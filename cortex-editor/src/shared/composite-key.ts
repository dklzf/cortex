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
import { isStructuralEdit, isClassEdit } from './../schemas/pending-edit.js'

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
 * A class intent collapses per (source, OPERATION) — deliberately not per
 * source alone. It carries no pseudo: a class attaches to the owning element,
 * never to a ::before box. Style edits collapse per property because a scrub emits
 * hundreds of intermediate values and only the last matters. Class ops are
 * discrete clicks, and `add text-lg` followed by `add font-bold` are INDEPENDENT
 * mutations; last-write-wins there would silently drop one. Including the
 * operation in the key still collapses a genuine repeat (clicking the same
 * button twice) while keeping distinct mutations distinct.
 *
 * The `structural\0` / `class\0` prefixes keep the namespaces disjoint.
 */
export function compositeKey(edit: PendingEditSchema): string {
  if (isStructuralEdit(edit)) {
    return `structural\0${edit.structural.parentSource}\0${edit.structural.parentKey}`
  }
  if (isClassEdit(edit)) {
    const op = edit.classOp
    const sig =
      op.kind === 'swap' ? `swap\0${op.remove}\0${op.add}`
      : op.kind === 'add' ? `add\0${op.add}`
      : `remove\0${op.remove}`
    return `class\0${edit.source}\0${sig}`
  }
  return `${edit.source}\0${edit.property}\0${edit.pseudo ?? ''}`
}
