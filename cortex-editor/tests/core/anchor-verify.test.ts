import { describe, expect, it } from 'vitest'
import {
  parseAnchorSource,
  jsxFactsAt,
  verifyAnchor,
  summarizeAnchors,
} from '../../src/core/anchor-verify.js'

// The fixture mirrors the shape COR-28 was measured on: a `.map()` with an <li>
// partway down, and an unrelated <h2> exactly 19 lines below it. 19 is not an
// arbitrary number — it is the real offset plugin-react introduced (a 16-line
// refresh head plus a 3-line shared head).
const FILE = `export default function App() {
  return (
    <div className="wrap">
      <ul>
        {['Apple', 'Mango'].map(f => (
          <li className="row" key={f}>{f}</li>
        ))}
      </ul>
      <li className="other">decoy</li>
    </div>
  )
}
// padding
// 14
// 15
// 16
// 17
// 18
// 19
// 20
// 21
// 22
// 23
export function Other() {
  return <h2>Features</h2>
}
`

describe('parseAnchorSource', () => {
  it('parses from the RIGHT so a Windows drive letter survives', () => {
    expect(parseAnchorSource('C:\\repo\\src\\App.tsx:12:5'))
      .toEqual({ filePath: 'C:\\repo\\src\\App.tsx', line: 12, col: 5 })
  })

  it('rejects a source with no line:col — a preview source is not an anchor', () => {
    expect(parseAnchorSource('cortex-preview:p1')).toBeNull()
  })

  it('rejects zero and negative positions', () => {
    expect(parseAnchorSource('a.tsx:0:1')).toBeNull()
    expect(parseAnchorSource('a.tsx:1:0')).toBeNull()
  })

  it.each(['a.tsx:6junk:11', 'a.tsx:6:11junk', 'a.tsx: 6:11', 'a.tsx:+6:11', 'a.tsx:6.0:11', 'a.tsx:0x6:11'])(
    'rejects the malformed coordinate %s instead of silently truncating it',
    (source) => {
      // parseInt stops at the first non-digit, so `6junk` would read as 6 and a
      // malformed anchor could be reported VERIFIED. A metric about truthfulness
      // must not launder its own input.
      expect(parseAnchorSource(source)).toBeNull()
    },
  )
})

describe('jsxFactsAt', () => {
  it('resolves a host element and its static className', async () => {
    expect(await jsxFactsAt(FILE, 6, 11)).toEqual({ tag: 'li', className: 'row' })
  })

  it('returns null where no JSX lives', async () => {
    expect(await jsxFactsAt(FILE, 14, 1)).toBeNull()
  })
})

describe('verifyAnchor — the metric must be able to FAIL on a wrong label', () => {
  const read = (): string => FILE

  it('VERIFIED when the position resolves and the class discriminates', async () => {
    const r = await verifyAnchor({ source: 'src/App.tsx:6:11', domTag: 'li', domClass: 'row' }, read)
    expect(r.verdict).toBe('verified')
  })

  it('SILENTLY-WRONG for the COR-28 shape: +19 lines, wrong element', async () => {
    // The whole reason COR-29 exists. The label is as UNIQUE as it was — adding
    // a constant to every line is one-to-one — so a uniqueness metric reports an
    // unchanged score while every anchor points elsewhere.
    const r = await verifyAnchor({ source: 'src/App.tsx:25:11', domTag: 'li', domClass: 'row' }, read)
    expect(r.verdict).toBe('silently-wrong')
    expect(r.sourceTag).toBe('h2')
  })

  it('SILENTLY-WRONG when the offset lands on a DIFFERENT element with the SAME tag', async () => {
    // Tag equality is worthless as identity: repeated host tags are the norm.
    // The decoy <li className="other"> is a real element, so tag comparison alone
    // would call this correct — which is how a shifted anchor stays invisible.
    const r = await verifyAnchor({ source: 'src/App.tsx:9:7', domTag: 'li', domClass: 'row' }, read)
    expect(r.verdict).toBe('silently-wrong')
    expect(r.reason).toContain('class mismatch')
  })

  it('SILENTLY-WRONG, not unresolvable, when the position resolves to NO JSX', async () => {
    // Cortex emitted an anchor and that anchor names nothing. It is a false
    // claim, not a refusal. Scoring it unresolvable would let a uniform offset
    // into blank lines report SILENTLY-WRONG 0% with every anchor false — the
    // exact blind spot this module exists to remove.
    const r = await verifyAnchor({ source: 'src/App.tsx:14:1', domTag: 'div' }, read)
    expect(r.verdict).toBe('silently-wrong')
    expect(r.reason).toContain('no JSX')
  })

  it('TAG-ONLY, never verified, when nothing discriminates', async () => {
    // The <h2> carries no className, so a matching tag is all there is. That is
    // "not contradicted", not "confirmed", and folding it into VERIFIED would
    // overstate exactly the number this PR exists to make honest.
    const r = await verifyAnchor({ source: 'src/App.tsx:25:11', domTag: 'h2' }, read)
    expect(r.verdict).toBe('tag-only')
  })

  it('UNRESOLVABLE, not wrong, when the file cannot be read', async () => {
    const r = await verifyAnchor({ source: 'src/Gone.tsx:1:1', domTag: 'div' }, () => null)
    expect(r.verdict).toBe('unresolvable')
  })

  it('UNRESOLVABLE when the anchor names a COMPONENT, not a host element', async () => {
    // <Card> renders host elements whose tags never equal the component name, so
    // the question is ill-formed rather than false. Counting it wrong would put a
    // permanent floor under a number that must reach zero, and a metric that
    // cannot reach its target stops being read.
    const withComponent = `export const A = () => (\n  <Card title="x" />\n)\n`
    const r = await verifyAnchor({ source: 'src/A.tsx:2:3', domTag: 'div' }, () => withComponent)
    expect(r.verdict).toBe('unresolvable')
    expect(r.reason).toContain('component')
  })

  it('compares SVG tags with EXACT casing', async () => {
    // The probe records localName, which lower-cases HTML but preserves SVG
    // casing. JSX must spell host elements identically or they parse as
    // components — so a casing difference is a real mismatch, and lower-casing
    // both sides would throw away the only signal that catches it.
    const svg = `export const S = () => (\n  <svg><linearGradient id="g" /></svg>\n)\n`
    const ok = await verifyAnchor({ source: 's.tsx:2:8', domTag: 'linearGradient' }, () => svg)
    expect(ok.verdict).toBe('tag-only')          // matches; no discriminator
    const bad = await verifyAnchor({ source: 's.tsx:2:8', domTag: 'lineargradient' }, () => svg)
    expect(bad.verdict).toBe('silently-wrong')
  })

  it('tolerates EXTRA runtime classes on the DOM side', async () => {
    // Frameworks, CSS modules and runtime toggles add tokens the source never
    // names. Requiring equality would report false mismatches on ordinary apps
    // and make the number unusable; source classes must be PRESENT, not equal.
    const r = await verifyAnchor(
      { source: 'src/App.tsx:6:11', domTag: 'li', domClass: 'row hash_a1b2 is-active' },
      read,
    )
    expect(r.verdict).toBe('verified')
  })
})

describe('summarizeAnchors', () => {
  it('keeps every outcome separate and names each mismatch with a cause', async () => {
    const summary = await summarizeAnchors(
      [
        { source: 'src/App.tsx:6:11', domTag: 'li', domClass: 'row' },  // verified
        { source: 'src/App.tsx:25:11', domTag: 'h2' },                  // tag-only
        { source: 'src/App.tsx:9:7', domTag: 'li', domClass: 'row' },   // wrong (same tag!)
        { source: 'src/Gone.tsx:1:1', domTag: 'div' },                  // unresolvable
      ],
      (p) => (p === 'src/Gone.tsx' ? null : FILE),
    )
    expect(summary.total).toBe(4)
    expect(summary.verified).toBe(1)
    expect(summary.tagOnly).toBe(1)
    expect(summary.silentlyWrong).toBe(1)
    expect(summary.unresolvable).toBe(1)
    expect(summary.mismatches[0]).toMatchObject({
      source: 'src/App.tsx:9:7',
      domTag: 'li',
      sourceTag: 'li',
      why: 'class mismatch',
    })
  })

  it('the file-grouping optimisation never leaks one file\'s parse into another', async () => {
    // summarizeAnchors reorders work by file so the one-entry parse cache hits.
    // Interleaving two files with the SAME position but DIFFERENT elements is
    // the case a stale cache would get wrong: B's anchor would be answered with
    // A's parse and report verified.
    const A = `export const A = () => <div className="a" />\n`
    const B = `export const B = () => <span className="b" />\n`
    const s = await summarizeAnchors(
      [
        { source: 'A.tsx:1:24', domTag: 'div', domClass: 'a' },
        { source: 'B.tsx:1:24', domTag: 'span', domClass: 'b' },
        { source: 'A.tsx:1:24', domTag: 'div', domClass: 'a' },
        { source: 'B.tsx:1:24', domTag: 'span', domClass: 'b' },
      ],
      (p) => (p === 'A.tsx' ? A : B),
    )
    expect(s.verified).toBe(4)
    expect(s.silentlyWrong).toBe(0)
  })

  it('reports mismatches in INPUT order, not the file-grouped work order', async () => {
    // Grouping is a performance detail. If it leaked into the output, the first
    // reported mismatch would depend on filename sort order rather than on what
    // the operator actually saw first.
    const s = await summarizeAnchors(
      [
        { source: 'zz/App.tsx:9:7', domTag: 'li', domClass: 'row' },   // wrong; sorts LAST by file
        { source: 'aa/App.tsx:9:7', domTag: 'li', domClass: 'row' },   // wrong; sorts FIRST by file
      ],
      () => FILE,
    )
    expect(s.mismatches.map(m => m.source)).toEqual(['zz/App.tsx:9:7', 'aa/App.tsx:9:7'])
  })

  it('a uniform +19 offset drives silently-wrong to 100% — the case uniqueness cannot see', async () => {
    const shifted = await summarizeAnchors(
      [
        { source: 'src/App.tsx:25:11', domTag: 'li', domClass: 'row' },
        { source: 'src/App.tsx:25:11', domTag: 'li', domClass: 'row' },
      ],
      () => FILE,
    )
    expect(shifted.silentlyWrong).toBe(2)
    expect(shifted.verified).toBe(0)
  })
})
