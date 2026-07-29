import type { JSX } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { getSelectionLabel } from '../label.js'
import { onTransformUpdate } from '../transform-bus.js'
import { onOverrideChange } from '../override-bus.js'
import type { StateDeclarations, InteractionState } from '../state-detector.js'

export interface SelectionOverlayProps {
  element: Element | null
  availableStates?: StateDeclarations
  activeState?: InteractionState
  onStateChange?: (state: InteractionState) => void
  overlaysVisible?: boolean
  /** Counter that bumps on every HMR cycle. Forces the RAF tracking loop
   *  to re-initialize so layout changes from source-edit reorders (where
   *  the selected element moves position but stays connected) are picked
   *  up. Without this dep, the loop's idle-until-change optimization
   *  leaves the overlay glued to the old position — ZF0-1292. */
  hmrAppliedVersion?: number
}

/**
 * Persistent selection outline with transition. Uses RAF to track position
 * continuously (element may move from scroll/resize while selected).
 */
export function SelectionOverlay({ element, availableStates, activeState, onStateChange, overlaysVisible = true, hmrAppliedVersion = 0 }: SelectionOverlayProps): JSX.Element | null {
  const overlayRef = useRef<HTMLDivElement>(null)
  const lensRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)

  // Cached lens dimensions — only re-measured when availableStates changes
  const cachedLensWRef = useRef(120)
  const cachedLensHRef = useRef(24)
  const lensNeedsMeasureRef = useRef(true)

  // Re-measure lens when available states change (buttons added/removed)
  useEffect(() => {
    lensNeedsMeasureRef.current = true
  }, [availableStates])

  // RAF-based continuous position tracking for the selected element
  useEffect(() => {
    if (!element || !overlayRef.current) return

    let rafId = 0
    let idleFrames = 0
    // Cache previous values to skip redundant DOM writes
    let prevTransform = ''
    let prevWidth = ''
    let prevHeight = ''
    let prevBorderRadius = ''

    // Layout shift tracking — document-relative coordinates (bundled structs)
    interface DocPos { top: number; left: number }
    let stableDoc: DocPos | null = null // baseline for total shift threshold
    let prevDoc: DocPos | null = null   // previous frame for movement detection
    let lastChangeTime = 0
    let scrollCooldownUntil = 0
    const STABLE_THRESHOLD_MS = 400
    const SHIFT_THRESHOLD_PX = 50
    const SCROLL_COOLDOWN_MS = 1000

    function update(): void {
      if (!element || !overlayRef.current) return
      // Stop RAF loop when element is detached from DOM (e.g. HMR, navigation)
      if (!element.isConnected) return
      // Overlays live in Shadow DOM on documentElement (outside body),
      // so getBoundingClientRect already returns correct visual coordinates
      // even when body has a CSS transform (canvas zoom).
      const r = element.getBoundingClientRect()
      const transform = `translate(${r.left}px, ${r.top}px)`
      const width = `${r.width}px`
      const height = `${r.height}px`

      // Only write to DOM when values changed
      const el = overlayRef.current
      const changed = transform !== prevTransform || width !== prevWidth || height !== prevHeight
      const sizeChanged = width !== prevWidth || height !== prevHeight
      if (transform !== prevTransform) { el.style.transform = transform; prevTransform = transform }
      if (width !== prevWidth) { el.style.width = width; prevWidth = width }
      if (height !== prevHeight) { el.style.height = height; prevHeight = height }

      // Idle frame detection — stop RAF after 3 unchanged frames
      if (changed) { idleFrames = 0 } else { idleFrames++ }

      // Update borderRadius only when dimensions change (avoids per-frame getComputedStyle)
      if (sizeChanged || prevBorderRadius === '') {
        const br = getComputedStyle(element).borderRadius || '0px'
        if (br !== prevBorderRadius) { el.style.borderRadius = br; prevBorderRadius = br }
      }

      // Update label position via ref — RAF is the single source of truth.
      // This avoids disagreement between render-time and RAF-time thresholds.
      const labelH = 20 // approximate label height
      const gap = 8
      const isLabelBelow = (window.innerHeight - r.bottom) > (labelH + gap)
      if (labelRef.current) {
        const cls = isLabelBelow
          ? 'cortex-label cortex-label--below'
          : 'cortex-label cortex-label--above'
        if (labelRef.current.className !== cls) labelRef.current.className = cls
      }

      // Update lens position in sync with overlay.
      // Default: lens above element, label below. When stacked, label nearest to element.
      if (lensRef.current) {
        // Only read offsetWidth/offsetHeight when lens content changed
        if (lensNeedsMeasureRef.current) {
          const measuredW = lensRef.current.offsetWidth
          const measuredH = lensRef.current.offsetHeight
          if (measuredW > 0) {
            cachedLensWRef.current = measuredW
            cachedLensHRef.current = measuredH || 24
            lensNeedsMeasureRef.current = false // only clear when measurement succeeds
          }
        }

        const lensW = cachedLensWRef.current
        const lensH = cachedLensHRef.current

        // Hide lens until it has a valid measurement (prevents first-frame flash).
        if (lensW <= 0) {
          lensRef.current.style.visibility = 'hidden'
        } else {
          lensRef.current.style.visibility = 'visible'
        }

        const isAbove = r.top > (lensH + gap) // enough room above for lens

        let lensTop: number
        if (isAbove) {
          // Lens above — check if label is also above (stacked)
          lensTop = !isLabelBelow
            ? r.top - labelH - gap - lensH - 4 // both above: lens above label
            : r.top - lensH - gap               // default: lens above, label below
        } else {
          // Lens below — label is also below (stacked): label nearest, lens outside
          lensTop = r.bottom + labelH + gap + 4
        }
        const lensLeft = r.left + r.width / 2 - lensW / 2
        const clampedLeft = Math.max(4, Math.min(lensLeft, window.innerWidth - 4 - lensW))
        lensRef.current.style.transform = `translate(${clampedLeft}px, ${lensTop}px)`
      }

      // Shift detection uses document-relative coordinates
      const docTop = r.top + window.scrollY
      const docLeft = r.left + window.scrollX

      // Initialize on first read — no shift detection until second frame
      if (stableDoc === null) {
        stableDoc = { top: docTop, left: docLeft }
        prevDoc = { top: docTop, left: docLeft }
        rafId = requestAnimationFrame(update)
        return
      }

      // During scroll cooldown: keep baseline current but skip shift detection
      if (performance.now() < scrollCooldownUntil) {
        stableDoc = { top: docTop, left: docLeft }
        prevDoc = { top: docTop, left: docLeft }
        rafId = requestAnimationFrame(update)
        return
      }

      // Detect frame-to-frame movement (> 2px jitter filter)
      const dTop = docTop - prevDoc!.top
      const dLeft = docLeft - prevDoc!.left
      const shifted = Math.abs(dTop) > 2 || Math.abs(dLeft) > 2

      if (shifted) {
        lastChangeTime = performance.now()
      }
      prevDoc = { top: docTop, left: docLeft }

      // After position stabilizes for STABLE_THRESHOLD_MS, check total shift from baseline
      const timeSinceChange = performance.now() - lastChangeTime
      if (timeSinceChange > STABLE_THRESHOLD_MS && lastChangeTime > 0) {
        const totalShift = Math.hypot(
          docTop - stableDoc.top,
          docLeft - stableDoc.left,
        )
        const offScreen = r.top < 0 || r.bottom > window.innerHeight ||
                          r.left < 0 || r.right > window.innerWidth
        if (totalShift > SHIFT_THRESHOLD_PX && offScreen) {
          element.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          scrollCooldownUntil = performance.now() + SCROLL_COOLDOWN_MS
        }
        stableDoc = { top: docTop, left: docLeft }
        lastChangeTime = 0 // reset — don't re-trigger
      }

      // Stop loop after 3 idle frames — restartLoop wakes it on external events
      if (idleFrames >= 3) { rafId = 0; return }
      rafId = requestAnimationFrame(update)
    }

    // Restart RAF loop from idle — called by scroll, resize, override changes, etc.
    // MUST schedule via RAF, not call update() directly — calling update() synchronously
    // during a stylesheet write forces the browser to recalculate styles for all
    // [data-cortex-source] elements before getBoundingClientRect() can return,
    // causing a full-page flash.
    function restartLoop() {
      if (!rafId) { idleFrames = 0; rafId = requestAnimationFrame(update) }
    }

    update()

    // Synchronize overlay position with canvas transform writes.
    // emitTransformUpdate fires after every body.style.transform write,
    // so we re-read getBoundingClientRect in the same JS task — no 1-frame lag.
    function handleTransformUpdate() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
      idleFrames = 0
      update()
    }
    const unsubTransform = onTransformUpdate(handleTransformUpdate)

    // Wake RAF loop when CSS overrides change element geometry (e.g. padding scrub-end).
    // Without this, the overlay stays at the old position/size after idle timeout.
    const unsubOverride = onOverrideChange(restartLoop)

    // Restart loop on scroll/resize (element may have moved)
    window.addEventListener('scroll', restartLoop, { capture: true, passive: true })
    window.addEventListener('resize', restartLoop)

    return () => {
      cancelAnimationFrame(rafId)
      unsubTransform()
      unsubOverride()
      window.removeEventListener('scroll', restartLoop, { capture: true })
      window.removeEventListener('resize', restartLoop)
    }
    // hmrAppliedVersion is in deps so the effect re-initializes on every HMR
    // cycle — the teardown cancels the idle RAF loop and the fresh setup
    // runs update() synchronously with the new getBoundingClientRect. This
    // catches loop-reorder cases where the selected element's DOM node is
    // preserved (isConnected stays true) but its layout position changed.
  }, [element, hmrAppliedVersion])

  if (!element) return null

  const label = getSelectionLabel(element)

  // Determine if the state lens should be shown
  const showLens = !!(availableStates && (
    availableStates.hover.size > 0 ||
    availableStates.focus.size > 0 ||
    availableStates.active.size > 0
  ))

  // Build the list of available state buttons
  const stateButtons: Array<{ label: string; state: InteractionState }> = []
  if (showLens) {
    stateButtons.push({ label: 'Default', state: 'default' })
    if (availableStates!.hover.size > 0) stateButtons.push({ label: ':hover', state: 'hover' })
    if (availableStates!.focus.size > 0) stateButtons.push({ label: ':focus', state: 'focus' })
    if (availableStates!.active.size > 0) stateButtons.push({ label: ':active', state: 'active' })
  }

  return (
    <div
      ref={overlayRef}
      class="cortex-selection-overlay"
      style={{
        // width/height intentionally omitted — set by the RAF position-tracking loop
        // at lines 73-75. Including them here causes Preact re-renders to overwrite
        // RAF-set values with 0, producing a one-frame flash.
        visibility: overlaysVisible ? 'visible' : 'hidden',
      }}
    >
      <span ref={labelRef} class="cortex-label cortex-label--below">
        {label}
      </span>
      {showLens && (
        <div
          ref={lensRef}
          class="cortex-state-lens"
          style={{ position: 'fixed', left: 0, top: 0 }}
        >
          {stateButtons.map(({ label: btnLabel, state }) => (
            <button
              key={state}
              class={`cortex-state-lens__btn${activeState === state ? ' cortex-state-lens__btn--active' : ''}`}
              onClick={() => onStateChange?.(state)}
            >
              {btnLabel}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
