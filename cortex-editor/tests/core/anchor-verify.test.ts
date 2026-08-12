import { describe, expect, it } from 'vitest'
import {
  parseAnchorSource,
  tagAtPosition,
  verifyAnchor,
  summarizeAnchors,
} from '../../src/core/anchor-verify.js'

// The fixture mirrors the shape COR-28 was measured on: a `.map()` with an <li>
// partway down, and an unrelated <h2> exactly 19 lines below it. 19 is not an
// arbitrary number — it is the real offset plugin-react introduced (a 16-line
// refresh head plus a 3-line shared head), and it is what every test below uses
// to simulate the bug rather than a rounder, less meaningful value.
const FILE = `export default function App() {
  return (
    <div>
      <ul>
        {['Apple', 'Mango'].map(f => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </div>
  )
}
// padding so the offset below lands on real code
// 13
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
    const r = parseAnchorSource('C:\\repo\\src\\App.tsx:12:5')
    expect(r).toEqual({ filePath: 'C:\\repo\\src\\App.tsx', line: 12, col: 5 })
  })

  it('rejects a source with no line:col — a preview source is not an anchor', () => {
    expect(parseAnchorSource('cortex-preview:p1')).toBeNull()
  })

  it('rejects zero and negative positions', () => {
    expect(parseAnchorSource('a.tsx:0:1')).toBeNull()
    expect(parseAnchorSource('a.tsx:1:0')).toBeNull()
  })
})

describe('tagAtPosition', () => {
  it('resolves a host element', () => {
    expect(tagAtPosition(FILE, 6, 11)).toBe('li')
  })

  it('returns null where no JSX lives', () => {
    expect(tagAtPosition(FILE, 13, 1)).toBeNull()
  })
})

describe('verifyAnchor — the metric must be able to FAIL on a wrong label', () => {
  const read = () => FILE

  it('VERIFIED when the position resolves to the tag the DOM reports', () => {
    const r = verifyAnchor({ source: 'src/App.tsx:6:11', domTag: 'li' }, read)
    expect(r.verdict).toBe('verified')
    expect(r.sourceTag).toBe('li')
  })

  it('SILENTLY-WRONG for the COR-28 shape: +19 lines, still resolves, wrong element', () => {
    // This is the whole reason COR-29 exists. The label is as UNIQUE as it was
    // — adding a constant to every line is one-to-one — so a uniqueness metric
    // reports an unchanged score while every anchor points somewhere else.
    // Here the <li> at 6:11 is stamped 25:11, which resolves to the <h2>.
    const r = verifyAnchor({ source: 'src/App.tsx:25:11', domTag: 'li' }, read)
    expect(r.verdict).toBe('silently-wrong')
    expect(r.sourceTag).toBe('h2')
  })

  it('UNRESOLVABLE, not wrong, when the file cannot be read', () => {
    // A coverage gap is not an error. Scoring it as one is exactly the
    // conflation this module exists to prevent: a tool that refuses is not a
    // tool that lies.
    const r = verifyAnchor({ source: 'src/Gone.tsx:1:1', domTag: 'div' }, () => null)
    expect(r.verdict).toBe('unresolvable')
  })

  it('UNRESOLVABLE when the position lands on no JSX at all', () => {
    const r = verifyAnchor({ source: 'src/App.tsx:13:1', domTag: 'div' }, read)
    expect(r.verdict).toBe('unresolvable')
  })

  it('UNRESOLVABLE when the anchor names a COMPONENT, not a host element', () => {
    // `<Card>` renders host elements whose tags will never equal the component
    // name, so "does the tag match" is ill-formed rather than false. Counting
    // it as silently-wrong would put a permanent floor under the number that is
    // supposed to be zero, and a metric that can never reach its target stops
    // being read.
    const withComponent = `export const A = () => (
  <Card title="x" />
)
`
    const r = verifyAnchor({ source: 'src/A.tsx:2:3', domTag: 'div' }, () => withComponent)
    expect(r.verdict).toBe('unresolvable')
    expect(r.reason).toContain('component')
  })
})

describe('summarizeAnchors', () => {
  it('keeps the three outcomes separate and names every mismatch', () => {
    const summary = summarizeAnchors(
      [
        { source: 'src/App.tsx:6:11', domTag: 'li' },   // verified
        { source: 'src/App.tsx:25:11', domTag: 'li' },  // silently wrong
        { source: 'src/App.tsx:13:1', domTag: 'div' },  // unresolvable
      ],
      () => FILE,
    )
    expect(summary.total).toBe(3)
    expect(summary.verified).toBe(1)
    expect(summary.silentlyWrong).toBe(1)
    expect(summary.unresolvable).toBe(1)
    // Named, not just counted — a bare count tells you something is wrong and
    // nothing about where, which is how a metric becomes a number nobody acts on.
    expect(summary.mismatches).toEqual([
      { source: 'src/App.tsx:25:11', domTag: 'li', sourceTag: 'h2' },
    ])
  })

  it('a uniform +19 offset drives silently-wrong to 100% — the case uniqueness cannot see', () => {
    // The falsifiability proof for the whole module. Under a uniqueness metric
    // this input scores identically to the correct one; here it is unmissable.
    const shifted = summarizeAnchors(
      [
        { source: 'src/App.tsx:25:11', domTag: 'li' },
        { source: 'src/App.tsx:25:11', domTag: 'li' },
      ],
      () => FILE,
    )
    expect(shifted.silentlyWrong).toBe(2)
    expect(shifted.verified).toBe(0)
  })
})
