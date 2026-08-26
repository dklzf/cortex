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
  onStateChange?: (state: ResizeDragState) => void
  onResult?: (result: ResizeResult) => void
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
  const { getTarget, isOwnUI, onStateChange, onResult, target } = options

  return installPointerGesture<ResizeDragState, ResizeResult>({
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
      return beginResize(el, raw as ResizeEdge, pointer)
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
