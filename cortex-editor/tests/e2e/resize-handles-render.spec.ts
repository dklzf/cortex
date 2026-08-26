/**
 * Resize handles on the REAL selection overlay.
 *
 * `resize-gesture.spec.ts` drives the gesture against a synthetic fixture, which
 * proves the reducer and the listener. It cannot prove the thing that actually
 * decides whether a designer can grab a handle: that Preact renders eight of
 * them into the closed shadow root, and that they are hittable there.
 *
 * `pointer-events: auto` is the load-bearing property. BOTH the shadow host
 * (`index.tsx`) and `.cortex-selection-overlay` (`styles.css`) are
 * `pointer-events: none`, so without it every press falls through to the page
 * element underneath and the REORDER listener fires instead — a resize press
 * silently starting a drag-to-reorder, invisible until source is wrong. A
 * regression here would not throw; it would just quietly do the wrong gesture.
 */
import { test, expect } from '@playwright/test'
import { bootWithSendSpy, selectElement } from './helpers/panel.js'

interface HandleReport {
  overlayPresent: boolean
  count: number
  edges: (string | null)[]
  corners: { corner?: string; edge: string | null; cursor: string }[]
  pointerEvents: string[]
  zeroArea: number
}

async function report(page: import('@playwright/test').Page): Promise<HandleReport | { error: string }> {
  return await page.evaluate(() => {
    // `setupDebugBridge` patches attachShadow to `open`, so the closed root is
    // reachable here — the same three-line dance the other panel helpers use.
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    if (!root) return { error: 'shadow root unreachable' }
    const handles = Array.from(root.querySelectorAll('[data-cortex-resize-edge]'))
    return {
      overlayPresent: !!root.querySelector('.cortex-selection-overlay'),
      count: handles.length,
      edges: handles.map(h => h.getAttribute('data-cortex-resize-edge')),
      // Corner class -> the edge it drags -> the cursor shown. A corner styled
      // with a diagonal cursor that only moves one axis is a promise the
      // gesture cannot keep.
      corners: handles
        .filter(h => /--(nw|ne|sw|se)$/.test(h.className))
        .map(h => ({
          corner: h.className.split('--').pop(),
          edge: h.getAttribute('data-cortex-resize-edge'),
          cursor: getComputedStyle(h).cursor,
        })),
      pointerEvents: [...new Set(handles.map(h => getComputedStyle(h).pointerEvents))],
      // A handle with no box cannot be pressed however correct its CSS is.
      zeroArea: handles.filter(h => {
        const r = h.getBoundingClientRect()
        return r.width === 0 || r.height === 0
      }).length,
    }
  })
}

test.describe('resize handles — the real overlay', () => {
  test('only handles that CAN act are rendered, and all are hittable', async ({ page }) => {
    await bootWithSendSpy(page)
    await selectElement(page, '#center')
    await page.waitForTimeout(400)

    const r = await report(page)
    expect('error' in r).toBe(false)
    if ('error' in r) return

    expect(r.overlayPresent).toBe(true)
    // NOT a fixed count. `canResizeEdge` probes each edge, and in normal flow an
    // element's top-left is ANCHORED — changing `width` moves the right edge,
    // so left and top genuinely cannot be dragged. Measured on ordinary
    // layouts, that is 4 of 8 handles on a plain block element.
    //
    // Rendering them anyway would mean half the handles exist only to produce
    // an error banner in engine language. Asserting a count of 8 would pin the
    // behaviour this fix removes, so the assertion is on the PROPERTY instead:
    // some handles, none of them inert.
    // The EXACT set for this fixture, measured: a plain block element in normal
    // flow responds on `right` and `bottom` only, so the two right-hand corners
    // survive and the two left-hand ones do not.
    //
    // `toBeGreaterThan(0)` was the first version of this, and it was weaker than
    // the facts allow: it passes for 1 handle, for 8, and for any wrong subset.
    // A range assertion where an exact one is available is a test declining to
    // check the thing it knows.
    expect(r.count).toBe(4)
    expect(r.edges.slice().sort()).toEqual(['bottom', 'right', 'right', 'right'])
    // THE assertion this file exists for.
    expect(r.pointerEvents).toEqual(['auto'])
    expect(r.zeroArea).toBe(0)
  })

  test('every corner cursor matches the axis that corner actually drags', async ({ page }) => {
    // The bug: all four corners carried a VERTICAL edge while being styled
    // `nwse-resize`/`nesw-resize`. `onResizeMove` discards travel on the other
    // axis, so a designer saw a diagonal cursor, dragged the SE corner sideways
    // to widen the box, and only the HEIGHT changed — or, dragging purely
    // horizontally, nothing happened at all.
    //
    // Corners now drag a horizontal edge and say `ew-resize`. Asserting the
    // PAIR is what makes this falsifiable: either half alone can be changed
    // without the test noticing, and it is the mismatch that misleads.
    await bootWithSendSpy(page)
    await selectElement(page, '#center')
    await page.waitForTimeout(400)

    const r = await report(page)
    if ('error' in r) return

    // However many corners survive the capability filter, each must drag a
    // horizontal edge and SAY so. The pairing is the assertion — either half
    // alone can change without the test noticing, and it is the mismatch that
    // misleads a designer.
    // Both surviving corners, named. Same reasoning as the count above.
    expect(r.corners.map(c => c.corner).sort()).toEqual(['ne', 'se'])
    for (const c of r.corners) {
      expect(['left', 'right']).toContain(c.edge)
      expect(c.cursor).toBe('ew-resize')
    }
  })

  test('pressing a REAL shadow-DOM handle actually begins the gesture', async ({ page }) => {
    // The step this file previously stopped one short of, and the gap that hid
    // a critical bug: it proved handles EXIST and are styled hittable, then
    // never pressed one.
    //
    // Handles live inside a CLOSED shadow root, so a window listener receives
    // `event.target` retargeted to the host, and `composedPath()` trimmed there
    // as well — measured in Chromium: path length 5, handle absent. Resolving
    // the press off `event.target` therefore declined EVERY real handle while
    // the synthetic-fixture spec passed, because in light DOM `event.target`
    // simply is the handle.
    //
    // Symptom before the fix: eight correct-looking handles with the right
    // cursors that do nothing at all. No error, no console output.
    await bootWithSendSpy(page)
    await selectElement(page, '#center')
    await page.waitForTimeout(400)

    const box = await page.evaluate(() => {
      const host = document.querySelector('[data-cortex-host]')
      const root = (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
      const h = root?.querySelector('[data-cortex-resize-edge="right"]')
      if (!h) return null
      const r = h.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    expect(box).not.toBeNull()

    // Watch the OVERLAY for the probe's inline-style mutation. The probe is the
    // first thing `beginResize` does, so a single mutation on the target proves
    // the gesture began — without needing the staging buffer wired up here.
    await page.evaluate(() => {
      const w = window as unknown as { __probes: number }
      w.__probes = 0
      const el = document.querySelector('#center')
      if (el) new MutationObserver(() => { w.__probes++ })
        .observe(el, { attributes: true, attributeFilter: ['style'] })
    })

    await page.mouse.move(box!.x, box!.y)
    await page.mouse.down()
    await page.mouse.move(box!.x + 60, box!.y, { steps: 6 })
    await page.mouse.up()

    // `measureConstraintOwner` writes and reverts an inline !important size at
    // pointerdown. Zero mutations means `begin` declined the press.
    expect(await page.evaluate(() => (window as unknown as { __probes: number }).__probes))
      .toBeGreaterThan(0)
  })

  test('an INERT edge gets no handle at all', async ({ page }) => {
    // Measured, not assumed. On a plain block element in normal flow the engine
    // reports `edgeResponse: 0` for `left` and `top` — the top-left is anchored,
    // so changing `width` moves the RIGHT edge and the left one cannot follow.
    // That is the engine telling the truth, not a bug in it.
    //
    // Before this fix all eight handles rendered regardless, so half of them
    // existed only to produce a banner in engine language ("Measured: this
    // element's width changed but the left edge did not move…") on the most
    // common element in any app. The banner has no dismiss and clears only on
    // selection change, so they accumulated.
    await bootWithSendSpy(page)
    await selectElement(page, '#center')
    await page.waitForTimeout(400)

    const r = await report(page)
    if ('error' in r) return

    // The concrete expectation for this fixture: `left`/`top` are inert, so
    // neither appears. If a future engine change makes them respond, this fails
    // loudly rather than silently widening the affordance.
    //
    // (An earlier draft looped over the rendered edges asserting `offsetWidth >
    // 0`, which is true of every visible element and therefore asserted
    // nothing. Removed rather than left as decoration.)
    expect(r.edges).not.toContain('top')
    expect(r.edges).not.toContain('left')
  })

  test('no handles render for a MULTI selection', async ({ page }) => {
    // `beginResize` probes the primary element; `applyOverride` then fans the
    // result out to every selected element. A secondary that is a stretched
    // flex child would receive `width` alone — the declaration lands in source,
    // the diff looks right, and the element does NOT move. Exactly what the pin
    // design exists to prevent, arriving through the fan-out door.
    //
    // Gated rather than solved: a correct multi-select resize probes per
    // target, which is N DOM-mutating probes at release. Worth designing; not
    // worth shipping the version that silently no-ops on half the selection.
    await bootWithSendSpy(page)
    await selectElement(page, '#center')
    await page.waitForTimeout(300)
    const single = await report(page)
    // Control with a KNOWN value: if the single-selection case ever stops
    // rendering 4, this test's premise is gone and the multi-select assertion
    // below would pass vacuously.
    expect('error' in single ? 0 : single.count).toBe(4)

    // `selectElements` is the multi-select entry point — the single-element
    // `selectElement` shim ignores an action argument, so passing 'add' to it
    // selected one element and the gate correctly did nothing.
    const selected = await page.evaluate(() => {
      const bridge = (globalThis as unknown as {
        __CORTEX_TEST__?: { selectElements?: (els: Element[]) => void }
      }).__CORTEX_TEST__
      const els = Array.from(document.querySelectorAll('[data-cortex-source]')).slice(0, 2)
      if (els.length < 2 || !bridge?.selectElements) return 0
      bridge.selectElements(els)
      return els.length
    })
    // Control: if the fixture cannot produce a 2-element selection, this test
    // proves nothing about the gate.
    expect(selected).toBe(2)
    await page.waitForTimeout(300)

    const r = await report(page)
    if ('error' in r) return
    expect(r.count).toBe(0)
  })

  test('no handles render when nothing is selected', async ({ page }) => {
    // The control. Without it the test above passes for a build that renders
    // handles unconditionally, which would put grab targets over the page
    // whenever cortex is active.
    await bootWithSendSpy(page)
    await page.waitForTimeout(400)

    const r = await report(page)
    if ('error' in r) return
    expect(r.count).toBe(0)
  })
})
