import {
  beginPress,
  onPointerMove,
  onPointerUp,
  onCancel,
  IDLE,
  type ReorderDragState,
} from './reorder-drag.js'
import type { ReorderIntentResult } from './reorder-intent.js'

/**
 * Event wiring for the reorder gesture (COR-7, M1).
 *
 * The state machine in `reorder-drag.ts` is a pure reducer; this is the only
 * part that touches listeners, and it stays deliberately thin — it translates
 * events into reducer calls and hands the results back. Everything that could
 * be decided without the DOM already was.
 *
 * Mirrors `selection.ts`'s shape (install, return `cleanup`) because they wire
 * the same surface and a second convention here would be one more thing to
 * reason about when both are attached at once.
 */

export interface ReorderDragOptions {
  /**
   * Map the pressed element to the one that should actually be reordered, or
   * `null` to decline the press.
   *
   * A caller function rather than a rule baked in here, and load-bearing twice
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

export interface ReorderDragHandle {
  cleanup(): void
  /** Current state, for callers that poll rather than subscribe. */
  state(): ReorderDragState
}

export function installReorderDrag(options: ReorderDragOptions): ReorderDragHandle {
  const { resolveDraggable, isOwnUI, onStateChange, onResult } = options
  const win = options.target ?? window

  let state: ReorderDragState = IDLE
  // The pointer that began the gesture. Without it, a SECOND touch's moves and
  // releases drive the one shared state — a second finger can cross the first
  // finger's threshold, pick a slot, and complete the reorder when it lifts,
  // and its `pointercancel` can abandon the first finger's drag.
  let activePointerId: number | null = null
  // Set between a completed drag and the click the browser synthesises after
  // it, so that click can be swallowed exactly once.
  let swallowNextClick = false

  function setState(next: ReorderDragState): void {
    if (next === state) return
    state = next
    onStateChange?.(state)
  }

  function handlePointerDown(event: PointerEvent): void {
    if (state.phase !== 'idle') return
    if (event.button !== 0) return // primary button only; right-click opens menus
    if (isOwnUI(event)) return
    const pressed = event.target
    if (!(pressed instanceof Element)) return
    const el = resolveDraggable(pressed)
    if (!el) return

    const next = beginPress(el, { x: event.clientX, y: event.clientY })
    if (next.phase === 'idle') return
    activePointerId = event.pointerId

    // NO `setPointerCapture`. The obvious reasoning says it is required — a
    // reorder is by definition a move away from where it started, so the
    // pointer leaves the pressed element immediately — but the listeners below
    // are on the WINDOW in the capture phase, so they see every move and the
    // release wherever the pointer goes. Regression-simulated: deleting the
    // capture call changes no test, including the one that drags off the list
    // and back. Keeping it would have added a try/catch, a pointer-id to track,
    // and a stale-capture failure mode that silently swallows later events, to
    // buy nothing this gesture depends on.
    setState(next)
    // NOT preventDefault here. This is still ambiguously a click, and
    // suppressing the default now would break selection for every press that
    // never becomes a drag.
  }

  function handlePointerMove(event: PointerEvent): void {
    if (state.phase === 'idle') return
    if (event.pointerId !== activePointerId) return
    const next = onPointerMove(state, { x: event.clientX, y: event.clientY })
    if (next.phase === 'dragging') {
      // Once it IS a drag, suppress the native text selection that would
      // otherwise paint over the page for the whole gesture.
      event.preventDefault()
    }
    setState(next)
  }

  function handlePointerUp(event: PointerEvent): void {
    if (state.phase === 'idle') return
    if (event.pointerId !== activePointerId) return
    const wasDragging = state.phase === 'dragging'
    const { state: next, result } = onPointerUp(state)
    setState(next)
    activePointerId = null
    if (wasDragging) {
      // A completed drag must not also read as a click — the same press would
      // otherwise reorder the list AND change the selection.
      //
      // Suppressing `pointerup` is NOT enough: the browser dispatches a
      // separate `click` afterwards, and that one still reaches links, buttons
      // and the app's click-to-select handler. The flag makes the next click
      // (and only the next) get consumed.
      event.preventDefault()
      event.stopPropagation()
      swallowNextClick = true
    }
    if (result) onResult?.(result)
  }

  function handleClick(event: MouseEvent): void {
    if (!swallowNextClick) return
    swallowNextClick = false
    event.preventDefault()
    event.stopPropagation()
  }

  /**
   * Refuse the browser's own drag-and-drop.
   *
   * Images, links and anything with `draggable="true"` start a native HTML drag
   * once the pointer travels far enough. `preventDefault` on `pointermove` does
   * not stop it — it comes from the compatibility mouse sequence — and once it
   * starts the browser takes the pointer away, `pointercancel` fires, and this
   * module abandons a reorder the user was in the middle of. So the common case
   * of reordering a list of images or links would simply never work.
   */
  function handleDragStart(event: Event): void {
    if (state.phase === 'idle') return
    event.preventDefault()
  }

  function abandon(event?: Event): void {
    if (state.phase === 'idle') return
    // A cancel from some OTHER pointer must not kill this gesture.
    if (event && 'pointerId' in event && (event as PointerEvent).pointerId !== activePointerId) return
    activePointerId = null
    setState(onCancel())
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') abandon()
  }

  // Capture phase, matching `selection.ts`: the page's own handlers must not be
  // able to stop these before cortex sees them.
  const opts = { capture: true } as const
  win.addEventListener('pointerdown', handlePointerDown as EventListener, opts)
  win.addEventListener('pointermove', handlePointerMove as EventListener, opts)
  win.addEventListener('pointerup', handlePointerUp as EventListener, opts)
  // `pointercancel` fires when the browser takes the pointer away — a system
  // gesture, a touch turning into a scroll. Treating it as a release would
  // stage a reorder the user never completed.
  win.addEventListener('pointercancel', abandon as EventListener, opts)
  win.addEventListener('blur', abandon as EventListener)
  win.addEventListener('keydown', handleKeyDown as EventListener, opts)
  win.addEventListener('click', handleClick as EventListener, opts)
  win.addEventListener('dragstart', handleDragStart, opts)

  return {
    cleanup() {
      abandon()
      win.removeEventListener('pointerdown', handlePointerDown as EventListener, opts)
      win.removeEventListener('pointermove', handlePointerMove as EventListener, opts)
      win.removeEventListener('pointerup', handlePointerUp as EventListener, opts)
      win.removeEventListener('pointercancel', abandon as EventListener, opts)
      win.removeEventListener('blur', abandon as EventListener)
      win.removeEventListener('keydown', handleKeyDown as EventListener, opts)
      win.removeEventListener('click', handleClick as EventListener, opts)
      win.removeEventListener('dragstart', handleDragStart, opts)
    },
    state: () => state,
  }
}
