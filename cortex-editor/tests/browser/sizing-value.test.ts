import { describe, it, expect, afterEach, vi } from 'vitest'
import { readAuthoredSize, classifySizingValue } from '../../src/browser/sizing-value.js'

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

describe('readAuthoredSize', () => {
  it('prefers the Typed OM computed value over the used pixel value', () => {
    const el = stubElement({ computed: { width: '1264px' }, typed: { width: '100%' } })
    expect(readAuthoredSize(el, 'width')).toBe('100%')
  })

  it('returns fit-content where getComputedStyle would report resolved pixels', () => {
    const el = stubElement({ computed: { width: '10.6719px' }, typed: { width: 'fit-content' } })
    expect(readAuthoredSize(el, 'width')).toBe('fit-content')
  })

  it('returns auto — the case that previously read as a pixel width', () => {
    const el = stubElement({ computed: { width: '1264px' }, typed: { width: 'auto' } })
    expect(readAuthoredSize(el, 'width')).toBe('auto')
  })

  it('falls back to getComputedStyle when Typed OM is absent (Firefox)', () => {
    const el = stubElement({ computed: { width: '640px' }, typed: null })
    expect(readAuthoredSize(el, 'width')).toBe('640px')
  })

  it('falls back rather than throwing when .get() rejects the property', () => {
    // Verified in Chromium: computedStyleMap().get() throws TypeError on an
    // unknown property. A throw here must not take the Panel down.
    const el = stubElement({ computed: { height: '80px' }, typed: {}, typedThrows: true })
    expect(readAuthoredSize(el, 'height')).toBe('80px')
  })

  it('falls back for pseudo-elements — Typed OM has no pseudo support', () => {
    const el = stubElement({ computed: { width: '210px' }, typed: { width: '300px' } })
    // The typed value belongs to the originating element, not the pseudo, so
    // trusting it would report the wrong box entirely.
    expect(readAuthoredSize(el, 'width', '::before')).toBe('210px')
  })

  it('falls back when Typed OM returns undefined for the property', () => {
    const el = stubElement({ computed: { width: '55px' }, typed: {} })
    expect(readAuthoredSize(el, 'width')).toBe('55px')
  })
})

describe('classifySizingValue', () => {
  it.each([
    ['320px', 'fixed'],
    ['0px', 'fixed'],
    ['12.5px', 'fixed'],
  ])('classifies an authored length %s as fixed', (value, expected) => {
    expect(classifySizingValue(value)).toBe(expected)
  })

  it.each([
    ['100%', 'fill'],
    ['stretch', 'fill'],
    ['-webkit-fill-available', 'fill'],
  ])('classifies %s as fill', (value, expected) => {
    expect(classifySizingValue(value)).toBe(expected)
  })

  it.each([
    ['fit-content', 'fit'],
    ['max-content', 'fit'],
    ['min-content', 'fit'],
    ['fit-content(20rem)', 'fit'],
  ])('classifies %s as fit', (value, expected) => {
    expect(classifySizingValue(value)).toBe(expected)
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
