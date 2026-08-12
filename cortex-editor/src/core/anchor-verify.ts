import { LazyTsMorph } from './rewriter/lazy-ts-morph.js'
import { findJsxElementAt } from './rewriter/jsx-utils.js'

/**
 * Anchor CORRECTNESS — does a recorded position point at the element it claims?
 *
 * ## Why this exists as its own thing
 *
 * The coverage harness measures UNIQUENESS: how many DOM nodes share each
 * `data-cortex-source` value. That is orthogonal to correctness in a way that is
 * easy to miss until it costs you.
 *
 * Adding a constant to every line number is a ONE-TO-ONE mapping. Every label
 * stays exactly as unique as it was. So COR-28 — where a 19-line offset made
 * 100% of Vite anchors point at the wrong element — was *mathematically
 * invisible* to a uniqueness metric. It would have reported the same 91.7% on
 * dev-app with every label wrong.
 *
 * ## What each verdict does and does NOT prove
 *
 * `verified` requires a DISCRIMINATING signal, not just a matching tag. Tag
 * equality alone is worthless as identity: repeated host tags are the norm, so
 * an offset that lands on a different `<div>` or `<li>` would read as correct.
 * When a static `className` literal is present on both sides it is compared;
 * that is the discriminator. When there is none, the result is `tag-only` — a
 * SEPARATE bucket that must never be added to `verified`, because "consistent
 * with" is not "is".
 *
 * `silently-wrong` covers both a resolved-but-different element AND a position
 * that resolves to no JSX at all. The second is not a refusal: cortex EMITTED an
 * anchor and that anchor names nothing. A uniform offset landing on blank lines
 * would otherwise report SILENTLY-WRONG 0% while every anchor was false, which
 * is the exact blind spot this module exists to remove.
 *
 * `unresolvable` is reserved for cases where the QUESTION is ill-formed or the
 * evidence is missing — an unreadable file, or an anchor naming a component
 * rather than a host element. That distinction is load-bearing: a tool that
 * refuses is not a tool that lies, and one blended "accuracy" number scores them
 * identically.
 */
export type AnchorVerdict = 'verified' | 'tag-only' | 'silently-wrong' | 'unresolvable'

export interface AnchorSample {
  /** The `data-cortex-source` value: `path/to/File.tsx:line:col`. */
  source: string
  /** `el.localName` — lower-cased for HTML, case-preserving for SVG, which is
   *  why the collector must use localName and not tagName. */
  domTag: string
  /** The live element's class attribute, when it has one. The discriminator that
   *  lets a verdict be `verified` rather than merely `tag-only`. */
  domClass?: string
}

export interface AnchorVerifyResult {
  verdict: AnchorVerdict
  sourceTag?: string
  reason?: string
}

export interface AnchorVerifySummary {
  total: number
  verified: number
  tagOnly: number
  silentlyWrong: number
  unresolvable: number
  mismatches: Array<{ source: string; domTag: string; sourceTag: string; why: string }>
}

/** Parse `path:line:col` from the RIGHT, so a Windows drive letter
 *  (`C:\a\App.tsx:2:10`) does not split on the wrong colon. */
export function parseAnchorSource(
  source: string,
): { filePath: string; line: number; col: number } | null {
  const lastColon = source.lastIndexOf(':')
  if (lastColon < 0) return null
  const secondLastColon = source.lastIndexOf(':', lastColon - 1)
  if (secondLastColon < 0) return null

  const filePath = source.slice(0, secondLastColon)
  const line = Number.parseInt(source.slice(secondLastColon + 1, lastColon), 10)
  const col = Number.parseInt(source.slice(lastColon + 1), 10)
  if (!filePath || !Number.isFinite(line) || !Number.isFinite(col)) return null
  if (line < 1 || col < 1) return null
  return { filePath, line, col }
}

/** One Project, reused. A fresh `new Project()` per anchor is a full parse per
 *  anchor, and the harness calls this once per annotated element — O(anchors)
 *  parses on a page with hundreds. ts-morph itself is loaded lazily through
 *  LazyTsMorph so importing this module does not pull it into the bundle for
 *  callers that never verify anything. */
const morph = new LazyTsMorph('AnchorVerify', { useInMemoryFileSystem: true })
const PROBE_PATH = '/__anchor_probe__.tsx'

interface JsxFacts {
  tag: string
  /** The className when it is a plain string literal. An expression
   *  (`className={cx(...)}`) yields undefined — unknown, never guessed. */
  className?: string
}

/** The JSX facts at a position, or null when the position resolves to no JSX. */
export async function jsxFactsAt(
  fileText: string,
  line: number,
  col: number,
): Promise<JsxFacts | null> {
  const { project, SK } = await morph.ensureReady()
  // Overwrite one probe file rather than accumulating source files; ts-morph
  // keeps every added file alive on the Project otherwise.
  const existing = project.getSourceFile(PROBE_PATH)
  if (existing) project.removeSourceFile(existing)
  let sourceFile
  try {
    sourceFile = project.createSourceFile(PROBE_PATH, fileText, { overwrite: true })
  } catch {
    return null
  }
  const el = findJsxElementAt(sourceFile, line, col, SK)
  if (!el) return null

  const tag = el.getTagNameNode().getText()
  let className: string | undefined
  for (const attr of el.getAttributes()) {
    const text = attr.getText()
    const m = /^class(?:Name)?\s*=\s*"([^"]*)"$/.exec(text) ?? /^class(?:Name)?\s*=\s*'([^']*)'$/.exec(text)
    if (m) { className = m[1]; break }
  }
  return className === undefined ? { tag } : { tag, className }
}

const tokens = (s: string): Set<string> => new Set(s.trim().split(/\s+/).filter(Boolean))

/**
 * Verify one anchor against the source it names.
 *
 * `readFile` is injected rather than importing `fs` so this is unit-testable
 * without a fixture tree, and so a harness can feed it text it already holds.
 */
export async function verifyAnchor(
  sample: AnchorSample,
  readFile: (filePath: string) => string | null,
): Promise<AnchorVerifyResult> {
  const parsed = parseAnchorSource(sample.source)
  if (!parsed) return { verdict: 'unresolvable', reason: 'source is not file:line:col' }

  const text = readFile(parsed.filePath)
  if (text === null) return { verdict: 'unresolvable', reason: 'file could not be read' }

  const facts = await jsxFactsAt(text, parsed.line, parsed.col)
  if (facts === null) {
    // NOT a refusal. Cortex emitted an anchor and that anchor names nothing —
    // a false claim, and exactly what a uniform offset into blank lines looks
    // like. Counting it as unresolvable would let that case report 0% wrong.
    return { verdict: 'silently-wrong', reason: 'position resolves to no JSX element' }
  }

  // A component element (`<Card>`) renders host elements whose tag will never
  // equal the component name. Asking "does it point at the right tag" is
  // ill-formed there, not false — and scoring it wrong would put a permanent
  // floor under the number that must reach zero, so the metric would stop being
  // read.
  if (/^[A-Z]/.test(facts.tag) || facts.tag.includes('.')) {
    return { verdict: 'unresolvable', sourceTag: facts.tag, reason: 'anchor names a component, not a host element' }
  }

  if (facts.tag.toLowerCase() !== sample.domTag.toLowerCase()) {
    return { verdict: 'silently-wrong', sourceTag: facts.tag, reason: 'tag mismatch' }
  }

  // Tags agree. That is necessary and nowhere near sufficient — an offset onto
  // another <div> agrees too. Use the class attribute as a discriminator when
  // BOTH sides have one that can be compared.
  if (facts.className !== undefined && sample.domClass !== undefined) {
    const src = tokens(facts.className)
    const dom = tokens(sample.domClass)
    if (src.size === 0 && dom.size === 0) return { verdict: 'verified', sourceTag: facts.tag }
    // Source classes must all appear on the element. The DOM may carry extra
    // tokens — framework-injected, CSS-module-hashed, or added at runtime — so
    // requiring equality would report false mismatches on ordinary apps.
    const allPresent = [...src].every(t => dom.has(t))
    return allPresent
      ? { verdict: 'verified', sourceTag: facts.tag }
      : { verdict: 'silently-wrong', sourceTag: facts.tag, reason: 'class mismatch' }
  }

  return {
    verdict: 'tag-only',
    sourceTag: facts.tag,
    reason: 'tag agrees but no discriminating signal was available',
  }
}

/** Roll up a sample set. Counts stay separate on purpose — one blended
 *  "accuracy" number hides the difference between refusing and being wrong, and
 *  between proving identity and merely not contradicting it. */
export async function summarizeAnchors(
  samples: readonly AnchorSample[],
  readFile: (filePath: string) => string | null,
): Promise<AnchorVerifySummary> {
  const summary: AnchorVerifySummary = {
    total: samples.length,
    verified: 0,
    tagOnly: 0,
    silentlyWrong: 0,
    unresolvable: 0,
    mismatches: [],
  }
  for (const sample of samples) {
    const r = await verifyAnchor(sample, readFile)
    if (r.verdict === 'verified') summary.verified++
    else if (r.verdict === 'tag-only') summary.tagOnly++
    else if (r.verdict === 'unresolvable') summary.unresolvable++
    else {
      summary.silentlyWrong++
      summary.mismatches.push({
        source: sample.source,
        domTag: sample.domTag,
        sourceTag: r.sourceTag ?? '(none)',
        why: r.reason ?? 'mismatch',
      })
    }
  }
  return summary
}
