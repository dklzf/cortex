import { useCallback, useMemo, useRef, useState } from 'preact/hooks'
import { stripLineCol, deepQueryAllElements } from '../selection-metadata.js'
import type { CortexChannel, PendingEdit } from '../../adapters/types.js'

// Re-export for backward compatibility — existing test imports rely on this.
export type { PendingEdit }

/**
 * Reads the source-of-truth value for a pending edit, bypassing any active
 * cortex CSS overrides. Production HMR wiring MUST pass an implementation that
 * temporarily detaches the override stylesheet (see
 * `CSSOverrideManager.readUnderlyingValue`) — otherwise getComputedStyle will
 * return cortex's own `!important` override value rather than the source value
 * that HMR re-applied, producing a 100% false-positive divergence rate during
 * active edits.
 */
export type ReadSourceValue = (
  el: Element,
  property: string,
  pseudo: '::before' | '::after' | null,
) => string

/**
 * Optional sync emitter passed to useEditStagingBuffer to mirror every
 * mutation to the server-side StagedEditsCache (Process 2). When undefined,
 * the hook operates as purely browser-canonical — backward-compat for tests
 * and scenarios without channel access.
 *
 * Wire-up in Panel.tsx is out of scope for T1; T2 will pass an implementation
 * that delegates to channel.send.
 */
export interface SyncEmitter {
  syncAdd(edit: PendingEdit): void
  syncRemove(intentIds: readonly string[]): void
  syncClear(): void
  syncFullState(edits: readonly PendingEdit[]): void
}

export interface StagingBufferHandle {
  /** Last-write-wins by (source\0property\0pseudo). Returns the entry this
   *  append DISPLACED, or undefined on a fresh key. `PropertyEditCommand` keeps
   *  it so undo can put it back: without that, undoing the second edit in a
   *  chain removed the current intent and restored nothing, leaving the override
   *  showing the intermediate value while the buffer read empty and Apply was a
   *  silent no-op. */
  append: (edit: PendingEdit) => PendingEdit | undefined
  remove: (intentIds: string[]) => void
  list: () => PendingEdit[]
  clear: () => void
  size: () => number
  /**
   * Monotonic mutation counter. Increments on every append/remove/clear.
   * Consumers (e.g. Panel.tsx drift reconcile useEffect) can add this to
   * their dep array to re-run when the buffer mutates — without subscribing
   * to unstable method references that change every render.
   */
  version: number
  /**
   * Re-evaluate previousValue against the live DOM for intents whose file is
   * in `changedFiles`. Returns intents whose resolved current value no longer
   * matches `previousValue.trim()`, plus intents whose element no longer
   * exists in DOM (file deleted/refactored).
   *
   * IMPORTANT: When the cortex CSSOverrideManager has active overrides on the
   * page, getComputedStyle() returns the override value, not the source
   * value. Production HMR wiring MUST pass a `readSourceValue` callback that
   * bypasses the override layer (e.g. delegating to
   * `CSSOverrideManager.readUnderlyingValue`). The default reader (used by
   * unit tests where no override layer is active) prefers
   * `element.style.getPropertyValue(prop)` (skipped for pseudo-element edits)
   * and falls back to `getComputedStyle(el, pseudo)`.
   *
   * Hook does NOT auto-subscribe to HMR. Wiring HMR → reconcile is deferred.
   */
  reconcile: (
    changedFiles: string[],
    readSourceValue?: ReadSourceValue,
  ) => { divergent: PendingEdit[] }
}

const MAX_ENTRIES = 500

/** Composite key for last-write-wins deduplication. */
function compositeKey(edit: PendingEdit): string {
  return `${edit.source}\0${edit.property}\0${edit.pseudo ?? ''}`
}

/** Default reader used when no `readSourceValue` callback is provided.
 *  Inline-style first (skipped for pseudo-elements, which have none), then
 *  getComputedStyle with the pseudo argument so pseudo-element edits query
 *  the pseudo's box rather than the host element. NOTE: this default does
 *  NOT bypass the cortex override layer — production callers must pass a
 *  reader that delegates to CSSOverrideManager.readUnderlyingValue. */
function defaultReadSourceValue(
  el: Element,
  property: string,
  pseudo: '::before' | '::after' | null,
): string {
  // `.style` lives on ElementCSSInlineStyle (HTMLElement | SVGElement), not on
  // Element. Narrow instead of casting — SVG-sourced intents are reachable once
  // the selection layer is Element-typed.
  const inlineStyle = el instanceof HTMLElement || el instanceof SVGElement ? el.style : null
  const inlineValue = pseudo
    ? ''
    : (inlineStyle?.getPropertyValue(property).trim() ?? '')
  if (inlineValue !== '') return inlineValue
  return getComputedStyle(el, pseudo ?? undefined).getPropertyValue(property).trim()
}

/**
 * useEditStagingBuffer — accumulates PendingEdit entries browser-side.
 *
 * - last-write-wins by (source\0property\0pseudo) composite key
 * - memory-only (Change 4): no localStorage persistence; buffer is session-scoped
 * - bounded at 500 entries (oldest evicted)
 * - stable method identities: append/remove/list/clear/size/reconcile are
 *   held in a useRef and never change across re-renders. The returned wrapper
 *   object itself is memoized via `useMemo([version])`, so its identity changes
 *   ONLY when the buffer mutates (version bumps) — not on every render. This
 *   lets consumer dep arrays like `useEffect(..., [buffer])` re-run only on
 *   real buffer changes. Methods destructured from the handle remain
 *   reference-stable across all renders.
 * - optional SyncEmitter: when provided, every mutation emits a sync message
 *   to the server-side StagedEditsCache (T1). Wire-up in Panel.tsx is T2.
 */
export default function useEditStagingBuffer(emitter?: SyncEmitter): StagingBufferHandle {
  const bufferRef = useRef<Map<string, PendingEdit>>(new Map())
  const initRef = useRef(false)
  // Stable ref to the emitter — avoids stale-closure issues inside useCallback.
  const emitterRef = useRef<SyncEmitter | undefined>(emitter)
  emitterRef.current = emitter
  // ZF0-1453 (post-Step-9.5): bump on every mutation so consumers reading
  // size()/list() in render re-evaluate after staged-edits-discard arrives.
  // Without this, bufferRef mutations (server-driven discards) don't cause
  // Panel to re-render and the Apply button stays at "Apply (N)" after the
  // buffer is server-side empty.
  // ZF0-1477: version is now exposed on StagingBufferHandle so Panel.tsx's
  // drift-reconcile useEffect can add it to the dep array and re-run when
  // the buffer mutates (not just when an HMR event fires).
  const [version, bumpVersion] = useState(0)
  const bumpRef = useRef(() => bumpVersion(v => v + 1))

  // STRICT-MODE INVARIANT: `initRef.current = true` must be the FIRST statement
  // in this block so Preact strict-mode's double-invocation cannot re-enter and
  // execute the body twice. Do NOT move the assignment after any emission —
  // that would break the "exactly one full-sync per mount" contract that the
  // server-side StagedEditsCache.mergeFullSync relies on.
  if (!initRef.current) {
    initRef.current = true
    // Change 4: memory-only — no rehydration from localStorage. Intents are
    // session-scoped; persistence created phantom intents when Claude landed
    // edits via the Edit tool without an acknowledgement callback (Change 7's
    // acknowledge protocol is the real fix). bufferRef starts empty.
  }

  // Change 4: memory-only — the staging buffer has no persistence layer.
  // Mutations update `bufferRef` in memory and bump `version`; the buffer dies
  // with the cortex session. The previous localStorage debounce chain
  // (persistNow/schedulePersist/flush) was removed — it allocated a timer per
  // mutation that only ever called a no-op.

  const append = useCallback((edit: PendingEdit): PendingEdit | undefined => {
    const key = compositeKey(edit)
    // Capture BEFORE the delete. This is the entry last-write-wins is about to
    // destroy, and it is the only record that it ever existed.
    const displaced = bufferRef.current.get(key)
    if (displaced !== undefined) {
      // Update in-place (last-write-wins) — remove and re-insert to keep insertion order.
      bufferRef.current.delete(key)
    }

    bufferRef.current.set(key, edit)

    // Evict oldest entry if over limit. Surface so a future Apply UI can
    // render a "buffer full — older edits dropped" notice; the warning is
    // intentionally low-key because the buffer continues to function.
    let evictedIntentId: string | null = null
    if (bufferRef.current.size > MAX_ENTRIES) {
      const oldest = bufferRef.current.entries().next()
      if (!oldest.done) {
        const [firstKey, evicted] = oldest.value
        bufferRef.current.delete(firstKey)
        evictedIntentId = evicted.intentId
        console.warn(
          '[cortex] Staging buffer evicted oldest intent (max 500):',
          evicted.source,
          evicted.property,
        )
      }
    }

    // Emit sync AFTER the in-memory map is updated.
    // Eviction IS a mutation: emit syncRemove so the server cache stays in
    // lockstep with the bounded browser buffer. Without this, the server
    // cache grows unbounded on long sessions while the browser caps at 500.
    emitterRef.current?.syncAdd(edit)
    if (evictedIntentId !== null) {
      emitterRef.current?.syncRemove([evictedIntentId])
    }

    bumpRef.current()
    // Displacement and eviction are mutually exclusive: a displacing append does
    // delete-then-set, so size is unchanged and the `> MAX_ENTRIES` branch above
    // cannot fire. A refactor to set-without-delete would break that silently —
    // there is a test pinning it.
    return displaced
  }, [])

  const remove = useCallback((intentIds: string[]) => {
    const idSet = new Set(intentIds)
    const toDeleteKeys: string[] = []

    for (const [key, edit] of bufferRef.current.entries()) {
      if (idSet.has(edit.intentId)) toDeleteKeys.push(key)
    }

    for (const key of toDeleteKeys) {
      bufferRef.current.delete(key)
    }

    // Emit sync AFTER the in-memory map is updated.
    emitterRef.current?.syncRemove(intentIds)

    if (toDeleteKeys.length > 0) bumpRef.current()
  }, [])

  const list = useCallback((): PendingEdit[] => {
    return Array.from(bufferRef.current.values())
  }, [])

  const clear = useCallback(() => {
    bufferRef.current.clear()

    // Emit sync AFTER the in-memory map is cleared.
    emitterRef.current?.syncClear()

    bumpRef.current()
  }, [])

  const size = useCallback((): number => {
    return bufferRef.current.size
  }, [])

  const reconcile = useCallback((
    changedFiles: string[],
    readSourceValue: ReadSourceValue = defaultReadSourceValue,
  ): { divergent: PendingEdit[] } => {
    if (changedFiles.length === 0) return { divergent: [] }

    const changedSet = new Set(changedFiles)
    const divergent: PendingEdit[] = []

    // Single tree-walk to build a source→element index, then O(1) lookup per
    // intent. Avoids O(intents × DOM) querySelector fan-out when an HMR event
    // touches a hot file referenced by hundreds of intents.
    let elBySource: Map<string, Element> | null = null

    for (const edit of bufferRef.current.values()) {
      if (!changedSet.has(stripLineCol(edit.source))) continue

      if (elBySource === null) {
        elBySource = new Map()
        // Use deepQueryAllElements (not document.querySelectorAll) so reconcile
        // sees elements inside open shadow roots — web-component apps (Lit,
        // Stencil, Shoelace) place data-cortex-source inside shadow trees.
        // Bare flat queries miss them and falsely flag them as "element
        // deleted" (file deleted/refactored), producing user-hostile divergence
        // cards. Mirrors the existing selection-resolution shadow-pierce path.
        //
        // Element-typed (this used to filter to HTMLElement): SVG-sourced
        // intents are reachable now that selection is Element-typed, and a
        // missing index entry falls into the `!el` branch below — a false
        // "element deleted" card on every HMR touching that file.
        // First-seen wins on duplicate sources. With `set` semantics, two
        // mounted instances sharing a `data-cortex-source` (legitimate when
        // scope='all' targets sibling instances; or accidental during HMR
        // re-render where old + new trees coexist for a tick) would have
        // the LAST element clobber the first, and `last` is non-deterministic
        // in document/insertion order across browsers and shadow trees.
        // First-seen + traversal order produces stable behavior.
        for (const el of deepQueryAllElements('[data-cortex-source]')) {
          const s = el.getAttribute('data-cortex-source')
          if (s !== null && !elBySource.has(s)) elBySource.set(s, el)
        }
      }

      const el = elBySource.get(edit.source)
      if (!el) {
        // Element does not exist — file deleted/refactored
        divergent.push(edit)
        continue
      }

      const pseudo = edit.pseudo ?? null
      const currentValue = readSourceValue(el, edit.property, pseudo).trim()

      if (currentValue !== edit.previousValue.trim()) {
        divergent.push(edit)
      }
    }

    return { divergent }
  }, [])

  // Stable handle — every method is `useCallback([...])` over stable refs, so
  // their identities never change after first render. The ref initializer fires
  // once; no per-render reassignment needed.
  // NOTE: `version` is NOT stored in handleRef because it is a reactive value
  // from useState — it must come from the current render's closure so that dep
  // arrays in consumers (e.g. Panel.tsx drift reconcile useEffect) see the
  // latest value.
  const handleRef = useRef<Omit<StagingBufferHandle, 'version'>>({
    append,
    remove,
    list,
    clear,
    size,
    reconcile,
  })

  // Memoize the return wrapper on `version` so consumers using the FULL handle
  // in dep arrays (e.g. `useEffect(..., [channel, buffer])` in Panel.tsx:320,
  // 347, 708) only re-run when the buffer actually mutates — not on every
  // render. Without this useMemo, the spread allocates a new object every
  // render, breaking memoization on every consumer of the handle.
  return useMemo(() => ({ ...handleRef.current, version }), [version])
}

export { useEditStagingBuffer }

/**
 * createPanelSyncEmitter — wires a SyncEmitter to a CortexChannel by
 * delegating each method to channel.send with the corresponding
 * BrowserToServer message shape.
 *
 * Token stamping: channel.send (both Vite and WebSocket variants) auto-stamps
 * the captured token via `{ ...msg, token: capturedToken }` (see
 * src/browser/channel.ts). The empty string passed here is overwritten — it
 * exists only to satisfy the BrowserToServer type union which marks `token`
 * as required on the staged-edit-* variants.
 *
 * Array conversion: BrowserToServer variants spec mutable arrays
 * (`string[]`, `PendingEdit[]`); the SyncEmitter interface uses `readonly`.
 * Spread the readonly inputs into fresh mutable arrays at the boundary.
 *
 * Extracted as a named export so its wiring shape is unit-testable without
 * mounting Panel.tsx — the test file imports this directly. */
export function createPanelSyncEmitter(channel: CortexChannel): SyncEmitter {
  return {
    syncAdd: (edit) => channel.send({ type: 'staged-edit-add', edit, token: '' }),
    syncRemove: (intentIds) => channel.send({ type: 'staged-edit-remove', intentIds: [...intentIds], token: '' }),
    syncClear: () => channel.send({ type: 'staged-edit-clear', token: '' }),
    syncFullState: (edits) => channel.send({ type: 'staged-edits-sync', edits: [...edits], token: '' }),
  }
}
