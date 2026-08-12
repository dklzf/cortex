import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Annotation } from '../adapters/types.js'

// ---------------------------------------------------------------------------
// Schema version — bump when envelope shape changes
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1 as const

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ElementContextSchema = z.object({
  tagName: z.string(),
  componentName: z.string().nullable(),
  domSelector: z.string(),
  textPreview: z.string(),
})

const FixMetaSchema = z.object({
  property: z.string(),
  value: z.string(),
  reason: z.string(),
})

const ThreadMessageSchema = z.object({
  id: z.string(),
  from: z.union([z.literal('user'), z.literal('agent')]),
  text: z.string(),
  timestamp: z.number(),
})

const AnnotationStatusSchema = z.union([
  z.literal('pending'),
  z.literal('acknowledged'),
  z.literal('resolved'),
  z.literal('dismissed'),
])

const AnnotationKindSchema = z.union([
  z.literal('comment'),
  z.literal('fix-request'),
])

const AnnotationSchema = z.object({
  id: z.string(),
  status: AnnotationStatusSchema,
  elementSource: z.string(),
  /** COR-27. Optional so annotations persisted before this field still load —
   *  a stricter schema would make the whole store fail to parse and silently
   *  drop every existing comment. */
  sourceResolutionHint: z
    .object({
      tagName: z.string(),
      className: z.string().optional(),
      id: z.string().optional(),
      textPreview: z.string(),
      domSelector: z.string(),
    })
    .optional(),
  text: z.string(),
  elementContext: ElementContextSchema.optional(),
  currentStyles: z.record(z.string(), z.string()).optional(),
  pinPosition: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  resolution: z.object({ summary: z.string() }).optional(),
  dismissReason: z.string().optional(),
  thread: z.array(ThreadMessageSchema),
  kind: AnnotationKindSchema.optional(),
  fixMeta: FixMetaSchema.optional(),
})

const EnvelopeSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  annotations: z.array(AnnotationSchema),
})

// Compile-time guard: if `Annotation` in types.ts gains a required field,
// this assignment fails type-checking until AnnotationSchema is updated.
// Catches schema/type drift before it becomes a silent runtime data loss.
const _annotationSchemaMatchesType: z.ZodType<Annotation> = AnnotationSchema
void _annotationSchemaMatchesType

// ---------------------------------------------------------------------------
// Internal type guards
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}

/**
 * Best-effort forensic backup of an unreadable annotations.json (ZF0-1853).
 *
 * On a parse/validation failure loadAnnotations returns [] and the next save
 * overwrites the file — silently destroying possibly-recoverable data. Renaming
 * the corrupt file to `.corrupted-<timestamp>.json` first preserves it for
 * manual recovery while still letting the session start fresh.
 *
 * Only called for failures where the bytes WERE read (corrupt JSON, schema /
 * version mismatch, Zod shape failure) — never for ENOENT (nothing to back up)
 * or read errors (can't read => can't move). Backup failure is non-fatal: it
 * warns and returns so loadAnnotations still degrades to [].
 */
function backupCorruptFile(filePath: string): void {
  try {
    const backupPath = `${filePath}.corrupted-${Date.now()}.json`
    fs.renameSync(filePath, backupPath)
    console.warn(
      `[cortex] Backed up unreadable annotations.json to ${path.basename(backupPath)}`,
    )
  } catch (err) {
    console.warn(
      '[cortex] Could not back up corrupt annotations.json:',
      errMessage(err),
    )
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads annotations from a JSON file. Returns [] on any error.
 * Does NOT throw under any circumstances.
 */
export function loadAnnotations(filePath: string): Annotation[] {
  try {
    let contents: string
    try {
      contents = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === 'ENOENT') {
        // Normal first-run case — no warn
        return []
      }
      console.warn('[cortex] annotations.json read failed:', errMessage(err))
      return []
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents)
    } catch (err) {
      console.warn('[cortex] annotations.json invalid JSON:', errMessage(err))
      backupCorruptFile(filePath)
      return []
    }

    const result = EnvelopeSchema.safeParse(parsed)
    if (!result.success) {
      console.warn(
        '[cortex] annotations.json schema mismatch:',
        result.error.message,
      )
      backupCorruptFile(filePath)
      return []
    }

    return result.data.annotations
  } catch (err) {
    console.warn(
      '[cortex] annotations.json unexpected error:',
      errMessage(err),
    )
    return []
  }
}

/**
 * Saves annotations to a JSON file using atomic write (write .tmp, then rename).
 * Does NOT throw under any circumstances.
 */
export function saveAnnotations(
  filePath: string,
  annotations: readonly Annotation[],
): void {
  try {
    const envelope = {
      version: SCHEMA_VERSION,
      annotations,
    }
    const serialized = JSON.stringify(envelope, null, 2)
    // PID + nonce in the temp filename keeps concurrent writers (two cortex
    // dev servers on the same project root) from interleaving bytes into a
    // shared `.tmp` file before rename. The async `atomicWrite` helper in
    // adapters/atomic-write.ts is the canonical implementation (it also does
    // read-back verification against editor revert) but it is async, and
    // saveAnnotations is called synchronously from five AnnotationStore
    // mutation paths — migrating to async would change the sync hydrate→ready
    // contract that adapters depend on. PID + nonce is the smallest delta
    // that closes the collision-safety gap without that ripple.
    const nonce = randomBytes(6).toString('hex')
    const tmpPath = `${filePath}.cortex-${process.pid}-${nonce}.tmp`

    try {
      // mode 0o600 matches the rest of .cortex/ (parent dir is 0o700, token is 0o600).
      // Defense-in-depth: file-level perms remain restrictive if the parent dir's
      // mode ever drifts. Annotations are user-authored content (not secrets), so
      // strict consistency is the right default.
      fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      console.warn('[cortex] annotations.json write failed:', errMessage(err))
      // Live file at filePath is untouched — atomicity preserved
      return
    }

    try {
      fs.renameSync(tmpPath, filePath)
    } catch (err) {
      console.warn('[cortex] annotations.json rename failed:', errMessage(err))
      // Best-effort cleanup of the orphan .tmp. Under a unique nonce it is
      // harmless (no collision with future writes) but stale-file accumulation
      // is undesirable if the volume can be written but rename specifically
      // fails (rare; e.g., EXDEV cross-device, EBUSY on Windows).
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        /* tmp already gone or unreachable — ignore */
      }
    }
  } catch (err) {
    console.warn(
      '[cortex] annotations.json unexpected error:',
      errMessage(err),
    )
  }
}
