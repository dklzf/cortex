/**
 * Pure reducer for CortexApp message-handling logic.
 *
 * Extracted from the inline if-chain in the channel.onMessage handler in
 * CortexApp.tsx and the onDivergence subscriber in CortexApp.tsx, and now
 * wired into CortexApp.tsx for those update paths without changing
 * production behaviour.
 *
 * Follows the selection-metadata.ts module conventions:
 * - Named exports only (no default export)
 * - JSDoc on every exported symbol
 * - No imports from preact/react — framework-agnostic
 * - Type-only imports separated from value imports
 */

import type { Annotation, ActivityEntry, BrowserToServer, EditKind, StyleCapability } from '../adapters/types.js'
import type { TextComponent } from '../core/text-components.js'
import type { SpacingToken } from '../core/tailwind-resolver.js'
import type { EditError } from './components/EditErrorCard.js'
import type { OverrideDivergence } from './override-bus.js'

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/** Shape of each entry in the editDispatch ref in CortexApp.tsx.
 *  Defined locally because no shared type exists yet; Sub B may consolidate. */
export interface EditDispatchEntry {
  source: string
  property: string
  value: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Maximum number of activity entries retained in state. */
export const MAX_ACTIVITY_ENTRIES = 200

/** Full immutable state managed by `cortexAppReducer`. */
export interface CortexAppReducerState {
  /** Whether the Cortex panel is currently open. */
  active: boolean
  /** Flat hex list of design-system colour swatches (undefined = not yet received). */
  swatches: string[] | undefined
  /** Typography bundles from the `hello` handshake (undefined = not yet received). */
  textComponents: TextComponent[] | undefined
  /** Named colour chips from the `hello` handshake (undefined = not yet received). */
  colorChips: Array<{ name: string; hex: string; aliases?: string[]; source?: 'page' | 'theme' }> | undefined
  /** Spacing tokens detected by TailwindResolver (undefined = not yet received).
   *  Populated by the `hello` handshake. Storing in reducer state — vs. a
   *  side-channel useTokenSubscription hook — closes the race where Panel
   *  mounts AFTER the initial hello fires (which happens reliably on fast-
   *  booting projects). Mirrors the swatches/colorChips/textComponents pattern. */
  spacingTokens: SpacingToken[] | undefined
  /** Non-supported styling systems — filtered from `capabilities` messages. */
  capabilitySystems: StyleCapability[]
  /** Monotonic counter bumped on every successful edit and activity-entry. */
  activityCount: number
  /** Active edit errors keyed by `source\0property` or `source\0property\0pseudo`. */
  editErrors: Map<string, EditError>
  /** Annotations keyed by annotation id. */
  annotations: Map<string, Annotation>
  /** Whether the agent (Claude Code) is currently connected. */
  agentConnected: boolean
  /** Ring-buffer of recent activity entries, capped at MAX_ACTIVITY_ENTRIES. */
  activityEntries: ActivityEntry[]
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Discriminated union of all actions the reducer handles.
 *
 * Each action variant corresponds to one branch of the channel.onMessage
 * handler in CortexApp.tsx, plus the onDivergence subscriber in CortexApp.tsx.
 */
export type CortexAppAction =
  | { type: 'cortex' }
  | { type: 'cortex-close' }
  | { type: 'cortex-toggle'; active: boolean }
  | { type: 'set-active'; active: boolean }
  | { type: 'capabilities'; systems: StyleCapability[] }
  | {
      type: 'hello'
      swatches?: string[]
      textComponents?: TextComponent[]
      colorChips?: Array<{ name: string; hex: string; aliases?: string[]; source?: 'page' | 'theme' }>
      spacingTokens?: SpacingToken[]
    }
  | { type: 'edit_status'; status: 'done'; editId: string; dispatch?: EditDispatchEntry }
  | {
      type: 'edit_status'
      status: 'failed'
      editId: string
      reason?: string
      dispatch?: EditDispatchEntry
    }
  | { type: 'hmr_verified'; editId: string; match: boolean; kind: EditKind | undefined }
  | {
      type: 'undo_sync_status' | 'redo_sync_status'
      status: 'failed' | 'done'
      reason?: string
      reason_code?: string
    }
  | { type: 'annotation-created'; annotation: Annotation }
  | { type: 'annotation-updated'; annotation: Annotation }
  | { type: 'annotations-snapshot'; annotations: Annotation[] }
  | { type: 'agent-status'; connected: boolean }
  | { type: 'activity-entry'; entry: ActivityEntry }
  | { type: 'divergence'; diagnostic: OverrideDivergence }

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/** Side-effects produced by the reducer.
 *
 * The wiring layer (Sub B) interprets each effect and executes it.
 * The reducer itself is pure — it never calls channel.send() or console.warn().
 */
export type CortexAppEffect =
  | { type: 'send'; message: BrowserToServer }
  | { type: 'log_warning'; message: string }
  | { type: 'invoke_exit' }
  | { type: 'apply_hmr_verified'; editId: string; match: boolean; kind: EditKind | undefined }

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

/** Zero-value state. Mirrors the useState() initialisers in CortexApp.tsx. */
export const initialCortexAppReducerState: CortexAppReducerState = {
  active: false,
  swatches: undefined,
  textComponents: undefined,
  colorChips: undefined,
  spacingTokens: undefined,
  capabilitySystems: [],
  activityCount: 0,
  editErrors: new Map(),
  annotations: new Map(),
  agentConnected: false,
  activityEntries: [],
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

/**
 * Pure selection-update helper used by the component-level `setSelection`
 * setter in CortexApp.tsx (ZF0-1195).
 *
 * Selection state is component-local (`useState`) — it never lived in the
 * reducer. This helper is exported alongside the reducer because both
 * reason about discrete state-shape transitions and share the
 * "named-export, framework-agnostic" conventions of this module.
 *
 * Identity-stable: returns `prev` unchanged when the action is a no-op
 * (e.g. `add` of an element already in the selection, or `replace` with
 * the same elements in the same order). Reference equality lets Preact
 * bail out of re-render via `setSelectedElementsState(prev => prev)`.
 */
export function applySelectionUpdate(
  prev: Element[],
  elements: Element[],
  action: 'replace' | 'add' | 'toggle',
): Element[] {
  if (action === 'replace') {
    // Identity-stable replace: same contents in same order → return prev.
    if (
      elements.length === prev.length &&
      elements.every((el, i) => el === prev[i])
    ) {
      return prev
    }
    return elements
  }
  if (action === 'add') {
    const next = [...prev]
    let changed = false
    for (const el of elements) {
      if (!next.includes(el)) {
        next.push(el)
        changed = true
      }
    }
    return changed ? next : prev
  }
  // toggle
  const next = [...prev]
  for (const el of elements) {
    const idx = next.indexOf(el)
    if (idx >= 0) next.splice(idx, 1)
    else next.push(el)
  }
  return next
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Pure reducer that mirrors the CortexApp message-handling if-chain.
 *
 * Returns `{ state, effects }`. When no slice of state changed AND there are
 * no effects, the original `state` reference is returned so the wiring layer
 * can skip setter fan-out via reference equality.
 *
 * Invariants:
 *  - No Date.now / Math.random / DOM reads / closures over mutable refs.
 *  - Map mutations always allocate a new Map (never alias the previous one).
 *  - Exhaustive switch with a `never` default to catch missing action types.
 */
export function cortexAppReducer(
  state: CortexAppReducerState,
  action: CortexAppAction,
): { state: CortexAppReducerState; effects: CortexAppEffect[] } {
  switch (action.type) {
    // -----------------------------------------------------------------------
    case 'cortex': {
      if (state.active) {
        // Already active — no-op, preserve reference equality.
        return { state, effects: [] }
      }
      return { state: { ...state, active: true }, effects: [] }
    }

    // -----------------------------------------------------------------------
    case 'cortex-close': {
      if (!state.active) {
        // Already inactive — emit invoke_exit but don't allocate a new state object.
        return { state, effects: [{ type: 'invoke_exit' }] }
      }
      // Set active: false so the reducer is the single source of truth.
      // applyReducerState will call setActive(false) via the normal slice-setter
      // path, keeping reducerStateRef in sync. handleExit (called via invoke_exit)
      // also calls setActive(false) — the double-call is idempotent.
      return { state: { ...state, active: false }, effects: [{ type: 'invoke_exit' }] }
    }

    // -----------------------------------------------------------------------
    case 'cortex-toggle': {
      return cortexAppReducer(state, action.active ? { type: 'cortex' } : { type: 'cortex-close' })
    }

    // -----------------------------------------------------------------------
    // Pillar 1 unified action. Routes to the existing cortex/cortex-close
    // branches so behavior stays identical to the legacy paths during the
    // dual-mode period. After deprecation removes cortex/cortex-close, this
    // case absorbs their bodies directly.
    case 'set-active': {
      return cortexAppReducer(state, action.active ? { type: 'cortex' } : { type: 'cortex-close' })
    }

    // -----------------------------------------------------------------------
    case 'capabilities': {
      const filtered = action.systems.filter(s => s.status !== 'supported')
      return { state: { ...state, capabilitySystems: filtered }, effects: [] }
    }

    // -----------------------------------------------------------------------
    case 'hello': {
      return {
        state: {
          ...state,
          swatches: action.swatches ?? [],
          textComponents: action.textComponents ?? [],
          colorChips: action.colorChips ?? [],
          spacingTokens: action.spacingTokens ?? [],
        },
        effects: [],
      }
    }

    // -----------------------------------------------------------------------
    case 'edit_status': {
      if (action.status === 'done') {
        if (action.dispatch) {
          const { source, property } = action.dispatch
          const key = `${source}\0${property}`
          // Only allocate a new Map when the key is actually present —
          // mirrors the legacy clearEditError bail-out (I2 fix, ZF0-1363).
          // Same shape as the annotation-updated branch below.
          let nextErrors = state.editErrors
          if (nextErrors.has(key)) {
            nextErrors = new Map(nextErrors)
            nextErrors.delete(key)
          }
          return {
            state: {
              ...state,
              activityCount: state.activityCount + 1,
              editErrors: nextErrors,
            },
            effects: [],
          }
        }
        return {
          state: { ...state, activityCount: state.activityCount + 1 },
          effects: [],
        }
      }

      // status === 'failed'
      if (action.dispatch) {
        const { source, property, value } = action.dispatch
        const key = `${source}\0${property}`
        const nextErrors = new Map(state.editErrors)
        nextErrors.set(key, {
          source,
          property,
          value,
          reason: action.reason ?? 'Unknown error',
        })
        return { state: { ...state, editErrors: nextErrors }, effects: [] }
      }

      // failed without dispatch
      return {
        state,
        effects: [
          {
            type: 'log_warning',
            message: `[cortex] edit_status:failed for untracked editId ${action.editId}: ${action.reason ?? 'Unknown'}`,
          },
        ],
      }
    }

    // -----------------------------------------------------------------------
    case 'hmr_verified': {
      return {
        state,
        effects: [
          {
            type: 'apply_hmr_verified',
            editId: action.editId,
            match: action.match,
            kind: action.kind,
          },
        ],
      }
    }

    // -----------------------------------------------------------------------
    case 'undo_sync_status':
    case 'redo_sync_status': {
      if (action.status === 'done') {
        return { state, effects: [] }
      }

      // status === 'failed'
      const verb = action.type === 'undo_sync_status' ? 'undo' : 'redo'
      const effects: CortexAppEffect[] = [
        {
          type: 'log_warning',
          message: `[cortex] Server ${verb} sync failed: ${action.reason}`,
        },
      ]
      if (action.reason_code === 'stale' || action.reason_code === 'write_failed') {
        effects.push({ type: 'send', message: { type: 'clear_server_undo' } })
      }
      return { state, effects }
    }

    // -----------------------------------------------------------------------
    case 'annotations-snapshot': {
      // Server-authoritative replacement of the annotations Map. Fires on
      // browser `init` so persisted annotations re-appear after a Vite
      // dev-server restart (CORTEX_PERSIST_ANNOTATIONS=true). Drops any local
      // state — typically none, since browser is freshly mounted on init.
      const nextAnnotations = new Map<string, Annotation>(
        action.annotations.map((ann) => [ann.id, ann]),
      )

      // Mirror the editErrors reconciliation from the annotation-updated case:
      // if the browser was disconnected during an edit failure and the server
      // resolved/dismissed the corresponding fix-request during that window,
      // the stale error must clear on reconnect. Identity-stable when no
      // clearing is needed (Map reference unchanged).
      let nextErrors = state.editErrors
      let errorsCloned = false
      for (const ann of action.annotations) {
        if (
          ann.kind === 'fix-request' &&
          (ann.status === 'resolved' || ann.status === 'dismissed') &&
          ann.fixMeta
        ) {
          const key = `${ann.elementSource}\0${ann.fixMeta.property}`
          if (nextErrors.has(key)) {
            if (!errorsCloned) {
              nextErrors = new Map(nextErrors)
              errorsCloned = true
            }
            nextErrors.delete(key)
          }
        }
      }

      return {
        state: { ...state, annotations: nextAnnotations, editErrors: nextErrors },
        effects: [],
      }
    }

    // -----------------------------------------------------------------------
    case 'annotation-created': {
      const nextAnnotations = new Map(state.annotations)
      nextAnnotations.set(action.annotation.id, action.annotation)
      return { state: { ...state, annotations: nextAnnotations }, effects: [] }
    }

    // -----------------------------------------------------------------------
    case 'annotation-updated': {
      const nextAnnotations = new Map(state.annotations)
      nextAnnotations.set(action.annotation.id, action.annotation)
      let nextErrors = state.editErrors

      const ann = action.annotation
      if (
        ann.kind === 'fix-request' &&
        (ann.status === 'resolved' || ann.status === 'dismissed') &&
        ann.fixMeta
      ) {
        const key = `${ann.elementSource}\0${ann.fixMeta.property}`
        if (nextErrors.has(key)) {
          nextErrors = new Map(nextErrors)
          nextErrors.delete(key)
        }
      }

      return {
        state: { ...state, annotations: nextAnnotations, editErrors: nextErrors },
        effects: [],
      }
    }

    // -----------------------------------------------------------------------
    case 'agent-status': {
      if (state.agentConnected === action.connected) {
        return { state, effects: [] }
      }
      return { state: { ...state, agentConnected: action.connected }, effects: [] }
    }

    // -----------------------------------------------------------------------
    case 'activity-entry': {
      const prev = state.activityEntries
      const nextEntries =
        prev.length >= MAX_ACTIVITY_ENTRIES
          ? [...prev.slice(-(MAX_ACTIVITY_ENTRIES - 1)), action.entry]
          : [...prev, action.entry]
      return {
        state: {
          ...state,
          activityEntries: nextEntries,
          activityCount: state.activityCount + 1,
        },
        effects: [],
      }
    }

    // -----------------------------------------------------------------------
    case 'divergence': {
      const d = action.diagnostic
      const key = `${d.source}\0${d.property}\0${d.pseudo ?? ''}`
      const nextErrors = new Map(state.editErrors)
      nextErrors.set(key, {
        source: d.source,
        property: d.property,
        value: d.expected,
        reason: `Preview shows "${d.expected}" but the saved file renders "${d.actual || '(empty)'}". The edit may not have propagated.`,
        diagnostics: d.diagnostics,
      })
      return { state: { ...state, editErrors: nextErrors }, effects: [] }
    }

    // -----------------------------------------------------------------------
    default: {
      const _exhaustive: never = action
      throw new Error(`Unhandled cortex-app-reducer action: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
