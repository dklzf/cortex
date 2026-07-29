import type { JSX } from 'preact'
import { useState, useRef, useEffect } from 'preact/hooks'
import { getLabel } from '../label.js'
import { onTransformUpdate } from '../transform-bus.js'

export interface HoverOverlayProps {
  element: Element | null
}

/**
 * Semi-transparent hover highlight. Positioned via getBoundingClientRect().
 * Re-rendered on every mousemove by the parent — no internal RAF needed.
 *
 * Overlays live in Shadow DOM on documentElement (outside body), so
 * getBoundingClientRect() already returns correct visual coordinates
 * even when body has a CSS transform (canvas zoom).
 */
export function HoverOverlay({ element }: HoverOverlayProps): JSX.Element | null {
  // Cache borderRadius keyed on element identity — avoids getComputedStyle per render
  const cachedElementRef = useRef<Element | null>(null)
  const cachedBorderRadiusRef = useRef('0px')

  // Re-render on canvas transform updates so getBoundingClientRect stays fresh
  const [, forceRender] = useState(0)
  useEffect(() => {
    if (!element) return
    return onTransformUpdate(() => forceRender(c => c + 1))
  }, [element])

  if (!element) return null

  const r = element.getBoundingClientRect()

  // Only call getComputedStyle when element identity changes
  if (element !== cachedElementRef.current) {
    cachedElementRef.current = element
    cachedBorderRadiusRef.current = getComputedStyle(element).borderRadius || '0px'
  }

  const label = getLabel(element)
  const labelAbove = r.top > 30

  return (
    <div
      class="cortex-hover-overlay"
      style={{
        transform: `translate(${r.left}px, ${r.top}px)`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        borderRadius: cachedBorderRadiusRef.current,
      }}
    >
      <span class={`cortex-label ${labelAbove ? 'cortex-label--above' : 'cortex-label--below'}`}>
        {label}
      </span>
    </div>
  )
}
