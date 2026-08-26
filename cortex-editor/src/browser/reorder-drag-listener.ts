import { installPointerGesture, type PointerGestureHandle } from './pointer-gesture.js'
import { beginPress, onPointerMove, onPointerUp, onCancel, type ReorderDragState } from './reorder-drag.js'
import type { ReorderIntentResult } from './reorder-intent.js'

/**
 * Event wiring for the reorder gesture (COR-7, M1).
 *
 * The hardening — multi-touch pointer tracking, `touch-action` pinning, click
 * swallowing, native-drag refusal, abandon-on-cancel — now lives in
 * `pointer-gesture.ts`, shared with the resize gesture. Every one of those
 * behaviours was a separate review finding on this file; two copies would drift
 * silently, because each fails by doing nothing visible.
 *
 * What remains here is only what makes this gesture a REORDER: which element a
 * press resolves to, and which reducer runs.
 */

export interface ReorderDragOptions {
  /**
   * Map the pressed element to the one that should actually be reordered, or
   * `null` to decline the press.
   *
   * A caller function rather than a boolean predicate, and load-bearing twice
   * over:
   *
   *  - If every `pointerdown` began a press, dragging to SELECT TEXT would
   *    become a reorder gesture. The threshold does not save you — a text
   *    selection travels far more than 4px.
   *  - `event.target` is the INNERMOST element under the pointer. For
   *    `<li><span>Alpha</span></li>` a press lands on the span, and a boolean
   *    predicate leaves the caller no way to say "reorder the li instead": a
   *    strict predicate makes every nested list item undraggable, a permissive
   *    one reorders the span among the li's children. Returning the ancestor
   *    resolves both.
   */
  resolveDraggable: (el: Element) => Element | null
  /** True for cortex's own panel/overlay chrome, which must never be dragged. */
  isOwnUI: (event: Event) => boolean
  /** Called on every state transition, for the drop indicator to render from. */
  onStateChange?: (state: ReorderDragState) => void
  /** Called once per completed drag with the producer's verdict. */
  onResult?: (result: ReorderIntentResult) => void
  /** Injectable for tests; defaults to the real window. */
  target?: Window
}

export type ReorderDragHandle = PointerGestureHandle<ReorderDragState>

export function installReorderDrag(options: ReorderDragOptions): ReorderDragHandle {
  const { resolveDraggable, isOwnUI, onStateChange, onResult, target } = options
  return installPointerGesture<ReorderDragState, ReorderIntentResult>({
    begin: (pressed, pointer) => {
      const el = resolveDraggable(pressed)
      return el ? beginPress(el, pointer) : null
    },
    onMove: onPointerMove,
    onUp: onPointerUp,
    onCancel,
    // Pin `touch-action` on the DRAGGED element, not the pressed one — a press
    // on `<span>` inside `<li>` reorders the li, so the li is what must not pan.
    touchTarget: (state) => (state.phase === 'idle' ? null : state.dragged),
    isOwnUI,
    onStateChange,
    onResult,
    target,
  })
}
