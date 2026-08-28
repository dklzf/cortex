import { test, expect } from '@playwright/test'
import { bootWithSendSpy, selectElement, selectElements } from './helpers/panel.js'
import { handleCentre } from './helpers/resize-handle.js'

/**
 * The write must not outlive the measurement it was based on.
 *
 * `beginResize` probes ONE element at pointerdown. `applyOverride` writes to
 * whatever Panel has selected at pointerup. Nothing keeps those agreeing across
 * a drag — an HMR remount or a programmatic selection change redirects the
 * write while the size still describes the first element.
 *
 * This had no test, and the guard it protects was DEAD CODE for the whole
 * first half of this branch (`pointer-gesture` handed `onResult` the
 * post-transition state, so `phase !== 'idle'` never held). It then broke a
 * second time when the release-coordinate fix added a transition that ran
 * before `onResult` and wiped the press-time snapshot. Twice silently, so it
 * gets an assertion.
 */
test.describe('resize when the selection moves under the gesture', () => {
  test('refuses rather than writing the measured size to a different element', async ({ page }) => {
    await bootWithSendSpy(page)
    await selectElement(page, '#center')
    const knob = await handleCentre(page, 'right', '#center')

    const widthOf = (sel: string) => page.evaluate(
      (s) => (document.querySelector(s) as HTMLElement).getBoundingClientRect().width, sel)
    const before = await widthOf('#center')

    await page.mouse.move(knob.x, knob.y)
    await page.mouse.down()
    await page.mouse.move(knob.x - 80, knob.y, { steps: 6 })

    // The selection moves mid-gesture, exactly as an HMR remount would do it.
    await selectElement(page, '#left')
    await page.mouse.up()

    const banner = await page.evaluate(() => {
      const root = (document.querySelector('[data-cortex-host]') as any)?.shadowRoot
      return root?.querySelector('.cortex-resize-refusal')?.textContent ?? null
    })
    expect(banner).toMatch(/selection changed/i)

    // And nothing was written — to either element. A refusal that still wrote
    // would be the worst of both.
    expect(await widthOf('#center')).toBe(before)
  })

  test('refuses when an element is ADDED to the selection mid-drag', async ({ page }) => {
    // The narrower hole: the PRIMARY is unchanged, so an identity check passes
    // — but `applyOverride` fans the primary's pin out to the newcomer, whose
    // ownership was never measured.
    await bootWithSendSpy(page)
    await selectElement(page, '#center')
    const knob = await handleCentre(page, 'right', '#center')

    await page.mouse.move(knob.x, knob.y)
    await page.mouse.down()
    await page.mouse.move(knob.x - 80, knob.y, { steps: 6 })

    await selectElements(page, ['#center', '#left'])
    await page.mouse.up()

    const banner = await page.evaluate(() => {
      const root = (document.querySelector('[data-cortex-host]') as any)?.shadowRoot
      return root?.querySelector('.cortex-resize-refusal')?.textContent ?? null
    })
    expect(banner).toMatch(/selection changed/i)
  })
})
