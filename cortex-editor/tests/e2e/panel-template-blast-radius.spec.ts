/**
 * Template blast-radius banner — E2E spec (ZF0-1584).
 *
 * Business purpose: T1 (ZF0-1582) added detectSharedSource(), which detects
 * when a selected element shares its data-cortex-source with 2+ siblings —
 * the hallmark of a .map()-rendered list where editing one item edits all.
 * T2 (ZF0-1583) wired that into Panel: when sharedSourceInfo is non-null AND
 * no CSS-class sharing is detected, Panel renders an "Editing all N — they
 * share one source location" banner (cortex-panel__scope--source-only). Hovering the banner calls
 * highlightSharedElements(), which adds data-cortex-blast-radius to every
 * sibling (excluding the selected element). Mouse-leave calls clearHighlights()
 * to remove the attribute.
 *
 * This spec exercises the complete flow in a real browser:
 *
 *   1. Select #map-item-0 (shares data-cortex-source="fixture:map:1" with two
 *      siblings). Panel's detectSharedSource() sees count=3.
 *   2. Assert: banner states the edit scope ("Editing all N").
 *   3. Assert: the count shown in the banner matches the actual DOM sibling
 *      count (3 in the fixture, so the banner reads "Editing all 3").
 *   4. Hover the banner → assert data-cortex-blast-radius is present on
 *      #map-item-1 and #map-item-2 (the non-selected siblings). rAF-deferred;
 *      poll required.
 *   5. Mouse-leave → assert data-cortex-blast-radius is absent on all siblings.
 *      Also rAF-deferred; poll required.
 *
 * Why hover via page.evaluate instead of page.locator.hover():
 * The banner lives inside a closed Shadow DOM. Playwright's shadow-piercing
 * `locator('>> css')` syntax resolves to `locator(':scope >> css')` under the
 * hood, but `page.locator('[data-cortex-host]').locator(':scope >> ...')` is
 * the correct pattern for piercing one level. However, dispatching
 * mouseenter/mouseleave directly from page.evaluate is simpler and avoids
 * the coordinate calculations that Playwright's `.hover()` requires (the host
 * may be positioned off-screen in headless mode). The banner's onMouseEnter
 * and onMouseLeave are Preact event handlers — synthetic events dispatched via
 * `element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))`
 * fire them correctly, matching what a real mouse gesture would produce.
 *
 * Tagged @fast-ci so /e2e fast includes it in the preflight gate.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FALSIFIABILITY PROOF
 * Performed per CLAUDE.md Test Anti-Patterns §2 after the spec was written.
 *
 *   Mutation A (banner count): In Panel.tsx sharedSourceInfo detection,
 *   forced setSharedSourceInfo(null) before calling detectSharedSource —
 *   the banner never renders. Step 2 FAILED: expect.poll on banner
 *   text-content found empty string. Reverted — green.
 *
 *   Mutation B (highlight attribute): In highlightSharedElements(), removed
 *   the el.setAttribute(HIGHLIGHT_ATTR, '') call. Step 4 FAILED:
 *   expect.poll saw data-cortex-blast-radius absent on #map-item-1.
 *   Reverted — green.
 *
 *   Mutation C (clear attribute): In clearHighlights(), removed the
 *   el.removeAttribute(HIGHLIGHT_ATTR) call. Step 5 FAILED: expect.poll
 *   saw data-cortex-blast-radius still present after mouse-leave. Reverted —
 *   green.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { test, expect } from '@playwright/test'
import { bootFixture } from './helpers/boot.js'
import { selectElement, waitForElementStatePanel } from './helpers/panel.js'
import {
  FIXTURE_MAP_SELECTOR,
  FIXTURE_MAP_SOURCE,
  FIXTURE_MAP_COUNT,
} from './helpers/fixture-server.js'

test.describe('Template blast-radius banner (ZF0-1584) @fast-ci', () => {
  test(
    'selecting a .map()-rendered element shows the "Editing all N" banner, ' +
      'hover adds data-cortex-blast-radius to siblings, mouse-leave clears it',
    async ({ page }) => {
      // ── Boot ──────────────────────────────────────────────────────────────
      // activateDesignMode: Panel must render for sharedSourceInfo to fire.
      // collectDivergences: false — this spec doesn't assert on override events.
      await bootFixture(page, { activateDesignMode: true, collectDivergences: false })

      // ── Step 1: select #map-item-0 ────────────────────────────────────────
      // selectElement calls bridge.selectElement(el) — same path as a real
      // click selection. Panel's useEffect runs detectSharedSource(element)
      // on the next microtask and calls setSharedSourceInfo({count:3, …}).
      await selectElement(page, FIXTURE_MAP_SELECTOR)

      // Wait for Panel to commit the element-state branch (section-group
      // guard). Without this, the banner assertion below races against Preact's
      // async state commit and can find the null-state branch instead.
      await waitForElementStatePanel(page)

      // ── Step 2: banner states the edit SCOPE ──────────────────────────────
      // cortex-panel__scope--source-only is the stable class for the
      // SharedSourceInfo banner. Copy is "Editing all N — they share one source
      // location": COR-12 changed it from "Used by N elements" because that
      // described the SOURCE while leaving the consequence — that the edit hits
      // all N — for the user to infer. We assert on text-content after polling
      // because detectSharedSource fires inside a useEffect, so Preact commits
      // asynchronously after selectElement.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const host = document.querySelector('[data-cortex-host]')
              const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
              if (!root) return null
              const banner = root.querySelector('.cortex-panel__scope--source-only')
              return banner?.textContent?.trim() ?? null
            }),
          { timeout: 3000 },
        )
        .toContain('Editing all')

      // ── Step 3: displayed count matches actual DOM sibling count ──────────
      // FIXTURE_MAP_COUNT is the source of truth (3). The banner renders
      // `sharedSourceInfo.count` which is set by detectSharedSource() counting
      // all [data-cortex-source="fixture:map:1"] elements in the DOM.
      // Asserting both the banner text AND the raw DOM count verifies that:
      //   a) the banner reads from sharedSourceInfo.count (not a hardcoded stub)
      //   b) the fixture elements are present as expected
      const actualDomCount = await page.evaluate(
        (source) => document.querySelectorAll(`[data-cortex-source="${source}"]`).length,
        FIXTURE_MAP_SOURCE,
      )
      expect(actualDomCount).toBe(FIXTURE_MAP_COUNT)

      const bannerText = await page.evaluate(() => {
        const host = document.querySelector('[data-cortex-host]')
        const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
        if (!root) return null
        const banner = root.querySelector('.cortex-panel__scope--source-only')
        return banner?.textContent?.trim() ?? null
      })
      expect(bannerText).toContain(`${FIXTURE_MAP_COUNT}`)

      // ── Step 4: hover adds data-cortex-blast-radius to siblings ──────────
      // Dispatch mouseenter on the banner element inside the shadow root.
      // highlightSharedElements() is rAF-deferred so we poll for the attribute.
      // The selected element (#map-item-0) is EXCLUDED from highlighting per
      // Panel.tsx:117 (`if (el === selected) continue`).
      await page.evaluate(() => {
        const host = document.querySelector('[data-cortex-host]')
        const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
        if (!root) throw new Error('[test] shadow root not accessible — setupDebugBridge must open it')
        const banner = root.querySelector('.cortex-panel__scope--source-only')
        if (!banner) throw new Error('[test] blast-radius banner not found in shadow root')
        banner.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
      })

      // Poll for rAF — highlight fires on next animation frame.
      await expect
        .poll(
          () =>
            page.evaluate(() => ({
              item1: document.querySelector('#map-item-1')?.hasAttribute('data-cortex-blast-radius') ?? false,
              item2: document.querySelector('#map-item-2')?.hasAttribute('data-cortex-blast-radius') ?? false,
              // Selected element must NOT receive the highlight attribute.
              item0: document.querySelector('#map-item-0')?.hasAttribute('data-cortex-blast-radius') ?? false,
            })),
          { timeout: 2000 },
        )
        .toMatchObject({ item1: true, item2: true, item0: false })

      // ── Step 5: mouse-leave clears data-cortex-blast-radius ───────────────
      // clearHighlights() is also rAF-deferred — poll for removal.
      await page.evaluate(() => {
        const host = document.querySelector('[data-cortex-host]')
        const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
        if (!root) throw new Error('[test] shadow root not accessible')
        const banner = root.querySelector('.cortex-panel__scope--source-only')
        if (!banner) throw new Error('[test] blast-radius banner not found for mouseleave')
        banner.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
      })

      await expect
        .poll(
          () =>
            page.evaluate(() =>
              document.querySelectorAll('[data-cortex-blast-radius]').length,
            ),
          { timeout: 2000 },
        )
        .toBe(0)
    },
  )
})
