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
 * Last-write-wins key for a style edit; a unique key for a structural one.
 *
 * Collapsing by locus is right for a style edit — the newest `color` at one
 * place is the only one that matters. It is wrong for a move: "A before B, then
 * B before C" is an ordered sequence, and folding it by locus lands the element
 * somewhere the user never dragged it. Keying structural intents on their
 * unique intentId makes the Map's insertion order the move log.
 *
 * The `structural\0` prefix keeps the namespaces disjoint — an intentId can
 * never collide with a `source\0property\0pseudo` triple.
 */
export function compositeKey(edit: PendingEditSchema): string {
  if (isStructuralEdit(edit)) return `structural\0${edit.intentId}`
  return `${edit.source}\0${edit.property}\0${edit.pseudo ?? ''}`
}
