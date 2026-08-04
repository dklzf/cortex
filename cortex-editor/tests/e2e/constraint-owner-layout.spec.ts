/**
 * The CSS facts the constraint-owner resolver is built on (B3).
 *
 * Business purpose: `src/browser/constraint-owner.ts` decides where a resize
 * edit must be written — the element, its flex allocation, or the parent's grid
 * track — and how far the grabbed edge travels per pixel of size. Those
 * decisions encode claims about how CSS actually behaves.
 *
 * Falsifiability note: the unit tests drive the DECISION function and can only
 * prove it is self-consistent. They cannot catch us believing the wrong thing
 * about CSS, because happy-dom does not lay out. This spec asserts the
 * underlying measurements in real Chromium, so if a browser (or our reading of
 * the spec) ever changes, the resolver's premises fail loudly here rather than
 * silently producing edits that do nothing.
 *
 * Each case asks a child for +50px of width — exactly what a naive resize
 * writes — and measures what actually happened.
 */
import { test, expect, type Page } from '@playwright/test'

const FIXTURE = `<!doctype html><body style="margin:0">
  <div id="endWrap" style="display:flex;justify-content:flex-end;width:600px">
    <div id="endChild" style="width:200px;height:40px"></div></div>
  <div id="centerWrap" style="display:flex;justify-content:center;width:600px">
    <div id="centerChild" style="width:200px;height:40px"></div></div>
  <div id="growWrap" style="display:flex;width:600px">
    <div id="growChild" style="flex:1;width:200px;height:40px"></div></div>
  <div id="rtlWrap" style="display:flex;direction:rtl;justify-content:flex-start;width:600px">
    <div id="rtlChild" style="width:200px;height:40px"></div></div>
  <div id="gridWrap" style="display:grid;grid-template-columns:1fr 1fr;width:600px">
    <div id="gridChild" style="height:40px"></div><div id="gridSibling" style="height:40px"></div></div>
</body>`

interface Box { width: number; left: number; right: number }

async function measure(page: Page, id: string): Promise<Box> {
  return await page.evaluate((elementId) => {
    const el = document.getElementById(elementId)
    if (!el) throw new Error(`[constraint-owner] fixture #${elementId} missing`)
    const r = el.getBoundingClientRect()
    return { width: +r.width.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1) }
  }, id)
}

/** Write the naive edit a resize gesture would produce: current width + delta. */
async function resizeBy(page: Page, id: string, delta: number): Promise<void> {
  await page.evaluate(({ elementId, d }) => {
    const el = document.getElementById(elementId)
    if (!el) throw new Error(`[constraint-owner] fixture #${elementId} missing`)
    el.style.width = `${el.getBoundingClientRect().width + d}px`
  }, { elementId: id, d: delta })
}

/** Convenience for the +50px cases. */
const growBy50 = (page: Page, id: string): Promise<void> => resizeBy(page, id, 50)

test.beforeEach(async ({ page }) => {
  await page.setContent(FIXTURE)
})

test('justify-content: flex-end PINS the right edge — it does not move at all', async ({ page }) => {
  // This is why edgeResponse is 0 there. A drag on this edge can never move it,
  // no matter what width is written, so the resolver must refuse the gesture
  // rather than write a width that appears to do nothing.
  const before = await measure(page, 'endChild')
  await growBy50(page, 'endChild')
  const after = await measure(page, 'endChild')

  expect(after.width).toBeCloseTo(before.width + 50, 0)
  expect(after.right - before.right).toBeCloseTo(0, 0)
  // It grew leftward instead.
  expect(before.left - after.left).toBeCloseTo(50, 0)
})

test('justify-content: center moves the edge exactly HALF as far', async ({ page }) => {
  // This is why edgeResponse is 0.5, and why pointerDeltaToSizeDelta doubles
  // the delta — otherwise the element visibly lags the cursor.
  const before = await measure(page, 'centerChild')
  await growBy50(page, 'centerChild')
  const after = await measure(page, 'centerChild')

  expect(after.width).toBeCloseTo(before.width + 50, 0)
  expect(after.right - before.right).toBeCloseTo(25, 0)
})

test('flex-grow IGNORES an explicit width outright', async ({ page }) => {
  // The strongest case for routing to the flex allocation: the width lands in
  // source and the used width does not change by a single pixel.
  const before = await measure(page, 'growChild')
  await growBy50(page, 'growChild')
  const after = await measure(page, 'growChild')

  expect(before.width).toBeCloseTo(600, 0)
  expect(after.width).toBeCloseTo(600, 0)
  expect(after.right - before.right).toBeCloseTo(0, 0)
})

test('GROWING a grid item forces its track and steals width from the sibling', async ({ page }) => {
  // `1fr` is really `minmax(auto, 1fr)`. The `auto` minimum means the track
  // cannot be smaller than the item, so an explicit width drags the track with
  // it — and the sibling pays for it. Surprising, but not inert.
  const siblingBefore = await measure(page, 'gridSibling')
  await resizeBy(page, 'gridChild', 50)
  const after = await measure(page, 'gridChild')
  const siblingAfter = await measure(page, 'gridSibling')

  expect(after.width).toBeCloseTo(350, 0)
  expect(siblingAfter.width).toBeCloseTo(siblingBefore.width - 50, 0)
})

test('SHRINKING a grid item is inert — the track holds and nothing moves', async ({ page }) => {
  // The other half of the asymmetry, and the reason a naive grid resize feels
  // broken: 1fr reclaims nothing, so the item shrinks INSIDE a track that stays
  // put. No sibling moves and the gap is invisible.
  const siblingBefore = await measure(page, 'gridSibling')
  await resizeBy(page, 'gridChild', -50)
  const after = await measure(page, 'gridChild')
  const siblingAfter = await measure(page, 'gridSibling')

  expect(after.width).toBeCloseTo(250, 0)
  expect(siblingAfter.left).toBeCloseTo(siblingBefore.left, 0)
  expect(siblingAfter.width).toBeCloseTo(siblingBefore.width, 0)
})

test('an RTL row is start-anchored on the RIGHT, so the right edge is pinned', async ({ page }) => {
  // `direction: rtl` inverts the inline axis, so a start-anchored box grows
  // LEFTWARD. Missing this is silent — the drag still appears to work, just in
  // the wrong direction — which is why it is measured rather than reasoned about.
  const before = await measure(page, 'rtlChild')
  await growBy50(page, 'rtlChild')
  const after = await measure(page, 'rtlChild')

  expect(after.width).toBeCloseTo(before.width + 50, 0)
  expect(after.right - before.right).toBeCloseTo(0, 0)
  expect(before.left - after.left).toBeCloseTo(50, 0)
})
