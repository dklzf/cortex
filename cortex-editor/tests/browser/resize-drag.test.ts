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
  // Inline width/height, because `beginResize` reads the COMPUTED size rather
  // than the bounding rect — the two are different box models, and mixing them
  // made a 60px drag grow a padded element by 110px. Stubbing the rect here
  // would test a path the code no longer takes.
  node.setAttribute('style', `width:${w}px;height:${h}px`)
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

describe('onResizeUp — a drag that ends where it began', () => {
  const owns = { target: 'element', edgeResponse: 1, reason: 'ok' } as ConstraintOwnership

  const dragging = (startPx: number, currentPx: number): ResizeDragState => ({
    phase: 'dragging', element: document.createElement('div'), edge: 'right',
    ownership: owns, origin: { x: 0, y: 0 }, startPx, currentPx,
  })

  /**
   * Crossing the threshold makes it a drag permanently — there is no path back
   * to `pressed`. So a user who drags out, changes their mind, and returns to
   * the original size used to get an explicit pixel pin anyway, plus
   * `flex: none` or a self-alignment override where those apply. Responsive
   * behaviour replaced by a gesture that visibly changed nothing.
   */
  it('writes nothing when the released size matches the starting size', () => {
    expect(onResizeUp(dragging(300, 300)).result).toBeUndefined()
  })

  it('treats a sub-pixel difference as nothing, since the write is rounded', () => {
    // `pinToFixed` rounds, so 300.4 and 300 produce the identical declaration.
    // Calling that an edit would write `width: 300px` for no visible change.
    expect(onResizeUp(dragging(300, 300.4)).result).toBeUndefined()
  })

  it('still writes for a real change of one pixel', () => {
    // The bound must not swallow a deliberate nudge.
    const r = onResizeUp(dragging(300, 301)).result
    expect(r?.ok).toBe(true)
    expect(r?.ok === true && r.writes).toEqual([{ property: 'width', value: '301px' }])
  })
})

describe('onResizeUp — an inert edge is not a no-op', () => {
  /**
   * The two cases produce identical numbers: dragging back to the start, and
   * an edge that never moved because it cannot. `onResizeMove` holds
   * `currentPx` at `startPx` for the inert case precisely so the release can
   * explain itself, so the zero-delta shortcut has to be gated on capability
   * or it eats that explanation.
   */
  it('reports the refusal rather than treating an unchanged size as no edit', () => {
    const inert = { target: 'element', edgeResponse: 0, reason: 'This element is pinned by its parent.' } as ConstraintOwnership
    const r = onResizeUp({
      phase: 'dragging', element: document.createElement('div'), edge: 'right',
      ownership: inert, origin: { x: 0, y: 0 }, startPx: 300, currentPx: 300,
    }).result
    expect(r?.ok).toBe(false)
    expect(r?.ok === false && r.reason).toMatch(/pinned by its parent/)
  })
})
