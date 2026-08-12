import { randomUUID } from 'node:crypto'
import type { PendingEdit } from '../adapters/types.js'
import { pendingEditSchema, MAX_FULL_SYNC_SIZE, isStructuralEdit, isClassEdit, describeClassOp } from '../schemas/pending-edit.js'
import { compositeKey } from '../shared/composite-key.js'
import { isPreviewSource, PREVIEW_SOURCE_PREFIX } from '../shared/preview-source.js'
import { stripFenceMarkers } from '../shared/untrusted-fence.js'
import type { EditPipeline } from './edit-pipeline.js'

// MAX_FULL_SYNC_SIZE — single source of truth lives in schemas/pending-edit.ts
// (kept there so the schema can enforce the cap at the envelope boundary
// without an upward import from schemas/ to core/). Re-imported above.


/** Defensive snapshot of a PendingEdit — callers mutating the returned object
 *  cannot affect the cache's internal state. structuredClone makes this
 *  correct-by-construction: the prior top-level spread + selective shallow
 *  clones of instanceSources/sourceResolutionHint covered today's flat schema,
 *  but any nested field added to PendingEdit later would silently leak until
 *  someone remembered to extend this helper (ZF0-1855, sister of ZF0-1844).
 *  PendingEdit is plain wire-format data (pending-edit.ts) — fully cloneable. */
function snapshot(edit: PendingEdit): PendingEdit {
  return structuredClone(edit)
}

function isAgentResolvedIntent(intent: PendingEdit): boolean {
  return intent.applyMode === 'agent-resolve' || isPreviewSource(intent.source)
}

/**
 * StagedEditsCache — server-side (Process 2) mirror of the browser's
 * useEditStagingBuffer. Receives one-way sync messages from the browser and
 * is read by MCP tool calls in T2.
 *
 * - last-write-wins by composite key `${source}\0${property}\0${pseudo ?? ''}`
 * - insertion order preserved (Map iteration order)
 * - defensive-copy on every read (snapshot helper)
 */
export class StagedEditsCache {
  private readonly store = new Map<string, PendingEdit>()

  /**
   * Append or update an edit using last-write-wins semantics.
   * Re-inserts to the end of the Map when the key already exists,
   * matching browser hook behavior.
   */
  append(edit: PendingEdit): void {
    const key = compositeKey(edit)
    if (this.store.has(key)) {
      this.store.delete(key)
    }
    this.store.set(key, snapshot(edit))
    this.evictOverflow()
  }

  /**
   * Bound the cache independently of the browser.
   *
   * This cache previously had NO cap, relying entirely on the browser mirroring
   * its own 500-entry FIFO eviction. That mirror is two separate channel sends
   * (syncAdd then syncRemove); if the tab closes, reloads, or the socket drops
   * between them, the server never learns of the eviction and the orphan is
   * permanent — `mergeFullSync` cannot heal it, because it only adds and
   * updates keys present in the payload and never deletes absent ones (an empty
   * sync is deliberately a no-op so a rehydrating tab cannot wipe a peer's
   * edits).
   *
   * Dedupe used to hide this: repeated style edits at one locus collapse onto a
   * single key, so the store grew slowly. Structural intents are exempt by
   * design — every drag is a new permanent key — so the leak compounds fastest
   * on exactly the traffic this change introduces. Raised in architecture
   * review.
   *
   * Cap is MAX_FULL_SYNC_SIZE: the server already refuses to ingest a sync
   * larger than this, so holding more than it would accept is incoherent.
   * Eviction is oldest-first, matching the browser's FIFO.
   */
  private evictOverflow(): void {
    while (this.store.size > MAX_FULL_SYNC_SIZE) {
      const oldest = this.store.keys().next()
      if (oldest.done) return
      this.store.delete(oldest.value)
      console.warn(
        `[cortex] StagedEditsCache evicted oldest intent (cap ${MAX_FULL_SYNC_SIZE}) — ` +
        'the browser buffer is the canonical store; this bound exists so a lost eviction sync cannot leak indefinitely',
      )
    }
  }

  /**
   * Remove entries by intentId. Iterates the store to find all entries
   * with a matching intentId (there should be exactly one per intentId,
   * since intentIds are UUIDs). Idempotent — re-removing a gone id is a no-op.
   */
  remove(intentIds: readonly string[]): void {
    if (intentIds.length === 0) return
    const idSet = new Set(intentIds)
    const toDelete: string[] = []
    for (const [key, edit] of this.store.entries()) {
      if (idSet.has(edit.intentId)) toDelete.push(key)
    }
    for (const key of toDelete) this.store.delete(key)
  }

  /**
   * Merge a full-state sync from a browser canonical buffer into the
   * server-side cache. On composite-key conflict, keep whichever entry has
   * the higher (or equal) `timestamp` field. Empty input is a no-op (does
   * NOT wipe the cache).
   *
   * Multi-tab safety rationale: pre-merge semantics ("clear + set") wiped
   * the cache on every Panel mount, which silently corrupted state when
   * multiple tabs were open. Concrete failure: Tab A has 5 fresh staged
   * edits in the server cache; Tab B (3 OLDER edits in localStorage) opens
   * and mounts Panel → fires syncFullState([3-old]) → old replaceAll wiped
   * Tab A's 5 and installed Tab B's 3. Merge with timestamp preference is
   * the minimum viable fix: Tab B's stale localStorage cannot clobber Tab
   * A's newer edits, and an empty rehydration is a no-op. Reviewed in
   * ZF0-1452 Step 4 (3-of-3 reviewer convergence).
   *
   * Within `edits`, duplicate composite keys keep the last-seen entry
   * (Map.set overwrites — matches the browser hook's last-write-wins).
   * The browser staging buffer dedupes upstream, so duplicates within a
   * single payload are not expected in practice.
   *
   * Inputs exceeding MAX_FULL_SYNC_SIZE are rejected with a console.error;
   * cache state is left unchanged so a malformed message can't wipe a
   * healthy cache. Severity is `error` (not `warn`) because the browser-side
   * cap is 2× MAX_ENTRIES — an oversize payload arriving here means client
   * misbehavior or compromise, and the server cache is now silently divergent
   * from browser canonical until the next legitimate sync.
   */
  mergeFullSync(edits: readonly PendingEdit[]): void {
    if (edits.length > MAX_FULL_SYNC_SIZE) {
      console.error(
        `[cortex] StagedEditsCache.mergeFullSync rejected: ${edits.length} entries exceeds defensive cap ${MAX_FULL_SYNC_SIZE} — possible client misbehavior or compromise`,
      )
      return
    }
    for (const edit of edits) {
      const key = compositeKey(edit)
      const existing = this.store.get(key)
      // Keep the newer entry on conflict; ties go to the incoming entry
      // (matches the browser hook's "re-insert at end on append" semantics
      // for sub-millisecond edit replays).
      if (!existing || edit.timestamp >= existing.timestamp) {
        if (existing) this.store.delete(key)
        this.store.set(key, snapshot(edit))
      }
    }
    this.evictOverflow()
  }

  /** Empty the cache. */
  clear(): void {
    this.store.clear()
  }

  /** Return all entries in insertion order. Defensive copy — safe to mutate. */
  list(): PendingEdit[] {
    return Array.from(this.store.values()).map(snapshot)
  }

  /** Return a single entry by intentId, or null if not found. */
  getById(intentId: string): PendingEdit | null {
    for (const edit of this.store.values()) {
      if (edit.intentId === intentId) return snapshot(edit)
    }
    return null
  }

  /** Current number of entries. */
  size(): number {
    return this.store.size
  }
}

// ---------------------------------------------------------------------------
// isValidPendingEdit — server-side WS trust-boundary validation.
//
// Now backed by pendingEditSchema (src/schemas/pending-edit.ts), which is the
// single source of truth for shape + size bounds. This thin wrapper is kept
// for backwards compatibility with existing unit tests; new call sites should
// use pendingEditSchema.safeParse() or parseOrFail(pendingEditSchema, ...) directly.
// ---------------------------------------------------------------------------

/** Validate a PendingEdit at the WebSocket trust boundary.
 *  Returns false (does NOT throw) on any deviation; callers drop the message.
 *
 *  @deprecated Use `pendingEditSchema.safeParse(value).success` directly.
 *  Kept for backward compatibility — existing unit tests import this symbol. */
export function isValidPendingEdit(value: unknown): value is PendingEdit {
  return pendingEditSchema.safeParse(value).success
}

// ---------------------------------------------------------------------------
// applyEditsCore — pure helper used by handleRPC.applyEdits in vite.ts.
//
// Lives here (not in vite.ts) because it's a cache-helper with zero
// adapter-specific dependencies — it operates on a structural `cache` shape
// and an array of intent IDs. Co-locating with StagedEditsCache keeps the
// layering clean (tests in `tests/cli/` import from `core/`, not `adapters/`).
// ---------------------------------------------------------------------------

/** Per-id result item produced by applyEditsCore. */
export type ApplyEditResult =
  | { intentId: string; status: 'applied'; mechanism: 'tailwind' | 'css-module' | 'inline-style' }
  | { intentId: string; status: 'needs-source-edit'; intent: PendingEdit; reason: string }
  | { intentId: string; status: 'failed'; error: string }

/** Build the per-id result list for cortex_apply_edits.
 *
 *  Routes each intent through EditPipeline for deterministic apply. Intents
 *  handled directly by a rewriter (Tailwind, CSS Modules, inline-style) resolve
 *  as 'applied' with the mechanism name. Intents that the pipeline cannot
 *  rewrite deterministically resolve as 'needs-source-edit' with guidance for
 *  Claude to apply via the Edit tool. Missing intentIds resolve as 'failed'.
 *  Input order is preserved via Promise.all.
 *
 *  On 'applied': cache.remove([intentId]) is called immediately so the browser
 *  canonical buffer and server-side StagedEditsCache stay in sync (AC3).
 *
 *  Extracted as an injectable function (cache and pipeline passed in) so its
 *  contract can be unit-tested without booting a full CortexSession — the test
 *  file imports this directly rather than mocking the RPC handler. This avoids
 *  the shadow-copy hazard (cortex CLAUDE.md test rule #1).
 *
 *  timeoutMs is forwarded to pipeline.registerApplyResolver; for tests, pass a
 *  short value (e.g. 100ms) to avoid blocking the test suite. */
export async function applyEditsCore(
  cache: {
    getById(id: string): PendingEdit | null
    remove(intentIds: readonly string[]): void
  },
  intentIds: readonly string[],
  pipeline: EditPipeline,
  timeoutMs = 10_000,
): Promise<ApplyEditResult[]> {
  // Defensive dedup: the MCP input schema (mcp-tool-inputs.ts:49) refuses
  // duplicates at the trust boundary, but tests and other callers reach
  // applyEditsCore directly. Two intentIds with the same value within ONE
  // call would generate identical synthetic editIds and overwrite each
  // other's pendingResolvers entry, orphaning the first timer + Promise.
  // Track the seen set; for each duplicate, return the SAME result reference
  // so input order + length are preserved.
  //
  // Per-call UUID prefix (`callId`) covers the OTHER collision class — two
  // CONCURRENT cortex_apply_edits invocations targeting the same intentId
  // would generate identical synthetic editIds without it. Three external
  // reviewers (Codex P1, Copilot, CodeRabbit Major) flagged this independently.
  const callId = randomUUID().slice(0, 8)
  const seen = new Map<string, Promise<ApplyEditResult>>()

  return Promise.all(
    intentIds.map((intentId) => {
      const cached = seen.get(intentId)
      if (cached) return cached
      const fresh = applyOne(cache, intentId, pipeline, timeoutMs, callId)
      seen.set(intentId, fresh)
      return fresh
    }),
  )
}

/** Per-intent apply. Extracted from applyEditsCore so the dedup-by-id loop in
 *  applyEditsCore can cache the Promise without smearing the body. `callId` is
 *  the per-applyEditsCore-invocation UUID prefix that prevents synthetic-editId
 *  collisions across concurrent calls. */
async function applyOne(
  cache: {
    getById(id: string): PendingEdit | null
    remove(intentIds: readonly string[]): void
  },
  intentId: string,
  pipeline: EditPipeline,
  timeoutMs: number,
  callId: string,
): Promise<ApplyEditResult> {
  const intent = cache.getById(intentId)
  if (!intent) {
    return { intentId, status: 'failed' as const, error: 'intent not found' }
  }

  // Structural intents have no deterministic path by construction (B2). The
  // schema already forces applyMode 'agent-resolve', so they would fall into
  // the branch below anyway — but the generic message does not say "this is a
  // move", and the difference matters: the mechanizable edit here is
  // `style={{ order: N }}`, which changes visual order WITHOUT changing DOM
  // order and silently breaks screen-reader sequence and tab order. Spelling
  // that out is the difference between Claude reordering the JSX and Claude
  // reaching for the CSS property that looks equivalent.
  //
  // Placed before the agent-resolve check so it wins, and so TypeScript narrows
  // the remainder of this function to style intents.
  if (isStructuralEdit(intent)) {
    const { parentSource, parentKey, baseline, order } = intent.structural
    const described = order.map((from, to) => `${to} <- ${from} (${baseline[from] ?? '?'})`).join(', ')
    return {
      intentId,
      status: 'needs-source-edit' as const,
      intent,
      reason:
        `Structural reorder: the container at ${parentSource} (runtime instance ${parentKey}) ` +
        `must end up with its children in this order — ${described}. Indices refer to the ` +
        `children's positions BEFORE the edit; the list describes the intended RESULT, not a ` +
        `sequence of moves, so apply it as a whole.\n\n` +
        `Children as observed when the user dragged: ${baseline.join(', ')}. If the source no ` +
        `longer matches that, stop and report the drift rather than reordering what is there.\n\n` +
        `Reorder the SOURCE so the DOM order changes. If those children are rendered by a ` +
        `.map(), reorder the underlying array — the siblings share one source location, so ` +
        `editing the JSX cannot move a single instance. If they are hand-authored siblings, ` +
        `reorder the JSX elements.\n\n` +
        `Do NOT express this with CSS 'order', 'flex-direction: *-reverse', or absolute ` +
        `positioning. Those change visual order only; the accessibility tree and tab order ` +
        `keep following the original DOM sequence, which is a real regression that looks ` +
        `correct in a screenshot.`,
    }
  }

  // A class intent reaches the buffer only when the gesture could NOT be applied
  // deterministically — the element carried no build-time anchor, so there is no
  // file position to rewrite (COR-25). Before this existed the gesture returned
  // early in the Panel and evaporated with no error and no intent, which on a
  // component-library app is the majority of the pointable surface.
  //
  // Same placement rationale as the structural branch above: ahead of the
  // agent-resolve check, so TypeScript narrows the rest of this function to
  // style intents and no property/value access below can see a class intent.
  if (isClassEdit(intent)) {
    const inlineNote =
      (intent.inlineSets?.length ?? 0) + (intent.inlineRemoves?.length ?? 0) > 0
        ? `\n\nThe same gesture also ` +
          [
            intent.inlineSets?.length
              ? `SETS ${intent.inlineSets.map(s => `${s.property}: ${s.value}`).join(', ')}`
              : '',
            intent.inlineRemoves?.length
              ? `REMOVES ${intent.inlineRemoves.map(r => r.property).join(', ')}`
              : '',
          ].filter(Boolean).join(' and ') +
          `. Apply those together with the class change — they belong to one user action, and ` +
          `landing one without the other leaves the element in a state the user never asked for.`
        : ''
    return {
      intentId,
      status: 'needs-source-edit' as const,
      intent,
      reason:
        `Class change: ${describeClassOp(intent.classOp)}` +
        `. This intent carries no file position — the element had no build-time anchor, so ` +
        `locate the call site from its sourceResolutionHint and edit the className there.` +
        inlineNote +
        `\n\nEdit the className in SOURCE. Do not set the class via a style attribute or a ` +
        `runtime classList call: the user is editing their component, and a change that only ` +
        `exists at runtime disappears on the next render and cannot be reviewed in a diff.`,
    }
  }

  if (isAgentResolvedIntent(intent)) {
    return {
      intentId,
      status: 'needs-source-edit' as const,
      intent,
      reason: 'Agent-resolve edit requires source resolution before writing source. Use sourceResolutionHint when present to locate the user source, apply the edit with the Edit tool, then discard this intent after it is handled.',
    }
  }

  // Pseudo-element intents (::before / ::after) are not supported by the
  // EditRequest shape — there's no `pseudo` field on it, so the pipeline
  // would silently target the base element. Return needs-source-edit so
  // Claude can write the pseudo selector via Edit tool. (Codex caught this
  // in Step 4 review.)
  if (intent.pseudo) {
    return {
      intentId,
      status: 'needs-source-edit' as const,
      intent,
      reason: `Pseudo-element edits (${intent.pseudo}) require source rewrite — use the Edit tool on the file at ${intent.source} to set ${intent.property} to ${intent.value}.`,
    }
  }

  // Session-level in-flight gate: two concurrent applyEditsCore calls for the
  // same intentId would collide on the pipeline's debounce-timer key
  // (source:property). The second handleEdit cancels the first's timer and
  // the first's resolver hangs until timeout. Refuse concurrent dispatch up
  // front — the second caller gets failed-already-in-flight immediately, the
  // first proceeds normally. (CodeRabbit Major caught this in PR #97 review.)
  if (!pipeline.beginApply(intentId)) {
    return {
      intentId,
      status: 'failed' as const,
      error: 'Apply already in-flight for this intentId; retry after current apply completes.',
    }
  }

  try {
    // Synthetic editId — `apply-${callId}-${intentId}` is unique across both
    // concurrent calls (callId from caller) AND the browser-generated editId
    // namespace (which uses no `apply-` prefix).
    const editId = `apply-${callId}-${intentId}`
    const resultPromise = pipeline.registerApplyResolver(editId, timeoutMs)

    // Convert PendingEdit -> EditRequest. PendingEdit lacks elementSelector;
    // pass '' for paths that don't need it. baselineValue carries previousValue
    // through to the Tailwind path's old-token resolution (see edit-pipeline.ts
    // executeEdit). Without this, Tailwind apply fails silently when the
    // debounce-time lastValues cache is empty (always the case for MCP path).
    pipeline.handleEdit({
      editId,
      source: intent.source,
      property: intent.property,
      value: intent.value,
      elementSelector: '',
      scope: intent.scope,
      instanceSources: intent.instanceSources,
      baselineValue: intent.previousValue,
      mcpMode: true,
    })

    const result = await resultPromise

    if (result.status === 'applied') {
      cache.remove([intentId]) // AC3 — remove from buffer on deterministic apply
      return { intentId, status: 'applied' as const, mechanism: result.mechanism }
    }
    if (result.status === 'needs-source-edit') {
      return {
        intentId,
        status: 'needs-source-edit' as const,
        intent,
        reason: result.reason ?? `Apply via source edit: use the Edit tool on the file at ${intent.source} to set ${intent.property} to ${intent.value}.`,
      }
    }
    // result.status === 'failed' — including timeouts (reason_code: 'apply_timeout')
    return { intentId, status: 'failed' as const, error: result.reason }
  } finally {
    pipeline.endApply(intentId)
  }
}

// ---------------------------------------------------------------------------
// getIntentContext helpers — pure slicer + size guard, used by vite.ts
// handleRPC.getIntentContext.
//
// Extracted so the production contract (line ranges, clamp boundaries,
// size-cap error format) is unit-testable in isolation without mounting an
// MCP test rig. The vite.ts integration test that exercises these helpers
// makes envelope-only assertions (intentId echo, target line non-empty)
// because the slice contents and error format are pinned here.
// ---------------------------------------------------------------------------

/** Max file size readable by cortex_get_intent_context (2MB). Synchronous
 *  fs.readFileSync blocks the Vite Node event loop; capping at ~10× a
 *  generous source-file size keeps the read non-blocking even when a
 *  project has large generated artefacts (lockfiles, asset bundles, db
 *  dumps) under projectRoot. Files exceeding this are rejected before the
 *  read. Exported so the size-cap test can pin the exact threshold. */
export const MAX_INTENT_FILE_BYTES = 2 * 1024 * 1024

/** Pure slicer for getIntentContext: given file content and a 1-based line
 *  number, return ~10 lines before + target + ~10 lines after. Clamps to
 *  file boundaries so neither index can underflow or overflow. The returned
 *  `currentValue` is the target line text — AST-based property-value
 *  extraction would let currentValue distinguish the actual property value
 *  from surrounding JSX, but the line-text fallback is sufficient for the
 *  divergence-detection use case (criterion 8) and avoids pulling in a
 *  parser dependency. */
export function sliceIntentContext(
  fileContent: string,
  line: number,
): { before: string[]; target: string; after: string[]; currentValue: string } {
  const lines = fileContent.split('\n')
  const targetIdx = line - 1
  const beforeStart = Math.max(0, targetIdx - 10)
  const afterEnd = Math.min(lines.length - 1, targetIdx + 10)
  const targetLine = lines[targetIdx] ?? ''
  return {
    before: lines.slice(beforeStart, targetIdx),
    target: targetLine,
    after: lines.slice(targetIdx + 1, afterEnd + 1),
    currentValue: targetLine,
  }
}

/** Defensive size guard for getIntentContext file reads. Returns the
 *  structured rejection envelope when the file exceeds the cap; returns
 *  null when the read should proceed. Centralizes the error format so
 *  tests pin it without shadow-copying the message string. */
export function checkIntentFileSize(
  filePath: string,
  sizeBytes: number,
): { error: string } | null {
  if (sizeBytes > MAX_INTENT_FILE_BYTES) {
    return {
      error: `File too large for intent context: ${filePath} (${sizeBytes} bytes, max ${MAX_INTENT_FILE_BYTES})`,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// parseIntentSource — `file:line:col` parser for PendingEdit.source
//
// Extracted from handleRPC.getIntentContext to make line-component validation
// directly unit-testable. isValidPendingEdit caps source length but does not
// parse format, so a value like `bogus:abc:1` can pass the WS gate and be
// cached. Callers must reject malformed sources before path resolution or
// fs access — `parseInt('abc', 10) → NaN`, and a NaN line index produces
// garbage slices in sliceIntentContext (Copilot review on PR #90).
// ---------------------------------------------------------------------------

export type ParseIntentSourceResult =
  | { ok: true; filePath: string; line: number }
  | { ok: false; error: string }

/** Parse `PendingEdit.source` (format `file:line:col`).
 *
 *  Splits on the LAST two colons so file paths with embedded colons (Windows
 *  drive letters, URL schemes) parse correctly. Validates that line is a
 *  positive integer; rejects NaN, 0, negative, and decimal values. column is
 *  not parsed because no current consumer reads it — adding it would be
 *  speculative scope. */
export function parseIntentSource(source: string): ParseIntentSourceResult {
  // A preview source (`cortex-preview:<id>`) is a SECOND, deliberate source
  // format with no file position — it names a DOM node cortex stamped at click
  // time because the element carried no build-time anchor. It has one colon, so
  // the `file:line:col` split below rejects it as "Malformed", which is both
  // wrong and unactionable: nothing is malformed, this format simply has no file
  // to parse. Callers must branch on isPreviewSource BEFORE reaching here.
  //
  // This produced COR-24: `cortex_get_intent_context` returned an error for
  // 100% of agent-resolve intents, and since the schema forces every structural
  // intent onto that path, Claude's only source-inspection tool was dead on the
  // majority of the surface. The parser was correct for what it was written for;
  // it broke when a second format was introduced without auditing consumers.
  if (isPreviewSource(source)) {
    // Deliberately does NOT echo `source`. The preview id is page-controllable
    // (`ensurePreviewId` preserves an existing `data-cortex-preview-id`), and a
    // result with no `sourceResolutionHint` is not fenced by `serializeForAgent`
    // — so interpolating it here would put attacker-authored prose in front of
    // the agent with no wrapper and no warning. The caller already has the value
    // it passed in; nothing is lost by naming the SHAPE instead.
    return {
      ok: false,
      error:
        'Not a file position: this is an agent-resolve intent (source begins ' +
        '"cortex-preview:"). It carries a sourceResolutionHint instead of a ' +
        'file:line:col — use that to locate the source.',
    }
  }
  const lastColon = source.lastIndexOf(':')
  const secondLastColon = source.lastIndexOf(':', lastColon - 1)
  if (lastColon < 0 || secondLastColon < 0) {
    return { ok: false, error: `Malformed source: ${source}` }
  }
  const filePath = source.slice(0, secondLastColon)
  const line = parseInt(source.slice(secondLastColon + 1, lastColon), 10)
  if (!Number.isInteger(line) || line < 1) {
    return { ok: false, error: `Invalid line in source: ${source}` }
  }
  return { ok: true, filePath, line }
}

/** What `cortex_get_intent_context` returns for an intent that has no file
 *  position. Deliberately NOT shaped like the file-slice response — the two are
 *  different answers, and blurring them is how a caller ends up treating a DOM
 *  hint as a source location. */
export interface AgentResolveIntentContext {
  resolution: 'agent-resolve'
  source: string
  /** Why there is no file slice, in terms the agent can act on. */
  reason: string
  /** The DOM evidence captured at click time. Null only if a producer violated
   *  the schema, which requires the hint on this path. */
  sourceResolutionHint: PendingEdit['sourceResolutionHint'] | null
  /** Present for multi-select; each entry is another element in the same intent. */
  instanceSources?: string[]
  guidance: string
}

/**
 * Build the context payload for an agent-resolve intent.
 *
 * Agent-resolve intents carry `cortex-preview:<id>` — a runtime-stamped DOM
 * handle, not a file position — so there is nothing to slice out of a file. The
 * useful answer is the evidence cortex captured at click time plus a statement
 * of what the agent should do with it.
 *
 * Lives in core, and both the Vite and webpack adapters call it, because this
 * repo has a documented history of the two adapters drifting apart (an existing
 * P2 covers webpack never sending annotation-updated/activity-entry). A shared
 * builder makes divergence impossible rather than merely unlikely.
 */
export function agentResolveIntentContext(intent: PendingEdit): AgentResolveIntentContext {
  const hint = intent.sourceResolutionHint ?? null
  // EVERY top-level string here is page-derived, and `sanitizeHintsForAgent`
  // only descends into `sourceResolutionHint` objects — it never sees one. Left
  // raw, a value carrying `</untrusted-page-content>` closes the fence early and
  // everything after it reads to the agent as trusted content.
  //
  // Three fields are exposed, not one:
  //   - `guidance` quotes the hint text inline
  //   - `source` is `cortex-preview:<id>`, and `ensurePreviewId` PRESERVES an
  //     existing `data-cortex-preview-id`, so the id is page-controllable
  //   - `instanceSources` is a list of the same
  // Cortex-generated ids are `p<base36>-<base36>` and can never contain a marker,
  // so stripping is identity for every legitimate value and only alters injected
  // ones. (The hint object is stripped again downstream; stripping is idempotent.)
  //
  // Sanitizing INPUTS is not sufficient on its own. A `tagName` of
  // `/untrusted-page-content` passes `fenceSafe` untouched — it holds no `<` for
  // either pattern to match — and then the template below supplies the missing
  // `<` and `>`, manufacturing `</untrusted-page-content>` after sanitization.
  // The attacker never has to smuggle a delimiter past the filter; the string
  // literal donates it. So the ASSEMBLED guidance is stripped as well: sanitize
  // what you emit, not only what you receive.
  const fenceSafe = (v: string | undefined): string => (v ? stripFenceMarkers(v) : '')

  // With no hint the response contains no `sourceResolutionHint` OBJECT, so
  // `containsPageDerivedHint` is false, `serializeForAgent` emits plain JSON, and
  // nothing is fenced at all. Marker-stripping would still stop the wrapper being
  // terminated, but there is no wrapper — arbitrary attacker prose inside the
  // preview id would reach the agent unlabelled. Redact to the shape instead,
  // exactly as `parseIntentSource` does above. This branch means a producer
  // violated the schema; the id has no diagnostic value the intentId lacks.
  if (!hint) {
    return {
      resolution: 'agent-resolve',
      source: `${PREVIEW_SOURCE_PREFIX}<redacted — no resolution hint recorded>`,
      reason:
        'This intent has no build-time source anchor, so there is no file:line to read. ' +
        'The element was identified at runtime instead.',
      sourceResolutionHint: null,
      guidance:
        'No resolution hint was recorded, which should not happen on this path — ' +
        'report this rather than guessing at a source location.',
    }
  }

  return {
    resolution: 'agent-resolve',
    source: fenceSafe(intent.source),
    reason:
      'This intent has no build-time source anchor, so there is no file:line to read. ' +
      'The element was identified at runtime instead.',
    sourceResolutionHint: hint,
    ...(intent.instanceSources?.length
      ? { instanceSources: intent.instanceSources.map(fenceSafe) }
      : {}),
    guidance: stripFenceMarkers(
      `Locate the source yourself using the hint: a <${fenceSafe(hint.tagName)}> element` +
        (hint.className ? ` with class "${fenceSafe(hint.className)}"` : '') +
        (hint.id ? ` with id "${fenceSafe(hint.id)}"` : '') +
        (hint.textPreview
          ? ` whose text begins "${fenceSafe(hint.textPreview).slice(0, 60)}"`
          : '') +
        (hint.domSelector ? ` matching the selector "${fenceSafe(hint.domSelector)}"` : '') +
        `. Search the project for the JSX that renders it, then apply the edit with ` +
        `your Edit tool. Close the loop with cortex_acknowledge_source_edit on ` +
        `success, or cortex_report_source_edit_failed if the write did not land — ` +
        `NOT cortex_discard_edits, which means the user changed their mind. The wire ` +
        `effect is the same but the recorded outcome is not. If several candidates ` +
        `match and you cannot tell them apart, ask the user rather than guessing.`,
    ),
  }
}
