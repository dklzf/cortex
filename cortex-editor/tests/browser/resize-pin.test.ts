import { describe, it, expect } from 'vitest'
import { pinToFixed } from '../../src/browser/resize-pin.js'
import type { ConstraintOwnership } from '../../src/browser/constraint-owner.js'

/**
 * The product rule: a drag ALWAYS pins the element to a fixed size, escaping
 * whatever the parent was doing. Figma's model — one behaviour, no special
 * cases for the user to learn, and the panel or undo puts it back.
 *
 * These are pure-data tests, deliberately. The measurement that produces a
 * `ConstraintOwnership` is verified against real Chromium layout in
 * `tests/e2e/constraint-owner-measured.spec.ts`; what is under test HERE is the
 * translation from "the parent owns this" to "these declarations take it back".
 */

const own = (over: Partial<ConstraintOwnership> = {}): ConstraintOwnership => ({
  target: 'element',
  property: 'width',
  appliesTo: 'self',
  edgeResponse: 1,
  screenPxPerCssPx: 1,
  reason: 'element owns its width',
  ...over,
})

describe('pinToFixed — a self-owned element', () => {
  it('writes the size and nothing else', () => {
    const r = pinToFixed(own(), 'right', 300)
    expect(r).toEqual({ ok: true, writes: [{ property: 'width', value: '300px' }] })
  })

  it('uses height for a vertical edge', () => {
    const r = pinToFixed(own(), 'bottom', 120)
    expect(r.ok && r.writes[0]!.property).toBe('height')
  })

  it('rounds to whole pixels', () => {
    // A drag produces sub-pixel floats. `width: 300.4px` in someone's source is
    // noise in a diff for a precision no display can show and no one asked for.
    const r = pinToFixed(own(), 'right', 300.4)
    expect(r.ok && r.writes[0]!.value).toBe('300px')
  })
})

describe('pinToFixed — the PARENT owns the size', () => {
  it('neutralises flex allocation before writing the size', () => {
    // `width: 300px` alone does not survive `flex-grow: 1` — the line's free
    // space still decides, the declaration lands, and the element does not
    // move. That reads to the user as a broken drag, which is why the flex
    // shorthand comes first.
    const r = pinToFixed(own({ target: 'flex-allocation', property: 'flex-grow' }), 'right', 240)
    expect(r).toEqual({
      ok: true,
      writes: [{ property: 'flex', value: 'none' }, { property: 'width', value: '240px' }],
    })
  })

  it('un-stretches a grid ITEM rather than resizing its track', () => {
    // Editing `grid-template-columns` would move the item's NEIGHBOURS too.
    // The user dragged one element; a diff showing three of them changed is
    // not what they asked for.
    const r = pinToFixed(own({ target: 'grid-track', property: 'grid-template-columns' }), 'right', 200)
    expect(r.ok && r.writes.map(w => w.property)).toEqual(['justify-self', 'width'])
    expect(r.ok && r.writes.some(w => w.property.startsWith('grid-template'))).toBe(false)
  })

  it('un-stretches along the BLOCK axis for a vertical edge', () => {
    // `justify-self` runs along the inline axis; a bottom-edge drag needs
    // `align-self` or the item stays stretched and the drag does nothing.
    const r = pinToFixed(own({ target: 'grid-track', property: 'grid-template-rows' }), 'bottom', 90)
    expect(r.ok && r.writes.map(w => w.property)).toEqual(['align-self', 'height'])
  })

  it('puts the neutralising write BEFORE the size write', () => {
    // Order is load-bearing for review, not for CSS: a reader of the diff sees
    // "stop filling, then be this wide", which is the gesture in the order the
    // user performed it.
    const r = pinToFixed(own({ target: 'flex-allocation', property: 'flex-basis' }), 'left', 100)
    expect(r.ok && r.writes[0]!.property).toBe('flex')
  })
})

describe('pinToFixed — refusals', () => {
  it('refuses when the edge does not respond, and passes the reason through', () => {
    // `edgeResponse: 0` means the probe changed the size and the edge did not
    // follow. Writing anyway would produce a declaration that lands in source
    // and changes nothing on screen — the worst outcome, because the user sees
    // no effect and the diff says otherwise.
    const r = pinToFixed(own({ edgeResponse: 0, reason: 'width is pinned by an !important author rule' }), 'right', 300)
    expect(r).toEqual({ ok: false, reason: 'width is pinned by an !important author rule' })
  })

  it('refuses a zero-response FLEX case too, rather than pinning blindly', () => {
    // The pinning rule is not "always write something" — it is "always write
    // what makes the size self-owned". When nothing does, say so.
    const r = pinToFixed(own({ target: 'flex-allocation', edgeResponse: 0, reason: 'over-constrained line' }), 'right', 300)
    expect(r.ok).toBe(false)
  })
})
