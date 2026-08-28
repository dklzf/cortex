/**
 * "The next click belongs to a gesture that already happened — eat it."
 *
 * ## Why this is shared state rather than a local flag
 *
 * A completed drag must not ALSO read as a click: the same press would perform
 * the gesture and then change the selection. `installPointerGesture` handled
 * that with its own `swallowNextClick` and a capture-phase `click` listener
 * calling `stopPropagation`.
 *
 * That works in isolation and fails in the assembled app, because BOTH the
 * selection handler and the gesture handler are capture-phase listeners on
 * `window`, and same-target capture listeners fire in REGISTRATION order.
 * `initSelection` is installed long before either gesture (CortexApp line ~381
 * vs ~1535/1596), so it ran first, selected whatever was under the release
 * point, and only then did the gesture's `stopPropagation` execute. A resize
 * drag released away from the handle therefore changed the selection every
 * time — verified in a real browser, not deduced.
 *
 * Ordering cannot be fixed by re-ordering: the gesture listeners are installed
 * from effects that legitimately run later, and any future listener would
 * reintroduce the same race. So the flag is shared, and whichever capture
 * listener sees it FIRST consumes it and swallows the click. Every participant
 * checks the same fact instead of competing to act on it.
 */

let armed = false

/** A drag completed. The synthetic click that follows is not a user click. */
export function armClickSwallow(): void {
  armed = true
}

/**
 * Take the flag if it is set, clearing it.
 *
 * The caller that gets `true` owns swallowing this click — it must
 * `preventDefault()` and `stopPropagation()` — because no one else will now
 * see the flag.
 */
export function consumeClickSwallow(): boolean {
  if (!armed) return false
  armed = false
  return true
}

/**
 * Clear without consuming.
 *
 * Called on a new pointerdown: the browser does not always deliver the click
 * that a drag implies — a pointerup outside the window, an interrupted touch
 * sequence — and a flag left armed would eat some unrelated click later. A new
 * press proves the old gesture's click is never arriving.
 */
export function disarmClickSwallow(): void {
  armed = false
}
