import { describe, it, expect, afterEach, vi } from 'vitest'
import { readComputedSize, classifySizingValue, isSizeInert, makeSizingDimension } from '../../src/browser/sizing-value.js'

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

  it.each([['1e300px'], ['999999999px'], ['-1e300px']])(
    'refuses an absurd magnitude (%s) rather than seeding it into an edit',
    (value) => {
      // These reach us from a page cortex does not control, via prototype
      // methods that page can override.
      expect(classifySizingValue(value)).toBe('custom')
    },
  )

  it('still accepts a large but plausible layout value', () => {
    expect(classifySizingValue('50000px')).toBe('fixed')
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

describe('isSizeInert — width/height that cannot be set at all', () => {
  const el = (tag: string, display: string): Element => {
    const node = document.createElement(tag)
    ;(globalThis as Record<string, unknown>).getComputedStyle = () =>
      ({ display }) as unknown as CSSStyleDeclaration
    return node
  }

  it('reports a non-replaced inline as inert', () => {
    // MEASURED: setting `width: 300px` then `40px` on a <span> left its rendered
    // width at 73.33px both times. The property has no effect whatsoever.
    expect(isSizeInert(el('span', 'inline'))).toBe(true)
  })

  it.each([['img'], ['input'], ['button'], ['select'], ['textarea'], ['svg'], ['video'], ['canvas']])(
    'does NOT report a REPLACED inline (%s) as inert — width applies to those',
    (tag) => {
      // The over-correction to guard against: an <img> is display:inline by
      // default and is sized by width perfectly well. Dimming it would be the
      // same dead-control mistake in reverse.
      expect(isSizeInert(el(tag, 'inline'))).toBe(false)
    },
  )

  it.each([['block'], ['inline-block'], ['flex'], ['inline-flex'], ['grid'], ['table-cell']])(
    'does not report display:%s as inert',
    (display) => {
      expect(isSizeInert(el('span', display))).toBe(false)
    },
  )

  it('does not throw when computed style is unavailable', () => {
    const node = document.createElement('span')
    ;(globalThis as Record<string, unknown>).getComputedStyle = () => { throw new TypeError('detached') }
    expect(() => isSizeInert(node)).not.toThrow()
    expect(isSizeInert(node)).toBe(false)
  })
})

describe('makeSizingDimension — the pairing cannot be half-set (COR-6)', () => {
  it('classifies the AUTHORED value and measures the USED one, from a single call', () => {
    // The whole point: authored and used enter together. `100%` decides the
    // MODE and is not a measurement; `1264px` is the measurement and says
    // nothing about the mode. Two fields let a producer supply one without the
    // other; one constructor does not.
    const d = makeSizingDimension('100%', '1264px')
    expect(d).toEqual({ mode: 'fill', authored: '100%', usedPx: 1264 })
  })

  it('reports an unmeasured axis as null, NOT as zero', () => {
    // The trap this ticket exists to close. With two loose strings, a missing
    // `widthUsed` rendered "0" — indistinguishable from an empty selection —
    // and clicking Fixed then wrote `width: 0px` and collapsed the element.
    // `null` is a distinct state a consumer must handle deliberately.
    expect(makeSizingDimension('fit-content', undefined).usedPx).toBeNull()
  })

  it('reports a genuinely zero size as 0, not null', () => {
    // The other half of the same distinction, and the reason `usedPx` is not
    // just `number` with 0 as the sentinel: a collapsed box and an unmeasured
    // box are different facts, and only one of them is safe to seed into a
    // "switch to Fixed" write.
    expect(makeSizingDimension('0px', '0px').usedPx).toBe(0)
  })

  it('rejects a non-length used value instead of storing NaN', () => {
    // `auto` is what getComputedStyle reports for height on some inline boxes.
    // parseFloat gives NaN, which every downstream `isNaN` check then had to
    // re-discover — the dance this type removes.
    expect(makeSizingDimension('auto', 'auto').usedPx).toBeNull()
  })
})

describe('makeSizingDimension — a used value must be a PIXEL length (COR-6 review)', () => {
  it.each(['50%', 'fit-content', 'min-content', 'calc(100% - 10px)', '10em', ''])(
    'rejects %s as a measurement instead of parsing a number out of it',
    (used) => {
      // parseFloat('50%') is 50. Storing that meant an element with no pixel
      // measurement reported one, and a later switch to Fixed wrote `50px` from
      // it — the fabricated measurement this type exists to prevent, reached
      // through its own constructor.
      expect(makeSizingDimension('100%', used).usedPx).toBeNull()
    },
  )

  it('still accepts a genuine pixel length', () => {
    expect(makeSizingDimension('100%', '1264px').usedPx).toBe(1264)
  })

  it('rejects an absurd magnitude, inheriting the authored-side guard', () => {
    // These strings come from a page cortex does not control, and
    // getComputedStyle is a page-overridable prototype method. Sharing
    // classifySizingValue means the used side cannot drift from the authored
    // side's bound.
    expect(makeSizingDimension('100%', '1e300px').usedPx).toBeNull()
  })
})
