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
  test('eight hittable handles render on the selected element', async ({ page }) => {
    await bootWithSendSpy(page)
    await selectElement(page, '#center')
    await page.waitForTimeout(400)

    const r = await report(page)
    expect('error' in r).toBe(false)
    if ('error' in r) return

    expect(r.overlayPresent).toBe(true)
    // Four edges plus four corners.
    expect(r.count).toBe(8)
    // Every edge reachable — a corner carries one edge, so all four appear.
    expect([...new Set(r.edges)].sort()).toEqual(['bottom', 'left', 'right', 'top'])
    // THE assertion this file exists for.
    expect(r.pointerEvents).toEqual(['auto'])
    expect(r.zeroArea).toBe(0)
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
