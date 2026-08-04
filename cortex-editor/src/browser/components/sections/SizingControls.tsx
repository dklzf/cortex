/**
 * SizingControls — Panel v2 Task 10 (ZF0-1188)
 *
 * Extracted from LayoutSection's inline sizing block. Controls how a
 * selected element's width/height is determined: fixed px, fit-content,
 * or fill (100%). Also exposes min/max constraints, aspect-lock,
 * clip-content (overflow), and border-box toggles.
 *
 * Business logic: This component lets the user resize elements and set
 * sizing constraints. It fires CSS property changes (width, height,
 * min-width, max-width, min-height, max-height, overflow, box-sizing)
 * that get applied as CSS overrides to the selected element.
 *
 * CRITICAL BUG FIX (widthMode/heightMode stale state):
 * The old LayoutSection used useState for widthMode/heightMode
 * initialized from values but never re-synced when props changed.
 * Now widthMode/heightMode are DERIVED from values via a pure function
 * — no useState. Same for minWidthEnabled/maxWidthEnabled etc.
 */
import type { JSX } from 'preact'
import { useState, useCallback, useEffect } from 'preact/hooks'
import { isDimmed } from './types.js'
import type { SectionChange } from './types.js'
import { NumericInput } from '../controls/NumericInput.js'
import { SizingDropdown } from '../controls/SizingDropdown.js'
import { Check, Lock, LockOpen, X } from '../icons.js'
import type { SelectableSizingMode } from '../../sizing-value.js'
import { classifySizingValue } from '../../sizing-value.js'

export type SizingChange = SectionChange

const DIMENSION_REQUIRES_FIXED_TOOLTIP = 'Switch to Fixed (px) to edit dimensions'
const ASPECT_LOCK_REQUIRES_FIXED_TOOLTIP = 'Aspect lock requires fixed dimensions'

export interface SizingControlsProps {
  values: {
    width: string
    height: string
    /** Used (rendered) pixel size. See LayoutValues.widthUsed. */
    widthUsed?: string
    heightUsed?: string
    minWidth: string
    maxWidth: string
    minHeight: string
    maxHeight: string
    overflow: string
    boxSizing: string
  }
  onChange: (change: SizingChange) => void
  onScrub?: (change: SizingChange) => void
  onScrubEnd?: (change: SizingChange) => void
  /** Set of CSS properties that changed in the forced state. When present, unchanged properties are dimmed. */
  dimmedProperties?: Set<string>
  mixedProperties?: Set<string>
  /**
   * When true, the element's source override has exceeded the TTL without hmr_verified.
   * Forwarded to NumericInput controls as the stale indicator.
   */
  stale?: boolean
}

/** Derive the SizingDropdown mode from the raw CSS value — pure, no state.
 *
 *  Previously this was a DECODER of cortex's own write vocabulary
 *  (`fit-content` / `100%` / `<n>px`) whose fall-through was `return 'fixed'`.
 *  Used as a CLASSIFIER over arbitrary authored CSS — which is what the panel
 *  needs — that fall-through made every element read Fixed, including
 *  author-written `width: 100%`. Delegates to the real classifier now. */
const deriveSizingMode = classifySizingValue

/** Derive whether a min/max constraint is active from the raw CSS value. */
function isMinEnabled(value: string): boolean {
  const num = parseFloat(value)
  return !isNaN(num) && num > 0
}

function isMaxEnabled(value: string): boolean {
  return value !== 'none' && value !== ''
}

export function SizingControls({
  values,
  onChange,
  onScrub,
  onScrubEnd,
  dimmedProperties,
  mixedProperties,
  stale,
}: SizingControlsProps): JSX.Element {
  const [aspectLocked, setAspectLocked] = useState(false)

  // Derive modes from values — fixes stale-state bug (Task 2 flag).
  const widthMode = deriveSizingMode(values.width)
  const heightMode = deriveSizingMode(values.height)
  const minWidthEnabled = isMinEnabled(values.minWidth)
  const maxWidthEnabled = isMaxEnabled(values.maxWidth)
  const minHeightEnabled = isMinEnabled(values.minHeight)
  const maxHeightEnabled = isMaxEnabled(values.maxHeight)

  // Only a `fixed` value is a pixel count. Parsing `50%` yields 50 and would
  // render "50 px" for an element that is half its parent's width; parsing
  // `auto` yields NaN and renders "0". Both are worse than showing nothing.
  const widthNum = widthMode === 'fixed' ? parseFloat(values.width) : NaN
  const heightNum = heightMode === 'fixed' ? parseFloat(values.height) : NaN
  const isAutoWidth = isNaN(widthNum)
  const isAutoHeight = isNaN(heightNum)

  // The element's true rendered size. For a non-fixed element this is the ONLY
  // honest number available: `100%` and `fit-content` are not measurements, and
  // showing 0 in their place fabricates a width for a box that plainly has one.
  // Figma does the same — a Fill/Hug element still reports its current size.
  const usedWidthNum = parseFloat(values.widthUsed ?? '')
  const usedHeightNum = parseFloat(values.heightUsed ?? '')
  // What the W/H fields display. Fixed shows its authored value; anything else
  // shows the measured one. Falls back to 0 only when there is no measurement
  // at all (empty selection).
  const widthDisplay = isAutoWidth ? (isNaN(usedWidthNum) ? 0 : usedWidthNum) : widthNum
  const heightDisplay = isAutoHeight ? (isNaN(usedHeightNum) ? 0 : usedHeightNum) : heightNum

  const canLockAspect = widthMode === 'fixed' && heightMode === 'fixed'
  const widthDisabled = widthMode !== 'fixed'
  const heightDisabled = heightMode !== 'fixed'
  const lockUiActive = canLockAspect && aspectLocked
  // Auto-unlock when either dimension switches away from fixed (e.g., to
  // fill or fit). Without this, aspectLocked survives mode changes and the
  // lock button renders as visually active while the guard silently no-ops
  // every coupled write — confusing UX flagged by 3 independent reviewers.
  useEffect(() => {
    if (!canLockAspect) setAspectLocked(false)
  }, [canLockAspect])
  const aspectRatio = (canLockAspect && !isAutoWidth && !isAutoHeight && heightNum > 0)
    ? widthNum / heightNum
    : 1

  // ── Width handlers ──────────────────────────────────────────────
  const handleWidthChange = useCallback(
    (v: number) => {
      if (widthDisabled) return
      onChange({ property: 'width', value: `${v}px` })
      if (aspectLocked && canLockAspect && aspectRatio > 0) {
        onChange({ property: 'height', value: `${Math.round(v / aspectRatio)}px` })
      }
    },
    [onChange, widthDisabled, aspectLocked, canLockAspect, aspectRatio],
  )
  const handleWidthScrub = useCallback(
    (v: number) => {
      if (widthDisabled) return
      if (onScrub) onScrub({ property: 'width', value: `${v}px` })
      if (aspectLocked && canLockAspect && aspectRatio > 0 && onScrub) {
        onScrub({ property: 'height', value: `${Math.round(v / aspectRatio)}px` })
      }
    },
    [onScrub, widthDisabled, aspectLocked, canLockAspect, aspectRatio],
  )
  const handleWidthScrubEnd = useCallback(
    (v: number) => {
      if (widthDisabled) return
      if (onScrubEnd) onScrubEnd({ property: 'width', value: `${v}px` })
      if (aspectLocked && canLockAspect && aspectRatio > 0 && onScrubEnd) {
        onScrubEnd({ property: 'height', value: `${Math.round(v / aspectRatio)}px` })
      }
    },
    [onScrubEnd, widthDisabled, aspectLocked, canLockAspect, aspectRatio],
  )

  // ── Height handlers ─────────────────────────────────────────────
  const handleHeightChange = useCallback(
    (v: number) => {
      if (heightDisabled) return
      onChange({ property: 'height', value: `${v}px` })
      if (aspectLocked && canLockAspect && aspectRatio > 0) {
        onChange({ property: 'width', value: `${Math.round(v * aspectRatio)}px` })
      }
    },
    [onChange, heightDisabled, aspectLocked, canLockAspect, aspectRatio],
  )
  const handleHeightScrub = useCallback(
    (v: number) => {
      if (heightDisabled) return
      if (onScrub) onScrub({ property: 'height', value: `${v}px` })
      if (aspectLocked && canLockAspect && aspectRatio > 0 && onScrub) {
        onScrub({ property: 'width', value: `${Math.round(v * aspectRatio)}px` })
      }
    },
    [onScrub, heightDisabled, aspectLocked, canLockAspect, aspectRatio],
  )
  const handleHeightScrubEnd = useCallback(
    (v: number) => {
      if (heightDisabled) return
      if (onScrubEnd) onScrubEnd({ property: 'height', value: `${v}px` })
      if (aspectLocked && canLockAspect && aspectRatio > 0 && onScrubEnd) {
        onScrubEnd({ property: 'width', value: `${Math.round(v * aspectRatio)}px` })
      }
    },
    [onScrubEnd, heightDisabled, aspectLocked, canLockAspect, aspectRatio],
  )

  const handleToggleLock = useCallback(() => {
    if (!canLockAspect) return
    setAspectLocked((v) => !v)
  }, [canLockAspect])

  // ── Mode change handlers ────────────────────────────────────────
  const handleWidthModeChange = useCallback((mode: SelectableSizingMode) => {
    if (mode === 'fit') onChange({ property: 'width', value: 'fit-content' })
    else if (mode === 'fill') onChange({ property: 'width', value: '100%' })
    // Switching TO Fixed must pin the element at the size it currently RENDERS.
    // Seeding from `widthNum` wrote `0px` for every non-fixed element, because
    // widthNum is NaN unless the value was authored in pixels.
    else onChange({ property: 'width', value: `${widthDisplay}px` })
  }, [onChange, widthDisplay])

  const handleHeightModeChange = useCallback((mode: SelectableSizingMode) => {
    if (mode === 'fit') onChange({ property: 'height', value: 'fit-content' })
    else if (mode === 'fill') onChange({ property: 'height', value: '100%' })
    else onChange({ property: 'height', value: `${heightDisplay}px` })
  }, [onChange, heightDisplay])

  // ── Min/max handlers ────────────────────────────────────────────
  const handleMinWidthChange = useCallback(
    (v: number) => onChange({ property: 'min-width', value: `${v}px` }),
    [onChange],
  )
  const handleMaxWidthChange = useCallback(
    (v: number) => onChange({ property: 'max-width', value: `${v}px` }),
    [onChange],
  )
  const handleMinHeightChange = useCallback(
    (v: number) => onChange({ property: 'min-height', value: `${v}px` }),
    [onChange],
  )
  const handleMaxHeightChange = useCallback(
    (v: number) => onChange({ property: 'max-height', value: `${v}px` }),
    [onChange],
  )

  const handleToggleMinWidth = useCallback(() => {
    if (minWidthEnabled) onChange({ property: 'min-width', value: '0px' })
    else onChange({ property: 'min-width', value: '1px' })
  }, [onChange, minWidthEnabled])

  const handleToggleMaxWidth = useCallback(() => {
    if (maxWidthEnabled) onChange({ property: 'max-width', value: 'none' })
    else onChange({ property: 'max-width', value: '9999px' })
  }, [onChange, maxWidthEnabled])

  const handleToggleMinHeight = useCallback(() => {
    if (minHeightEnabled) onChange({ property: 'min-height', value: '0px' })
    else onChange({ property: 'min-height', value: '1px' })
  }, [onChange, minHeightEnabled])

  const handleToggleMaxHeight = useCallback(() => {
    if (maxHeightEnabled) onChange({ property: 'max-height', value: 'none' })
    else onChange({ property: 'max-height', value: '9999px' })
  }, [onChange, maxHeightEnabled])

  // ── Clip content (overflow) ─────────────────────────────────────
  const isClipped = values.overflow === 'hidden'
  const handleClipToggle = useCallback(() => {
    onChange({ property: 'overflow', value: isClipped ? 'visible' : 'hidden' })
  }, [onChange, isClipped])

  // ── Border box ──────────────────────────────────────────────────
  const isBorderBox = values.boxSizing === 'border-box'
  const handleBoxSizingToggle = useCallback(() => {
    onChange({ property: 'box-sizing', value: isBorderBox ? 'content-box' : 'border-box' })
  }, [onChange, isBorderBox])

  return (
    <div class="cortex-sizing-controls" data-testid="sizing-controls">
      <span class="cortex-subsection-label">Size</span>
      <div class="cortex-layout-section__sizing">
        <div class={`cortex-layout-section__sizing-field${isDimmed(dimmedProperties, 'width', 'min-width', 'max-width') ? ' cortex-control--dimmed' : ''}`}>
          <NumericInput
            value={widthDisplay}
            label="W"
            tooltip={widthDisabled ? DIMENSION_REQUIRES_FIXED_TOOLTIP : 'Width'}
            min={0}
            disabled={widthDisabled}
            mixed={mixedProperties?.has('width')}
            stale={stale}
            onChange={handleWidthChange}
            onScrub={handleWidthScrub}
            onScrubEnd={handleWidthScrubEnd}
          />
          <SizingDropdown
            mode={widthMode}
            minEnabled={minWidthEnabled}
            maxEnabled={maxWidthEnabled}
            onModeChange={handleWidthModeChange}
            onToggleMin={handleToggleMinWidth}
            onToggleMax={handleToggleMaxWidth}
            dimension="Width"
          />
        </div>
        <div class={`cortex-layout-section__sizing-field${isDimmed(dimmedProperties, 'height', 'min-height', 'max-height') ? ' cortex-control--dimmed' : ''}`}>
          <NumericInput
            value={heightDisplay}
            label="H"
            tooltip={heightDisabled ? DIMENSION_REQUIRES_FIXED_TOOLTIP : 'Height'}
            min={0}
            disabled={heightDisabled}
            mixed={mixedProperties?.has('height')}
            stale={stale}
            onChange={handleHeightChange}
            onScrub={handleHeightScrub}
            onScrubEnd={handleHeightScrubEnd}
          />
          <SizingDropdown
            mode={heightMode}
            minEnabled={minHeightEnabled}
            maxEnabled={maxHeightEnabled}
            onModeChange={handleHeightModeChange}
            onToggleMin={handleToggleMinHeight}
            onToggleMax={handleToggleMaxHeight}
            dimension="Height"
          />
        </div>
        <button
          type="button"
          class={`cortex-lock-btn${lockUiActive ? ' cortex-lock-btn--active' : ''}${!canLockAspect ? ' cortex-lock-btn--disabled' : ''}`}
          aria-pressed={lockUiActive ? 'true' : 'false'}
          aria-disabled={!canLockAspect ? 'true' : undefined}
          aria-label={lockUiActive ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
          data-tooltip={!canLockAspect ? ASPECT_LOCK_REQUIRES_FIXED_TOOLTIP : lockUiActive ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
          onClick={handleToggleLock}
        >
          {lockUiActive ? <Lock size={14} /> : <LockOpen size={14} />}
        </button>
      </div>
      {(minWidthEnabled || maxWidthEnabled || minHeightEnabled || maxHeightEnabled) && (
        <div class="cortex-layout-section__minmax">
          {minWidthEnabled && (
            <div class="cortex-layout-section__minmax-field">
              <NumericInput
                value={parseFloat(values.minWidth) || 0}
                unit="px"
                label="Min"
                tooltip="Min Width"
                min={0}
                mixed={mixedProperties?.has('min-width')}
                stale={stale}
                onChange={handleMinWidthChange}
              />
              <button
                class="cortex-layout-section__minmax-dismiss"
                type="button"
                data-tooltip="Remove Min Width"
                aria-label="Remove Min Width"
                onClick={handleToggleMinWidth}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {maxWidthEnabled && (
            <div class="cortex-layout-section__minmax-field">
              <NumericInput
                value={values.maxWidth === 'none' ? 0 : parseFloat(values.maxWidth) || 0}
                unit="px"
                label="Max"
                tooltip="Max Width"
                min={0}
                mixed={mixedProperties?.has('max-width')}
                stale={stale}
                onChange={handleMaxWidthChange}
              />
              <button
                class="cortex-layout-section__minmax-dismiss"
                type="button"
                data-tooltip="Remove Max Width"
                aria-label="Remove Max Width"
                onClick={handleToggleMaxWidth}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {minHeightEnabled && (
            <div class="cortex-layout-section__minmax-field">
              <NumericInput
                value={parseFloat(values.minHeight) || 0}
                unit="px"
                label="Min"
                tooltip="Min Height"
                min={0}
                mixed={mixedProperties?.has('min-height')}
                stale={stale}
                onChange={handleMinHeightChange}
              />
              <button
                class="cortex-layout-section__minmax-dismiss"
                type="button"
                data-tooltip="Remove Min Height"
                aria-label="Remove Min Height"
                onClick={handleToggleMinHeight}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {maxHeightEnabled && (
            <div class="cortex-layout-section__minmax-field">
              <NumericInput
                value={values.maxHeight === 'none' ? 0 : parseFloat(values.maxHeight) || 0}
                unit="px"
                label="Max"
                tooltip="Max Height"
                min={0}
                mixed={mixedProperties?.has('max-height')}
                stale={stale}
                onChange={handleMaxHeightChange}
              />
              <button
                class="cortex-layout-section__minmax-dismiss"
                type="button"
                data-tooltip="Remove Max Height"
                aria-label="Remove Max Height"
                onClick={handleToggleMaxHeight}
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      )}
      <div class={`cortex-sizing-controls__toggles${isDimmed(dimmedProperties, 'overflow', 'box-sizing') ? ' cortex-control--dimmed' : ''}`}>
        <label
          class="cortex-checkbox"
          role="checkbox"
          aria-checked={isClipped ? 'true' : 'false'}
          data-tooltip="Clip content (overflow: hidden)"
          onClick={handleClipToggle}
        >
          <span class={`cortex-checkbox__box${isClipped ? ' cortex-checkbox__box--checked' : ''}`}>
            {isClipped && <Check size={12} />}
          </span>
          <span class="cortex-checkbox__label">Clip content</span>
        </label>
        <label
          class="cortex-checkbox"
          role="checkbox"
          aria-checked={isBorderBox ? 'true' : 'false'}
          data-tooltip="Border box sizing"
          onClick={handleBoxSizingToggle}
        >
          <span class={`cortex-checkbox__box${isBorderBox ? ' cortex-checkbox__box--checked' : ''}`}>
            {isBorderBox && <Check size={12} />}
          </span>
          <span class="cortex-checkbox__label">Border box</span>
        </label>
      </div>
    </div>
  )
}
