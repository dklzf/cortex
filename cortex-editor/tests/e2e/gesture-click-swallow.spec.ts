import { test, expect } from '@playwright/test'
import { bootWithSendSpy, selectElement } from './helpers/panel.js'
import { handleCentre } from './helpers/resize-handle.js'

/**
 * A completed drag must not also change the selection.
 *
 * This can only be tested in the ASSEMBLED app. Both the selection handler and
 * the gesture handler are capture-phase `click` listeners on `window`, and
 * same-target capture listeners fire in REGISTRATION order — selection is
 * installed long before either gesture. So selection ran first, selected
 * whatever sat under the release point, and the gesture's `stopPropagation`
 * executed too late to matter.
 *
 * The unit harness could not see it: it installs one listener and no selection
 * layer, so the ordering that causes the bug does not exist there.
 */
test.describe('a completed drag does not steal the selection', () => {
  // The SELECTION overlay's label specifically. `.cortex-label` alone also
  // matches the HOVER overlay's label, which follows the pointer — reading that
  // reports a "selection change" on any mouse move and makes this test lie in
  // both directions.
  const label = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const root = (document.querySelector('[data-cortex-host]') as any)?.shadowRoot
    return root?.querySelector('.cortex-selection-overlay .cortex-label')?.textContent ?? null
  })
  const centreOf = (page: import('@playwright/test').Page, sel: string) =>
    page.evaluate((q) => {
      const r = document.querySelector(q)!.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, sel)

  test('a resize released over a DIFFERENT element keeps the original selected', async ({ page }) => {
    await bootWithSendSpy(page)
    await selectElement(page, '#center')
    const before = await label(page)

    const knob = await handleCentre(page, 'right', '#center')
    const elsewhere = await centreOf(page, '#left')

    // The control below proves a plain click here WOULD change the selection,
    // so releasing a drag here is the real test and not a no-op.
    await page.mouse.move(knob.x, knob.y)
    await page.mouse.down()
    await page.mouse.move(elsewhere.x, elsewhere.y, { steps: 10 })
    await page.mouse.up()

    await expect.poll(() => label(page)).toBe(before)
  })

  test('control: a plain click on that element DOES change the selection', async ({ page }) => {
    // Without this, the test above passes just as happily on a build where
    // click-to-select is broken or disabled entirely.
    await bootWithSendSpy(page)
    await selectElement(page, '#center')
    const before = await label(page)

    const elsewhere = await centreOf(page, '#left')
    await page.mouse.click(elsewhere.x, elsewhere.y)

    await expect.poll(() => label(page)).not.toBe(before)
  })
})
