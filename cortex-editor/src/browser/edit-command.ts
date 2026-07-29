// src/browser/edit-command.ts
import type { CSSOverrideManager } from './override.js'
import type { PendingEdit } from './hooks/useEditStagingBuffer.js'
import { generateId } from './uuid.js'

/** A single property change within an EditCommand. */
export interface PropertyChange {
  readonly source: string
  readonly property: string
  readonly value: string
  readonly previousValue: string
  readonly pseudo?: '::before' | '::after'
}

/** Subset of StagingBufferHandle needed by PropertyEditCommand for its
 *  buffer-side undo/redo bookkeeping. Defined narrowly so the command
 *  doesn't depend on the entire hook surface. */
export interface StagingBufferOps {
  /** Returns the entry this append displaced under the same composite key,
   *  or undefined on a fresh key. See `StagingBufferHandle.append`. */
  append: (edit: PendingEdit) => PendingEdit | undefined
  remove: (intentIds: string[]) => void
}

/** Interface for all edit commands. */
export interface EditCommand {
  readonly editId: string
  readonly changes: readonly PropertyChange[]
  /** Whether undoing/redoing this command should also send {type:'undo'/'redo'}
   *  to the server. False for buffer-only commands (PropertyEditCommand after
   *  the ZF0-1210 pivot — staged edits have no server-side counterpart until
   *  Apply). True for compound edits that still channel.send (classOp). */
  readonly hasServerEntry: boolean
  execute(): void
  undo(): void
}

/** Shared init shape for both PropertyEditCommand and CompoundEditCommand —
 *  structurally identical so the inputs live in ONE type. */
export interface EditCommandInit {
  changes: PropertyChange[]
  overrideManager: CSSOverrideManager
  editId?: string
}

/** Back-compat alias for CompoundEditCommand callers — its init shape is
 *  identical to EditCommandInit. PropertyEditCommand has its own richer
 *  init type below (`PropertyEditCommandInit`). */
export type CompoundEditCommandInit = EditCommandInit

/** Shared base: constructor + undo() are identical across both command
 *  classes. Subclasses differ ONLY in execute() semantics:
 *    - PropertyEditCommand always sets (scrub-produced values are
 *      never empty).
 *    - CompoundEditCommand honors value === '' as "remove this
 *      override" because compound edits mix inlineSets (value set)
 *      and inlineRemoves (value empty) in one changes[] array.
 *
 *  Subclassing expresses the semantic difference declaratively — the
 *  alternative (a runtime executeMode flag) would hide two distinct
 *  behaviors behind a branch. */
abstract class BaseEditCommand implements EditCommand {
  readonly editId: string
  readonly changes: readonly PropertyChange[]
  abstract readonly hasServerEntry: boolean
  protected readonly overrideManager: CSSOverrideManager

  constructor(init: EditCommandInit) {
    this.editId = init.editId ?? generateId()
    this.changes = init.changes
    this.overrideManager = init.overrideManager
  }

  abstract execute(): void

  /** Revert each change: previousValue === '' removes the override;
   *  otherwise restores the prior value. Same logic for both subclasses
   *  because undo reads the captured previousValue, not the forward value. */
  undo(): void {
    for (const c of this.changes) {
      if (c.previousValue === '') {
        this.overrideManager.remove(c.source, c.property, c.pseudo)
      } else {
        this.overrideManager.set(c.source, c.property, c.previousValue, c.pseudo)
      }
    }
  }
}

/** Init shape specific to PropertyEditCommand — extends the shared init with
 *  the staging-buffer wiring needed to keep undo/redo and the buffer in lockstep. */
export interface PropertyEditCommandInit extends EditCommandInit {
  /** PendingEdits this command corresponds to in the staging buffer.
   *  One PendingEdit per PropertyChange (same order). On undo we remove
   *  these from the buffer; on redo (execute) we re-append them. */
  pendingEdits?: readonly PendingEdit[]
  /** Entries that this command's appends DISPLACED under the same composite
   *  keys (last-write-wins destroys the prior intent with no other record).
   *  Undo re-appends them so the buffer matches what the reverted override
   *  actually shows. Empty for a first touch on every key. */
  displacedEdits?: readonly PendingEdit[]
  /** Buffer handle. Captured at construction time and held for the
   *  lifetime of the command. Safe because the command's lifetime is
   *  bounded by the activation session — see commandStack.clear() on
   *  cortex close. */
  bufferOps?: StagingBufferOps
}

/**
 * Captures a user gesture (one or more CSS property changes) as a command.
 * execute() applies overrides + re-appends to staging buffer (redo path);
 * undo() reverts overrides + removes the same intents from the buffer.
 * Multi-property changes (e.g., fill type switch) are atomic — one command, one undo.
 *
 * Buffer/override stay in lockstep: without this, an undone edit would
 * still flush to Claude Code on Apply, and a redone edit would re-apply
 * the override but be invisible to the next Apply. The pendingEdits +
 * bufferOps wiring is what closes that gap.
 */
export class PropertyEditCommand extends BaseEditCommand {
  // Staged in the browser-side buffer post-pivot; no server-side undo entry
  // exists until Apply (ZF0-1452) flushes the buffer to Claude Code.
  readonly hasServerEntry = false
  private readonly pendingEdits: readonly PendingEdit[]
  private readonly bufferOps: StagingBufferOps | null
  /** Not readonly: `execute()` (redo) refreshes it from what its own appends
   *  displaced, so undo/redo stay symmetric on their own terms rather than
   *  relying on CommandStack's "redo can only replay into the state undo left"
   *  invariant holding forever. */
  private displacedEdits: readonly PendingEdit[]

  constructor(init: PropertyEditCommandInit) {
    super(init)
    this.pendingEdits = init.pendingEdits ?? []
    this.displacedEdits = init.displacedEdits ?? []
    this.bufferOps = init.bufferOps ?? null
  }

  execute(): void {
    for (const c of this.changes) {
      this.overrideManager.set(c.source, c.property, c.value, c.pseudo)
    }
    // Redo path: re-append staging-buffer entries removed by undo().
    // Initial commit does NOT route through here — Panel.tsx records the
    // command via commandStack.record() (which skips execute()) and does the
    // initial buffer.append at the call site. So execute() only fires on redo.
    if (this.bufferOps && this.pendingEdits.length > 0) {
      const displaced: PendingEdit[] = []
      for (const edit of this.pendingEdits) {
        const d = this.bufferOps.append(edit)
        if (d !== undefined) displaced.push(d)
      }
      this.displacedEdits = displaced
    }
  }

  override undo(): void {
    super.undo()
    // Remove buffer entries by intentId so a subsequent Apply doesn't flush
    // edits the user just undid, THEN restore whatever those appends displaced.
    //
    // Remove-first is for wire determinism, not local correctness: `remove`
    // deletes by intentId (not by composite key), so append-first would also
    // end at the right local state. What remove-first buys is a deterministic
    // syncRemove-then-syncAdd order on the channel, keeping the server-side
    // StagedEditsCache in lockstep with the browser buffer.
    if (this.bufferOps) {
      if (this.pendingEdits.length > 0) {
        this.bufferOps.remove(this.pendingEdits.map(e => e.intentId))
      }
      for (const displaced of this.displacedEdits) {
        this.bufferOps.append(displaced)
      }
    }
  }
}

/**
 * Represents one compound edit (classOp + inlineSets + inlineRemoves) on the
 * browser's commandStack. The server writes the whole gesture as ONE
 * UndoFileChange; this command's job is to (a) exist on the local stack so
 * CortexApp's `const cmd = commandStack.undo()` / `if (cmd)` gate fires and
 * dispatches `{ type: 'undo' }` to the server, and (b) manage the local
 * !important overrides that applyClassChange set for immediate visual
 * feedback while HMR is in flight.
 *
 * Unlike PropertyEditCommand (which always sets), execute() here must also
 * honor value === '' as "remove this override" because compound edits mix
 * inlineSets (value='rgb(...)') and inlineRemoves (value=''). The classOp
 * (className add/remove) is NOT tracked by this command — it is reverted
 * purely via the server's compound UndoFileChange + HMR re-render.
 */
export class CompoundEditCommand extends BaseEditCommand {
  // classOp dispatches at Panel.tsx still channel.send to the server, so the
  // server has a corresponding UndoFileChange entry that {type:'undo'} can pop.
  readonly hasServerEntry = true

  execute(): void {
    for (const c of this.changes) {
      if (c.value === '') {
        this.overrideManager.remove(c.source, c.property, c.pseudo)
      } else {
        this.overrideManager.set(c.source, c.property, c.value, c.pseudo)
      }
    }
  }
}
