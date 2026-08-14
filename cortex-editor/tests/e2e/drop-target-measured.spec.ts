/**
 * `resolveDropTarget` against real Chromium layout (COR-7, M1).
 *
 * Business purpose: the gesture has to answer "which slot is the user pointing
 * at" before anything reaches source. Getting it wrong by one produces a
 * confident, plausible-looking reorder of the wrong pair — the failure class
 * this whole milestone is defended against.
 *
 * Falsifiability note, and the reason this is an e2e file rather than a unit
 * test: happy-dom does not lay out, so every `getBoundingClientRect()` is zero.
 * A unit test would be asserting against a stub of the exact thing under test,
 * which is how the predicted `edgeResponse` resolver (COR-3) passed its own
 * tests while being wrong about CSS in five separate ways. Every case below
 * asserts the answer real layout gives.
 *
 * The module is bundled from source rather than imported from the product IIFE:
 * it is not part of that bundle's public surface, and bundling the TypeScript
 * directly means these tests exercise the real code rather than a copy that can
 * drift.
 */
import { test, expect, type Page } from '@playwright/test'
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'

interface DropTarget { toIndex: number; axis: 'vertical' | 'horizontal' | 'grid' }

let BUNDLE = ''

test.beforeAll(async () => {
  const result = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../../src/browser/drop-target.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'DT',
    write: false,
    target: 'es2020',
  })
  BUNDLE = result.outputFiles[0]!.text
})

const ROW = 'height:40px;width:200px;background:#eee'

// Every container is pinned at the viewport origin. Laid out in flow they
// stack down the page, and the arithmetic in each test's comment would then
// describe only the FIRST list — which is exactly the mistake the first run of
// this file made: `hiddenlist` sits ~320px down, so a pointer at y=70 was above
// all of it and every drop resolved to 0.
const AT_ORIGIN = 'position:absolute;top:0;left:0'

const FIXTURE = `<!doctype html><body style="margin:0">
  <!-- Plain vertical list: rows at y = 0..40, 40..80, 80..120, centres 20/60/100. -->
  <ul id="vlist" style="${AT_ORIGIN};margin:0;padding:0;list-style:none;width:200px">
    <li style="${ROW}">Alpha</li><li style="${ROW}">Bravo</li><li style="${ROW}">Charlie</li></ul>

  <!-- Horizontal row: centres at x = 50/150/250. -->
  <div id="hlist" style="${AT_ORIGIN};display:flex;width:300px">
    <div style="width:100px;height:40px"></div>
    <div style="width:100px;height:40px"></div>
    <div style="width:100px;height:40px"></div></div>

  <!-- row-reverse: child 0 is on the RIGHT. Measured centres run backwards
       against DOM order, which is the whole point of the reversed flag. -->
  <div id="rrlist" style="${AT_ORIGIN};display:flex;flex-direction:row-reverse;width:300px">
    <div style="width:100px;height:40px"></div>
    <div style="width:100px;height:40px"></div>
    <div style="width:100px;height:40px"></div></div>

  <!-- direction: rtl produces the same visual reversal from a completely
       different property. Measuring cannot tell them apart, and does not need to. -->
  <div id="rtllist" style="${AT_ORIGIN};display:flex;direction:rtl;width:300px">
    <div style="width:100px;height:40px"></div>
    <div style="width:100px;height:40px"></div>
    <div style="width:100px;height:40px"></div></div>

  <!-- Wrapped flex: two rows of two. Centres spread on BOTH axes, so no
       single-axis midpoint rule is meaningful. -->
  <div id="gridlist" style="${AT_ORIGIN};display:flex;flex-wrap:wrap;width:200px">
    <div style="width:100px;height:40px"></div>
    <div style="width:100px;height:40px"></div>
    <div style="width:100px;height:40px"></div>
    <div style="width:100px;height:40px"></div></div>

  <!-- A hidden sibling among visible ones: zero-area rect, and counting
       it would put a centre at the viewport origin and drag drops toward 0. -->
  <ul id="hiddenlist" style="${AT_ORIGIN};margin:0;padding:0;list-style:none;width:200px">
    <li style="${ROW}">Alpha</li>
    <li style="display:none">Ghost</li>
    <li style="${ROW}">Charlie</li></ul>

  <!-- Ragged widths in a vertical list. Centres differ horizontally, and a
       naive both-axes-vary test would call this a grid. -->
  <ul id="ragged" style="${AT_ORIGIN};margin:0;padding:0;list-style:none;width:400px">
    <li style="height:40px;width:80px"></li>
    <li style="height:40px;width:300px"></li>
    <li style="height:40px;width:150px"></li></ul>
</body>`

async function drop(page: Page, id: string, x: number, y: number, fromIndex: number): Promise<DropTarget | null> {
  return await page.evaluate(
    ({ elementId, px, py, from }) => {
      const el = document.getElementById(elementId)
      if (!el) throw new Error(`[drop-target] fixture #${elementId} missing`)
      return (window as unknown as {
        DT: { resolveDropTarget: (n: Element, p: { x: number; y: number }, f: number) => DropTarget | null }
      }).DT.resolveDropTarget(el, { x: px, y: py }, from)
    },
    { elementId: id, px: x, py: y, from: fromIndex },
  )
}

test.beforeEach(async ({ page }) => {
  await page.setContent(FIXTURE)
  await page.addScriptTag({ content: BUNDLE })
})

test.describe('resolveDropTarget — vertical lists', () => {
  test('measures the axis from layout, not from CSS', async ({ page }) => {
    const t = await drop(page, 'vlist', 100, 10, 0)
    expect(t?.axis).toBe('vertical')
  })

  test('dragging the last row above the first gives toIndex 0', async ({ page }) => {
    // Rows 0 and 1 remain (centres y=20 and y=60 once row 2 is lifted out).
    // Pointer at y=10 has passed neither.
    const t = await drop(page, 'vlist', 100, 10, 2)
    expect(t?.toIndex).toBe(0)
  })

  test('toIndex counts positions in the list WITHOUT the dragged row', async ({ page }) => {
    // The off-by-one this test exists for: dragging row 0 to the bottom. With
    // row 0 lifted, the remaining centres are y=20 and y=60 (rows shift up).
    // A pointer below both is toIndex 2 — the end of a TWO-item list — and
    // computing against the full three-item list would produce 3.
    const t = await drop(page, 'vlist', 100, 115, 0)
    expect(t?.toIndex).toBe(2)
  })

  test('the midpoint decides, not the row boundary', async ({ page }) => {
    // With row 2 lifted, remaining centres are y=20 and y=60. y=39 is past the
    // first centre and short of the second.
    expect((await drop(page, 'vlist', 100, 39, 2))?.toIndex).toBe(1)
    expect((await drop(page, 'vlist', 100, 19, 2))?.toIndex).toBe(0)
  })

  test('ragged row widths do NOT read as a grid', async ({ page }) => {
    // Centres differ on both axes here (80/300/150 wide). A both-axes-vary test
    // without the 2x margin calls this two-dimensional and switches to
    // nearest-centre, which changes the answer on an ordinary list.
    const t = await drop(page, 'ragged', 40, 10, 2)
    expect(t?.axis).toBe('vertical')
  })

  test('ignores a zero-area sibling instead of placing it at the origin', async ({ page }) => {
    // The display:none li has a rect at 0,0. Counting it would put a centre
    // above every real row and shift drops toward index 0.
    const t = await drop(page, 'hiddenlist', 100, 70, 0)
    expect(t?.toIndex).toBe(1)
  })
})

test.describe('resolveDropTarget — horizontal and reversed', () => {
  test('measures a flex row as horizontal', async ({ page }) => {
    expect((await drop(page, 'hlist', 10, 20, 0))?.axis).toBe('horizontal')
  })

  test('drops to the far end of a row', async ({ page }) => {
    // Child 0 lifted; remaining centres x=50 and x=150 (children shift left).
    expect((await drop(page, 'hlist', 290, 20, 0))?.toIndex).toBe(2)
  })

  test('row-reverse: DOM order runs right-to-left, and the index stays in DOM order', async ({ page }) => {
    // Child 0 is drawn at the RIGHT. Lifting child 2 (drawn leftmost) leaves
    // children 0 and 1 at x=250 and x=150. A pointer at the far RIGHT is before
    // both in DOM terms, so toIndex is 0 — the returned index is a DOM index,
    // which is the only coordinate `baseline` and `order` are expressed in.
    expect((await drop(page, 'rrlist', 295, 20, 2))?.toIndex).toBe(0)
    expect((await drop(page, 'rrlist', 5, 20, 2))?.toIndex).toBe(2)
  })

  test('direction: rtl reverses identically, from a different property', async ({ page }) => {
    // Same visual result as row-reverse, produced by a property this module
    // never reads. If the axis were predicted from CSS this would need its own
    // branch; measured, it needs nothing.
    expect((await drop(page, 'rtllist', 295, 20, 2))?.toIndex).toBe(0)
    expect((await drop(page, 'rtllist', 5, 20, 2))?.toIndex).toBe(2)
  })
})

test.describe('resolveDropTarget — wrapped layouts and refusals', () => {
  test('detects a wrapped flex container as a grid', async ({ page }) => {
    expect((await drop(page, 'gridlist', 50, 20, 0))?.axis).toBe('grid')
  })

  test('a grid resolves by nearest centre rather than one axis', async ({ page }) => {
    // Cells at (50,20) (150,20) (50,60) (150,60). Lifting child 0 leaves three.
    // A pointer just below the bottom-right cell's centre lands after it.
    const t = await drop(page, 'gridlist', 150, 70, 0)
    expect(t?.axis).toBe('grid')
    expect(t?.toIndex).toBe(3)
  })

  test('returns null rather than guessing when there is nothing to resolve', async ({ page }) => {
    // A null is "stage nothing". This feeds a source rewrite, and a
    // plausible-looking wrong slot is worse than no drop at all.
    await page.setContent('<ul id="one" style="margin:0"><li style="height:40px"></li></ul>')
    await page.addScriptTag({ content: BUNDLE })
    expect(await drop(page, 'one', 10, 10, 0)).toBeNull()
  })

  test('returns null for an out-of-range fromIndex', async ({ page }) => {
    expect(await drop(page, 'vlist', 100, 10, 9)).toBeNull()
  })
})
