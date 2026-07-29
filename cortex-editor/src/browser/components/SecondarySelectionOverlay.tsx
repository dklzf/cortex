import type { JSX } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { onTransformUpdate } from '../transform-bus.js'
import { onOverrideChange } from '../override-bus.js'

export interface SecondarySelectionOverlayProps {
  /** A non-primary selected element (selectedElements[i] for i >= 1). */
  element: Element
  overlaysVisible?: boolean
  /** HMR cycle counter — re-initializes RAF loop. */
  hmrAppliedVersion?: number
}

/**
 * Lightweight outline overlay for non-primary selected elements (ZF0-1195).
 * The primary element gets the full `SelectionOverlay` (label + state lens);
 * additional selections just need a visible outline so the user can see
 * which elements are part of the multi-selection.
 *
 * RAF tracking mirrors `SelectionOverlay`'s pattern but drops the label,
 * lens, scroll-into-view, and shift-detection logic — those are primary
 * concerns. The outline updates on transform writes, override-bus changes,
 * scroll, resize, and HMR cycles.
 */
export function SecondarySelectionOverlay({
  element,
  overlaysVisible = true,
  hmrAppliedVersion = 0,
}: SecondarySelectionOverlayProps): JSX.Element | null {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!overlayRef.current) return

    let rafId = 0
    let idleFrames = 0
    let prevTransform = ''
    let prevWidth = ''
    let prevHeight = ''
    let prevBorderRadius = ''

    function update(): void {
      if (!overlayRef.current) return
      if (!element.isConnected) {
        // Hide the overlay when its target detaches from the DOM (PR #104
        // review I2). Without this, the last painted box stays visible until
        // some unrelated rerender, leaving ghost outlines after HMR or
        // node removal — the deferred secondary-element re-resolution path
        // (T1) means we can't always recover the new node either.
        overlayRef.current.style.visibility = 'hidden'
        return
      }
      const r = element.getBoundingClientRect()
      const transform = `translate(${r.left}px, ${r.top}px)`
      const width = `${r.width}px`
      const height = `${r.height}px`
      const el = overlayRef.current
      const changed = transform !== prevTransform || width !== prevWidth || height !== prevHeight
      const sizeChanged = width !== prevWidth || height !== prevHeight
      if (transform !== prevTransform) { el.style.transform = transform; prevTransform = transform }
      if (width !== prevWidth) { el.style.width = width; prevWidth = width }
      if (height !== prevHeight) { el.style.height = height; prevHeight = height }
      if (sizeChanged || prevBorderRadius === '') {
        const br = getComputedStyle(element).borderRadius || '0px'
        if (br !== prevBorderRadius) { el.style.borderRadius = br; prevBorderRadius = br }
      }
      if (changed) { idleFrames = 0 } else { idleFrames++ }
      if (idleFrames >= 3) { rafId = 0; return }
      rafId = requestAnimationFrame(update)
    }

    function restartLoop(): void {
      if (!rafId) { idleFrames = 0; rafId = requestAnimationFrame(update) }
    }

    update()

    function handleTransformUpdate(): void {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
      idleFrames = 0
      update()
    }
    const unsubTransform = onTransformUpdate(handleTransformUpdate)
    const unsubOverride = onOverrideChange(restartLoop)
    window.addEventListener('scroll', restartLoop, { capture: true, passive: true })
    window.addEventListener('resize', restartLoop)

    return () => {
      cancelAnimationFrame(rafId)
      unsubTransform()
      unsubOverride()
      window.removeEventListener('scroll', restartLoop, { capture: true })
      window.removeEventListener('resize', restartLoop)
    }
  }, [element, hmrAppliedVersion])

  return (
    <div
      ref={overlayRef}
      class="cortex-selection-overlay cortex-selection-overlay--secondary"
      style={{ visibility: overlaysVisible ? 'visible' : 'hidden' }}
    />
  )
}
