import type { JSX } from 'preact'
import { useState, useEffect } from 'preact/hooks'
import { dropIndicatorRect } from '../drop-target.js'
import { onTransformUpdate } from '../transform-bus.js'
import type { ReorderDragState } from '../reorder-drag.js'

export interface ReorderDropIndicatorProps {
  state: ReorderDragState
}

/**
 * The "it will land here" line for an in-progress reorder (COR-7, M1).
 *
 * Reads its geometry from `dropIndicatorRect`, which measures the SAME rects
 * `resolveDropTarget` used to pick the slot. Computing the line independently
 * is how a drag starts feeling possessed — an indicator drawn one slot away
 * from where the release actually lands is worse than none, because the user
 * trusts it and drops in the wrong place.
 *
 * Renders nothing until the press has become a drag. Showing a line the moment
 * a row is pressed would tell the user a move is underway before they have
 * asked for one, and every click would flash it.
 */
export function ReorderDropIndicator({ state }: ReorderDropIndicatorProps): JSX.Element | null {
  // Overlays live in Shadow DOM on documentElement, so getBoundingClientRect
  // already returns visual coordinates under canvas zoom — but the transform
  // itself changes them, so re-render when it moves.
  const [, forceRender] = useState(0)
  useEffect(() => {
    if (state.phase !== 'dragging') return
    return onTransformUpdate(() => forceRender(c => c + 1))
  }, [state.phase])

  if (state.phase !== 'dragging') return null

  const rect = dropIndicatorRect(state.container, state.fromIndex, state.toIndex)
  if (!rect) return null

  return (
    <div
      class="cortex-reorder-drop-indicator"
      data-cortex-reorder-axis={state.axis}
      style={{
        transform: `translate(${rect.left}px, ${rect.top}px)`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
    />
  )
}
