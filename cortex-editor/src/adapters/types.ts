import type { Server as HttpServer } from 'http'
import type { StyleCapability } from '../core/capabilities.js'
import type { BrowserToServerSchema, ServerToBrowserSchema, PendingEditSchema } from '../schemas/index.js'

// === Server-side adapter interface ===
// Each framework adapter (Vite, Next.js) implements this.
// Core code depends on this abstraction only.

export interface FrameworkAdapter {
  /** Add Cortex <script> tag to HTML response */
  injectScripts(html: string): string

  /** Add data-cortex-source="file:line:col" attributes to JSX elements */
  transformSource(code: string, id: string): TransformResult | null

  /** Mount MCP + transport on the framework's HTTP server */
  mount(httpServer: HttpServer): void

  /** Register callback for when HMR updates complete; returns unsubscribe */
  onHMRUpdate(callback: (updatedFiles: string[]) => void): () => void

  /** Create the bidirectional channel for browser↔server communication */
  createChannel(): ServerChannel

  /** Clean up resources (listeners, file watchers, etc.) */
  dispose(): Promise<void>
}

export interface SourceMap {
  file?: string
  mappings: string
  names?: string[]
  sources?: (string | null)[]
  sourcesContent?: (string | null)[]
  version: 3
}

export interface SourceTransformOptions {
  /** Set to 'production' to disable instrumentation. Default: 'development'. */
  mode?: 'development' | 'production'
  /** Called when the parser fails to parse a file. */
  onParseError?: (id: string, error: unknown) => void
  /** Resolve import aliases (e.g., @/ → src/) synchronously. Return null if unresolvable. */
  resolveAlias?: (specifier: string) => string | null
  /** Package names in node_modules to instrument (for library component detection). */
  includeNodeModules?: string[]
  /** Supply the authoritative source text for a module id, replacing the default
   *  `fs.readFileSync`. For adapters whose modules do not live on the native
   *  filesystem — an in-memory fs, a virtual route generator, a custom bundler.
   *
   *  `id` is the QUERY-STRIPPED module id (`rawId.split('?')[0]`), not the raw
   *  bundler id. Vite and Rollup routinely append `?v=<hash>`, `?raw`, `?worker`
   *  and friends; cortex strips them before every filesystem read, so an adapter
   *  keying an in-memory map by raw id would miss. Key by the bare path.
   *
   *  This is a provenance SEAM, not a bypass. The returned string is compared to
   *  the incoming code exactly as a disk read would be, and returning `null` (or
   *  throwing) still fails closed with no anchor emitted. It exists so a custom
   *  adapter can PROVE provenance by another route, not skip proving it.
   *
   *  Must return the text in the same coordinate space the apply side will later
   *  resolve against. An adapter that returns text differing from what its own
   *  writer will reopen reintroduces exactly the wrong-element write this guard
   *  prevents. */
  readSource?: (id: string) => string | null

  /** Called when cortex refuses to annotate a file, because an anchor it cannot
   *  fully account for is a WRITE TARGET: the attribute's presence alone forces
   *  `applyMode: 'direct'`, and apply resolves the recorded path and position
   *  against disk. When set, replaces the default console warning.
   *
   *  `reason` distinguishes the four refusal causes. The first three are about
   *  the TEXT — Babel's line/column are coordinates in the string handed to the
   *  parser, so an unproven match means the position could name the wrong
   *  element. The fourth is about the PATH, and is a different failure: the
   *  position is fine, the file it would be applied to is not.
   *   - `'virtual'`    — the module id contains `\0` (Rollup/Vite virtual module);
   *                      there is no file to compare against
   *   - `'unreadable'` — the file could not be read (missing, EACCES, memory-fs)
   *   - `'mismatch'`   — the file was read and differs after position-preserving
   *                      normalization; an upstream transform rewrote it
   *   - `'unmappable'` — the file has no canonical, reversible path relative to
   *                      `projectRoot` (outside it, or symlink-escaped). Apply
   *                      resolves stamped paths UNDER `projectRoot`, so a stamp
   *                      would name a DIFFERENT file — a silent wrong-FILE write
   *
   *  `diskLines` is `-1` whenever no line-count divergence is involved
   *  (virtual, unreadable, unmappable).
   *  See the provenance guard in source-transform.ts. */
  onProvenanceMismatch?: (
    id: string,
    detail: {
      reason: 'virtual' | 'unreadable' | 'mismatch' | 'unmappable'
      inputLines: number
      diskLines: number
    },
  ) => void
}

export interface TransformResult {
  code: string
  map: SourceMap | null
}

// === Server-side channel (adapter provides) ===

export interface ServerChannel {
  send(msg: ServerToBrowser): void
  onMessage(handler: (msg: BrowserToServer) => void): () => void
  broadcast(msg: ServerToBrowser): void
  dispose(): Promise<void>
}

/** Write kind for HMR verification — determines override removal timing in the browser.
 *  'immediate': CSS-only edit, override cleared synchronously (stylesheet already applied).
 *  'jsx-immediate': JSX inline style edit, override cleared after a MutationObserver
 *                   confirms React applied the new inline style to the DOM element.
 *  'deferred': AI/deferred edit, override cleared after double-rAF (framework re-render). */
export type EditKind = 'immediate' | 'jsx-immediate' | 'deferred'

/** Discriminated union for className mutations. The `kind` discriminator
 *  forces callers to declare intent; pipeline routing reads only the
 *  fields guaranteed present for each variant. */
export type ClassOp =
  | { kind: 'add'; add: string }
  | { kind: 'remove'; remove: string }
  | { kind: 'swap'; remove: string; add: string }

// === Message protocol ===

/** Single source of truth: inferred from pendingEditSchema in src/schemas/pending-edit.ts. */
export type PendingEdit = PendingEditSchema

/** Single source of truth: inferred from browserToServerSchema in src/schemas/wire-format.ts. */
export type BrowserToServer = BrowserToServerSchema

/** Single source of truth: inferred from serverToBrowserSchema in src/schemas/wire-format.ts. */
export type ServerToBrowser = ServerToBrowserSchema

export interface ElementContext {
  tagName: string
  componentName: string | null
  domSelector: string
  textPreview: string
}

export type AnnotationKind = 'comment' | 'fix-request'

export interface FixMeta {
  property: string
  value: string
  reason: string
}

export type AnnotationStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed'

export interface Annotation {
  id: string
  status: AnnotationStatus
  elementSource: string
  text: string
  elementContext?: ElementContext
  currentStyles?: Record<string, string>
  pinPosition?: { x: number; y: number }
  createdAt: number
  updatedAt: number
  resolution?: { summary: string }
  dismissReason?: string
  thread: ThreadMessage[]
  kind?: AnnotationKind
  fixMeta?: FixMeta
}

export interface ThreadMessage {
  id: string
  from: 'user' | 'agent'
  text: string
  timestamp: number
}

export interface CreateAnnotationParams {
  elementSource: string
  text: string
  elementContext?: ElementContext
  currentStyles?: Record<string, string>
  pinPosition?: { x: number; y: number }
  kind?: AnnotationKind
  fixMeta?: FixMeta
}

export interface ActivityEntry {
  id: string
  type: 'edit' | 'comment' | 'status-change'
  timestamp: number
  elementSource?: string
  description: string
  details?: Record<string, unknown>
}

// === Browser-side channel (injected by adapter) ===
// Implemented in src/browser/channel.ts (Phase 2).
// Defined here so both server and browser code share the same contract.

/** Connection lifecycle state emitted by channels. */
export type ConnectionState =
  | { status: 'connected' }
  | { status: 'reconnecting'; retryCount: number; maxRetries: number }
  | { status: 'disconnected' }

/** UI display state for connection indicator. Extends ConnectionState with transient 'reconnected'. */
export type ConnectionDisplay = ConnectionState | { status: 'reconnected' }

export interface CortexChannel {
  send(msg: BrowserToServer): void
  onMessage(handler: (msg: ServerToBrowser) => void): () => void
  onConnectionChange(handler: (state: ConnectionState) => void): () => void
  readonly connected: boolean
  /** Send a message and wait for a matching ack from the server.
   *  Stamps a fresh requestId (via `uuid.generateId` — polyfill that handles
   *  non-secure contexts where `crypto.randomUUID` is unavailable) and routes
   *  through the existing channel.send() so the ZF0-1326 token-capture closure
   *  is preserved — the token is never re-read from window.
   *
   *  Rejects with a descriptive Error on:
   *  - timeout (default 10 000 ms): `'sendAndAck timeout after Nms'`
   *  - disconnect while waiting: `'sendAndAck failed: channel disconnected'`
   *
   *  NEVER hangs silently — one of the two rejection paths always fires. */
  sendAndAck<TType extends Extract<BrowserToServer, { requestId: string }>['type']>(
    msg: Omit<Extract<BrowserToServer, { type: TType; requestId: string }>, 'requestId' | 'token'>,
    options?: { timeoutMs?: number },
  ): Promise<ServerToBrowser>
  /** Clean up resources (WebSocket, timers). Optional — Vite channel has nothing to dispose. */
  dispose?: () => void
}

export type { StyleCapability }
