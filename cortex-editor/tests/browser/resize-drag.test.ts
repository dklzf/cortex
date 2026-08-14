import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  beginResize, onResizeMove, onResizeUp, onResizeCancel, IDLE, RESIZE_THRESHOLD_PX,
  type ResizeDragState,
} from '../../src/browser/resize-drag.js'
import * as co from '../../src/browser/constraint-owner.js'

/**
 * The resize state machine.
 *
 * `measureConstraintOwner` PROBES real layout — it writes an inline
 * `!important` size, reads where the edge went, and reverts — so happy-dom
 * cannot produce a meaningful ownership record. It is stubbed here, and the
 * measurement itself is verified against real Chromium in
 * `tests/e2e/constraint-owner-measured.spec.ts`. What is under test HERE is
 * when a press becomes a drag and what a release produces.
 */

function el(w = 200, h = 100): Element {
  const node = document.createElement('div')
  document.body.appendChild(node)
  node.getBoundingClientRect = () => ({
    width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect
  return node
}

function stubOwner(over: Partial<co.ConstraintOwnership> = {}) {
  const ownership: co.ConstraintOwnership = {
    target: 'element', property: 'width', appliesTo: 'self',
    edgeResponse: 1, screenPxPerCssPx: 1, reason: 'element owns its width', ...over,
  }
  vi.spyOn(co, 'measureConstraintOwner').mockReturnValue(ownership)
  return ownership
}

afterEach(() => { vi.restoreAllMocks() })

describe('beginResize', () => {
  it('measures ownership exactly ONCE, at press', () => {
    // The probe writes an !important size, forces layout, and enqueues
    // MutationRecords the override manager and HMR both watch. Doing it per
    // move would fight the overrides the drag is writing, at 60Hz.
    stubOwner()
    const node = el()
    let s: ResizeDragState = beginResize(node, 'right', { x: 200, y: 50 })
    s = onResizeMove(s, { x: 240, y: 50 })
    s = onResizeMove(s, { x: 280, y: 50 })
    s = onResizeMove(s, { x: 320, y: 50 })
    expect(co.measureConstraintOwner).toHaveBeenCalledTimes(1)
  })

  it('captures the starting size along the DRAGGED axis', () => {
    stubOwner()
    const s = beginResize(el(200, 100), 'bottom', { x: 0, y: 100 })
    expect(s.phase !== 'idle' && s.startPx).toBe(100)
  })

  it('refuses an element with no box', () => {
    // A detached or non-rendered node has a zero rect, and every number derived
    // from it would be arithmetic on nothing.
    stubOwner()
    expect(beginResize(el(0, 0), 'right', { x: 0, y: 0 }).phase).toBe('idle')
  })
})

describe('the threshold', () => {
  it('does not become a drag below it', () => {
    // Without a threshold, clicking a handle writes a zero-delta size edit —
    // the user taps the corner and gets a staged change they never asked for.
    stubOwner()
    const s = beginResize(el(), 'right', { x: 200, y: 50 })
    expect(onResizeMove(s, { x: 200 + RESIZE_THRESHOLD_PX - 1, y: 50 }).phase).toBe('pressed')
  })

  it('counts travel along the DRAGGED axis only', () => {
    // A vertical wobble while dragging a LEFT edge is not intent to resize.
    // Using total distance would fire the gesture early and by the wrong
    // amount, because the perpendicular travel contributes nothing to size.
    stubOwner()
    const s = beginResize(el(), 'right', { x: 200, y: 50 })
    const wobble = onResizeMove(s, { x: 200, y: 50 + RESIZE_THRESHOLD_PX * 10 })
    expect(wobble.phase).toBe('pressed')
  })

  it('recomputes from the ORIGIN rather than accumulating', () => {
    // An accumulator compounds rounding error over a long drag, and drifts
    // permanently once the pointer reverses. Same answer, arrived at twice.
    stubOwner()
    const s0 = beginResize(el(200), 'right', { x: 200, y: 50 })
    const direct = onResizeMove(s0, { x: 260, y: 50 })
    let stepped = onResizeMove(s0, { x: 210, y: 50 })
    for (const x of [220, 230, 240, 250, 260]) stepped = onResizeMove(stepped, { x, y: 50 })
    expect(stepped.phase === 'dragging' && stepped.currentPx)
      .toBe(direct.phase === 'dragging' && direct.currentPx)
  })

  it('never produces a size below one pixel', () => {
    // Dragging the right edge past the left one yields a negative delta.
    // Zero and negative are not sizes a user means.
    stubOwner()
    const s = beginResize(el(200), 'right', { x: 200, y: 50 })
    const crossed = onResizeMove(s, { x: -500, y: 50 })
    expect(crossed.phase === 'dragging' && crossed.currentPx).toBeGreaterThanOrEqual(1)
  })
})

describe('release', () => {
  it('a press below the threshold is a CLICK and writes nothing', () => {
    stubOwner()
    const s = beginResize(el(), 'right', { x: 200, y: 50 })
    const { state, result } = onResizeUp(s)
    expect(state.phase).toBe('idle')
    expect(result).toBeUndefined()
  })

  it('a real drag returns the declarations to write', () => {
    stubOwner()
    const s = onResizeMove(beginResize(el(200), 'right', { x: 200, y: 50 }), { x: 260, y: 50 })
    const { result } = onResizeUp(s)
    expect(result?.ok).toBe(true)
    if (result?.ok !== true) return
    expect(result.writes).toEqual([{ property: 'width', value: '260px' }])
  })

  it('PINS a flex child — the product rule', () => {
    // The element was stretching to fill the line. After the drag it is a
    // fixed number of pixels it owns itself, exactly like Figma. `width` alone
    // would land in source and change nothing on screen.
    stubOwner({ target: 'flex-allocation', property: 'flex-grow' })
    const s = onResizeMove(beginResize(el(200), 'right', { x: 200, y: 50 }), { x: 300, y: 50 })
    const { result } = onResizeUp(s)
    expect(result?.ok === true && result.writes.map(w => w.property)).toEqual(['flex', 'width'])
  })

  it('surfaces the engine REASON when the edge cannot move', () => {
    // A drag that silently does nothing is indistinguishable from a bug. The
    // engine already writes this sentence for a person to read.
    stubOwner({ edgeResponse: 0, reason: 'width is pinned by an !important author rule' })
    const s = onResizeMove(beginResize(el(200), 'right', { x: 200, y: 50 }), { x: 300, y: 50 })
    const { result } = onResizeUp(s)
    expect(result?.ok).toBe(false)
    if (result?.ok !== false) return
    expect(result.reason).toMatch(/important/i)
  })

  it('holds the starting size when the edge cannot move', () => {
    // `pointerDeltaToSizeDelta` returns null on a zero response. Inventing a
    // size there would show the user a preview the release then refuses.
    stubOwner({ edgeResponse: 0, reason: 'pinned' })
    const s = onResizeMove(beginResize(el(200), 'right', { x: 200, y: 50 }), { x: 400, y: 50 })
    expect(s.phase === 'dragging' && s.currentPx).toBe(200)
  })

  it('cancel returns to idle and can never write', () => {
    expect(onResizeCancel()).toEqual(IDLE)
  })

  it('a move from idle stays idle', () => {
    expect(onResizeMove(IDLE, { x: 5, y: 5 })).toEqual(IDLE)
  })
})
