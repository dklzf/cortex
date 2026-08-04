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

const sourceResolutionHintSchema = z.object({
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
 * ## Why positions, not sibling sources
 *
 * The obvious encoding is "insert before sibling X". It is ambiguous in exactly
 * the case that matters: JSX inside a `.map()` produces N siblings that all
 * share ONE `data-cortex-source`, so "before X" does not identify a slot.
 * Positions among the parent's element children are unambiguous for both
 * shapes, and translate directly to the two real edits — reorder the data array
 * for a `.map()`, reorder the JSX for hand-authored siblings.
 *
 * `source` (on the base) identifies the element being moved; `parentSource`
 * identifies the container whose children are being reordered. Both are carried
 * for the agent's benefit — it needs to find the JSX, not just the indices.
 *
 * ## Known limitation: DOM index is not always a JSX child slot
 *
 * These indices are computed in the BROWSER against live DOM; the agent edits
 * SOURCE. The two correspond only when each JSX child renders exactly one
 * element. They diverge for conditional children, fragments, and components
 * that return multiple roots. Concretely, for parent JSX
 * `[A, {flag && <B/>}, C, D]` with `flag === false`, the live DOM has three
 * element children `[A, C, D]`, so dragging D reports "position 2 → 0" while
 * counting raw JSX children would move C.
 *
 * `sourceResolutionHint` identifies the MOVED element but says nothing about
 * the destination's neighbours, so it does not close this gap. The agent must
 * therefore treat the indices as a description of the INTENDED RESULT — the
 * observable order the user asked for — and verify against the source it reads,
 * rather than applying them as raw JSX offsets. The `needs-source-edit` reason
 * in staged-edits.ts states this. Raised in architecture review and recorded
 * rather than silently assumed; it is the first thing to revisit when the move
 * gesture lands a producer.
 */
export const structuralIntentSchema = z.object({
  op: z.literal('move'),
  parentSource: z.string().min(1).refine((v) => utf8Bytes(v) <= MAX_INTENT_SOURCE_BYTES, { message: `parentSource exceeds ${MAX_INTENT_SOURCE_BYTES} UTF-8 bytes` }),
  /** Index of the moved element among its parent's ELEMENT children, before the move. */
  fromIndex: z.number().int().nonnegative().finite(),
  /** Index the element should occupy among those children after the move. */
  toIndex: z.number().int().nonnegative().finite(),
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
 * `kind` is OPTIONAL and defaults to 'style' on read, so every intent written
 * by an older browser bundle continues to validate unchanged. New structural
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
  z.discriminatedUnion('kind', [structuralEditSchema, styleEditSchema]),
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
  if (edit.kind === 'structural' && edit.applyMode !== 'agent-resolve') {
    ctx.addIssue({
      code: 'custom',
      path: ['applyMode'],
      message: "structural intents must use applyMode 'agent-resolve' — there is no deterministic move rewriter",
    })
  }
  if (edit.kind === 'structural' && edit.structural.fromIndex === edit.structural.toIndex) {
    ctx.addIssue({
      code: 'custom',
      path: ['structural', 'toIndex'],
      message: 'structural move is a no-op: fromIndex equals toIndex',
    })
  }
})

/** True when the intent changes tree shape rather than a CSS property. */
export function isStructuralEdit(edit: PendingEditSchema): edit is StructuralEditSchema {
  return edit.kind === 'structural'
}

export type StyleEditSchema = z.infer<typeof styleEditSchema>
export type StructuralEditSchema = z.infer<typeof structuralEditSchema>
export type PendingEditSchema = z.infer<typeof pendingEditSchema>
