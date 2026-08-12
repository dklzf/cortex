import type { JSX } from 'preact'
import { render as preactRender } from 'preact'
import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import type { CortexChannel, ConnectionDisplay, Annotation, StyleCapability } from '../../adapters/types.js'
import type { EditError } from './EditErrorCard.js'
import { CSSOverrideManager } from '../override.js'
import { onDivergence } from '../override-bus.js'
import { CommandStack } from '../command-stack.js'
import { initSelection } from '../selection.js'
import type { SelectionHandle } from '../selection.js'
import { cortexAppReducer, initialCortexAppReducerState, applySelectionUpdate } from '../cortex-app-reducer.js'
import { resolveSelectionTargets } from '../selection-source-expand.js'
import type { SelectionTargetOptions } from '../selection-source-expand.js'
import { isStyleEdit, isClassEdit } from '../../schemas/pending-edit.js'
import { PREVIEW_SOURCE_ATTR, PREVIEW_SOURCE_PREFIX } from '../preview-source.js'
import type { CortexAppReducerState, CortexAppAction, CortexAppEffect, EditDispatchEntry } from '../cortex-app-reducer.js'
// @ts-ignore — tinykeys has types but exports field doesn't include a "types" condition (TODO: add declare module shim when tinykeys updates)
import { tinykeys } from 'tinykeys'
import { getDeepActiveElement, isInputFocused, isCortexUIFocused, isRealEvent } from '../focus-utils.js'
import { detectStates } from '../state-detector.js'
import type { StateDeclarations, InteractionState } from '../state-detector.js'
import { HoverOverlay } from './HoverOverlay.js'
import { SelectionOverlay } from './SelectionOverlay.js'
import { SecondarySelectionOverlay } from './SecondarySelectionOverlay.js'
import { Panel } from './Panel.js'
import { Toolbar } from './Toolbar.js'
import { CommentPin } from './CommentPin.js'
import { ErrorToast } from './ErrorToast.js'
import { CapabilityBanner } from './CapabilityBanner.js'
import { InactiveTabBanner } from './InactiveTabBanner.js'
import { NoAnnotationsBanner } from './NoAnnotationsBanner.js'
import { TooltipLayer } from './TooltipLayer.js'
import { useDrag } from '../hooks/useDrag.js'
import { useSnapToEdge } from '../hooks/useSnapToEdge.js'
import { useCanvasZoom } from '../hooks/useCanvasZoom.js'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss.js'
import { captureSelectionMetadata, reResolveSelection, shouldRefreshOnHMR, deepQueryAllElements } from '../selection-metadata.js'
import type { SelectionMetadata } from '../selection-metadata.js'
import { dismissTopmostPopover, hasOpenPopover } from '../popover-stack.js'
import { markPageColorChips } from '../page-color-chips.js'
import { useEditStagingBuffer, createPanelSyncEmitter } from '../hooks/useEditStagingBuffer.js'
import type { SyncEmitter } from '../hooks/useEditStagingBuffer.js'

export interface CortexAppProps {
  channel: CortexChannel
  shadowRoot: ShadowRoot
  initialActive?: boolean
}

type ColorChipState = Array<{ name: string; hex: string; aliases?: string[]; source?: 'page' | 'theme' }>

function sameColorChipSources(
  prev: ColorChipState | undefined,
  next: ColorChipState,
): boolean {
  if (!prev || prev.length !== next.length) return false
  for (let i = 0; i < next.length; i++) {
    const a = prev[i]
    const b = next[i]
    if (!a || !b || a.name !== b.name || a.hex !== b.hex || a.source !== b.source) return false
  }
  return true
}

function isCortexHostMutation(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement
  return !!target?.closest('[data-cortex-host]')
}

/**
 * Root component. Wires selection events, overlay rendering,
 * CSS override manager, channel message handling, and panel
 * drag/snap positioning. Canvas zoom hook is wired but currently
 * disabled — preserved for future re-enablement.
 */
export function CortexApp({ channel, shadowRoot, initialActive }: CortexAppProps): JSX.Element | null {
  const [hoveredElement, setHoveredElement] = useState<Element | null>(null)
  const [selectedElements, setSelectedElementsState] = useState<Element[]>([])
  // Back-compat alias — primaryElement for all CSS parsing and existing callsites (ZF0-1195).
  const selectedElement = selectedElements[0] ?? null
  // Monotonic counter bumped on every `hmr-applied` message (ZF0-1292).
  // Flowed to Panel so stylesheet-only source edits (App.css rule changes,
  // @theme token changes, ancestor cascade changes) force a getComputedStyle
  // re-read and shared-class re-detect. The MutationObserver in Panel only
  // sees the selected element's own attributes — it cannot catch these.
  const [hmrAppliedVersion, setHmrAppliedVersion] = useState(0)
  // ZF0-1470 (T4 fix-up, IMPORTANT 1): monotonic counter that bumps on EVERY
  // hmr-applied event, regardless of shouldRefreshOnHMR(). Used by Panel's
  // buffer-reconcile effect so buffered intents on non-selected elements are
  // re-evaluated when their source files change. hmrAppliedVersion is gated on
  // shouldRefresh (selection-awareness); hmrEventVersion is always-bump —
  // reconcile must run for ALL buffered intents, not just those affecting the
  // selected element.
  const [hmrEventVersion, setHmrEventVersion] = useState(0)
  const [swatches, setSwatches] = useState<string[] | undefined>(undefined)
  const [textComponents, setTextComponents] = useState<
    import('../../core/text-components.js').TextComponent[] | undefined
  >(undefined)
  const [colorChips, setColorChips] = useState<ColorChipState | undefined>(undefined)
  const colorChipThemeRef = useRef<ColorChipState | undefined>(undefined)
  const [spacingTokens, setSpacingTokens] = useState<
    import('../../core/tailwind-resolver.js').SpacingToken[] | undefined
  >(undefined)
  const [activeState, setActiveState] = useState<InteractionState>('default')
  const [availableStates, setAvailableStates] = useState<StateDeclarations | undefined>(undefined)
  const [hasBefore, setHasBefore] = useState(false)
  const [hasAfter, setHasAfter] = useState(false)
  const [hoverEnabled, setHoverEnabled] = useState(true)
  const overrideRef = useRef<CSSOverrideManager | null>(null)
  const commandStackRef = useRef<CommandStack | null>(null)
  const flushCommitRef = useRef<(() => void) | null>(null)
  // Suppresses phantom re-edits from Panel re-renders during undo/redo.
  // Set true before undo, cleared via nested setTimeout after Preact re-renders settle.
  // undoGenRef prevents rapid Cmd+Z from clearing the flag too early: only the
  // timeout from the latest undo/redo clears it (earlier ones see a stale generation).
  const undoInProgressRef = useRef(false)
  const undoGenRef = useRef(0)
  const [annotations, setAnnotations] = useState<Map<string, Annotation>>(new Map())
  const [agentConnected, setAgentConnected] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionDisplay>({ status: 'connected' })
  // ZF0-1470 (T4): stale override signals from CSSOverrideManager.onStale (T1 API).
  // staleOverrideCount drives the StagingDriftBanner; staleSources drives per-control
  // stale indicator in sections. Both flow down to Panel.
  const [staleOverrideCount, setStaleOverrideCount] = useState(0)
  const [staleSources, setStaleSources] = useState<Set<string>>(new Set())
  // ZF0-1470 (T4): changedFiles from hmr-applied message — passed to Panel so it can
  // call buffer.reconcile() with the bypass readSourceValue callback.
  const [hmrChangedFiles, setHmrChangedFiles] = useState<string[]>([])
  const [commentMode, setCommentMode] = useState(false)
  const [capabilitySystems, setCapabilitySystems] = useState<StyleCapability[]>([])
  // Set when the adapter rejects this tab's cortex/set-active because another
  // tab is the single active editor. Cleared when this tab becomes active so
  // the banner doesn't linger after the user resolves the conflict by closing
  // or deactivating the other tab.
  const [inactiveTabMessage, setInactiveTabMessage] = useState<string | null>(null)
  // Error tracking: editId → source+property for lookup when edit_status:failed arrives
  const editDispatchRef = useRef<Map<string, { source: string; property: string; value: string }>>(new Map())
  // Active errors keyed by source\0property
  const [editErrors, setEditErrors] = useState<Map<string, EditError>>(new Map())
  // ZF0-1869 Round-1 Fix 1: applyError lifted from Panel. Lives here so it
  // survives Panel unmount (Panel unmounts on deselect; buffer + apply-error
  // must outlive the selection). Cleared on next Apply attempt or user dismiss.
  const [applyError, setApplyError] = useState<string | null>(null)

  /**
   * Remove an error by key — avoids new Map allocation when key is absent.
   * Mirrors the change into reducerStateRef so the next reducer dispatch
   * doesn't reintroduce the cleared key from a stale snapshot.
   */
  const clearEditError = useCallback((key: string): void => {
    setEditErrors(prev => {
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
    if (reducerStateRef.current.editErrors.has(key)) {
      const nextErrors = new Map(reducerStateRef.current.editErrors)
      nextErrors.delete(key)
      reducerStateRef.current = { ...reducerStateRef.current, editErrors: nextErrors }
    }
  }, [])
  const commentModeRef = useRef(false)
  commentModeRef.current = commentMode

  const [active, setActive] = useState(initialActive ?? false)
  const selectionRef = useRef<SelectionHandle | null>(null)
  const selectedElementRef = useRef<Element | null>(null)
  selectedElementRef.current = selectedElement
  // Metadata captured at selection time — survives HMR node replacement
  // and drives the smart-fallback re-resolution (ZF0-1292 architecture
  // review: nth-index + content-hash + shadow-root flag). Null whenever
  // selectedElement is null.
  const selectionMetadataRef = useRef<SelectionMetadata[]>([])
  // ZF0-1804: ref-synced mirror of hmrAppliedVersion for the DCE-gated test
  // hook below. The hook reads ref.current (not closure-captured state) so the
  // returned value is always the latest committed React value. Render-time
  // mirror matches the commentModeRef / selectedElementRef pattern above;
  // gated by __CORTEX_TEST_BUILD__ so esbuild's minifySyntax: true strips the
  // ref-write from production bundles (the consumer — the test hook below —
  // is DCE'd in prod, so the write is dead). The bare `useRef(0)` survives;
  // refs are ~zero-cost and adding a conditional top-level ref would violate
  // the React Rules of Hooks.
  const hmrAppliedVersionRef = useRef(0)
  if (__CORTEX_TEST_BUILD__) hmrAppliedVersionRef.current = hmrAppliedVersion
  const handleExitRef = useRef<(() => void) | null>(null)
  // Mirror of `handleEditDispatch` for the test bridge. The mount effect that
  // installs `__CORTEX_TEST__` runs once with deps `[channel, shadowRoot]`, so
  // capturing `handleEditDispatch` directly there would freeze the first-render
  // closure. Today that closure is stable (deps are `[clearEditError]`), but a
  // future non-stable dep would silently route the bridge through stale state.
  // The thunk pattern (used by `handleExitRef`) keeps the bridge calling the
  // latest closure regardless of how `handleEditDispatch`'s deps evolve.
  const editDispatchHandlerRef = useRef<((editId: string, source: string, property: string, value: string) => void) | null>(null)
  // Test-only: bridge.stageEdit lets e2e specs seed the staging buffer
  // directly (the prod path is buffer.append() inside Panel.commitScrub —
  // only triggered by user slider release). The bridge surface is gated
  // by __CORTEX_TEST_BUILD__ && debugFlag and DCEs cleanly. The
  // stageEditRef + Panel's useEffect cannot be gated (React Rules of
  // Hooks), so they ship as runtime-inert plumbing — the ref defaults to
  // undefined in prod (CortexApp passes `__CORTEX_TEST_BUILD__ ? ref : undefined`
  // as the prop), the useEffect's `if (stageEditRef)` guard short-circuits,
  // ~150 bytes of dead branch. Returns the intentId so specs can inject discard.
  const stageEditRef = useRef<((source: string, property: string, value: string) => string) | null>(null)
  // TEST-ONLY: bridge.commitEdit triggers the full applyOverride → commitScrub →
  // commandStack.record + buffer.append fan-out so e2e specs can exercise undo
  // without going through actual panel UI. Gated identically to stageEditRef.
  const commitEditRef = useRef<((property: string, value: string) => Promise<void>) | null>(null)
  // Hoisted from Panel.tsx — buffer lifetime is now CortexApp-scoped so it
  // survives Panel mount/unmount on selection changes (Task 16) and cortex
  // toggle-off (`if (!active) return null` renders null but doesn't unmount
  // CortexApp). Lifetime matches CortexApp = the tab session.
  const appSyncEmitterRef = useRef<SyncEmitter | null>(null)
  if (appSyncEmitterRef.current === null && channel) {
    appSyncEmitterRef.current = createPanelSyncEmitter(channel)
  }
  const buffer = useEditStagingBuffer(appSyncEmitterRef.current ?? undefined)
  // DCE-gated ref so the test bridge closure can read the current buffer.version
  // without capturing a stale value. Follows the same pattern as hmrAppliedVersionRef.
  const bufferVersionRef = useRef(0)
  if (__CORTEX_TEST_BUILD__) bufferVersionRef.current = buffer.version

  // Exposed outside the useEffect so UI handlers (X-button, Toolbar close) can
  // route through the reducer rather than calling setActive(false) directly.
  // Populated by the mount effect — may be null during first paint when
  // initialActive is true (handleClose has a fallback for that case).
  const dispatchRef = useRef<((action: CortexAppAction) => void) | null>(null)
  // Component-scope mirror of the reducer's state. Component handlers that
  // mutate reducer-owned slices (clearEditError, handleActivityToggle's badge
  // reset, handleExit's safety-net setActive(false)) must keep this in sync,
  // otherwise the next reducer dispatch would overwrite their changes with a
  // stale slice value (Copilot review on PR #84).
  const reducerStateRef = useRef<CortexAppReducerState>({
    ...initialCortexAppReducerState,
    active: initialActive ?? false,
  })

  // ZF0-1804: DCE-gated test hook. Used by the HMR file-list filter test to
  // independently verify the version-bump gate (the
  // `if (shouldRefresh) setHmrAppliedVersion(...)` block inside the hmr-applied
  // handler, distinct from the re-resolve gate further below that calls
  // attemptReResolve). Reads pure React state via a ref — coverage-instrumentation
  // cannot fake state values
  // (the failure mode of the original gcs.mock.calls.length assertion, see
  // ZF0-1564 audit). `__CORTEX_TEST_BUILD__` is inlined directly into the `if`
  // condition (per the load-bearing DCE contract documented in types.ts) so
  // esbuild's `minifySyntax: true` folds the entire branch to dead code and
  // strips the install + cleanup from production bundles. Do NOT rewrite as
  // `if (!__CORTEX_TEST_BUILD__) return` — early-return forms are not
  // reliably folded.
  useEffect(() => {
    if (__CORTEX_TEST_BUILD__) {
      ;(window as unknown as { __cortex_test_get_hmr_applied_version?: () => number })
        .__cortex_test_get_hmr_applied_version = () => hmrAppliedVersionRef.current
      return () => {
        delete (window as unknown as { __cortex_test_get_hmr_applied_version?: () => number })
          .__cortex_test_get_hmr_applied_version
      }
    }
  }, [])

  const refreshPageColorChips = useCallback((): void => {
    const chips = colorChipThemeRef.current
    if (!chips) return
    const next = markPageColorChips(chips)
    setColorChips(prev => sameColorChipSources(prev, next) ? prev : next)
  }, [])

  // Panel positioning
  const { position: panelPosition, isSnapping: panelSnapping, setPosition: setPanelPosition, snap: panelSnap, reset: panelReset } = useSnapToEdge()
  const { handlePointerDown: panelPointerDown, handlePointerMove: panelPointerMove, handlePointerUp: panelPointerUp, handlePointerCancel: panelPointerCancel } = useDrag({
    onDrag(x, y) { setPanelPosition({ x, y }) },
    onDragEnd() { panelSnap() },
  })

  // ZF0-1869 follow-up: on deselect, return the panel to its home position so
  // the next selection opens it at the default spot rather than wherever it was
  // last dragged. layerHeight needs no equivalent reset — it is Panel-local
  // state and Panel unmounts on deselect, so it re-inits to DEFAULT_LAYER_HEIGHT.
  //
  // Codex P2 (post-#142): fire only on the NON-EMPTY → EMPTY transition. The
  // naive `if (length === 0)` body ran on initial mount (length starts at 0)
  // and overwrote the position useSnapToEdge() restored from localStorage,
  // regressing cross-reload position persistence for users who had dragged
  // the panel. The ref tracks the previous length so reset() is bound to a
  // real deselect event, not the initial render.
  const prevSelectedCountRef = useRef(selectedElements.length)
  useEffect(() => {
    const prev = prevSelectedCountRef.current
    prevSelectedCountRef.current = selectedElements.length
    if (prev > 0 && selectedElements.length === 0) panelReset()
  }, [selectedElements.length, panelReset])

  // Canvas zoom (disabled — preserved for future re-enablement)
  useCanvasZoom(false)

  // Selection setter that keeps selectionMetadataRef in sync. Every path
  // that sets a positive selection must go through this helper so the HMR
  // re-resolver has valid metadata. Empty-array paths (exit, escape, failed
  // re-resolve) also clear metadata here.
  // Declared above the mount effect so later readers see it before its
  // first use — avoids the forward-reference ambiguity a reviewer flagged.
  //
  // Accepts (elements, action). Delegates the replace/add/toggle algorithm to
  // the pure helper `applySelectionUpdate` — single source of truth for
  // selection-state algebra. Identity-stable: when the helper returns `prev`
  // (no-op add or replace-with-same-elements), Preact bails out of the
  // re-render and metadata is not re-captured.
  //
  // ZF0-1195 Follow-up A: incoming `elements` are auto-expanded to include
  // every DOM node sharing the same `data-cortex-source` attribute. This makes
  // the editor model honest — JSX inside `.map()` produces N runtime nodes
  // that share one source, and the CSS override layer keys on source, so
  // editing any one of them affects all N. Expanding selection up-front means
  // the UI shows the user the full set their edit will affect, instead of
  // letting them pick a subset that the override layer cannot honor.
  //
  // B4: expansion is now opt-OUT-able. It is correct for style edits, which the
  // override layer applies per source, and wrong for a structural move, which
  // acts on one instance — reordering `.map()` siblings means reordering the
  // underlying array, which is expressible for a single instance in a way a
  // source-keyed CSS rule never is. A caller performing a per-instance
  // operation passes `{ expandShared: false }`; everything else is unchanged.
  const setSelection = useCallback((
    elements: Element[],
    action: 'replace' | 'add' | 'toggle' = 'replace',
    options?: SelectionTargetOptions,
  ): void => {
    const expanded = resolveSelectionTargets(elements, options)
    setSelectedElementsState(prev => {
      const next = applySelectionUpdate(prev, expanded, action)
      if (next !== prev) {
        selectionMetadataRef.current = next.map(el => captureSelectionMetadata(el))
      }
      return next
    })
  }, [])

  // Legacy-compat shim — single element or null → setSelection([], 'replace') or setSelection([el], 'replace').
  // Used by the test bridge, HMR re-resolver, and escape/exit paths that set null.
  const setSelectionWithMetadata = useCallback((el: Element | null): void => {
    setSelection(el ? [el] : [], 'replace')
  }, [setSelection])

  useEffect(() => {
    // Disposal guard for async work (HMR re-resolution timers, rAF callbacks)
    // scheduled from the message handler. When CortexApp unmounts — route
    // change, test teardown — pending timers must not fire state updates
    // against a disposed component. The flag flips in cleanup and is read
    // by attemptReResolve below; timers become no-ops rather than throwing
    // state-update-after-unmount warnings.
    let disposed = false

    // Initialize CSS override manager and command stack
    const overrideManager = new CSSOverrideManager()
    overrideRef.current = overrideManager
    const commandStack = new CommandStack()
    commandStackRef.current = commandStack

    // ZF0-1470 (T4 A1): subscribe to override TTL eviction events. Fires when an
    // applied override passes its 30s TTL without hmr_verified arriving — signals
    // the edit may not have landed on disk. Component-scope setters flow state to
    // Panel's StagingDriftBanner and per-control stale indicators.
    const disposeStale = overrideManager.onStale((staleSet) => {
      setStaleOverrideCount(staleSet.size)
      setStaleSources(new Set(staleSet)) // defensive copy already made by emitStale
    })

    // Initialize selection system. The `setSelection` callback is the ONE
    // point of entry for populating `selectedElements` — the mount effect
    // uses it here, and every keyboard/click handler routes through it.
    // This prevents a new contributor from introducing a fresh selection
    // path that bypasses metadata capture (Round 2 frontend-clink + mts-native finding).
    const selectionHandle = initSelection(
      shadowRoot,
      setHoveredElement,
      setSelection,
    )

    // Debug-only test bridge — dual-gated to close ZF0-1298 (XSS via dev server).
    //
    // `__CORTEX_TEST_BUILD__` is a build-time constant injected by esbuild
    // `define` in tsup.config.ts. Production `npm run build` sets it to `false`;
    // esbuild DCE strips this entire block from the production bundle — the
    // bridge code simply does not exist in customer-shipped bundles, so no
    // runtime flag flip can revive it. `npm run build:test` sets it to `true`,
    // producing the bundle the Playwright harness consumes.
    //
    // `debugFlag` (reading `window.__CORTEX_DEBUG_OVERRIDES__`) is preserved
    // as a defense-in-depth runtime opt-in inside test bundles. Specs arm it
    // explicitly via `setupDebugBridge` in tests/e2e/helpers/bridge.ts.
    //
    // Why dual-gate and not just flip to build-time-only? An attacker who
    // compromises a test fixture still has to flip a second flag to reach
    // the bridge, and `__CORTEX_DEBUG_OVERRIDES__`'s other (legitimate)
    // uses — tracing in override.ts, Debug disclosure in EditErrorCard,
    // debug styles — stay orthogonal to the bridge gate.
    const debugFlag = !!(window as unknown as { __CORTEX_DEBUG_OVERRIDES__?: boolean }).__CORTEX_DEBUG_OVERRIDES__
    if (__CORTEX_TEST_BUILD__ && debugFlag) {
      ;(window as unknown as { __CORTEX_TEST__?: unknown }).__CORTEX_TEST__ = {
        overrideManager: {
          set: overrideManager.set.bind(overrideManager),
          flush: overrideManager.flush.bind(overrideManager),
          trackPendingEdit: overrideManager.trackPendingEdit.bind(overrideManager),
          handleHMRVerified: overrideManager.handleHMRVerified.bind(overrideManager),
          // TEST-ONLY: synchronously insert a stale tuple key (same format as
          // evictStalePendingEdits) and fire emitStale(). Bypasses the 30s TTL
          // + 5s sweep for deterministic Playwright specs. Accesses private
          // fields via cast — acceptable here since this entire block is DCE'd
          // from prod bundles by the build-gate constant fold (see line 244).
          //
          // Idempotency: only fires `emitStale()` when a NEW entry was added,
          // matching production at override.ts (evictStalePendingEdits only
          // emits when at least one entry was newly added). Calling twice with
          // identical args is a single logical state change → single listener
          // notification — required for tests asserting listener-call count.
          _testOnly_evictStale: (source: string, property: string, pseudo?: '::before' | '::after'): void => {
            // priorValuesKey format: `${source}\0${property}\0${pseudo ?? ''}`
            const mgr = overrideManager as unknown as {
              staleEntries: Set<string>
              emitStale(): void
            }
            const key = `${source}\0${property}\0${pseudo ?? ''}`
            const sizeBefore = mgr.staleEntries.size
            mgr.staleEntries.add(key)
            if (mgr.staleEntries.size !== sizeBefore) {
              mgr.emitStale()
            }
          },
        },
        channel,
        selectElement: setSelectionWithMetadata,
        // Expose the page-side `detectStates` call so Playwright specs can
        // exercise browser-only CSSOM branches without making it a public API.
        // The Map-to-object conversion keeps the bridge return value
        // structured-clone friendly.
        detectStates: (el: Element) => {
          const states = detectStates(el)
          return {
            hover: Object.fromEntries(states.hover),
            focus: Object.fromEntries(states.focus),
            active: Object.fromEntries(states.active),
          }
        },
        // Expose the page-side `onDivergence` subscription so Playwright
        // specs can collect divergence events through Node-side callbacks.
        // The bus itself is module-scoped (private), but routing through
        // the bridge is strictly better than leaking events onto window:
        // the surface stays minimal, dual-gated, and keeps the same type
        // contract as the internal subscriber.
        onDivergence,
        // Expose handleEditDispatch so unit tests can seed editDispatchRef
        // without going through the scrub UI path. Routed through
        // `editDispatchHandlerRef` so the bridge always hits the latest
        // closure (mirrors the `handleExitRef` pattern). Throws if called
        // before first render commits — silent no-op would mask test setup
        // bugs where the test calls the bridge before render completes.
        handleEditDispatch: (editId: string, source: string, property: string, value: string) => {
          if (!editDispatchHandlerRef.current) {
            throw new Error('[cortex test bridge] handleEditDispatch called before render committed')
          }
          editDispatchHandlerRef.current(editId, source, property, value)
        },
        // TEST-ONLY: directly append a PendingEdit to Panel's staging buffer.
        // Allows e2e specs to drive the Apply button lifecycle without going through
        // the full scrub UI path. Routed through stageEditRef so Panel always exposes
        // the latest buffer.append instance (same pattern as flushCommitRef).
        //
        // Async because Panel's useEffect populates the ref AFTER first paint —
        // calling stageEdit immediately after waitForBridge resolves can race the
        // useEffect commit. Polls the ref at ~one-rAF cadence with a 2s ceiling
        // (well under Playwright's 10s default test timeout). The previous
        // synchronous version flaked ~1/6 times in suite-level runs because the
        // race depended on natural settling delays in caller code.
        //
        // Returns the intentId so callers can pass it to staged-edits-discard.
        stageEdit: async (source: string, property: string, value: string): Promise<string> => {
          const start = performance.now()
          while (!stageEditRef.current) {
            if (performance.now() - start > 2000) {
              throw new Error('[cortex test bridge] stageEdit timeout — Panel did not mount in 2000ms (was activateDesignMode called?)')
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 16))
          }
          return stageEditRef.current(source, property, value)
        },
        // TEST-ONLY: trigger the full applyOverride → commitScrub → commandStack.record
        // + buffer.append fan-out on the currently selected elements. Unlike stageEdit,
        // this path creates a PropertyEditCommand so the gesture is undoable via Cmd+Z.
        // Routed through commitEditRef (same thunk pattern as stageEditRef) so Panel
        // always exposes the latest applyOverride closure. Polls with a 2s ceiling.
        commitEdit: async (property: string, value: string): Promise<void> => {
          const start = performance.now()
          while (!commitEditRef.current) {
            if (performance.now() - start > 2000) {
              throw new Error('[cortex test bridge] commitEdit timeout — Panel did not mount in 2000ms (was activateDesignMode called?)')
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 16))
          }
          return commitEditRef.current(property, value)
        },
        // TEST-ONLY: expose buffer.list() and buffer.size() directly from
        // CortexApp's hoisted buffer instance (bufferListRef indirection removed
        // in Task 3 — buffer is now owned exclusively by CortexApp).
        buffer: {
          list: () => buffer.list(),
          size: () => buffer.size(),
        },
        // TEST-ONLY: reads buffer.version directly from CortexApp's hoisted buffer
        // instance. Proves CortexApp owns the buffer (not Panel-local). Uses
        // bufferVersionRef (a build-gated ref updated each render) to avoid
        // stale-closure issues — same pattern as hmrAppliedVersionRef.
        getCortexAppBufferVersion: () => bufferVersionRef.current,
        // TEST-ONLY: set multi-element selection via setSelection(elements, 'replace').
        // Allows e2e specs to seed multi-select state without real click interactions.
        // selectElement (above) handles single-element selection via the legacy shim;
        // selectElements is the multi-element version for ZF0-1195 multi-select specs.
        selectElements: (els: Element[]) => setSelection(els, 'replace'),
        // TEST-ONLY: mount a minimal Preact popover (using the production
        // `useOutsideDismiss` hook) into any ParentNode including a genuinely
        // closed ShadowRoot. Exists to exercise the hook's closed-shadow
        // retargeting branch (lines 114-129 in useOutsideDismiss.ts) from a
        // real-Chromium Playwright spec — happy-dom cannot simulate that
        // retargeting faithfully (Test Anti-Pattern #3). Each call returns a
        // fresh closure over new state so multiple mounts in the same test
        // cannot share dismissCount or buttonNode. DCE'd from prod bundles.
        useOutsideDismissKit: {
          mountInRoot: async (root: ParentNode) => {
            let dismissCount = 0
            let buttonNode: HTMLButtonElement | null = null
            const Popover = (): JSX.Element => {
              const ref = useRef<HTMLDivElement>(null)
              useOutsideDismiss(ref, () => { dismissCount++ })
              return (
                <div
                  ref={ref}
                  data-testid="test-popover"
                  style={{
                    position: 'fixed',
                    top: '200px',
                    left: '200px',
                    width: '120px',
                    height: '120px',
                    background: 'rgb(220, 220, 220)',
                  }}
                >
                  <button
                    ref={(n) => { if (n) buttonNode = n }}
                    data-testid="popover-inside-btn"
                    type="button"
                  >
                    inside
                  </button>
                </div>
              )
            }
            const container = document.createElement('div')
            root.appendChild(container)
            preactRender(<Popover />, container)
            // Wait for Preact's post-rAF effect flush so useOutsideDismiss has
            // registered its document listeners before the spec dispatches events.
            // Preact's afterNextFrame schedules effects via
            //   requestAnimationFrame(() => setTimeout(flushAfterPaintEffects))
            // so a single rAF wait is insufficient — effects run in the setTimeout
            // INSIDE the rAF callback. We await rAF then a setTimeout to match
            // Preact's double-deferral, ensuring all useEffect callbacks are
            // registered before the Promise resolves.
            await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)))
            if (!buttonNode) throw new Error('[useOutsideDismissKit] inside button ref never resolved after rAF flush')
            return {
              insideButton: buttonNode,
              dismissCount: () => dismissCount,
              cleanup: () => {
                try {
                  preactRender(null, container)
                } catch (err) {
                  console.error('[useOutsideDismissKit] cleanup render failed — listeners may leak:', err)
                }
                try {
                  container.remove()
                } catch (err) {
                  console.error('[useOutsideDismissKit] container.remove failed:', err)
                }
              },
            }
          },
        },
        // TEST-ONLY: mount a production `<NoAnnotationsBanner />` into any
        // ParentNode so Playwright specs can exercise the MutationObserver
        // self-heal flow with real Chromium delivery. Happy-dom cannot
        // faithfully simulate the Preact effect scheduling × MO timer queue
        // interaction (Test Anti-Pattern #3). Each call returns a fresh
        // closure over a new container so multiple mounts in the same test
        // don't share state. Caller is responsible for stripping existing
        // `[data-cortex-source]` elements BEFORE mounting when testing the
        // "initially visible" path — banner reads `document` globally, not
        // from its mount-parent. DCE'd from prod bundles.
        noAnnotationsBannerKit: {
          mountInRoot: async (root: ParentNode) => {
            const container = document.createElement('div')
            root.appendChild(container)
            preactRender(<NoAnnotationsBanner />, container)
            // Same Preact-scheduler dance as useOutsideDismissKit:
            // rAF → setTimeout ensures the MutationObserver useEffect has
            // registered before the spec dispatches mutations. Preact's
            // afterNextFrame schedules effects via
            //   requestAnimationFrame(() => setTimeout(flushAfterPaintEffects))
            // so a single rAF wait is insufficient — effects run in the
            // setTimeout INSIDE the rAF callback.
            await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)))
            return {
              isVisible: () => container.querySelector('[data-banner-id="no-annotations"]') !== null,
              cleanup: () => {
                try {
                  preactRender(null, container)
                } catch (err) {
                  console.error('[noAnnotationsBannerKit] cleanup render failed — MO may leak:', err)
                }
                try {
                  container.remove()
                } catch (err) {
                  console.error('[noAnnotationsBannerKit] container.remove failed:', err)
                }
              },
            }
          },
        },
      }
    }
    // Start with design mode disabled — don't intercept events until activated
    selectionHandle.setDesignMode(false)
    selectionRef.current = selectionHandle

    // reducerStateRef is component-scope (declared at line ~115) so component
    // handlers can keep it in sync when they bypass dispatch. The mount effect
    // re-uses that ref directly — no separate local copy.

    // Per-slice setters (not a single setState over the whole state) so Preact
    // can bail out per consumer. The reducer's reference-equality discipline
    // makes each `next.X !== prev.X` a meaningful guard rather than a tautology.
    const applyReducerState = (next: CortexAppReducerState, prev: CortexAppReducerState): void => {
      if (next.active !== prev.active) setActive(next.active)
      if (next.swatches !== prev.swatches) setSwatches(next.swatches)
      if (next.textComponents !== prev.textComponents) setTextComponents(next.textComponents)
      if (next.colorChips !== prev.colorChips) {
        colorChipThemeRef.current = next.colorChips
        setColorChips(next.colorChips ? markPageColorChips(next.colorChips) : next.colorChips)
      }
      if (next.spacingTokens !== prev.spacingTokens) setSpacingTokens(next.spacingTokens)
      if (next.capabilitySystems !== prev.capabilitySystems) setCapabilitySystems(next.capabilitySystems)
      if (next.editErrors !== prev.editErrors) setEditErrors(next.editErrors)
      if (next.annotations !== prev.annotations) setAnnotations(next.annotations)
      if (next.agentConnected !== prev.agentConnected) setAgentConnected(next.agentConnected)
    }

    const runEffect = (effect: CortexAppEffect): void => {
      // I4: Guard against effects firing after disposal (e.g., a queued
      // microtask from a channel message that arrived during cleanup).
      if (disposed) return
      switch (effect.type) {
        case 'send':
          channel.send(effect.message)
          return
        case 'log_warning':
          console.warn(effect.message)
          return
        case 'invoke_exit':
          handleExitRef.current?.()
          return
        case 'apply_hmr_verified':
          overrideRef.current?.handleHMRVerified(effect.editId, effect.match, effect.kind)
          return
        default: {
          // Compile-time exhaustiveness — mirrors the reducer's `never` default.
          // Forces TS to error if a new CortexAppEffect variant is added without
          // a matching wiring case here. Runtime throw makes the gap observable
          // even if a cast bypasses TS.
          const _exhaustive: never = effect
          throw new Error(`Unhandled cortex-app effect: ${JSON.stringify(_exhaustive)}`)
        }
      }
    }

    const dispatch = (action: CortexAppAction): void => {
      // I4: Guard against in-flight microtasks after disposal (channel message
      // arrives between disposed=true and unsubscribe taking effect).
      if (disposed) return
      const prev = reducerStateRef.current
      const { state: next, effects } = cortexAppReducer(prev, action)
      if (next !== prev) {
        reducerStateRef.current = next
        applyReducerState(next, prev)
      }
      // Per-effect isolation: a throw in one handler (e.g., channel.send
      // closing mid-flight) must not drop subsequent effects from the same
      // dispatch. log_warning + send for undo_sync_status:failed is the
      // canonical case where order matters and silent drop would be visible.
      for (const effect of effects) {
        try {
          runEffect(effect)
        } catch (err) {
          console.warn('[cortex] runEffect failed', err)
        }
      }
    }
    dispatchRef.current = dispatch

    // editDispatchRef is React-side state; the pure reducer can't read refs,
    // so we snapshot the entry into the action before dispatching. Only consume
    // (delete) the entry on terminal statuses — `writing`/`cancelled` keep the
    // entry alive so the eventual `done`/`failed` can consume it.
    const popDispatchEntry = (editId: string): EditDispatchEntry | undefined => {
      const entry = editDispatchRef.current.get(editId)
      if (entry) editDispatchRef.current.delete(editId)
      return entry
    }

    // Criterion 25 (ZF0-1869): reconcile-on-connect — auto-clear already-landed intents.
    //
    // On reconnect (mcp-session-hello on the no-wipe paths: first-adopt + same-UUID),
    // walk the staging buffer and remove intents whose target element's live value
    // ALREADY equals the intent's target value. This is the 4th outcome safety net
    // of the Change-7 acknowledgement protocol: if Claude crashed or was interrupted
    // between the Edit tool and cortex_acknowledge_source_edit, the intent is stuck
    // in the buffer as a phantom. On the next reconnect this read detects "the edit
    // clearly already landed" and auto-clears the stale intent.
    //
    // IMPORTANT: reads via overrideRef.current.readSourceValue() which bypasses
    // cortex's own !important override stylesheet. Without the bypass, any intent
    // with an active CSS override would always appear "matched" (false positive).
    //
    // Early-return guards:
    //   - overrideRef.current is null until the CSSOverrideManager is initialized
    //     (this useEffect initializes it immediately above, so in practice it's
    //     always set when reconcileOnConnect is called from the message handler —
    //     but null-guard is defensive for tests / strict-mode double-mount).
    //   - buffer.size() === 0: no intents → no work.
    //
    // Element resolution uses deepQueryAllElements (shadow-piercing, same as
    // buffer.reconcile's internal element-index build) to find elements annotated
    // with `data-cortex-source`. Intents whose element is not found in the DOM are
    // not auto-cleared — they're treated as divergent and left for the user to handle.
    const reconcileOnConnect = (): void => {
      const override = overrideRef.current
      if (!override || buffer.size() === 0) return

      // Build source → element index once (O(DOM)) to avoid O(intents × DOM) fan-out.
      // Same first-seen-wins + traversal-order semantics as buffer.reconcile internals.
      const elBySource = new Map<string, Element>()
      for (const el of deepQueryAllElements('[data-cortex-source]')) {
        const src = el.getAttribute('data-cortex-source')
        if (src !== null && !elBySource.has(src)) elBySource.set(src, el)
      }
      // Preview-sourced elements too. Class intents are agent-resolve by
      // construction, so without this they can never be resolved here and a
      // phantom left by an agent that wrote the source but crashed before
      // acknowledging could never be cleared. Empty attribute counts as missing,
      // matching ensurePreviewId.
      for (const el of deepQueryAllElements(`[${PREVIEW_SOURCE_ATTR}]`)) {
        const id = el.getAttribute(PREVIEW_SOURCE_ATTR)
        if (!id) continue
        const src = `${PREVIEW_SOURCE_PREFIX}${id}`
        if (!elBySource.has(src)) elBySource.set(src, el)
      }

      const convergedIds: string[] = []
      for (const edit of buffer.list()) {
        // Match by full source (data-cortex-source includes :line:col).
        const el = elBySource.get(edit.source)
        if (!el) continue  // element not in DOM — leave intent for user to handle

        // Convergence asks "did the live value become what this intent wanted".
        // A structural intent wants a POSITION, not a value, so the question is
        // ill-formed for it and answering it against a property it lacks would
        // be worse than not answering. Left for the user to discard, which is
        // the same conservative direction the exact-match below is chosen for.
        // Positive guard: only a style intent states a property/value pair that
        // can be compared against the live source. `!isStructuralEdit` was correct
        // while there were two kinds and silently admitted class intents when a
        // third arrived.
        // A class intent's convergence question IS answerable, unlike a
        // structural one's: "does the element now carry the class the user
        // asked for". Answer it, so an agent that wrote the source and crashed
        // before acknowledging does not leave a phantom the safety net cannot
        // clear. Same conservative direction as below — only an exact,
        // unambiguous match converges.
        if (isClassEdit(edit)) {
          // A COMPOUND class intent also carries inline property work, and the
          // class half landing says nothing about the other half. Clearing on
          // classList alone would drop the intent while the inline edits are
          // still missing from source — losing a real edit permanently, which is
          // strictly worse than the stale badge this net exists to clean up.
          // Only the pure class-op case is answerable here; leave the rest for
          // the user, the same conservative direction as everything below.
          if (edit.inlineSets?.length || edit.inlineRemoves?.length) continue

          const op = edit.classOp
          const has = (c: string): boolean => el.classList.contains(c)
          const converged =
            op.kind === 'add' ? has(op.add)
            : op.kind === 'remove' ? !has(op.remove)
            : has(op.add) && !has(op.remove)
          if (converged) convergedIds.push(edit.intentId)
          continue
        }

        if (!isStyleEdit(edit)) continue

        const pseudo = edit.pseudo ?? null
        const liveValue = override.readSourceValue(el, edit.property, pseudo).trim()
        // Deliberate exact string-match (not CSSOverrideManager.valuesMatch): this
        // is the conservative direction. A false negative (serialization differs,
        // intent stays) just leaves a stale badge the user can discard; a false
        // positive would silently drop a real pending intent. Favor the former.
        if (liveValue === edit.value.trim()) {
          convergedIds.push(edit.intentId)
        }
      }

      if (convergedIds.length > 0) {
        buffer.remove(convergedIds)
      }
    }

    // Listen-first ordering: subscribe to onMessage BEFORE sending init. The server's
    // hello response is async, so attaching this handler first guarantees it's live
    // when the response arrives. Emitting init before this line would race.
    const unsubscribe = channel.onMessage((msg) => {
      // FIX 5: guard against messages arriving in the unmount window.
      // The `disposed` flag flips in the cleanup callback below; `unsubscribe()`
      // runs in the same cleanup, but messages already enqueued by the transport
      // may still be dispatched between disposed=true and unsubscribe taking effect.
      // Without this guard, those messages would mutate state on a disposed instance.
      if (disposed) return

      // edit_status: ref-lookup before dispatch (impure boundary).
      // The dispatch entry comes from editDispatchRef which is mutable React-side state.
      // We must read AND mutate the ref BEFORE dispatching, so the reducer receives a
      // stable action snapshot.
      if (msg.type === 'edit_status') {
        // Only `done` and `failed` are reducer-modeled. `writing` and `cancelled`
        // pass through silently — and crucially must NOT consume the dispatch
        // entry (a `done` typically follows; the entry must survive). This mirrors
        // the legacy if-chain which only deleted the entry inside done/failed.
        if (msg.status === 'done') {
          dispatch({ type: 'edit_status', status: 'done', editId: msg.editId, dispatch: popDispatchEntry(msg.editId) })
        } else if (msg.status === 'failed') {
          dispatch({ type: 'edit_status', status: 'failed', editId: msg.editId, reason: msg.reason, dispatch: popDispatchEntry(msg.editId) })
        }
        return
      }

      // hmr-applied: STAYS INLINE — out of scope for ZF0-1363 (handled by ZF0-1362's
      // selection-metadata.ts pure functions). The complex HMR re-resolution logic
      // (rAF + setTimeout fan-out, disposal guards, selection-metadata refresh) is
      // not yet modelable as effects-as-data without re-architecting that ticket.
      if (msg.type === 'hmr-applied') {
        overrideRef.current?.onHMRApplied()

        // Defensive: even though the types declare files?: string[], the
        // channel is trusted to enforce the contract. A malformed non-array
        // `files` from a future adapter bug would crash .some() / .map().
        // Normalize to undefined so the downstream gate treats it as "unknown".
        const rawFiles = msg.files
        const files: string[] | undefined = Array.isArray(rawFiles) && rawFiles.every(f => typeof f === 'string')
          ? rawFiles
          : undefined

        // ZF0-1470 (T4 fix-up, IMPORTANT 1): always-bump counter for buffer reconcile.
        // Panel's reconcile effect uses hmrEventVersion (not hmrAppliedVersion) so it
        // fires on every HMR event regardless of selection-awareness. Buffered intents
        // for non-selected elements must be reconciled when their source files change —
        // even when shouldRefreshOnHMR returns false for the selected element.
        setHmrEventVersion(v => v + 1)

        // Gate the Panel refresh (getComputedStyle cascade + detectSharedClasses
        // over full DOM) on whether the changed files can possibly affect the
        // selected element. Skip only when we're confident: server provided a
        // non-empty file list AND no CSS/virtual files AND no ancestor source
        // is in the list (up to 20 levels). Otherwise — absent / empty / typo
        // — err toward refresh. If nothing is selected, there is nothing to
        // refresh (Panel renders empty state, no overlay, no Layer Tree),
        // so skip the version bump outright.
        const shouldRefresh = shouldRefreshOnHMR(files, selectedElementRef.current)
        if (shouldRefresh) {
          setHmrAppliedVersion(v => v + 1)
        }

        // ZF0-1470 (T4 A2): capture changedFiles for Panel's buffer.reconcile() call.
        // Always update — even when shouldRefresh is false — because reconcile uses its
        // own file-intersection logic (stripLineCol on source paths) independently of
        // the DOM-refresh heuristic above. An empty/absent files list is represented
        // as [] so Panel's reconcile early-returns cleanly (changedFiles.length === 0).
        setHmrChangedFiles(files ?? [])

        const attemptRefreshPageColorChips = (): void => {
          if (disposed) return
          refreshPageColorChips()
        }
        attemptRefreshPageColorChips()
        requestAnimationFrame(() => requestAnimationFrame(attemptRefreshPageColorChips))
        setTimeout(attemptRefreshPageColorChips, 100)
        setTimeout(attemptRefreshPageColorChips, 250)

        // Re-resolve the selection after HMR node replacement. Runs
        // synchronously (catches CSS-only / classname-flip cases where the
        // DOM is already committed) AND after double-rAF (catches React
        // Fast Refresh, which schedules DOM commits via the React scheduler
        // past `vite:afterUpdate`'s firing point).
        //
        // Smart-fallback via `reResolveSelection`: primary=nth-index match,
        // secondary=content-search for reorder detection, tertiary=preserve
        // at index for in-place content edits. See selection-metadata.ts.
        // Re-run the resolver against the LIVE DOM. If the saved element is
        // no longer the right answer, swap. This replaces the earlier
        // `isConnected`-gated version — which missed the case where React
        // Fast Refresh defers its DOM commit past the hmr-applied signal,
        // so at that moment the selected node is still connected *in the
        // old DOM tree* that's about to be replaced.
        const attemptReResolve = (): void => {
          // Disposal guard: pending timers/rAFs fire as no-ops after unmount.
          if (disposed) return
          try {
            const current = selectedElementRef.current
            // Re-resolution operates on the primary element (index 0) only.
            // Multi-element re-resolve is intentionally deferred — it will be
            // wired in a later ZF0-1195 task once multi-element gestures
            // actually drive the system. Today the secondary selection slots
            // exist in state but are not exercised by user input.
            const meta = selectionMetadataRef.current[0] ?? null
            if (!current || !meta) return
            const resolved = reResolveSelection(meta)
            if (resolved !== current) {
              // Ref has drifted (element removed, list shrunk, Fast Refresh
              // replaced the node, or content-hash fallback found a better
              // match at a different position). Swap.
              setSelectionWithMetadata(resolved)
              return
            }
            // Same DOM node, but its position in siblings may have shifted
            // (e.g. reorder preserved the Cherry <li> via `key=` but its
            // index changed from 2 → 0). Recapture metadata so the next
            // HMR cycle starts from the correct index.
            if (resolved) {
              const newMeta = captureSelectionMetadata(resolved)
              const indexShifted = newMeta.index !== meta.index
              // Preserve metadata for all elements; only update primary (index 0).
              const updatedMeta = [...selectionMetadataRef.current]
              updatedMeta[0] = newMeta
              selectionMetadataRef.current = updatedMeta
              // If the position drifted, views that cached against the OLD
              // DOM layout (LayerTree's sibling list, SelectionOverlay's
              // position) need to re-read. Bumping hmrAppliedVersion again
              // triggers a fresh Panel render that happens AFTER React Fast
              // Refresh has committed — which the initial bump in the
              // message handler couldn't guarantee because Preact microtasks
              // run before React's scheduler tasks.
              if (indexShifted) {
                setHmrAppliedVersion(v => v + 1)
              }
            }
          } catch (err) {
            console.warn('[cortex] reResolveSelection failed', err)
            setSelectionWithMetadata(null)
          }
        }

        // Gate re-resolution on the same predicate as the version bump
        // (ZF0-1298 follow-up). If the HMR files don't affect our selection,
        // React Fast Refresh can't have swapped the selected DOM node — so
        // `attemptReResolve` has nothing to resolve and its 5 fan-outs
        // (sync + 2 rAFs + 100ms + 250ms setTimeouts) are pure waste.
        // Previously ungated, which meant every HMR event (even unrelated
        // ones) ran reResolveSelection + captureSelectionMetadata against
        // the live DOM. Observable in the "skips Panel refresh when hmr
        // files are fully unrelated" test — the 6 getComputedStyle calls
        // that flaked CI were this ungated work, not the gated refresh.
        if (shouldRefresh) {
          attemptReResolve()
          // Frame-deferred: catches React sync commits + most Fast Refresh commits.
          requestAnimationFrame(() => requestAnimationFrame(attemptReResolve))
          // Scheduler-deferred: React 18's concurrent mode can schedule commits
          // through its priority scheduler beyond 2 rAFs. 100ms is empirically
          // sufficient for typical updates; 250ms is the safety net for slow
          // machines or heavy subtree remounts. Both are bounded and idempotent —
          // if the selection is already settled, each call is a ~microsecond no-op.
          setTimeout(attemptReResolve, 100)
          setTimeout(attemptReResolve, 250)
        }
        return
      }

      // 'error' channel messages aren't reducer-modeled. Other consumers
      // (ErrorToast subscribes to the channel directly) handle them. The legacy
      // if-chain silently fell through; preserve that semantics so the reducer's
      // exhaustive throw doesn't fire on every error message.
      if (msg.type === 'error') return

      // staged-edits-discard: the server discarded one or more intents (via
      // cortex_discard_edits or cortex_acknowledge_source_edit). CortexApp owns
      // the buffer (hoisted from Panel in Task 2), so the handler lives here —
      // NOT in Panel.tsx. Panel unmounts on deselect; if the handler lived in
      // Panel, messages arriving while Panel is unmounted would be silently dropped
      // and the buffer would permanently diverge from the server cache.
      // (ZF0-1869 Round-1 Fix 1)
      if (msg.type === 'staged-edits-discard') {
        buffer.remove(msg.intentIds)
        return
      }

      // staged-edits-acked (ZF0-1469) is consumed by channel.sendAndAck's
      // one-shot listener — it correlates the requestId and resolves the Apply
      // button's pending Promise. Not a CortexAppAction; early-return so the
      // reducer's exhaustive default doesn't fire and log on every Apply.
      if (msg.type === 'staged-edits-acked') return

      // source-edit-failed (ZF0-1869 Change 7): the Edit-tool agent failed to
      // land a needs-source-edit intent. CortexApp owns applyError state (lifted
      // from Panel in Round-1 Fix 1) so the error banner survives Panel remounts.
      // The intent stays in the buffer so the designer can retry or discard.
      if (msg.type === 'source-edit-failed') {
        // msg.intentIds is intentionally not consumed here. The single applyError banner
        // showing msg.reason is the v1 signal — per-intent failure highlighting is a
        // tracked follow-up, not in scope for this PR (ZF0-1869).
        setApplyError(msg.reason)
        return
      }

      // mcp-session-hello: the MCP server announces a process-scoped UUID.
      // DELIBERATELY NO buffer.clear() here (0.3.1): the wipe formerly keyed on a
      // UUID change, but Claude Code spawns a fresh `cortex mcp` process — fresh
      // UUID — per conversation, so every Claude restart (and every interleaved
      // hello from two concurrent Claude clients) destroyed staged-but-unapplied
      // work. The designer's session is THIS page's lifetime (the buffer is
      // memory-only — a genuinely new session starts empty on its own), so no
      // MCP-process identity can justify a destructive clear. Every hello runs
      // reconcileOnConnect(): a restarted Claude may have landed intents via the
      // Edit tool before dying, and transient reconnects (sleep/wake, WiFi flap)
      // may have converged intents while MCP was disconnected — reconcile clears
      // exactly the intents whose edits are verifiably in source, nothing more.
      // (Side-effect, accepted: a stale apply-error banner now persists across
      // Claude restarts — consistent, since the intent it refers to persists too.)
      if (msg.type === 'mcp-session-hello') {
        reconcileOnConnect()
        return
      }

      // Pillar 1: server-authoritative activation broadcast. May be addressed
      // to one tab in single-tab mode — filter on targetTabId.
      if (msg.type === 'cortex/active-changed') {
        const tabId = window.__cortex_tab_id__
        if (msg.targetTabId && msg.targetTabId !== tabId) return
        // Update the keyboard-handler cache before the reducer dispatch so
        // the next keystroke flips the right state.
        if (window.__cortex_active_cache__) {
          ;(window.__cortex_active_cache__ as { active: boolean }).active = msg.active
        }
        // Becoming active in this tab resolves any standing inactive-tab
        // notice — the conflict is gone, so the banner should not linger.
        if (msg.active) setInactiveTabMessage(null)
        // Dispatch through the unified set-active reducer action (Chunk A).
        dispatch({ type: 'set-active', active: msg.active })
        return
      }

      if (msg.type === 'cortex/inactive-tab') {
        const tabId = window.__cortex_tab_id__
        if (msg.targetTabId !== tabId) return
        // Console for log archeology; banner for the designer who actually
        // hit this. Banner clears when this tab next becomes active.
        console.warn('[cortex]', msg.message)
        setInactiveTabMessage(msg.message)
        return
      }

      // After the early returns above (edit_status, hmr-applied, error), `msg.type`
      // matches a CortexAppAction discriminant. The cast is a forcing cast — TS
      // does not narrow ServerToBrowser to CortexAppAction across the assignment.
      // The reducer's exhaustive `never` default is the runtime safety net: any
      // new ServerToBrowser variant not modeled by CortexAppAction will throw at
      // dispatch time, surfacing the drift in CI.
      dispatch(msg as CortexAppAction)
    })

    // Handshake signal — server responds with 'hello' carrying swatches + design-system
    // data. Placed AFTER onMessage subscription above so the response is guaranteed
    // to reach the handler. Idempotent on the server, so strict-mode double-mount
    // and HMR re-mount both work without special-casing.
    channel.send({ type: 'init', sessionId: window.__CORTEX_SESSION_ID__, tabId: window.__cortex_tab_id__ })

    // Track whether we were disconnected for the "reconnected" flash
    let wasDisconnected = false
    let reconnectedTimer: ReturnType<typeof setTimeout> | undefined

    const unsubStatus = channel.onConnectionChange((state) => {
      if (state.status === 'connected' && wasDisconnected) {
        // ZF0-1869 follow-up: on reconnect, re-establish the server's
        // StagedEditsCache from the browser-canonical buffer. Per-mutation sync
        // messages (staged-edit-add/-remove/-clear) sent while the socket was
        // down are lost, so the server cache can be stale in BOTH directions:
        // missing adds AND retaining removes. mergeFullSync alone only fixes the
        // former (it upserts, never deletes), which would leave a discarded-
        // while-disconnected intent as a server-side ghost that MCP could apply.
        // So we clear-then-set: syncClear() empties the server cache, then
        // syncFullState() repopulates it with exactly the current buffer.
        // WebSocket preserves in-connection message order, so this is an
        // authoritative replace. Multi-tab safe: the multi-tab hazard documented
        // on StagedEditsCache.mergeFullSync was localStorage rehydration, which
        // is dead since the buffer became memory-only. buffer.list() delegates
        // to a stable bufferRef, so reading it from this mount-time effect
        // closure is not stale.
        appSyncEmitterRef.current?.syncClear()
        appSyncEmitterRef.current?.syncFullState(buffer.list())
        // Transition from disconnected/reconnecting → connected = "reconnected" flash
        setConnectionStatus({ status: 'reconnected' })
        if (reconnectedTimer !== undefined) clearTimeout(reconnectedTimer)
        reconnectedTimer = setTimeout(() => {
          setConnectionStatus({ status: 'connected' })
          reconnectedTimer = undefined
        }, 2000)
        wasDisconnected = false
      } else {
        if (state.status === 'reconnecting' || state.status === 'disconnected') {
          wasDisconnected = true
        }
        setConnectionStatus(state)
        // If we were showing "reconnected" but connection drops again, cancel the auto-dismiss
        if (reconnectedTimer !== undefined) {
          clearTimeout(reconnectedTimer)
          reconnectedTimer = undefined
        }
      }
    })

    // Override divergence → Panel error card. Fires when the browser-side verifier
    // determines the source write succeeded per the server but the DOM didn't
    // reflect the expected value (e.g., React Fast Refresh skipped the element).
    // Dispatched through the reducer so editErrors is a single source of truth.
    const unsubDivergence = onDivergence((d) => dispatch({ type: 'divergence', diagnostic: d }))

    return () => {
      disposed = true
      unsubscribe()
      unsubStatus()
      unsubDivergence()
      disposeStale()
      if (reconnectedTimer !== undefined) clearTimeout(reconnectedTimer)
      selectionHandle.cleanup()
      selectionRef.current = null
      overrideManager.dispose()
      overrideRef.current = null
      commandStack.clear()
      commandStackRef.current = null
      dispatchRef.current = null
      // Clear the debug bridge so a remount (strict mode, HMR, route change)
      // doesn't leave a stale reference to the now-disposed overrideManager.
      // Dual-gate matches the install site — in production bundles this
      // `if` block is DCE'd by esbuild `minifySyntax`. The `debugFlag` read
      // on mount (~line 177) survives DCE (constant folding doesn't remove
      // unused `const` declarations), but the read is side-effect-free
      // (boolean coercion only) and never touches `window.__CORTEX_TEST__`.
      if (__CORTEX_TEST_BUILD__ && debugFlag) {
        delete (window as unknown as { __CORTEX_TEST__?: unknown }).__CORTEX_TEST__
      }
    }
  }, [channel, shadowRoot])

  useEffect(() => {
    let raf: number | null = null
    const scheduleRefresh = (): void => {
      if (raf !== null) return
      raf = requestAnimationFrame(() => {
        raf = null
        refreshPageColorChips()
      })
    }
    const handleMutations = (records: MutationRecord[]): void => {
      if (records.some((record) => !isCortexHostMutation(record))) {
        scheduleRefresh()
      }
    }

    const observer = new MutationObserver(handleMutations)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    if (document.body) {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
        subtree: true,
      })
    }

    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [refreshPageColorChips])

  // Detect interaction states and pseudo-elements on element selection change
  useEffect(() => {
    // Always clear state overrides when selection changes (even to another element)
    overrideRef.current?.clearStateOverrides()

    if (!selectedElement) {
      setAvailableStates(undefined)
      setActiveState('default')
      setHasBefore(false)
      setHasAfter(false)
      return
    }

    // Detect available interaction states via CSSOM inspection
    const states = detectStates(selectedElement)
    setAvailableStates(states)
    setActiveState('default')

    // Detect pseudo-elements
    const beforeContent = getComputedStyle(selectedElement, '::before').content
    const afterContent = getComputedStyle(selectedElement, '::after').content
    setHasBefore(beforeContent !== 'none' && beforeContent !== '')
    setHasAfter(afterContent !== 'none' && afterContent !== '')

    // 6.3: Auto-scroll — bring off-viewport elements into view
    const rect = selectedElement.getBoundingClientRect()
    const offScreen = rect.top < 0 || rect.bottom > window.innerHeight ||
                      rect.left < 0 || rect.right > window.innerWidth
    if (offScreen) {
      selectedElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [selectedElement])

  // Handle state changes from the lens overlay
  const handleStateChange = useCallback((state: InteractionState) => {
    const manager = overrideRef.current
    if (!manager || !selectedElement) return

    if (state === 'default') {
      manager.clearStateOverrides()
      setActiveState(state)
    } else if (availableStates) {
      const declarations = availableStates[state]
      if (declarations.size > 0) {
        const source = selectedElement.getAttribute('data-cortex-source')
        if (source) {
          manager.setStateOverrides(source, declarations)
          setActiveState(state)
        } else {
          console.warn('[cortex] Cannot force state: element missing data-cortex-source')
        }
      }
    }
  }, [selectedElement, availableStates])

  const handleCommentMode = useCallback(() => setCommentMode(m => !m), [])
  const handleCommentReply = useCallback((annotationId: string, text: string) => {
    channel.send({ type: 'comment-reply', annotationId, text })
  }, [channel])

  const handleSelectElement = useCallback(
    (el: Element | null) => setSelectionWithMetadata(el),
    [setSelectionWithMetadata],
  )
  const handleToggleHover = useCallback(() => setHoverEnabled(v => !v), [])

  const handleEditDispatch = useCallback((editId: string, source: string, property: string, value: string) => {
    const map = editDispatchRef.current
    if (map.size >= 500) {
      // Evict oldest entry to prevent unbounded growth if server never responds
      const firstKey = map.keys().next().value
      if (firstKey) map.delete(firstKey)
    }
    map.set(editId, { source, property, value })
    // A new edit supersedes any prior divergence card for the same source+property.
    // Without this, a stale divergence from the previous edit would persist through
    // the new edit's lifecycle and mislead the user.
    clearEditError(`${source}\0${property}`)
  }, [clearEditError])
  editDispatchHandlerRef.current = handleEditDispatch

  const handleDismissError = clearEditError

  // Exit handler — notify server, deactivate.
  // Called by the invoke_exit effect (which fires when the reducer processes a
  // cortex-close action). The setActive(false) + reducerStateRef sync below is
  // a safety net for paths that reach handleExit without going through dispatch
  // (e.g., handleClose's first-paint fallback when dispatchRef isn't yet
  // populated). The normal path already has active: false in reducer state by
  // this point, so the sync is a no-op there.
  const handleExit = useCallback(() => {
    setCommentMode(false)
    setSelectionWithMetadata(null)
    setActive(false)
    reducerStateRef.current = { ...reducerStateRef.current, active: false }
    channel.send({ type: 'cortex-closed' })
  }, [channel, setSelectionWithMetadata])
  handleExitRef.current = handleExit

  // Close handler for UI elements (X-button, Toolbar close).
  // Routes through the reducer so reducerStateRef.active stays in sync —
  // preventing the close→reopen desync where cortex-close left active: true
  // in the reducer ref while React state was false (C1 fix, ZF0-1363).
  // First-paint fallback: dispatchRef is populated inside the mount useEffect.
  // When initialActive is true the toolbar renders before the effect fires, so
  // a click on the close button can race with mount. Falling back to handleExit
  // (which keeps reducerStateRef in sync) makes early closes deactivate
  // correctly without reintroducing the C1 desync (Copilot review on PR #84).
  const handleClose = useCallback(() => {
    if (dispatchRef.current) {
      dispatchRef.current({ type: 'cortex-close' })
      return
    }
    handleExit()
  }, [handleExit])

  // Cascading Escape — capture phase for host app compat
  useEffect(() => {
    if (!active) return
    function handleEscape(e: KeyboardEvent): void {
      if (!isRealEvent(e)) return
      if (e.key !== 'Escape') return

      // Priority 1: Blur focused input inside Cortex UI.
      // Skip when a popover is open — TokenPresetPopover (and any future popover
      // anchored to an input) keeps focus on the input via onMouseDown
      // preventDefault so picks don't blur-commit prematurely. If we still
      // blurred here, the user would need TWO Escape presses to close the
      // popover (first press blurs input, second press dismisses popover).
      // Letting Priority 2.5 dismiss the popover first matches the LIFO
      // expectation: Escape closes the topmost interactive layer.
      if (isCortexUIFocused() && !hasOpenPopover()) {
        const focused = getDeepActiveElement()
        if (focused instanceof HTMLElement) {
          const tag = focused.tagName.toLowerCase()
          if (tag === 'input' || tag === 'textarea' || tag === 'select' || focused.isContentEditable) {
            focused.blur()
            e.stopPropagation()
            e.preventDefault()
            return
          }
        }
      }

      // Skip if user is focused on a host app input — let browser/host handle it
      if (isInputFocused() && !isCortexUIFocused()) return

      // Priority 2: Exit comment mode
      if (commentModeRef.current) {
        setCommentMode(false)
        e.stopPropagation()
        e.preventDefault()
        return
      }

      // Priority 2.5: Dismiss the topmost open popover (chip picker, etc.)
      // before falling through to deselect. Without this, one Escape press
      // would collapse two UI layers — close the picker AND deselect the
      // element — which users reported as "Escape closes the panel."
      if (dismissTopmostPopover()) {
        e.stopPropagation()
        e.preventDefault()
        return
      }

      // Priority 3: Deselect element
      if (selectedElementRef.current) {
        setSelectionWithMetadata(null)
        e.stopPropagation()
        e.preventDefault()
        return
      }

      // Priority 4: Deactivate Cortex (re-added per ZF0-1869, reversing finding H5).
      //
      // Reaching here means nothing earlier in the cascade consumed the Esc — no
      // Cortex/host input focused, no comment mode, no open popover, no selected
      // element. In that case Esc deactivates Cortex. From the idle state (Cortex
      // active, nothing selected) this is a SINGLE Esc press. From a selected-element
      // state it takes two presses — the first hits Priority 3 and deselects, the
      // second reaches Priority 4 and closes — but that is a side effect of the
      // cascade order, NOT a uniform two-press guarantee.
      //
      // This single-press-when-idle behavior is the spec's intent: spec §4's Esc
      // cascade says "Esc while Cortex active, no input focused → Cortex deactivates."
      //
      // It reverses architecture-review finding H5, which removed Esc-to-close to
      // prevent accidental close back when the panel was always-on chrome. The
      // reversal is a deliberate product decision: keyboard-only close is a required
      // affordance. The spec's Risks section logs H5's accidental-close / host-app
      // Esc-collision concern as a KNOWN, ACCEPTED tradeoff to be validated in demo
      // testing — if a real collision emerges there, the guard is narrowed further.
      handleClose()
      e.stopPropagation()
      e.preventDefault()
    }

    window.addEventListener('keydown', handleEscape, { capture: true })
    return () => window.removeEventListener('keydown', handleEscape, { capture: true })
  }, [active])

  // tinykeys keyboard shortcuts — bubble phase, guarded
  useEffect(() => {
    if (!active) return

    function guardSingleKey(handler: () => void): (e: KeyboardEvent) => void {
      return (e: KeyboardEvent) => {
        if (!isRealEvent(e)) return
        if (isInputFocused() || isCortexUIFocused()) return
        handler()
      }
    }

    function guardModifier(handler: () => void): (e: KeyboardEvent) => void {
      return (e: KeyboardEvent) => {
        if (!isRealEvent(e)) return
        // Block when a host-app input is focused (allow native text undo).
        // Allow when a cortex panel input is focused (Cmd+Z should undo edits).
        if (isInputFocused() && !isCortexUIFocused()) return
        // Prevent browser native text undo/redo in cortex inputs — otherwise
        // it changes the input value, sets userTypedRef, and triggers a phantom
        // edit on blur that conflicts with the cortex undo.
        e.preventDefault()
        handler()
      }
    }

    const unsubscribe = tinykeys(window, {
      'v': guardSingleKey(() => setCommentMode(false)),
      'c': guardSingleKey(() => setCommentMode(m => !m)),
      '$mod+z': guardModifier(() => {
        if (isCortexUIFocused()) {
          const activeEl = getDeepActiveElement()
          if (activeEl instanceof HTMLElement) activeEl.blur()
        }
        flushCommitRef.current?.()
        undoInProgressRef.current = true
        // Preact batches re-renders via setTimeout (macrotask), which fires AFTER
        // requestAnimationFrame. Use nested setTimeout so the flag outlives the
        // Preact re-render that triggers phantom onChange from sections.
        // Generation counter ensures rapid Cmd+Z doesn't clear the flag too early:
        // only the timeout from the latest undo/redo actually clears it.
        const gen = ++undoGenRef.current
        setTimeout(() => setTimeout(() => {
          if (undoGenRef.current === gen) undoInProgressRef.current = false
        }))
        try {
          const cmd = commandStackRef.current?.undo()
          if (cmd) {
            overrideRef.current?.flush()
            // Only send to server if the popped command had a server-side
            // counterpart. Buffer-only PropertyEditCommands (post-pivot)
            // would silently pop an unrelated classOp/comment entry on the
            // server stack, corrupting server-side undo history.
            if (cmd.hasServerEntry) {
              channel.send({ type: 'undo' })
            }
          }
        } catch (err) {
          console.error('[cortex] Undo failed:', err)
        }
      }),
      '$mod+Shift+z': guardModifier(() => {
        if (isCortexUIFocused()) {
          const activeEl = getDeepActiveElement()
          if (activeEl instanceof HTMLElement) activeEl.blur()
        }
        flushCommitRef.current?.()
        undoInProgressRef.current = true
        const gen = ++undoGenRef.current
        setTimeout(() => setTimeout(() => {
          if (undoGenRef.current === gen) undoInProgressRef.current = false
        }))
        try {
          const cmd = commandStackRef.current?.redo()
          if (cmd) {
            overrideRef.current?.flush()
            if (cmd.hasServerEntry) {
              channel.send({ type: 'redo' })
            }
          }
        } catch (err) {
          console.error('[cortex] Redo failed:', err)
        }
      }),
    })

    return unsubscribe
  }, [active, channel])

  // setDesignMode must track active — selection events are otherwise unblocked when inactive
  useEffect(() => {
    selectionRef.current?.setDesignMode(active)
    if (active) {
      document.documentElement.setAttribute('data-cortex-active', '')
    } else {
      document.documentElement.removeAttribute('data-cortex-active')
    }
  }, [active])

  if (!active) return null

  return (
    <>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9998, pointerEvents: 'none', display: 'flex', flexDirection: 'column' }}>
        <NoAnnotationsBanner />
        <CapabilityBanner systems={capabilitySystems} />
        <InactiveTabBanner message={inactiveTabMessage} />
        <ErrorToast channel={channel} />
      </div>
      <TooltipLayer shadowRoot={shadowRoot} />
      {/* Wrapper shifts toolbar + every position:fixed UI down by the
          banner's measured height when visible. The transform turns this div
          into the containing block for fixed-positioned descendants (CSS
          spec quirk), so toolbar/hover/selection/panel all reposition
          relative to the wrapper instead of the viewport.
          Critical: --cx-banner-transform falls back to `none` (not
          `translateY(0px)`) when the banner is hidden. `translateY(0px)`
          still creates a containing block per CSS spec, which changes how
          fixed-positioned descendants resolve and produces intra-file test
          pollution in cortex-app.test.tsx. With `none`, no containing block
          forms when banner is hidden — wrapper becomes a plain pass-through.
          Trade-off: during the 200ms dismiss animation, fixed-positioned
          descendants (e.g., dropdown popovers) are coordinate-stable
          relative to the wrapper, but if floating-ui-style positioning
          recomputes against viewport mid-animation, popover position can
          be momentarily off. Bounded: banner is visible only when count=0,
          which means no panel selection (silent filter blocks selection),
          which means no dropdown can open. */}
      <div style={{ transform: 'var(--cx-banner-transform, none)', transition: 'transform 200ms ease-out' }}>
      <HoverOverlay element={hoverEnabled ? hoveredElement : null} />
      <SelectionOverlay
        element={selectedElement}
        availableStates={availableStates}
        activeState={activeState}
        onStateChange={handleStateChange}
        overlaysVisible={hoverEnabled}
        hmrAppliedVersion={hmrAppliedVersion}
      />
      {/* ZF0-1195: render an outline for each non-primary selected element so
          the user can see the full multi-selection. Primary already gets the
          full overlay above (with label + state lens). */}
      {selectedElements.slice(1).map((el, idx) => (
        <SecondarySelectionOverlay
          key={idx}
          element={el}
          overlaysVisible={hoverEnabled}
          hmrAppliedVersion={hmrAppliedVersion}
        />
      ))}
      {overrideRef.current && selectedElements.length > 0 && (
        <Panel
          selectedElements={selectedElements}
          overrideManager={overrideRef.current}
          commandStack={commandStackRef.current}
          flushCommitRef={flushCommitRef}
          stageEditRef={__CORTEX_TEST_BUILD__ ? stageEditRef : undefined}
          commitEditRef={__CORTEX_TEST_BUILD__ ? commitEditRef : undefined}
          undoInProgressRef={undoInProgressRef}
          onClose={handleClose}
          onSelectElement={handleSelectElement}
          onSelectElements={setSelection}
          swatches={swatches}
          textComponents={textComponents}
          colorChips={colorChips}
          spacingTokens={spacingTokens}
          activeState={activeState}
          hasBefore={hasBefore}
          hasAfter={hasAfter}
          hoverEnabled={hoverEnabled}
          onToggleHover={handleToggleHover}
          position={panelPosition}
          isSnapping={panelSnapping}
          panelPointerDown={panelPointerDown}
          panelPointerMove={panelPointerMove}
          panelPointerUp={panelPointerUp}
          panelPointerCancel={panelPointerCancel}
          channel={channel}
          agentConnected={agentConnected}
          connectionStatus={connectionStatus}
          editErrors={editErrors}
          onEditDispatch={handleEditDispatch}
          onDismissError={handleDismissError}
          hmrAppliedVersion={hmrAppliedVersion}
          hmrEventVersion={hmrEventVersion}
          hmrChangedFiles={hmrChangedFiles}
          staleOverrideCount={staleOverrideCount}
          staleSources={staleSources}
          buffer={buffer}
          applyError={applyError}
          onSetApplyError={setApplyError}
        />
      )}
      {/* Toolbar's X button was removed in favor of Esc-to-deactivate
          (cascading Escape handler Priority 4 already calls handleClose
          when nothing else consumed the key). handleClose stays alive
          and reachable via Esc. */}
      <Toolbar
        commentMode={commentMode}
        onCommentMode={handleCommentMode}
      />
      <CommentPin
        annotations={[...annotations.values()]}
        commentMode={commentMode}
        channel={channel}
        onReply={handleCommentReply}
      />
      </div>
    </>
  )
}
