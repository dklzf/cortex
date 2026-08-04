/**
 * Sizing-mode provenance in a real browser (B5).
 *
 * Business purpose: the panel decides whether the W/H pixel inputs are editable
 * from the element's sizing mode. It used to derive that mode from
 * `getComputedStyle().width`, which CSSOM defines to return the USED value —
 * always pixels. Every element therefore read as Fixed, the pixel inputs were
 * live everywhere, and editing one silently converted a responsive element to a
 * fixed width.
 *
 * Falsifiability note: this is the ONLY test in the suite that can fail for the
 * real reason. The unit tests in tests/browser/sizing-value.test.ts necessarily
 * stub the element, because happy-dom implements neither CSS Typed OM nor
 * layout — precisely the two things under test. A stub can only assert that the
 * classifier handles the strings we believe browsers emit; it cannot catch us
 * believing the wrong thing. This spec drives a real Chromium, so it fails if
 * `computedStyleMap()` ever stops reporting what we assume.
 *
 * The last case deliberately pins a KNOWN LIMITATION rather than a desired
 * behaviour — see the comment on it.
 */
import { test, expect, type Page } from '@playwright/test'
import { FIXTURE_SEED_SELECTOR } from './helpers/fixture-server.js'
import {
  bootWithSendSpy,
  selectElement,
  waitForElementStatePanel,
} from './helpers/panel.js'

interface SizingSnapshot {
  /** Trigger label for the W axis: 'px' | 'fit' | 'fill' | 'auto' | 'custom'. */
  widthMode: string
  /** Value shown in the W numeric input. */
  widthValue: string
  /** Whether the W pixel input accepts edits. */
  widthDisabled: boolean
  /** The element's true rendered width, for comparison with widthValue. */
  renderedWidth: number
}

async function setSeedWidth(page: Page, value: string): Promise<void> {
  await page.evaluate(
    ({ selector, width }) => {
      const el = document.querySelector<HTMLElement>(selector)
      if (!el) throw new Error(`[panel-sizing-mode] fixture ${selector} not found`)
      el.style.setProperty('width', width)
    },
    { selector: FIXTURE_SEED_SELECTOR, width: value },
  )
}

async function getSizingSnapshot(page: Page): Promise<SizingSnapshot> {
  return await page.evaluate((selector) => {
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    // Scope to the WIDTH sizing field. `.cortex-numeric-input input` alone
    // matches the first numeric input anywhere in the panel — spacing renders
    // above sizing, so an unscoped query silently reads padding-top.
    const widthField = root?.querySelector<HTMLElement>('.cortex-layout-section__sizing-field')
    const label = widthField?.querySelector<HTMLElement>('.cortex-sizing-trigger__label')
    const input = widthField?.querySelector<HTMLInputElement>('.cortex-numeric-input input')
    const target = document.querySelector<HTMLElement>(selector)
    return {
      widthMode: label?.textContent?.trim() ?? '(no label)',
      widthValue: input?.value ?? '(no input)',
      widthDisabled: input?.disabled ?? false,
      renderedWidth: target?.getBoundingClientRect().width ?? -1,
    }
  }, FIXTURE_SEED_SELECTOR)
}

/** Re-select so the panel recomputes its style snapshot for the new width. */
async function applyWidthAndSnapshot(page: Page, width: string): Promise<SizingSnapshot> {
  await setSeedWidth(page, width)
  await selectElement(page, FIXTURE_SEED_SELECTOR)
  await waitForElementStatePanel(page)
  return await getSizingSnapshot(page)
}

test.describe('panel sizing mode — real browser provenance', () => {
  test.beforeEach(async ({ page }) => {
    await bootWithSendSpy(page)
  })

  test('an author-written 100% reports fill and locks the pixel input', async ({ page }) => {
    // The headline B5 case. Pre-fix this read as Fixed with the pixel count in
    // an editable field, so typing in it converted a responsive element to a
    // fixed width without the user ever choosing that.
    const snap = await applyWidthAndSnapshot(page, '100%')
    expect(snap.widthMode).toBe('fill')
    expect(snap.widthDisabled).toBe(true)
  })

  test('a fill element still reports its RENDERED width, not 0', async ({ page }) => {
    // `100%` is not a measurement, but the element plainly has one. Showing 0
    // in its place fabricates a width. Figma reports the current size for a
    // Fill/Hug element too.
    const snap = await applyWidthAndSnapshot(page, '100%')
    expect(snap.renderedWidth).toBeGreaterThan(0)
    expect(Number(snap.widthValue)).toBeCloseTo(snap.renderedWidth, 0)
  })

  test('fit-content reports fit', async ({ page }) => {
    const snap = await applyWidthAndSnapshot(page, 'fit-content')
    expect(snap.widthMode).toBe('fit')
    expect(snap.widthDisabled).toBe(true)
  })

  test('an authored pixel width reports px and stays editable', async ({ page }) => {
    // The one mode that IS a pixel count. Regression guard for over-correcting:
    // it would be easy to disable every input in the name of safety.
    const snap = await applyWidthAndSnapshot(page, '320px')
    expect(snap.widthMode).toBe('px')
    expect(snap.widthDisabled).toBe(false)
    expect(Number(snap.widthValue)).toBeCloseTo(320, 0)
  })

  test('auto reports auto, not px', async ({ page }) => {
    const snap = await applyWidthAndSnapshot(page, 'auto')
    expect(snap.widthMode).toBe('auto')
    expect(snap.widthDisabled).toBe(true)
  })

  test('50% reports custom and never renders as a pixel count', async ({ page }) => {
    // parseFloat('50%') === 50, so a naive implementation shows "50 px" for an
    // element that is half its parent's width. Assert the mode AND that the
    // displayed number is the real width rather than the bare percentage.
    const snap = await applyWidthAndSnapshot(page, '50%')
    expect(snap.widthMode).toBe('custom')
    expect(snap.widthDisabled).toBe(true)
    expect(Number(snap.widthValue)).toBeCloseTo(snap.renderedWidth, 0)
    expect(Number(snap.widthValue)).not.toBe(50)
  })

  test('min-content reports custom, so re-selecting a mode cannot rewrite it', async ({ page }) => {
    // min-content and max-content are distinct intrinsic sizes, not fit-content.
    // Classifying them as the SELECTABLE `fit` made the dropdown show fit as
    // already-active, and clicking it rewrote the value to fit-content — a
    // layout change from a click that read as a no-op.
    const snap = await applyWidthAndSnapshot(page, 'min-content')
    expect(snap.widthMode).toBe('custom')
  })

  test('stretch reports custom rather than being rewritten to 100%', async ({ page }) => {
    // stretch sizes the MARGIN box; 100% sizes the content box. They are not
    // interchangeable for any element with padding or borders.
    const snap = await applyWidthAndSnapshot(page, 'stretch')
    expect(snap.widthMode).toBe('custom')
  })

  test('KNOWN LIMITATION: a rem width reports px, because units do not survive', async ({ page }) => {
    // NOT a desired behaviour — this pins a documented limitation so that it is
    // visible in CI rather than folklore, and so this test FAILS LOUDLY if a
    // future browser or a cascade-walking implementation ever fixes it.
    //
    // Computed-value time absolutises lengths: `20rem` computes to `320px` and
    // is indistinguishable from a hand-written pixel width. Recovering the unit
    // needs the SPECIFIED value, which Typed OM does not expose. Consequence:
    // editing a rem-authored width writes px and breaks the linkage.
    // See sizing-value.ts "Known limitations".
    const snap = await applyWidthAndSnapshot(page, '20rem')
    expect(snap.widthMode).toBe('px')
    expect(Number(snap.widthValue)).toBeCloseTo(320, 0)
  })
})
