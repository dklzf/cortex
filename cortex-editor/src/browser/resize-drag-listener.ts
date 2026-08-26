import { installPointerGesture, type PointerGestureHandle } from './pointer-gesture.js'
import { beginResize, onResizeMove, onResizeUp, onResizeCancel, type ResizeDragState, type ResizeResult } from './resize-drag.js'
import type { ResizeEdge } from './constraint-owner.js'

/** The attribute a resize handle carries, naming the edge it grabs. */
export const RESIZE_EDGE_ATTR = 'data-cortex-resize-edge'

const EDGES = new Set<ResizeEdge>(['left', 'right', 'top', 'bottom'])

export interface ResizeDragOptions {
  /**
   * The element a handle press should resize — i.e. the current selection.
   *
   * A getter rather than a fixed element: the listener is installed once and
   * the selection changes under it, so capturing an element at install time
   * would resize whatever was selected when cortex started.
   */
  getTarget: () => Element | null
  /** True for cortex's own chrome. Handles LIVE in that chrome, so see below. */
  isOwnUI: (event: Event) => boolean
  /**
   * Cortex's shadow root, held from bootstrap.
   *
   * Optional so a caller can install this gesture against light-DOM handles —
   * which is what the synthetic gesture spec does, and what any future non-
   * shadow embedding would need. When it IS supplied (the production case) it
   * is the only way to resolve a press, because the root is CLOSED: the browser
   * retargets `event.target` to the host and trims `composedPath()` there too.
   */
  shadowRoot?: ShadowRoot
  onStateChange?: (state: ResizeDragState) => void
  onResult?: (result: ResizeResult, state: ResizeDragState) => void
  /**
   * The measurement probe threw, so no drag started.
   *
   * Separate from `onResult` because there is no result: the gesture never
   * began. The caller shows this to the user, because the alternative is a
   * press that does nothing for a reason nobody can see.
   */
  onProbeError?: (message: string) => void
  target?: Window
}

export type ResizeDragHandle = PointerGestureHandle<ResizeDragState>

/**
 * Event wiring for the resize gesture.
 *
 * ## Why this cannot use the shared `isOwnUI` decline
 *
 * `installPointerGesture` refuses any press whose `composedPath()` contains
 * `[data-cortex-host]`, which is what stops a page gesture starting on cortex's
 * own panel. Resize handles are the exception that proves the rule: they render
 * INSIDE `SelectionOverlay`, i.e. inside the shadow host, so the shared decline
 * would refuse every one of them.
 *
 * So `isOwnUI` is inverted for this gesture — a press must be on cortex chrome
 * AND carry a resize-edge attribute. That keeps the reorder listener's decline
 * intact (it still refuses handle presses, so the two never both fire) while
 * letting this one accept exactly the elements it owns.
 */
export function installResizeDrag(options: ResizeDragOptions): ResizeDragHandle {
  const { getTarget, isOwnUI, shadowRoot, onStateChange, onResult, onProbeError, target } = options

  return installPointerGesture<ResizeDragState, ResizeResult>({
    // `event.target` is the shadow HOST for any press inside a closed root, and
    // `composedPath()` is trimmed there too — measured in Chromium: path length
    // 5, handle absent. `elementFromPoint` on the retained root reference is
    // what still resolves the real node, which is why the root is threaded in.
    //
    // FALLS BACK to `event.target` when no root is supplied. Not defensive
    // padding: a shadow lookup that misses must not silently swallow a press
    // that light DOM would have resolved, and returning null here would decline
    // every gesture for a caller whose handles are not in a shadow tree.
    resolvePressed: (event) => {
      // Feature-detected, not assumed. `ShadowRoot.elementFromPoint` is part of
      // the DocumentOrShadowRoot mixin and real browsers all have it, but
      // happy-dom does not — and calling it blind threw inside the pointerdown
      // handler, taking an UNRELATED panel-drag test down with it. A gesture
      // module must not be able to break the page's other listeners.
      const inner = typeof shadowRoot?.elementFromPoint === 'function'
        ? shadowRoot.elementFromPoint(event.clientX, event.clientY)
        : null
      return inner ?? (event.target instanceof Element ? event.target : null)
    },
    begin: (pressed, pointer) => {
      // `closest` rather than reading the attribute off `pressed` directly: a
      // handle may contain a hit-area child or an icon, and the press lands on
      // the innermost node. Same lesson the reorder gesture learned with
      // `<li><span>`.
      const handle = pressed.closest(`[${RESIZE_EDGE_ATTR}]`)
      if (!handle) return null
      const raw = handle.getAttribute(RESIZE_EDGE_ATTR)
      if (!raw || !EDGES.has(raw as ResizeEdge)) return null

      const el = getTarget()
      if (!el) return null

      // `beginResize` PROBES: `getComputedStyle`, then `measureConstraintOwner`
      // writing and reverting an inline size, reading rects, and walking the
      // parent chain. Every one of those is page-reachable and page-overridable
      // — a cross-origin frame in the ancestry throws `SecurityError`, a page
      // that redefines `HTMLElement.prototype.style` throws `TypeError`, and a
      // node detached between selection and press throws from the rect read.
      //
      // `SelectionOverlay` already wraps the SAME probe (`canResizeEdge`) in a
      // try/catch. This path did not. Hardening the render path and leaving the
      // event path bare is the sibling-branch miss CLAUDE.md rule 3 names.
      //
      // Not a blanket swallow: `catch { return null }` would reproduce the
      // silent press this whole surface exists to avoid. Log for the developer,
      // surface for the user, decline the gesture.
      //
      // (On the DoS question — in Chromium a listener exception is reported and
      // dispatch continues, so other listeners survive. In happy-dom it does
      // take them down, which is how this class of bug was found here before.
      // The SILENT failure is the part that is real in every environment.)
      try {
        return beginResize(el, raw as ResizeEdge, pointer)
      } catch (err) {
        console.warn('[cortex] resize measurement failed on', el, err)
        onProbeError?.('cortex could not measure this element, so the drag did not start.')
        return null
      }
    },
    onMove: onResizeMove,
    onUp: onResizeUp,
    onCancel: onResizeCancel,
    // Pin `touch-action` on the RESIZED element, not the handle — the handle is
    // a few pixels wide and pinning it would not stop the page panning under a
    // touch that strays off it mid-drag.
    touchTarget: (state) => (state.phase === 'idle' ? null : state.element),
    // Inverted, per the doc comment above: accept ONLY cortex chrome.
    isOwnUI: (event) => !isOwnUI(event),
    onStateChange,
    onResult,
    target,
  })
}
