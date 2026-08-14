import { measureConstraintOwner, pointerDeltaToSizeDelta, type ConstraintOwnership, type ResizeEdge } from './constraint-owner.js'
import { pinToFixed, type PinWrite } from './resize-pin.js'

/**
 * The drag state machine for a resize gesture (COR-3's consumer).
 *
 * A reducer over pointer facts holding no listeners and rendering nothing —
 * the same split `reorder-drag.ts` uses, for the same reason: the part that
 * decides what reaches source is the part whose bugs are invisible in a
 * screenshot.
 *
 * ## Why ownership is measured ONCE, at press
 *
 * `measureConstraintOwner` PROBES: it writes an inline `!important` size,
 * reads where the edge went, and reverts (`constraint-owner.ts`). That enqueues
 * MutationRecords which the override manager and the HMR pipeline both watch,
 * and it forces layout. Doing it per pointermove would fight the very overrides
 * the drag is writing and thrash the page at 60Hz. The parent's layout rules do
 * not change mid-drag, so one measurement is also all the information there is.
 */

/** Pixels the pointer must travel before a press becomes a resize. */
export const RESIZE_THRESHOLD_PX = 3

export interface Pointer { x: number; y: number }

export type ResizeDragState =
  | { phase: 'idle' }
  | {
      phase: 'pressed'
      element: Element
      edge: ResizeEdge
      ownership: ConstraintOwnership
      origin: Pointer
      /** The element's size along the dragged axis when the press began. */
      startPx: number
    }
  | {
      phase: 'dragging'
      element: Element
      edge: ResizeEdge
      ownership: ConstraintOwnership
      origin: Pointer
      startPx: number
      /** Where the element would land if released now, in CSS px. */
      currentPx: number
    }

export const IDLE: ResizeDragState = { phase: 'idle' }

/** Smallest size a drag will write. Zero and negatives are not sizes a user
 *  means; they are what happens when the pointer crosses the far edge. */
const MIN_PX = 1

const isHorizontal = (edge: ResizeEdge): boolean => edge === 'left' || edge === 'right'

/**
 * Begin a resize press on `el`'s `edge`.
 *
 * Measures ownership here and nowhere else. Returns `idle` when the element has
 * no box to resize — a detached or non-rendered node, where every subsequent
 * number would be derived from a zero rect.
 */
export function beginResize(el: Element, edge: ResizeEdge, pointer: Pointer): ResizeDragState {
  const rect = el.getBoundingClientRect()
  const startPx = isHorizontal(edge) ? rect.width : rect.height
  if (startPx <= 0) return IDLE
  return {
    phase: 'pressed',
    element: el,
    edge,
    ownership: measureConstraintOwner(el, edge),
    origin: { ...pointer },
    startPx,
  }
}

/**
 * Advance on pointer movement.
 *
 * Crossing the threshold promotes `pressed` to `dragging`. Every move recomputes
 * from the ORIGIN rather than accumulating deltas — an accumulator drifts as
 * rounding errors compound over a long drag, and the pointer is the only input,
 * so there is nothing to accumulate.
 */
export function onResizeMove(state: ResizeDragState, pointer: Pointer): ResizeDragState {
  if (state.phase === 'idle') return state

  const dx = pointer.x - state.origin.x
  const dy = pointer.y - state.origin.y
  // Only travel along the DRAGGED axis counts. A vertical wobble while dragging
  // a left edge is not intent to resize, and folding it in would make the
  // gesture feel like it fires early and by the wrong amount.
  const travel = isHorizontal(state.edge) ? dx : dy
  if (state.phase === 'pressed' && Math.abs(travel) < RESIZE_THRESHOLD_PX) return state

  const sizeDelta = pointerDeltaToSizeDelta(state.ownership, state.edge, travel)
  if (sizeDelta === null) {
    // `edgeResponse` is 0 — the element cannot be resized by this write. Hold
    // the state so the UI can keep showing the refusal, and let the release
    // report the reason rather than silently doing nothing.
    return { ...state, phase: 'dragging', currentPx: state.startPx }
  }

  return {
    ...state,
    phase: 'dragging',
    currentPx: Math.max(MIN_PX, state.startPx + sizeDelta),
  }
}

export type ResizeResult =
  | { ok: true; writes: PinWrite[] }
  | { ok: false; reason: string }

/**
 * Release the pointer.
 *
 * Returns the declarations to commit, or a refusal with a reason the UI shows.
 * `result` is undefined for a press that never crossed the threshold — that is
 * a CLICK on a handle and must not write anything.
 */
export function onResizeUp(state: ResizeDragState): { state: ResizeDragState; result?: ResizeResult } {
  if (state.phase !== 'dragging') return { state: IDLE }
  return { state: IDLE, result: pinToFixed(state.ownership, state.edge, state.currentPx) }
}

/** Abandon — Escape, `pointercancel`, blur. Never writes. */
export function onResizeCancel(): ResizeDragState {
  return IDLE
}
