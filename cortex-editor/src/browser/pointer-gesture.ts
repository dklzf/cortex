/**
 * The event plumbing shared by every cortex drag gesture.
 *
 * Extracted from `reorder-drag-listener.ts` when the resize gesture needed the
 * same behaviour. Copying it would have been ~150 lines of duplication, and
 * EVERY line of it exists because a review round found the case it handles:
 * multi-touch pointer tracking, `touch-action` pinning, click swallowing,
 * native-drag refusal, and abandon-on-cancel. Two copies of that would drift,
 * and the drift would be silent — each behaviour fails by doing nothing
 * visible.
 *
 * What stays OUT of here is anything that knows what a gesture MEANS. The
 * reducer decides that; this only decides when to call it.
 */

/** A gesture's own state. Only `phase: 'idle'` is interpreted here. */
export interface GesturePhase { phase: string }

export interface PointerGestureOptions<S extends GesturePhase, R> {
  /**
   * Map a pressed element to the gesture's starting state, or `null` to decline
   * the press.
   *
   * One function rather than a boolean predicate plus a separate `begin`,
   * because the two are the same decision: a resize must resolve to an element
   * AND an edge, and a boolean cannot carry the edge. The reorder gesture
   * learned this the expensive way — a boolean `canDrag` made every nested list
   * item either undraggable or reordered at the wrong level.
   */
  begin: (pressed: Element, pointer: { x: number; y: number }) => S | null
  onMove: (state: S, pointer: { x: number; y: number }) => S
  onUp: (state: S) => { state: S; result?: R }
  onCancel: () => S
  /** True for cortex's own chrome, which must never start a page gesture. */
  isOwnUI: (event: Event) => boolean
  /**
   * Resolve the pressed element, when `event.target` is not it.
   *
   * A gesture whose targets live inside cortex's CLOSED shadow root cannot use
   * `event.target`: the browser retargets it to the host, and `composedPath()`
   * is trimmed at the host too, so neither can see the pressed node. Verified
   * in Chromium — through a closed root the path has length 5 and contains no
   * handle. A gesture that owns such targets supplies this; page gestures
   * (reorder) leave it out and get `event.target`.
   */
  resolvePressed?: (event: PointerEvent) => Element | null
  /** The element to pin `touch-action` on, given the state `begin` returned. */
  touchTarget?: (state: S) => Element | null
  onStateChange?: (state: S) => void
  onResult?: (result: R) => void
  /** Injectable for tests; defaults to the real window. */
  target?: Window
}

export interface PointerGestureHandle<S> {
  cleanup(): void
  state(): S
}

export function installPointerGesture<S extends GesturePhase, R>(
  options: PointerGestureOptions<S, R>,
): PointerGestureHandle<S> {
  const { begin, onMove, onUp, onCancel, isOwnUI, touchTarget, resolvePressed, onStateChange, onResult } = options
  const win = options.target ?? window

  const IDLE = onCancel()
  let state: S = IDLE
  // The pointer that began the gesture. Without it, a SECOND touch's moves and
  // releases drive the one shared state — a second finger can cross the first
  // finger's threshold and complete the gesture when IT lifts, and its
  // `pointercancel` can abandon the first finger's drag.
  let activePointerId: number | null = null
  // Set between a completed drag and the click the browser synthesises after
  // it, so that click can be swallowed exactly once.
  let swallowNextClick = false
  // What the pressed element's inline `touch-action` was before we pinned it.
  let priorTouchAction: { el: HTMLElement; value: string } | null = null

  function restoreTouchAction(): void {
    if (!priorTouchAction) return
    const { el, value } = priorTouchAction
    // Assigning '' removes the declaration, which is what an element with no
    // inline touch-action started with — setting 'auto' would leave a rule
    // behind that overrides a stylesheet.
    el.style.touchAction = value
    priorTouchAction = null
  }

  function setState(next: S): void {
    if (next === state) return
    state = next
    onStateChange?.(state)
  }

  function handlePointerDown(event: PointerEvent): void {
    if (state.phase !== 'idle') return
    if (event.button !== 0) return // primary button only; right-click opens menus
    if (isOwnUI(event)) return
    const pressed = resolvePressed ? resolvePressed(event) : event.target
    if (!(pressed instanceof Element)) return

    const next = begin(pressed, { x: event.clientX, y: event.clientY })
    if (!next || next.phase === 'idle') return
    activePointerId = event.pointerId

    // Touch: the browser decides whether this gesture is a pan BEFORE the
    // threshold is crossed, and `preventDefault` on a later `pointermove` is
    // too late to change its mind — it claims the pointer, fires
    // `pointercancel`, and the gesture is abandoned before it began. Pinning
    // `touch-action: none` for the duration is what keeps the gesture ours.
    const pinTarget = touchTarget?.(next) ?? pressed
    if (event.pointerType === 'touch' && pinTarget instanceof HTMLElement) {
      priorTouchAction = { el: pinTarget, value: pinTarget.style.touchAction }
      pinTarget.style.touchAction = 'none'
    }

    // NO `setPointerCapture`. The obvious reasoning says it is required — a
    // drag is by definition a move away from where it started — but the
    // listeners below are on the WINDOW in the capture phase, so they see every
    // move and the release wherever the pointer goes. Regression-simulated on
    // the reorder gesture: deleting the capture call changed no test, including
    // the one that drags off the list and back. Keeping it would have bought a
    // try/catch, a pointer id to track, and a stale-capture failure mode that
    // silently swallows later events.
    setState(next)
    // NOT preventDefault here. This is still ambiguously a click, and
    // suppressing the default now would break selection for every press that
    // never becomes a drag.
  }

  function handlePointerMove(event: PointerEvent): void {
    if (state.phase === 'idle') return
    if (event.pointerId !== activePointerId) return
    const next = onMove(state, { x: event.clientX, y: event.clientY })
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
    const { state: next, result } = onUp(state)
    setState(next)
    activePointerId = null
    restoreTouchAction()
    if (wasDragging) {
      // A completed drag must not also read as a click — the same press would
      // otherwise perform the gesture AND change the selection.
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
   * module abandons a gesture the user was in the middle of.
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
    restoreTouchAction()
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
  // commit a gesture the user never completed.
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
