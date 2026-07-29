import type { JSX } from 'preact'
import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks'
import type { CSSOverrideManager } from '../override.js'
import { onOverrideChange } from '../override-bus.js'
import { CommandStack } from '../command-stack.js'
import { PropertyEditCommand, CompoundEditCommand } from '../edit-command.js'
import type { PropertyChange } from '../edit-command.js'
import { parseCortexSource, isLibraryComponent, findUserAncestor } from '../label.js'
import { PANEL_WIDTH } from '../hooks/useSnapToEdge.js'
import { classAttr } from '../class-attr.js'
import { isNonEditable } from '../classify-non-editable.js'
import { extractUtilities } from '../class-extractor.js'
import { PanelHeader } from './PanelHeader.js'
import { ElementTree } from './sections/ElementTree.js'
import { DEFAULT_LAYER_HEIGHT, MIN_LAYER_HEIGHT } from './LayerTree.js'
import type { SectionChange } from './sections/types.js'
import { LayoutSection } from './sections/LayoutSection.js'
import {
  TypographySection,
  getWeightsForFamily,
  stripCSSQuotes,
  TYPOGRAPHY_LINKED_PROPERTIES,
  COLOR_LINKED_PROPERTIES,
} from './sections/TypographySection.js'
import { summarizeFill } from './sections/fill-utils.js'
import { BorderSection, summarizeBorder, type BorderChange } from './sections/BorderSection.js'
import { EffectsSection, addShadow } from './sections/EffectsSection.js'
import { PositionSection } from './sections/PositionSection.js'
import { AppearanceSection } from './sections/AppearanceSection.js'
import type { InteractionState } from '../state-detector.js'
import { detectSharedClasses } from '../shared-class-detector.js'
import type { SharedClassInfo } from '../shared-class-detector.js'
import { detectSharedSource } from '../shared-source-detector.js'
import type { SharedSourceInfo } from '../shared-source-detector.js'
import { EditErrorCard } from './EditErrorCard.js'
import type { EditError } from './EditErrorCard.js'
import { SectionGroup } from './SectionGroup.js'
import { IconButton } from './controls/IconButton.js'
import { BackgroundSection, type BackgroundChange } from './sections/BackgroundSection.js'
import { ChevronDown, ChevronUp, Eye, EyeOff, Plus, X } from './icons.js'
import type { CortexChannel, ConnectionDisplay } from '../../adapters/types.js'
import { computePanelStyleSnapshot } from './panel-style-snapshot.js'
import { ALL_DIMMING_PROPERTIES } from './sections/spacing-utils.js'
import type { PendingEdit, StagingBufferHandle } from '../hooks/useEditStagingBuffer.js'
import { generateId } from '../uuid.js'
import { StagingDriftBanner } from './StagingDriftBanner.js'
import { SpacingTokensContext } from '../tokens/TokenContext.js'
import { deepQueryAllElements } from '../selection-metadata.js'
import { resolveTypographyAlignmentEdits } from '../alignment-router.js'
import { getElementEditTarget } from '../preview-source.js'
import type { ElementEditTarget } from '../preview-source.js'

// ── Connection status footer ─────────────────────────────────────────

function connectionStatusText(status: ConnectionDisplay): string {
  switch (status.status) {
    case 'reconnecting':
      return `Reconnecting\u2026 (${status.retryCount}/${status.maxRetries})`
    case 'disconnected':
      return 'Disconnected \u2014 edits won\u2019t save to files'
    case 'reconnected':
      return 'Reconnected'
    case 'connected':
      return ''
    default: {
      const _: never = status
      return _
    }
  }
}

/** Connection-status footer. Exported for direct-render leaf testing. */
export function ConnectionStatusFooter({ status }: { status?: ConnectionDisplay }): JSX.Element {
  // aria-live regions must exist in DOM BEFORE content is injected —
  // screen readers observe mutations to existing regions, not newly inserted ones.
  // Always render the container; gate only the visible content.
  if (!status || status.status === 'connected') {
    return <div class="cortex-connection-status cortex-connection-status--hidden" role="status" aria-live="polite" aria-atomic="true" />
  }
  return (
    <div
      class={`cortex-connection-status cortex-connection-status--${status.status}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span class="cortex-connection-status__dot" aria-hidden="true" />
      <span class="cortex-connection-status__text">
        {connectionStatusText(status)}
      </span>
    </div>
  )
}

// ── Blast-radius highlight utilities ──────────────────────────────────
// These operate on the REAL page DOM (outside Shadow DOM) via a data attribute.
// A <style> injected into the page <head> provides the visual treatment; the
// attribute toggle is batched inside requestAnimationFrame to prevent layout thrashing.

const HIGHLIGHT_ATTR = 'data-cortex-blast-radius'

function pendingEditTargetFields(target: ElementEditTarget): Partial<PendingEdit> {
  if (target.applyMode === 'direct') return {}
  return {
    applyMode: target.applyMode,
    sourceResolutionHint: target.sourceResolutionHint,
  }
}

function editSourcesForElements(elements: readonly Element[]): string[] {
  return elements.map(el => getElementEditTarget(el).source)
}

function ensureBlastRadiusStyle(): void {
  // Query DOM instead of module-level ref — survives Vite HMR module re-execution
  if (document.head.querySelector('[data-cortex-blast-radius-style]')) return
  const style = document.createElement('style')
  style.setAttribute('data-cortex-blast-radius-style', '')
  style.textContent = `[${HIGHLIGHT_ATTR}] { outline: 2px dashed #f97316 !important; outline-offset: 2px !important; }`
  document.head.appendChild(style)
}

let highlightFrame = 0
let clearFrame = 0

function highlightSharedElements(info: SharedClassInfo | SharedSourceInfo, selected: Element | null): void {
  ensureBlastRadiusStyle()
  cancelAnimationFrame(clearFrame)
  cancelAnimationFrame(highlightFrame)
  highlightFrame = requestAnimationFrame(() => {
    for (const el of info.elements) {
      if (el === selected) continue
      if (!el.isConnected) continue
      el.setAttribute(HIGHLIGHT_ATTR, '')
    }
  })
}

function clearHighlights(): void {
  cancelAnimationFrame(highlightFrame)
  cancelAnimationFrame(clearFrame)
  clearFrame = requestAnimationFrame(() => {
    // Use deep, Element-typed traversal so highlights set on:
    //   (a) shadow-hosted nodes (document.querySelectorAll doesn't pierce
    //       shadow boundaries — would leak the attribute), and
    //   (b) non-HTMLElement nodes (SVG / MathML / other namespaced siblings
    //       that highlightSharedElements may have set the attribute on via
    //       SharedClassInfo.elements — deepQueryAllElements is Element-typed,
    //       filter would silently skip these and orphan the attribute)
    // are both cleared symmetrically.
    for (const el of deepQueryAllElements(`[${HIGHLIGHT_ATTR}]`)) {
      el.removeAttribute(HIGHLIGHT_ATTR)
    }
  })
}

function removeBlastRadiusStyle(): void {
  document.head.querySelector('[data-cortex-blast-radius-style]')?.remove()
}


/**
 * True when `element` has at least one non-empty (trimmed) `TEXT_NODE` child.
 *
 * Used by Panel v2 to decide whether to render the Typography section group:
 * only elements that directly render text are typography-relevant. Pure
 * container elements (whose only children are other elements) don't have
 * font/color decisions to make — those live on the descendant text elements
 * themselves. An element with `<span>` + `'Some text'` mixed children returns
 * `true` because it still renders a text node (even nested inside a span).
 *
 * Form inputs are always typography-sensitive (they render user text
 * via browser internals, even without text-node children).
 */
const TYPOGRAPHY_ELEMENTS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

// 15-property watch-list for multi-select mixed-state detection (ZF0-1195 / T3).
// Declared at module scope so the array is allocated once, not per render.
const MULTI_SELECT_WATCHED_PROPERTIES = [
  'color', 'background-color', 'font-family', 'font-size', 'font-weight',
  'line-height', 'letter-spacing', 'padding', 'margin', 'border-radius',
  'box-shadow', 'opacity', 'display', 'flex-direction', 'gap',
] as const

export function hasTypographyContent(element: Element): boolean {
  if (TYPOGRAPHY_ELEMENTS.has(element.tagName)) return true
  return (element.textContent ?? '').trim() !== ''
}

export interface PanelProps {
  /** Selected elements; `selectedElements[0]` is the primary for all CSS parsing.
   *  Empty array means no selection. (ZF0-1195 / T3) */
  selectedElements: Element[]
  overrideManager: CSSOverrideManager
  onClose: () => void
  onSelectElement: (el: Element | null) => void
  onSelectElements?: (elements: Element[], action: 'replace' | 'add' | 'toggle') => void
  swatches?: string[]
  /** Design-system text-component bundles (size + line-height + letter-spacing + weight).
   *  Resolved once per dev-server lifetime; `undefined` = not yet received; `[]` = none defined. */
  textComponents?: import('../../core/text-components.js').TextComponent[]
  /** Design-system named color chips (token name + browser-ready hex). */
  colorChips?: Array<{ name: string; hex: string; aliases?: string[]; source?: 'page' | 'theme' }>
  /** Spacing tokens detected by TailwindResolver (Tailwind v3/v4 + CSS variables).
   *  `undefined` = not yet received; `[]` = none detected. Sourced from cortex-app
   *  reducer state — populated by the `hello` handshake at boot. */
  spacingTokens?: readonly import('../../core/tailwind-resolver.js').SpacingToken[]

  activeState?: InteractionState
  hasBefore?: boolean
  hasAfter?: boolean
  hoverEnabled?: boolean
  onToggleHover?: () => void
  position: { x: number; y: number }
  isSnapping: boolean
  panelPointerDown: (e: PointerEvent) => void
  panelPointerMove: (e: PointerEvent) => void
  panelPointerUp: (e: PointerEvent) => void
  panelPointerCancel: (e: PointerEvent) => void
  commandStack?: CommandStack | null
  /** Ref written by Panel — CortexApp calls it to flush pending coalesced commits
   *  before undo (microtask commits haven't fired yet when blur+undo runs synchronously). */
  flushCommitRef?: { current: (() => void) | null }
  /** TEST-ONLY ref written by Panel — allows the e2e test bridge to directly
   *  append a PendingEdit to the staging buffer without going through the scrub UI.
   *  Only populated when __CORTEX_TEST_BUILD__ is true (DCE'd from prod bundles).
   *  Follows the same thunk pattern as flushCommitRef. Returns the intentId so
   *  specs can pass it to staged-edits-discard messages. */
  stageEditRef?: { current: ((source: string, property: string, value: string) => string) | null }
  /** TEST-ONLY ref written by Panel — allows the e2e test bridge to trigger a full
   *  commit gesture (applyOverride → commitScrub → commandStack.record + buffer.append)
   *  on the currently selected elements without going through the scrub UI.
   *  Only populated when __CORTEX_TEST_BUILD__ is true (DCE'd from prod bundles).
   *  Returns a Promise that resolves after the microtask-coalesced commitScrub fires. */
  commitEditRef?: { current: ((property: string, value: string) => Promise<void>) | null }
  /** Set by CortexApp during undo/redo — suppresses phantom re-edits from Panel re-renders. */
  undoInProgressRef?: { current: boolean }
  channel?: CortexChannel
  agentConnected?: boolean
  connectionStatus?: ConnectionDisplay
  editErrors?: Map<string, EditError>
  onEditDispatch?: (editId: string, source: string, property: string, value: string) => void
  onDismissError?: (key: string) => void
  /** Monotonic counter bumped by CortexApp on every `hmr-applied` message
   *  (ZF0-1292). Forces a getComputedStyle re-read and shared-class re-detect,
   *  covering out-of-band source edits that don't mutate the selected
   *  element's own class/style attributes — stylesheet rule changes, @theme
   *  token changes, and ancestor cascade changes — which the
   *  MutationObserver cannot see.
   *
   *  Required (not optional): forgetting to pass it leaves the Panel silently
   *  unable to react to HMR. Architecture review flagged the original
   *  optional signature as a silent-failure hazard for future integration
   *  sites. Tests must pass `hmrAppliedVersion={0}` explicitly. */
  hmrAppliedVersion: number
  /** Monotonic counter bumped on EVERY `hmr-applied` event, regardless of
   *  shouldRefreshOnHMR() (ZF0-1470 T4 fix-up, IMPORTANT 1). Panel's buffer
   *  reconcile effect uses this dep — not hmrAppliedVersion — so buffered
   *  intents for non-selected elements are re-evaluated when their source
   *  files change. hmrAppliedVersion is selection-aware; hmrEventVersion is
   *  always-bump so reconcile fires for ALL buffered intents. */
  hmrEventVersion?: number
  /** Files reported by the latest `hmr-applied` message (ZF0-1470).
   *  Empty array when the message carried no files or files was absent.
   *  Panel uses this to call buffer.reconcile() with the override-bypass
   *  readSourceValue callback — producing intentDriftCount for the banner. */
  hmrChangedFiles?: string[]
  /** Count of CSS override entries that have exceeded the TTL without
   *  hmr_verified arriving. Drives the stale-overrides row in StagingDriftBanner.
   *  Sourced from CSSOverrideManager.onStale (ZF0-1470 T1 API). */
  staleOverrideCount?: number
  /** Source strings (path:line:col) whose overrides have gone stale.
   *  Used to compute per-element stale indicators on section controls. */
  staleSources?: Set<string>
  /** Buffer lifetime is CortexApp-scoped (Task 2 hoist). Required — Panel no longer
   *  creates its own buffer (Task 3 removed the local fallback). */
  buffer: StagingBufferHandle
  /** Apply error lifted to CortexApp (ZF0-1869 Round-1 Fix 1) so it survives
   *  Panel unmount on deselect. Null means no error. Panel renders the banner
   *  from this prop; both CortexApp's onMessage handler (source-edit-failed) and
   *  Panel's handleApplyError (sendAndAck rejection) set it via onSetApplyError. */
  applyError?: string | null
  /** Sets or clears the applyError in CortexApp. Pass null to clear. */
  onSetApplyError?: (err: string | null) => void
}

export function Panel({
  selectedElements,
  overrideManager,
  onClose,
  onSelectElement,
  swatches,
  textComponents,
  colorChips,
  spacingTokens,
  activeState = 'default',
  hasBefore = false,
  hasAfter = false,
  hoverEnabled = true,
  onToggleHover,
  position,
  isSnapping,
  panelPointerDown,
  panelPointerMove,
  panelPointerUp,
  panelPointerCancel,
  commandStack,
  flushCommitRef,
  undoInProgressRef,
  channel,
  agentConnected,
  connectionStatus,
  editErrors,
  onEditDispatch,
  onDismissError,
  onSelectElements,
  hmrAppliedVersion,
  hmrEventVersion = 0,
  hmrChangedFiles = [],
  staleOverrideCount = 0,
  staleSources,
  stageEditRef,
  commitEditRef,
  buffer: bufferProp,
  applyError: applyErrorProp = null,
  onSetApplyError,
}: PanelProps): JSX.Element | null {
  // Back-compat alias: primary element for all CSS-parsing code paths (ZF0-1195 / T3).
  // All existing usages of `element` inside this function work unchanged.
  const element = selectedElements[0] ?? null

  // ALL hooks first — no conditional returns before hooks
  const [isEntering, setIsEntering] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)
  const prevElementRef = useRef<Element | null>(null)

  // Tracks the pre-gesture value per property during a scrub, under TWO distinct
  // readings that used to be conflated into one string:
  //
  //   override — the UNDO TARGET. What `overrideManager.set` must restore to step
  //     back exactly one gesture. This is the prior *override* when one exists,
  //     so undo walks green → blue → red rather than jumping green → red.
  //
  //   baseline — the DIFF BASE, shipped as `PendingEdit.previousValue`. This must
  //     be the TRUE SOURCE value, because the server resolves the Tailwind
  //     old-token from it (staged-edits → edit-pipeline → rewriter). One string
  //     serving both meant every chained edit recorded a staged intermediate the
  //     file never contained: the rewriter looked for `text-blue-500` in a file
  //     holding `text-red-500`, and `reconcile` compared live source against a
  //     value that never existed, nagging the drift banner forever.
  //
  // Key: source\0property\0pseudo (null-byte separated — source paths contain colons).
  const scrubPreviousRef = useRef<Map<string, { override: string; baseline: string }>>(new Map())

  // Cache of resolved SOURCE values, keyed the same way and scoped to one HMR
  // generation. A source value cannot change without the file changing, and a
  // file change means an HMR cycle — so within one `hmrAppliedVersion` a
  // baseline read is valid forever and every repeat is provably redundant.
  //
  // This is a throughput guard, not a micro-optimisation. `readSourceValue`
  // detaches the override <style>, calls getComputedStyle, and reattaches: two
  // forced style recalcs per call. `scrubPreviousRef` alone does NOT bound it —
  // that map is cleared on every commit, and the wheel / held-arrow affordances
  // in NumericInput commit once per input EVENT (they call onChange, not
  // onScrub). Without this cache a held arrow key re-pays the full detach set
  // per repeat, multiplied by every target in a scope='all' fan-out.
  const sourceBaselineRef = useRef<{ version: number; values: Map<string, string> }>({
    version: -1,
    values: new Map(),
  })
  // Tracks the last committed value per property to suppress phantom commits
  // from HMR re-render blur events (same value committed twice for the same property).
  const lastCommitValueRef = useRef<Map<string, string>>(new Map())
  // Coalesces synchronous multi-property commits (e.g., linked padding left+right)
  // into a single atomic command via microtask.
  const commitPendingRef = useRef(false)

  // Spacing tokens flow in as a prop from cortex-app-reducer state, populated
  // by the `hello` handshake at boot. Provided to descendants (NumericInput)
  // via SpacingTokensContext.
  const resolvedSpacingTokens = spacingTokens ?? []

  // Buffer is provided by CortexApp (Task 2 hoist). The prop is required now
  // that the local fallback is removed (Task 3).
  const buffer = bufferProp
  if (!buffer) {
    throw new Error('[cortex] Panel requires `buffer` prop — hoisted from CortexApp')
  }

  // staged-edits-discard and source-edit-failed are now handled in CortexApp's
  // onMessage subscriber (ZF0-1869 Round-1 Fix 1). CortexApp owns the buffer and
  // never unmounts while active; if these handlers lived here, messages arriving
  // while Panel is unmounted (user deselected) would be silently dropped, causing
  // buffer divergence and silent apply-error loss. applyError state is also lifted
  // to CortexApp and flows down as the applyErrorProp + onClearApplyError pair.

  // ZF0-1470 (T4 B1): drift count drives StagingDriftBanner's intent-drift row.
  // Updated by buffer.reconcile() whenever hmrChangedFiles changes (see effect below).
  const [intentDriftCount, setIntentDriftCount] = useState(0)

  // ZF0-1869 Round-1 Fix 1: applyError state lifted to CortexApp. Panel reads
  // the error string from applyErrorProp (passed down from CortexApp) and
  // delegates mutations to onSetApplyError. The local alias keeps the
  // handleApplyError and onApply pre-flight callsites identical.
  const applyError = applyErrorProp
  const setApplyError = onSetApplyError ?? ((_v: string | null) => {})

  // ZF0-1470 (T4 B1): Apply handler — sends staged-edits-ready via sendAndAck so
  // Claude's MCP tools can read the buffer. Does NOT call buffer.clear() — per
  // parent ticket contract, Claude owns the buffer after Apply; it calls
  // cortex_discard_edits to remove specific intents via the MCP channel.
  const onApply = useCallback(async () => {
    // Reject (don't silently fulfill) when no channel — otherwise PanelHeader
    // sees a fulfilled promise and transitions into "Hidden after success"
    // state even though nothing was delivered to Claude. CodeRabbit caught
    // this on PR #91 review.
    if (!channel) {
      throw new Error('No cortex channel available — Apply not delivered. Reload the page or check that the cortex MCP is connected.')
    }
    // Clear any prior apply error before the new attempt so the UI doesn't
    // show a stale error while the new request is in-flight.
    setApplyError(null)
    await channel.sendAndAck({ type: 'staged-edits-ready', count: buffer.size() })
  }, [channel, buffer])

  // ZF0-1453 cross-task fix-up (IMPORTANT 3): Stable identity via useCallback so
  // PanelHeader does not receive a new function reference on every render. Without
  // this, memo on PanelHeader would be defeated and child subtree re-renders on
  // every Panel render cycle.
  const handleApplyError = useCallback((err: unknown) => {
    setApplyError(err instanceof Error ? err.message : 'Apply failed')
  }, [])

  // ZF0-1470 (T4 B2): reconcile on HMR — re-evaluate staged intents against live DOM.
  // CRITICAL: overrideManager.readSourceValue.bind bypasses the override !important
  // layer so getComputedStyle returns the source value, not cortex's own override
  // value. Without this, every active edit produces a false-positive divergence.
  //
  // ZF0-1470 (T4 fix-up, IMPORTANT 1): hmrEventVersion bumps on every HMR event
  // regardless of selection — reconcile must run for ALL buffered intents, not
  // just those affecting the selected element. hmrAppliedVersion is selection-aware
  // (drives DOM refresh); hmrEventVersion is always-bump (drives buffer reconcile).
  // Using hmrAppliedVersion here was the bug: if the HMR files didn't affect the
  // selected element, shouldRefreshOnHMR returned false, hmrAppliedVersion didn't
  // bump, and intents on non-selected elements were never reconciled.
  //
  // ZF0-1453 cross-task fix-up (IMPORTANT 1): When hmrChangedFiles is empty, no
  // reconcile is needed but the prior intentDriftCount must be cleared. Without
  // this reset, a nonzero count persists across unrelated HMR cycles (e.g. a CSS
  // hot update fires with empty changedFiles) and the drift banner shows a stale
  // "N edits affected" warning that no longer reflects reality.
  useEffect(() => {
    if (hmrChangedFiles.length === 0) { setIntentDriftCount(0); return }
    const result = buffer.reconcile(
      hmrChangedFiles,
      overrideManager.readSourceValue.bind(overrideManager),
    )
    setIntentDriftCount(result.divergent.length)
  // Dual-trigger design (ZF0-1477): re-run when HMR fires (hmrEventVersion) OR
  // when the buffer mutates (buffer.version). hmrEventVersion is a stable
  // monotonic counter that bumps on every hmr-applied event regardless of
  // selection. buffer.version is the monotonic mutation counter from
  // useEditStagingBuffer — increments on every append/remove/clear so that
  // removing a previously divergent intent without a new HMR event correctly
  // re-evaluates and clears the drift count. hmrChangedFiles is captured via
  // closure (both triggers) — omitted from deps because it changes reference
  // every render (array allocation) which would defeat the stable-trigger design.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hmrEventVersion, buffer.version])

  // Pseudo-element tab state — internal to Panel
  const [activePseudo, setActivePseudo] = useState<'element' | '::before' | '::after'>('element')

  // Shared class detection + scope toggle for instance-level editing (ZF0-1018)
  const [sharedInfo, setSharedInfo] = useState<SharedClassInfo | null>(null)
  const [editScope, setEditScope] = useState<'instance' | 'all'>('instance')
  // Shared source detection for warning-only banner (ZF0-1583)
  const [sharedSourceInfo, setSharedSourceInfo] = useState<SharedSourceInfo | null>(null)

  // Typography section dual-mode toggle: auto picks from detected token classes

  // Elements section (LayerTree) height — owned by Panel so the resize handle
  // can sit between SectionGroups as the section divider.
  const [layerHeight, setLayerHeight] = useState(DEFAULT_LAYER_HEIGHT)
  const layerResizeRef = useRef({ dragging: false, startY: 0, startH: 0 })
  const handleLayerResizeDown = useCallback((e: PointerEvent) => {
    layerResizeRef.current = { dragging: true, startY: e.clientY, startH: layerHeight }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [layerHeight])
  const handleLayerResizeMove = useCallback((e: PointerEvent) => {
    const r = layerResizeRef.current
    if (!r.dragging) return
    const maxH = Math.floor(window.innerHeight * 0.5)
    setLayerHeight(Math.max(MIN_LAYER_HEIGHT, Math.min(maxH, r.startH + (e.clientY - r.startY))))
  }, [])
  const handleLayerResizeUp = useCallback((e: PointerEvent) => {
    if (!layerResizeRef.current.dragging) return
    layerResizeRef.current.dragging = false
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch {}
  }, [])

  // Default computed styles snapshot for dimming comparison.
  // Plain object snapshot (NOT a live CSSStyleDeclaration) — taken once per element.
  const defaultStylesRef = useRef<Record<string, string> | null>(null)

  useEffect(() => {
    if (!element) { defaultStylesRef.current = null; return }
    const cs = getComputedStyle(element)
    const snapshot: Record<string, string> = {}
    for (const prop of ALL_DIMMING_PROPERTIES) {
      snapshot[prop] = typeof cs.getPropertyValue === 'function'
        ? cs.getPropertyValue(prop)
        : ''
    }
    defaultStylesRef.current = snapshot
    // Force useMemo re-run with fresh snapshot so dimming comparison
    // uses the NEW element's defaults, not the previous element's.
    setStyleVersion(v => v + 1)
  }, [element])

  // ZF0-1876: Play the enter animation on mount only, not on element-to-element
  // switches. The useState(true) initializer above covers first paint; []
  // keeps it mount-only so switching the selected element while the Panel
  // stays mounted is a silent content swap (per the contract on the
  // element-switch effect below: "sections update via normal prop changes").
  // Prior behaviour (re-armed on every [element] change) produced an ~800ms
  // staggered section-group cascade on every switch that read as the Panel
  // "flashing".
  useEffect(() => {
    const timer = setTimeout(() => setIsEntering(false), 250)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (prevElementRef.current && prevElementRef.current !== element) {
      // No cross-fade or body remount — sections update via normal prop changes.
      setActivePseudo('element') // reset pseudo tab on element change
    }
    prevElementRef.current = element
    scrubPreviousRef.current.clear() // abandon any in-progress scrub state
    lastCommitValueRef.current.clear()
  }, [element])

  // Abandon in-progress scrub state when switching pseudo-element tabs.
  // Without this, scrub state from ::before would contaminate a ::after commit.
  useEffect(() => {
    scrubPreviousRef.current.clear()
    lastCommitValueRef.current.clear()
  }, [activePseudo])

  // Clear blast-radius highlights and remove injected style tag on unmount
  useEffect(() => () => { clearHighlights(); removeBlastRadiusStyle() }, [])

  // Scope reset + blast-radius highlight clear fire on element change only
  // (ZF0-1018/1019). This was originally one effect with sharedInfo detection;
  // keeping scope reset pinned to [element] prevents the scope-reset regression
  // where an HMR bump would silently flip a user's "All" scope back to
  // "instance" mid-edit (cubic + Copilot flagged in ZF0-1292 review).
  useEffect(() => {
    clearHighlights()
    setEditScope('instance')
  }, [element])

  // Detect shared CSS classes when a new element is selected (ZF0-1018), and
  // re-run on hmrAppliedVersion bumps (ZF0-1292) because `sharedInfo.elements`
  // caches DOM refs — a stylesheet-only HMR edit can add or remove siblings
  // matching the shared selector without mutating the primary element.
  useEffect(() => {
    if (element) {
      try {
        setSharedInfo(detectSharedClasses(element))
      } catch (err) {
        // Cross-origin CSSOM access throws SecurityError — known path, don't
        // warn. Anything else is a bug; log it so it shows up in devtools.
        // Either way, disable the scope toggle so the Panel stays usable.
        if (!(err instanceof DOMException && err.name === 'SecurityError')) {
          console.warn('[cortex] detectSharedClasses unexpected error', err)
        }
        setSharedInfo(null)
      }
    } else {
      setSharedInfo(null)
    }
  }, [element, hmrAppliedVersion])

  // Detect shared source location when a new element is selected (ZF0-1583), and
  // re-run on hmrAppliedVersion bumps because `sharedSourceInfo.elements` caches
  // DOM refs — an HMR edit can add or remove siblings sharing the same source.
  // Warning-only: no scope toggle, no commit-path changes.
  useEffect(() => {
    if (element) {
      try {
        setSharedSourceInfo(detectSharedSource(element))
      } catch (err) {
        // Cross-origin DOM access throws SecurityError — known path, don't
        // warn. Anything else is a bug; log it so it shows up in devtools.
        if (!(err instanceof DOMException && err.name === 'SecurityError')) {
          console.warn('[cortex] detectSharedSource unexpected error', err)
        }
        setSharedSourceInfo(null)
      }
    } else {
      setSharedSourceInfo(null)
    }
  }, [element, hmrAppliedVersion])

  // Sync strategy: bump counter on committed changes to force getComputedStyle re-read.
  // During scrub, trust NumericInput local state (no re-render per frame).
  const [styleVersion, setStyleVersion] = useState(0)

  // Re-read computed styles whenever overrides change externally (undo/redo clearAll,
  // hmr_verified removal). Without this, Panel shows stale values after undo because
  // clearAll doesn't bump styleVersion — only applyOverride does.
  useEffect(() => {
    return onOverrideChange(() => setStyleVersion(v => v + 1))
  }, [])

  // `hmrAppliedVersion` is a dep on the `computedStyles` useMemo below so
  // HMR-driven invalidation happens in the render pass triggered by the
  // prop change — no intermediate state bump, no extra render. Covers
  // stylesheet-only source edits (App.css rule changes, @theme token
  // changes, ancestor cascade changes) that don't mutate the selected
  // element's own class/style attributes and therefore don't trip the
  // MutationObserver below.

  // Observe class AND style attribute mutations on the selected element.
  // The Panel lives in a shadow-DOM Preact tree decoupled from the user's
  // React tree — when HMR re-renders their component and flips className
  // or inline style, nothing else signals the Panel. Without this, bundle
  // detection (typographyClassName memo) keeps returning the pre-HMR class
  // and the typography pill never updates after a classOp edit; similarly,
  // SegmentedControl values (text-align, etc.) stay stale after an
  // InlineStyleRewriter edit lands via HMR because the memoized
  // `computedStyles` never refreshes.
  //
  // Both attributes matter because the server has two rewriter paths:
  //   - Tailwind class swap (className changes)
  //   - Inline style rewrite (style attribute changes, new in ZF0-1215
  //     for properties without a matching Tailwind utility on the element)
  //
  // Microtask coalescing: React Fast Refresh commonly emits several
  // mutations within a single paint (reconciler diff + side-effect passes).
  // Collapsing them into one styleVersion bump prevents `computedStyles`
  // from thrashing (2-3× getComputedStyle calls per property group per
  // mutation). This is correctness-hygiene, not a perf optimization — it
  // keeps one user-visible DOM change mapped to one Panel render.
  useEffect(() => {
    if (!element) return
    let pending = false
    const bump = (): void => {
      if (pending) return
      pending = true
      queueMicrotask(() => {
        pending = false
        setStyleVersion(v => v + 1)
      })
    }
    const observer = new MutationObserver(bump)
    observer.observe(element, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => observer.disconnect()
  }, [element])

  // C1: Cache getComputedStyle results + compute dimmed properties in a single useMemo
  // to avoid double forced layout. CRITICAL: activeState + activePseudo in deps so
  // useMemo re-runs after state forcing (getComputedStyle returns a live reference).
  const { computedStyles, dimmedProperties, mixedProperties: scopeMixedProperties } = useMemo(
    () => computePanelStyleSnapshot({
      element,
      activePseudo,
      activeState,
      sharedInfo,
      editScope,
      overrideManager,
      defaultStyles: defaultStylesRef.current,
    }),
    [element, styleVersion, hmrAppliedVersion, activeState, activePseudo, sharedInfo, editScope],
  )

  // Multi-select mixed properties (ZF0-1195 / T3): compare getComputedStyle across
  // all selectedElements for the 15-property watch-list. When selectedElements.length
  // <= 1 the result is always empty. Merged with scopeMixedProperties (scope='all'
  // cross-sibling comparison) so sections see a unified mixed signal.
  //
  // Filter to .isConnected elements before comparing (Phase-4 review A3): T1 deferred
  // multi-element HMR re-resolution, so secondary elements may go stale (detached) after
  // an HMR swap. getComputedStyle on a detached node returns empty strings, which would
  // otherwise produce false "mixed" signals across all 15 watched properties.
  //
  // Deps include styleVersion / activeState / activePseudo (PR #104 review I1):
  // computed values change when stylesheet rules update (styleVersion),
  // when interaction state forces a different cascade (activeState), or when
  // we're reading a pseudo-element (activePseudo). Without these deps the
  // memo holds stale "mixed" signals through animation, hover-state preview,
  // or pseudo-state editing.
  const multiSelectMixed = useMemo<Set<string>>(() => {
    const live = selectedElements.filter(el => el.isConnected)
    if (live.length <= 1) return new Set()
    const mixed = new Set<string>()
    for (const prop of MULTI_SELECT_WATCHED_PROPERTIES) {
      let firstVal: string | null = null
      for (const el of live) {
        const v = getComputedStyle(el).getPropertyValue(prop).trim()
        if (firstVal === null) firstVal = v
        else if (v !== firstVal) { mixed.add(prop); break }
      }
    }
    return mixed
  }, [selectedElements, hmrAppliedVersion, styleVersion, activeState, activePseudo])

  // Merge multi-select mixed with scope-based mixed for a unified signal.
  const mixedProperties = useMemo<Set<string> | undefined>(() => {
    if (multiSelectMixed.size === 0 && !scopeMixedProperties) return scopeMixedProperties
    if (multiSelectMixed.size === 0) return scopeMixedProperties
    if (!scopeMixedProperties) return multiSelectMixed
    return new Set([...scopeMixedProperties, ...multiSelectMixed])
  }, [multiSelectMixed, scopeMixedProperties])

  const availableWeights = useMemo(
    () => {
      const family = computedStyles.typography.fontFamily ?? ''
      return getWeightsForFamily(stripCSSQuotes(family.split(',')[0]?.trim() ?? ''))
    },
    [computedStyles.typography.fontFamily],
  )

  // Shared raw className read — both extractedUtilities (Tailwind utilities)
  // and typographyClassName (bundle + chip detection) need the same string.
  const rawClassName = useMemo<string>(() => (element ? classAttr(element) : ''), [element, styleVersion])

  // Extract Tailwind utility classes from element's className.
  // Enables the "direct class path": send the actual class name to the server
  // instead of relying on fragile computed-style → hex → class-name reverse lookup.
  // Note: when element is null, rawClassName resolves to '' and extractUtilities('')
  // returns an empty Map — no explicit guard needed. element is transitively covered
  // by rawClassName's deps, so it's omitted from this memo's deps.
  const extractedUtilities = useMemo(
    () => extractUtilities(rawClassName),
    [rawClassName],
  )

  // Raw className attribute — TypographySection detects bundle + chip membership against it.
  // String identity is stable from rawClassName's memo, so a passthrough useMemo would
  // add no memoization value; bind directly.
  const typographyClassName: string = rawClassName

  // Null-byte separator for composite scrub keys — never appears in CSS properties or source paths.
  const SEP = '\0'

  // Commit phase: builds an atomic PropertyEditCommand from accumulated scrub state,
  // records it on the CommandStack, flushes visual overrides, and sends server edits.
  // Separated from applyOverride so batch handlers can accumulate multiple properties
  // via scrub calls and commit once (one undo entry for the whole gesture).
  const commitScrub = useCallback(() => {
    // Suppress phantom re-edits from Panel re-renders during undo/redo.
    // Without this, undo changes overrides → Panel re-renders → inputs fire
    // onChange with stale values → new phantom command overwrites the undo.
    if (undoInProgressRef?.current) {
      scrubPreviousRef.current.clear()
      return
    }
    if (!element || scrubPreviousRef.current.size === 0) return
    const primaryTarget = getElementEditTarget(element)
    const source = primaryTarget.source

    // Build PropertyChange[] from accumulated scrub previous values.
    // Filter out no-op changes where value didn't change.
    //
    // `PropertyChange.previousValue` carries the UNDO target. The DIFF BASE
    // travels alongside in `baselineByKey` rather than widening PropertyChange,
    // which `CompoundEditCommand` also consumes and has no diff-base semantics.
    const changes: PropertyChange[] = []
    const baselineByKey = new Map<string, string>()
    for (const [key, prev] of scrubPreviousRef.current) {
      const [s, p, ps] = key.split(SEP) as [string, string, string]
      const parsedPseudo = (ps || undefined) as '::before' | '::after' | undefined
      const currentValue = overrideManager.get(s, p, parsedPseudo) ?? ''
      // Compare against `override`, not `baseline`: this asks "did THIS gesture
      // change anything", which is an override-space question. Comparing against
      // baseline would swallow a legitimate re-edit back to the source value.
      if (currentValue === prev.override) continue
      changes.push({
        source: s,
        property: p,
        value: currentValue,
        previousValue: prev.override,
        pseudo: parsedPseudo,
      })
      baselineByKey.set(key, prev.baseline)
    }

    /** Rebuild a change's scrubPreviousRef key so its baseline can be looked up. */
    const baselineFor = (c: PropertyChange): string =>
      baselineByKey.get(`${c.source}${SEP}${c.property}${SEP}${c.pseudo ?? ''}`) ?? c.previousValue

    // Build PendingEdits up front. They are the single source of truth for both
    // (a) the initial buffer.append loop below, and (b) the PropertyEditCommand's
    // undo/redo bookkeeping — undo removes these intentIds; redo re-appends these
    // exact shapes. Sharing one array avoids the desync where the buffer entry
    // and the command's view of "what was appended" could drift apart.
    //
    // Multi-select: one PendingEdit per (selectedElement, property) pair.
    // Single-select: one PendingEdit per changed property on the primary element.
    const isMultiSelect = selectedElements.length > 1
    const isShared = !!sharedInfo && editScope === 'all'

    let pendingEdits: PendingEdit[]
    if (isMultiSelect) {
      // Filter `changes` to entries matching this element's source — mirrors the
      // single-select branch's `c.source === source` filter (Post-Fix Discipline
      // rule 3: parallel branches should mirror).
      //
      // Source-dedup (PR #104 review C1): expandSharedSource() may put N DOM
      // nodes with the same data-cortex-source into selectedElements (e.g.,
      // .map()-rendered list items). Without deduping by source, the outer
      // loop pushes one PendingEdit per DOM node — buffer's last-write-wins
      // collapses them to one entry, but commandStack's pendingEdits inflates
      // by N. Same class as the T4 round 2 O(N²) bug. Use a seenSources Set
      // so the first occurrence of each source produces exactly one intent.
      pendingEdits = []
      const seenSources = new Set<string>()
      for (const el of selectedElements) {
        const elTarget = getElementEditTarget(el)
        const elSource = elTarget.source
        if (seenSources.has(elSource)) continue
        seenSources.add(elSource)
        // When scope='all' is also active, each unique selected source fans out
        // to its own shared-class siblings — each PendingEdit carries its own instanceSources.
        let perElementInstanceSources: string[] | undefined
        if (isShared) {
          try {
            const shared = detectSharedClasses(el)
            perElementInstanceSources = shared
              ? editSourcesForElements(shared.elements)
              : undefined
          } catch (err) {
            console.warn('[cortex] detectSharedClasses threw during multi-select fan-out', err)
            perElementInstanceSources = undefined
          }
        }
        for (const c of changes) {
          if (c.source !== elSource) continue // mirrors single-select branch
          pendingEdits.push({
            intentId: generateId(),
            source: elSource,
            property: c.property,
            value: c.value,
            // The DIFF BASE, not the undo target — see scrubPreviousRef.
            previousValue: baselineFor(c),
            // Use the change's own pseudo, not the closure-scoped `activePseudo`.
            pseudo: c.pseudo,
            scope: isShared ? 'all' : 'instance',
            instanceSources: perElementInstanceSources,
            ...pendingEditTargetFields(elTarget),
            timestamp: Date.now(),
          })
        }
      }
    } else {
      // Single-select: filter to the primary source, pack optional instanceSources.
      const editedProps = changes.filter(c => c.source === source)
      const instanceSources = isShared
        ? editSourcesForElements(sharedInfo!.elements)
        : undefined
      pendingEdits = editedProps.map(c => ({
        intentId: generateId(),
        source,
        property: c.property,
        value: c.value,
        // The DIFF BASE, not the undo target — see scrubPreviousRef.
        previousValue: baselineFor(c),
        // Use the change's own pseudo, not the closure-scoped `activePseudo`.
        // They're equal today via a useEffect that clears scrubPreviousRef on
        // pseudo change, but that invariant is action-at-a-distance — local
        // truth (`c.pseudo`) is always correct.
        pseudo: c.pseudo,
        // PendingEdit.scope mirrors the server's CortexEdit.scope contract
        // ('instance' | 'all'); editScope already uses the same shape.
        scope: editScope,
        instanceSources,
        ...pendingEditTargetFields(primaryTarget),
        timestamp: Date.now(),
      }))
    }

    // Track committed values to suppress phantom re-commits from HMR re-render.
    // Stays HERE, ahead of the appends: buffer.append bumps the buffer version,
    // which can re-render Panel and fire an input onChange, and this guard needs
    // to be armed before that can happen.
    for (const c of changes) {
      lastCommitValueRef.current.set(`${c.source}${SEP}${c.property}${SEP}${c.pseudo ?? ''}`, c.value)
    }

    overrideManager.flush()
    setStyleVersion(v => v + 1)
    scrubPreviousRef.current.clear()

    // Initial append to the staging buffer (deferred to Apply gesture).
    // Subsequent redo() of the recorded command re-appends these same shapes
    // via PropertyEditCommand.execute → bufferOps.append.
    const displacedEdits: PendingEdit[] = []
    for (const edit of pendingEdits) {
      // Last-write-wins destroys any prior intent for this composite key. Collect
      // what each append displaced so undo can restore it — otherwise undoing a
      // chained edit empties the buffer while the override still shows the
      // intermediate value, and Apply silently writes nothing.
      const displaced = buffer.append(edit)
      if (displaced !== undefined) displacedEdits.push(displaced)
      // A new edit supersedes any prior divergence card for the same source+property.
      // Pre-pivot, this clear happened in CortexApp.handleEditDispatch when the edit
      // went out via channel.send. Now that the edit is buffer-appended, dispatch
      // doesn't fire — so we re-establish the contract here.
      onDismissError?.(`${edit.source}${SEP}${edit.property}`)
    }

    // Record command on stack AFTER the appends, so it owns what they displaced.
    // Overrides are already applied during the scrub phase, so record() stores
    // without re-executing (avoids double-apply). The command owns the
    // staging-buffer side of undo/redo via pendingEdits + displacedEdits.
    if (changes.length > 0) {
      if (commandStack) {
        const cmd = new PropertyEditCommand({
          changes,
          overrideManager,
          pendingEdits,
          displacedEdits,
          bufferOps: buffer,
        })
        commandStack.record(cmd)
      } else {
        console.warn('[cortex] Edit committed without undo stack — this edit cannot be undone')
      }
    }
  }, [selectedElements, element, overrideManager, buffer, sharedInfo, editScope, commandStack, onDismissError])

  // Expose flush for CortexApp to call before undo/redo — microtask commits
  // haven't fired yet when blur+undo runs synchronously in the same tick.
  useEffect(() => {
    if (flushCommitRef) {
      flushCommitRef.current = () => {
        if (commitPendingRef.current) {
          commitPendingRef.current = false
          commitScrub()
        }
      }
      return () => { flushCommitRef.current = null }
    }
  }, [flushCommitRef, commitScrub])

  // TEST-ONLY: expose buffer.append via stageEditRef so e2e specs can seed
  // the staging buffer directly (Apply button lifecycle tests). Follows the
  // same pattern as flushCommitRef — Panel owns the assignment, CortexApp
  // passes the ref. Only active when __CORTEX_TEST_BUILD__ is true (the ref
  // is undefined in prod bundles because CortexApp gates the prop assignment
  // behind __CORTEX_TEST_BUILD__).
  useEffect(() => {
    if (stageEditRef) {
      stageEditRef.current = (source: string, property: string, value: string): string => {
        // ZF0-1473 PR #93 Copilot+CodeRabbit feedback: use generateId() to
        // avoid same-millisecond intentId collisions on rapid stage calls
        // and to mirror the production `commitScrub` path (Panel.tsx:662)
        // which uses generateId() too. The `test-` prefix makes test-staged
        // intents identifiable in debug output.
        const intentId = `test-${generateId()}`
        buffer.append({
          intentId,
          source,
          property,
          value,
          previousValue: '',
          timestamp: Date.now(),
        })
        return intentId
      }
      return () => { stageEditRef.current = null }
    }
  }, [stageEditRef, buffer])

  /** Capture the pre-gesture `{ override, baseline }` pair for one target, once
   *  per key per gesture. ONE implementation deliberately shared by the primary
   *  target and every fan-out target — these were twin inline blocks, and twins
   *  that must stay identical eventually don't (Post-Fix Discipline rule 3).
   *
   *  `baseline` skips the expensive detached read when the page carries no
   *  overrides at all, because computed IS source in that case. It does NOT
   *  gate on "an override exists for THIS key" — that check misses a parent's
   *  inherited-property override and shorthand-to-longhand leakage, which is
   *  how a polluted baseline reaches a first-touch capture with no edit chain
   *  at all (e.g. after a classOp whose server write failed). */
  const capturePrevious = useCallback((
    el: Element,
    elSource: string,
    property: string,
    pseudo: '::before' | '::after' | undefined,
    key: string,
  ): void => {
    if (scrubPreviousRef.current.has(key)) return
    const existing = overrideManager.get(elSource, property, pseudo)
    const override = existing
      ?? (getComputedStyle(el, pseudo ?? null).getPropertyValue(property).trim() || '')

    // Version-keyed reset, checked synchronously rather than in an effect so a
    // capture in the same render pass as an HMR bump can't read a stale entry.
    const version = hmrAppliedVersion ?? 0
    if (sourceBaselineRef.current.version !== version) {
      sourceBaselineRef.current = { version, values: new Map() }
    }
    const cached = sourceBaselineRef.current.values.get(key)
    if (cached !== undefined) {
      scrubPreviousRef.current.set(key, { override, baseline: cached })
      return
    }

    // No overrides anywhere ⟹ `existing` was undefined ⟹ `override` is the
    // computed value, which is the source value. Reuse it rather than paying
    // for a second read.
    const baseline = overrideManager.hasAnyOverrides()
      ? overrideManager.readSourceValue(el, property, pseudo ?? null).trim()
      : override
    sourceBaselineRef.current.values.set(key, baseline)
    scrubPreviousRef.current.set(key, { override, baseline })
  }, [overrideManager, hmrAppliedVersion])

  // Scrub phase: captures previousValue on first touch per property, applies override.
  // On commit (commitRender=true): delegates to commitScrub() for atomic command creation.
  const applyOverride = useCallback((property: string, value: string, commitRender: boolean) => {
    // Suppress phantom re-edits triggered by Preact re-renders after undo/redo.
    // Preact's setTimeout-based batching fires AFTER the keyboard handler completes,
    // causing section inputs to re-render with new values and fire onChange.
    if (undoInProgressRef?.current) return
    if (!element) return
    const primaryTarget = getElementEditTarget(element)
    const source = primaryTarget.source
    const pseudo = activePseudo !== 'element' ? activePseudo : undefined
    const prevKey = `${source}${SEP}${property}${SEP}${pseudo ?? ''}`

    // Phantom re-commit guard: after HMR re-render, input blur can fire onCommit
    // with the same value that was just committed. Bail BEFORE applying the override
    // so no stale !important rule is (re-)introduced into the style element.
    if (commitRender) {
      const lastCommitted = lastCommitValueRef.current.get(prevKey)
      if (lastCommitted === value) {
        // Only suppress if the override is still in place. If HMR or undo
        // removed the override externally, the user genuinely wants to
        // re-apply the same value — allow it through.
        const currentOverride = overrideManager.get(source, property, pseudo)
        if (currentOverride === value) {
          scrubPreviousRef.current.delete(prevKey)
          return
        }
        // Override was removed externally — stale guard entry, clear it
        lastCommitValueRef.current.delete(prevKey)
      }
    }

    // Capture BEFORE set() — only on first touch per property per gesture.
    // `override` (undo target) prefers the existing override so undo steps back
    // one gesture even after HMR removed the original override; `baseline`
    // (diff base) is always the true source. See scrubPreviousRef's declaration.
    capturePrevious(element, source, property, pseudo, prevKey)

    // Fan-out targets for this gesture, computed once per applyOverride call.
    // Multi-select alone: apply override to ALL selected elements.
    // scope='all' (single-select): apply to all shared-class siblings.
    // Multi-select + scope='all' (PR #104 review C2): apply to UNION of selected
    //   elements AND each selected element's shared-class siblings — otherwise
    //   the live preview misses what `commitScrub`'s instanceSources will dispatch
    //   to the server, producing preview/apply divergence.
    // Single-select + scope='instance': apply to the primary element only.
    const fanOutTargets: Element[] = (() => {
      const isMulti = selectedElements.length > 1
      const isAll = sharedInfo && editScope === 'all'
      if (isMulti && isAll) {
        const seen = new Set<Element>()
        for (const sel of selectedElements) {
          if (!seen.has(sel)) seen.add(sel)
          try {
            const shared = detectSharedClasses(sel)
            if (shared) for (const sib of shared.elements) seen.add(sib)
          } catch {
            // detectSharedClasses can throw DOMException SecurityError on
            // cross-origin querySelector — fall through with just selectedElements.
          }
        }
        return Array.from(seen)
      }
      if (isMulti) return selectedElements
      if (isAll) return sharedInfo!.elements
      return element ? [element] : []
    })()

    for (const el of fanOutTargets) {
      const elSource = getElementEditTarget(el).source
      const elPrevKey = `${elSource}${SEP}${property}${SEP}${pseudo ?? ''}`
      // Same helper as the primary capture above, so the two can never drift
      // apart. Usually a no-op re-visit — but the primary capture is NOT
      // redundant: it pins the primary target's pre-gesture state ahead of every
      // `set()` in this loop, and the `isAll` branch returns
      // `sharedInfo.elements`, a flat-query snapshot that need not contain a
      // shadow-hosted `element`.
      capturePrevious(el, elSource, property, pseudo, elPrevKey)
      overrideManager.set(elSource, property, value, pseudo)
    }

    if (commitRender) {
      // Coalesce synchronous multi-property commits into one atomic command.
      // When linked padding fires onChange for both left and right in the same
      // tick, both accumulate in scrubPreviousRef and commit once via microtask.
      if (!commitPendingRef.current) {
        commitPendingRef.current = true
        queueMicrotask(() => {
          commitPendingRef.current = false
          commitScrub()
        })
      }
    }
  }, [selectedElements, element, overrideManager, activePseudo, sharedInfo, editScope, commitScrub, capturePrevious])

  const handleCommit = useCallback((c: SectionChange) => applyOverride(c.property, c.value, true), [applyOverride])
  const handleScrub = useCallback((c: SectionChange) => applyOverride(c.property, c.value, false), [applyOverride])

  // TEST-ONLY: expose applyOverride(property, value, true) via commitEditRef so e2e specs
  // can trigger the full commit gesture (override set + scrubPreviousRef seed + commandStack
  // record + buffer.append fan-out) without going through the scrub UI. Mirrors the
  // stageEditRef pattern — Panel owns the assignment, CortexApp passes the ref.
  // Returns a Promise that resolves after the microtask-coalesced commitScrub fires so callers
  // don't need their own settling logic.
  useEffect(() => {
    if (commitEditRef) {
      commitEditRef.current = (property: string, value: string): Promise<void> =>
        new Promise<void>((resolve) => {
          applyOverride(property, value, false) // arm scrubPreviousRef + override
          applyOverride(property, value, true)  // schedule microtask commitScrub
          queueMicrotask(resolve)               // resolve after commitScrub fires
        })
      return () => { commitEditRef.current = null }
    }
  // applyOverride is stable (useCallback) — safe dep.
  }, [commitEditRef, applyOverride])

  /**
   * Dispatch a className mutation (classOp) to the server, optionally followed
   * by per-property inline-style edits for the same element. Used by the new
   * Typography section: linking a bundle is `{add: 'body-md', inlineProps: []}`
   * (class goes on, inline styles come off), unlinking is
   * `{remove: 'body-md', inlineProps: [{property:'font-size', value:'14px'}, ...]}`
   * (class comes off, inline styles from the bundle preserve the rendered look).
   *
   * classOps bypass the scrub/commit dance — they are atomic by nature
   * (no "half-linked" state). Follow-up inline props go through the normal
   * applyOverride path so they participate in undo coalescing.
   */
  // Describe a compound edit for onEditDispatch's activity log.
  // Kept local (not exported) because it's a UI-detail formatter —
  // the '__class__' sentinel tells consumers to render this differently
  // than regular property edits.
  const formatCompoundDescription = (opts: {
    remove?: string
    add?: string
    inlineSets?: ReadonlyArray<{ property: string; value: string }>
    inlineRemoves?: ReadonlyArray<{ property: string }>
  }): string => {
    const parts: string[] = []
    if (opts.remove) parts.push(`-${opts.remove}`)
    if (opts.add) parts.push(`+${opts.add}`)
    if (opts.inlineSets?.length) parts.push(`set(${opts.inlineSets.length})`)
    if (opts.inlineRemoves?.length) parts.push(`rm(${opts.inlineRemoves.length})`)
    return parts.join(' ')
  }

  const applyClassChange = useCallback(
    (opts: {
      remove?: string
      add?: string
      /** Inline property SETS to apply alongside the class change. The
       *  server writes these to source as `style={{...}}` properties.
       *  Locally, they're applied as !important overrides for immediate
       *  visual feedback while HMR processes the source write. */
      inlineSets?: ReadonlyArray<{ property: string; value: string }>
      /** Inline property REMOVES to apply alongside the class change.
       *  The server removes them from source. Locally, any matching
       *  !important overrides are cleared so the new class's cascade
       *  takes effect immediately. */
      inlineRemoves?: ReadonlyArray<{ property: string }>
    }) => {
      if (!element || !channel) return
      const source = element.getAttribute('data-cortex-source')
      if (!source) return
      if (!opts.remove && !opts.add) return  // classOp required for compound path

      // Drain any pending property-commit microtask BEFORE issuing the
      // compound edit. Otherwise a classOp could land in the server's
      // file-lock queue AHEAD of a pending PropertyEditCommand, producing
      // an inverted undo stack order. The flush is a no-op when no
      // scrub is in flight.
      flushCommitRef?.current?.()

      const pseudo = activePseudo !== 'element' ? activePseudo : undefined
      const editId = generateId()

      // Capture previous override values BEFORE mutating, so the
      // Single-pass iteration: snapshot previousValue, build the
      // CompoundEditCommand change entry, AND apply the optimistic
      // override — all in one loop per kind. The critical constraint
      // is order: overrideManager.get must run BEFORE overrideManager.set
      // so the snapshot reflects the pre-edit state. Single-pass
      // respects this because get + push + set fire in that order for
      // each property before moving to the next.
      //
      // Local !important overrides give IMMEDIATE visual feedback. The
      // server's HMR-verified handshake (trackPendingEdit →
      // handleHMRVerified) releases them once the source write lands
      // and React re-renders. Without the local override, the user
      // would see OLD styles until HMR completes (100-500ms).
      const changes: PropertyChange[] = []
      if (opts.inlineSets) {
        for (const s of opts.inlineSets) {
          const previousValue = overrideManager.get(source, s.property, pseudo) ?? ''
          changes.push({ source, property: s.property, value: s.value, previousValue, pseudo })
          overrideManager.set(source, s.property, s.value, pseudo)
          // trackPendingEdit shares editId across the whole compound so
          // HMR-verification releases all properties of this gesture together.
          overrideManager.trackPendingEdit(editId, source, s.property, s.value, pseudo)
        }
      }
      // inlineRemoves: clear any stale overrides locally so the new
      // class's cascade wins immediately. Structurally redundant with
      // the H7 part A pre-clear in handleTypographyChange but idempotent
      // and keeps this function self-contained.
      if (opts.inlineRemoves) {
        for (const r of opts.inlineRemoves) {
          const previousValue = overrideManager.get(source, r.property, pseudo) ?? ''
          overrideManager.remove(source, r.property, pseudo)
          if (previousValue === '') continue  // nothing to restore on undo — no-op remove
          changes.push({ source, property: r.property, value: '', previousValue, pseudo })
        }
      }

      // Record on browser commandStack so Ctrl+Z's `if (cmd)` gate fires
      // and dispatches `{ type: 'undo' }` to the server — without this,
      // the server's compound UndoFileChange is never popped.
      // record() stores without re-executing — overrides were already
      // applied above, matching the PropertyEditCommand pattern.
      if (commandStack) {
        const cmd = new CompoundEditCommand({ changes, overrideManager, editId })
        commandStack.record(cmd)
      } else {
        // Observability parity with commitScrub at line 593 — a
        // compound edit committed without a commandStack cannot be
        // undone. Warn so missing-stack wiring is diagnosable.
        console.warn('[cortex] Compound edit committed without undo stack — this edit cannot be undone')
      }

      // ONE compound WebSocket message. Server routes to
      // handleCompoundEdit when classOp + (inlineSets || inlineRemoves)
      // are all present; to handleClassOp when only classOp; to the
      // property path when only property/value. Falsifiable hook for
      // onEditDispatch is the '__class__' sentinel — the Panel's
      // activity log uses it to render compound ops as a single row.
      onEditDispatch?.(editId, source, '__class__', formatCompoundDescription(opts))
      channel.send({
        type: 'edit',
        editId,
        source,
        property: '',
        value: '',
        elementSelector: element.tagName.toLowerCase(),
        classOp:
          opts.remove && opts.add ? { kind: 'swap' as const, remove: opts.remove, add: opts.add }
          : opts.add ? { kind: 'add' as const, add: opts.add }
          : opts.remove ? { kind: 'remove' as const, remove: opts.remove }
          : undefined,
        ...(opts.inlineSets && opts.inlineSets.length > 0 ? { inlineSets: opts.inlineSets } : {}),
        ...(opts.inlineRemoves && opts.inlineRemoves.length > 0 ? { inlineRemoves: opts.inlineRemoves } : {}),
      })
    },
    [element, channel, onEditDispatch, overrideManager, activePseudo, commandStack],
  )

  /**
   * Route a TypographyChange (discriminated union) to the right dispatcher.
   *
   * - Plain {property, value} → applyOverride (scrub/commit dance)
   * - link-* → applyClassChange with `add` + inline clear of the 5 props
   * - unlink-* → applyClassChange with `remove` + inline preservation
   * - typography-align → screen-axis intent routed through the selected
   *   element's layout context, fanning out multi-property edits as needed.
   */
  const handleTypographyChange = useCallback(
    (change: import('./sections/TypographySection.js').TypographyChange) => {
      if ('property' in change) {
        applyOverride(change.property, change.value, true)
        return
      }

      // Shared by link handlers (H7 part A): clear any in-flight browser
      // !important overrides for the properties the link is about to own.
      // Without this, a prior scrub (e.g., user dragged font-size to 24px)
      // leaves an override in overrideManager; when the link lands, the
      // class's font-size: 1rem loses the cascade to the override, and
      // the Panel shows "linked" while the visual stays at 24px. These
      // removes are LOCAL — no WebSocket message, no source edit —
      // the source-file inline-style cleanup is handled separately by
      // the compound-edit message introduced in C2 (inlineRemoves).
      const clearLinkedOverrides = (properties: ReadonlyArray<string>): void => {
        if (!element) return
        const source = element.getAttribute('data-cortex-source')
        if (!source) return
        const pseudo = activePseudo !== 'element' ? activePseudo : undefined
        for (const property of properties) {
          overrideManager.remove(source, property, pseudo)
        }
      }

      switch (change.kind) {
        case 'link-text-component': {
          // Compound edit (C2 + H7 part B): add the new text- class AND
          // request removal of any stale inline style= values from the
          // 5 typography properties. Prior to C2, link handlers only
          // sent classOp — the rendered view still wins from inline
          // styles left over from a prior unlink. The compound message
          // makes link "truly fresh": new class + no stale inline.
          //
          // clearLinkedOverrides is kept for IMMEDIATE visual feedback
          // (local override clear) while the compound roundtrips to
          // server. Redundant with applyClassChange's internal
          // inlineRemoves clear but idempotent.
          clearLinkedOverrides(TYPOGRAPHY_LINKED_PROPERTIES)
          applyClassChange({
            remove: change.removeClass,
            add: `text-${change.component.name}`,
            inlineRemoves: TYPOGRAPHY_LINKED_PROPERTIES.map((property) => ({ property })),
          })
          return
        }
        case 'unlink-text-component': {
          // Compound edit: remove the bundle class AND write preserving
          // inline styles to source IN ONE MESSAGE. Before C2 this was
          // ONE classOp message + FIVE applyOverride edit messages,
          // producing 6 server undo entries for one user gesture.
          // After C2: ONE compound undo entry → one Ctrl+Z restores
          // the whole gesture.
          applyClassChange({
            remove: change.removeClass,
            inlineSets: change.inline,
          })
          return
        }
        case 'link-color-chip': {
          clearLinkedOverrides(COLOR_LINKED_PROPERTIES)
          applyClassChange({
            remove: change.removeClass,
            add: `text-${change.chip.name}`,
            inlineRemoves: COLOR_LINKED_PROPERTIES.map((property) => ({ property })),
          })
          return
        }
        case 'unlink-color-chip': {
          applyClassChange({
            remove: change.removeClass,
            inlineSets: change.inline,
          })
          return
        }
        case 'typography-align': {
          const result = resolveTypographyAlignmentEdits({
            context: computedStyles.typography,
            axis: change.axis,
            value: change.value,
          })
          result.edits.forEach((edit, index) => {
            applyOverride(edit.property, edit.value, index === result.edits.length - 1)
          })
          return
        }
        default: {
          // Exhaustive check — TypeScript errors here if TypographyChange
          // gains a new kind without a handler. Mirrors the pattern used
          // by connectionStatusText at line 47. Runtime no-op with log
          // so misconfigurations are observable without crashing the panel.
          const _exhaustive: never = change
          console.error('[cortex] Unhandled TypographyChange kind:', _exhaustive)
        }
      }
    },
    [applyOverride, applyClassChange, computedStyles.typography],
  )

  const handleBackgroundChange = useCallback(
    (change: BackgroundChange) => {
      if ('property' in change) {
        applyOverride(change.property, change.value, true)
        return
      }

      switch (change.kind) {
        case 'link-background-token':
          applyClassChange({
            remove: change.removeClass,
            add: `bg-${change.chip.name}`,
            inlineRemoves: [{ property: 'background-color' }],
          })
          return
        case 'unlink-background-token':
          applyClassChange({
            remove: change.removeClass,
            inlineSets: change.inline,
          })
          return
        default: {
          const _exhaustive: never = change
          console.error('[cortex] Unhandled BackgroundChange kind:', _exhaustive)
        }
      }
    },
    [applyOverride, applyClassChange],
  )

  const handleBorderChange = useCallback(
    (change: BorderChange) => {
      if ('property' in change) {
        applyOverride(change.property, change.value, true)
        return
      }

      switch (change.kind) {
        case 'link-border-token':
          applyClassChange({
            remove: change.removeClass,
            add: `border-${change.chip.name}`,
            inlineRemoves: [{ property: 'border-color' }],
          })
          return
        case 'unlink-border-token':
          applyClassChange({
            remove: change.removeClass,
            inlineSets: change.inline,
          })
          return
        default: {
          const _exhaustive: never = change
          console.error('[cortex] Unhandled BorderChange kind:', _exhaustive)
        }
      }
    },
    [applyOverride, applyClassChange],
  )

  // Property section state — driven by computed values, not user toggle
  const fillSummary = useMemo(() => summarizeFill(computedStyles.fill), [computedStyles.fill])
  const fillHasValue = fillSummary !== 'transparent'
  const borderSummary = useMemo(() => summarizeBorder(computedStyles.border), [computedStyles.border])
  const borderHasValue = borderSummary !== 'none'
  const handleFillAdd = useCallback(() => {
    applyOverride('background-color', '#ffffff', true)
  }, [applyOverride])
  // Inverse of handleFillAdd — applied via override so `summarizeFill` returns
  // 'transparent' and `fillHasValue` flips false, collapsing the section and
  // re-surfacing the "+" add button in the SectionGroup header. Using override
  // (rather than overrideManager.remove) keeps behavior deterministic regardless
  // of what background the element's natural CSS cascade would reveal.
  const handleFillRemove = useCallback(() => {
    applyOverride('background-color', 'transparent', true)
  }, [applyOverride])
  // Apply one width value to the shorthand AND all 4 per-side longhands.
  //
  // The override manager is a flat `Map<property, value>` with no shorthand
  // awareness: Map iteration order (= insertion order) becomes declaration
  // order in the injected stylesheet (see override.ts rebuild()). Per CSS
  // cascade rules, a longhand declared after a shorthand wins over the
  // shorthand's expansion — and `Map.set` never moves existing keys. That
  // means once `border-top-width` lands in the Map from user per-side edits
  // or a prior minus action, any later write of `border-width` alone gets
  // silently overruled by the stale longhand.
  //
  // Both `handleBorderAdd` and `handleBorderRemove` therefore write all five
  // width properties through this helper. Add/remove become idempotent and
  // symmetric: "+" always paints a uniform 1px border, "-" always fully
  // zeroes every width slot regardless of prior per-side customization.
  const setBorderWidths = useCallback((width: string) => {
    applyOverride('border-width', width, false)
    applyOverride('border-top-width', width, false)
    applyOverride('border-right-width', width, false)
    applyOverride('border-bottom-width', width, false)
    applyOverride('border-left-width', width, false)
  }, [applyOverride])
  // Batch: 7 properties → 1 undo entry. All 5 width properties are written
  // (via setBorderWidths) so any orphan per-side override from a prior
  // remove→add cycle is cleared — otherwise the longhands would win the
  // cascade and the new border would render with the old per-side values.
  const handleBorderAdd = useCallback(() => {
    setBorderWidths('1px')
    applyOverride('border-style', 'solid', false)
    applyOverride('border-color', '#000000', false)
    commitScrub()
  }, [setBorderWidths, applyOverride, commitScrub])
  // Inverse of handleBorderAdd. Symmetric with handleFillRemove: writes
  // explicit 0 values rather than calling overrideManager.remove, so a
  // Tailwind utility class like `border` or `border-t-2` on the element
  // can't resurface through the natural cascade after removal. Style and
  // color are left untouched — minimal surface area, and handleBorderAdd
  // will overwrite them from defaults on the next `+` click.
  const handleBorderRemove = useCallback(() => {
    setBorderWidths('0px')
    commitScrub()
  }, [setBorderWidths, commitScrub])
  const handleEffectAdd = useCallback(() => {
    applyOverride('box-shadow', addShadow(computedStyles.effects.boxShadow), true)
  }, [computedStyles.effects.boxShadow, applyOverride])


  const handleSelectParent = useCallback(() => {
    if (!element) return
    if (element.parentElement && element.parentElement !== document.documentElement) {
      onSelectElement(element.parentElement)
    }
  }, [element, onSelectElement])

  const handleSelectChild = useCallback(() => {
    if (!element) return
    // Skip non-visual children (script/style/title, including an SVG's own),
    // matching both `hasChildren` below and the click path's isNonEditable gate.
    // The old `instanceof HTMLElement` guard made this a no-op on an SVG first
    // child while `hasChildren` still counted it — an ENABLED button that did
    // nothing. Advancing to the first EDITABLE child keeps the two in agreement
    // instead of trading one asymmetry for another.
    const firstChild = Array.from(element.children).find(c => !isNonEditable(c))
    if (firstChild) {
      onSelectElement(firstChild)
    }
  }, [element, onSelectElement])

  const panelClasses = [
    'cortex-panel',
    isEntering && 'cortex-panel--entering',
    isSnapping && 'cortex-panel--snapping',
  ].filter(Boolean).join(' ')

  // Panel is gated at CortexApp level (selectedElements.length > 0 required to
  // mount).  This guard is a TS narrowing aid only — it never fires at runtime.
  if (!element) return null

  const sourceInfo = parseCortexSource(element)
  const tagName = element.tagName.toLowerCase()
  const componentName = sourceInfo?.componentName ?? null
  const sourceFile = sourceInfo?.fileName ?? null
  const sourceLine = sourceInfo?.line ?? null
  const filePath = sourceInfo?.filePath ?? null
  const isLibrary = isLibraryComponent(element)
  const ancestor = isLibrary ? findUserAncestor(element) : null
  const hasParent = element.parentElement !== null && element.parentElement !== document.documentElement
  const hasChildren = Array.from(element.children).some(c => !isNonEditable(c))
  // Typography section only renders for elements that directly render text.
  // Pure container elements have nothing to do in Typography.
  const showTypography = hasTypographyContent(element)
  // Position section is instance-specific — hide when editing a shared class.
  const showPosition = !(sharedInfo && editScope === 'all')

  // ZF0-1470 (T4 C): per-element stale indicator. All controls for the same element
  // share one source path (data-cortex-source), so stale is binary at element level.
  // True when the element's source appears in the staleSources set emitted by
  // CSSOverrideManager.onStale after TTL eviction.
  //
  // Stale prop threading coverage (ZF0-1470 T4):
  //   - PositionSection: covered (receives `stale` directly).
  //   - LayoutSection → SizingControls: covered (stale forwarded through LayoutSection).
  //   - LayoutSection → SpacingControls: covered by this commit (T4 fix-up, IMPORTANT 3).
  //   - Appearance/Border/Effects/Typography/Flex/Grid sections: deferred to follow-up
  //     (ZF0-TBD). Those sections have no NumericInput-level stale indicator yet.
  const elementSource = element.getAttribute('data-cortex-source') ?? ''
  const elementSourceIsStale = elementSource !== '' && (staleSources?.has(elementSource) ?? false)

  return (
    <SpacingTokensContext.Provider value={resolvedSpacingTokens}>
    <div
      class={panelClasses}
      style={{
        transform: `translate(${position.x}px, ${position.y}px)`,
        width: `${PANEL_WIDTH}px`,
      }}
    >
      <PanelHeader
        tagName={tagName}
        componentName={componentName}
        sourceFile={sourceFile}
        sourceLine={sourceLine}
        filePath={filePath}
        onClose={onClose}
        onPointerDown={panelPointerDown}
        onPointerMove={panelPointerMove}
        onPointerUp={panelPointerUp}
        onPointerCancel={panelPointerCancel}
        hasBefore={hasBefore}
        hasAfter={hasAfter}
        activePseudo={activePseudo}
        onPseudoChange={setActivePseudo}
        isLibrary={isLibrary}
        ancestorSource={ancestor?.source.fileName ?? null}
        ancestorLine={ancestor?.source.line ?? null}
        bufferSize={buffer.size()}
        onApply={onApply}
        onApplyError={handleApplyError}
        applyError={applyError}
      />
      {editErrors && element?.getAttribute('data-cortex-source') && (
        <EditErrorCard
          errors={editErrors}
          elementSource={element.getAttribute('data-cortex-source')!}
          agentConnected={agentConnected ?? false}
          onDismiss={(key) => onDismissError?.(key)}
          onAskAI={(error) => {
            if (!channel) {
              console.warn('[cortex] Cannot send fix request: no channel')
              return
            }
            channel.send({
              type: 'comment',
              kind: 'fix-request',
              fixMeta: { property: error.property, value: error.value, reason: error.reason },
              elementSource: error.source,
              text: `${error.property} edit failed: ${error.reason}`,
            })
          }}
        />
      )}
      {sharedInfo && (
        <div class="cortex-panel__scope">
          <span class="cortex-panel__scope-label">
            Shared by {sharedInfo.count} elements
          </span>
          <div
            class="cortex-panel__scope-toggle"
            role="radiogroup"
            aria-label="Editing scope"
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault()
                const next = editScope === 'instance' ? 'all' : 'instance'
                setEditScope(next)
                if (next === 'all') highlightSharedElements(sharedInfo, element)
                else clearHighlights()
              }
            }}
          >
            <button
              type="button"
              class={`cortex-panel__scope-btn ${editScope === 'instance' ? 'cortex-panel__scope-btn--active' : ''}`}
              role="radio"
              aria-checked={editScope === 'instance'}
              tabIndex={editScope === 'instance' ? 0 : -1}
              onClick={() => { setEditScope('instance'); clearHighlights() }}
            >
              This element
            </button>
            <button
              type="button"
              class={`cortex-panel__scope-btn ${editScope === 'all' ? 'cortex-panel__scope-btn--active' : ''}`}
              role="radio"
              aria-checked={editScope === 'all'}
              tabIndex={editScope === 'all' ? 0 : -1}
              onClick={() => { setEditScope('all'); highlightSharedElements(sharedInfo, element) }}
              onMouseEnter={() => { if (editScope !== 'all') highlightSharedElements(sharedInfo, element) }}
              onMouseLeave={() => { if (editScope !== 'all') clearHighlights() }}
            >
              All
            </button>
          </div>
        </div>
      )}
      {sharedSourceInfo && !sharedInfo && (
        <div
          class="cortex-panel__scope cortex-panel__scope--source-only"
          onMouseEnter={() => highlightSharedElements(sharedSourceInfo, element)}
          onMouseLeave={() => clearHighlights()}
        >
          <span class="cortex-panel__scope-label">
            Used by {sharedSourceInfo.count} elements
          </span>
        </div>
      )}
      <div class="cortex-panel__body" ref={bodyRef}>
        {/* ZF0-1470 (T4 fix-up, IMPORTANT 4): Apply error inline banner. Surfaces
            sendAndAck rejections (timeout/disconnect/server error) that PanelHeader
            captures via onApplyError. Placed above StagingDriftBanner so the user
            sees it immediately after an Apply failure, regardless of scroll position.
            Clears on next Apply attempt (in onApply, before sendAndAck) or on dismiss. */}
        {applyError && (
          <div class="cortex-apply-error" role="alert">
            <span>{applyError}</span>
            <button
              type="button"
              onClick={() => setApplyError(null)}
              class="cortex-apply-error__dismiss"
              aria-label="Dismiss apply error"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {/* ZF0-1470 (T4): StagingDriftBanner signals drift between staged edits
            and live source. Placed above sections so it's always visible regardless
            of scroll position. Two independent signals: intent drift (HMR reconcile)
            and stale overrides (TTL eviction from CSSOverrideManager). */}
        <StagingDriftBanner
          intentDriftCount={intentDriftCount}
          staleOverrideCount={staleOverrideCount}
          onIntentRefresh={() => {
            // Re-run reconcile with the current changedFiles to refresh divergent flags
            // for intents that may have been resolved by a subsequent HMR cycle.
            if (hmrChangedFiles.length > 0) {
              const result = buffer.reconcile(
                hmrChangedFiles,
                overrideManager.readSourceValue.bind(overrideManager),
              )
              setIntentDriftCount(result.divergent.length)
            }
          }}
          onStaleRefresh={() => window.location.reload()}
          onDismiss={() => {
            // Banner's internal dismissed state handles visibility.
            // No external state tracking needed per spec.
          }}
        />
        {/* Section ordering per DESIGN.md: Elements → Position → Layout →
            Typography → Appearance → Background → Border → Effects.
            Typography conditional on hasTypographyContent; Position hidden
            in shared-class "All" scope. */}
        <SectionGroup
          label="Elements"
          groupId="elements"
          headerAction={(
            <div class="cortex-elements-header-actions" role="group" aria-label="Element navigation and overlay controls">
              <button
                type="button"
                class="cortex-elements-header-actions__btn"
                data-action="parent"
                disabled={!hasParent}
                data-tooltip="Select parent element"
                aria-label="Select parent element"
                onClick={handleSelectParent}
              >
                <ChevronUp size={14} />
              </button>
              <button
                type="button"
                class="cortex-elements-header-actions__btn"
                data-action="child"
                disabled={!hasChildren}
                data-tooltip="Select child element"
                aria-label="Select child element"
                onClick={handleSelectChild}
              >
                <ChevronDown size={14} />
              </button>
              <button
                type="button"
                class={`cortex-elements-header-actions__btn${hoverEnabled ? '' : ' cortex-elements-header-actions__btn--toggled-off'}`}
                data-action="toggle-hover"
                disabled={!onToggleHover}
                data-tooltip={hoverEnabled ? 'Hide hover overlay' : 'Show hover overlay'}
                aria-label={hoverEnabled ? 'Hide hover overlay' : 'Show hover overlay'}
                aria-pressed={hoverEnabled ? 'true' : 'false'}
                onClick={() => onToggleHover?.()}
              >
                {hoverEnabled ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
            </div>
          )}
        >
          <ElementTree
            element={element}
            onSelectElements={onSelectElements ?? ((els, _action) => onSelectElement(els[0] ?? null))}
            height={layerHeight}
            hmrAppliedVersion={hmrAppliedVersion}
          />
        </SectionGroup>
        <div
          class="cortex-section-resize"
          onPointerDown={handleLayerResizeDown}
          onPointerMove={handleLayerResizeMove}
          onPointerUp={handleLayerResizeUp}
          onPointerCancel={handleLayerResizeUp}
        />
        {showPosition && (
          <SectionGroup label="Position" groupId="position">
            <PositionSection
              values={computedStyles.position}
              onChange={handleCommit}
              onScrub={handleScrub}
              onScrubEnd={handleCommit}
              dimmedProperties={dimmedProperties}
              stale={elementSourceIsStale}
            />
          </SectionGroup>
        )}
        <SectionGroup label="Layout" groupId="layout">
          <LayoutSection
            values={computedStyles.layout}
            onChange={handleCommit}
            onScrub={handleScrub}
            onScrubEnd={handleCommit}
            dimmedProperties={dimmedProperties}
            mixedProperties={mixedProperties}
            spacing={{ padding: computedStyles.spacing.padding, margin: computedStyles.spacing.margin }}
            onSpacingChange={handleCommit}
            onSpacingScrub={handleScrub}
            onSpacingScrubEnd={handleCommit}
            stale={elementSourceIsStale}
          />
        </SectionGroup>
        {showTypography && (
          <SectionGroup label="Typography" groupId="typography">
            <TypographySection
              values={computedStyles.typography}
              availableWeights={availableWeights}
              className={typographyClassName}
              onChange={handleTypographyChange}
              onScrub={handleScrub}
              onScrubEnd={handleCommit}
              swatches={swatches}
              textComponents={textComponents}
              colorChips={colorChips}
              dimmedProperties={dimmedProperties}
              mixedProperties={mixedProperties}
            />
          </SectionGroup>
        )}
        <SectionGroup label="Appearance" groupId="appearance">
          <AppearanceSection
            values={computedStyles.appearance}
            onChange={handleCommit}
            onScrub={handleScrub}
            onScrubEnd={handleCommit}
            dimmedProperties={dimmedProperties}
            mixedProperties={mixedProperties}
            resetKey={`${element.tagName}|${element.id}|${element.getAttribute('data-cortex-source') ?? ''}`}
          />
        </SectionGroup>
        <SectionGroup
          label="Background"
          groupId="background"
          headerAction={
            !fillHasValue ? (
              <IconButton icon={<Plus size={14} />} ariaLabel="Add background" tooltip="Add background color" onClick={handleFillAdd} />
            ) : undefined
          }
        >
          {fillHasValue && (
            <BackgroundSection
              backgroundColor={computedStyles.fill.backgroundColor}
              backgroundToken={extractedUtilities.get('background-color') ?? null}
              onChange={handleBackgroundChange}
              onScrub={handleScrub}
              onScrubEnd={handleCommit}
              onRemove={handleFillRemove}
              swatches={swatches}
              colorChips={colorChips}
              dimmedProperties={dimmedProperties}
              mixedProperties={mixedProperties}
            />
          )}
        </SectionGroup>
        <SectionGroup
          label="Border"
          groupId="border"
          headerAction={
            !borderHasValue ? (
              <IconButton icon={<Plus size={14} />} ariaLabel="Add border" tooltip="Add border" onClick={handleBorderAdd} />
            ) : undefined
          }
        >
          {borderHasValue && (
            <BorderSection
              values={computedStyles.border}
              borderToken={extractedUtilities.get('border-color') ?? null}
              onChange={handleBorderChange}
              onScrub={handleScrub}
              onScrubEnd={handleCommit}
              onRemove={handleBorderRemove}
              swatches={swatches}
              colorChips={colorChips}
              dimmedProperties={dimmedProperties}
              mixedProperties={mixedProperties}
            />
          )}
        </SectionGroup>
        <SectionGroup
          label="Effects"
          groupId="effects"
          headerAction={
            <IconButton icon={<Plus size={14} />} ariaLabel="Add effect" tooltip="Add effect" onClick={handleEffectAdd} />
          }
        >
          <EffectsSection
            // Keyed on the selected element's identity so a selection change
            // remounts EffectsSection fresh — this resets its local UI state
            // (disabledSingletons, expandedId, stashRef). Without the remount,
            // disabling a blur on element A then selecting element B leaves a
            // ghost disabled-blur row on B. The key is stable during a scrub
            // (selection doesn't change mid-gesture), so it never interrupts an
            // in-progress edit.
            key={`${element.tagName}|${element.id}|${element.getAttribute('data-cortex-source') ?? ''}`}
            values={computedStyles.effects}
            onChange={handleCommit}
            onScrub={handleScrub}
            onScrubEnd={handleCommit}
            swatches={swatches}
            dimmedProperties={dimmedProperties}
            mixedProperties={mixedProperties}
          />
        </SectionGroup>
      </div>
      <ConnectionStatusFooter status={connectionStatus} />
    </div>
    </SpacingTokensContext.Provider>
  )
}
