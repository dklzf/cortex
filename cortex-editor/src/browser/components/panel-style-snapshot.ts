/**
 * computePanelStyleSnapshot
 *
 * Extracted in ZF0-1360 (rescope) to make the hmrAppliedVersion-triggered
 * re-read testable as a side-effect-free helper. See
 * `tests/browser/components/panel-style-snapshot.test.ts` for the unit tests;
 * the originating flaky integration test in
 * `panel.test.tsx > Panel — hmrAppliedVersion (ZF0-1292)` was deleted.
 *
 * The function is the verbatim body of Panel's
 * `useMemo(() => { ... }, [element, styleVersion, hmrAppliedVersion, activeState,
 * activePseudo, sharedInfo, editScope])` for derived `computedStyles` / `dimmedProperties` / `mixedProperties`. The deps array
 * stays identical in Panel.tsx, preserving the exact re-run-on-hmrAppliedVersion-
 * bump contract.
 */

import type { InteractionState } from '../state-detector.js'
import type { SharedClassInfo } from '../shared-class-detector.js'
import { parseLayoutValues } from './sections/LayoutSection.js'
import { makeSizingDimension, withAuthoredSize } from '../sizing-value.js'
import { parseTypographyValues } from './sections/TypographySection.js'
import { parseFillValues } from './sections/fill-utils.js'
import { parseBorderValues } from './sections/BorderSection.js'
import { parseEffectsValues } from './sections/EffectsSection.js'
import { parsePositionValues } from './sections/PositionSection.js'
import { parseAppearanceValues } from './sections/AppearanceSection.js'
import { parseSpacingValues, ALL_DIMMING_PROPERTIES } from './sections/spacing-utils.js'
import { readComputedSize, isSizeInert } from '../sizing-value.js'

/** CSS the box model gives you that SVG GEOMETRY simply does not implement.
 *
 *  `<path>`, `<circle>`, `<g>` and friends are not CSS boxes: padding, margin,
 *  border (incl. radius), background-color and box-shadow have no effect on
 *  them, and width/height apply only to rect/image and the SVG root. Before the
 *  Element widening these were unreachable, so the panel never had to say so.
 *  Now they are selectable, and without this the user scrubs a value, sees
 *  nothing move, and Apply still writes the property into their JSX — the same
 *  dead-control failure as the child-nav button.
 *
 *  Dimmed, not hidden: the panel's shape stays stable across selections, which
 *  is the existing treatment for flex-child-inert properties.
 *
 *  The SVG root element is a replaced element with a real CSS box, so it is
 *  excluded. */
const SVG_GEOMETRY_INERT_PROPERTIES: readonly string[] = [
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'background-color', 'background-image',
  'border-width', 'border-style', 'border-color', 'border-radius',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'box-shadow',
]

/** SVG2 exposes `width`/`height` as geometry PROPERTIES on these elements, so CSS
 *  sizing genuinely applies to them. Dimming those would be the same dead-control
 *  mistake in reverse — greying out a control that works. Every other SVG geometry
 *  element ignores CSS width/height. Matched on `localName`, which preserves case
 *  (`foreignObject`). The SVG root is already excluded by `isSvgGeometry`. */
const SVG_SIZING_CAPABLE_TAGS: ReadonlySet<string> = new Set(['rect', 'image', 'use', 'foreignObject'])

/** True for SVG geometry and resource containers, false for the SVG root. */
function isSvgGeometry(el: Element): boolean {
  return el instanceof SVGElement && el.localName !== 'svg'
}

export interface ComputePanelStyleSnapshotInput {
  element: Element | null
  activePseudo: 'element' | '::before' | '::after'
  activeState: InteractionState
  sharedInfo: SharedClassInfo | null
  editScope: 'instance' | 'all'
  overrideManager: { get: (source: string, prop: string, pseudo?: '::before' | '::after') => string | undefined }
  /** Snapshot of the element's default-state computed styles, captured by Panel's
   *  `defaultStylesRef`. Pass the ref's `.current` value at call time. */
  defaultStyles: Record<string, string> | null
}

export interface ComputePanelStyleSnapshotResult {
  computedStyles: {
    spacing: ReturnType<typeof parseSpacingValues>
    layout: ReturnType<typeof parseLayoutValues>
    typography: ReturnType<typeof parseTypographyValues>
    fill: ReturnType<typeof parseFillValues>
    border: ReturnType<typeof parseBorderValues>
    effects: ReturnType<typeof parseEffectsValues>
    position: ReturnType<typeof parsePositionValues>
    appearance: ReturnType<typeof parseAppearanceValues>
  }
  dimmedProperties: Set<string> | undefined
  mixedProperties: Set<string> | undefined
}

export function computePanelStyleSnapshot(input: ComputePanelStyleSnapshotInput): ComputePanelStyleSnapshotResult {
  const { element, activePseudo, activeState, sharedInfo, editScope, overrideManager, defaultStyles } = input

  if (!element) {
    return {
      computedStyles: {
        spacing: parseSpacingValues({} as CSSStyleDeclaration),
        layout: parseLayoutValues({} as CSSStyleDeclaration),
        typography: parseTypographyValues({} as CSSStyleDeclaration),
        fill: parseFillValues({} as CSSStyleDeclaration),
        border: parseBorderValues({} as CSSStyleDeclaration),
        effects: parseEffectsValues({} as CSSStyleDeclaration),
        position: parsePositionValues({} as CSSStyleDeclaration),
        appearance: parseAppearanceValues({} as CSSStyleDeclaration),
      },
      dimmedProperties: undefined as Set<string> | undefined,
      mixedProperties: undefined as Set<string> | undefined,
    }
  }
  const pseudo = activePseudo !== 'element' ? activePseudo : undefined
  const cs = getComputedStyle(element, pseudo)
  const source = element.getAttribute('data-cortex-source') ?? ''
  const layout = parseLayoutValues(cs)
  // `parseLayoutValues` reads width/height off getComputedStyle, which returns
  // the USED value in pixels — it cannot express a sizing mode at all (B5).
  // Replace both with the authored (computed) value via CSS Typed OM, which
  // reports `100%` / `fit-content` / `auto` as authored. Falls back to the used
  // value on engines without Typed OM and for pseudo-elements; see
  // sizing-value.ts for why that fallback is lossy but honest.
  // Keep the USED value too. The authored value decides the MODE; the used
  // value is the only true pixel measurement of the box, and the panel needs
  // it for two things a mode cannot supply: the number shown in the (disabled)
  // W/H field for a non-fixed element, and the width to seed when the user
  // switches that element TO Fixed. Dropping it made "switch to Fixed" write
  // `0px` and collapse the element.
  // Bind the used values BEFORE overwriting layout.width/height. `parseLayoutValues`
  // set them from getComputedStyle — the USED value, a pixel length wherever
  // width/height actually applies — and the authored values installed below
  // would otherwise clobber them. Locals rather than careful line ordering,
  // because a data dependency that exists only as statement order is one
  // "consolidate these four similar assignments" refactor away from silently
  // corrupting every non-fixed element. Raised in architecture review.
  // COR-6: one constructor call per axis, so the authored value and the used
  // value cannot be set apart. The old shape needed the two locals below to be
  // bound BEFORE the authored values overwrote layout.width/height — a data
  // dependency that existed only as statement order, and one "consolidate these
  // similar assignments" refactor away from silently corrupting every non-fixed
  // element. Passing both into one call removes the ordering hazard entirely.
  layout.width = makeSizingDimension(readComputedSize(element, 'width', pseudo), layout.width.authored)
  layout.height = makeSizingDimension(readComputedSize(element, 'height', pseudo), layout.height.authored)
  // Cortex's own staged override still wins: it is the value the user just
  // asked for and has not yet been applied to source, so it is more current
  // than anything the cascade can report. This special case predates the Typed
  // OM read and is now narrow rather than load-bearing — before, it was the
  // ONLY way any keyword mode ever reached the panel.
  const widthOverride = overrideManager.get(source, 'width', pseudo)
  const heightOverride = overrideManager.get(source, 'height', pseudo)
  // An override replaces the AUTHORED value only; the measurement is still the
  // real box, which has not moved yet — the override is what the user just
  // asked for and source has not caught up with.
  if (widthOverride !== undefined) layout.width = withAuthoredSize(layout.width, widthOverride)
  if (heightOverride !== undefined) layout.height = withAuthoredSize(layout.height, heightOverride)

  const parsed = {
    spacing: parseSpacingValues(cs),
    layout,
    typography: parseTypographyValues(cs),
    fill: parseFillValues(cs),
    border: parseBorderValues(cs),
    effects: parseEffectsValues(cs),
    position: parsePositionValues(cs),
    appearance: parseAppearanceValues(cs),
  }
  // Self-alignment (align-self/justify-self) gating needs the LAYOUT
  // parent's computed display — not the element's. For real DOM elements
  // the layout parent is element.parentElement. For ::before/::after
  // pseudo-elements (pseudo is set), the pseudo is laid out as a child
  // of its ORIGINATING element, so use `element` itself — otherwise a
  // pseudo on a flex/grid container appears as if its parent were the
  // originating element's DOM parent, and the self-alignment controls
  // hide spuriously (or show as dead controls in the reverse case).
  // Caught by codex review on the Position QOL PR.
  //
  // parentFlexDirection drives parent-aware icon/label selection in
  // PositionSection (align-self cross-axis depends on it for flex
  // parents). Read it from the same layoutParent so the pseudo logic
  // carries through.
  const layoutParent = pseudo ? element : element.parentElement
  if (layoutParent) {
    const parentCs = getComputedStyle(layoutParent)
    parsed.position.parentDisplay = parentCs.display ?? 'block'
    parsed.position.parentFlexDirection = parentCs.flexDirection ?? 'row'
    // LayoutSection mirrors the parentDisplay read so the display
    // SegmentedControl can disable the 'inline' option when CSS would
    // blockify it (flex/grid child) — same underlying signal, different
    // consumer.
    parsed.layout.parentDisplay = parentCs.display ?? 'block'
  }
  // Tag name drives widget-coercion detection in LayoutSection ('inline'
  // is a no-op on button/input/select/etc. per HTML UA stylesheet).
  //
  // Pseudo-elements (::before/::after) are NOT subject to widget
  // coercion — they're generated boxes, not the form control. Their
  // computed display for `inline` value is honored normally. So we
  // leave tagName empty for pseudo-element snapshots, which makes
  // WIDGET_TAGS.has('') return false and the inline option stay
  // enabled. The remaining gate (parent flex/grid blockification) is
  // still applied via parentDisplay. Caught by codex review on PR #162.
  parsed.layout.tagName = pseudo ? '' : element.tagName.toLowerCase()
  // Per CSS spec §8.5.3, getComputedStyle zeroes border-width when
  // border-style is 'none' or 'hidden' — which breaks the existence/
  // visibility split used by summarizeBorder. A user-hidden border (via
  // the eye toggle) would summarize as 'none' and the section would
  // collapse, making "hide" indistinguishable from "delete". Same remedy
  // as the width/height override pattern above: prefer the raw override-
  // manager value over getComputedStyle when an override exists. The eye
  // toggle handler in BorderSection snapshots all 5 width overrides
  // before it flips style to 'hidden', so the override store has the
  // specified widths available to recover here.
  for (const [property, field] of [
    ['border-width', 'borderWidth'],
    ['border-top-width', 'borderTopWidth'],
    ['border-right-width', 'borderRightWidth'],
    ['border-bottom-width', 'borderBottomWidth'],
    ['border-left-width', 'borderLeftWidth'],
  ] as const) {
    const raw = overrideManager.get(source, property, pseudo)
    if (raw !== undefined) {
      parsed.border[field] = parseFloat(raw) || 0
    }
  }
  let dimmed: Set<string> | undefined
  if (activeState !== 'default' && defaultStyles) {
    dimmed = new Set<string>()
    const defaultCs = pseudo ? getComputedStyle(element) : cs
    if (typeof defaultCs.getPropertyValue === 'function') {
      for (const prop of ALL_DIMMING_PROPERTIES) {
        if (defaultCs.getPropertyValue(prop) !== defaultStyles[prop]) dimmed.add(prop)
      }
    }
  }

  // Compare computed styles across shared elements when editing "All" scope.
  // Properties where siblings differ from the selected element are "mixed".
  let mixed: Set<string> | undefined
  if (sharedInfo && editScope === 'all') {
    mixed = new Set<string>()
    for (const sibling of sharedInfo.elements) {
      if (sibling === element) continue
      const siblingCs = getComputedStyle(sibling, pseudo)
      for (const prop of ALL_DIMMING_PROPERTIES) {
        if (mixed.has(prop)) continue
        if (cs.getPropertyValue(prop) !== siblingCs.getPropertyValue(prop)) {
          mixed.add(prop)
        }
      }
    }
    if (mixed.size === 0) mixed = undefined
  }

  // Same dead-control treatment for elements where width/height simply do not
  // apply. MEASURED: setting `width: 300px` then `40px` on a non-replaced inline
  // left its rendered width at 73.33px both times. Worse, once a pixel width has
  // been written `getComputedStyle().width` echoes it back, so the element then
  // classifies as `fixed` with an ENABLED input — a control the user can scrub
  // forever with nothing ever moving. Dimming is the existing remedy for exactly
  // this shape of problem.
  if (element && !pseudo && isSizeInert(element)) {
    dimmed = new Set([...(dimmed ?? []), 'width', 'height'])
  }

  // Merge in the properties SVG geometry cannot honour. Done here rather than by
  // gating whole sections so it rides the existing per-control dimming treatment.
  if (element && isSvgGeometry(element)) {
    const inert = SVG_SIZING_CAPABLE_TAGS.has(element.localName)
      ? SVG_GEOMETRY_INERT_PROPERTIES
      : [...SVG_GEOMETRY_INERT_PROPERTIES, 'width', 'height']
    dimmed = new Set([...(dimmed ?? []), ...inert])
  }

  return { computedStyles: parsed, dimmedProperties: dimmed, mixedProperties: mixed }
}
