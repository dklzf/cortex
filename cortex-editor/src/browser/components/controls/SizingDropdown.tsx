import type { JSX } from 'preact'
import { useState, useRef, useCallback, useEffect } from 'preact/hooks'
import { computePosition, flip, shift } from '@floating-ui/dom'
import { Check, ChevronDown } from '../icons.js'

// Re-exported for existing importers. The type now lives with the classifier
// that produces it (a pure module a component should not own).
export type { SizingMode } from '../../sizing-value.js'
import type { SizingMode } from '../../sizing-value.js'

export interface SizingDropdownProps {
  mode: SizingMode
  minEnabled: boolean
  maxEnabled: boolean
  onModeChange: (mode: SizingMode) => void
  onToggleMin: () => void
  onToggleMax: () => void
  dimension?: string
}

const MODE_LABELS: Record<SizingMode, string> = {
  fixed: 'px',
  fit: 'fit',
  fill: 'fill',
  auto: 'auto',
  custom: 'custom',
}

const MODE_DISPLAY: Record<SizingMode, string> = {
  fixed: 'Fixed (px)',
  fit: 'Fit contents',
  fill: 'Fill container',
  auto: 'Auto (browser decides)',
  custom: 'Custom value',
}

/** Modes a user can SELECT. Deliberately narrower than SizingMode: `auto` and
 *  `custom` are states an element can be IN but not states you can switch TO.
 *  "Make this auto" is not a coherent instruction, and `custom` covers values
 *  (calc(), 50%, clamp()) the panel reports faithfully but has no control for.
 *  Both still render as the trigger label so the current state is never a lie. */
const MODES: SizingMode[] = ['fixed', 'fit', 'fill']

/**
 * Purpose-built dropdown for dimension sizing modes.
 *
 * Business logic: Controls how a selected element's width/height is determined.
 * "fixed" uses explicit pixel values, "fit" sizes to content, "fill" sizes to
 * parent container. The min/max toggles enable constraint bounds on the dimension.
 *
 * Unlike the generic Dropdown, this has mixed radio + toggle (checkbox) behavior:
 * selecting a mode closes the menu, while toggling min/max keeps it open so the
 * user can enable both in one interaction.
 */
export function SizingDropdown({
  mode,
  minEnabled,
  maxEnabled,
  onModeChange,
  onToggleMin,
  onToggleMax,
  dimension = 'Width',
}: SizingDropdownProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Position menu when opened — same pattern as Dropdown.tsx
  useEffect(() => {
    if (!isOpen || !triggerRef.current || !menuRef.current) return
    let cancelled = false
    const trigger = triggerRef.current
    const menu = menuRef.current
    menu.style.width = `${Math.max(trigger.offsetWidth, 140)}px`
    computePosition(trigger, menu, {
      placement: 'bottom-start',
      middleware: [flip(), shift()],
    }).then(({ x, y }) => {
      if (!cancelled && menuRef.current) {
        menuRef.current.style.left = `${x}px`
        menuRef.current.style.top = `${y}px`
      }
    }).catch(() => {
      if (!cancelled && triggerRef.current && menuRef.current) {
        const rect = trigger.getBoundingClientRect()
        menuRef.current.style.left = `${rect.left}px`
        menuRef.current.style.top = `${rect.bottom}px`
      }
    })
    return () => { cancelled = true }
  }, [isOpen])

  const open = useCallback(() => { setIsOpen(true) }, [])
  const close = useCallback(() => { setIsOpen(false) }, [])

  const handleModeClick = useCallback(
    (m: SizingMode) => {
      onModeChange(m)
      close()
    },
    [onModeChange, close],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    },
    [close],
  )

  return (
    <div class="cortex-sizing">
      <button
        ref={triggerRef}
        class="cortex-sizing-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen ? 'true' : 'false'}
        onClick={isOpen ? close : open}
      >
        <span class="cortex-sizing-trigger__label">{MODE_LABELS[mode]}</span>
        <span class={`cortex-sizing-trigger__chevron${isOpen ? ' cortex-sizing-trigger__chevron--open' : ''}`}>
          <ChevronDown size={10} />
        </span>
      </button>
      {isOpen && (
        <>
          <div class="cortex-sizing-backdrop" onClick={close} />
          <div
            ref={menuRef}
            class="cortex-sizing-menu"
            role="menu"
            style={{ position: 'fixed' }}
            onKeyDown={handleKeyDown}
          >
            {MODES.map((m) => (
              <div
                key={m}
                class={[
                  'cortex-sizing-menu__item',
                  m === mode && 'cortex-sizing-menu__item--active',
                ]
                  .filter(Boolean)
                  .join(' ')}
                role="menuitemradio"
                aria-checked={m === mode ? 'true' : 'false'}
                data-value={m}
                onClick={() => handleModeClick(m)}
              >
                <span class={`cortex-sizing-menu__radio${m === mode ? ' cortex-sizing-menu__radio--active' : ''}`} />
                {MODE_DISPLAY[m]}
              </div>
            ))}
            <div class="cortex-sizing-menu__separator" />
            <div
              class={[
                'cortex-sizing-menu__item',
                'cortex-sizing-menu__item--toggle',
                minEnabled && 'cortex-sizing-menu__item--checked',
              ]
                .filter(Boolean)
                .join(' ')}
              role="menuitemcheckbox"
              aria-checked={minEnabled ? 'true' : 'false'}
              data-action="toggle-min"
              onClick={onToggleMin}
            >
              <span class="cortex-sizing-menu__indicator">
                {minEnabled && <Check size={12} />}
              </span>
              Add Min {dimension}
            </div>
            <div
              class={[
                'cortex-sizing-menu__item',
                'cortex-sizing-menu__item--toggle',
                maxEnabled && 'cortex-sizing-menu__item--checked',
              ]
                .filter(Boolean)
                .join(' ')}
              role="menuitemcheckbox"
              aria-checked={maxEnabled ? 'true' : 'false'}
              data-action="toggle-max"
              onClick={onToggleMax}
            >
              <span class="cortex-sizing-menu__indicator">
                {maxEnabled && <Check size={12} />}
              </span>
              Add Max {dimension}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
