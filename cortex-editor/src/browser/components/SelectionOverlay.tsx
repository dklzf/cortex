import type { JSX } from 'preact'
import { useEffect, useRef, useMemo } from 'preact/hooks'
import { getSelectionLabel } from '../label.js'
import { onTransformUpdate } from '../transform-bus.js'
import { RESIZE_EDGE_ATTR } from '../resize-drag-listener.js'
import { canResizeEdge } from '../resize-drag.js'
import type { ResizeEdge } from '../constraint-owner.js'
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
  /** Show resize handles. Off by default so the overlay stays a pure outline
   *  for callers that only want selection feedback — and so the SECONDARY
   *  overlay, which reuses the class but not this component, cannot grow them. */
  resizable?: boolean
  /**
   * Live size readout while a resize drag is in flight; `null` when idle.
   *
   * The drag does NOT move the element — the write happens on release — so
   * without this the entire gesture has no feedback at all, and a drag that
   * gets refused looks exactly like a drag that worked. A number that tracks
   * the pointer is the cheapest honest signal: it needs no style write, so it
   * cannot fight the override manager or the MutationObserver watching it.
   */
  resizePreview?: { label: string } | null
}

/**
 * Persistent selection outline with transition. Uses RAF to track position
 * continuously (element may move from scroll/resize while selected).
 */
/**
 * Four edges plus four corners. Each corner drags ONE edge.
 *
 * `measureConstraintOwner` answers per-edge, so a true diagonal resize needs
 * two probes and two ownership records that can disagree with each other. Until
 * that is designed, a corner drags a single axis.
 *
 * Corners map to the HORIZONTAL edge, and the cursor says so. The first version
 * mapped all four to a vertical edge while styling them `nwse-resize` — so the
 * cursor promised a diagonal, dragging one sideways did nothing at all, and
 * dragging it any direction changed only the height. A cursor that lies about
 * what a control does is worse than a plain one; `ew-resize` is honest.
 */
const RESIZE_HANDLES: { edge: ResizeEdge; corner?: string }[] = [
  { edge: 'top' }, { edge: 'right' }, { edge: 'bottom' }, { edge: 'left' },
  { edge: 'left', corner: 'nw' }, { edge: 'right', corner: 'ne' },
  { edge: 'left', corner: 'sw' }, { edge: 'right', corner: 'se' },
]

export function SelectionOverlay({ element, availableStates, activeState, onStateChange, overlaysVisible = true, hmrAppliedVersion = 0, resizable = false, resizePreview = null }: SelectionOverlayProps): JSX.Element | null {
  const overlayRef = useRef<HTMLDivElement>(null)
  const lensRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)

  // Which handles can actually act on THIS element, measured once per
  // selection. `canResizeEdge` probes, so this must not run per render or per
  // pointermove — the memo key is the element plus the HMR counter, which is
  // exactly when layout can have changed underneath us.
  //
  // A THROWN probe is not an inert edge, and collapsing the two hid the only
  // report of it. `catch { return false }` dropped every handle, so the press
  // that would have reached `installResizeDrag`'s `onProbeError` could never
  // happen — the event path was hardened to explain this exact failure and the
  // explanation was unreachable through the UI. Kept separate and reported.
  const { handles: usableHandles, probeError } = useMemo<{
    handles: { edge: ResizeEdge; corner?: string }[]
    probeError: string | null
  }>(() => {
    if (!element || !resizable) return { handles: [], probeError: null }
    const handles: { edge: ResizeEdge; corner?: string }[] = []
    let failed = false
    for (const h of RESIZE_HANDLES) {
      try {
        if (canResizeEdge(element, h.edge)) handles.push(h)
      } catch (err) {
        // One warning per failing edge is noise; the first one carries the
        // diagnostic and the rest are the same page lying the same way.
        if (!failed) console.warn('[cortex] resize capability probe failed on', element, err)
        failed = true
      }
    }
    return {
      handles,
      // Only when NOTHING is measurable. A page that breaks one edge's probe
      // while the others answer leaves usable handles, and a banner over a
      // working affordance is worse than no banner.
      probeError: failed && handles.length === 0
        ? 'cortex could not measure this element, so it cannot offer resize handles for it.'
        : null,
    }
  }, [element, resizable, hmrAppliedVersion])

  // Reported through an effect, not during render — calling a parent's setState
  // mid-render is a Preact warning and an update-depth risk.
  //
  // Only NON-null values are pushed. The memo re-evaluates on every re-render
  // that changes its deps, and any pass where `resizable` is momentarily false
  // yields `probeError: null` — pushing that would immediately erase a real
  // error reported milliseconds earlier, which is exactly what happened.
  // Clearing belongs to the parent, on selection change, because that is the
  // scope a probe error actually has.
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
      {resizable && usableHandles.map(({ edge, corner }) => (
        <div
          key={corner ?? edge}
          class={`cortex-resize-handle cortex-resize-handle--${corner ?? edge}`}
          // The edge this handle DRAGS. A corner carries one edge too: dragging
          // a corner resizes along one axis at a time, which keeps the gesture
          // honest — `measureConstraintOwner` answers per-edge, and pretending a
          // corner is two simultaneous edges would need two probes and two
          // ownership records that can disagree.
          {...{ [RESIZE_EDGE_ATTR]: edge }}
        />
      ))}
      {probeError && (
        // Rendered HERE rather than reported to CortexApp for it to render.
        //
        // Three attempts at the callback version each died on effect ordering:
        // a child's reporting effect runs before the parent's clearing effect,
        // so the message was set and erased in the same commit. The round trip
        // bought nothing — this is a fact the overlay computes, about the
        // element the overlay is drawing, shown where the overlay already is.
        // Keeping it local deletes the state, the effect, and the ordering.
        <span class="cortex-resize-readout cortex-resize-readout--error">{probeError}</span>
      )}
      {resizePreview && (
        // Sits with the label rather than following the dragged edge: the edge
        // is where the pointer already is, and a badge under the cursor is the
        // one thing guaranteed to be occluded by it.
        <span class="cortex-resize-readout">{resizePreview.label}</span>
      )}
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
