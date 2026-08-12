import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { CortexSession } from '../core/session.js'
import { LockHeldError } from '../core/cortex-lock.js'
import { resolveAnnotationsFilePath } from './annotations-path-resolver.js'
import { TailwindResolver } from '../core/tailwind-resolver.js'
import { TailwindRewriter } from '../core/rewriter/tailwind.js'
import { InlineStyleRewriter } from '../core/rewriter/inline-style.js'
import { HMRVerifier } from '../core/hmr-verifier.js'
import { EditPipeline } from '../core/edit-pipeline.js'
import { StyleDetector, type DetectionResult } from '../core/rewriter/detector.js'
import { computeCapabilities, type ResolverState } from '../core/capabilities.js'
import { CSSModulesRewriter } from '../core/rewriter/css-modules.js'
import { RuntimeCSSResolver } from '../core/rewriter/runtime-resolver.js'
import { UndoStack } from '../core/session/undo-stack.js'
import { applyEditsCore, checkIntentFileSize, parseIntentSource, sliceIntentContext, agentResolveIntentContext } from '../core/staged-edits.js'
import { isPreviewSource } from '../shared/preview-source.js'
import { atomicWrite } from './atomic-write.js'
import {
  evaluateSetActive,
  clearActiveBrowser,
  type SetActiveResult,
} from './cortex-active-state.js'
import {
  ALLOWED_ORIGINS,
  CLI_ALLOWED_TYPES,
  BROWSER_TO_CLI_FORWARD_TYPES,
  WRITE_TYPES,
  HEARTBEAT_INTERVAL,
  MAX_CLI_CONNECTIONS,
  tokensEqual,
} from './shared-server-constants.js'
import { shouldSuppressHmr } from './vite.js'
import {
  CORTEX_BROWSER_PATH,
  DEFAULT_TOGGLE_SHORTCUT,
  createManualInjectionScriptBody,
  validateToggleShortcut,
  type InjectionState,
} from './injection-snippet.js'
import { shouldExcludeCortexSource, markRuntimeDisabled, markRuntimeEnabled } from './source-loader-utils.js'
import type { ServerChannel, ServerToBrowser, Annotation } from './types.js'
import {
  browserToServerSchema,
  cliRpcRequestSchema,
  cortexAcknowledgeInputSchema,
  cortexApplyEditsInputSchema,
  cortexDismissInputSchema,
  cortexDiscardEditsInputSchema,
  cortexGetIntentContextInputSchema,
  cortexAcknowledgeSourceEditInputSchema,
  cortexReportSourceEditFailedInputSchema,
  cortexGetDetailsInputSchema,
  cortexResolveInputSchema,
  cortexRespondInputSchema,
  formatIssues,
  parseOrFail,
  pendingEditSchema,
  serverToBrowserSchema,
} from '../schemas/index.js'

const PLUGIN_NAME = 'CortexWebpackPlugin'
const CLI_WS_PATH = '/@cortex/ws'
const BROWSER_WS_PATH = '/cortex'

// Re-exported from the injection-snippet leaf module so webpack.ts's public
// surface is unchanged (these used to be defined here). The leaf module carries
// no heavy imports, letting Next's <CortexDevScripts/> pull the snippet builder
// — and next.ts validate a toggle shortcut — without dragging ws/session/pipeline
// into every RSC process. See 3D / 3F.
export { CORTEX_BROWSER_PATH, DEFAULT_TOGGLE_SHORTCUT, createManualInjectionScriptBody, validateToggleShortcut }
export type { InjectionState }

// CLI WebSocket bridge constants (ALLOWED_ORIGINS, WRITE_TYPES, HEARTBEAT_INTERVAL,
// etc.) live in ./shared-server-constants.ts — shared with the Vite adapter so
// the two dev-server bridges cannot drift on security/protocol invariants.
const ALLOWED_RPC_METHODS = new Set([
  'getActive', 'getPending', 'getDetails', 'acknowledge', 'resolve', 'dismiss', 'respond',
  'getPendingEdits', 'applyEdits', 'discardEdits', 'getIntentContext', 'acknowledgeSourceEdit', 'reportSourceEditFailed',
])

const RPC_METHOD_SCHEMAS = {
  applyEdits: cortexApplyEditsInputSchema,
  discardEdits: cortexDiscardEditsInputSchema,
  getIntentContext: cortexGetIntentContextInputSchema,
  acknowledgeSourceEdit: cortexAcknowledgeSourceEditInputSchema,
  reportSourceEditFailed: cortexReportSourceEditFailedInputSchema,
  getDetails: cortexGetDetailsInputSchema,
  acknowledge: cortexAcknowledgeInputSchema,
  resolve: cortexResolveInputSchema,
  dismiss: cortexDismissInputSchema,
  respond: cortexRespondInputSchema,
  getActive: null,
  getPending: null,
  getPendingEdits: null,
} as const

/**
 * Apply the activation-state result to the session: persist next state,
 * emit broadcasts. During the dual-mode period this fans out the new wire
 * shape (cortex/active-changed) AND the legacy shapes (cortex / cortex-close)
 * so old browsers and old MCP clients keep working unchanged. Remove the
 * legacy fan-out in the next minor release.
 */
function applySetActiveResult(
  session: CortexSession,
  result: SetActiveResult,
): void {
  session.activeState = result.next
  session.editorActive = result.next.editorActive

  if (result.broadcast) {
    const newShape: ServerToBrowser = {
      type: 'cortex/active-changed',
      active: result.broadcast.active,
      ...(result.broadcast.targetTabId ? { targetTabId: result.broadcast.targetTabId } : {}),
    }
    session.channel?.send(newShape)

    // Dual-mode legacy broadcast — drop in the next minor release.
    // Pillar 1 (ZF0-1881 codex P2.2): skip the untargeted legacy fan-out for
    // browser-originated activations (those have targetTabId). CortexApp
    // dispatches legacy `cortex`/`cortex-close` without tabId filtering, so an
    // untargeted legacy broadcast would open/close the panel in EVERY tab,
    // bypassing the single-tab gate the new shape correctly enforces. Legacy
    // shapes are still emitted for CLI-originated activations (no targetTabId
    // — those genuinely have no tab to target and are server-wide).
    if (!result.broadcast.targetTabId) {
      const legacyType = result.broadcast.active ? 'cortex' : 'cortex-close'
      session.channel?.send({ type: legacyType } as ServerToBrowser)
    }
  }

  if (result.reject) {
    session.channel?.send({
      type: 'cortex/inactive-tab',
      targetTabId: result.reject.targetTabId,
      message: 'Cortex is active in another tab — switch to it or close it first',
    })
  }
  // TODO(ZF0-1051): wire telemetry activation for webpack adapter.
  // The vite adapter fires session.telemetry?.recordActivation() here when
  // result.broadcast.active === true. The webpack adapter needs the same
  // treatment: (1) construct a Telemetry instance in the runtime's start()
  // method and assign it to session.telemetry, then (2) add the same
  // `if (result.broadcast?.active) void session.telemetry?.recordActivation()`
  // guard here. Deferred to keep this PR focused on the vite path.
}

/**
 * Module-level reference to the most-recently started runtime.
 * Used ONLY by test-only export helpers — do not use in production code.
 * @internal
 */
let _lastRuntime: CortexWebpackRuntime | null = null

/**
 * Get the current session's ActiveState. Exposed for testing only —
 * lets webpack.test.ts assert that cortex/set-active WS branches update
 * the Pillar 1 state machine.
 * @internal
 */
export function _getActiveStateForTesting() {
  // _lastRuntime.session is private but we're in the same module.
  // TypeScript private is erased at runtime; the cast makes it accessible.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (_lastRuntime as any)?.session?.activeState ?? null
}

/**
 * Expose the injected client script for testing only — lets the test suite
 * assert on the text of the script without going through webpack's HTML
 * injection pipeline. Do not import this in production code.
 * @internal
 */
export function _getInjectedClientScriptForTesting(options: { toggleShortcut: string }): string {
  return createManualInjectionSnippet({
    port: 0,
    token: 'test-token',
    sessionId: 'test-session',
    browserScriptUrl: 'http://localhost:0/@cortex/browser.js',
    toggleShortcut: options.toggleShortcut,
  })
}

export interface CortexWebpackOptions {
  /** Project root. Defaults to compiler.context/options.context/process.cwd(). */
  projectRoot?: string
  /** Port for the standalone Cortex WebSocket bridge. Defaults to an available port. */
  port?: number
  /** Resolve JSX CSS Module aliases. Example: { '@': '/abs/project/src' }. */
  resolveAlias?: Record<string, string>
  /** Package names in node_modules to instrument. */
  includeNodeModules?: string[]
  /** Keyboard shortcut for toggling the editor. */
  toggleShortcut?: string
}

interface WebpackRuleSet {
  test: RegExp
  exclude?: (resourcePath: string) => boolean
  enforce?: string
  use: Array<{ loader: string; options: Record<string, unknown> }>
}

interface WebpackCompiler {
  context?: string
  options: {
    context?: string
    mode?: string
    module?: { rules?: unknown[] }
    plugins?: unknown[]
  }
  hooks: {
    beforeRun?: { tapPromise(name: string, fn: () => Promise<void>): void }
    watchRun?: { tapPromise(name: string, fn: () => Promise<void>): void }
    thisCompilation?: { tap(name: string, fn: (compilation: WebpackCompilation) => void): void }
    done?: { tap(name: string, fn: (stats: WebpackStats) => void): void }
    shutdown?: { tapPromise?(name: string, fn: () => Promise<void>): void }
  }
  webpack?: {
    sources?: {
      RawSource?: new (source: string) => unknown
    }
  }
  watching?: {
    invalidate?: () => void
  }
}

interface WebpackCompilation {
  hooks?: {
    processAssets?: {
      tapPromise(
        options: { name: string; stage?: number } | string,
        fn: () => Promise<void>,
      ): void
    }
  }
  emitAsset?: (name: string, source: unknown) => void
  assets?: Record<string, unknown>
  compiler?: WebpackCompiler
}

interface WebpackStats {
  compilation?: {
    modifiedFiles?: Iterable<string>
    fileDependencies?: Iterable<string>
  }
}

interface HtmlWebpackPluginHooks {
  beforeEmit?: {
    tapPromise(
      name: string,
      fn: (data: { html: string; [key: string]: unknown }) => Promise<{ html: string; [key: string]: unknown }>,
    ): void
  }
}

function resolveBrowserIIFEPath(): string {
  if (typeof __dirname !== 'undefined') {
    return path.join(__dirname, '..', 'browser', 'index.js')
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browser', 'index.js')
}

function resolveSourceLoaderPath(): string {
  if (typeof __dirname !== 'undefined') {
    return path.join(__dirname, 'source-loader.cjs')
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'source-loader.cjs')
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function isAllowedWebSocketOrigin(origin: string | undefined): boolean {
  return origin === undefined || ALLOWED_ORIGINS.test(origin)
}

function isPathInsideRoot(resolved: string, root: string): boolean {
  const normalizedRoot = path.resolve(root)
  return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep)
}

function requireRealpathInsideRoot(
  resolved: string,
  root: string,
  realpathFn: (p: string) => string = fs.realpathSync.native,
): { ok: true; real: string; realRoot: string } | { ok: false; error: string } {
  let real: string
  let realRoot: string
  try {
    real = realpathFn(resolved)
    realRoot = realpathFn(root)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return { ok: false, error: `Could not resolve symlinks${code ? ` (${code})` : ''}` }
  }
  if (!isPathInsideRoot(real, realRoot)) return { ok: false, error: 'Path outside project root (symlink-resolved)' }
  return { ok: true, real, realRoot }
}

function getElementSourceFile(elementSource: string): string {
  const lastColon = elementSource.lastIndexOf(':')
  const secondLastColon = elementSource.lastIndexOf(':', lastColon - 1)
  return secondLastColon > 0
    ? elementSource.slice(0, secondLastColon)
    : elementSource.split(':')[0] ?? elementSource
}

function isFixRequestSourceInsideRoot(elementSource: string, root: string): boolean {
  const sourceFile = getElementSourceFile(elementSource)
  const resolved = path.resolve(root, sourceFile)
  if (!isPathInsideRoot(resolved, root)) return false

  let realRoot: string
  try {
    realRoot = fs.realpathSync.native(root)
  } catch {
    realRoot = root
  }

  try {
    const realResolved = fs.realpathSync.native(resolved)
    return isPathInsideRoot(realResolved, realRoot)
  } catch {
    try {
      const realParent = fs.realpathSync.native(path.dirname(resolved))
      return isPathInsideRoot(realParent, realRoot)
    } catch {
      return isPathInsideRoot(resolved, root)
    }
  }
}

export function createManualInjectionSnippet(state: InjectionState): string {
  return `<script>${createManualInjectionScriptBody(state)}</script>`
}

export function injectWebpackHtml(html: string, state: InjectionState): string {
  const snippet = createManualInjectionSnippet(state)
  const injected = html.replace(/<\/head>/i, `${snippet}\n</head>`)
  return injected === html ? html : injected
}

function detectNextProject(root: string): boolean {
  const nextConfig = [
    'next.config.js', 'next.config.cjs', 'next.config.mjs',
    'next.config.ts', 'next.config.cts', 'next.config.mts',
  ].some(name => fs.existsSync(path.join(root, name)))
  if (nextConfig) return true
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return Boolean(pkg.dependencies?.next || pkg.devDependencies?.next)
  } catch {
    return false
  }
}

/**
 * The standalone cortex bridge: its own loopback HTTP server hosting the
 * browser bundle, the browser WS channel, the CLI WS channel, and the edit
 * pipeline — plus the `.cortex/` discovery files (`port`, `token`,
 * `injection.json`) that the MCP CLI and <CortexDevScripts/> read.
 *
 * Despite the name, nothing in here requires webpack: the webpack plugin
 * drives start()/dispose()/notifyHMR() from compiler hooks, and withCortex()
 * (next.ts) drives start() from Next's phase-function config with no
 * bundler hooks at all. Exported for that second consumer; not part of the
 * public package API surface.
 */
export class CortexWebpackRuntime {
  /** Per-runtime id passed to the source-loader so MultiCompiler with one
   *  lock-refused plugin doesn't accidentally disable the other plugin's
   *  transforms. ZF0-1851 — see source-loader-utils.disabledRuntimes. May be
   *  supplied by the caller (next.ts generates it up front to thread the SAME id
   *  into the loader options synchronously); defaults to a fresh UUID otherwise
   *  (the webpack plugin path, which reads it back off the instance). */
  readonly runtimeId: string
  private readonly root: string
  private readonly mode: string
  private readonly requestedPort?: number
  private readonly toggleShortcut: string
  private readonly invalidate?: () => void
  private readonly browserIIFEPath: string
  private session: CortexSession | null = null
  /** Design-system payloads shipped in the browser hello (swatches, color
   *  chips, text components, spacing tokens) — lazily resolved ONCE per
   *  runtime and cached, mirroring vite.ts's server-boot resolver promises.
   *  Lazy (not tied to initializePipeline) so a browser that inits before the
   *  pipeline finishes still gets tokens; memoized so repeat inits
   *  (multi-tab, HMR re-mount) cost ~nothing. Absent on the wire when the
   *  theme doesn't resolve — the picker shows its empty state, editing is
   *  unaffected (the edit pipeline has its own resolver). */
  private helloTokenPayloads: Promise<{
    swatches: string[] | null
    colorChips: import('../core/tailwind-resolver.js').ColorChip[] | null
    textComponents: import('../core/text-components.js').TextComponent[] | null
    spacingTokens: import('../core/tailwind-resolver.js').SpacingToken[] | null
  }> | null = null
  /** In-flight discovery-file write, tracked so dispose() serializes with it
   *  (see startInternal / dispose). */
  private discoveryWrites: Promise<void> | null = null
  /** One-shot flag for the silent post-foreign-conflict retry (see the
   *  LockHeldError handling in startInternal). */
  private conflictRetryScheduled = false
  /** True only while the scheduled retry's start() is executing — so a
   *  re-entrant start() (beforeRun/watchRun/HTML injection) is not mistaken for
   *  the retry and doesn't warn early (codex P3). */
  private conflictRetryFiring = false
  /** Warn-once guard for a GENUINE (post-retry) foreign conflict. */
  private conflictWarned = false
  /** Pending retry timer — cancelled by dispose() so a shutdown during the
   *  retry window cannot resurrect a bridge on a disposed runtime (cubic P1). */
  private conflictRetryTimer: ReturnType<typeof setTimeout> | null = null
  /** Set by startInternal's lock-refused path; consumed by start() to
   *  un-memoize AFTER the assignment settles (see start()). */
  private lockRefusedLastStart = false
  /** Retry delay for the transient-holder self-heal; injectable for tests. */
  private readonly conflictRetryDelayMs: number
  private httpServer: HttpServer | null = null
  private browserWss: WebSocketServer | null = null
  private cliWss: WebSocketServer | null = null
  private browserClients = new Set<WebSocket>()
  private initializedBrowserClients = new Set<WebSocket>()
  private startPromise: Promise<void> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: { root: string; mode: string; port?: number; toggleShortcut: string; invalidate?: () => void; runtimeId?: string; conflictRetryDelayMs?: number }) {
    this.root = options.root
    this.mode = options.mode
    this.requestedPort = options.port
    this.toggleShortcut = options.toggleShortcut
    this.invalidate = options.invalidate
    this.runtimeId = options.runtimeId ?? randomUUID()
    this.conflictRetryDelayMs = options.conflictRetryDelayMs ?? 4000
    this.browserIIFEPath = resolveBrowserIIFEPath()
  }

  get started(): boolean {
    return Boolean(this.session && this.httpServer)
  }

  get injectionState(): InjectionState | null {
    const session = this.session
    const port = this.port
    if (!session || !port) return null
    return {
      port,
      token: session.token,
      sessionId: session.sessionId,
      browserScriptUrl: `http://localhost:${port}${CORTEX_BROWSER_PATH}`,
      toggleShortcut: this.toggleShortcut,
    }
  }

  get port(): number {
    const addr = this.httpServer?.address()
    return typeof addr === 'object' && addr ? addr.port : 0
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal()
      .then(() => {
        // A lock-refused run completes "successfully" but must NOT stay
        // memoized — a later start() (next watchRun, the conflict-retry
        // timer) needs to re-attempt acquisition. This clearing must happen
        // HERE, after the memoizing assignment settles: the old pattern of
        // clearing startPromise synchronously inside startInternal was
        // overwritten by this very assignment (the constructor-throw path is
        // fully synchronous), so the documented ZF0-1851 retry never actually
        // fired.
        if (this.lockRefusedLastStart) {
          this.lockRefusedLastStart = false
          this.startPromise = null
        }
      })
      .catch(async err => {
        await this.dispose().catch(() => {})
        this.startPromise = null
        throw err
      })
    return this.startPromise
  }

  private async startInternal(): Promise<void> {
    if (this.session || this.httpServer) return
    // Annotations persistence opt-in lives in resolveAnnotationsFilePath —
    // shared by the vite adapter and unit-tested without a webpack runtime.
    const annotationsFilePath = resolveAnnotationsFilePath({ root: this.root })

    // ZF0-1851: acquire the .cortex/ single-writer lock inside CortexSession's
    // constructor. A live conflicting instance throws LockHeldError here; we
    // log it and return cleanly so cortex doesn't start — the user's webpack
    // build itself keeps running.
    let session: CortexSession
    try {
      session = new CortexSession({
        root: this.root,
        mode: this.mode,
        annotationsFilePath,
        cortexDir: path.join(this.root, '.cortex'),
        // Use the runtimeId as the lock's owner nonce so the Next adapter can
        // ADVERTISE it in __CORTEX_LOCK_FAMILY synchronously at config-eval
        // time — before any child process is spawned — instead of only after
        // this async construction acquires the lock. Same-boot double evals
        // then classify sameFamily even when the spawn wins the race.
        lockOwnerNonce: this.runtimeId,
      })
    } catch (err) {
      if (err instanceof LockHeldError) {
        // ZF0-1851: flag the refusal so start() un-memoizes AFTER its
        // assignment settles and a later start() (next watchRun, the
        // conflict-retry timer) re-attempts acquisition. (Clearing
        // this.startPromise directly here is ineffective — this catch runs
        // synchronously inside the startInternal() call, before start()'s
        // memoizing assignment, which would overwrite the cleared slot.)
        this.lockRefusedLastStart = true
        if (err.sameFamily) {
          // A same-family refusal is a NORMAL `next dev` boot: Next evaluates
          // next.config more than once per boot across the CLI/dev-server
          // processes, and exactly one evaluation may own the bridge. The
          // loser goes inert SILENTLY (warning here on every boot was the
          // ZF0-1851 misfire the 0.3.0 validation caught) and — critically —
          // keeps its source-loader transforms ENABLED: this process may be
          // the one compiling, and its data-cortex-source attributes pair
          // with the sibling's discovery files as ONE logical session.
          // Enabled must be asserted EXPLICITLY (not merely "not disabled") —
          // a stale disabled flag from an earlier foreign-conflict loss in
          // this process would otherwise survive into the same-family state.
          markRuntimeEnabled(this.runtimeId)
          return
        }
        // A non-family conflict — disable this runtime's source-loader
        // transforms (the loader, attached at apply() time, would otherwise
        // rewrite JSX for a build whose bridge/client are absent, while
        // <CortexDevScripts/> injects the OTHER server's port/token).
        markRuntimeDisabled(this.runtimeId)
        if (this.conflictRetryFiring && !this.conflictWarned) {
          // This refusal IS the scheduled retry still finding the lock held →
          // a genuine second dev server, not a draining predecessor. Warn once.
          this.conflictWarned = true
          console.error(err.message)
        } else if (!this.conflictRetryScheduled) {
          // FIRST refusal: DON'T warn yet. The realistic foreign holder during
          // a quick restart is the dying server still holding the lock for
          // ~1-2s before it drains (P3-1) — alarming the user then, only to
          // reclaim moments later, is the spurious warning the retest saw.
          // Schedule ONE silent, unref'd retry; if it succeeds, no warning ever
          // fires. conflictRetryFiring gates the warn to the RETRY specifically
          // — webpack calls start() again from beforeRun/watchRun/HTML-injection,
          // and those re-entrant refusals (before the retry fires) must stay
          // silent, or the transient warning we're suppressing leaks back in.
          this.conflictRetryScheduled = true
          this.conflictRetryTimer = setTimeout(() => {
            this.conflictRetryTimer = null
            this.conflictRetryFiring = true
            this.start().catch(() => {}).finally(() => { this.conflictRetryFiring = false })
          }, this.conflictRetryDelayMs)
          this.conflictRetryTimer.unref()
        }
        // else: a re-entrant start() while a retry is pending — stay silent; the
        // pending retry decides transient-vs-genuine.
        return
      }
      throw err
    }
    // Successful acquire: ensure this runtime's transforms are enabled. Clears
    // any prior disabled state from a recovered lock-refused run.
    markRuntimeEnabled(this.runtimeId)
    this.session = session
    _lastRuntime = this

    this.browserWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
    this.cliWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
    session.cliWss = this.cliWss
    session.channel = this.createChannel(session)

    this.browserWss.on('connection', (ws) => this.handleBrowserConnection(session, ws))
    this.cliWss.on('connection', (ws) => this.handleCliConnection(session, ws))

    this.httpServer = createServer((req, res) => {
      if (req.url === CORTEX_BROWSER_PATH) {
        try {
          const content = fs.readFileSync(this.browserIIFEPath, 'utf8')
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(content)
        } catch (err) {
          res.statusCode = 500
          res.end(`[cortex] Browser bundle not found: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      res.statusCode = 404
      res.end('Not found')
    })

    this.httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!isLoopbackRequest(req)) {
        socket.destroy()
        return
      }
      const host = req.headers.host
      if (!host || !ALLOWED_ORIGINS.test(`http://${host}`)) {
        socket.destroy()
        return
      }
      if (!isAllowedWebSocketOrigin(req.headers.origin)) {
        socket.destroy()
        return
      }
      if (req.url === BROWSER_WS_PATH && this.browserWss) {
        this.browserWss.handleUpgrade(req, socket, head, (ws) => this.browserWss!.emit('connection', ws, req))
        return
      }
      if (req.url === CLI_WS_PATH && this.cliWss) {
        this.cliWss.handleUpgrade(req, socket, head, (ws) => this.cliWss!.emit('connection', ws, req))
        return
      }
      socket.destroy()
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      this.httpServer!.once('error', onError)
      this.httpServer!.listen(this.requestedPort ?? 0, '127.0.0.1', () => {
        this.httpServer!.removeListener('error', onError)
        resolve()
      })
    })
    // The bridge must NEVER be the reason a Node process stays alive. Next
    // evaluates next.config with the dev-server phase in processes that are
    // not the dev server and that rely on natural event-loop drain to exit —
    // the detached telemetry flusher, the exiting `next dev` CLI parent. A
    // ref'd listening handle would pin such a process forever: a zombie
    // holding a live .cortex/.lock that turns every subsequent `next dev`
    // inert (P0, 0.3.0 activation review). The real dev server keeps its own
    // process alive, so unref'ing costs nothing there.
    this.httpServer.unref()
    // ACCEPTED sockets must be unref'd too (codex P1): unref() only covers the
    // listening handle. A connected client — the MCP CLI of a still-open
    // Claude Code session is the realistic one — would otherwise re-pin a
    // draining inspector process for as long as the client stays connected,
    // resurrecting the zombie through the front door. In the real dev server
    // the process is kept alive by its own handles, so client sockets never
    // needed to be ref'd here in the first place.
    this.httpServer.on('connection', (socket) => socket.unref())

    // Track the in-flight write so dispose() can serialize against it, and
    // re-check ownership after the await: a signal or in-process restart may
    // have disposed this runtime while the writes were pending. Continuing
    // would start a heartbeat on a torn-down session — and a successor
    // bridge's fresh discovery files could be clobbered by our stale write.
    this.discoveryWrites = this.writeDiscoveryFiles(session)
    await this.discoveryWrites
    if (this.session !== session) return
    this.startHeartbeat(session)
    this.initializePipeline(session)
    // Warm the hello design-system payloads at boot (vite resolves at
    // configureServer time) — without this, the FIRST browser init pays the
    // full Tailwind resolution latency, and the whole init batch (agent-status,
    // annotations too) would wait on it.
    void this.resolveHelloTokenPayloads()
  }

  private createChannel(session: CortexSession): ServerChannel {
    const send = (msg: ServerToBrowser): void => {
      this.sendToInitializedBrowsers(session, msg, 'webpack.channel.send')
      this.forwardToCLI(session, msg)
    }
    return {
      send,
      broadcast: send,
      onMessage: () => () => {},
      dispose: async () => {},
    }
  }

  /** Discovery writes are ATOMIC (tmp + rename) so readers — <CortexDevScripts/>
   *  per render, the MCP CLI at connect — can never observe a torn/partial file.
   *  The client-side torn-read guards remain as defense in depth for the
   *  cross-FILE window (three files still change non-atomically as a set). */
  private async writeDiscoveryFiles(session: CortexSession): Promise<void> {
    const cortexDir = path.join(this.root, '.cortex')
    const portFilePath = path.join(cortexDir, 'port')
    const tokenFilePath = path.join(cortexDir, 'token')
    try {
      fs.mkdirSync(cortexDir, { recursive: true, mode: 0o700 })
    } catch (err) {
      console.warn('[cortex] Could not create .cortex/ directory:', err instanceof Error ? err.message : err)
      return
    }
    try {
      await atomicWrite(portFilePath, String(this.port))
      session.portFilePath = portFilePath
    } catch (err) {
      console.warn('[cortex] Could not write port file:', err instanceof Error ? err.message : err)
    }
    try {
      await atomicWrite(tokenFilePath, session.token, { mode: 0o600 })
      fs.chmodSync(tokenFilePath, 0o600)
      session.tokenFilePath = tokenFilePath
    } catch (err) {
      console.error('[cortex] Could not write token file — CLI authentication will fail:', err instanceof Error ? err.message : err)
    }
    // Third discovery file: everything <CortexDevScripts/> needs to build the
    // injection snippet that isn't derivable from port+token alone. Written
    // 0600 like the token file (it names a live session id).
    const injectionFilePath = path.join(cortexDir, 'injection.json')
    try {
      await atomicWrite(
        injectionFilePath,
        // lockGeneration binds these values to THIS bridge's exact lock
        // acquisition: <CortexDevScripts/> compares it against the live lock's
        // generation, so a successor's acquire→publish window (live lock, but
        // the files on disk are still the predecessor's) is detectable — even
        // when the successor is same-family and shares the family nonce.
        JSON.stringify({
          port: this.port,
          sessionId: session.sessionId,
          toggleShortcut: this.toggleShortcut,
          lockGeneration: session.lockGeneration,
        }),
        { mode: 0o600 },
      )
      fs.chmodSync(injectionFilePath, 0o600)
      session.injectionFilePath = injectionFilePath
    } catch (err) {
      console.warn('[cortex] Could not write injection file — <CortexDevScripts/> will stay inactive:', err instanceof Error ? err.message : err)
    }
  }

  private startHeartbeat(session: CortexSession): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of session.cliClients) {
        if (!session.aliveFlags.get(client)) {
          client.terminate()
          this.removeCliClient(session, client)
          continue
        }
        session.aliveFlags.set(client, false)
        try { client.ping() } catch { this.removeCliClient(session, client) }
      }
    }, HEARTBEAT_INTERVAL)
    this.heartbeatTimer.unref()
    session.heartbeatTimer = this.heartbeatTimer
  }

  /** Resolve the four browser-facing design-system payloads, once. Mirrors
   *  vite.ts's server-boot promises (same per-payload catch-and-warn contract:
   *  a failed resolver logs and degrades to null — never blocks the hello).
   *  This producer was MISSING on the webpack/Next path until 0.3.1: the vite
   *  hello shipped tokens while this adapter sent a bare hello, so the token
   *  picker showed "No design tokens detected" on every Next app even when
   *  the server had resolved the theme for the edit pipeline (sibling-adapter
   *  asymmetry, found by the zerofog-web round-2 retest). */
  private resolveHelloTokenPayloads() {
    return (this.helloTokenPayloads ??= (async () => {
      const warn = (what: string) => (err: unknown) => {
        console.warn(`[cortex] Tailwind ${what} resolution failed:`, err instanceof Error ? err.message : err)
        return null
      }
      const [swatches, colorChips, textComponents, spacingTokens] = await Promise.all([
        TailwindResolver.resolveColors(this.root).catch(warn('color')),
        TailwindResolver.resolveColorChips(this.root).catch(warn('color chip')),
        TailwindResolver.resolveTextComponents(this.root).catch(warn('text component')),
        TailwindResolver.resolveSpacingTokens(this.root).catch(warn('spacing token')),
      ])
      return { swatches, colorChips, textComponents, spacingTokens }
    })())
  }

  private initializePipeline(session: CortexSession): void {
    const channel = session.channel
    if (!channel) return
    const projectRoot = this.root
    const rewriter = new TailwindRewriter()
    const inlineStyleRewriter = new InlineStyleRewriter()
    const verifier = new HMRVerifier(channel)
    const cssModulesRewriter = new CSSModulesRewriter({
      readFile: (p) => fs.promises.readFile(p, 'utf-8'),
    })
    const runtimeResolver = new RuntimeCSSResolver()
    const undoStack = new UndoStack()
    const detector = new StyleDetector()

    const detectionPromise = detector.detect(projectRoot).catch((err) => {
      console.warn('[cortex] Style detection failed:', err instanceof Error ? err.message : err)
      return { hasCSSModules: false, hasTailwind: false, hasCSSInJS: false, hasPlainCSS: true, hasComponentLibrary: false, summary: 'Detection failed' } satisfies DetectionResult
    })
    const resolverPromise = TailwindResolver.fromConfig(projectRoot).catch((err) => {
      console.warn('[cortex] Tailwind config resolution failed:', err instanceof Error ? err.message : err)
      return null
    })

    Promise.all([detectionPromise, resolverPromise]).then(([detection, resolver]) => {
      if (!this.session || this.session !== session || session.isDisposed) return
      session.pipeline?.dispose()
      session.hmrUnsubscribe?.()
      session.pipeline = new EditPipeline({
        channel,
        resolver: resolver ?? TailwindResolver.fromTheme({}),
        // The real resolver may be null (theme unresolved) even though we pass a
        // truthy empty stand-in above — tell the pipeline which it is.
        resolverAvailable: !!resolver,
        rewriter,
        inlineStyleRewriter,
        verifier,
        cssModulesRewriter,
        detector: detection,
        runtimeResolver,
        undoStack,
        writeFile: async (intent) => {
          await atomicWrite(intent.filePath, intent.content)
          if (!shouldSuppressHmr(intent)) this.invalidate?.()
        },
        readFile: (p) => fs.promises.readFile(p, 'utf-8'),
        projectRoot,
      })
      session.hmrUnsubscribe = this.onHMRUpdate(session, files => verifier.onHMRUpdate(files))
      const resolverState: ResolverState = {
        resolverAvailable: resolver !== null,
        aiAvailable: false,
        inlineStyleAvailable: true,
      }
      const capabilities = computeCapabilities(detection, resolverState)
      session.capabilitiesCache = capabilities.length > 0 ? capabilities : null
      if (session.capabilitiesCache) channel.send({ type: 'capabilities', systems: session.capabilitiesCache })
    }).catch((err) => {
      console.error('[cortex] Failed to initialize edit pipeline:', err instanceof Error ? err.message : err)
    })
  }

  private onHMRUpdate(session: CortexSession, cb: (files: string[]) => void): () => void {
    session.hmrCallbacks.push(cb)
    return () => {
      const idx = session.hmrCallbacks.indexOf(cb)
      if (idx >= 0) session.hmrCallbacks.splice(idx, 1)
    }
  }

  notifyHMR(files: string[]): void {
    const callbacks = [...(this.session?.hmrCallbacks ?? [])]
    for (const cb of callbacks) {
      try { cb(files) } catch (err) {
        console.warn('[cortex] HMR callback error:', err instanceof Error ? err.message : err)
      }
    }
  }

  private dropBrowserClient(session: CortexSession, ws: WebSocket): void {
    const wasInitialized = this.initializedBrowserClients.delete(ws)
    this.browserClients.delete(ws)
    session.browserConnected = this.initializedBrowserClients.size > 0
    if (wasInitialized && !session.browserConnected) {
      session.editorActive = false
      this.forwardToCLI(session, { type: 'cortex-closed' })
    }
  }

  private sendToBrowser(session: CortexSession, ws: WebSocket, msg: ServerToBrowser, context: string): void {
    const parsed = parseOrFail(serverToBrowserSchema, msg, context)
    if (parsed === null) return
    if (ws.readyState !== WebSocket.OPEN) {
      this.dropBrowserClient(session, ws)
      return
    }
    try {
      ws.send(JSON.stringify(parsed))
    } catch {
      this.dropBrowserClient(session, ws)
    }
  }

  private sendToInitializedBrowsers(session: CortexSession, msg: ServerToBrowser, context: string): void {
    const parsed = parseOrFail(serverToBrowserSchema, msg, context)
    if (parsed === null) return
    const data = JSON.stringify(parsed)
    for (const ws of this.initializedBrowserClients) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.dropBrowserClient(session, ws)
        continue
      }
      try {
        ws.send(data)
      } catch {
        this.dropBrowserClient(session, ws)
      }
    }
  }

  private handleBrowserConnection(session: CortexSession, ws: WebSocket): void {
    this.browserClients.add(ws)
    const disconnect = () => this.dropBrowserClient(session, ws)
    ws.on('close', disconnect)
    ws.on('error', disconnect)
    ws.on('message', (raw) => this.handleBrowserMessage(session, ws, raw.toString()))
  }

  private handleBrowserMessage(session: CortexSession, ws: WebSocket, raw: string): void {
    if (session.isDisposed) return
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return }
    const data = parseOrFail(browserToServerSchema, parsed, 'webpack.browserMessage')
    if (data === null) {
      const issues = browserToServerSchema.safeParse(parsed)
      const message = issues.success ? 'Schema validation failed' : formatIssues(issues.error.issues)
      this.sendToBrowser(session, ws, { type: 'error', code: 'SCHEMA_VIOLATION', message }, 'webpack.browserMessage.schemaError')
      return
    }
    if (data.type !== 'init' && !this.initializedBrowserClients.has(ws)) {
      this.sendToBrowser(session, ws, { type: 'error', code: 'AUTH_FAILED', message: 'Browser socket is not initialized' }, 'webpack.browserMessage.auth')
      return
    }
    if (WRITE_TYPES.has(data.type)) {
      if (!('token' in data) || !tokensEqual(data.token, session.token)) {
        this.sendToBrowser(session, ws, { type: 'error', code: 'AUTH_FAILED', message: 'Invalid or missing auth token' }, 'webpack.browserMessage.auth')
        return
      }
    }

    const { token: _token, ...forwardData } = data as Record<string, unknown>
    if (BROWSER_TO_CLI_FORWARD_TYPES.has(data.type)) {
      const forwarded = this.forwardToCLI(session, forwardData)
      if (data.type === 'staged-edits-ready' && forwarded) {
        const ackMsg: ServerToBrowser = { type: 'staged-edits-acked', requestId: data.requestId }
        this.sendToInitializedBrowsers(session, ackMsg, 'webpack.stagedEditsAck')
      }
    }

    // Pillar 1 (ZF0-1881 codex P1): legacy cortex-closed from Esc/X-button
    // must route through evaluateSetActive so activeState stays consistent
    // with editorActive. Without this the same-tab activation is treated as
    // idempotent and other tabs are rejected — user stuck.
    if (data.type === 'cortex-closed') {
      const result = evaluateSetActive(session.activeState, {
        active: false,
        tabId: session.activeState.activeBrowserId ?? undefined,
      })
      applySetActiveResult(session, result)
    }

    // Pillar 1: unified activation request from the browser.
    if (data.type === 'cortex/set-active') {
      const result = evaluateSetActive(session.activeState, {
        active: data.active,
        tabId: data.tabId,
      })
      applySetActiveResult(session, result)
      return
    }

    if (data.type === 'init') {
      const msgToken = (parsed as Record<string, unknown>).token
      if (!tokensEqual(msgToken, session.token)) {
        this.sendToBrowser(session, ws, { type: 'error', code: 'AUTH_FAILED', message: 'Invalid or missing auth token' }, 'webpack.browserMessage.initAuth')
        return
      }
      this.initializedBrowserClients.add(ws)
      session.browserConnected = true

      // Pillar 1: a fresh init with a different tab ID means the previously
      // adopted tab is gone (user refreshed). Clear the gate so the new tab
      // can claim it. Backward-compatible: init without tabId (old injected
      // script) leaves the gate intact.
      const initTabId = (parsed as Record<string, unknown>).tabId
      if (typeof initTabId === 'string' && session.activeState.activeBrowserId &&
          session.activeState.activeBrowserId !== initTabId) {
        const result = clearActiveBrowser(
          session.activeState,
          session.activeState.activeBrowserId,
        )
        applySetActiveResult(session, result)
      }

      // The whole init response awaits the (memoized) design-system payloads so
      // hello carries them AND the batch order is preserved (hello first, then
      // agent-status/cortex/capabilities/annotations — same order as before,
      // just deferred as a unit). In the common case (browser connects seconds
      // after boot) the promise is settled and this costs one microtask; an
      // early browser waits like vite's hello does ("ships as fast as the
      // slowest resolver"). Guards re-checked after the await: the session may
      // have been disposed/replaced while resolving.
      this.resolveHelloTokenPayloads()
        .then(({ swatches, colorChips, textComponents, spacingTokens }) => {
          if (this.session !== session || session.isDisposed) return
          this.sendToBrowser(session, ws, {
            type: 'hello',
            protocolVersion: 1,
            sessionId: session.sessionId,
            swatches: swatches && swatches.length > 0 ? swatches : undefined,
            colorChips: colorChips && colorChips.length > 0 ? colorChips : undefined,
            textComponents: textComponents && textComponents.length > 0 ? textComponents : undefined,
            spacingTokens: spacingTokens && spacingTokens.length > 0 ? spacingTokens : undefined,
          }, 'webpack.browserMessage.initHello')
          this.sendToBrowser(session, ws, { type: 'agent-status', connected: session.cliClients.size > 0 }, 'webpack.browserMessage.initAgentStatus')
          if (session.editorActive) this.sendToBrowser(session, ws, { type: 'cortex' }, 'webpack.browserMessage.initCortex')
          if (session.capabilitiesCache) this.sendToBrowser(session, ws, { type: 'capabilities', systems: session.capabilitiesCache }, 'webpack.browserMessage.initCapabilities')
          // Hydrate the browser with annotations the server has in memory.
          // Always emit — even an empty snapshot is authoritative. A reconnecting
          // browser (network blip, HMR re-mount) needs to know the server's current
          // state so any stale local annotations get replaced. The reducer performs
          // a full Map replacement on this message.
          this.sendToBrowser(
            session,
            ws,
            // ZF0-1856: DeepReadonly snapshots → mutable wire shape at the send boundary.
            { type: 'annotations-snapshot', annotations: session.annotations.getAll() as Annotation[] },
            'webpack.browserMessage.initAnnotationsSnapshot',
          )
        })
        .catch((err) => {
          console.warn('[cortex] Failed to send init batch:', err instanceof Error ? err.message : err)
        })
      return
    }
    if (data.type === 'comment') {
      if (data.kind === 'fix-request' && !isFixRequestSourceInsideRoot(data.elementSource, this.root)) {
        console.warn(`[cortex] Rejected fix-request: elementSource "${getElementSourceFile(data.elementSource)}" is outside project root`)
        return
      }
      const annotation = session.annotations.create({
        elementSource: data.elementSource,
        // COR-27. The Vite handler forwarded this and webpack/Next did not, so
        // an unannotated click on those adapters stored a session-local
        // `cortex-preview:` id and DROPPED the only thing that could resolve it
        // — the agent gets a comment naming an element it cannot find. Same
        // adapter-asymmetry class as the annotation/activity gap in 0.3.1:
        // whatever the vite handler forwards, this one must too.
        sourceResolutionHint: data.sourceResolutionHint,
        text: data.text,
        elementContext: data.elementContext,
        currentStyles: data.currentStyles,
        pinPosition: data.pinPosition,
        kind: data.kind,
        fixMeta: data.fixMeta,
      })
      // ZF0-1856: DeepReadonly snapshot → mutable wire shape at the send boundary.
      session.channel?.send({ type: 'annotation-created', annotation: annotation as Annotation })
      return
    }
    if (data.type === 'comment-reply') {
      const annotation = session.annotations.addMessage(data.annotationId, { from: 'user', text: data.text })
      if (annotation) session.channel?.send({ type: 'annotation-updated', annotation: annotation as Annotation })
      return
    }
    if (data.type === 'staged-edit-add') {
      session.stagedEdits.append(data.edit)
      return
    }
    if (data.type === 'staged-edit-remove') {
      session.stagedEdits.remove(data.intentIds)
      return
    }
    if (data.type === 'staged-edit-clear') {
      session.stagedEdits.clear()
      return
    }
    if (data.type === 'staged-edits-sync') {
      const results = data.edits.map(edit => pendingEditSchema.safeParse(edit))
      const validEdits = results.flatMap(result => result.success ? [result.data] : [])
      session.stagedEdits.mergeFullSync(validEdits)
      return
    }
    if (data.type === 'edit') {
      if (session.pipeline) session.pipeline.handleEdit(data)
      else session.channel?.send({ type: 'edit_status', editId: data.editId, status: 'failed', reason: 'Editor is still initializing. Please try again.' })
      return
    }
    if (data.type === 'undo') {
      if (session.pipeline) session.pipeline.handleUndo()
      else session.channel?.send({ type: 'undo_sync_status', status: 'failed', reason: 'Editor is still initializing.' })
      return
    }
    if (data.type === 'redo') {
      if (session.pipeline) session.pipeline.handleRedo()
      else session.channel?.send({ type: 'redo_sync_status', status: 'failed', reason: 'Editor is still initializing.' })
      return
    }
    if (data.type === 'clear_server_undo') session.pipeline?.clearUndoStack()
  }

  private forwardToCLI(session: CortexSession, msg: unknown): boolean {
    if (session.cliClients.size === 0) return false
    let data: string
    try { data = JSON.stringify(msg) } catch { return false }
    let delivered = false
    for (const client of session.cliClients) {
      if (client.readyState !== WebSocket.OPEN) continue
      try {
        client.send(data)
        delivered = true
      } catch {
        this.removeCliClient(session, client)
      }
    }
    return delivered
  }

  private markCliAuthenticated(session: CortexSession, ws: WebSocket): boolean {
    if (session.cliClients.has(ws)) {
      session.aliveFlags.set(ws, true)
      return true
    }
    if (session.cliClients.size >= MAX_CLI_CONNECTIONS) {
      ws.close(1013, 'Too many CLI connections')
      return false
    }
    session.cliClients.add(ws)
    session.aliveFlags.set(ws, true)
    this.sendToInitializedBrowsers(session, { type: 'agent-status', connected: true }, 'webpack.cliAgentStatus')
    return true
  }

  private removeCliClient(session: CortexSession, ws: WebSocket): void {
    const removed = session.cliClients.delete(ws)
    session.aliveFlags.delete(ws)
    if (removed) {
      this.sendToInitializedBrowsers(session, { type: 'agent-status', connected: session.cliClients.size > 0 }, 'webpack.cliAgentStatus')
    }
  }

  private handleCliConnection(session: CortexSession, ws: WebSocket): void {
    ws.on('pong', () => {
      if (session.cliClients.has(ws)) session.aliveFlags.set(ws, true)
    })
    ws.on('message', raw => void this.handleCliMessage(session, ws, raw.toString()))
    ws.on('close', () => this.removeCliClient(session, ws))
    ws.on('error', () => this.removeCliClient(session, ws))
  }

  private async handleCliMessage(session: CortexSession, ws: WebSocket, raw: string): Promise<void> {
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return }
    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return
    const type = (parsed as { type: unknown }).type
    if (typeof type !== 'string') return

    const msgToken = (parsed as Record<string, unknown>).token
    if (!tokensEqual(msgToken, session.token)) {
      try { ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'Invalid or missing auth token' })) } catch {}
      this.removeCliClient(session, ws)
      return
    }
    if (!this.markCliAuthenticated(session, ws)) return

    if (type === 'cortex-status-request') {
      try {
        ws.send(JSON.stringify({ type: 'cortex-status', editorActive: session.editorActive, browserConnected: session.browserConnected }))
      } catch {
        this.removeCliClient(session, ws)
        ws.terminate()
      }
      return
    }

    // mcp-session-hello — MCP server announces its process-scoped UUID; the
    // browser uses the forwarded hello as its reconcile trigger (phantom-intent
    // self-heal). Still gated behind the same token check as every other
    // privileged CLI message above — the MCP server attaches the token (see
    // mcp.ts socket.on('open')). The upgrade is only Origin-checked at connect;
    // the per-message token is the actual auth, so handling this AFTER the gate
    // prevents any other local process from forging hellos.
    // Token is STRIPPED — never forwarded to the browser.
    if (type === 'mcp-session-hello') {
      const sessionId = (parsed as Record<string, unknown>).sessionId
      if (typeof sessionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
        // DELIBERATELY NO stagedEdits.clear() here (0.3.1): the wipe formerly
        // keyed on a UUID change, but Claude Code spawns a fresh `cortex mcp`
        // process — fresh UUID — per conversation, so every Claude restart (and
        // every interleaved hello from two concurrent Claude clients) destroyed
        // the designer's staged-but-unapplied work. The designer's session is
        // the BROWSER page's lifetime (memory-only buffer), not any MCP process
        // lifetime. See the vite.ts sibling handler for the full rationale.
        // FIX 3: mcp-session-hello is a server→browser message; send BROWSER-ONLY
        // via sendToInitializedBrowsers (bypassing forwardToCLI). The channel.send
        // path fans out to CLI clients — wrong direction, no consumer.
        this.sendToInitializedBrowsers(session, { type: 'mcp-session-hello', sessionId }, 'webpack.mcpSessionHello')
      } else {
        console.warn('[cortex] mcp-session-hello rejected: sessionId is not a valid UUID')
      }
      return
    }

    if (type === 'cortex-rpc') {
      const rpcMsg = parseOrFail(cliRpcRequestSchema, parsed, 'webpack.cliDispatcher.cortex-rpc')
      if (rpcMsg === null) {
        try { ws.send(JSON.stringify({ type: 'error', code: 'SCHEMA_VIOLATION', message: 'Invalid cortex-rpc envelope' })) } catch {}
        return
      }
      const { requestId, method } = rpcMsg
      let params = rpcMsg.params
      if (!ALLOWED_RPC_METHODS.has(method)) {
        try { ws.send(JSON.stringify({ type: 'cortex-rpc-error', requestId, error: `Unknown RPC method: ${method}` })) } catch {}
        return
      }
      try {
        const methodSchema = RPC_METHOD_SCHEMAS[method as keyof typeof RPC_METHOD_SCHEMAS]
        if (methodSchema !== null && methodSchema !== undefined) {
          const schemaResult = (methodSchema as import('zod').ZodType<unknown>).safeParse(params)
          if (!schemaResult.success) {
            const formatted = formatIssues(schemaResult.error.issues)
            try { ws.send(JSON.stringify({ type: 'cortex-rpc-error', requestId, error: `SCHEMA_VIOLATION: ${formatted}` })) } catch {}
            return
          }
          params = schemaResult.data as Record<string, unknown>
        }
        const result = await Promise.resolve(this.handleRPC(session, method, params))
        try { ws.send(JSON.stringify({ type: 'cortex-rpc-result', requestId, result })) } catch {}
      } catch (err) {
        try { ws.send(JSON.stringify({ type: 'cortex-rpc-error', requestId, error: err instanceof Error ? err.message : String(err) })) } catch {}
      }
      return
    }

    // Pillar 1 unified path — accept new shape and route through helper.
    if (type === 'cortex/set-active') {
      const active = (parsed as unknown as { active: boolean }).active
      const result = evaluateSetActive(session.activeState, { active })
      applySetActiveResult(session, result)
      return
    }

    // Dual-mode legacy paths — translate into set-active. Drop after one
    // minor release once all clients have migrated to cortex/set-active.
    if (type === 'cortex' || type === 'cortex-close') {
      const result = evaluateSetActive(session.activeState, {
        active: type === 'cortex',
      })
      applySetActiveResult(session, result)
      return
    }

    if (!CLI_ALLOWED_TYPES.has(type)) return
    session.channel?.send({ type } as ServerToBrowser)
  }

  private handleRPC(session: CortexSession, method: string, params: Record<string, unknown>): unknown {
    const id = params.annotationId as string | undefined ?? ''
    switch (method) {
      case 'getActive': return session.annotations.getActive()
      case 'getPending': return session.annotations.getPending()
      case 'getDetails': return session.annotations.getById(id)
      case 'acknowledge': return session.annotations.acknowledge(id)
      case 'resolve': return session.annotations.resolve(id, params.summary as string)
      case 'dismiss': return session.annotations.dismiss(id, params.reason as string | undefined)
      case 'respond': return session.annotations.addMessage(id, { from: 'agent', text: params.text as string })
      case 'getPendingEdits': {
        const intents = session.stagedEdits.list()
        return { intents, count: intents.length }
      }
      case 'applyEdits': {
        const intentIds = params.intentIds as string[]
        if (!session.pipeline) {
          return {
            results: intentIds.map(intentId => ({
              intentId,
              status: 'failed' as const,
              error: 'Editor is still initializing. Please try again.',
            })),
            browserNotified: true,
          }
        }
        const stagedEdits = session.stagedEdits
        const pipeline = session.pipeline
        const channel = session.channel
        const hasBrowserClients = this.initializedBrowserClients.size > 0
        return applyEditsCore(stagedEdits, intentIds, pipeline).then(results => {
          const appliedIds = results.filter(result => result.status === 'applied').map(result => result.intentId)
          let browserNotified = appliedIds.length === 0  // vacuously true: nothing to notify
          // FIX 4: gate on hasBrowserClients (captured before async) so browserNotified
          // reflects whether a browser actually received the discard notification.
          if (appliedIds.length > 0 && channel && hasBrowserClients) {
            channel.send({ type: 'staged-edits-discard', intentIds: appliedIds })
            browserNotified = true
          }
          return { results, browserNotified }
        })
      }
      case 'discardEdits': {
        const intentIds = params.intentIds as string[]
        session.stagedEdits.remove(intentIds)
        // FIX 4: browserNotified only true when ≥1 initialized browser client exists.
        // initializedBrowserClients.size > 0 is more accurate than channel existence alone —
        // sendToInitializedBrowsers is a no-op when the set is empty.
        let browserNotified = false
        if (session.channel && this.initializedBrowserClients.size > 0) {
          try {
            session.channel.send({ type: 'staged-edits-discard', intentIds })
            browserNotified = true
          } catch (err) {
            console.warn('[cortex] Failed to send staged-edits-discard (discard) to browser:', err instanceof Error ? err.message : String(err))
          }
        }
        return { discarded: intentIds, browserNotified }
      }
      case 'acknowledgeSourceEdit': {
        const intentIds = params.intentIds as string[]
        session.stagedEdits.remove(intentIds)
        // FIX 4: browserNotified only true when ≥1 initialized browser client exists.
        let browserNotified = false
        if (session.channel && this.initializedBrowserClients.size > 0) {
          try {
            session.channel.send({ type: 'staged-edits-discard', intentIds })
            browserNotified = true
          } catch (err) {
            console.warn('[cortex] Failed to send staged-edits-discard (ack) to browser:', err instanceof Error ? err.message : String(err))
          }
        }
        return { acknowledged: intentIds, browserNotified }
      }
      case 'reportSourceEditFailed': {
        const intentIds = params.intentIds as string[]
        const reason = params.reason as string
        // STATE-MACHINE INVARIANT: do NOT remove from cache — the source edit failed.
        // FIX 4: browserNotified only true when ≥1 initialized browser client exists.
        let browserNotified = false
        if (session.channel && this.initializedBrowserClients.size > 0) {
          try {
            session.channel.send({ type: 'source-edit-failed', intentIds, reason })
            browserNotified = true
          } catch (err) {
            console.warn('[cortex] Failed to send source-edit-failed to browser:', err instanceof Error ? err.message : String(err))
          }
        }
        return { reported: intentIds, browserNotified }
      }
      case 'getIntentContext': {
        const intentId = params.intentId as string
        const intent = session.stagedEdits.getById(intentId)
        if (!intent) return { error: 'intent not found' }
        // See the equivalent branch in vite.ts (COR-24). Agent-resolve intents
        // have no file position; both adapters call the SAME core builder so
        // this answer cannot drift between them.
        if (isPreviewSource(intent.source)) {
          return agentResolveIntentContext(intent)
        }
        const parsed = parseIntentSource(intent.source)
        if (!parsed.ok) return { error: parsed.error }
        const resolvedPath = path.resolve(this.root, parsed.filePath)
        if (!isPathInsideRoot(resolvedPath, this.root)) return { error: 'Path outside project root' }
        const containment = requireRealpathInsideRoot(resolvedPath, this.root)
        if (!containment.ok) return { error: containment.error.includes('outside') ? containment.error : `${containment.error} in: ${parsed.filePath}` }
        let stats: fs.Stats
        try {
          stats = fs.statSync(containment.real)
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          return { error: `Could not stat file: ${parsed.filePath}${code ? ` (${code})` : ''}` }
        }
        const sizeCheck = checkIntentFileSize(parsed.filePath, stats.size)
        if (sizeCheck) return sizeCheck
        let fileContent: string
        try {
          fileContent = fs.readFileSync(containment.real, 'utf8')
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          return { error: `Could not read file: ${parsed.filePath}${code ? ` (${code})` : ''}` }
        }
        const slice = sliceIntentContext(fileContent, parsed.line)
        return {
          intentId,
          context: { before: slice.before, target: slice.target, after: slice.after },
          currentValue: slice.currentValue,
        }
      }
      default: throw new Error(`Unknown RPC method: ${method}`)
    }
  }

  async dispose(): Promise<void> {
    // Cancel a pending conflict retry FIRST — dispose() is the intent to stop;
    // a timer surviving it would call start() on this disposed runtime and
    // resurrect the bridge (cubic P1). A later legitimate restart (watchRun)
    // calls start() itself and gets a fresh retry budget.
    if (this.conflictRetryTimer) {
      clearTimeout(this.conflictRetryTimer)
      this.conflictRetryTimer = null
    }
    this.conflictRetryScheduled = false
    this.conflictRetryFiring = false
    this.conflictWarned = false
    // Let any in-flight discovery write LAND before session.dispose() removes
    // the files — an unserialized write would resume after removal and
    // re-create orphaned discovery files (or overwrite a successor bridge's
    // fresh set, leaving a live lock pointing at dead port/token data).
    if (this.discoveryWrites) await this.discoveryWrites.catch(() => {})
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    for (const ws of this.browserClients) ws.terminate()
    this.browserClients.clear()
    const browserWss = this.browserWss
    const httpServer = this.httpServer
    this.browserWss = null
    this.httpServer = null
    await this.session?.dispose()
    this.session = null
    await new Promise<void>(resolve => {
      browserWss?.close(() => {
        httpServer?.close(() => resolve())
        if (!httpServer) resolve()
      })
      if (!browserWss) {
        httpServer?.close(() => resolve())
        if (!httpServer) resolve()
      }
    })
    this.startPromise = null
  }
}

export class CortexWebpackPlugin {
  private readonly options: CortexWebpackOptions
  private readonly toggleShortcut: string

  constructor(options: CortexWebpackOptions = {}) {
    this.options = options
    this.toggleShortcut = validateToggleShortcut(options.toggleShortcut ?? DEFAULT_TOGGLE_SHORTCUT)
  }

  apply(compiler: WebpackCompiler): void {
    const projectRoot = path.resolve(this.options.projectRoot ?? compiler.options.context ?? compiler.context ?? process.cwd())
    if (compiler.options.mode === 'production' || process.env.NODE_ENV === 'production') return
    if (detectNextProject(projectRoot)) {
      console.warn('[cortex] Next.js project detected. Use withCortex() from cortex-editor/next instead of cortexWebpack().')
    }
    const runtime = new CortexWebpackRuntime({
      root: projectRoot,
      mode: compiler.options.mode ?? 'development',
      port: this.options.port,
      toggleShortcut: this.toggleShortcut,
      invalidate: () => compiler.watching?.invalidate?.(),
    })
    this.addSourceLoaderRule(compiler, projectRoot, runtime)

    compiler.hooks.beforeRun?.tapPromise(PLUGIN_NAME, () => runtime.start())
    compiler.hooks.watchRun?.tapPromise(PLUGIN_NAME, () => runtime.start())
    compiler.hooks.thisCompilation?.tap(PLUGIN_NAME, compilation => this.configureCompilation(compilation, compiler, runtime))
    compiler.hooks.done?.tap(PLUGIN_NAME, stats => {
      const modifiedFiles = stats.compilation?.modifiedFiles
      if (!modifiedFiles) return
      const files = Array.from(modifiedFiles)
        .filter(file => /\.[jt]sx$|\.css$/.test(file))
      if (files.length === 0) return
      runtime.notifyHMR(files)
    })
    compiler.hooks.shutdown?.tapPromise?.(PLUGIN_NAME, () => runtime.dispose())
  }

  private addSourceLoaderRule(compiler: WebpackCompiler, projectRoot: string, runtime: CortexWebpackRuntime): void {
    compiler.options.module ??= {}
    compiler.options.module.rules ??= []
    const rules = compiler.options.module.rules
    if (rules.some(rule => ruleUsesCortexSourceLoader(rule))) return
    const rule: WebpackRuleSet = {
      test: /\.[jt]sx$/,
      exclude: resourcePath => shouldExcludeCortexSource(resourcePath, this.options.includeNodeModules),
      enforce: 'pre',
      use: [{
        loader: resolveSourceLoaderPath(),
        options: {
          projectRoot,
          resolveAlias: this.options.resolveAlias,
          includeNodeModules: this.options.includeNodeModules,
          // ZF0-1851: the loader checks this runtimeId against the
          // disabledRuntimes set to decide whether to pass through unchanged.
          runtimeId: runtime.runtimeId,
        },
      }],
    }
    rules.push(rule)
  }

  private configureCompilation(
    compilation: WebpackCompilation,
    compiler: WebpackCompiler,
    runtime: CortexWebpackRuntime,
  ): void {
    const hooks = findHtmlWebpackPluginHooks(compilation, compiler.options.plugins ?? [])
    if (hooks?.beforeEmit) {
      hooks.beforeEmit.tapPromise(PLUGIN_NAME, async data => {
        await runtime.start()
        const state = runtime.injectionState
        return state ? { ...data, html: injectWebpackHtml(data.html, state) } : data
      })
      return
    }

    compilation.hooks?.processAssets?.tapPromise({ name: PLUGIN_NAME }, async () => {
      await runtime.start()
      const state = runtime.injectionState
      if (!state) return
      const snippet = createManualInjectionSnippet(state)
      emitAsset(compilation, compiler, 'cortex-manual-injection.html', snippet)
      console.warn(
        '[cortex] HtmlWebpackPlugin not detected; automatic script injection is unavailable. ' +
        'Add the snippet emitted at cortex-manual-injection.html to your dev HTML template.',
      )
    })
  }
}

function findHtmlWebpackPluginHooks(
  compilation: WebpackCompilation,
  plugins: unknown[],
): HtmlWebpackPluginHooks | null {
  for (const plugin of plugins) {
    const ctor = (plugin as { constructor?: { getHooks?: (compilation: WebpackCompilation) => HtmlWebpackPluginHooks } }).constructor
    if (typeof ctor?.getHooks === 'function') return ctor.getHooks(compilation)
  }
  return null
}

function emitAsset(
  compilation: WebpackCompilation,
  compiler: WebpackCompiler,
  name: string,
  source: string,
): void {
  const RawSource = compiler.webpack?.sources?.RawSource
  const asset = RawSource
    ? new RawSource(source)
    : { source: () => source, size: () => source.length }
  if (typeof compilation.emitAsset === 'function') {
    compilation.emitAsset(name, asset)
  } else {
    compilation.assets ??= {}
    compilation.assets[name] = asset
  }
}

function ruleUsesCortexSourceLoader(rule: unknown): boolean {
  if (!rule || typeof rule !== 'object') return false
  const candidate = rule as {
    loader?: unknown
    use?: unknown
    oneOf?: unknown
    rules?: unknown
  }

  if (loaderLooksLikeCortexSourceLoader(candidate.loader)) return true
  if (loaderLooksLikeCortexSourceLoader(candidate.use)) return true
  if (Array.isArray(candidate.use) && candidate.use.some(loaderLooksLikeCortexSourceLoader)) return true
  if (Array.isArray(candidate.oneOf) && candidate.oneOf.some(ruleUsesCortexSourceLoader)) return true
  if (Array.isArray(candidate.rules) && candidate.rules.some(ruleUsesCortexSourceLoader)) return true
  return false
}

function loaderLooksLikeCortexSourceLoader(loader: unknown): boolean {
  if (typeof loader === 'string') return /(?:^|[/\\])(?:next-)?source-loader\.cjs$/.test(loader)
  if (!loader || typeof loader !== 'object') return false
  return loaderLooksLikeCortexSourceLoader((loader as { loader?: unknown }).loader)
}

export function cortexWebpack(options?: CortexWebpackOptions): CortexWebpackPlugin {
  return new CortexWebpackPlugin(options)
}

export default cortexWebpack
