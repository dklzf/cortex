/**
 * Wire-format schemas — canonical source of truth for browser↔server messages.
 *
 * The TS types in `src/adapters/types.ts` (`BrowserToServer`, `ServerToBrowser`,
 * `PendingEdit`) re-export `z.infer<>` from these schemas via aliases like
 * `export type BrowserToServer = BrowserToServerSchema`. Drift is impossible
 * by construction — the alias makes them literally identical.
 *
 * Root `tsc --noEmit` catches any inconsistency through the transitive consumers
 * that import both the schema (for runtime validation) and the type (for typed
 * function signatures).
 */
import { z } from 'zod'
import { pendingEditSchema, intentIdSchema, MAX_FULL_SYNC_SIZE, classOpSchema } from './pending-edit.js'

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

// Spacing-token name pattern: `--spacing-`, `--sp-`, `--gap-`, `--space-` namespaces.
// Mirrors `matchesSpacingPattern` in src/browser/tokens/family.ts. Tightening here
// rejects protocol drift (e.g., a server emitting `--color-primary` or `foo`) at the
// schema boundary rather than letting it reach the popover and fail filter-time.
const SPACING_TOKEN_NAME_PATTERN = /^--(spacing|sp|gap|space)-\S*$/

export const spacingTokenSchema = z.object({
  name: z.string().min(2).max(256).regex(SPACING_TOKEN_NAME_PATTERN),
  valuePx: z.number().nonnegative().finite(),
  source: z.enum(['tailwind-v3', 'tailwind-v4', 'css-variable']),
})



const elementContextSchema = z.object({
  tagName: z.string(),
  componentName: z.string().nullable(),
  domSelector: z.string(),
  textPreview: z.string(),
})

const fixMetaSchema = z.object({
  property: z.string(),
  value: z.string(),
  reason: z.string(),
})

const annotationKindSchema = z.enum(['comment', 'fix-request'])

const annotationStatusSchema = z.enum(['pending', 'acknowledged', 'resolved', 'dismissed'])

const threadMessageSchema = z.object({
  id: z.string(),
  from: z.enum(['user', 'agent']),
  text: z.string(),
  timestamp: z.number(),
})

const annotationSchema = z.object({
  id: z.string(),
  status: annotationStatusSchema,
  elementSource: z.string(),
  text: z.string(),
  elementContext: elementContextSchema.optional(),
  currentStyles: z.record(z.string(), z.string()).optional(),
  pinPosition: z.object({ x: z.number(), y: z.number() }).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  resolution: z.object({ summary: z.string() }).optional(),
  dismissReason: z.string().optional(),
  thread: z.array(threadMessageSchema),
  kind: annotationKindSchema.optional(),
  fixMeta: fixMetaSchema.optional(),
})

const activityEntrySchema = z.object({
  id: z.string(),
  type: z.enum(['edit', 'comment', 'status-change']),
  timestamp: z.number(),
  elementSource: z.string().optional(),
  description: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})

const styleCapabilitySchema = z.object({
  name: z.string(),
  status: z.enum(['supported', 'preview-only', 'ai-required']),
  reason: z.string().optional(),
})

const editKindSchema = z.enum(['immediate', 'jsx-immediate', 'deferred'])

// ---------------------------------------------------------------------------
// BrowserToServer — all 13 variants from types.ts:92-146
// ---------------------------------------------------------------------------

export const browserToServerSchema = z.discriminatedUnion('type', [
  // 1. init
  z.object({
    type: z.literal('init'),
    sessionId: z.string().optional(),
    /** Pillar 1: included by browsers running the new injected script.
     *  Server uses it to invalidate a stale active-tab adoption when a
     *  fresh tab connects (e.g. user refreshed). Absent on old browsers
     *  and CLI — both must continue to work without it. */
    tabId: z.string().optional(),
  }),

  // 2. cortex-closed
  z.object({
    type: z.literal('cortex-closed'),
  }),

  // 3. edit (class-op and inline-style variants share this schema)
  z.object({
    type: z.literal('edit'),
    token: z.string().optional(),
    protocolVersion: z.number().optional(),
    editId: z.string(),
    property: z.string(),
    value: z.string(),
    source: z.string(),
    elementSelector: z.string(),
    cssMapping: z.string().optional(),
    scope: z.enum(['instance', 'all']).optional(),
    instanceSources: z.array(z.string()).optional(),
    currentClass: z.string().optional(),
    classOp: classOpSchema.optional(),
    inlineSets: z.array(z.object({ property: z.string(), value: z.string() })).readonly().optional(),
    inlineRemoves: z.array(z.object({ property: z.string() })).readonly().optional(),
  }),

  // 4. undo
  z.object({
    type: z.literal('undo'),
    token: z.string().optional(),
    protocolVersion: z.number().optional(),
    editId: z.string().optional(),
  }),

  // 5. redo
  z.object({
    type: z.literal('redo'),
    token: z.string().optional(),
    protocolVersion: z.number().optional(),
    editId: z.string().optional(),
  }),

  // 6. comment (plain and fix-request variants)
  z.object({
    type: z.literal('comment'),
    token: z.string().optional(),
    protocolVersion: z.number().optional(),
    elementSource: z.string(),
    text: z.string(),
    elementContext: elementContextSchema.optional(),
    currentStyles: z.record(z.string(), z.string()).optional(),
    pinPosition: z.object({ x: z.number(), y: z.number() }).optional(),
    kind: annotationKindSchema.optional(),
    fixMeta: fixMetaSchema.optional(),
  }),

  // 7. comment-reply
  z.object({
    type: z.literal('comment-reply'),
    token: z.string().optional(),
    protocolVersion: z.number().optional(),
    annotationId: z.string(),
    text: z.string(),
  }),

  // 8. clear_server_undo
  z.object({
    type: z.literal('clear_server_undo'),
    token: z.string().optional(),
    protocolVersion: z.number().optional(),
  }),

  // 9. staged-edit-add
  z.object({
    type: z.literal('staged-edit-add'),
    edit: pendingEditSchema,
    token: z.string(),
  }),

  // 10. staged-edit-remove
  z.object({
    type: z.literal('staged-edit-remove'),
    intentIds: z.array(intentIdSchema),
    token: z.string(),
  }),

  // 11. staged-edit-clear
  z.object({
    type: z.literal('staged-edit-clear'),
    token: z.string(),
  }),

  // 12. staged-edits-sync — envelope-only validation (graceful degradation).
  // Per-element validation is intentionally deferred to the consumer (vite.ts):
  // a single malformed entry in a 500-edit multi-tab merge sync should NOT
  // reject the entire batch and lose 499 valid edits. Consumer filters
  // per-element via pendingEditSchema.safeParse and warns on drops.
  //
  // .max(MAX_FULL_SYNC_SIZE) caps batch size at the envelope boundary —
  // defense-in-depth against an authenticated tab sending ~1M tiny entries
  // (ws default maxPayload is 100MB). Mirrors StagedEditsCache.mergeFullSync's
  // runtime cap; both must stay in sync.
  z.object({
    type: z.literal('staged-edits-sync'),
    edits: z.array(z.unknown()).max(MAX_FULL_SYNC_SIZE),
    token: z.string(),
  }),

  // 13. staged-edits-ready
  z.object({
    type: z.literal('staged-edits-ready'),
    count: z.number(),
    requestId: z.string(),
    token: z.string(),
  }),

  // 14. cortex/set-active — unified activation request from any client
  z.object({
    type: z.literal('cortex/set-active'),
    active: z.boolean(),
    /** Browser-originated requests include the tab's stable ID for single-tab
     *  gating. CLI-originated requests omit it; server treats omission as
     *  "trusted CLI" and routes through the editorActive state machine
     *  without a tab gate. */
    tabId: z.string().optional(),
    /** Auth token, present on CLI-originated requests; browser sends as part
     *  of the standard write-message envelope. */
    token: z.string().optional(),
  }),
])

export type BrowserToServerSchema = z.infer<typeof browserToServerSchema>

// ---------------------------------------------------------------------------
// ServerToBrowser — variants mirror types.ts. Count is intentionally not stated
// here so additions (ZF0-1881 Pillar 1 added cortex/active-changed and
// cortex/inactive-tab) don't require updating a comment whose only role is to
// drift out of sync.
// ---------------------------------------------------------------------------

export const serverToBrowserSchema = z.discriminatedUnion('type', [
  // 1. cortex (CLI activation ack)
  z.object({ type: z.literal('cortex') }),

  // 2. cortex-close (CLI deactivation ack)
  z.object({ type: z.literal('cortex-close') }),

  // 3. cortex-toggle
  z.object({
    type: z.literal('cortex-toggle'),
    active: z.boolean(),
  }),

  // cortex/active-changed — server's authoritative broadcast after editorActive
  // changes. targetTabId scopes the broadcast to one browser tab in single-tab
  // mode; absence means "every tab applies it" (legacy/MCP path).
  z.object({
    type: z.literal('cortex/active-changed'),
    active: z.boolean(),
    targetTabId: z.string().optional(),
  }),

  // cortex/inactive-tab — sent to a tab whose cortex/set-active was rejected
  // because another tab is the active one. targetTabId identifies the
  // intended recipient; tabs filter on this so they only react when addressed.
  z.object({
    type: z.literal('cortex/inactive-tab'),
    targetTabId: z.string(),
    message: z.string(),
  }),

  // 4. hello
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.number(),
    sessionId: z.string(),
    swatches: z.array(z.string()).optional(),
    colorChips: z.array(z.object({
      name: z.string(),
      hex: z.string(),
      aliases: z.array(z.string()).optional(),
      source: z.enum(['page', 'theme']).optional(),
    })).optional(),
    textComponents: z
      .array(
        z.object({
          name: z.string(),
          fontSize: z.string(),
          lineHeight: z.string(),
          letterSpacing: z.string(),
          fontWeight: z.string(),
          fontFamily: z.string().optional(),
        }),
      )
      .optional(),
    spacingTokens: z.array(spacingTokenSchema).max(500).optional(),
  }),

  // 5. error
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    editId: z.string().optional(),
  }),

  // 6. edit_status
  z.object({
    type: z.literal('edit_status'),
    editId: z.string(),
    status: z.enum(['writing', 'done', 'failed', 'cancelled']),
    newToken: z.string().optional(),
    reason: z.string().optional(),
    reason_code: z
      .enum(['external_revert', 'invalid_class_token', 'write_failed', 'rewriter_failed', 'parse_failed', 'read_failed', 'apply_timeout'])
      .optional(),
    strategy: z.enum(['immediate', 'deferred']).optional(),
  }),

  // 7. undo_sync_status
  z.object({
    type: z.literal('undo_sync_status'),
    status: z.enum(['done', 'failed']),
    reason: z.string().optional(),
    reason_code: z.enum(['empty_stack', 'stale', 'write_failed']).optional(),
  }),

  // 8. redo_sync_status
  z.object({
    type: z.literal('redo_sync_status'),
    status: z.enum(['done', 'failed']),
    reason: z.string().optional(),
    reason_code: z.enum(['empty_stack', 'stale', 'write_failed']).optional(),
  }),

  // 9. hmr_verified
  z.object({
    type: z.literal('hmr_verified'),
    editId: z.string(),
    match: z.boolean(),
    expected: z.string().optional(),
    actual: z.string().optional(),
    kind: editKindSchema.optional(),
  }),

  // 10. hmr-applied
  z.object({
    type: z.literal('hmr-applied'),
    files: z.array(z.string()).optional(),
  }),

  // 11. annotation-created
  z.object({
    type: z.literal('annotation-created'),
    annotation: annotationSchema,
  }),

  // 12. annotation-updated
  z.object({
    type: z.literal('annotation-updated'),
    annotation: annotationSchema,
  }),

  // 12b. annotations-snapshot — server pushes this on browser `init` so
  // persisted annotations (CORTEX_PERSIST_ANNOTATIONS=true) re-appear in the
  // UI after a Vite dev-server restart. Without this, the reducer state
  // starts empty even though server-side AnnotationStore has hydrated.
  z.object({
    type: z.literal('annotations-snapshot'),
    annotations: z.array(annotationSchema),
  }),

  // 13. agent-status
  z.object({
    type: z.literal('agent-status'),
    connected: z.boolean(),
  }),

  // 14. activity-entry
  z.object({
    type: z.literal('activity-entry'),
    entry: activityEntrySchema,
  }),

  // 15. capabilities
  z.object({
    type: z.literal('capabilities'),
    systems: z.array(styleCapabilitySchema),
  }),

  // 16. staged-edits-discard
  // .max(MAX_FULL_SYNC_SIZE) is defense-in-depth: a huge intentIds array
  // produces a multi-MB WebSocket frame + O(n) browser-side work. Cap matches
  // the MCP input schema bounds in mcp-tool-inputs.ts.
  z.object({
    type: z.literal('staged-edits-discard'),
    intentIds: z.array(intentIdSchema).max(MAX_FULL_SYNC_SIZE),
  }),

  // 17. staged-edits-acked
  z.object({
    type: z.literal('staged-edits-acked'),
    requestId: z.string(),
  }),

  // 18. source-edit-failed (Change 7) — Edit tool failed to land a needs-source-edit
  // intent; intent stays in the buffer, reason surfaces via applyError.
  // ZF0-1869 Round-1 Fix 4: reason bounded to 2048 chars (defense-in-depth at the
  // wire layer; MCP input schema is bounded identically in mcp-tool-inputs.ts).
  // .max(MAX_FULL_SYNC_SIZE) mirrors the staged-edits-discard bound — defense-in-depth
  // against a huge intentIds array producing a multi-MB frame + O(n) browser work.
  z.object({
    type: z.literal('source-edit-failed'),
    intentIds: z.array(intentIdSchema).max(MAX_FULL_SYNC_SIZE),
    reason: z.string().max(2048),
  }),

  // 19. mcp-session-hello — MCP server announces its process-scoped UUID; the
  // browser uses the forwarded hello as its reconcile trigger (0.3.1: it never
  // wipes the buffer — an MCP process restart is not a new designer session).
  z.object({
    type: z.literal('mcp-session-hello'),
    sessionId: z.uuid(),
  }),
])

export type ServerToBrowserSchema = z.infer<typeof serverToBrowserSchema>

// ---------------------------------------------------------------------------
// CLI WebSocket envelopes (server↔CLI, not part of browser protocol)
// These are inline JSON shapes used in vite.ts and mcp.ts.
// ---------------------------------------------------------------------------

/** Sent by the CLI to the Vite server to invoke an RPC method. */
export const cliRpcRequestSchema = z.object({
  type: z.literal('cortex-rpc'),
  requestId: z.string(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
  token: z.string(),
})

/** Sent by the Vite server back to the CLI with the RPC result. */
export const cliRpcResultSchema = z.object({
  type: z.literal('cortex-rpc-result'),
  requestId: z.string(),
  result: z.unknown(),
})

/** Sent by the Vite server back to the CLI when an RPC call fails. */
export const cliRpcErrorSchema = z.object({
  type: z.literal('cortex-rpc-error'),
  requestId: z.string(),
  error: z.string(),
})

/** Sent by the Vite server to the CLI immediately on connection. */
export const cliStatusSchema = z.object({
  type: z.literal('cortex-status'),
  editorActive: z.boolean(),
  browserConnected: z.boolean(),
})

export type CliRpcRequest = z.infer<typeof cliRpcRequestSchema>
export type CliRpcResult = z.infer<typeof cliRpcResultSchema>
export type CliRpcError = z.infer<typeof cliRpcErrorSchema>
export type CliStatus = z.infer<typeof cliStatusSchema>
