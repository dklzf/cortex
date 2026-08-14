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
   * Whether a press on this element may begin a reorder.
   *
   * A caller predicate rather than a rule baked in here, and the choice is
   * load-bearing: if every `pointerdown` began a press, dragging to SELECT TEXT
   * in a paragraph would become a reorder gesture. The threshold does not save
   * you — a text selection travels far more than 4px. The app knows what is
   * selected and what design mode is doing; this module does not, so the policy
   * belongs on its side of the boundary.
   */
  canDrag: (el: Element) => boolean
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
  const { canDrag, isOwnUI, onStateChange, onResult } = options
  const win = options.target ?? window

  let state: ReorderDragState = IDLE

  function setState(next: ReorderDragState): void {
    if (next === state) return
    state = next
    onStateChange?.(state)
  }

  function handlePointerDown(event: PointerEvent): void {
    if (state.phase !== 'idle') return
    if (event.button !== 0) return // primary button only; right-click opens menus
    if (isOwnUI(event)) return
    const el = event.target
    if (!(el instanceof Element)) return
    if (!canDrag(el)) return

    const next = beginPress(el, { x: event.clientX, y: event.clientY })
    if (next.phase === 'idle') return

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
    const wasDragging = state.phase === 'dragging'
    const { state: next, result } = onPointerUp(state)
    setState(next)
    if (wasDragging) {
      // A completed drag must not also read as a click — the same press would
      // otherwise reorder the list AND change the selection.
      event.preventDefault()
      event.stopPropagation()
    }
    if (result) onResult?.(result)
  }

  function abandon(): void {
    if (state.phase === 'idle') return
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
  win.addEventListener('pointercancel', abandon, opts)
  win.addEventListener('blur', abandon)
  win.addEventListener('keydown', handleKeyDown as EventListener, opts)

  return {
    cleanup() {
      abandon()
      win.removeEventListener('pointerdown', handlePointerDown as EventListener, opts)
      win.removeEventListener('pointermove', handlePointerMove as EventListener, opts)
      win.removeEventListener('pointerup', handlePointerUp as EventListener, opts)
      win.removeEventListener('pointercancel', abandon, opts)
      win.removeEventListener('blur', abandon)
      win.removeEventListener('keydown', handleKeyDown as EventListener, opts)
    },
    state: () => state,
  }
}
