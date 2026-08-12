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
    expect(o.reason).toContain('moved a sibling')
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
