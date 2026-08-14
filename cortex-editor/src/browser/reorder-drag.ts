import { resolveDropTarget, type DropAxis } from './drop-target.js'
import { buildReorderIntent, type ReorderIntentResult } from './reorder-intent.js'

/**
 * The drag state machine for a reorder gesture (COR-7, M1).
 *
 * A reducer over pointer facts, deliberately holding no DOM listeners and
 * rendering nothing. The component wiring — pointer capture, the drop
 * indicator, the Shadow DOM boundary — sits on top; this is the part that
 * decides WHEN a press becomes a drag and WHAT a release produces, and it is
 * the part whose bugs are invisible in a screenshot.
 *
 * ## Why a threshold exists at all
 *
 * Without one, every click on a list item is a zero-distance drag that resolves
 * to some slot and stages an intent. The user would click a row to select it
 * and get a staged source edit. The threshold is what separates "I am pointing
 * at this" from "I am moving this", and it has to survive hand tremor and
 * trackpad jitter on the press.
 */

/**
 * Pixels the pointer must travel before a press becomes a drag.
 *
 * 4px is the conventional slop for exactly this decision (it is what browsers
 * use before a mousedown becomes a native drag). Smaller and a steady click on
 * a trackpad registers as a move; larger and a deliberate short drag between
 * adjacent rows feels ignored.
 */
export const DRAG_THRESHOLD_PX = 4

export interface Pointer { x: number; y: number }

export type ReorderDragState =
  | { phase: 'idle' }
  /** Pointer is down but has not travelled far enough to be a drag yet. */
  | { phase: 'pressed'; container: Element; dragged: Element; fromIndex: number; origin: Pointer }
  | {
      phase: 'dragging'
      container: Element
      /** The ELEMENT being dragged. `fromIndex` is where it was at press time
       *  and can go stale under a held pointer; this cannot. */
      dragged: Element
      fromIndex: number
      origin: Pointer
      /** Where the release would put it, in post-removal coordinates. */
      toIndex: number
      axis: DropAxis
    }

export const IDLE: ReorderDragState = { phase: 'idle' }

/**
 * Begin a press on `el`.
 *
 * Returns `idle` when the element cannot be reordered at all — no parent, or a
 * parent with nothing to reorder. Refusing at press time rather than at release
 * is what lets the UI decline to show a drag affordance on a list that could
 * never accept one, instead of letting the user drag and then telling them no.
 */
export function beginPress(el: Element, pointer: Pointer): ReorderDragState {
  const container = el.parentElement
  if (!container) return IDLE
  const fromIndex = Array.from(container.children).indexOf(el)
  if (fromIndex < 0) return IDLE
  if (container.children.length < 2) return IDLE
  return { phase: 'pressed', container, dragged: el, fromIndex, origin: { ...pointer } }
}

/**
 * Advance on pointer movement.
 *
 * Crossing the threshold promotes `pressed` to `dragging`. Once dragging, every
 * move re-resolves the slot — the pointer is the only input, so there is no
 * accumulated state to drift.
 */
export function onPointerMove(state: ReorderDragState, pointer: Pointer): ReorderDragState {
  if (state.phase === 'idle') return state

  const dx = pointer.x - state.origin.x
  const dy = pointer.y - state.origin.y
  // Squared distance, so the threshold is a CIRCLE. Comparing dx and dy
  // separately makes a diagonal drag need ~1.4x the travel of a straight one,
  // which reads as the gesture being unresponsive in one direction.
  const travelled = dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX
  if (state.phase === 'pressed' && !travelled) return state

  const target = resolveDropTarget(state.container, pointer, state.fromIndex)
  if (!target) {
    // The container stopped being resolvable mid-drag — children removed, or
    // everything hidden. Hold the last known state rather than inventing a
    // slot; a release from here re-resolves and refuses if it still cannot.
    return state
  }
  return {
    phase: 'dragging',
    container: state.container,
    dragged: state.dragged,
    fromIndex: state.fromIndex,
    origin: state.origin,
    toIndex: target.toIndex,
    axis: target.axis,
  }
}

/**
 * Release the pointer.
 *
 * Returns the next state and, when the gesture actually was a drag, the
 * producer's verdict — either a staged intent or a refusal with a reason.
 * `result` is undefined for a press that never crossed the threshold, which is
 * a CLICK and must not stage anything.
 */
export function onPointerUp(
  state: ReorderDragState,
): { state: ReorderDragState; result?: ReorderIntentResult } {
  if (state.phase !== 'dragging') return { state: IDLE }

  // Re-derive the dragged element's CURRENT index rather than trusting the one
  // captured at press time. If the app inserts, removes or reorders a sibling
  // while the pointer is held, `fromIndex` names whichever child now occupies
  // that position — and the release would build an otherwise valid intent for
  // the wrong element. An earlier comment here claimed the live DOM was
  // re-derived; only `buildReorderIntent`'s child array was, and the dragged
  // identity stayed stale.
  const liveIndex = Array.from(state.container.children).indexOf(state.dragged)
  if (liveIndex < 0) {
    // The element left the container mid-drag. Nothing to describe.
    return {
      state: IDLE,
      result: { ok: false, reason: 'That element is no longer in this list — the page changed while you were dragging.' },
    }
  }
  // `toIndex` was resolved against the press-time arrangement. If the dragged
  // element moved, the slot it named no longer means the same thing, so the
  // whole gesture is refused rather than applied to a tree it does not
  // describe — the same fail-closed direction as the drift guard.
  if (liveIndex !== state.fromIndex) {
    return {
      state: IDLE,
      result: { ok: false, reason: 'The list changed while you were dragging, so this move was not applied. Try again.' },
    }
  }
  return {
    state: IDLE,
    result: buildReorderIntent(state.container, liveIndex, state.toIndex),
  }
}

/**
 * Abandon the gesture — Escape, `pointercancel`, or the element going away.
 *
 * Always returns to idle and NEVER produces an intent. A cancel that could
 * still stage would make Escape a coin flip on whether the user's source
 * changes.
 */
export function onCancel(): ReorderDragState {
  return IDLE
}
