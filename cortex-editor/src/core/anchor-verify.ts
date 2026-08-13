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
 * The two REFUSAL verdicts are kept apart because they mean opposite things
 * about the anchor, and one blended "accuracy" number scores them identically.
 * A tool that refuses is not a tool that lies — but WHY it refused decides what
 * to do next:
 *
 * `unreadable` — the evidence is missing. The file could not be read, or the
 * source is not a `file:line:col` at all. Says nothing about the anchor's
 * quality; it is a gap in what the harness could see.
 *
 * `component-anchor` — the anchor names a COMPONENT (`<Card>`) rather than a
 * host element. The tag can never equal the rendered DOM tag, so the
 * tag-comparison question is ill-formed. This one is not a gap: it is a
 * POSITIVE observation that the anchor points at a call site, and under a
 * call-site-addressing scheme it is the expected result rather than a failure.
 * Folding it into a bucket that also holds "file unreadable" made a fully
 * working call-site scheme indistinguishable from a broken harness — the
 * measurement blind spot recorded in the 2026-08-13 harvest plan.
 */
export type AnchorVerdict =
  | 'verified'
  | 'tag-only'
  | 'silently-wrong'
  | 'unreadable'
  | 'component-anchor'

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
  unreadable: number
  /** Anchors naming a component rather than a host element. Counted separately
   *  because under a call-site-addressing scheme this is the SUCCESS case, not
   *  a refusal — see AnchorVerdict. */
  componentAnchor: number
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
  // Whole-field match, NOT parseInt. parseInt stops at the first non-digit, so
  // `App.tsx:6junk:11` would parse as line 6 and a malformed anchor could be
  // reported VERIFIED — a metric about truthfulness must not launder its own
  // input. `[1-9]\d*` also subsumes the `< 1` check and rejects `+6`, ` 6`,
  // `6.0`, `0x6`, and `Infinity`, all of which parseInt or Number would accept
  // in some form.
  const lineText = source.slice(secondLastColon + 1, lastColon)
  const colText = source.slice(lastColon + 1)
  if (!filePath || !/^[1-9]\d*$/.test(lineText) || !/^[1-9]\d*$/.test(colText)) return null
  const line = Number(lineText)
  const col = Number(colText)
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(col)) return null
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

/**
 * One-entry parse cache. `summarizeAnchors` groups its samples by file before
 * calling in, so consecutive calls almost always carry the same text and this
 * hits every time — turning O(anchors) parses into O(files). A route with a
 * `.map()` over 200 rows names one source file 200 times; without this it would
 * reparse that file 200 times.
 *
 * Deliberately one entry, not a Map: an unbounded cache keyed by file TEXT
 * would retain every version of every file for the process lifetime, and the
 * grouping makes the extra entries worthless anyway.
 */
let cachedText: string | null = null
let cachedFile: import('ts-morph').SourceFile | null = null

/** The JSX facts at a position, or null when the position resolves to no JSX. */
export async function jsxFactsAt(
  fileText: string,
  line: number,
  col: number,
): Promise<JsxFacts | null> {
  const { project, SK } = await morph.ensureReady()
  let sourceFile = cachedText === fileText ? cachedFile : null
  if (!sourceFile) {
    // Overwrite one probe file rather than accumulating source files; ts-morph
    // keeps every added file alive on the Project otherwise.
    const existing = project.getSourceFile(PROBE_PATH)
    if (existing) project.removeSourceFile(existing)
    try {
      sourceFile = project.createSourceFile(PROBE_PATH, fileText, { overwrite: true })
    } catch {
      cachedText = null
      cachedFile = null
      return null
    }
    cachedText = fileText
    cachedFile = sourceFile
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
  if (!parsed) return { verdict: 'unreadable', reason: 'source is not file:line:col' }

  const text = readFile(parsed.filePath)
  if (text === null) return { verdict: 'unreadable', reason: 'file could not be read' }

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
    return { verdict: 'component-anchor', sourceTag: facts.tag, reason: 'anchor names a component, not a host element' }
  }

  // EXACT comparison, not case-insensitive. The probe records `localName`
  // precisely because it preserves SVG casing (`linearGradient`, `clipPath`)
  // while lower-casing HTML — and JSX must spell host elements the same way, or
  // they would be parsed as components. Lower-casing both sides throws away the
  // one signal that distinguishes an SVG host element from a differently-cased
  // impostor, so a casing-only difference would verify.
  if (facts.tag !== sample.domTag) {
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
    unreadable: 0,
    componentAnchor: 0,
    mismatches: [],
  }
  // Verify in file-grouped order so the one-entry parse cache in jsxFactsAt hits
  // — a page naming one file 200 times becomes ONE parse, not 200. Results are
  // stored by ORIGINAL index and tallied in input order afterwards, so grouping
  // is a pure performance detail and never reorders the reported mismatches.
  const byFile = samples
    .map((sample, index) => ({ sample, index, filePath: parseAnchorSource(sample.source)?.filePath ?? '' }))
    .sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : a.index - b.index))

  const verified = []
  for (const e of byFile) {
    verified.push({ index: e.index, sample: e.sample, result: await verifyAnchor(e.sample, readFile) })
  }
  verified.sort((a, b) => a.index - b.index)

  for (const { sample, result } of verified) {
    if (result.verdict === 'verified') summary.verified++
    else if (result.verdict === 'tag-only') summary.tagOnly++
    else if (result.verdict === 'unreadable') summary.unreadable++
    else if (result.verdict === 'component-anchor') summary.componentAnchor++
    else {
      summary.silentlyWrong++
      summary.mismatches.push({
        source: sample.source,
        domTag: sample.domTag,
        sourceTag: result.sourceTag ?? '(none)',
        why: result.reason ?? 'mismatch',
      })
    }
  }
  return summary
}
