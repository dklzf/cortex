import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveConstraintOwner,
  pointerDeltaToSizeDelta,
  type ResizeEdge,
} from '../../src/browser/constraint-owner.js'

/**
 * B3 — who owns the edge you grabbed.
 *
 * Every expectation here is anchored to a measurement taken in real Chromium
 * 147 (see the table in constraint-owner.ts). happy-dom does not lay out, so
 * these tests drive the DECISION function against computed styles it can
 * report; the measurements themselves are pinned by the companion e2e spec,
 * which is the only thing that can catch us believing the wrong thing about CSS.
 */

function mount(parentStyle: string, childStyle = ''): HTMLElement {
  const parent = document.createElement('div')
  parent.setAttribute('style', parentStyle)
  const child = document.createElement('div')
  child.setAttribute('style', childStyle)
  parent.appendChild(child)
  document.body.appendChild(parent)
  return child
}

beforeEach(() => {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
})

describe('grid items — the track owns the size', () => {
  it('routes the edit to the parent grid track, not the item', () => {
    // Measured: the naive edit is wrong in BOTH directions, differently.
    // Growing forces the track (300px 300px → 350px 250px) and takes width from
    // the sibling; shrinking leaves the track at 300px so nothing moves at all.
    // Either way the track, not the item, is what the user meant to resize.
    const child = mount('display: grid; grid-template-columns: 1fr 1fr')
    const owner = resolveConstraintOwner(child, 'right')
    expect(owner.target).toBe('grid-track')
    expect(owner.property).toBe('grid-template-columns')
    expect(owner.appliesTo).toBe('parent')
  })

  it('uses the row track when the drag is vertical', () => {
    const child = mount('display: grid; grid-template-rows: 1fr 1fr')
    expect(resolveConstraintOwner(child, 'bottom').property).toBe('grid-template-rows')
  })

  it('explains the directional asymmetry, which is the surprising part', () => {
    // Measured: growing forces the track and takes 50px from the sibling
    // (`300px 300px` → `350px 250px`); shrinking leaves the track alone so
    // nothing moves at all. A reason that only said "ignored" would be wrong in
    // one direction and misleading in the other.
    const reason = resolveConstraintOwner(mount('display: grid'), 'right').reason
    expect(reason).toMatch(/grow/i)
    expect(reason).toMatch(/shrink/i)
  })
})

describe('flex items — flex-grow ignores the size property outright', () => {
  it('routes a grown main-axis child to its flex allocation', () => {
    // Measured: a `flex: 1` child asked for 600 → 650 stayed at 600. Writing
    // `width` here produces a source edit that changes nothing on screen.
    const child = mount('display: flex; flex-direction: row', 'flex-grow: 1')
    const owner = resolveConstraintOwner(child, 'right')
    expect(owner.target).toBe('flex-allocation')
    expect(owner.property).toBe('flex-grow')
  })

  it('does NOT claim flex ownership on the cross axis, where width still applies', () => {
    // flex-grow governs the MAIN axis only. A row's child still owns its height.
    const child = mount('display: flex; flex-direction: row', 'flex-grow: 1')
    expect(resolveConstraintOwner(child, 'bottom').target).toBe('element')
  })

  it('follows the main axis when the parent is a column', () => {
    const child = mount('display: flex; flex-direction: column', 'flex-grow: 1')
    expect(resolveConstraintOwner(child, 'bottom').target).toBe('flex-allocation')
    expect(resolveConstraintOwner(child, 'right').target).toBe('element')
  })

  it('leaves ownership with the element when flex-grow is 0', () => {
    const child = mount('display: flex', 'flex-grow: 0; width: 200px')
    expect(resolveConstraintOwner(child, 'right').target).toBe('element')
  })
})

describe('alignment — the size is the element’s, but the edge may not move', () => {
  it('reports a PINNED right edge under justify-content: flex-end', () => {
    // Measured: width 200 → 250 while the right edge moved 0px. The element
    // grew leftward. Dragging that edge can never move it.
    const child = mount('display: flex; justify-content: flex-end', 'width: 200px')
    const owner = resolveConstraintOwner(child, 'right')
    expect(owner.edgeResponse).toBe(0)
    expect(owner.target).toBe('element')
  })

  it('leaves the opposite edge fully responsive under flex-end', () => {
    const child = mount('display: flex; justify-content: flex-end', 'width: 200px')
    expect(resolveConstraintOwner(child, 'left').edgeResponse).toBe(1)
  })

  it('reports HALF response under justify-content: center', () => {
    // Measured: +50px of width moved the right edge exactly 25px.
    const child = mount('display: flex; justify-content: center', 'width: 200px')
    expect(resolveConstraintOwner(child, 'right').edgeResponse).toBe(0.5)
    expect(resolveConstraintOwner(child, 'left').edgeResponse).toBe(0.5)
  })

  it('pins the LEFT edge in the default start-anchored case', () => {
    // The common case, and the one a naive implementation gets wrong in the
    // other direction: a start-anchored box grows rightward, so its left edge
    // is the pinned one.
    const child = mount('display: flex; justify-content: flex-start', 'width: 200px')
    expect(resolveConstraintOwner(child, 'left').edgeResponse).toBe(0)
    expect(resolveConstraintOwner(child, 'right').edgeResponse).toBe(1)
  })

  it('mirrors the pinned edge under row-reverse', () => {
    // row-reverse swaps which physical edge is the start, so the pinned edge
    // swaps with it. Getting this wrong silently inverts every drag in an RTL
    // or reversed row.
    const child = mount('display: flex; flex-direction: row-reverse; justify-content: flex-start', 'width: 200px')
    expect(resolveConstraintOwner(child, 'right').edgeResponse).toBe(0)
    expect(resolveConstraintOwner(child, 'left').edgeResponse).toBe(1)
  })

  it('warns that setting a cross size opts the element out of stretching', () => {
    const child = mount('display: flex; flex-direction: row; align-items: stretch')
    expect(resolveConstraintOwner(child, 'bottom').reason).toMatch(/stretch/i)
  })
})

describe('plain block layout and degenerate input', () => {
  it('leaves ownership with the element under normal block flow', () => {
    const child = mount('display: block')
    const owner = resolveConstraintOwner(child, 'right')
    expect(owner.target).toBe('element')
    expect(owner.property).toBe('width')
    expect(owner.edgeResponse).toBe(1)
  })

  it('does not throw for a detached element with no parent', () => {
    const orphan = document.createElement('div')
    const owner = resolveConstraintOwner(orphan, 'right')
    expect(owner.target).toBe('element')
    expect(owner.edgeResponse).toBe(1)
  })
})

describe('pointerDeltaToSizeDelta', () => {
  const own = (edgeResponse: number) => ({
    target: 'element' as const,
    property: 'width',
    appliesTo: 'self' as const,
    edgeResponse,
    reason: '',
  })

  it('passes a right-edge drag through unchanged when the edge fully responds', () => {
    expect(pointerDeltaToSizeDelta(own(1), 'right', 50)).toBe(50)
  })

  it('DOUBLES the delta for a centred element, so the edge lands under the pointer', () => {
    // The edge only moves half as far, so reaching a +25px edge movement
    // requires +50px of width. Without this the element visibly lags the cursor.
    expect(pointerDeltaToSizeDelta(own(0.5), 'right', 25)).toBe(50)
  })

  it('flips the sign for a start edge — dragging left GROWS the element', () => {
    expect(pointerDeltaToSizeDelta(own(1), 'left', -30)).toBe(30)
  })

  it('refuses to convert when the edge is pinned, rather than dividing by zero', () => {
    // Guard against writing Infinity as a width.
    expect(pointerDeltaToSizeDelta(own(0), 'right', 50)).toBeNull()
  })

  it.each<[ResizeEdge, number, number]>([
    ['right', 40, 40],
    ['left', -40, 40],
    ['bottom', 40, 40],
    ['top', -40, 40],
  ])('converts a %s drag consistently', (edge, pointer, expected) => {
    expect(pointerDeltaToSizeDelta(own(1), edge, pointer)).toBe(expected)
  })
})
