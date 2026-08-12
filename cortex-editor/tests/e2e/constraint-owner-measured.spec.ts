/**
 * `measureConstraintOwner` against real Chromium layout (COR-3).
 *
 * Business purpose: a resize gesture needs two answers — which property actually
 * controls the size, and how far the grabbed edge travels per pixel of it. The
 * original resolver predicted both from a handful of parent CSS properties. A
 * post-merge review returned seven P1 findings, and five were confirmed by
 * measurement: the prediction was wrong in every one.
 *
 * Falsifiability note, and the reason this file exists rather than a unit test:
 * happy-dom does not lay out, so a unit test of a measurement function would be
 * asserting against a stub of the very thing under test — it could only prove
 * the function is self-consistent, which is exactly how the predicted resolver
 * passed its own tests while being wrong about CSS. Every case below is one of
 * the five measured failures, and each asserts the answer the BROWSER gives.
 *
 * The module is bundled into the page rather than imported from the product
 * bundle: it is not part of the browser IIFE's public surface, and bundling the
 * TypeScript source directly means these tests exercise the real code rather
 * than a copy that can drift.
 */
import { test, expect, type Page } from '@playwright/test'
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'

type Edge = 'left' | 'right' | 'top' | 'bottom'
interface Ownership {
  target: 'element' | 'flex-allocation' | 'grid-track'
  property: string
  appliesTo: 'self' | 'parent'
  edgeResponse: number
  reason: string
}

let BUNDLE = ''

test.beforeAll(async () => {
  const result = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../../src/browser/constraint-owner.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'CO',
    write: false,
    target: 'es2020',
  })
  BUNDLE = result.outputFiles[0]!.text
})

const FIXTURE = `<!doctype html><body style="margin:0">
  <!-- space-between, THREE children: the middle one grows both ways, which no
       switch over justify-content can express because the answer depends on the
       item's INDEX, not on the container's declaration. -->
  <div id="sbWrap" style="display:flex;justify-content:space-between;width:600px">
    <div style="width:100px;height:40px"></div>
    <div id="sbMiddle" style="width:100px;height:40px"></div>
    <div style="width:100px;height:40px"></div></div>

  <!-- align-self on the ITEM overrides the parent's align-items, so reading the
       parent alone gives the wrong answer. -->
  <div id="asWrap" style="display:flex;align-items:flex-start;height:200px;width:600px">
    <div id="asChild" style="width:100px;height:40px;align-self:center"></div></div>

  <!-- row-reverse: the cross axis is NOT reversed by flex-direction, but the
       predicted resolver folded reversal into both axes. -->
  <div id="rrWrap" style="display:flex;flex-direction:row-reverse;align-items:flex-start;height:200px;width:600px">
    <div id="rrChild" style="width:100px;height:40px"></div></div>

  <!-- Over-constrained line: children total 900px in a 600px box, so flex-shrink
       overrules any width written. flex-grow is 0, so the prediction called this
       element-owned. -->
  <div id="shrinkWrap" style="display:flex;width:600px">
    <div id="shrinkChild" style="width:300px;height:40px;flex-shrink:1"></div>
    <div style="width:300px;height:40px;flex-shrink:1"></div>
    <div style="width:300px;height:40px;flex-shrink:1"></div></div>

  <!-- justify-items:start — the item does NOT fill its track, so growing it
       moves its own edge and leaves the sibling alone. The prediction routed
       every grid item to the track unconditionally. -->
  <div id="gStartWrap" style="display:grid;grid-template-columns:1fr 1fr;justify-items:start;width:600px">
    <div id="gStartChild" style="width:100px;height:40px"></div>
    <div id="gStartSibling" style="width:100px;height:40px"></div></div>

  <!-- Stretched grid item: growing it DOES force the track and steal from the
       sibling, so this one really is track-owned. -->
  <div id="gStretchWrap" style="display:grid;grid-template-columns:1fr 1fr;width:600px">
    <div id="gStretchChild" style="height:40px"></div>
    <div id="gStretchSibling" style="height:40px"></div></div>

  <!-- Plain block child: the boring case must stay boring. -->
  <div id="blockWrap" style="width:600px">
    <div id="blockChild" style="width:200px;height:40px"></div></div>

  <!-- ── Round-1 review fixtures ─────────────────────────────────────────── -->

  <!-- A width transition: the synchronous read sees the transition's START
       value unless transitions are suppressed for the probe. -->
  <div id="transWrap" style="width:600px">
    <div id="transChild" style="width:200px;height:40px;transition:width 3s linear"></div></div>

  <!-- !important author rule: a normal-priority probe loses the cascade and
       measures nothing, reporting a resizable element as pinned. -->
  <style>#impChild { width: 200px !important }</style>
  <div id="impWrap" style="width:600px">
    <div id="impChild" style="height:40px"></div></div>

  <!-- display:contents between the flex container and the item: reading
       parentElement alone misses the flex context entirely. -->
  <div id="contentsWrap" style="display:flex;width:600px">
    <div style="display:contents">
      <div id="contentsChild" style="flex:1;height:40px"></div></div></div>

  <!-- Vertical writing mode grid: physical width is the BLOCK axis, so the
       controlling tracks are grid-template-ROWS. -->
  <div id="vwmWrap" style="display:grid;writing-mode:vertical-rl;grid-template-rows:1fr 1fr;width:600px;height:200px">
    <div id="vwmChild"></div><div id="vwmSibling"></div></div>

  <!-- Row flex whose child's HEIGHT (cross axis) is clamped by max-height.
       flex-shrink governs the main axis only, so naming it here is a dead end. -->
  <div id="crossWrap" style="display:flex;width:600px;height:300px">
    <div id="crossChild" style="width:100px;height:40px;max-height:48px"></div></div>

  <!-- Sitting on max-width: growth is clamped, but shrinking works fine.
       A growth-only probe calls this pinned and refuses an inward drag. -->
  <div id="maxWrap" style="width:600px">
    <div id="maxChild" style="width:200px;max-width:200px;height:40px"></div></div>

  <!-- Two stretched grid items in different ROWS of the same column: widening
       the column resizes the sibling WITHOUT moving its origin. -->
  <div id="colWrap" style="display:grid;grid-template-columns:auto 1fr;width:600px">
    <div id="colChild" style="height:40px"></div><div style="height:40px"></div>
    <div id="colSibling" style="height:40px"></div><div style="height:40px"></div></div>

  <!-- A SCALED element: getBoundingClientRect reports transformed pixels, so a
       100px box scaled 2x measures 200px. Writing 216px back would ask for +116
       CSS px, not +16. -->
  <div id="sclWrap" style="width:600px">
    <div id="sclChild" style="width:100px;height:40px;transform:scale(2);transform-origin:left top"></div></div>

  <!-- 40 children, space-between: growing the second-to-last moves its right
       edge by only 16/39 ~ 0.41px — a REAL response of ~0.026 that an absolute
       0.5px floor rounds to zero, disabling the edge entirely. -->
  <div id="manyWrap" style="display:flex;justify-content:space-between;width:1200px">
    ${Array.from({ length: 38 }, () => '<div style="width:10px;height:20px"></div>').join('')}
    <div id="manyChild" style="width:10px;height:20px"></div>
    <div style="width:10px;height:20px"></div></div>

  <!-- content-box with padding+border: computed width EXCLUDES them, the rect
       INCLUDES them. Deriving the scale from their ratio invents a >1 scale
       with no transform present. -->
  <div id="boxWrap" style="width:600px">
    <div id="boxChild" style="width:200px;height:40px;padding:20px;border:5px solid;box-sizing:content-box"></div></div>

  <!-- flex: 0 0 100px — the BASIS supplies the size, so flex-grow is a dead end. -->
  <div id="basisWrap" style="display:flex;width:600px">
    <div id="basisChild" style="flex:0 0 100px;min-width:0;height:40px"></div>
    <div style="flex:1;height:40px"></div></div>

  <!-- A non-replaced inline box: width does not apply at all. -->
  <div id="inlineWrap" style="width:600px">
    <span id="inlineChild">some text</span></div>

  <!-- An item placed in an IMPLICIT column (template declares one track). -->
  <!-- No explicit template at all, so BOTH columns are implicit 1fr tracks and
       growing one steals from the other — the track reallocation that makes the
       naming reachable in the first place. -->
  <div id="implicitWrap" style="display:grid;grid-auto-columns:1fr;grid-auto-flow:column;width:600px">
    <div id="implicitChild" style="height:40px"></div>
    <div style="height:40px"></div></div>

  <!-- A wrapping flex line the probe would tip over: two centred items totalling
       290px in a 300px container become two lines at +16px. -->
  <div id="wrapWrap" style="display:flex;flex-wrap:wrap;justify-content:center;width:300px">
    <div id="wrapChild" style="width:145px;height:40px"></div>
    <div style="width:145px;height:40px"></div></div>
</body>`

async function own(page: Page, id: string, edge: Edge): Promise<Ownership> {
  return await page.evaluate(
    ({ elementId, e }) => {
      const el = document.getElementById(elementId)
      if (!el) throw new Error(`[constraint-owner] fixture #${elementId} missing`)
      return (window as unknown as { CO: { measureConstraintOwner: (n: Element, x: string) => Ownership } })
        .CO.measureConstraintOwner(el, e)
    },
    { elementId: id, e: edge },
  )
}

test.beforeEach(async ({ page }) => {
  await page.setContent(FIXTURE)
  await page.addScriptTag({ content: BUNDLE })
})

test.describe('measureConstraintOwner — the five cases prediction got wrong', () => {
  test('space-between MIDDLE child grows both ways (predicted 0/1, measured 0.5)', async ({ page }) => {
    // The container says space-between, which the switch treated as
    // start-anchored. That is right for the FIRST item and wrong for a middle
    // one: free space redistributes on both sides, so each edge takes half.
    const right = await own(page, 'sbMiddle', 'right')
    expect(right.target).toBe('element')
    expect(right.edgeResponse).toBeCloseTo(0.5, 1)

    const left = await own(page, 'sbMiddle', 'left')
    expect(left.edgeResponse).toBeCloseTo(0.5, 1)
  })

  test('align-self on the ITEM beats align-items on the parent', async ({ page }) => {
    // The parent declares flex-start; the child overrides with center. Reading
    // the parent alone answers for a child that is not there.
    const bottom = await own(page, 'asChild', 'bottom')
    expect(bottom.target).toBe('element')
    expect(bottom.edgeResponse).toBeCloseTo(0.5, 1)
  })

  test('row-reverse does NOT reverse the cross axis', async ({ page }) => {
    // flex-direction reverses the MAIN axis only. The prediction folded
    // reversal into both, so it reported the bottom edge pinned when the top
    // edge is the one that is pinned.
    const bottom = await own(page, 'rrChild', 'bottom')
    expect(bottom.edgeResponse).toBeCloseTo(1, 1)

    const top = await own(page, 'rrChild', 'top')
    expect(top.edgeResponse).toBe(0)
    expect(top.reason).toContain('did not move')
  })

  test('an over-constrained flex child is flex-owned even with flex-grow: 0', async ({ page }) => {
    // Three 300px children in a 600px box. flex-shrink overrules any width
    // written, so `flex-grow > 0` — the prediction's ownership test — is neither
    // necessary nor sufficient. Only a write reveals it.
    const o = await own(page, 'shrinkChild', 'right')
    expect(o.target).toBe('flex-allocation')
    expect(o.property).toBe('flex-shrink')
    expect(o.reason).toContain('over-constrained')
  })

  test('a grid item that does NOT fill its track is element-owned', async ({ page }) => {
    // justify-items: start, so the item sits at 100px inside a 300px track.
    // Growing it moves its own right edge and the sibling never moves — the
    // naive edit is exactly right here, and routing to the track was wrong.
    const o = await own(page, 'gStartChild', 'right')
    expect(o.target).toBe('element')
    expect(o.property).toBe('width')
    expect(o.edgeResponse).toBeCloseTo(1, 1)
  })
})

test.describe('measureConstraintOwner — the cases prediction got right must stay right', () => {
  test('a STRETCHED grid item really is track-owned, and says why', async ({ page }) => {
    // The distinction from the case above is observed, not declared: growing
    // this item moves the sibling, so the track re-allocated.
    const o = await own(page, 'gStretchChild', 'right')
    expect(o.target).toBe('grid-track')
    expect(o.property).toBe('grid-template-columns')
    expect(o.appliesTo).toBe('parent')
    expect(o.reason).toContain('changed a sibling')
  })

  test('a plain block child is element-owned with 1:1 response', async ({ page }) => {
    const o = await own(page, 'blockChild', 'right')
    expect(o.target).toBe('element')
    expect(o.edgeResponse).toBeCloseTo(1, 1)
  })
})

test.describe('the probe must leave the page exactly as it found it', () => {
  test('restores an absent inline width rather than writing an empty one', async ({ page }) => {
    // Declarations, not the raw attribute string. Writing to `el.style` at all
    // makes Chromium re-serialize the whole attribute to canonical form
    // (`height:40px` becomes `height: 40px;`), so a probe can restore what the
    // declarations MEAN but never the bytes. That is inherent to perturbation
    // rather than a flaw in this implementation — worth stating plainly, since
    // anything diffing the attribute text will see a spurious change.
    const decls = () => page.evaluate(() => {
      const s = document.getElementById('gStretchChild')!.style
      return Array.from(s).map(p => `${p}:${s.getPropertyValue(p)}:${s.getPropertyPriority(p)}`).sort()
    })
    const before = await decls()
    await own(page, 'gStretchChild', 'right')
    // The load-bearing part: `width` must be ABSENT, not present-and-empty.
    // Leaving `width: 300px` behind would silently convert a stretched grid item
    // into a fixed-width one just by hovering it.
    expect(await decls()).toEqual(before)
    expect(before.some(d => d.startsWith('width:'))).toBe(false)
  })

  test('restores a pre-existing inline width AND its !important priority', async ({ page }) => {
    await page.evaluate(() => {
      document.getElementById('blockChild')!.style.setProperty('width', '222px', 'important')
    })
    await own(page, 'blockChild', 'right')
    const restored = await page.evaluate(() => {
      const s = document.getElementById('blockChild')!.style
      return { value: s.getPropertyValue('width'), priority: s.getPropertyPriority('width') }
    })
    // Priority is part of the declaration. Restoring the value alone would drop
    // the !important and change the cascade — a silent edit to the user's page.
    expect(restored).toEqual({ value: '222px', priority: 'important' })
  })

  test('the measured geometry is unchanged after probing', async ({ page }) => {
    const box = () => page.evaluate(() => {
      const r = document.getElementById('sbMiddle')!.getBoundingClientRect()
      return { w: +r.width.toFixed(1), l: +r.left.toFixed(1) }
    })
    const before = await box()
    await own(page, 'sbMiddle', 'right')
    expect(await box()).toEqual(before)
  })
})

test.describe('round-1 review: the probe must not be fooled by the page', () => {
  test('a width TRANSITION does not make a resizable element look pinned', async ({ page }) => {
    // The synchronous read lands at the transition's starting value, so
    // sizeDelta comes back ~0 and the element is reported pinned or
    // container-owned. Suppressing transitions for the probe is the only way to
    // read the settled value inside one task.
    const o = await own(page, 'transChild', 'right')
    expect(o.target).toBe('element')
    expect(o.edgeResponse).toBeCloseTo(1, 1)
  })

  test('an !important author width is still measurable', async ({ page }) => {
    // A normal-priority inline probe loses the cascade to
    // `#impChild { width: 200px !important }` and measures nothing — yet editing
    // that important declaration WOULD resize the element, so calling it pinned
    // is wrong. The probe outranks it to find out.
    const o = await own(page, 'impChild', 'right')
    expect(o.target).toBe('element')
    expect(o.edgeResponse).toBeCloseTo(1, 1)
  })

  test('a flex child under display:contents is still flex-owned', async ({ page }) => {
    // parentElement is the contents wrapper, which generates NO layout box; the
    // child participates directly in the flex context above it. Reading the
    // immediate parent left isFlex false and reported a `flex: 1` child as an
    // element-owned pinned width.
    const o = await own(page, 'contentsChild', 'right')
    expect(o.target).toBe('flex-allocation')
    expect(o.property).toBe('flex-grow')
  })

  test('a vertical-writing-mode grid names ROWS for a horizontal drag', async ({ page }) => {
    // Under vertical-rl the inline axis runs vertically, so physical width is the
    // BLOCK axis. Naming grid-template-columns sends the user to edit a property
    // that does not control the edge they grabbed.
    const o = await own(page, 'vwmChild', 'right')
    expect(o.target).toBe('grid-track')
    expect(o.property).toBe('grid-template-rows')
  })

  test('a PARTIALLY honoured cross-axis size is not blamed on flex-shrink', async ({ page }) => {
    // flex-shrink governs the MAIN axis only. This row child asks for +16px of
    // height and gets +8 because max-height clamps it — a partially honoured
    // write, which is exactly the signature the flex-shrink branch keys on.
    // Without the main-axis guard it names flex-shrink, sending the user to edit
    // a property that cannot affect this edge.
    const o = await own(page, 'crossChild', 'bottom')
    expect(o.property).not.toBe('flex-shrink')
    expect(o.property).not.toBe('flex-grow')
  })

  test('a CSS transform does not inflate the requested delta', async ({ page }) => {
    // The write is in CSS pixels; the rect is in transformed pixels. Deriving
    // the probe size from the RECT asked a 2x-scaled 100px element for 216px —
    // +116 CSS px rather than +16 — measuring a perturbation six times larger
    // than intended. The used size now comes from the computed style, which is
    // untransformed by definition, and the scale is carried so `requested` and
    // `sizeDelta` stay in one space.
    const probe = await page.evaluate(() => {
      const el = document.getElementById('sclChild')!
      return (window as unknown as {
        CO: { probeConstraint: (n: Element, e: string) => { sizeDelta: number; requested: number } | null }
      }).CO.probeConstraint(el, 'right')
    })
    // 16 CSS px through a 2x scale is 32 rect px — and the element must have
    // actually moved by that, not by 116-scaled nonsense.
    expect(probe!.requested).toBeCloseTo(32, 0)
    expect(probe!.sizeDelta).toBeCloseTo(32, 0)
  })

  test('a real but sub-pixel edge response is preserved, not rounded to pinned', async ({ page }) => {
    // 40 items in a space-between row: the second-to-last child's right edge
    // moves 16/39 ~ 0.41px for a 16px size change. That is a true response of
    // ~0.026, and an absolute 0.5px floor called it zero — which makes
    // pointerDeltaToSizeDelta refuse the drag outright.
    const o = await own(page, 'manyChild', 'right')
    expect(o.edgeResponse).toBeGreaterThan(0)
    expect(o.edgeResponse).toBeLessThan(0.2)
  })

  test('an element on its max-width reports that it can still SHRINK', async ({ page }) => {
    // Constraint response is directional. A growth-only probe is clamped to zero
    // here and would call the edge pinned, so pointerDeltaToSizeDelta refuses an
    // inward drag the user is entitled to make.
    const o = await own(page, 'maxChild', 'right')
    expect(o.target).toBe('element')
    expect(o.edgeResponse).toBeGreaterThan(0)
    expect(o.reason).toContain('shrink')
  })

  test('a grid sibling that RESIZES without moving still signals track ownership', async ({ page }) => {
    // Two stretched items in different rows of one column keep their origins
    // while the column widens. Comparing origins alone missed it and returned
    // element ownership for a genuinely track-allocated item.
    const o = await own(page, 'colChild', 'right')
    expect(o.target).toBe('grid-track')
  })

  test('a probe that tips a flex line into wrapping reports UNKNOWN, not a number', async ({ page }) => {
    // +16px pushes these two 145px items onto separate lines, and every
    // measurement after that describes an arrangement the user is not dragging
    // in — the edge can jump tens of pixels the wrong way. `probeConstraint`
    // returns null and the caller falls back rather than inventing a ratio.
    const probe = await page.evaluate(() => {
      const el = document.getElementById('wrapChild')!
      return (window as unknown as { CO: { probeConstraint: (n: Element, e: string) => unknown } })
        .CO.probeConstraint(el, 'right')
    })
    expect(probe).toBeNull()
  })
})

test.describe('round-2 review: box models, bases, and axes', () => {
  test('padding and borders do not fake a transform scale', async ({ page }) => {
    // computed width EXCLUDES padding/border under content-box; the rect
    // INCLUDES them. Deriving the scale from their ratio produced >1 with no
    // transform, inflating `requested` so a fully honoured write read as
    // partial. offsetWidth and the rect are both border-box, so their ratio is
    // the pure transform scale.
    const probe = await page.evaluate(() => {
      const el = document.getElementById('boxChild')!
      return (window as unknown as {
        CO: { probeConstraint: (n: Element, e: string) => { scale: number; requested: number } | null }
      }).CO.probeConstraint(el, 'right')
    })
    expect(probe!.scale).toBeCloseTo(1, 2)
    expect(probe!.requested).toBeCloseTo(16, 1)
  })

  test('a basis-driven flex item names flex-basis, not flex-grow', async ({ page }) => {
    // `flex: 0 0 100px` has no positive free space to grow into, so changing
    // flex-grow does nothing. Naming it is the same dead end as naming a grid
    // template for an implicit track.
    const o = await own(page, 'basisChild', 'right')
    expect(o.target).toBe('flex-allocation')
    expect(o.property).toBe('flex-basis')
  })

  test('a non-replaced inline box is refused, not answered', async ({ page }) => {
    // `width` does not apply to a <span>, and its computed width stays `auto`.
    // The prediction fallback would report element-owned width at 1:1 — a
    // confident answer about a property that cannot move this edge.
    const probe = await page.evaluate(() => {
      const el = document.getElementById('inlineChild')!
      return (window as unknown as { CO: { probeConstraint: (n: Element, e: string) => unknown } })
        .CO.probeConstraint(el, 'right')
    })
    expect(probe).toBeNull()
  })

  test('an implicit grid track is NOT distinguishable, and the code says so', async ({ page }) => {
    // Documents a real limitation rather than asserting a fix. Chromium reports
    // the RESOLVED used tracks for grid-template-columns — '300px 300px' whether
    // the tracks were declared or auto-generated — and grid-column-start stays
    // 'auto' for an auto-placed item. So an implicit track cannot be told apart
    // from an explicit one using computed styles, and naming grid-auto-columns
    // would be a guess. This test pins the browser behaviour that makes it
    // impossible, so if a future engine DOES expose the difference, it fails and
    // the limitation can be lifted.
    const observed = await page.evaluate(() => ({
      implicit: getComputedStyle(document.getElementById('implicitWrap')!).gridTemplateColumns,
      start: getComputedStyle(document.getElementById('implicitChild')!).gridColumnStart,
    }))
    expect(observed.implicit).toMatch(/^\d/)   // resolved px, not 'none'
    expect(observed.start).toBe('auto')        // no resolved line number to compare
  })

  test('pointerDeltaToSizeDelta divides by the transform scale', async ({ page }) => {
    // edgeResponse is a ratio of two screen-space measurements, so it is
    // scale-INVARIANT and looks correct under a transform. The drag handler is
    // not: it reads screen pixels and writes a CSS length, so a 20px drag on a
    // 2x element must become a 10px width change.
    const cssDelta = await page.evaluate(() => {
      const el = document.getElementById('sclChild')!
      const CO = (window as unknown as {
        CO: {
          measureConstraintOwner: (n: Element, e: string) => unknown
          pointerDeltaToSizeDelta: (o: unknown, e: string, d: number) => number | null
        }
      }).CO
      return CO.pointerDeltaToSizeDelta(CO.measureConstraintOwner(el, 'right'), 'right', 20)
    })
    expect(cssDelta).toBeCloseTo(10, 1)
  })
})
