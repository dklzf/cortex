import { test, expect } from '@playwright/test'
import { bootWithSendSpy, selectElement } from './helpers/panel.js'
import { handleCentre } from './helpers/resize-handle.js'

/**
 * The live size readout.
 *
 * Exists because the drag has no other feedback: `onResizeMove` computes the
 * size and nothing applies it, so the element does not move until release. A
 * drag that gets refused and a drag that works look identical until pointerup.
 */
test.describe('resize readout', () => {
  test('appears only while dragging, and tracks the pointer', async ({ page }) => {
    await bootWithSendSpy(page)
    await selectElement(page, '#center')

    const readout = () => page.evaluate(() => {
      const root = (document.querySelector('[data-cortex-host]') as any)?.shadowRoot
      const n = root?.querySelector('.cortex-resize-readout')
      return n ? n.textContent : null
    })

    // Idle: nothing.
    expect(await readout()).toBeNull()

    // Waits for the handle to be where it looks, rather than sleeping and
    // hoping. Measuring it before the RAF loop positions the overlay sends the
    // press to the page instead, and the test then fails with a null readout —
    // which looks like a rendering bug and is not one. That flaked 1 run in 3.
    const knob = await handleCentre(page, 'right', '#center')

    await page.mouse.move(knob.x, knob.y)
    await page.mouse.down()
    await page.mouse.move(knob.x + 60, knob.y, { steps: 5 })

    // POLLED, not read once. Preact batches state updates, so a bare read
    // straight after the mouse move races the render — that flaked 1 run in 3.
    // `expect.poll` retries the assertion rather than sleeping, so it stays
    // fast when the render is prompt and deterministic when it is not.
    //
    // A width drag, so it must say W — an H here would mean the axis mapping
    // broke, which is invisible in a screenshot.
    await expect.poll(readout).toMatch(/^W \d+$/)
    const first = Number((await readout())!.slice(2))

    await page.mouse.move(knob.x + 160, knob.y, { steps: 5 })
    // Tracks the pointer: a static number would look identical at one sample,
    // so the assertion is on the CHANGE, and it polls for the same reason.
    await expect.poll(async () => Number((await readout())!.slice(2)))
      .toBeGreaterThan(first)

    await page.mouse.up()
    // Gone on release — a readout that lingers reads as an unapplied edit.
    await expect.poll(readout).toBeNull()
  })
})
