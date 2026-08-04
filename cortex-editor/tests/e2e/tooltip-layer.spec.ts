/**
 * TooltipLayer e2e coverage for ZF0-962.
 *
 * Business purpose: unit tests can prove event delegation and Floating UI calls,
 * but the regression was visual: CSS pseudo-element tooltips were clipped by
 * `.cortex-panel__body` overflow. This spec uses real Chromium layout to scroll
 * a NumericInput to the panel-body boundary, hover it, and prove the rendered
 * `.cortex-tooltip` escapes that clipping container without using the Native
 * Popover API attribute.
 */
import { test, expect } from '@playwright/test'
import { FIXTURE_SEED_SELECTOR } from './helpers/fixture-server.js'
import {
  bootWithSendSpy,
  selectElement,
  waitForElementStatePanel,
} from './helpers/panel.js'

test('NumericInput tooltip escapes panel-body clipping without Native Popover API', async ({ page }) => {
  // Shrink the viewport so the panel body is reliably shorter than its section
  // content. This test scrolls the Width NumericInput to the panel-body's top
  // edge — which only works if there is at least a viewport's worth of content
  // below it. The default 1280x800 viewport left almost no slack, so a section
  // legitimately getting shorter (e.g. the Effects empty state losing the
  // always-on BL/BG block) would clamp the scroll and break the precondition.
  // A 600px-tall viewport guarantees the panel overflows regardless.
  await page.setViewportSize({ width: 1280, height: 600 })
  await bootWithSendSpy(page)

  // Give the fixture an explicit pixel width so the W input is genuinely in
  // Fixed mode and therefore carries the "Width" tooltip this spec hovers.
  //
  // This precondition used to hold by accident: the panel derived its sizing
  // mode from getComputedStyle().width, which is always pixels, so EVERY
  // element read as Fixed and every W input was enabled. B5 fixed that — the
  // unstyled fixture now correctly reports `auto`, which disables the input and
  // swaps its tooltip to "Switch to Fixed (px) to edit dimensions". Nothing
  // about tooltip clipping changed; this spec was just relying on a bug to
  // reach the control it wanted.
  await page.evaluate((selector) => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) throw new Error(`[test] fixture ${selector} not found`)
    el.style.setProperty('width', '320px')
  }, FIXTURE_SEED_SELECTOR)

  await selectElement(page, FIXTURE_SEED_SELECTOR)
  await waitForElementStatePanel(page)

  const targetReady = await page.evaluate(() => {
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    if (!root) return false
    return !!root.querySelector('.cortex-panel__body .cortex-numeric-input[data-tooltip="Width"]')
  })
  expect(targetReady).toBe(true)

  await page.evaluate(() => {
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    if (!root) throw new Error('[test] shadow root not accessible')
    const body = root.querySelector<HTMLElement>('.cortex-panel__body')
    const target = root.querySelector<HTMLElement>('.cortex-panel__body .cortex-numeric-input[data-tooltip="Width"]')
    if (!body || !target) throw new Error('[test] tooltip target not found')

    const bodyRect = body.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    body.scrollTop += targetRect.top - bodyRect.top
  })

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const host = document.querySelector('[data-cortex-host]')
          const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
          const body = root?.querySelector<HTMLElement>('.cortex-panel__body')
          const target = root?.querySelector<HTMLElement>('.cortex-panel__body .cortex-numeric-input[data-tooltip="Width"]')
          if (!body || !target) return false
          return Math.abs(target.getBoundingClientRect().top - body.getBoundingClientRect().top) <= 1
        }),
      { timeout: 2000 },
    )
    .toBe(true)

  await page.evaluate(() => {
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    if (!root) throw new Error('[test] shadow root not accessible')
    const target = root.querySelector<HTMLElement>('.cortex-panel__body .cortex-numeric-input[data-tooltip="Width"]')
    if (!target) throw new Error('[test] tooltip target not found')
    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true, pointerId: 1 }))
  })

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const host = document.querySelector('[data-cortex-host]')
          const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
          return !!root?.querySelector('.cortex-tooltip')
        }),
      { timeout: 2000 },
    )
    .toBe(true)

  const snapshot = await page.evaluate(() => {
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    if (!root) throw new Error('[test] shadow root not accessible')
    const body = root.querySelector<HTMLElement>('.cortex-panel__body')
    const target = root.querySelector<HTMLElement>('.cortex-panel__body .cortex-numeric-input[data-tooltip="Width"]')
    const tooltip = root.querySelector<HTMLElement>('.cortex-tooltip')
    if (!body || !target || !tooltip) throw new Error('[test] tooltip state not found')

    const bodyRect = body.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()
    return {
      text: tooltip.textContent?.trim() ?? '',
      hasPopoverAttribute: tooltip.hasAttribute('popover'),
      describedBy: target.getAttribute('aria-describedby') ?? '',
      bodyTop: bodyRect.top,
      targetLeft: targetRect.left,
      tooltipBottom: tooltipRect.bottom,
      tooltipLeft: tooltipRect.left,
    }
  })

  expect(snapshot.text.length).toBeGreaterThan(0)
  expect(snapshot.hasPopoverAttribute).toBe(false)
  expect(snapshot.describedBy.split(/\s+/)).toContain('cortex-tooltip')
  expect(snapshot.tooltipBottom).toBeLessThanOrEqual(snapshot.bodyTop + 1)
  expect(Math.abs(snapshot.tooltipLeft - snapshot.targetLeft)).toBeLessThanOrEqual(8)
})
