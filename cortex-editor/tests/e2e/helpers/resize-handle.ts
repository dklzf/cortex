import type { Page } from '@playwright/test'

/**
 * The centre of a live resize handle, once it is actually where it looks.
 *
 * The overlay is positioned by a RAF loop, not by Preact — the JSX omits
 * width/height entirely so re-renders cannot clobber the RAF values. So a
 * handle exists in the DOM before it has a meaningful rect, and measuring it
 * too early yields a position the pointer will miss. The press then lands on
 * the page instead, the gesture never begins, and the test fails with
 * "readout was null" — which reads like a rendering bug and is not one.
 *
 * The first spec to press a handle papered over this with
 * `waitForTimeout(400)`. That is a sleep tuned to one machine: too short and it
 * flakes, too long and every run pays for it. This polls the CONDITION —
 * the handle has area and sits on the target's edge — so it is fast when the
 * overlay settles quickly and correct when it does not.
 */
export async function handleCentre(
  page: Page,
  edge: string,
  targetSelector: string,
  timeoutMs = 5000,
): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + timeoutMs
  let last = 'never measured'
  while (Date.now() < deadline) {
    const probe = await page.evaluate(([edge, sel]: [string, string]) => {
      const host = document.querySelector('[data-cortex-host]')
      const root = (host as (HTMLElement & { shadowRoot: ShadowRoot | null }) | null)?.shadowRoot
      const h = root?.querySelector(`[data-cortex-resize-edge="${edge}"]`)
      if (!h) return { ok: false as const, why: 'no handle in shadow root' }
      const r = h.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return { ok: false as const, why: 'handle has zero area' }

      const t = document.querySelector(sel)?.getBoundingClientRect()
      if (!t) return { ok: false as const, why: `no target ${sel}` }
      // The overlay tracks the element, so a settled handle sits ON the
      // element's box. An unsettled overlay is typically parked at the origin,
      // which this rejects without needing to know where it parks.
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2
      const near = cx >= t.left - 12 && cx <= t.right + 12 && cy >= t.top - 12 && cy <= t.bottom + 12
      if (!near) return { ok: false as const, why: `handle at ${Math.round(cx)},${Math.round(cy)} is off the target` }

      // The decisive check, and the reason a geometry-only version still flaked:
      // ask the SAME question the production code asks. `resolvePressed` calls
      // `shadowRoot.elementFromPoint` and then `closest('[data-cortex-resize-edge]')`,
      // so if that lookup does not reach this handle at these coordinates, the
      // press will be declined no matter how correct the rectangle looks.
      //
      // The two can disagree: a handle can have a settled rect while something
      // else — an overlay mid-reposition, a sibling handle overlapping at a
      // corner — is still what hit-testing returns there.
      const hit = root?.elementFromPoint(cx, cy)
      const resolved = hit?.closest?.('[data-cortex-resize-edge]')
      if (resolved !== h) {
        return {
          ok: false as const,
          why: `hit-test at ${Math.round(cx)},${Math.round(cy)} resolves to `
            + `${resolved?.getAttribute('data-cortex-resize-edge') ?? hit?.className ?? 'nothing'}, not "${edge}"`,
        }
      }
      return { ok: true as const, x: cx, y: cy }
    }, [edge, targetSelector] as [string, string])

    if (probe.ok) return { x: probe.x, y: probe.y }
    last = probe.why
    await page.waitForTimeout(25)
  }
  throw new Error(`resize handle "${edge}" never became pressable: ${last}`)
}
