import { isNonEditable } from './classify-non-editable.js'

export interface SelectionHandle {
  /** Remove all event listeners */
  cleanup: () => void
  /** Toggle design mode on/off (disables event interception when off) */
  setDesignMode: (enabled: boolean) => void
  /** Toggle click interception — when false, clicks pass through to host app (canvas mode) */
  setInterceptClicks: (enabled: boolean) => void
}

/** Check if an event originated from inside Cortex's own Shadow DOM. */
export function isOwnUI(event: Event): boolean {
  const path = event.composedPath()
  return path.some(
    el => el instanceof HTMLElement && el.hasAttribute('data-cortex-host'),
  )
}

/**
 * Initialize capture-phase event interception for element selection.
 *
 * Events from within Cortex's own Shadow DOM (detected via composedPath)
 * are passed through so panel interactions work normally.
 *
 * The `onSelect` callback receives an array of elements and a selection action:
 * - No modifier key → `([el], 'replace')` — replaces current selection
 * - Shift key        → `([el], 'add')` — adds element to selection
 * - Meta/Ctrl key    → `([el], 'toggle')` — toggles element in selection
 * - Click on backdrop / null target → `([], 'replace')` — clears selection
 */
export function initSelection(
  _shadowRoot: ShadowRoot,
  onHover: (el: Element | null) => void,
  onSelect: (elements: Element[], action: 'replace' | 'add' | 'toggle') => void,
): SelectionHandle {
  let designMode = true
  let interceptClicks = true

  function getTargetElement(event: MouseEvent): Element | null {
    const el = document.elementFromPoint(event.clientX, event.clientY)
    // `Element`, not `HTMLElement`: `SVGElement extends Element`, so an
    // `instanceof HTMLElement` guard rejected every SVG target. `handleClick`
    // reads null as "backdrop" and clears the selection — so clicking an icon
    // wiped your selection instead of selecting the icon. Inline SVG in the
    // user's own JSX carries `data-cortex-source` (source-transform annotates
    // every lowercase tag), so these are real, addressable targets.
    if (!el) return null
    if (el.hasAttribute('data-cortex-host') || el.hasAttribute('data-cortex-root')) return null
    if (el === document.documentElement || el === document.body) return null
    // Guards run on the ORIGINAL node, before SVG normalization below — an SVG's
    // own <style>/<title>/<script> children are in NON_VISUAL_TAGS, and
    // normalizing first would promote them to the enclosing icon and select it.
    if (isNonEditable(el)) return null
    // Clicking a multi-path icon means "the icon", not "that one path". SVG
    // shape hit-testing is sub-pixel: the same visual click lands on <path> or
    // on the SVG viewport depending on where the geometry falls, so without
    // normalization the selection is non-deterministic. It also keeps the
    // overlay on the icon's box rather than one stroke's bbox, keeps box-model
    // overrides effective, and preserves `class="lucide lucide-check"` as the
    // agent-resolve hint. Inner shapes stay reachable via Panel child-navigation
    // and the Layer Tree. `closest` includes self. HTML inside <foreignObject>
    // is not an SVGElement, so it is deliberately left alone.
    if (el instanceof SVGElement) return el.closest('svg') ?? el
    return el
  }

  // Sentinel value distinct from null — ensures first null dispatch is not deduped
  let lastHovered: Element | null | undefined = undefined

  function updateHover(el: Element | null): void {
    if (el === lastHovered) return
    lastHovered = el
    onHover(el)
  }

  function handleMouseMove(event: MouseEvent): void {
    if (!designMode) return
    if (isOwnUI(event)) {
      // Mouse is over Cortex UI — clear hover to prevent distracting overlay
      if (lastHovered !== null) {
        lastHovered = null
        onHover(null)
      }
      return
    }
    updateHover(getTargetElement(event))
  }

  function handleScroll(): void {
    if (!designMode) return
    // Clear hover on scroll — the element the user was hovering moved away.
    // Next mousemove will pick up whatever is under the cursor.
    if (lastHovered != null) {
      lastHovered = null
      onHover(null)
    }
  }

  function handleClick(event: MouseEvent): void {
    if (!designMode) return
    if (isOwnUI(event)) return
    if (!interceptClicks) return
    event.preventDefault()
    event.stopPropagation()
    const el = getTargetElement(event)
    if (!el) {
      // Backdrop / null target — clear selection
      onSelect([], 'replace')
      return
    }
    // Translate modifier keys to selection action
    let action: 'replace' | 'add' | 'toggle'
    if (event.shiftKey) {
      action = 'add'
    } else if (event.metaKey || event.ctrlKey) {
      action = 'toggle'
    } else {
      action = 'replace'
    }
    onSelect([el], action)
  }

  window.addEventListener('mousemove', handleMouseMove, { capture: true })
  window.addEventListener('click', handleClick, { capture: true })
  window.addEventListener('scroll', handleScroll, { capture: true, passive: true })

  return {
    cleanup() {
      window.removeEventListener('mousemove', handleMouseMove, { capture: true })
      window.removeEventListener('click', handleClick, { capture: true })
      window.removeEventListener('scroll', handleScroll, { capture: true })
    },
    setDesignMode(enabled: boolean) {
      designMode = enabled
    },
    setInterceptClicks(enabled: boolean) {
      interceptClicks = enabled
    },
  }
}
