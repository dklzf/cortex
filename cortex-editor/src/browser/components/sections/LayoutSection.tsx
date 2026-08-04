/**
 * LayoutSection — Panel v2 Task 10 (ZF0-1188)
 *
 * Thin orchestrator (~150 LOC) that routes display state to child
 * sub-controls: FlexControls (Task 8), GridControls (Task 9),
 * SizingControls and SpacingControls (this task).
 *
 * Business logic: This section controls the CSS layout model (display,
 * visibility), delegates flex/grid configuration to specialized
 * sub-controls, and hosts sizing (width/height) and spacing
 * (padding/margin) sub-controls. All CSS changes flow through the
 * single onChange callback to the Panel's override system.
 */
import type { JSX } from 'preact'
import { useCallback } from 'preact/hooks'
import { isDimmed } from './types.js'
import type { SectionChange } from './types.js'
import { SegmentedControl } from '../controls/SegmentedControl.js'
import { FlexControls } from './FlexControls.js'
import type { FlexValues, FlexChange } from './FlexControls.js'
import { GridControls } from './GridControls.js'
import type { GridValues, GridChange } from './GridControls.js'
import { SizingControls } from './SizingControls.js'
import { SpacingControls } from './SpacingControls.js'

export type LayoutChange = SectionChange

export interface LayoutValues {
  display: string
  visibility: string
  flexDirection: string
  justifyContent: string
  alignItems: string
  rowGap: number
  columnGap: number
  flexWrap: string
  gridTemplateColumns: string
  gridTemplateRows: string
  gridAutoFlow: string
  justifyItems: string
  width: string
  height: string
  /** Used (rendered) pixel size, from getComputedStyle. `width`/`height` carry
   *  the AUTHORED value and so may be `100%` / `fit-content` / `auto`, which
   *  are not measurements. Optional: callers that only have computed styles
   *  (tests, the empty-selection snapshot) may omit it. */
  widthUsed?: string
  heightUsed?: string
  minWidth: string
  maxWidth: string
  minHeight: string
  maxHeight: string
  overflow: string
  boxSizing: string
  /** Selected element's tag name, lowercase. Used to detect HTML widgets
   *  (button/input/select/textarea/etc.) whose user-agent stylesheet
   *  coerces `display: inline` to `inline-block`, making the panel's
   *  "inline" option silently no-op. Empty string when unknown. */
  tagName: string
  /** Parent element's computed `display`. When parent is flex/grid, CSS
   *  blockifies any child's `display: inline` to `display: block` per
   *  Flexbox §4 and Grid §3.4 — the inline option is also a no-op. */
  parentDisplay: string
}

export interface LayoutSectionProps {
  values: LayoutValues
  onChange: (change: LayoutChange) => void
  onScrub?: (change: LayoutChange) => void
  onScrubEnd?: (change: LayoutChange) => void
  /** Set of CSS properties that changed in the forced state. When present, unchanged properties are dimmed. */
  dimmedProperties?: Set<string>
  /** Set of CSS properties whose values differ across selected elements. */
  mixedProperties?: Set<string>
  /** Spacing data (passed from Panel.tsx, forwarded to SpacingControls). */
  spacing?: {
    padding: { top: number; right: number; bottom: number; left: number }
    margin: { top: number; right: number; bottom: number; left: number }
  }
  onSpacingChange?: (change: LayoutChange) => void
  onSpacingScrub?: (change: LayoutChange) => void
  onSpacingScrubEnd?: (change: LayoutChange) => void
  /**
   * When true, the element's source override has exceeded the TTL without hmr_verified
   * arriving. Forwarded to SizingControls and SpacingControls which thread it to their
   * NumericInput controls as the stale indicator (orange/yellow tint + recovery tooltip).
   */
  stale?: boolean
}

/** Normalize computed display values to SegmentedControl options. */
function normalizeDisplay(display: string): string {
  if (display === 'inline-flex') return 'flex'
  if (display === 'inline-grid') return 'grid'
  if (display === 'inline-block') return 'block'
  return display
}

/** Extract layout-related values from a CSSStyleDeclaration. */
export function parseLayoutValues(cs: CSSStyleDeclaration): LayoutValues {
  return {
    display: normalizeDisplay(cs.display ?? 'block'),
    visibility: cs.visibility ?? 'visible',
    flexDirection: cs.flexDirection || 'row',
    justifyContent: cs.justifyContent || 'flex-start',
    alignItems: cs.alignItems || 'stretch',
    rowGap: parseFloat(cs.rowGap || '0') || 0,
    columnGap: parseFloat(cs.columnGap || '0') || 0,
    flexWrap: cs.flexWrap || 'nowrap',
    gridTemplateColumns: cs.gridTemplateColumns || 'none',
    gridTemplateRows: cs.gridTemplateRows || 'none',
    gridAutoFlow: cs.gridAutoFlow || 'row',
    justifyItems: cs.justifyItems || 'stretch',
    width: cs.width ?? 'auto',
    height: cs.height ?? 'auto',
    minWidth: cs.minWidth ?? '0px',
    maxWidth: cs.maxWidth ?? 'none',
    minHeight: cs.minHeight ?? '0px',
    maxHeight: cs.maxHeight ?? 'none',
    overflow: cs.overflow ?? 'visible',
    boxSizing: cs.boxSizing ?? 'content-box',
    tagName: '',
    parentDisplay: 'block',
  }
}

/** HTML form-widget tags whose user-agent stylesheet coerces
 *  `display: inline` into `display: inline-block` (which the panel's
 *  normalizeDisplay maps back to "block"). For these the inline option
 *  is a no-op, so the panel disables it.
 *
 *  Replaced/media elements (img/video/canvas/iframe/embed/object) are
 *  INTENTIONALLY excluded — they're atomic-inline by default and
 *  display:inline is a valid edit on them (verified live: each computes
 *  to "inline" when set, not coerced). Including them here would block
 *  legitimate "switch back to inline" edits — caught by codex review on
 *  PR #162. */
const WIDGET_TAGS: ReadonlySet<string> = new Set([
  'button', 'input', 'select', 'textarea',
  'progress', 'meter',
])

/** Whether `display: inline` would actually take effect on this element.
 *  Returns false when:
 *    - parent is flex/grid (CSS blockification per Flexbox §4 / Grid §3.4)
 *    - tag is an HTML widget (UA stylesheet coercion to inline-block)
 *  In either case clicking "inline" silently no-ops; the panel disables
 *  the option with an explanatory tooltip rather than letting the user
 *  click into a black hole. */
export function inlineDisplayApplies(values: Pick<LayoutValues, 'tagName' | 'parentDisplay'>): boolean {
  if (WIDGET_TAGS.has(values.tagName)) return false
  if (values.parentDisplay.includes('flex')) return false
  if (values.parentDisplay.includes('grid')) return false
  return true
}

function buildDisplayOptions(values: Pick<LayoutValues, 'tagName' | 'parentDisplay'>) {
  const inlineEnabled = inlineDisplayApplies(values)
  const inlineDisabledReason = !inlineEnabled
    ? WIDGET_TAGS.has(values.tagName)
      ? `<${values.tagName}> elements coerce display:inline to inline-block (HTML widget UA stylesheet) — no visible change`
      : `Parent is ${values.parentDisplay}; flex/grid children blockify display:inline to block (CSS spec) — no visible change`
    : undefined
  return [
    { value: 'block', label: 'block' },
    { value: 'flex', label: 'flex' },
    { value: 'grid', label: 'grid' },
    {
      value: 'inline',
      label: 'inline',
      disabled: !inlineEnabled,
      disabledTooltip: inlineDisabledReason,
    },
    { value: 'none', label: 'none' },
  ]
}

export function LayoutSection({
  values,
  onChange,
  onScrub,
  onScrubEnd,
  dimmedProperties,
  mixedProperties,
  spacing,
  onSpacingChange,
  onSpacingScrub,
  onSpacingScrubEnd,
  stale,
}: LayoutSectionProps): JSX.Element {
  const isFlex = values.display === 'flex'
  const isGrid = values.display === 'grid'
  const isNone = values.display === 'none'

  const handleDisplayChange = useCallback(
    (v: string) => onChange({ property: 'display', value: v }),
    [onChange],
  )

  // FlexChange and GridChange are structurally identical to LayoutChange
  // (`{ property, value }`), so the parent callbacks pass through unchanged.
  const handleFlexChange: (c: FlexChange) => void = onChange
  const handleFlexScrub: ((c: FlexChange) => void) | undefined = onScrub
  const handleFlexScrubEnd: ((c: FlexChange) => void) | undefined = onScrubEnd
  const handleGridChange: (c: GridChange) => void = onChange
  const handleGridScrub: ((c: GridChange) => void) | undefined = onScrub
  const handleGridScrubEnd: ((c: GridChange) => void) | undefined = onScrubEnd

  // Build explicit subsets for sub-controls (compile-time safety).
  const flexValues: FlexValues = {
    flexDirection: values.flexDirection,
    justifyContent: values.justifyContent,
    alignItems: values.alignItems,
    rowGap: values.rowGap,
    columnGap: values.columnGap,
    flexWrap: values.flexWrap,
  }
  const gridValues: GridValues = {
    gridTemplateColumns: values.gridTemplateColumns,
    gridTemplateRows: values.gridTemplateRows,
    gridAutoFlow: values.gridAutoFlow,
    justifyItems: values.justifyItems,
    alignItems: values.alignItems,
    rowGap: values.rowGap,
    columnGap: values.columnGap,
  }

  return (
    <div class="cortex-layout-section" data-section-id="layout">
      <div class={`cortex-layout-section__group${isDimmed(dimmedProperties, 'display') ? ' cortex-control--dimmed' : ''}`}>
        <SegmentedControl
          options={buildDisplayOptions(values)}
          value={values.display}
          onChange={handleDisplayChange}
          mixed={mixedProperties?.has('display')}
        />
      </div>

      {isFlex && (
        <div class="cortex-layout-section__group cortex-layout-section__reveal">
          <FlexControls
            values={flexValues}
            onChange={handleFlexChange}
            onScrub={handleFlexScrub}
            onScrubEnd={handleFlexScrubEnd}
            dimmedProperties={dimmedProperties}
            mixedProperties={mixedProperties}
          />
        </div>
      )}

      {isGrid && (
        <div class="cortex-layout-section__group cortex-layout-section__reveal">
          <GridControls
            values={gridValues}
            onChange={handleGridChange}
            onScrub={handleGridScrub}
            onScrubEnd={handleGridScrubEnd}
            dimmedProperties={dimmedProperties}
            mixedProperties={mixedProperties}
          />
        </div>
      )}

      {!isNone && (
        <div class="cortex-layout-section__group">
          <SizingControls
            values={{
              width: values.width,
              height: values.height,
              widthUsed: values.widthUsed,
              heightUsed: values.heightUsed,
              minWidth: values.minWidth,
              maxWidth: values.maxWidth,
              minHeight: values.minHeight,
              maxHeight: values.maxHeight,
              overflow: values.overflow,
              boxSizing: values.boxSizing,
            }}
            onChange={onChange}
            onScrub={onScrub}
            onScrubEnd={onScrubEnd}
            dimmedProperties={dimmedProperties}
            mixedProperties={mixedProperties}
            stale={stale}
          />
        </div>
      )}

      {!isNone && spacing && onSpacingChange && (
        <div class="cortex-layout-section__group">
          <SpacingControls
            padding={spacing.padding}
            margin={spacing.margin}
            onChange={onSpacingChange}
            onScrub={onSpacingScrub}
            onScrubEnd={onSpacingScrubEnd}
            dimmedProperties={dimmedProperties}
            mixedProperties={mixedProperties}
            stale={stale}
          />
        </div>
      )}
    </div>
  )
}
