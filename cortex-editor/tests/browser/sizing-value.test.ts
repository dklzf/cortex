import { describe, it, expect, afterEach, vi } from 'vitest'
import { readComputedSize, classifySizingValue, usedPixelSize } from '../../src/browser/sizing-value.js'

/**
 * B5 — the Panel could not read a sizing mode.
 *
 * `getComputedStyle().width` returns the USED value in pixels ("296px"), never
 * `auto` / `100%` / `fit-content` — CSSOM defines the resolved value for
 * width/height to be the used value. `computedStyleMap()` returns the COMPUTED
 * value, which is what a sizing mode actually is.
 *
 * These tests use a stubbed element rather than a real one because happy-dom
 * implements neither Typed OM nor real layout, so a DOM fixture could not
 * distinguish the two APIs — the exact thing under test. The stub encodes the
 * measured browser contract (see the checkpoint's Step 2 table, verified in
 * Chromium 147): same element, two APIs, different answers.
 */

interface StubOpts {
  computed?: Record<string, string>
  typed?: Record<string, string> | null
  typedThrows?: boolean
}

function stubElement({ computed = {}, typed = null, typedThrows = false }: StubOpts) {
  const el = {
    computedStyleMap: typed === null && !typedThrows
      ? undefined
      : () => ({
          get(prop: string) {
            if (typedThrows) throw new TypeError(`Invalid propertyName: ${prop}`)
            const v = typed?.[prop]
            return v === undefined ? undefined : { toString: () => v }
          },
        }),
  } as unknown as Element
  ;(globalThis as Record<string, unknown>).getComputedStyle = () => computed as unknown as CSSStyleDeclaration
  return el
}

const originalGCS = globalThis.getComputedStyle

afterEach(() => {
  globalThis.getComputedStyle = originalGCS
  vi.restoreAllMocks()
})

describe('readComputedSize', () => {
  it('prefers the Typed OM computed value over the used pixel value', () => {
    const el = stubElement({ computed: { width: '1264px' }, typed: { width: '100%' } })
    expect(readComputedSize(el, 'width')).toBe('100%')
  })

  it('returns fit-content where getComputedStyle would report resolved pixels', () => {
    const el = stubElement({ computed: { width: '10.6719px' }, typed: { width: 'fit-content' } })
    expect(readComputedSize(el, 'width')).toBe('fit-content')
  })

  it('returns auto — the case that previously read as a pixel width', () => {
    const el = stubElement({ computed: { width: '1264px' }, typed: { width: 'auto' } })
    expect(readComputedSize(el, 'width')).toBe('auto')
  })

  it('falls back to getComputedStyle when Typed OM is absent (Firefox)', () => {
    const el = stubElement({ computed: { width: '640px' }, typed: null })
    expect(readComputedSize(el, 'width')).toBe('640px')
  })

  it('falls back rather than throwing when .get() rejects the property', () => {
    // Verified in Chromium: computedStyleMap().get() throws TypeError on an
    // unknown property. A throw here must not take the Panel down.
    const el = stubElement({ computed: { height: '80px' }, typed: {}, typedThrows: true })
    expect(readComputedSize(el, 'height')).toBe('80px')
  })

  it('falls back for pseudo-elements — Typed OM has no pseudo support', () => {
    const el = stubElement({ computed: { width: '210px' }, typed: { width: '300px' } })
    // The typed value belongs to the originating element, not the pseudo, so
    // trusting it would report the wrong box entirely.
    expect(readComputedSize(el, 'width', '::before')).toBe('210px')
  })

  it('falls back when the computedStyleMap ACCESSOR itself throws', () => {
    // Feature detection used to read the property outside the try. An element
    // with a throwing accessor would take the whole panel snapshot down rather
    // than degrade to the used value.
    const el = Object.defineProperty({} as Element, 'computedStyleMap', {
      get() { throw new Error('hostile accessor') },
    })
    ;(globalThis as Record<string, unknown>).getComputedStyle = () =>
      ({ width: '42px' }) as unknown as CSSStyleDeclaration
    expect(readComputedSize(el, 'width')).toBe('42px')
  })

  it('falls back when Typed OM returns undefined for the property', () => {
    const el = stubElement({ computed: { width: '55px' }, typed: {} })
    expect(readComputedSize(el, 'width')).toBe('55px')
  })
})

describe('classifySizingValue', () => {
  it.each([
    ['320px', 'fixed'],
    ['0px', 'fixed'],
    ['12.5px', 'fixed'],
    // Chromium serialises `width: 1000000px` in scientific notation.
    ['1e+06px', 'fixed'],
  ])('classifies an authored length %s as fixed', (value, expected) => {
    expect(classifySizingValue(value)).toBe(expected)
  })

  it('classifies 100% as fill — the exact value cortex writes back', () => {
    expect(classifySizingValue('100%')).toBe('fill')
  })

  it('classifies fit-content as fit — the exact value cortex writes back', () => {
    expect(classifySizingValue('fit-content')).toBe('fit')
  })

  // Only EXACT matches may claim a selectable mode. Selecting an already-active
  // mode fires a write, so anything folded into fill/fit is silently rewritten
  // to the canonical value by a click that looks like a no-op.
  it.each([
    // stretch sizes the MARGIN box, 100% the content box. Rewriting one to the
    // other overflows any child with padding or borders.
    ['stretch'],
    ['-webkit-fill-available'],
    // Distinct intrinsic sizes — measured 33.78px vs 93.30px for identical
    // content in Chromium. Rewriting either to fit-content changes layout.
    ['min-content'],
    ['max-content'],
    // Chromium actually reports `auto` for width:fit-content(<len>), so this
    // string is unlikely to arrive — but if it does it is not bare fit-content.
    ['fit-content(20rem)'],
  ])('classifies %s as custom, so it can never be silently rewritten', (value) => {
    expect(classifySizingValue(value)).toBe('custom')
  })

  it('classifies auto as auto, NOT fixed — this is the reported bug', () => {
    expect(classifySizingValue('auto')).toBe('auto')
  })

  it.each([
    ['50%', 'custom'],
    ['calc(100% - 32px)', 'custom'],
    ['clamp(160px, 50%, 480px)', 'custom'],
    ['100vw', 'custom'],
    ['min(50%, 300px)', 'custom'],
  ])('classifies %s as custom rather than mislabelling it fixed', (value, expected) => {
    expect(classifySizingValue(value)).toBe(expected)
  })

  it('does not report a percentage as a pixel length', () => {
    // Regression guard: parseFloat('50%') === 50, so a naive implementation
    // renders "50 px" for an element that is half its parent's width.
    expect(classifySizingValue('50%')).not.toBe('fixed')
  })

  it('treats an empty or missing value as auto, not fixed', () => {
    expect(classifySizingValue('')).toBe('auto')
  })

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(classifySizingValue('  FIT-CONTENT  ')).toBe('fit')
    expect(classifySizingValue('AUTO')).toBe('auto')
  })
})

describe('usedPixelSize', () => {
  const withRect = (width: number, height = 0) =>
    ({ getBoundingClientRect: () => ({ width, height }) }) as unknown as Element

  it('passes a genuine pixel value straight through', () => {
    // The common path must not perturb padded/bordered boxes by switching to a
    // different measurement of a different box.
    expect(usedPixelSize(withRect(999), '320px', 'width')).toBe('320px')
  })

  it('measures the rect when width does not APPLY to the element', () => {
    // Verified in Chromium 147: `<span style="width:100%">hello world</span>`
    // resolves to "100%" (width does not apply to non-replaced inlines) while
    // rendering at 73.33px. parseFloat('100%') === 100 put "100" in the W field
    // and staged `100px` on switch-to-Fixed.
    expect(usedPixelSize(withRect(73.33), '100%', 'width')).toBe('73.33px')
  })

  it('measures the height axis from the rect, not the width', () => {
    expect(usedPixelSize(withRect(400, 73.33), 'auto', 'height')).toBe('73.33px')
  })

  it('accepts scientific notation as a pixel value', () => {
    // Chromium serialises `width: 1000000px` as `1e+06px`.
    expect(usedPixelSize(withRect(1), '1e+06px', 'width')).toBe('1e+06px')
  })

  it('does not measure a pseudo-element — the rect belongs to its originator', () => {
    expect(usedPixelSize(withRect(500), '100%', 'width', '::before')).toBe('100%')
  })
})
