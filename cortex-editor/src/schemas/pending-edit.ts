import { z } from 'zod'
import { MAX_INTENT_SOURCE_BYTES, MAX_SOURCE_HINT_FIELD_BYTES } from '../shared/pending-edit-limits.js'
import { isPreviewSource } from '../shared/preview-source.js'

// ---------------------------------------------------------------------------
// PendingEdit schema — canonical source for the staging-buffer wire format and
// its size bounds. core/staged-edits.ts imports MAX_FULL_SYNC_SIZE and
// pendingEditSchema from this module; types.ts re-exports z.infer<typeof pendingEditSchema>.
//
// Shared browser/core bounds live in shared/pending-edit-limits.ts. The imperative
// validator isValidPendingEdit (now @deprecated thin wrapper at core/staged-edits.ts)
// delegates to pendingEditSchema.safeParse, so consistency is structural.
// ---------------------------------------------------------------------------

export const MAX_INTENT_VALUE_BYTES = 4096
export const MAX_INTENT_ID_BYTES = 256
export const MAX_INTENT_PROPERTY_BYTES = 256
export const MAX_INTENT_INSTANCE_SOURCES = 100
export { MAX_INTENT_SOURCE_BYTES, MAX_SOURCE_HINT_FIELD_BYTES }

/** Defensive cap on staged-edits-sync batch size — 2× browser MAX_ENTRIES (500).
 *  Mirrors the cap enforced by StagedEditsCache.mergeFullSync at runtime.
 *  Defined here (not in core/staged-edits.ts) to keep schemas/ a leaf module
 *  with no upward imports — wire-format.ts uses it for envelope-level rejection
 *  before per-element validation runs. The runtime cache's cap is re-exported
 *  from this constant; both must stay in sync. */
export const MAX_FULL_SYNC_SIZE = 1000

// ---------------------------------------------------------------------------
// UTF-8 byte helpers
//
// JS string.length measures UTF-16 code units, not UTF-8 bytes. The constants
// above are intentionally named *_BYTES to express byte limits. TextEncoder
// is available in Node 16+ and all modern browsers.
// ---------------------------------------------------------------------------

/** Count UTF-8 bytes in a string. Uses TextEncoder which is available in all
 *  modern JS environments (Node 16+, browsers, Deno). */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length

/**
 * Shared schema for intent IDs (256-byte UTF-8 cap, non-empty).
 *
 * Used by:
 * - pendingEditSchema.intentId (this file)
 * - browserToServerSchema staged-edit-remove arm (wire-format.ts)
 * - serverToBrowserSchema staged-edits-discard arm (wire-format.ts)
 * - cortexApplyEditsInputSchema/cortexDiscardEditsInputSchema array elements (mcp-tool-inputs.ts)
 * - cortexGetIntentContextInputSchema.intentId (mcp-tool-inputs.ts)
 *
 * Centralizing prevents the F2/F14 class of bug where one site uses raw
 * z.string().max() (UTF-16 code units) and another uses the byte-bounded
 * version — drift between trust boundaries.
 */
export const intentIdSchema = z
  .string()
  .min(1, 'intentId must not be empty')
  .refine(
    (v) => utf8Bytes(v) <= MAX_INTENT_ID_BYTES,
    { message: `intentId exceeds ${MAX_INTENT_ID_BYTES} UTF-8 bytes` },
  )

const sourceHintField = (fieldName: string) =>
  z.string().refine(
    (v) => utf8Bytes(v) <= MAX_SOURCE_HINT_FIELD_BYTES,
    { message: `${fieldName} exceeds ${MAX_SOURCE_HINT_FIELD_BYTES} UTF-8 bytes` },
  )

const requiredSourceHintField = (fieldName: string) =>
  z.string().min(1).refine(
    (v) => utf8Bytes(v) <= MAX_SOURCE_HINT_FIELD_BYTES,
    { message: `${fieldName} exceeds ${MAX_SOURCE_HINT_FIELD_BYTES} UTF-8 bytes` },
  )

/** Exported so the `comment` wire message reuses this EXACT shape rather than
 *  redeclaring it. COR-27 gave comments a hint too; two independent declarations
 *  of one page-derived payload would drift on the byte caps, and the caps are
 *  what stop an oversized hint being rejected wholesale by the server. */
export const sourceResolutionHintSchema = z.object({
  tagName: requiredSourceHintField('tagName'),
  className: sourceHintField('className').optional(),
  id: sourceHintField('id').optional(),
  textPreview: sourceHintField('textPreview'),
  domSelector: requiredSourceHintField('domSelector'),
})

/**
 * Zod schema for PendingEdit.
 *
 * Enforces both shape and UTF-8 byte size bounds.
 * The `.finite()` check on timestamp rejects NaN/Infinity,
 * matching the `!Number.isFinite(v.timestamp)` guard.
 *
 * Size fields use `.refine(utf8Bytes(v) <= N)` rather than `.max(N)` so that
 * multi-byte characters (e.g. 4-byte emoji at 4 UTF-8 bytes each) are counted
 * correctly — JS `.max(N)` measures UTF-16 code units, not bytes.
 */
/**
 * A structural intent — an edit that changes the SHAPE of the tree rather than
 * a CSS property on one node (B2).
 *
 * ## Why this cannot be a style edit
 *
 * The mechanizable edit for "move this button left" is `style={{ order: 2 }}`,
 * and it is dishonest. CSS `order` changes VISUAL order without changing DOM
 * order, so screen readers and sequential focus still follow the original
 * sequence. Shipping it would be a real a11y regression that looks correct in
 * a screenshot. A move must reach source as a move.
 *
 * ## Why a whole-container ORDER, not a from/to index pair
 *
 * The first cut of this encoded a move as `fromIndex → toIndex`. External
 * review took it apart, and every finding was the same flaw wearing different
 * clothes: those are RELATIVE coordinates, and nothing pinned the baseline they
 * are relative to. Applying a subset, applying out of order, discarding one
 * intent, retrying after a crash, merging two tabs' logs, or evicting the
 * oldest entry each silently invalidated every later index — producing a
 * confidently wrong reorder rather than a visible failure.
 *
 * Enforcing ordering, completeness, idempotency and single-writer semantics
 * across the whole pipeline would be four new invariants. Stating the INTENDED
 * RESULT instead removes the need for all four: one intent describes one
 * container's final child order, so it is idempotent, order-independent, and
 * unaffected by any other intent being dropped. It also restores plain
 * last-write-wins dedupe — the newest order for a container is the only one
 * that matters — which is why structural intents no longer need an ordered log.
 *
 * `baseline` carries the children as they were when the user dragged, so drift
 * is detectable: if the live children no longer match, the intent describes a
 * tree that no longer exists and is discarded rather than applied to whatever
 * is there now.
 *
 * ## Why sources cannot identify a slot on their own
 *
 * JSX inside a `.map()` renders N siblings sharing ONE `data-cortex-source`, so
 * "insert before sibling X" names no slot. Positions within `baseline` are
 * unambiguous, and `parentKey` disambiguates WHICH runtime container is meant
 * when one source renders more than once.
 *
 * ## Known limitation: a DOM child is not always a JSX child
 *
 * `baseline`/`order` index the live DOM's element children, while the agent
 * edits source. They correspond only when each JSX child renders exactly one
 * element; conditional children, fragments and multi-root components break the
 * correspondence. For `[A, {flag && <B/>}, C, D]` with `flag === false` the DOM
 * has three children, so the agent must treat the order as the intended RESULT
 * and verify against the source it reads, not as raw JSX offsets.
 */
export const structuralIntentSchema = z.object({
  op: z.literal('reorder'),
  /** Source location of the container whose children are reordered. */
  parentSource: z.string().min(1).refine((v) => utf8Bytes(v) <= MAX_INTENT_SOURCE_BYTES, { message: `parentSource exceeds ${MAX_INTENT_SOURCE_BYTES} UTF-8 bytes` }),
  /**
   * Which RUNTIME INSTANCE of `parentSource` this is.
   *
   * One source location can render many times — `<Column/>` twice, each with
   * identical rows, gives both containers the same `parentSource` and every row
   * the same `source`. Without this, reordering the left column and reordering
   * the right produce byte-identical payloads and the agent cannot know which
   * backing array to touch. Opaque to the schema; the producer supplies a
   * stable per-instance identifier (e.g. a DOM path from a known ancestor).
   */
  parentKey: z.string().min(1).refine((v) => utf8Bytes(v) <= MAX_INTENT_SOURCE_BYTES, { message: `parentKey exceeds ${MAX_INTENT_SOURCE_BYTES} UTF-8 bytes` }),
  /**
   * The children's `data-cortex-source` values in DOM order AT CAPTURE TIME.
   *
   * This is the baseline the reorder is stated against, carried so staleness is
   * DETECTABLE rather than assumed. If the live children no longer match, the
   * intent describes a tree that no longer exists and must be discarded instead
   * of applied to whatever happens to be there now.
   */
  baseline: z.array(z.string()).min(2).max(MAX_INTENT_INSTANCE_SOURCES),
  /**
   * A discriminator per child, in the same order as `baseline` (COR-35).
   *
   * `baseline` cannot answer "did these children get reordered". N siblings
   * from one `.map()` share ONE `data-cortex-source`, so `baseline` is N
   * identical strings and comparing it position-by-position is satisfied under
   * every permutation. The length check caught insertion and deletion; nothing
   * caught the one mutation a reorder intent is actually racing.
   *
   * These entries must be pairwise DISTINCT, which is what turns the guard from
   * a heuristic into a proof: given distinct keys at capture, positional
   * comparison against the live children detects EVERY permutation, not most of
   * them. Producers build them with `childDiscriminator` (browser/
   * child-discriminator.ts) and the guard re-derives them with the same
   * function, so there is one definition rather than two that can drift.
   *
   * REQUIRED, not optional, and deliberately so. No producer of structural
   * intents exists yet, so there is no wire compatibility to preserve and
   * nothing to migrate — while an optional field would let the first producer
   * omit it and silently restore the exact bug this closes. Uniqueness within
   * one parent's child list is a far weaker requirement than per-instance
   * identity and depends on nothing from React internals or the bundler.
   *
   * When children genuinely cannot be told apart — several identical icons, say
   * — no distinct set exists, the intent fails validation, and the reorder is
   * refused. That is the intended outcome: a list whose order cannot be
   * verified is one where a stale reorder writes to the wrong element.
   */
  childKeys: z
    .array(z.string().min(1).refine((v) => utf8Bytes(v) <= MAX_SOURCE_HINT_FIELD_BYTES, { message: `childKeys element exceeds ${MAX_SOURCE_HINT_FIELD_BYTES} UTF-8 bytes` }))
    .min(2)
    .max(MAX_INTENT_INSTANCE_SOURCES),
  /**
   * The desired final order, as a permutation of `baseline`'s INDICES.
   *
   * `order[i] === j` means "the child at baseline position j ends up at
   * position i". Absolute, not relative: it describes the intended RESULT, so
   * it is idempotent, independent of any other intent, and unaffected by the
   * order intents are applied or by one being discarded.
   */
  order: z.array(z.number().int().nonnegative().finite()).min(2).max(MAX_INTENT_INSTANCE_SOURCES),
})

export type StructuralIntent = z.infer<typeof structuralIntentSchema>

/** Fields common to every intent kind. */
const intentBase = {
  intentId: intentIdSchema,
  source: z.string().min(1).refine((v) => utf8Bytes(v) <= MAX_INTENT_SOURCE_BYTES, { message: `source exceeds ${MAX_INTENT_SOURCE_BYTES} UTF-8 bytes` }),
  scope: z.enum(['instance', 'all']).optional(),
  applyMode: z.enum(['direct', 'agent-resolve']).optional(),
  sourceResolutionHint: sourceResolutionHintSchema.optional(),
  instanceSources: z
    .array(z.string().refine((v) => utf8Bytes(v) <= MAX_INTENT_SOURCE_BYTES, { message: `instanceSources element exceeds ${MAX_INTENT_SOURCE_BYTES} UTF-8 bytes` }))
    .max(MAX_INTENT_INSTANCE_SOURCES)
    .optional(),
  timestamp: z.number().finite(),
}

/**
 * A style intent — one CSS property/value pair at one locus. The original and
 * still overwhelmingly common shape.
 *
 * `kind` is REQUIRED on this schema but optional ON THE WIRE: `withDefaultKind`
 * normalises a missing `kind` to 'style' before the union discriminates, so
 * every intent written by an older browser bundle continues to validate
 * unchanged while in-repo producers still get compile-time enforcement. New structural
 * intents carry `kind: 'structural'` explicitly, which an older MCP server will
 * REJECT at validation rather than silently mis-apply — fail-closed is the
 * correct behaviour for a version skew between the injected bundle and a
 * separately-installed `cortex mcp`.
 */
export const styleEditSchema = z.object({
  ...intentBase,
  kind: z.literal('style'),
  property: z.string().min(1).refine((v) => utf8Bytes(v) <= MAX_INTENT_PROPERTY_BYTES, { message: `property exceeds ${MAX_INTENT_PROPERTY_BYTES} UTF-8 bytes` }),
  value: z.string().refine((v) => utf8Bytes(v) <= MAX_INTENT_VALUE_BYTES, { message: `value exceeds ${MAX_INTENT_VALUE_BYTES} UTF-8 bytes` }),
  previousValue: z.string().refine((v) => utf8Bytes(v) <= MAX_INTENT_VALUE_BYTES, { message: `previousValue exceeds ${MAX_INTENT_VALUE_BYTES} UTF-8 bytes` }),
  pseudo: z.enum(['::before', '::after']).optional(),
})

export const structuralEditSchema = z.object({
  ...intentBase,
  kind: z.literal('structural'),
  structural: structuralIntentSchema,
})

/** The class mutation shape. Defined HERE rather than in wire-format.ts, which
 *  held a byte-identical private copy — the same drift class composite-key.ts
 *  exists to prevent. wire-format imports this one. */
/** A class op names exactly ONE token. Whitespace is rejected rather than
 *  trimmed or split: `classList.contains` throws `InvalidCharacterError` on a
 *  value containing whitespace, so `add: "foo bar"` is not a slightly-wrong
 *  intent, it is one that crashes the reconnect convergence check. Refusing it
 *  at the envelope keeps that unreachable. */
const classToken = z
  .string()
  .min(1)
  .refine(v => !/\s/.test(v), { message: 'class token must not contain whitespace' })

export const classOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add'), add: classToken }),
  z.object({ kind: z.literal('remove'), remove: classToken }),
  z.object({ kind: z.literal('swap'), remove: classToken, add: classToken }),
])

/**
 * A class intent — a className mutation at one locus, optionally with inline
 * property writes that belong to the same gesture.
 *
 * Exists because class ops previously had NO staged representation: they were
 * dispatched straight down the direct-write wire path, which needs a file
 * position. On an element with no `data-cortex-source` the gesture hit
 * `if (!source) return` and silently evaporated (COR-25) — and on a
 * component-library app that is the majority of the pointable surface.
 *
 * With a staged form, an unannotated class op becomes an `agent-resolve` intent
 * carrying the DOM hint, exactly like a style edit on the same element, and the
 * agent locates the call site. Two consequences, and the second is the one that
 * mattered: the gesture works, and it becomes VISIBLE to the identity hit-rate
 * gate, which scores intents that reached the agent. Gestures that never became
 * intents were invisible to it, so the gate over-reported.
 *
 * `inlineSets`/`inlineRemoves` mirror the compound wire message: a Tailwind swap
 * often clears the longhand properties it supersedes, and splitting that across
 * two intents would let one land without the other.
 */
export const classEditSchema = z.object({
  ...intentBase,
  kind: z.literal('class'),
  classOp: classOpSchema,
  // NO `pseudo`. A class attaches to the OWNING element — there is no way to put
  // one on a ::before box — so carrying the panel's active pseudo tab here would
  // tell the agent to make a change at a target that does not exist, and the
  // reason string would read "on the ::before pseudo-element" for an edit that
  // must land on the element itself.
  inlineSets: z
    .array(z.object({ property: z.string().min(1), value: z.string() }))
    .max(MAX_INTENT_INSTANCE_SOURCES)
    .optional(),
  inlineRemoves: z
    .array(z.object({ property: z.string().min(1) }))
    .max(MAX_INTENT_INSTANCE_SOURCES)
    .optional(),
})

/**
 * `kind` is optional on the wire for back-compat, but a discriminated union
 * needs it PRESENT to select a branch. Normalising it here — rather than using
 * a plain `z.union` — is what preserves error quality: `z.union` attempts every
 * member and reports a nested `invalid_union`, so a bad `timestamp` stopped
 * rejecting at path ['timestamp'] and became unreadable. `z.discriminatedUnion`
 * picks the branch first and reports only that branch's issues, so every
 * existing error path is unchanged.
 *
 * Non-object inputs pass through untouched so the union reports its own
 * "expected object" error rather than this preprocessing throwing.
 */
const withDefaultKind = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  try {
    // Reading a property invokes accessors, and spreading does too. An object
    // with a throwing `kind` getter would propagate synchronously out of
    // safeParse — breaking zod's never-throws contract and this function's own
    // promise to pass odd input through. Not reachable from today's callers
    // (every one feeds JSON.parse output, and JSON cannot encode accessors),
    // but a landmine for any future in-process caller.
    const record = value as Record<string, unknown>
    if (record.kind === undefined) return { ...record, kind: 'style' }
    return value
  } catch {
    // Returning the original value here would NOT be safe: the discriminated
    // union reads `.kind` itself, so the same accessor would throw again,
    // uncaught. Hand back an object whose discriminator is readable and
    // invalid, so validation fails cleanly with "invalid discriminator" instead
    // of propagating out of safeParse.
    return { kind: '__unreadable__' }
  }
}

export const pendingEditSchema = z.preprocess(
  withDefaultKind,
  z.discriminatedUnion('kind', [structuralEditSchema, classEditSchema, styleEditSchema]),
).superRefine((edit, ctx) => {
  if ((edit.applyMode === 'agent-resolve' || isPreviewSource(edit.source)) && !edit.sourceResolutionHint) {
    ctx.addIssue({
      code: 'custom',
      path: ['sourceResolutionHint'],
      message: 'sourceResolutionHint is required for agent-resolve or preview-source intents',
    })
  }
  // A structural intent has no deterministic rewriter and must never acquire
  // one silently — `set_inline_style` writing `style={{order}}` is the exact
  // a11y regression this type exists to prevent. Enforced at the envelope so
  // no producer can route a move to the direct path.
  // A class intent is only ever PRODUCED on the agent-resolve path — the direct
  // path writes className at a file position and never stages. Accepting a
  // forged `direct` (or omitted) mode with an attacker-chosen `source` let a
  // page reach the agent through `staged-edit-add` with NO hint, and
  // `serializeForAgent` fences only payloads that carry a sourceResolutionHint —
  // so the forged source arrived unfenced. Requiring the mode makes the hint
  // mandatory via the check above, which closes both halves at once.
  if (edit.kind === 'class' && edit.applyMode !== 'agent-resolve') {
    ctx.addIssue({
      code: 'custom',
      path: ['applyMode'],
      message: "class intents must use applyMode 'agent-resolve' — the direct path writes className at a file position and never stages",
    })
  }
  if (edit.kind === 'structural' && edit.applyMode !== 'agent-resolve') {
    ctx.addIssue({
      code: 'custom',
      path: ['applyMode'],
      message: "structural intents must use applyMode 'agent-resolve' — there is no deterministic move rewriter",
    })
  }
  if (edit.kind === 'structural') {
    const { baseline, order, childKeys } = edit.structural
    // COR-35. `baseline` is N identical strings for a `.map()`, so it cannot
    // witness a permutation; `childKeys` is what can, and only while these two
    // properties hold. Both are checked here rather than left to the producer:
    // the guard's correctness argument — positional comparison detects EVERY
    // reorder — is only true when the keys are pairwise distinct, so this is
    // the invariant the guard rests on, not a hygiene check.
    if (childKeys.length !== baseline.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['structural', 'childKeys'],
        message: `childKeys has ${childKeys.length} entries but baseline has ${baseline.length}`,
      })
    } else if (new Set(childKeys).size !== childKeys.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['structural', 'childKeys'],
        message: 'childKeys must be pairwise distinct — children that cannot be told apart cannot have a reorder verified against them',
      })
    }
    // `order` must be a genuine permutation of `baseline`'s indices. Anything
    // else — a duplicate, an out-of-range index, a length mismatch — describes
    // a tree that cannot exist, and the agent would have to guess.
    if (order.length !== baseline.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['structural', 'order'],
        message: `order has ${order.length} entries but baseline has ${baseline.length}`,
      })
    } else if (new Set(order).size !== order.length || order.some(i => i >= baseline.length)) {
      ctx.addIssue({
        code: 'custom',
        path: ['structural', 'order'],
        message: 'order must be a permutation of baseline indices — no duplicates, none out of range',
      })
    } else if (order.every((sourceIndex, position) => sourceIndex === position)) {
      // The identity permutation changes nothing; staging it would send the
      // agent to rewrite source for a reorder the user did not make.
      ctx.addIssue({
        code: 'custom',
        path: ['structural', 'order'],
        message: 'reorder is a no-op: order is the identity permutation',
      })
    }
  }
})

/** True when the intent changes tree shape rather than a CSS property. */
export function isStructuralEdit(edit: PendingEditSchema): edit is StructuralEditSchema {
  return edit.kind === 'structural'
}

/** True when the intent mutates className rather than a CSS property. */
export function isClassEdit(edit: PendingEditSchema): edit is ClassEditSchema {
  return edit.kind === 'class'
}

/** True when the intent carries `property`/`value` — the only kind that does.
 *
 *  Prefer this over `!isStructuralEdit(e)`, which was correct while there were
 *  exactly two kinds and silently started admitting class intents when a third
 *  arrived. A negative guard over an open union is a latent bug.
 *
 *  A MISSING `kind` counts as style, and that is not leniency — it mirrors the
 *  wire contract exactly. `kind` is optional on the wire and `withDefaultKind`
 *  normalises an absent one to 'style' before the union discriminates, so an
 *  in-memory intent that never passed through the schema (the browser staging
 *  buffer holds raw objects) legitimately has none. A bare `=== 'style'` test
 *  silently skipped those, which is how this guard first broke reconcile. */
export function isStyleEdit(edit: PendingEditSchema): edit is StyleEditSchema {
  return edit.kind === 'style' || (edit as { kind?: unknown }).kind === undefined
}

/** Human-readable one-liner for a class mutation, for agent-facing summaries. */
export function describeClassOp(op: ClassEditSchema['classOp']): string {
  switch (op.kind) {
    case 'add': return `add class "${op.add}"`
    case 'remove': return `remove class "${op.remove}"`
    case 'swap': return `swap class "${op.remove}" → "${op.add}"`
  }
}

export type StyleEditSchema = z.infer<typeof styleEditSchema>
export type StructuralEditSchema = z.infer<typeof structuralEditSchema>
export type ClassEditSchema = z.infer<typeof classEditSchema>
export type PendingEditSchema = z.infer<typeof pendingEditSchema>
