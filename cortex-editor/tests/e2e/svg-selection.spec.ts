/**
 * SVG selection in real Chromium.
 *
 * Business purpose: clicking an icon used to CLEAR your selection.
 * `getTargetElement` guarded on `el instanceof HTMLElement`, and
 * `SVGElement extends Element` — so every SVG target resolved to null, and
 * `handleClick` reads null as "backdrop, clear the selection".
 *
 * Why these assertions live in Playwright and not in the happy-dom suite:
 *
 *   1. `document.elementFromPoint` is a hard-coded `return null` in happy-dom.
 *      The unit tests mock it, which is fine for the null-vs-element branch but
 *      cannot show WHICH node a real hit-test returns. SVG hit-testing is
 *      geometry-based, so a click on an icon returns the inner shape — that
 *      premise is what the normalize-to-<svg> behavior rests on, and this is the
 *      only place it can be checked.
 *
 *   2. `SVGElement.className` is an `SVGAnimatedString` in real browsers but a
 *      plain string in happy-dom. Any unit assertion on the `getAttribute('class')`
 *      fallback passes before AND after the fix — textbook happy-dom theatre
 *      (CLAUDE.md Test Anti-Pattern #3). Real Chromium is authoritative here.
 *
 * Both icons in the fixture have a filled rect covering the whole viewBox, so a
 * center click deterministically lands on a CHILD of the <svg>.
 */
import { test, expect } from '@playwright/test'
import { bootFixture } from './helpers/boot.js'
import {
  FIXTURE_ICON_SELECTOR,
  FIXTURE_ICON_SOURCE,
  FIXTURE_ICON_SHAPE_SOURCE,
  FIXTURE_ICON_UNANNOTATED_SELECTOR,
} from './helpers/fixture-server.js'

/** Commit a gesture on whatever is currently selected and read the buffer back.
 *  Using the staged intent as the observable is deliberate: it proves the WHOLE
 *  chain (real hit-test → normalization → source resolution → staging), not just
 *  that some element got highlighted. */
async function commitAndReadIntents(page: import('@playwright/test').Page, property: string, value: string) {
  await page.evaluate(async ([prop, val]) => {
    const bridge = (globalThis as unknown as {
      __CORTEX_TEST__?: { commitEdit?: (p: string, v: string) => Promise<void> }
    }).__CORTEX_TEST__
    if (!bridge?.commitEdit) throw new Error('[test] bridge.commitEdit not present — is this a test build?')
    await bridge.commitEdit(prop as string, val as string)
  }, [property, value])

  return page.evaluate(() => {
    const bridge = (globalThis as unknown as {
      __CORTEX_TEST__?: { buffer?: { list: () => Array<Record<string, unknown>> } }
    }).__CORTEX_TEST__
    if (!bridge?.buffer) throw new Error('[test] bridge.buffer not present')
    return bridge.buffer.list()
  })
}

test.describe('SVG selection in real Chromium', () => {
  test('clicking an icon selects the <svg>, not the shape under the cursor, and not nothing', async ({ page }) => {
    await bootFixture(page, { activateDesignMode: true, collectDivergences: false })

    // Sanity-check the premise before relying on it: a real hit-test at the
    // icon's centre must return the RECT, not the <svg>. If Chromium ever
    // changed this, the normalization would be solving a problem that no longer
    // exists and this spec should fail loudly rather than pass vacuously.
    const box = (await page.locator(FIXTURE_ICON_SELECTOR).boundingBox())!
    const hitTagName = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x as number, y as number)?.id ?? null,
      [box.x + box.width / 2, box.y + box.height / 2],
    )
    expect(hitTagName).toBe('icon-shape')

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

    const intents = await commitAndReadIntents(page, 'opacity', '0.5')

    // Pre-fix: zero intents — the click cleared the selection, so commitEdit had
    // nothing to fan out. A naive widening would give FIXTURE_ICON_SHAPE_SOURCE
    // instead, i.e. "that one rect" rather than "the icon".
    expect(intents).toHaveLength(1)
    expect(intents[0]!.source).toBe(FIXTURE_ICON_SOURCE)
    expect(intents[0]!.source).not.toBe(FIXTURE_ICON_SHAPE_SOURCE)
    expect(intents[0]!.property).toBe('opacity')
  })

  test('an unannotated icon keeps its class in the agent-resolve hint', async ({ page }) => {
    await bootFixture(page, { activateDesignMode: true, collectDivergences: false })

    const box = (await page.locator(FIXTURE_ICON_UNANNOTATED_SELECTOR).boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

    const intents = await commitAndReadIntents(page, 'opacity', '0.5')
    expect(intents).toHaveLength(1)

    const intent = intents[0]!
    expect(intent.applyMode).toBe('agent-resolve')

    const hint = intent.sourceResolutionHint as { className?: string; tagName: string; domSelector: string }
    expect(hint.tagName).toBe('svg')
    // Pre-fix: className absent and domSelector 'svg'. `className` is an
    // SVGAnimatedString here, so the old `typeof === 'string'` guard silently
    // dropped it — and for a third-party icon (lucide et al., unannotated
    // because source-transform skips node_modules) that class is the single
    // strongest signal Claude has for locating the call site.
    expect(hint.className).toBe('lucide lucide-check')
    expect(hint.domSelector).toBe('svg.lucide')
  })
})
