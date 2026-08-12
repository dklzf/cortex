import { randomUUID } from 'node:crypto'
import type {
  Annotation,
  CreateAnnotationParams,
  ThreadMessage,
} from '../adapters/types.js'
import type { DeepReadonly } from './deep-readonly.js'
import { loadAnnotations, saveAnnotations } from './annotations-persistence.js'

const DEFAULT_MAX_TERMINAL = 100

export interface AnnotationStoreOptions {
  /** Cap on terminal (resolved/dismissed) entries. FIFO eviction past this. Default 100.
   *  Implementation note: eviction uses Array.prototype.shift() which is O(n) in V8 due
   *  to array reindexing. At the default cap of 100 this is microseconds per terminal
   *  flip and unobservable. If callers ever raise the cap above ~1000, replace the
   *  string[] queue with a circular buffer or head-index deque to keep eviction O(1). */
  maxTerminal?: number
  /** When set, AnnotationStore hydrates from this file on construction and
   *  write-throughs every mutation. When unset, behavior is unchanged. */
  persistence?: { filePath: string }
}

export class AnnotationStore {
  private annotations = new Map<string, Annotation>()
  private terminalOrder: string[] = []
  private readonly maxTerminal: number
  private readonly persistenceFilePath: string | undefined

  constructor(opts?: AnnotationStoreOptions) {
    const max = opts?.maxTerminal ?? DEFAULT_MAX_TERMINAL
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(
        `AnnotationStore: maxTerminal must be a positive integer, got ${max}`,
      )
    }
    this.maxTerminal = max
    this.persistenceFilePath = opts?.persistence?.filePath

    // Synchronous hydration is intentional: adapter callers depend on the store
    // being ready BEFORE the first WebSocket message arrives. Pending and
    // acknowledged annotations are never evicted; the terminal set is capped
    // at maxTerminal here (the file could exceed the cap from a hand-edit
    // or a reduced maxTerminal between sessions — flagged by Greptile +
    // Copilot in PR #140). Never moved to async without re-establishing the
    // sync hydrate→ready invariant in the adapter wiring.
    if (this.persistenceFilePath !== undefined) {
      const loaded = loadAnnotations(this.persistenceFilePath)

      // terminalOrder must be FIFO by updatedAt so future eviction removes
      // the oldest terminal annotation first — same contract as live writes.
      const sortedTerminal = loaded
        .filter((a) => a.status === 'resolved' || a.status === 'dismissed')
        .sort((a, b) => a.updatedAt - b.updatedAt)

      // Enforce the terminal cap on hydration. Drop the oldest excess —
      // the head of the sorted array is oldest-first.
      const excess = Math.max(0, sortedTerminal.length - this.maxTerminal)
      const droppedTerminalIds = new Set(
        sortedTerminal.slice(0, excess).map((a) => a.id),
      )

      for (const ann of loaded) {
        if (!droppedTerminalIds.has(ann.id)) {
          this.annotations.set(ann.id, ann)
        }
      }
      this.terminalOrder = sortedTerminal.slice(excess).map((a) => a.id)
    }
  }

  private persist(): void {
    if (this.persistenceFilePath === undefined) return
    // saveAnnotations only reads + serializes — skip getAll()'s per-element
    // snapshot copy (designed for external callers who might mutate the result).
    saveAnnotations(this.persistenceFilePath, [...this.annotations.values()])
  }

  // ZF0-1856: snapshot returns DeepReadonly<Annotation>. ZF0-1844 made the
  // structuredClone defensive copy a RUNTIME safety net; the DeepReadonly
  // return type adds the COMPILE-TIME half — a caller that tries to mutate a
  // returned snapshot now gets a tsc error instead of a silently-ignored write
  // to a throwaway clone. The store's internal Map stays Map<string, Annotation>
  // (mutable) — only the public surface is frozen at the type level. The
  // runtime structuredClone is kept as belt-and-suspenders (DeepReadonly is
  // erased at compile time; it does not freeze the object at runtime).
  private snapshot(ann: Annotation): DeepReadonly<Annotation> {
    return structuredClone(ann)
  }

  private markTerminal(id: string): void {
    this.terminalOrder.push(id)
    while (this.terminalOrder.length > this.maxTerminal) {
      const oldest = this.terminalOrder.shift()
      if (oldest !== undefined) this.annotations.delete(oldest)
    }
  }

  create(params: CreateAnnotationParams): DeepReadonly<Annotation> {
    // ZF0-1857 Finding 1 — input-side defensive copy. Deep-clone the
    // caller-owned params up front so the live store entry never shares nested
    // object refs (elementContext, currentStyles, pinPosition, fixMeta) with
    // the caller; a later caller mutation of their params object cannot corrupt
    // the store. Symmetric with the output-side snapshot() (ZF0-1844).
    //
    // ZF0-1857 Finding 2 — transactional insertion. This clone runs BEFORE any
    // store mutation, so a non-cloneable value that bypassed Zod throws here
    // and the store is never touched. `annotation` is then built from
    // structuredClone output, so the snapshot() below is guaranteed cloneable;
    // snapshotting before `set` keeps the order structurally correct even if
    // snapshot() ever becomes fallible — no half-inserted poisoned entry.
    //
    // Audit note: acknowledge/resolve/dismiss/addMessage need neither fix —
    // they take no object params (or copy primitive fields into fresh objects),
    // and their in-place mutations only assign primitives/plain objects, so
    // snapshot() cannot newly throw on an already-present entry.
    const cloned = structuredClone(params)
    const now = Date.now()
    const annotation: Annotation = {
      id: randomUUID(),
      status: 'pending',
      elementSource: cloned.elementSource,
      sourceResolutionHint: cloned.sourceResolutionHint,
      text: cloned.text,
      elementContext: cloned.elementContext,
      currentStyles: cloned.currentStyles,
      pinPosition: cloned.pinPosition,
      createdAt: now,
      updatedAt: now,
      thread: [],
      kind: cloned.kind ?? 'comment',
      fixMeta: cloned.fixMeta,
    }
    const result = this.snapshot(annotation)
    this.annotations.set(annotation.id, annotation)
    this.persist()
    return result
  }

  getPending(): DeepReadonly<Annotation[]> {
    return [...this.annotations.values()]
      .filter((a) => a.status === 'pending')
      .map((a) => this.snapshot(a))
  }

  getActive(): DeepReadonly<Annotation[]> {
    return [...this.annotations.values()].filter(a => a.status === 'pending' || a.status === 'acknowledged').map(a => this.snapshot(a))
  }

  getById(id: string): DeepReadonly<Annotation> | null {
    const ann = this.annotations.get(id)
    return ann ? this.snapshot(ann) : null
  }

  acknowledge(id: string): DeepReadonly<Annotation> | null {
    const ann = this.annotations.get(id)
    if (!ann || ann.status !== 'pending') return null
    ann.status = 'acknowledged'
    ann.updatedAt = Date.now()
    this.persist()
    return this.snapshot(ann)
  }

  resolve(id: string, summary: string): DeepReadonly<Annotation> | null {
    const ann = this.annotations.get(id)
    if (!ann || ann.status !== 'acknowledged') return null
    ann.status = 'resolved'
    ann.resolution = { summary }
    ann.updatedAt = Date.now()
    this.markTerminal(id)
    this.persist()
    return this.snapshot(ann)
  }

  dismiss(id: string, reason?: string): DeepReadonly<Annotation> | null {
    const ann = this.annotations.get(id)
    if (!ann || ann.status === 'resolved' || ann.status === 'dismissed')
      return null
    ann.status = 'dismissed'
    if (reason) ann.dismissReason = reason
    ann.updatedAt = Date.now()
    this.markTerminal(id)
    this.persist()
    return this.snapshot(ann)
  }

  addMessage(
    id: string,
    msg: Omit<ThreadMessage, 'id' | 'timestamp'>,
  ): DeepReadonly<Annotation> | null {
    const ann = this.annotations.get(id)
    if (!ann || ann.status === 'resolved' || ann.status === 'dismissed')
      return null
    if (ann.thread.length >= 100) return null
    ann.thread.push({
      id: randomUUID(),
      from: msg.from,
      text: msg.text,
      timestamp: Date.now(),
    })
    ann.updatedAt = Date.now()
    this.persist()
    return this.snapshot(ann)
  }

  getAll(): DeepReadonly<Annotation[]> {
    return [...this.annotations.values()].map((a) => this.snapshot(a))
  }
}
