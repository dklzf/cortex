import { Project, SyntaxKind } from 'ts-morph'
import { findJsxElementAt } from './rewriter/jsx-utils.js'

/**
 * Anchor CORRECTNESS — does a recorded position point at the element it claims?
 *
 * ## Why this exists as its own thing
 *
 * The coverage harness measures UNIQUENESS: how many DOM nodes share each
 * `data-cortex-source` value. That is a useful number and it is orthogonal to
 * correctness, in a way that is easy to miss until it costs you.
 *
 * Adding a constant to every line number is a ONE-TO-ONE mapping. Every label
 * stays exactly as unique as it was. So COR-28 — where a 19-line offset made
 * 100% of Vite anchors point at the wrong element — was *mathematically
 * invisible* to a uniqueness metric. It would have reported the same 91.7% on
 * dev-app with every label wrong.
 *
 * A uniqueness check cannot in principle detect a uniform position error. This
 * module answers the different question, and the test suite for it exists
 * specifically to prove it CAN fail on a wrong label.
 *
 * ## The three outcomes, deliberately not two
 *
 * `verified` / `silently-wrong` / `unresolvable` are kept apart because
 * collapsing them into one "accuracy" percentage scores two very different
 * tools identically. A tool that REFUSES 40% of the time and is never wrong is
 * far more useful than one that answers every time and is wrong 10% of the
 * time: the first is a coverage gap you can see, the second corrupts source and
 * looks fine doing it. `silently-wrong` is the number that must be zero.
 */
export type AnchorVerdict = 'verified' | 'silently-wrong' | 'unresolvable'

export interface AnchorSample {
  /** The `data-cortex-source` value: `path/to/File.tsx:line:col`. */
  source: string
  /** `el.localName` from the live DOM — lower-cased for HTML, case-preserving
   *  for SVG, which is why the collector must use localName and not tagName. */
  domTag: string
}

export interface AnchorVerifyResult {
  verdict: AnchorVerdict
  /** The tag the source position actually resolves to, when it resolves. */
  sourceTag?: string
  /** Why it could not be resolved — never used to judge correctness, only to
   *  explain a refusal. */
  reason?: string
}

export interface AnchorVerifySummary {
  total: number
  verified: number
  silentlyWrong: number
  unresolvable: number
  /** Every mismatch, so a report can name them instead of just counting. */
  mismatches: Array<{ source: string; domTag: string; sourceTag: string }>
}

/** Parse `path:line:col` from the RIGHT, so a Windows drive letter
 *  (`C:\a\App.tsx:2:10`) does not split on the wrong colon. Mirrors the
 *  edit-pipeline parser rather than restating its rules loosely. */
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

/**
 * The JSX tag name at a position, or null when the position resolves to no JSX.
 *
 * Reuses `findJsxElementAt` rather than reimplementing the position walk: a
 * second implementation would be a shadow copy that agrees with itself and
 * proves nothing about what apply actually does. That function is what the
 * apply path uses, so verifying through it asks the real question — "would apply
 * land on the element the DOM says this is".
 */
export function tagAtPosition(fileText: string, line: number, col: number): string | null {
  const project = new Project({ useInMemoryFileSystem: true })
  let sourceFile
  try {
    sourceFile = project.createSourceFile('probe.tsx', fileText)
  } catch {
    return null
  }
  const el = findJsxElementAt(sourceFile, line, col, SyntaxKind)
  if (!el) return null
  return el.getTagNameNode().getText()
}

/**
 * Verify one anchor against the source it names.
 *
 * `readFile` is injected rather than importing `fs` so this is unit-testable
 * without a fixture tree — and so a harness can feed it text it already has.
 * Returning null from it means "could not read", which is `unresolvable`, NOT
 * wrong: an unreadable file is a coverage gap, and scoring it as an error would
 * be exactly the conflation this module exists to prevent.
 */
export function verifyAnchor(
  sample: AnchorSample,
  readFile: (filePath: string) => string | null,
): AnchorVerifyResult {
  const parsed = parseAnchorSource(sample.source)
  if (!parsed) return { verdict: 'unresolvable', reason: 'source is not file:line:col' }

  const text = readFile(parsed.filePath)
  if (text === null) return { verdict: 'unresolvable', reason: 'file could not be read' }

  const sourceTag = tagAtPosition(text, parsed.line, parsed.col)
  if (sourceTag === null) {
    return { verdict: 'unresolvable', reason: 'position resolves to no JSX element' }
  }

  // Compare case-INSENSITIVELY on the host-element path. The DOM lower-cases
  // HTML tag names while JSX preserves the author's spelling, so `<Div>` cannot
  // occur but `<div>` vs `div` must match. A component element (`<Card>`)
  // renders host elements whose tag will not equal the component name — that is
  // a legitimate mismatch of KIND, not of position, so it is reported as
  // unresolvable rather than wrong: the anchor names a call site, and asking
  // whether it "points at the right tag" is ill-formed.
  if (/^[A-Z]/.test(sourceTag) || sourceTag.includes('.')) {
    return { verdict: 'unresolvable', sourceTag, reason: 'anchor names a component, not a host element' }
  }

  if (sourceTag.toLowerCase() === sample.domTag.toLowerCase()) {
    return { verdict: 'verified', sourceTag }
  }
  return { verdict: 'silently-wrong', sourceTag }
}

/** Roll up a sample set. Counts are kept separate on purpose — see the module
 *  doc: one blended "accuracy" number hides the difference between refusing and
 *  being wrong. */
export function summarizeAnchors(
  samples: readonly AnchorSample[],
  readFile: (filePath: string) => string | null,
): AnchorVerifySummary {
  const summary: AnchorVerifySummary = {
    total: samples.length,
    verified: 0,
    silentlyWrong: 0,
    unresolvable: 0,
    mismatches: [],
  }
  for (const sample of samples) {
    const r = verifyAnchor(sample, readFile)
    if (r.verdict === 'verified') summary.verified++
    else if (r.verdict === 'unresolvable') summary.unresolvable++
    else {
      summary.silentlyWrong++
      summary.mismatches.push({
        source: sample.source,
        domTag: sample.domTag,
        sourceTag: r.sourceTag ?? '?',
      })
    }
  }
  return summary
}
