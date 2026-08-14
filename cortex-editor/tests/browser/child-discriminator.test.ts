import { describe, it, expect } from 'vitest'
import { childDiscriminator, childDiscriminators } from '../../src/browser/child-discriminator.js'
import { MAX_SOURCE_HINT_FIELD_BYTES } from '../../src/shared/preview-source.js'

/**
 * COR-35 — the key that lets the drift guard see a reorder.
 *
 * These have to be distinct within one parent's child list and stable across
 * the window between capture and Apply. The tests below are split along that
 * line: DISTINCTNESS is what makes a reorder detectable at all, STABILITY is
 * what stops the guard reporting drift on a tree that never moved.
 */

function el(html: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  return host.firstElementChild!
}

describe('childDiscriminator — authored identity wins', () => {
  it.each([
    ['data-testid', '<li data-testid="row-7">Text</li>', '@data-testid=row-7'],
    ['id', '<li id="row-7">Text</li>', '@id=row-7'],
    ['name', '<input name="email">', '@name=email'],
    ['aria-label', '<button aria-label="Delete row"></button>', '@aria-label=Delete row'],
    ['href', '<a href="/docs">Docs</a>', '@href=/docs'],
    ['alt', '<img alt="Logo">', '@alt=Logo'],
  ])('reads %s in preference to the element text', (_label, html, expected) => {
    expect(childDiscriminator(el(html))).toBe(expected)
  })

  it('prefers data-testid over id when both are present', () => {
    // Fixed order matters: two children that disagree about which attribute to
    // read could produce keys that compare unequal while nothing moved.
    expect(childDiscriminator(el('<li data-testid="a" id="b">x</li>'))).toBe('@data-testid=a')
  })

  it('ignores an attribute that is present but blank', () => {
    // getAttribute returns '' for a valueless attribute. Keying on it would
    // give every such sibling '@id=' — indistinguishable, which is the exact
    // failure this module exists to prevent.
    expect(childDiscriminator(el('<li id="   ">Row</li>'))).toBe('#li:Row')
  })

  it('keeps the attribute NAME in the key, so two facets cannot collide', () => {
    const byTestId = childDiscriminator(el('<li data-testid="x"></li>'))
    const byLabel = childDiscriminator(el('<li aria-label="x"></li>'))
    expect(byTestId).not.toBe(byLabel)
  })

  it('does NOT read cortex\'s own preview id', () => {
    // `ensurePreviewId` mints this lazily when an element is clicked. A key
    // built from it would change AFTER capture and report drift on a tree that
    // never moved — a false positive introduced by cortex observing itself.
    expect(childDiscriminator(el('<li data-cortex-preview-id="p1">Row</li>'))).toBe('#li:Row')
  })

  it('does NOT read class, which the app mutates and siblings usually share', () => {
    const a = childDiscriminator(el('<li class="row">Alpha</li>'))
    const b = childDiscriminator(el('<li class="row row--active">Alpha</li>'))
    expect(a).toBe(b)
  })
})

describe('childDiscriminator — structural fallback', () => {
  it('falls back to tag plus text', () => {
    expect(childDiscriminator(el('<li>Alpha</li>'))).toBe('#li:Alpha')
  })

  it('separates same text under different tags', () => {
    expect(childDiscriminator(el('<li>Alpha</li>'))).not.toBe(childDiscriminator(el('<p>Alpha</p>')))
  })

  it('preserves SVG element-name case', () => {
    // localName, not tagName.toLowerCase() — SVG names are case-sensitive, and
    // lowercasing collapses <linearGradient> and <lineargradient> onto one key.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient')
    expect(childDiscriminator(svg)).toBe('#linearGradient:')
  })

  it('collapses whitespace so a reformat is not read as drift', () => {
    expect(childDiscriminator(el('<li>  Alpha   Bravo\n</li>'))).toBe('#li:Alpha Bravo')
  })

  it('includes descendant text, so rows differing only deep down still differ', () => {
    const a = childDiscriminator(el('<li><span><b>Alpha</b></span></li>'))
    const b = childDiscriminator(el('<li><span><b>Bravo</b></span></li>'))
    expect(a).not.toBe(b)
  })

  it('yields the SAME key for two genuinely indistinguishable children', () => {
    // Not a defect — the honest report. The schema refuses an intent whose keys
    // collide, so a list nobody can tell apart is refused rather than reordered
    // on a guard that cannot verify it.
    expect(childDiscriminator(el('<li></li>'))).toBe(childDiscriminator(el('<li></li>')))
  })
})

describe('childDiscriminator — long values', () => {
  const long = (suffix: string) => el(`<li>${'x'.repeat(900)}${suffix}</li>`)

  it('stays within the wire byte budget', () => {
    const key = childDiscriminator(long('A'))
    expect(new TextEncoder().encode(key).length).toBeLessThanOrEqual(MAX_SOURCE_HINT_FIELD_BYTES)
  })

  it('still separates two rows that agree on the truncated prefix', () => {
    // Truncation alone would map both onto one key, the schema's distinctness
    // rule would reject the intent, and the user would see cortex refuse to
    // reorder an ordinary list with no visible reason. The digest of the FULL
    // value is what keeps them apart.
    expect(childDiscriminator(long('A'))).not.toBe(childDiscriminator(long('B')))
  })

  it('does not truncate a value that already fits', () => {
    expect(childDiscriminator(el('<li>Alpha</li>'))).toBe('#li:Alpha')
  })
})

describe('childDiscriminators — a container\'s children', () => {
  it('returns one key per ELEMENT child, in DOM order', () => {
    const ul = el('<ul><li>Alpha</li>Loose text<li>Bravo</li><!--c--><li>Charlie</li></ul>')
    // Text and comment nodes are not children of `parent.children`, and the
    // guard reads sources from that same collection — so the two arrays it
    // compares are index-aligned by construction rather than by a length check.
    expect(childDiscriminators(ul)).toEqual(['#li:Alpha', '#li:Bravo', '#li:Charlie'])
  })

  it('returns an empty array for a childless container', () => {
    expect(childDiscriminators(el('<ul></ul>'))).toEqual([])
  })

  it('does not mutate the DOM it reads', () => {
    // The guard runs inside a read-only reconcile. `getElementEditTarget` has
    // already shown what stamping during a read costs.
    const ul = el('<ul><li>Alpha</li><li>Bravo</li></ul>')
    const before = ul.outerHTML
    childDiscriminators(ul)
    expect(ul.outerHTML).toBe(before)
  })
})
