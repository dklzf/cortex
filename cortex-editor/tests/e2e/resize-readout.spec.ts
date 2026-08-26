import { test, expect } from '@playwright/test'
import { bootWithSendSpy, selectElement } from './helpers/panel.js'

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

    const knob = await page.evaluate(() => {
      const root = (document.querySelector('[data-cortex-host]') as any)?.shadowRoot
      const h = root?.querySelector('[data-cortex-resize-edge="right"]')
      const r = h.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })

    await page.mouse.move(knob.x, knob.y)
    await page.mouse.down()
    await page.mouse.move(knob.x + 60, knob.y, { steps: 5 })

    const during = await readout()
    expect(during).not.toBeNull()
    // A width drag, so it must say W — an H here would mean the axis mapping
    // broke, which is invisible in a screenshot.
    expect(during).toMatch(/^W \d+$/)

    const first = Number(during!.slice(2))
    await page.mouse.move(knob.x + 160, knob.y, { steps: 5 })
    const second = Number((await readout())!.slice(2))
    // Tracks the pointer: a static number would look identical at one sample.
    expect(second).toBeGreaterThan(first)

    await page.mouse.up()
    // Gone on release — a readout that lingers reads as an unapplied edit.
    expect(await readout()).toBeNull()
  })
})
