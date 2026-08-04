/**
 * The staging buffer's deduplication key — ONE definition.
 *
 * This existed twice, byte-identical, in `core/staged-edits.ts` and
 * `browser/hooks/useEditStagingBuffer.ts`, each carrying a comment asking the
 * other to stay in lockstep. The server merges the browser's full-state sync by
 * this key, so any drift silently drops or duplicates entries — and a comment
 * is not an enforcement mechanism. Raised in architecture review; the codebase
 * bans this drift class explicitly (CLAUDE.md, "Post-Fix Discipline").
 */
import type { PendingEditSchema } from './../schemas/pending-edit.js'
import { isStructuralEdit } from './../schemas/pending-edit.js'

/**
 * Last-write-wins, for both kinds — but keyed on different things.
 *
 * A style edit collapses per (source, property, pseudo): the newest `color` at
 * one place is the only one that matters.
 *
 * A structural intent collapses per CONTAINER INSTANCE. Because each one states
 * a container's intended final child ORDER rather than a relative move, the
 * newest order for a container is likewise the only one that matters — dragging
 * three times in the same row leaves one intent describing where things ended
 * up, not three that must be replayed in sequence.
 *
 * An earlier version keyed on `intentId` to preserve an ordered move log.
 * External review showed that log was unreplayable in practice: applying a
 * subset, discarding one entry, retrying after a crash, merging two tabs, or
 * evicting the oldest entry each invalidated every later index. Absolute
 * intents removed the need for the log, and with it that whole failure class —
 * including the unbounded growth that unique-per-drag keys caused.
 *
 * The `structural\0` prefix keeps the namespaces disjoint.
 */
export function compositeKey(edit: PendingEditSchema): string {
  if (isStructuralEdit(edit)) {
    return `structural\0${edit.structural.parentSource}\0${edit.structural.parentKey}`
  }
  return `${edit.source}\0${edit.property}\0${edit.pseudo ?? ''}`
}
