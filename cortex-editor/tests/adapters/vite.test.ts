import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server as HttpServer } from 'http'
import fs from 'fs'
import os from 'os'
import pathMod from 'path'
import WebSocket from 'ws'
import { cortexEditor, getChannel, onHMRUpdate, _resetForTesting, _getSessionTokenForTesting, _getStagedEditsForTesting, _getActiveStateForTesting, _addCLIClientForTesting, shouldSuppressHmr, performEditWrite, _getInjectedClientScriptForTesting } from '../../src/adapters/vite.js'
import { AnnotationStore } from '../../src/core/annotations.js'
import { makeEdit } from '../core/helpers.js'
import type { Plugin } from 'vite'
import { SchemaViolationError, browserToServerSchema, serverToBrowserSchema } from '../../src/schemas/index.js'

// Mock TailwindResolver so tests control when/how swatches resolve
vi.mock('../../src/core/tailwind-resolver.js', () => ({
  TailwindResolver: {
    resolveColors: vi.fn().mockResolvedValue(null),
    resolveColorChips: vi.fn().mockResolvedValue(null),
    resolveTextComponents: vi.fn().mockResolvedValue(null),
    resolveSpacingTokens: vi.fn().mockResolvedValue(null),
    fromConfig: vi.fn().mockResolvedValue(null),
    fromTheme: vi.fn().mockReturnValue({ findClass: vi.fn() }),
  },
}))

// Mock new dependencies so they don't perform real I/O during tests
vi.mock('../../src/core/rewriter/tailwind.js', () => ({
  TailwindRewriter: function() {
    this.rewrite = () => Promise.resolve({ success: false, filePath: '', reason: 'mock' })
    this.dispose = () => {}
  },
}))

vi.mock('../../src/core/hmr-verifier.js', () => ({
  HMRVerifier: function(_channel?: unknown) {
    this.trackEdit = () => {}
    this.onHMRUpdate = () => {}
    this.dispose = () => {}
  },
}))

vi.mock('../../src/core/edit-pipeline.js', () => ({
  EditPipeline: function(_opts: any) {
    this.handleEdit = () => {}
    this.handleUndo = () => {}
    this.handleRedo = () => {}
    this.dispose = () => {}
  },
}))

vi.mock('../../src/core/rewriter/detector.js', () => ({
  StyleDetector: function() {
    this.detect = () => Promise.resolve({
      hasCSSModules: false, hasTailwind: false, hasCSSInJS: false, hasPlainCSS: true, summary: 'No style system detected',
    })
  },
}))

vi.mock('../../src/core/rewriter/css-modules.js', () => ({
  CSSModulesRewriter: function() {
    this.rewrite = () => Promise.resolve({ success: false, filePath: '', reason: 'mock' })
    this.dispose = () => {}
  },
}))

vi.mock('../../src/core/rewriter/runtime-resolver.js', () => ({
  RuntimeCSSResolver: function() {
    this.resolve = () => Promise.resolve(null)
    this.dispose = () => {}
  },
}))

vi.mock('../../src/core/session/undo-stack.js', () => ({
  UndoStack: function() {
    this.push = () => {}
    this.undo = () => {}
    this.redo = () => {}
    this.peekUndo = () => null
    this.removeStaleEntry = () => false
    this.clear = () => {}
    this.canUndo = false
    this.canRedo = false
  },
}))

// Import mocks for per-test control
import { TailwindResolver } from '../../src/core/tailwind-resolver.js'
const mockResolveColors = vi.mocked(TailwindResolver.resolveColors)
const mockResolveSpacingTokens = vi.mocked(TailwindResolver.resolveSpacingTokens)

// Reset module-level state between tests so ordering doesn't matter
beforeEach(() => {
  mockResolveColors.mockResolvedValue(null)
  mockResolveSpacingTokens.mockResolvedValue(null)
})
afterEach(async () => {
  await _resetForTesting()
})

// Minimal mock of ResolvedConfig
function mockConfig(overrides: { command?: 'serve' | 'build'; root?: string } = {}) {
  return {
    command: overrides.command ?? 'serve',
    root: overrides.root ?? '/project',
  } as Parameters<NonNullable<Plugin['configResolved']>>[0]
}

// Helper to initialize plugin with config
function initPlugin(overrides?: { command?: 'serve' | 'build'; root?: string }) {
  const plugin = cortexEditor()
  ;(plugin.configResolved as Function)(mockConfig(overrides))
  return plugin
}

// Real files on disk for transform tests (COR-28). The transform refuses to stamp
// a position it cannot prove was measured against the file on disk, so a synthetic
// '/project/src/App.tsx' would take the refusal branch and assert nothing.
const TRANSFORM_ROOT = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cortex-vite-tx-'))

afterAll(() => {
  fs.rmSync(TRANSFORM_ROOT, { recursive: true, force: true })
})

/** Init the plugin rooted at a real temp dir, write `code` there, and return both
 *  the plugin and the real id to hand its transform. */
function initPluginWithFile(code: string, relPath = 'src/App.tsx') {
  const plugin = initPlugin({ root: TRANSFORM_ROOT })
  const id = pathMod.join(TRANSFORM_ROOT, relPath)
  fs.mkdirSync(pathMod.dirname(id), { recursive: true })
  fs.writeFileSync(id, code, 'utf8')
  return { plugin, id }
}

// Mock Vite server with server.hot API
function mockServer() {
  const handlers = new Map<string, Function>()
  const offHandlers = new Map<string, Function>()
  const sent: { event: string; data: unknown }[] = []
  return {
    middlewares: { use: vi.fn() },
    hot: {
      on(event: string, handler: Function) { handlers.set(event, handler) },
      off(event: string, handler: Function) { offHandlers.set(event, handler) },
      send(event: string, data: unknown) { sent.push({ event, data }) },
      _trigger(event: string, data: unknown) { handlers.get(event)?.(data) },
    },
    _handlers: handlers,
    _sent: sent,
  }
}

function mockServerWithHttp(http: HttpServer) {
  const handlers = new Map<string, Function>()
  const offHandlers = new Map<string, Function>()
  const sent: { event: string; data: unknown }[] = []
  return {
    middlewares: { use: vi.fn() },
    httpServer: http,
    hot: {
      on(event: string, handler: Function) { handlers.set(event, handler) },
      off(event: string, handler: Function) { offHandlers.set(event, handler) },
      send(event: string, data: unknown) { sent.push({ event, data }) },
      _trigger(event: string, data: unknown) { handlers.get(event)?.(data) },
    },
    _handlers: handlers,
    _offHandlers: offHandlers,
    _sent: sent,
  }
}

describe('cortexEditor Vite plugin', () => {
  describe('transform', () => {
    it('instruments JSX files with data-cortex-source', () => {
      const code = 'export default function App() { return <div>hello</div> }'
      const { plugin, id } = initPluginWithFile(code)
      const result = ((plugin.transform as { handler: Function }).handler)(code, id)
      expect(result).not.toBeNull()
      expect(result.code).toContain('data-cortex-source="src/App.tsx:')
      expect(result.map).toBeDefined()
    })

    it('returns null for non-JSX files', () => {
      const plugin = initPlugin()
      const result = ((plugin.transform as { handler: Function }).handler)('const x = 1', '/project/src/utils.ts')
      expect(result).toBeNull()
    })

    it('returns null for node_modules', () => {
      const plugin = initPlugin()
      const code = 'export default function C() { return <div /> }'
      const result = ((plugin.transform as { handler: Function }).handler)(code, '/project/node_modules/pkg/index.tsx')
      expect(result).toBeNull()
    })

    it('returns null in production build', () => {
      const plugin = initPlugin({ command: 'build' })
      const code = 'export default function App() { return <div>hello</div> }'
      const result = ((plugin.transform as { handler: Function }).handler)(code, '/project/src/App.tsx')
      expect(result).toBeNull()
    })
  })

  describe('transformIndexHtml', () => {
    it('injects script tag before </head> in dev mode', () => {
      const plugin = initPlugin()
      const html = '<html><head><title>App</title></head><body></body></html>'
      const hook = plugin.transformIndexHtml as { order: string; handler: (html: string) => string }
      const result = hook.handler(html)
      expect(result).toContain('<script type="module" src="/@cortex/client.js"></script>')
      expect(result).toContain('</head>')
      const scriptIdx = result.indexOf('/@cortex/client.js')
      const headIdx = result.indexOf('</head>')
      expect(scriptIdx).toBeLessThan(headIdx)
    })

    it('returns unchanged HTML in production', () => {
      const plugin = initPlugin({ command: 'build' })
      const html = '<html><head></head><body></body></html>'
      const hook = plugin.transformIndexHtml as { order: string; handler: (html: string) => string }
      const result = hook.handler(html)
      expect(result).toBe(html)
    })

    it('warns and returns HTML unchanged when </head> is missing', () => {
      const plugin = initPlugin()
      const html = '<html><body><h1>No head tag</h1></body></html>'
      const hook = plugin.transformIndexHtml as { order: string; handler: (html: string) => string }
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = hook.handler(html)
      expect(result).toBe(html)
      expect(warnSpy).toHaveBeenCalledWith(
        '[cortex] transformIndexHtml: </head> not found — client script not injected'
      )
      warnSpy.mockRestore()
    })
  })

  describe('virtual module', () => {
    it('resolves /@cortex/client.js to virtual module ID', () => {
      const plugin = initPlugin()
      const resolved = (plugin.resolveId as Function)('/@cortex/client.js')
      expect(resolved).toBe('\0cortex-client')
    })

    it('does not resolve other IDs', () => {
      const plugin = initPlugin()
      const resolved = (plugin.resolveId as Function)('./App.tsx')
      expect(resolved).toBeUndefined()
    })

    it('loads client script for virtual module ID', () => {
      const plugin = initPlugin()
      const source = (plugin.load as Function)('\0cortex-client')
      expect(source).toContain('import.meta.hot')
      expect(source).toContain('cortex:msg')
      expect(source).toContain('__cortex_channel__')
      expect(source).toContain('__cortex_send__')
    })

    it('client script defines __cortex_send__ as non-writable but configurable (tombstone-deletable, ZF0-1326 Task 1)', () => {
      const plugin = initPlugin()
      const source = (plugin.load as Function)('\0cortex-client') as string
      // Scope to just the __cortex_send__ descriptor — the Pillar 1 blocks
      // (__cortex_tab_id__, __cortex_active_cache__, __cortex_toggle_registered__)
      // that follow intentionally use configurable: false, so the slice must
      // end BEFORE them. Use the "Pillar 1: generate" comment as the boundary.
      const sendBlock = source.slice(
        source.indexOf("Object.defineProperty(window, '__cortex_send__'"),
        source.indexOf("// Pillar 1: generate a stable per-tab ID"),
      )
      expect(sendBlock).toContain('writable: false')
      // ZF0-1326 Task 1: configurable MUST be true so the browser channel can
      // closure-capture and then `delete window.__cortex_send__`. Flipping
      // this back to false would silently re-open the XSS-via-dev-server RCE
      // vector — the delete becomes a no-op and the global stays callable.
      expect(sendBlock).toContain('configurable: true')
      expect(sendBlock).not.toContain('configurable: false')
    })

    it('client script includes onerror on browser script tag', () => {
      const plugin = initPlugin()
      const source = (plugin.load as Function)('\0cortex-client')
      expect(source).toContain('__cortexScript.onerror')
      expect(source).toContain('Failed to load browser UI')
    })

    it('does not load other module IDs', () => {
      const plugin = initPlugin()
      const source = (plugin.load as Function)('./other.js')
      expect(source).toBeUndefined()
    })
  })

  describe('plugin metadata', () => {
    it('has name "cortex-editor"', () => {
      const plugin = cortexEditor()
      expect(plugin.name).toBe('cortex-editor')
    })

    it('uses enforce: "pre"', () => {
      const plugin = cortexEditor()
      expect(plugin.enforce).toBe('pre')
    })
  })

  describe('source maps', () => {
    it('returns valid source map from transform', () => {
      const code = 'export default function App() { return <div>hello</div> }'
      const { plugin, id } = initPluginWithFile(code, 'src/AppMap.tsx')
      const result = ((plugin.transform as { handler: Function }).handler)(code, id)
      expect(result).not.toBeNull()
      expect(result.map).not.toBeNull()
      expect(result.map.version).toBe(3)
      expect(result.map.mappings).toBeDefined()
      expect(typeof result.map.mappings).toBe('string')
    })
  })

  describe('configureServer + getChannel', () => {
    it('getChannel() throws before configureServer is called', () => {
      expect(() => getChannel()).toThrow('getChannel() called before the Vite dev server started')
    })

    it('getChannel() returns ServerChannel after configureServer', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const channel = getChannel()
      expect(channel).toBeDefined()
      expect(typeof channel.send).toBe('function')
      expect(typeof channel.broadcast).toBe('function')
      expect(typeof channel.onMessage).toBe('function')
      expect(typeof channel.dispose).toBe('function')
    })

    it('channel.onMessage receives messages from server.hot', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const token = _getSessionTokenForTesting()!
      const channel = getChannel()
      const received: unknown[] = []
      channel.onMessage((msg) => received.push(msg))
      const testMsg = { type: 'edit' as const, token, editId: '1', property: 'p', value: 'v', source: 's', elementSelector: 'e' }
      server.hot._trigger('cortex:msg', testMsg)
      expect(received).toHaveLength(1)
      expect(received[0]).toEqual(testMsg)
    })
  })

  describe('staged-edit hot-handler branches (ZF0-1452 wiring)', () => {
    // Pins the production wiring: the 4 staged-edit-* WS branches in
    // hotHandler must mutate currentSession.stagedEdits, and the
    // BROWSER_TO_CLI_FORWARD_TYPES allowlist must let staged-edits-ready
    // through to CLI clients. Without these tests, a typo like
    // `staged-edit-add` → `staged_edit_add` would type-check and ship —
    // unit tests on isValidPendingEdit and mergeFullSync don't pin the
    // wire-up itself.

    it('staged-edit-add appends valid PendingEdit to currentSession.stagedEdits', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const token = _getSessionTokenForTesting()!
      const validEdit = makeEdit({ intentId: 'wire-add', property: 'color' })
      server.hot._trigger('cortex:msg', { type: 'staged-edit-add', edit: validEdit, token })

      const cache = _getStagedEditsForTesting()
      expect(cache).not.toBeNull()
      expect(cache!.list()).toContainEqual(expect.objectContaining({ intentId: 'wire-add', property: 'color' }))
    })

    it('staged-edit-add rejects malformed edit and leaves cache unchanged', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const token = _getSessionTokenForTesting()!

      // Missing required fields (intentId, source, etc.) — fails browserToServerSchema in test mode.
      // parseOrFail throws SchemaViolationError (test mode); the message is no longer console.warn'd.
      expect(() => {
        server.hot._trigger('cortex:msg', { type: 'staged-edit-add', edit: { property: 'color' }, token })
      }).toThrow(SchemaViolationError)

      const cache = _getStagedEditsForTesting()
      expect(cache!.list()).toEqual([])
    })

    it('staged-edit-remove drops specified intentIds from cache', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const token = _getSessionTokenForTesting()!
      const cache = _getStagedEditsForTesting()!
      cache.append(makeEdit({ intentId: 'keep', property: 'color' }))
      cache.append(makeEdit({ intentId: 'drop', property: 'fontSize' }))

      server.hot._trigger('cortex:msg', { type: 'staged-edit-remove', intentIds: ['drop'], token })

      const remaining = cache.list().map(e => e.intentId)
      expect(remaining).toEqual(['keep'])
    })

    it('staged-edit-clear empties the cache', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const token = _getSessionTokenForTesting()!
      const cache = _getStagedEditsForTesting()!
      cache.append(makeEdit({ intentId: 'a', property: 'color' }))
      cache.append(makeEdit({ intentId: 'b', property: 'fontSize' }))
      expect(cache.size()).toBe(2)

      server.hot._trigger('cortex:msg', { type: 'staged-edit-clear', token })

      expect(cache.size()).toBe(0)
    })

    it('staged-edits-sync merges via mergeFullSync (newer-wins semantics)', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const token = _getSessionTokenForTesting()!
      const cache = _getStagedEditsForTesting()!
      // Seed the cache with a NEWER entry — the sync's older entry must lose.
      cache.append(makeEdit({ intentId: 'a', property: 'color', value: 'newer-win', timestamp: 2000 }))

      server.hot._trigger('cortex:msg', {
        type: 'staged-edits-sync',
        edits: [makeEdit({ intentId: 'a', property: 'color', value: 'older-lose', timestamp: 1000 })],
        token,
      })

      // mergeFullSync semantics — older incoming loses to newer existing.
      expect(cache.getById('a')?.value).toBe('newer-win')
    })

    it('staged-edits-ready forwards to CLI clients via BROWSER_TO_CLI_FORWARD_TYPES allowlist', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const token = _getSessionTokenForTesting()!

      const received: string[] = []
      const fakeClient = {
        readyState: 1, // WebSocket.OPEN
        send: (data: string) => { received.push(data) },
        terminate: () => {},
      }
      _addCLIClientForTesting(fakeClient)

      server.hot._trigger('cortex:msg', {
        type: 'staged-edits-ready',
        count: 3,
        requestId: 'req-allowlist-test',
        token,
      })

      expect(received).toHaveLength(1)
      const forwarded = JSON.parse(received[0]) as Record<string, unknown>
      expect(forwarded.type).toBe('staged-edits-ready')
      expect(forwarded.count).toBe(3)
      expect(forwarded.requestId).toBe('req-allowlist-test')
      // Token is stripped before forwarding (defense — see hotHandler comment).
      expect(forwarded.token).toBeUndefined()
    })

    it('staged-edit-add (high-frequency sync) is NOT forwarded to CLI clients', () => {
      // Falsifiability anchor for the BROWSER_TO_CLI_FORWARD_TYPES allowlist:
      // adding 'staged-edit-add' to the set would let high-frequency sync
      // messages flood the MCP process. This test fails cleanly if that
      // happens.
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const token = _getSessionTokenForTesting()!

      const received: string[] = []
      const fakeClient = {
        readyState: 1,
        send: (data: string) => { received.push(data) },
        terminate: () => {},
      }
      _addCLIClientForTesting(fakeClient)

      server.hot._trigger('cortex:msg', {
        type: 'staged-edit-add',
        edit: makeEdit({ intentId: 'no-forward', property: 'color' }),
        token,
      })

      expect(received).toHaveLength(0)
    })
  })

  describe('middleware error handling', () => {
    it('middleware calls next(error) when browser bundle is not found', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      // Extract the middleware handler
      const [, handler] = server.middlewares.use.mock.calls[0]
      const res = {
        setHeader: vi.fn(),
        end: vi.fn(),
      }
      const next = vi.fn()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // Handler should call next with error since the file won't exist in test env
      handler({}, res, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
      expect(errorSpy).toHaveBeenCalled()
      // Headers should NOT have been set (read-before-headers pattern)
      expect(res.setHeader).not.toHaveBeenCalled()

      errorSpy.mockRestore()
    })
  })

  describe('handshake (init → hello)', () => {
    it('sends hello with swatches after browser init message', async () => {
      mockResolveColors.mockResolvedValue(['#ef4444', '#3b82f6', '#22c55e'])
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      // Browser sends init
      server.hot._trigger('cortex:msg', { type: 'init' })

      // hello is sent async via .then() — wait for it specifically (agent-status arrives first)
      await vi.waitFor(() => {
        expect(server._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
      })

      const hello = server._sent.find((s) => (s.data as any).type === 'hello')!
      expect(hello.event).toBe('cortex:msg')
      expect((hello.data as any).protocolVersion).toBe(1)
      expect((hello.data as any).swatches).toEqual(['#ef4444', '#3b82f6', '#22c55e'])
    })

    it('hello awaits tailwind resolution before sending', async () => {
      // Create a promise we control
      let resolveSwatches!: (val: string[] | null) => void
      const pending = new Promise<string[] | null>((r) => { resolveSwatches = r })
      mockResolveColors.mockReturnValue(pending)

      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      // Browser sends init while tailwind is still resolving
      server.hot._trigger('cortex:msg', { type: 'init' })

      // Only agent-status sent — hello hasn't sent yet (swatches still pending)
      const hellosBeforeResolve = server._sent.filter((s) => (s.data as any).type === 'hello')
      expect(hellosBeforeResolve).toHaveLength(0)

      // Now resolve swatches
      resolveSwatches(['#000000'])
      await vi.waitFor(() => {
        const hellos = server._sent.filter((s) => (s.data as any).type === 'hello')
        expect(hellos.length).toBeGreaterThan(0)
      })

      const hello = server._sent.find((s) => (s.data as any).type === 'hello')
      expect((hello!.data as any).swatches).toEqual(['#000000'])
    })

    it('does not send delayed hello from a replaced session', async () => {
      let resolveSwatches!: (val: string[] | null) => void
      const pending = new Promise<string[] | null>((r) => { resolveSwatches = r })
      mockResolveColors.mockReturnValue(pending)

      const plugin = initPlugin()
      const oldServer = mockServer()
      ;(plugin.configureServer as Function)(oldServer)
      oldServer.hot._trigger('cortex:msg', { type: 'init' })

      const newServer = mockServer()
      ;(plugin.configureServer as Function)(newServer)

      resolveSwatches(['#111111'])
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      expect(oldServer._sent.filter((s) => (s.data as any).type === 'hello')).toHaveLength(0)
      expect(newServer._sent.filter((s) => (s.data as any).type === 'hello')).toHaveLength(0)

      newServer.hot._trigger('cortex:msg', { type: 'init' })
      await vi.waitFor(() => {
        expect(newServer._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
      })
    })

    it('hello has undefined swatches when tailwind resolution fails', async () => {
      mockResolveColors.mockRejectedValue(new Error('no tailwindcss'))
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      server.hot._trigger('cortex:msg', { type: 'init' })

      await vi.waitFor(() => {
        expect(server._sent.length).toBeGreaterThan(0)
      })

      expect((server._sent[0].data as any).swatches).toBeUndefined()
    })

    it('only sends hello in response to init, not other message types', async () => {
      // Contract: hello responds to the browser's explicit 'init' signal — not
      // any first message. Sending edits, comments, or other types must not
      // trigger hello. This test guards against regressions to the old
      // "any first message" heuristic.
      mockResolveColors.mockResolvedValue(null)
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      const token = _getSessionTokenForTesting()!
      server.hot._trigger('cortex:msg', { type: 'init' })
      server.hot._trigger('cortex:msg', { type: 'edit', token, editId: '1', property: 'p', value: 'v', source: 's', elementSelector: 'e' })

      await vi.waitFor(() => {
        expect(server._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
      })

      // Exactly one hello — from the single init. The edit after must NOT have
      // triggered a second hello.
      const hellos = server._sent.filter((s) => (s.data as any).type === 'hello')
      expect(hellos).toHaveLength(1)
    })

    it('sends fresh hello on every init (idempotent — multi-tab + HMR re-mount support)', async () => {
      // Contract: each init gets a hello response. Required so second browser
      // tabs, HMR re-mounts, and strict-mode double-mounts all rebuild their
      // session context from scratch without relying on retained state. The
      // old `helloSent` flag broke this by silently blocking repeat sends.
      mockResolveColors.mockResolvedValue(['#ff0000'])
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      server.hot._trigger('cortex:msg', { type: 'init' })
      await vi.waitFor(() => {
        const hellos = server._sent.filter((s) => (s.data as any).type === 'hello')
        expect(hellos).toHaveLength(1)
      })

      server.hot._trigger('cortex:msg', { type: 'init' })
      await vi.waitFor(() => {
        const hellos = server._sent.filter((s) => (s.data as any).type === 'hello')
        expect(hellos).toHaveLength(2)
      })

      const hellos = server._sent.filter((s) => (s.data as any).type === 'hello')
      expect((hellos[0].data as any).sessionId).toBe((hellos[1].data as any).sessionId)
      expect((hellos[0].data as any).swatches).toEqual((hellos[1].data as any).swatches)
    })

    it('does not forward init to application message handlers', async () => {
      mockResolveColors.mockResolvedValue(null)
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      const received: unknown[] = []
      getChannel().onMessage((msg) => received.push(msg))

      server.hot._trigger('cortex:msg', { type: 'init' })

      await vi.waitFor(() => {
        expect(server._sent.length).toBeGreaterThan(0)
      })

      // init should NOT be forwarded to application handlers
      expect(received).toHaveLength(0)
    })

    it('hello includes spacingTokens when resolver returns tokens', async () => {
      const mockTokens = [
        { name: '--spacing-sm', valuePx: 8, source: 'css-variable' as const },
        { name: '--spacing-md', valuePx: 16, source: 'css-variable' as const },
      ]
      vi.mocked(TailwindResolver.resolveSpacingTokens).mockResolvedValueOnce(mockTokens)

      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      server.hot._trigger('cortex:msg', { type: 'init' })

      await vi.waitFor(() => {
        expect(server._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
      })

      const hello = server._sent.find((s) => (s.data as any).type === 'hello')!
      expect((hello.data as any).spacingTokens).toEqual(mockTokens)
    })

    it('hello omits spacingTokens when resolver returns null', async () => {
      vi.mocked(TailwindResolver.resolveSpacingTokens).mockResolvedValueOnce(null)

      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      server.hot._trigger('cortex:msg', { type: 'init' })

      await vi.waitFor(() => {
        expect(server._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
      })

      const hello = server._sent.find((s) => (s.data as any).type === 'hello')!
      expect((hello.data as any).spacingTokens).toBeUndefined()
    })

    it('hello omits spacingTokens when resolver returns empty array', async () => {
      vi.mocked(TailwindResolver.resolveSpacingTokens).mockResolvedValueOnce([])

      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      server.hot._trigger('cortex:msg', { type: 'init' })

      await vi.waitFor(() => {
        expect(server._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
      })

      const hello = server._sent.find((s) => (s.data as any).type === 'hello')!
      expect((hello.data as any).spacingTokens).toBeUndefined()
    })
  })

  describe('handleHotUpdate + onHMRUpdate', () => {
    it('dispatches file list to registered HMR callbacks', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const files: string[][] = []
      onHMRUpdate((f) => files.push(f))
      const hmrContext = {
        modules: [
          { file: '/project/src/App.tsx' },
          { file: '/project/src/Header.tsx' },
          { file: null },
        ],
      }
      ;(plugin.handleHotUpdate as Function)(hmrContext)
      expect(files).toHaveLength(1)
      expect(files[0]).toEqual(['/project/src/App.tsx', '/project/src/Header.tsx'])
    })

    it('onHMRUpdate returns unsubscribe function', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const files: string[][] = []
      const unsub = onHMRUpdate((f) => files.push(f))
      unsub()
      const hmrContext = { modules: [{ file: '/project/src/App.tsx' }] }
      ;(plugin.handleHotUpdate as Function)(hmrContext)
      expect(files).toHaveLength(0)
    })

    it.each([
      ['styles.css', 'plain CSS'],
      ['App.module.css', 'CSS modules'],
    ])('fires onHMRUpdate for %s (%s) (bug #13)', (filename) => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const files: string[][] = []
      onHMRUpdate((f) => files.push(f))
      const fullPath = `/project/src/${filename}`
      const hmrContext = {
        modules: [{ file: fullPath }],
      }
      ;(plugin.handleHotUpdate as Function)(hmrContext)
      expect(files).toHaveLength(1)
      expect(files[0]).toEqual([fullPath])
    })
  })
})

// --- CLI WebSocket bridge tests ---
// These use a real HTTP server + WebSocket clients (matching transport.test.ts pattern)

describe('CLI WebSocket bridge', () => {
  let httpServer: HttpServer
  let serverPort: number
  let tmpDir: string
  let sessionToken: string
  const openClients: WebSocket[] = []

  function readToken(): string {
    return fs.readFileSync(pathMod.join(tmpDir, '.cortex', 'token'), 'utf8').trim()
  }

  function mockServerWithHttp(http: HttpServer) {
    const handlers = new Map<string, Function>()
    const offHandlers = new Map<string, Function>()
    const sent: { event: string; data: unknown }[] = []
    return {
      middlewares: { use: vi.fn() },
      httpServer: http,
      hot: {
        on(event: string, handler: Function) { handlers.set(event, handler) },
        off(event: string, handler: Function) { offHandlers.set(event, handler) },
        send(event: string, data: unknown) { sent.push({ event, data }) },
        _trigger(event: string, data: unknown) { handlers.get(event)?.(data) },
      },
      _handlers: handlers,
      _offHandlers: offHandlers,
      _sent: sent,
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cortex-ws-test-'))
  })

  async function setupServer() {
    const plugin = initPlugin({ root: tmpDir })
    httpServer = createServer()
    const server = mockServerWithHttp(httpServer)
    ;(plugin.configureServer as Function)(server)

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = httpServer.address()
    serverPort = (addr as any).port
    sessionToken = readToken()

    return { plugin, server }
  }

  type CLIConnection = { ws: WebSocket; nextMessage: () => Promise<any> }

  async function connectCLI(opts?: { headers?: Record<string, string> }): Promise<CLIConnection> {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/@cortex/ws`, {
      headers: opts?.headers,
    })

    // Attach message queue BEFORE open to catch cortex-status without race
    const queue: any[] = []
    const waiters: ((msg: any) => void)[] = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      const waiter = waiters.shift()
      if (waiter) waiter(msg)
      else queue.push(msg)
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    openClients.push(ws)

    return {
      ws,
      nextMessage(): Promise<any> {
        const buffered = queue.shift()
        if (buffered !== undefined) return Promise.resolve(buffered)
        return new Promise((resolve) => waiters.push(resolve))
      },
    }
  }

  afterEach(async () => {
    for (const ws of openClients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate()
      }
    }
    openClients.length = 0
    await _resetForTesting()
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('accepts WebSocket upgrade at /@cortex/ws path', async () => {
    await setupServer()
    const { ws } = await connectCLI()
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  it('sends cortex-status on CLI connect', async () => {
    await setupServer()
    const { nextMessage } = await connectCLI()
    const msg = await nextMessage()
    expect(msg).toEqual({
      type: 'cortex-status',
      editorActive: false,
      browserConnected: false,
    })
  })

  it('sends cortex-status with browserConnected after init', async () => {
    const { server } = await setupServer()
    server.hot._trigger('cortex:msg', { type: 'init' })

    const { nextMessage } = await connectCLI()
    const msg = await nextMessage()
    expect(msg.browserConnected).toBe(true)
  })

  it('forwards allowed CLI messages to browser channel', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain status

    ws.send(JSON.stringify({ type: 'cortex', token: sessionToken }))

    await vi.waitFor(() => {
      const cortexMsgs = server._sent.filter((s) => (s.data as any).type === 'cortex')
      expect(cortexMsgs.length).toBeGreaterThan(0)
    })
  })

  it('rejects CLI messages not in allowlist', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain status

    ws.send(JSON.stringify({ type: 'edit_status', editId: '1', status: 'done', token: sessionToken }))
    await new Promise((r) => setTimeout(r, 50))

    const editMsgs = server._sent.filter((s) => (s.data as any).type === 'edit_status')
    expect(editMsgs).toHaveLength(0)
  })

  it('forwards browser messages to CLI clients', async () => {
    const { server } = await setupServer()
    const { nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status (connected: true)

    const msgPromise = nextMessage()
    server.hot._trigger('cortex:msg', { type: 'cortex-closed' })
    const msg = await msgPromise
    expect(msg.type).toBe('cortex-closed')
  })

  it('forwards server-generated messages to CLI clients', async () => {
    await setupServer()
    const { nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status (connected: true)

    const msgPromise = nextMessage()
    const channel = getChannel()
    channel.send({ type: 'edit_status', editId: '1', status: 'done' })
    const msg = await msgPromise
    expect(msg.type).toBe('edit_status')
    expect(msg.editId).toBe('1')
  })

  it('rejects connections with invalid Origin header', async () => {
    await setupServer()
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/@cortex/ws`, {
      headers: { Origin: 'https://evil.com' },
    })
    openClients.push(ws)
    const error = await new Promise<Error>((resolve, reject) => {
      ws.on('error', (e) => resolve(e as Error))
      ws.on('open', () => reject(new Error('connection should have been rejected')))
    })
    // verifyClient returns false → ws library sends 401 Unauthorized
    expect(error.message).toContain('401')
  })

  it('rejects connections with invalid Host header (DNS rebinding)', async () => {
    await setupServer()
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/@cortex/ws`, {
      headers: { Host: 'evil.com:5173' },
    })
    openClients.push(ws)
    const error = await new Promise<Error>((resolve, reject) => {
      ws.on('error', (e) => resolve(e as Error))
      ws.on('open', () => reject(new Error('connection should have been rejected')))
    })
    // socket.destroy() before upgrade → connection reset
    expect(error).toBeInstanceOf(Error)
  })

  it('accepts connections with IPv6 [::1] host header (bug #11)', async () => {
    await setupServer()
    const { ws } = await connectCLI({
      headers: { Host: `[::1]:${serverPort}` },
    })
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  it('caps concurrent connections at 5', async () => {
    await setupServer()

    for (let i = 0; i < 5; i++) {
      await connectCLI()
    }

    const ws6 = new WebSocket(`ws://127.0.0.1:${serverPort}/@cortex/ws`)
    openClients.push(ws6)
    const closeCode = await new Promise<number>((resolve) => {
      ws6.on('close', (code) => resolve(code))
    })
    expect(closeCode).toBe(1013)
  })

  it('handles CLI disconnect gracefully', async () => {
    await setupServer()
    const { ws } = await connectCLI()

    ws.close()
    await new Promise<void>((resolve) => ws.on('close', resolve))

    const channel = getChannel()
    expect(() => channel.send({ type: 'cortex' })).not.toThrow()
  })

  it('cleans up CLI connections on session dispose', async () => {
    await setupServer()
    const { ws } = await connectCLI()

    const closePromise = new Promise<void>((resolve) => ws.on('close', resolve))
    // Session dispose owns bridge cleanup — channel dispose is slim (hot.off only)
    await _resetForTesting()
    await closePromise
  })

  it('removes upgrade listener on session dispose', async () => {
    await setupServer()
    // Session dispose owns bridge cleanup — channel dispose is slim
    await _resetForTesting()

    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/@cortex/ws`)
    openClients.push(ws)
    const result = await new Promise<string>((resolve) => {
      ws.on('error', () => resolve('error'))
      ws.on('open', () => resolve('open'))
      setTimeout(() => resolve('timeout'), 1000)
    })
    expect(result).not.toBe('open')
    ws.terminate()
  })

  it('tracks editorActive from CLI cortex message', async () => {
    await setupServer()
    const { ws, nextMessage } = await connectCLI()
    const status1 = await nextMessage()
    expect(status1.editorActive).toBe(false)

    ws.send(JSON.stringify({ type: 'cortex', token: sessionToken }))
    await new Promise((r) => setTimeout(r, 50))

    const { nextMessage: nextMessage2 } = await connectCLI()
    const status2 = await nextMessage2()
    expect(status2.editorActive).toBe(true)
  })

  it('tracks editorActive from browser cortex-closed message', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain status

    ws.send(JSON.stringify({ type: 'cortex', token: sessionToken }))
    await new Promise((r) => setTimeout(r, 50))

    server.hot._trigger('cortex:msg', { type: 'cortex-closed' })
    await new Promise((r) => setTimeout(r, 50))

    const { nextMessage: nextMessage2 } = await connectCLI()
    const status = await nextMessage2()
    expect(status.editorActive).toBe(false)
  })

  it('re-sends cortex to browser on init when editorActive is true', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status

    // Activate editor via CLI
    ws.send(JSON.stringify({ type: 'cortex', token: sessionToken }))
    await new Promise((r) => setTimeout(r, 50))

    // Record sent count after activation
    const sentBefore = server._sent.length

    // Simulate browser refresh — browser sends init
    server.hot._trigger('cortex:msg', { type: 'init' })
    await new Promise((r) => setTimeout(r, 50))

    const newMessages = server._sent.slice(sentBefore)
    expect(newMessages.some((s) => (s.data as any).type === 'cortex')).toBe(true)
    expect(newMessages.some((s) => (s.data as any).type === 'agent-status')).toBe(true)
  })

  it('does not send cortex on init when editorActive is false', async () => {
    const { server } = await setupServer()

    // Browser sends init without editor being active
    server.hot._trigger('cortex:msg', { type: 'init' })
    await new Promise((r) => setTimeout(r, 50))

    expect(server._sent.some((s) => (s.data as any).type === 'agent-status')).toBe(true)
    expect(server._sent.some((s) => (s.data as any).type === 'cortex')).toBe(false)
  })

  it('rejects CLI message without token (bug #19)', async () => {
    await setupServer()
    const { ws, nextMessage } = await connectCLI()

    // Drain the cortex-status and agent-status welcome messages
    await nextMessage()
    await nextMessage()

    ws.send(JSON.stringify({ type: 'cortex' }))
    const response = await nextMessage()

    expect(response.type).toBe('error')
    expect(response.code).toBe('AUTH_FAILED')
  })

  it('rejects CLI message with wrong token (bug #19)', async () => {
    await setupServer()
    const { ws, nextMessage } = await connectCLI()

    await nextMessage()
    await nextMessage()

    ws.send(JSON.stringify({ type: 'cortex', token: 'wrong-token' }))
    const response = await nextMessage()

    expect(response.type).toBe('error')
    expect(response.code).toBe('AUTH_FAILED')
  })

  // Task 12, Change 6 — security: mcp-session-hello triggers a DESTRUCTIVE
  // buffer.clear() on the browser. The /@cortex/ws upgrade is only Origin-checked;
  // the per-message token is the actual auth. These three tests pin that the
  // mcp-session-hello handler sits AFTER the token gate: untokened/wrong-token
  // messages are rejected and never forwarded, a valid-token message IS forwarded.
  it('rejects untokened mcp-session-hello and does NOT forward it to the browser (Task 12 security)', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status

    const VALID_UUID = '00000000-0000-4000-a000-000000000001'
    ws.send(JSON.stringify({ type: 'mcp-session-hello', sessionId: VALID_UUID }))
    const response = await nextMessage()

    // The CLI client gets a specific AUTH_FAILED rejection — proves enforcement,
    // not just "an error occurred".
    expect(response.type).toBe('error')
    expect(response.code).toBe('AUTH_FAILED')
    // And critically: nothing was pushed to the browser channel, so no wipe.
    await new Promise((r) => setTimeout(r, 50))
    expect(server._sent.some((s) => (s.data as any).type === 'mcp-session-hello')).toBe(false)
  })

  it('rejects wrong-token mcp-session-hello and does NOT forward it to the browser (Task 12 security)', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status

    const VALID_UUID = '00000000-0000-4000-a000-000000000002'
    ws.send(JSON.stringify({ type: 'mcp-session-hello', sessionId: VALID_UUID, token: 'wrong-token' }))
    const response = await nextMessage()

    expect(response.type).toBe('error')
    expect(response.code).toBe('AUTH_FAILED')
    await new Promise((r) => setTimeout(r, 50))
    expect(server._sent.some((s) => (s.data as any).type === 'mcp-session-hello')).toBe(false)
  })

  it('forwards a valid-token mcp-session-hello to the browser channel (Task 12)', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status

    const VALID_UUID = '00000000-0000-4000-a000-000000000003'
    ws.send(JSON.stringify({ type: 'mcp-session-hello', sessionId: VALID_UUID, token: sessionToken }))

    await vi.waitFor(() => {
      const hello = server._sent.find((s) => (s.data as any).type === 'mcp-session-hello')
      expect(hello).toBeDefined()
      expect((hello!.data as any).sessionId).toBe(VALID_UUID)
      // Token must be stripped — never leaked onward to the browser.
      expect('token' in (hello!.data as any)).toBe(false)
    })
  })

  // ─── mcp-session-hello NEVER clears staged edits (0.3.1) ──────────────────
  // History: ZF0-1869 originally cleared on UUID change ("genuine new Claude
  // session"). That keyed a destructive clear on the MCP PROCESS lifetime — but
  // Claude Code spawns a fresh `cortex mcp` (fresh UUID) per conversation, so
  // every Claude restart, and every interleaved hello from two concurrent
  // Claude clients, silently destroyed the designer's staged work. The
  // designer's session is the BROWSER page's lifetime; no hello variant clears:
  //   (a) first hello → do NOT clear
  //   (b) same UUID again (transient reconnect) → do NOT clear
  //   (c) different UUID (MCP restart / second Claude client) → do NOT clear
  //   (d) interleaved A,B,A hellos (two concurrent clients) → do NOT clear

  it('mcp-session-hello first-adopt (no prior UUID) does NOT clear server stagedEdits (Fix 1 TDD-a)', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status

    const cache = _getStagedEditsForTesting()!
    cache.append(makeEdit({ intentId: 'keep-me', property: 'color' }))
    expect(cache.size()).toBe(1)

    // First mcp-session-hello — must not touch the cache (no hello ever clears).
    const UUID_A = '11111111-0000-4000-a000-000000000001'
    ws.send(JSON.stringify({ type: 'mcp-session-hello', sessionId: UUID_A, token: sessionToken }))

    // Wait for the hello to be forwarded to the browser (proves handler ran), then
    // assert the cache is still intact — first adopt must NOT wipe existing intents.
    await vi.waitFor(() => {
      expect(server._sent.some((s) => (s.data as any).type === 'mcp-session-hello')).toBe(true)
    })
    expect(cache.size()).toBe(1)
  })

  it('mcp-session-hello same-UUID reconnect does NOT clear server stagedEdits (Fix 1 TDD-b)', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status

    const cache = _getStagedEditsForTesting()!
    const UUID_A = '11111111-0000-4000-a000-000000000002'

    // First hello — adopt UUID (no clear expected on first adopt).
    ws.send(JSON.stringify({ type: 'mcp-session-hello', sessionId: UUID_A, token: sessionToken }))
    await vi.waitFor(() => {
      // Wait until the first hello has been processed by confirming it was
      // forwarded to the browser channel.
      const hellos = server._sent.filter((s) => (s.data as any).type === 'mcp-session-hello')
      expect(hellos.length).toBeGreaterThanOrEqual(1)
    })

    // Seed edit AFTER first hello — it must survive the same-UUID second hello.
    cache.append(makeEdit({ intentId: 'keep-me-b', property: 'font-size' }))
    expect(cache.size()).toBe(1)

    // Second hello — same UUID (transient WiFi-flap / sleep-wake reconnect). Must NOT clear.
    ws.send(JSON.stringify({ type: 'mcp-session-hello', sessionId: UUID_A, token: sessionToken }))

    await vi.waitFor(() => {
      const hellos = server._sent.filter((s) => (s.data as any).type === 'mcp-session-hello')
      expect(hellos.length).toBeGreaterThanOrEqual(2)
    })
    expect(cache.size()).toBe(1)
  })

  it('mcp-session-hello different-UUID does NOT clear server stagedEdits (0.3.1 — Claude restart must not destroy staged work)', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status

    const cache = _getStagedEditsForTesting()!
    const UUID_A = '11111111-0000-4000-a000-000000000003'
    const UUID_B = '22222222-0000-4000-a000-000000000003'

    // First hello — adopt.
    ws.send(JSON.stringify({ type: 'mcp-session-hello', sessionId: UUID_A, token: sessionToken }))
    await vi.waitFor(() => {
      expect(server._sent.some((s) => (s.data as any).type === 'mcp-session-hello')).toBe(true)
    })

    // Designer stages an edit, then Claude Code restarts (fresh mcp process →
    // fresh UUID). The staged work must SURVIVE.
    cache.append(makeEdit({ intentId: 'survives-restart', property: 'color' }))
    expect(cache.size()).toBe(1)

    // Second hello — DIFFERENT UUID (the restart). Key the wait on the second
    // forwarded hello (proves the handler ran), then assert survival.
    ws.send(JSON.stringify({ type: 'mcp-session-hello', sessionId: UUID_B, token: sessionToken }))
    await vi.waitFor(() => {
      const hellos = server._sent.filter((s) => (s.data as any).type === 'mcp-session-hello')
      expect(hellos.length).toBeGreaterThanOrEqual(2)
    })
    expect(cache.size()).toBe(1)
    expect(cache.list()[0]!.intentId).toBe('survives-restart')
  })

  it('interleaved hellos from two concurrent Claude clients (A,B,A) leave stagedEdits intact (0.3.1)', async () => {
    // Two Claude Code windows on one project = two mcp processes with distinct
    // UUIDs, alternating hellos on reconnects. Under the old UUID-change wipe,
    // EVERY alternation cleared the cache — merely opening a second Claude
    // window destroyed staged work.
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status

    const cache = _getStagedEditsForTesting()!
    const UUID_A = '11111111-0000-4000-a000-000000000004'
    const UUID_B = '22222222-0000-4000-a000-000000000004'

    cache.append(makeEdit({ intentId: 'two-client-survivor', property: 'padding-top' }))

    for (const uuid of [UUID_A, UUID_B, UUID_A]) {
      ws.send(JSON.stringify({ type: 'mcp-session-hello', sessionId: uuid, token: sessionToken }))
    }
    await vi.waitFor(() => {
      const hellos = server._sent.filter((s) => (s.data as any).type === 'mcp-session-hello')
      expect(hellos.length).toBeGreaterThanOrEqual(3)
    })
    expect(cache.size()).toBe(1)
    expect(cache.list()[0]!.intentId).toBe('two-client-survivor')
  })

  it('warns when no httpServer (middleware mode)', () => {
    const plugin = initPlugin()
    const server = mockServer()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    ;(plugin.configureServer as Function)(server)

    expect(warnSpy).toHaveBeenCalledWith(
      '[cortex] No httpServer — running in middleware mode. CLI connections unavailable.'
    )
    warnSpy.mockRestore()
  })

  // ─── Pillar 1: cortex/set-active from MCP (Task 5) ──────────────────────────

  it('activates editor when MCP sends cortex/set-active true (Pillar 1)', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status

    ws.send(JSON.stringify({ type: 'cortex/set-active', active: true, token: sessionToken }))
    await new Promise((r) => setTimeout(r, 50))

    const state = _getActiveStateForTesting()
    expect(state!.editorActive).toBe(true)
    expect(state!.activeBrowserId).toBe(null) // CLI has no tabId
    // cortex/active-changed broadcast (no targetTabId for CLI path)
    const broadcast = server._sent.find((e) => (e.data as any).type === 'cortex/active-changed')
    expect(broadcast).toBeDefined()
    expect((broadcast!.data as any).active).toBe(true)
    expect((broadcast!.data as any).targetTabId).toBeUndefined()
  })

  it('deactivates editor when MCP sends cortex/set-active false (Pillar 1)', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status

    ws.send(JSON.stringify({ type: 'cortex/set-active', active: true, token: sessionToken }))
    await new Promise((r) => setTimeout(r, 50))
    server._sent.length = 0

    ws.send(JSON.stringify({ type: 'cortex/set-active', active: false, token: sessionToken }))
    await new Promise((r) => setTimeout(r, 50))

    expect(_getActiveStateForTesting()!.editorActive).toBe(false)
    const broadcast = server._sent.find((e) => (e.data as any).type === 'cortex/active-changed')
    expect(broadcast).toBeDefined()
    expect((broadcast!.data as any).active).toBe(false)
  })

  it('legacy cortex / cortex-close from MCP still update activeState (dual-mode, Pillar 1)', async () => {
    await setupServer()
    const cliConn = await connectCLI()
    await cliConn.nextMessage() // drain cortex-status
    await cliConn.nextMessage() // drain agent-status

    cliConn.ws.send(JSON.stringify({ type: 'cortex', token: sessionToken }))
    await new Promise((r) => setTimeout(r, 50))
    expect(_getActiveStateForTesting()!.editorActive).toBe(true)

    cliConn.ws.send(JSON.stringify({ type: 'cortex-close', token: sessionToken }))
    await new Promise((r) => setTimeout(r, 50))
    expect(_getActiveStateForTesting()!.editorActive).toBe(false)
  })

  it('rejects cortex/set-active without a token — activeState unchanged (auth gate, Pillar 1)', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status

    ws.send(JSON.stringify({ type: 'cortex/set-active', active: true }))
    const response = await nextMessage()

    expect(response.type).toBe('error')
    expect(response.code).toBe('AUTH_FAILED')
    expect(_getActiveStateForTesting()!.editorActive).toBe(false)
    const broadcast = server._sent.find((e) => (e.data as any).type === 'cortex/active-changed')
    expect(broadcast).toBeUndefined()
  })
})

describe('annotation RPC', () => {
  let httpServer: HttpServer
  let serverPort: number
  let tmpDir: string
  let sessionToken: string
  const openClients: WebSocket[] = []

  function readToken(): string {
    return fs.readFileSync(pathMod.join(tmpDir, '.cortex', 'token'), 'utf8').trim()
  }

  function mockServerWithHttp(http: HttpServer) {
    const handlers = new Map<string, Function>()
    const offHandlers = new Map<string, Function>()
    const sent: { event: string; data: unknown }[] = []
    return {
      middlewares: { use: vi.fn() },
      httpServer: http,
      hot: {
        on(event: string, handler: Function) { handlers.set(event, handler) },
        off(event: string, handler: Function) { offHandlers.set(event, handler) },
        send(event: string, data: unknown) { sent.push({ event, data }) },
        _trigger(event: string, data: unknown) { handlers.get(event)?.(data) },
      },
      _handlers: handlers,
      _offHandlers: offHandlers,
      _sent: sent,
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cortex-rpc-test-'))
  })

  async function setupServer() {
    const plugin = initPlugin({ root: tmpDir })
    httpServer = createServer()
    const server = mockServerWithHttp(httpServer)
    ;(plugin.configureServer as Function)(server)

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = httpServer.address()
    serverPort = (addr as any).port
    sessionToken = readToken()

    return { plugin, server }
  }

  type CLIConnection = { ws: WebSocket; nextMessage: () => Promise<any> }

  async function connectCLI(): Promise<CLIConnection> {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/@cortex/ws`)

    const queue: any[] = []
    const waiters: ((msg: any) => void)[] = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      const waiter = waiters.shift()
      if (waiter) waiter(msg)
      else queue.push(msg)
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    openClients.push(ws)

    return {
      ws,
      nextMessage(): Promise<any> {
        const buffered = queue.shift()
        if (buffered !== undefined) return Promise.resolve(buffered)
        return new Promise((resolve) => waiters.push(resolve))
      },
    }
  }

  afterEach(async () => {
    for (const ws of openClients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate()
      }
    }
    openClients.length = 0
    await _resetForTesting()
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('getPending returns empty list initially', async () => {
    await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status (connected: true)

    ws.send(JSON.stringify({
      type: 'cortex-rpc',
      requestId: 'r1',
      method: 'getPending',
      params: {},
      token: sessionToken,
    }))
    const reply = await nextMessage()
    expect(reply.type).toBe('cortex-rpc-result')
    expect(reply.requestId).toBe('r1')
    expect(reply.result).toEqual([])
  })

  it('comment message creates annotation, getPending returns it', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status

    // Browser sends a comment via HMR
    server.hot._trigger('cortex:msg', {
      type: 'comment',
      token: sessionToken,
      elementSource: 'src/App.tsx:5:3',
      text: 'Make this blue',
    })

    // Drain the forwarded messages (comment + annotation-created + activity-entry come via CLI echo)
    // We need to consume any messages that arrive before our RPC response
    await new Promise((r) => setTimeout(r, 50))

    ws.send(JSON.stringify({
      type: 'cortex-rpc',
      requestId: 'r2',
      method: 'getPending',
      params: {},
      token: sessionToken,
    }))

    // Read messages until we get the RPC result
    let reply: any
    for (let i = 0; i < 20; i++) {
      reply = await nextMessage()
      if (reply.type === 'cortex-rpc-result' && reply.requestId === 'r2') break
    }

    expect(reply.type).toBe('cortex-rpc-result')
    expect(reply.requestId).toBe('r2')
    expect(reply.result).toHaveLength(1)
    expect(reply.result[0].text).toBe('Make this blue')
    expect(reply.result[0].elementSource).toBe('src/App.tsx:5:3')
    expect(reply.result[0].status).toBe('pending')
  })

  it('acknowledge RPC changes status and sends annotation-updated to browser', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status

    // Create an annotation via browser comment
    server.hot._trigger('cortex:msg', {
      type: 'comment',
      token: sessionToken,
      elementSource: 'src/App.tsx:10:5',
      text: 'Fix spacing',
    })

    // Wait for processing
    await new Promise((r) => setTimeout(r, 50))

    // Get the annotation ID via getPending
    ws.send(JSON.stringify({
      type: 'cortex-rpc',
      requestId: 'get1',
      method: 'getPending',
      params: {},
      token: sessionToken,
    }))

    let getReply: any
    for (let i = 0; i < 20; i++) {
      getReply = await nextMessage()
      if (getReply.type === 'cortex-rpc-result' && getReply.requestId === 'get1') break
    }
    const annotationId = getReply.result[0].id

    // Acknowledge it
    ws.send(JSON.stringify({
      type: 'cortex-rpc',
      requestId: 'ack1',
      method: 'acknowledge',
      params: { annotationId },
      token: sessionToken,
    }))

    let ackReply: any
    for (let i = 0; i < 20; i++) {
      ackReply = await nextMessage()
      if (ackReply.type === 'cortex-rpc-result' && ackReply.requestId === 'ack1') break
    }

    expect(ackReply.result.status).toBe('acknowledged')
    expect(ackReply.result.id).toBe(annotationId)

    // Verify browser received annotation-updated via HMR
    const annotationUpdated = server._sent.find(
      (s) => (s.data as any).type === 'annotation-updated' && (s.data as any).annotation?.status === 'acknowledged'
    )
    expect(annotationUpdated).toBeDefined()
    expect((annotationUpdated!.data as any).annotation.id).toBe(annotationId)
  })

  it('unknown RPC method returns error', async () => {
    await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status (connected: true)

    ws.send(JSON.stringify({
      type: 'cortex-rpc',
      requestId: 'bad1',
      method: 'deleteEverything',
      params: {},
      token: sessionToken,
    }))
    const reply = await nextMessage()
    expect(reply.type).toBe('cortex-rpc-error')
    expect(reply.requestId).toBe('bad1')
    expect(reply.error).toContain('Unknown RPC method')
  })

  // ── PR #94 F1: method-specific param validation ──────────────────────────
  it('applyEdits with malformed intentIds (mixed types) returns SCHEMA_VIOLATION, not silent coercion', async () => {
    // Before F1 fix: params.intentIds=[123, null, 'foo'] would silently filter to ['foo']
    // and proceed. After F1 fix: method-specific schema rejects the array element
    // types and returns a SCHEMA_VIOLATION error envelope (no requestId) in prod mode.
    // In test mode (VITEST=true) parseOrFail throws, which vite.ts catches and
    // re-sends as cortex-rpc-error to the CLI.
    await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status (connected: true)

    ws.send(JSON.stringify({
      type: 'cortex-rpc',
      requestId: 'f1-test',
      method: 'applyEdits',
      params: { intentIds: [123, null, 'foo'] }, // mixed types — should be rejected
      token: sessionToken,
    }))

    // Collect next message — in test mode parseOrFail throws and vite.ts surfaces
    // cortex-rpc-error; in prod parseOrFail returns null and vite.ts sends
    // { type: 'error', code: 'SCHEMA_VIOLATION' }.
    const reply = await nextMessage()
    const isSchemaViolation =
      (reply.type === 'error' && reply.code === 'SCHEMA_VIOLATION') ||
      reply.type === 'cortex-rpc-error'
    expect(isSchemaViolation).toBe(true)
  })

  // ── ZF0-1869 Task 8: reportSourceEditFailed RPC ──────────────────────────
  it('reportSourceEditFailed keeps intent in cache and broadcasts source-edit-failed to browser', async () => {
    // TDD anchor for Task 8/18 (Change 7). STATE-MACHINE INVARIANT: the source edit
    // FAILED — the intent did NOT land — so it MUST stay in the buffer for retry/discard.
    // This is the OPPOSITE of acknowledgeSourceEdit (which removes on success).
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status (connected: true)

    // Simulate a browser connecting so browserConnected=true and browserNotified is honest.
    server.hot._trigger('cortex:msg', { type: 'init', token: sessionToken })

    // Seed one intent directly into the server-side cache.
    const cache = _getStagedEditsForTesting()!
    cache.append(makeEdit({ intentId: 'i1', property: 'color', value: 'red' }))
    expect(cache.list()).toHaveLength(1)

    // Clear sent messages so we can isolate reportSourceEditFailed's broadcast.
    server._sent.length = 0

    ws.send(JSON.stringify({
      type: 'cortex-rpc',
      requestId: 'fail-src-1',
      method: 'reportSourceEditFailed',
      params: { intentIds: ['i1'], reason: "couldn't find pattern at App.tsx:31" },
      token: sessionToken,
    }))

    // Wait for the cortex-rpc-result response.
    let rpcReply: any
    for (let i = 0; i < 20; i++) {
      rpcReply = await nextMessage()
      if (rpcReply.type === 'cortex-rpc-result' && rpcReply.requestId === 'fail-src-1') break
    }

    // (a) result shape
    expect(rpcReply.result.reported).toEqual(['i1'])
    expect(rpcReply.result.browserNotified).toBe(true)

    // (b) STATE-MACHINE INVARIANT: i1 MUST remain in the cache (source edit failed)
    expect(cache.getById('i1')).toBeDefined()

    // (c) browser channel received source-edit-failed (NOT staged-edits-discard)
    const failMsg = server._sent.find(
      (s) => s.event === 'cortex:msg' && (s.data as Record<string, unknown>).type === 'source-edit-failed',
    )
    expect(failMsg).toBeDefined()
    expect((failMsg!.data as Record<string, unknown>).intentIds).toEqual(['i1'])
    expect((failMsg!.data as Record<string, unknown>).reason).toBe("couldn't find pattern at App.tsx:31")
  })

  // ── ZF0-1869 Task 6: acknowledgeSourceEdit RPC ───────────────────────────
  it('acknowledgeSourceEdit removes intent from cache and broadcasts staged-edits-discard to browser', async () => {
    // TDD anchor for Task 6/18 (Change 7). Wire effect is identical to discardEdits —
    // remove from server cache + broadcast staged-edits-discard. The distinct method
    // name carries the apply-acked vs user-discarded distinction at the MCP tool layer.
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    await nextMessage() // drain agent-status (connected: true)

    // Simulate a browser connecting so browserConnected=true and browserNotified is honest.
    server.hot._trigger('cortex:msg', { type: 'init', token: sessionToken })

    // Seed two intents directly into the server-side cache.
    const cache = _getStagedEditsForTesting()!
    cache.append(makeEdit({ intentId: 'i1', property: 'color', value: 'red' }))
    cache.append(makeEdit({ intentId: 'i2', property: 'fontSize', value: '16px' }))
    expect(cache.list()).toHaveLength(2)

    // Clear sent messages so we can isolate acknowledgeSourceEdit's broadcast.
    server._sent.length = 0

    ws.send(JSON.stringify({
      type: 'cortex-rpc',
      requestId: 'ack-src-1',
      method: 'acknowledgeSourceEdit',
      params: { intentIds: ['i1'] },
      token: sessionToken,
    }))

    // Wait for the cortex-rpc-result response.
    let rpcReply: any
    for (let i = 0; i < 20; i++) {
      rpcReply = await nextMessage()
      if (rpcReply.type === 'cortex-rpc-result' && rpcReply.requestId === 'ack-src-1') break
    }

    // (a) result shape
    expect(rpcReply.result.acknowledged).toEqual(['i1'])
    expect(rpcReply.result.browserNotified).toBe(true)

    // (b) i1 removed, i2 still present
    expect(cache.getById('i1')).toBeNull()
    expect(cache.getById('i2')).not.toBeNull()

    // (c) browser channel received staged-edits-discard
    const discard = server._sent.find(
      (s) => s.event === 'cortex:msg' && (s.data as Record<string, unknown>).type === 'staged-edits-discard',
    )
    expect(discard).toBeDefined()
    expect((discard!.data as Record<string, unknown>).intentIds).toEqual(['i1'])
  })

  it('comment-reply appends to existing annotation thread', async () => {
    const { server } = await setupServer()
    const { ws, nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status

    // Create an annotation via browser comment
    server.hot._trigger('cortex:msg', {
      type: 'comment',
      token: sessionToken,
      elementSource: 'src/App.tsx:5:3',
      text: 'Make this blue',
    })
    await new Promise((r) => setTimeout(r, 50))

    // Get the annotation ID via getPending
    ws.send(JSON.stringify({
      type: 'cortex-rpc',
      requestId: 'get1',
      method: 'getPending',
      params: {},
      token: sessionToken,
    }))
    let getReply: any
    for (let i = 0; i < 20; i++) {
      getReply = await nextMessage()
      if (getReply.type === 'cortex-rpc-result' && getReply.requestId === 'get1') break
    }
    const annotationId = getReply.result[0].id

    // Clear sent messages to isolate comment-reply effects
    server._sent.length = 0

    // Browser sends a comment-reply via HMR
    server.hot._trigger('cortex:msg', {
      type: 'comment-reply',
      token: sessionToken,
      annotationId,
      text: 'What shade of blue?',
    })
    await new Promise((r) => setTimeout(r, 50))

    // Verify browser received annotation-updated (not annotation-created)
    const updated = server._sent.find(
      (s) => (s.data as any).type === 'annotation-updated'
    )
    expect(updated).toBeDefined()
    expect((updated!.data as any).annotation.id).toBe(annotationId)
    expect((updated!.data as any).annotation.thread).toHaveLength(1)
    expect((updated!.data as any).annotation.thread[0].from).toBe('user')
    expect((updated!.data as any).annotation.thread[0].text).toBe('What shade of blue?')

    // Verify no annotation-created was sent (reply should NOT create a new annotation)
    const created = server._sent.find(
      (s) => (s.data as any).type === 'annotation-created'
    )
    expect(created).toBeUndefined()

    // Verify activity log entry was sent
    const activityEntry = server._sent.find(
      (s) => (s.data as any).type === 'activity-entry'
    )
    expect(activityEntry).toBeDefined()
    expect((activityEntry!.data as any).entry.type).toBe('comment')
  })

  it('comment-reply to nonexistent annotation is silently ignored', async () => {
    const { server } = await setupServer()
    await connectCLI()

    server._sent.length = 0

    // Send reply to a nonexistent annotation
    server.hot._trigger('cortex:msg', {
      type: 'comment-reply',
      token: sessionToken,
      annotationId: 'nonexistent-id',
      text: 'This should be ignored',
    })
    await new Promise((r) => setTimeout(r, 50))

    // No annotation-updated or annotation-created should be sent
    const annotationMsg = server._sent.find(
      (s) => (s.data as any).type === 'annotation-updated' || (s.data as any).type === 'annotation-created'
    )
    expect(annotationMsg).toBeUndefined()
  })

  it('agent-status sent on CLI connect', async () => {
    const { server } = await setupServer()
    const { nextMessage } = await connectCLI()
    await nextMessage() // drain cortex-status
    // The CLI also receives the agent-status echoed via forwardToCLI
    const agentMsg = await nextMessage()
    expect(agentMsg.type).toBe('agent-status')
    expect(agentMsg.connected).toBe(true)

    // Also verify browser received it via HMR
    const allAgentStatus = server._sent.filter((s) => (s.data as any).type === 'agent-status')
    expect(allAgentStatus.length).toBeGreaterThan(0)
    const connectStatus = allAgentStatus.find((s) => (s.data as any).connected === true)
    expect(connectStatus).toBeDefined()
  })

  it('agent-status sent on CLI disconnect', async () => {
    const { server } = await setupServer()
    const { ws } = await connectCLI()

    // Clear previous sent messages
    server._sent.length = 0

    ws.close()
    await new Promise<void>((resolve) => ws.on('close', resolve))

    // Wait for close handler to fire
    await new Promise((r) => setTimeout(r, 50))

    const agentStatus = server._sent.find((s) => (s.data as any).type === 'agent-status')
    expect(agentStatus).toBeDefined()
    expect((agentStatus!.data as any).connected).toBe(false)
  })

  it('ws.send() throwing during RPC success response does not crash the server', async () => {
    // Intercept ws.send on the server side: throw when sending any RPC response
    // for requestId "crash1". This simulates a WebSocket closing mid-send.
    // Without the fix, ws.send in the success path throws, the outer catch fires,
    // and ws.send in the catch also throws — an unhandled exception that crashes the server.
    const origSend = WebSocket.prototype.send
    WebSocket.prototype.send = function(this: WebSocket, data: any, ...args: any[]) {
      if (typeof data === 'string' && data.includes('"crash1"') && (data.includes('"cortex-rpc-result"') || data.includes('"cortex-rpc-error"'))) {
        throw new Error('WebSocket is not open')
      }
      return origSend.call(this, data, ...args)
    } as any

    try {
      await setupServer()
      const { ws, nextMessage } = await connectCLI()
      await nextMessage() // drain cortex-status
      await nextMessage() // drain agent-status

      ws.send(JSON.stringify({
        type: 'cortex-rpc',
        requestId: 'crash1',
        method: 'getPending',
        params: {},
        token: sessionToken,
      }))

      // Wait for the server to process the message
      await new Promise((r) => setTimeout(r, 100))

      // Restore send before verifying server is alive
      WebSocket.prototype.send = origSend

      // Verify the server is still alive by connecting a new client and performing an RPC
      const client2 = await connectCLI()
      await client2.nextMessage() // drain cortex-status
      await client2.nextMessage() // drain agent-status

      client2.ws.send(JSON.stringify({
        type: 'cortex-rpc',
        requestId: 'alive1',
        method: 'getPending',
        params: {},
        token: sessionToken,
      }))
      const reply = await client2.nextMessage()
      expect(reply.type).toBe('cortex-rpc-result')
      expect(reply.requestId).toBe('alive1')
    } finally {
      WebSocket.prototype.send = origSend
    }
  })

  it('ws.send() throwing during RPC error response logs console.warn', async () => {
    // Make handleAnnotationRPC throw by sabotaging AnnotationStore.prototype.getPending
    const getPendingSpy = vi.spyOn(AnnotationStore.prototype, 'getPending')
      .mockImplementation(() => { throw new Error('store exploded') })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Intercept ws.send on the server side: throw when sending cortex-rpc-error
    const origSend = WebSocket.prototype.send
    WebSocket.prototype.send = function(this: WebSocket, data: any, ...args: any[]) {
      if (typeof data === 'string' && data.includes('"cortex-rpc-error"')) {
        throw new Error('WebSocket is not open')
      }
      return origSend.call(this, data, ...args)
    } as any

    try {
      await setupServer()
      const { ws, nextMessage } = await connectCLI()
      await nextMessage() // drain cortex-status
      await nextMessage() // drain agent-status

      // Send the RPC — handleAnnotationRPC will throw ('store exploded'),
      // then the catch block's ws.send() will throw because we intercepted it.
      ws.send(JSON.stringify({
        type: 'cortex-rpc',
        requestId: 'crash2',
        method: 'getPending',
        params: {},
        token: sessionToken,
      }))

      // Wait for the server to process the message
      await new Promise((r) => setTimeout(r, 100))

      // Verify console.warn was called with the expected message
      expect(warnSpy).toHaveBeenCalledWith(
        '[cortex] Failed to send RPC error to CLI client:',
        expect.anything(),
      )
    } finally {
      WebSocket.prototype.send = origSend
      getPendingSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})

describe('port file', () => {
  let httpServer: HttpServer
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cortex-port-test-'))
  })

  afterEach(async () => {
    await _resetForTesting()
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function setupPortFileServer() {
    const plugin = initPlugin({ root: tmpDir })
    httpServer = createServer()
    const handlers = new Map<string, Function>()
    const server = {
      middlewares: { use: vi.fn() },
      httpServer,
      hot: {
        on(event: string, handler: Function) { handlers.set(event, handler) },
        off: vi.fn(),
        send: vi.fn(),
        _trigger(event: string, data: unknown) { handlers.get(event)?.(data) },
      },
    }
    ;(plugin.configureServer as Function)(server)
    return server
  }

  it('writes .cortex/port on server start', async () => {
    setupPortFileServer()

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve())
    })

    const portFile = pathMod.join(tmpDir, '.cortex', 'port')
    const port = (httpServer.address() as any).port
    const content = fs.readFileSync(portFile, 'utf8')
    expect(content).toBe(String(port))
  })

  it('cleans up .cortex/port on session dispose', async () => {
    setupPortFileServer()

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve())
    })

    const portFile = pathMod.join(tmpDir, '.cortex', 'port')
    expect(fs.existsSync(portFile)).toBe(true)

    // Session dispose owns port file cleanup — channel dispose is slim
    await _resetForTesting()
    expect(fs.existsSync(portFile)).toBe(false)
  })
})

describe('validateToggleShortcut', () => {
  it('rejects XSS payload', async () => {
    const { validateToggleShortcut } = await import('../../src/adapters/vite.js')
    expect(() => validateToggleShortcut("'; alert(1);//")).toThrow(/Invalid toggleShortcut/)
  })

  it('rejects </script> payload', async () => {
    const { validateToggleShortcut } = await import('../../src/adapters/vite.js')
    expect(() => validateToggleShortcut("</script><script>alert(1)")).toThrow()
  })

  it('accepts valid shortcuts', async () => {
    const { validateToggleShortcut } = await import('../../src/adapters/vite.js')
    expect(validateToggleShortcut('$mod+Shift+Period')).toBe('$mod+Shift+Period')
    expect(validateToggleShortcut('$mod+Shift+KeyE')).toBe('$mod+Shift+KeyE')
    expect(validateToggleShortcut('$mod+KeyK')).toBe('$mod+KeyK')
  })
})

describe('CortexSession wiring (A2)', () => {
  describe('configureServer re-entry', () => {
    it('disposes old session when configureServer is called twice', async () => {
      const plugin = initPlugin()
      const server1 = mockServer()
      ;(plugin.configureServer as Function)(server1)

      // First session is active — channel exists
      const channel1 = getChannel()
      expect(channel1).toBeDefined()

      // Call configureServer again (simulates Vite restart)
      const server2 = mockServer()
      ;(plugin.configureServer as Function)(server2)

      // New channel exists and is different from the first
      const channel2 = getChannel()
      expect(channel2).toBeDefined()
      expect(channel2).not.toBe(channel1)
    })

    it('does not accumulate signal handlers on re-entry', () => {
      const plugin = initPlugin()
      const server1 = mockServer()
      ;(plugin.configureServer as Function)(server1)

      const listenerCount1 = process.listenerCount('SIGINT')

      // Call again — should remove old handlers first
      const server2 = mockServer()
      ;(plugin.configureServer as Function)(server2)

      const listenerCount2 = process.listenerCount('SIGINT')
      // Should have same count (old removed, new added)
      expect(listenerCount2).toBe(listenerCount1)
    })

    it('does not accumulate httpServer listening listeners on re-entry before listen', () => {
      const plugin = initPlugin()
      const httpServer = createServer()
      try {
        const listenerCountBefore = httpServer.listenerCount('listening')
        const server1 = mockServerWithHttp(httpServer)
        ;(plugin.configureServer as Function)(server1)
        expect(httpServer.listenerCount('listening')).toBe(listenerCountBefore + 1)

        const server2 = mockServerWithHttp(httpServer)
        ;(plugin.configureServer as Function)(server2)

        expect(httpServer.listenerCount('listening')).toBe(listenerCountBefore + 1)
      } finally {
        httpServer.close()
      }
    })
  })

  describe('signal handler registration', () => {
    it('registers SIGINT and SIGTERM handlers after configureServer', () => {
      const sigintBefore = process.listenerCount('SIGINT')
      const sigtermBefore = process.listenerCount('SIGTERM')

      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1)
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1)
    })
  })

  describe('_resetForTesting', () => {
    it('disposes session and clears signal handlers', async () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      const sigintBefore = process.listenerCount('SIGINT')

      await _resetForTesting()

      // Signal handlers removed
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore - 1)

      // getChannel throws — session is null
      expect(() => getChannel()).toThrow('getChannel() called before the Vite dev server started')
    })

    it('is safe to call when no session exists', async () => {
      // Should not throw
      await _resetForTesting()
    })
  })

  describe('channel dispose is slim', () => {
    it('channel dispose does not clean up bridge resources — session owns those', async () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      const channel = getChannel()
      await channel.dispose()

      // After channel dispose, getChannel still returns the same object —
      // the session is NOT disposed, only the hot listener was detached.
      // Session fields remain intact (channel dispose didn't touch them).
      expect(getChannel()).toBe(channel)
    })
  })
})

// ---------------------------------------------------------------------------
// Regression tests (A4) — each must fail without the corresponding fix
// ---------------------------------------------------------------------------

describe('bug #5 regression: signal cleanup removes port + token files', () => {
  let httpServer: HttpServer
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cortex-signal-test-'))
  })

  afterEach(async () => {
    await _resetForTesting()
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('dispose cleans up both .cortex/port and .cortex/token files', async () => {
    const plugin = initPlugin({ root: tmpDir })
    httpServer = createServer()
    const handlers = new Map<string, Function>()
    const server = {
      middlewares: { use: vi.fn() },
      httpServer,
      hot: {
        on(event: string, handler: Function) { handlers.set(event, handler) },
        off: vi.fn(),
        send: vi.fn(),
        _trigger(event: string, data: unknown) { handlers.get(event)?.(data) },
      },
    }
    ;(plugin.configureServer as Function)(server)

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve())
    })

    const portFile = pathMod.join(tmpDir, '.cortex', 'port')
    const tokenFile = pathMod.join(tmpDir, '.cortex', 'token')

    // Both files must exist after server start
    expect(fs.existsSync(portFile)).toBe(true)
    expect(fs.existsSync(tokenFile)).toBe(true)

    // Token file must have restrictive permissions (0o600)
    const tokenStat = fs.statSync(tokenFile)
    expect(tokenStat.mode & 0o777).toBe(0o600)

    // Simulate signal handler path: _resetForTesting calls session.dispose()
    await _resetForTesting()

    // Both files must be cleaned up — this is bug #5's fix
    expect(fs.existsSync(portFile)).toBe(false)
    expect(fs.existsSync(tokenFile)).toBe(false)
  })
})

describe('bug #10 regression: configureServer re-entry produces fresh stores', () => {
  it('new session has different identity and rejects old credentials after re-entry', async () => {
    const plugin = initPlugin()
    const server1 = mockServer()
    ;(plugin.configureServer as Function)(server1)

    // Populate first session's state via browser messages
    const token1 = _getSessionTokenForTesting()!
    server1.hot._trigger('cortex:msg', { type: 'init' })

    // Wait for hello to capture session1's identity
    await vi.waitFor(() => {
      expect(server1._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
    })
    const hello1 = server1._sent.find((s) => (s.data as any).type === 'hello')!
    const sessionId1 = (hello1.data as any).sessionId

    // Send a comment to create an annotation in the first session
    server1.hot._trigger('cortex:msg', {
      type: 'comment',
      token: token1,
      text: 'stale annotation',
      elementSource: 'div.old',
    })

    // configureServer re-entry (simulates Vite restart)
    const server2 = mockServer()
    ;(plugin.configureServer as Function)(server2)

    // New session must have different token AND sessionId — proving a new
    // CortexSession instance was created (constructor generates fresh stores,
    // as verified by the session independence test in session.test.ts)
    const token2 = _getSessionTokenForTesting()!
    expect(token2).not.toBe(token1)

    // Trigger hello on new session to confirm fresh identity
    server2.hot._trigger('cortex:msg', { type: 'init' })
    await vi.waitFor(() => {
      expect(server2._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
    })
    const hello2 = server2._sent.find((s) => (s.data as any).type === 'hello')!
    const sessionId2 = (hello2.data as any).sessionId
    expect(sessionId2).not.toBe(sessionId1)

    // Old token is rejected by new session — auth isolation confirmed
    server2.hot._trigger('cortex:msg', {
      type: 'edit',
      token: token1,
      editId: 'stale-1',
      property: 'color',
      value: 'blue',
      source: 'div.stale',
      elementSelector: 'div.stale',
    })

    const authError = server2._sent.find((s) => (s.data as any).code === 'AUTH_FAILED')
    expect(authError).toBeDefined()
  })
})

describe('bug #19 regression: write messages without valid token are rejected', () => {
  describe('browser HMR path', () => {
    it('rejects edit message with wrong token', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      server.hot._trigger('cortex:msg', { type: 'init' })

      server.hot._trigger('cortex:msg', {
        type: 'edit',
        token: 'wrong-token-value',
        editId: 'bad-2',
        property: 'color',
        value: 'red',
        source: 'div',
        elementSelector: 'div',
      })

      const authError = server._sent.find((s) => (s.data as any).code === 'AUTH_FAILED')
      expect(authError).toBeDefined()
    })

    it('accepts edit message with correct token', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      const token = _getSessionTokenForTesting()!
      server.hot._trigger('cortex:msg', { type: 'init' })

      server.hot._trigger('cortex:msg', {
        type: 'edit',
        token,
        editId: 'good-1',
        property: 'color',
        value: 'red',
        source: 'div',
        elementSelector: 'div',
      })

      // No AUTH_FAILED error should be sent
      const authError = server._sent.find((s) => (s.data as any).code === 'AUTH_FAILED')
      expect(authError).toBeUndefined()
    })

    it('does not require token for non-write messages', () => {
      const plugin = initPlugin()
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)

      // init is not a WRITE_TYPE — should work without token
      server.hot._trigger('cortex:msg', { type: 'init' })

      // No AUTH_FAILED
      const authError = server._sent.find((s) => (s.data as any).code === 'AUTH_FAILED')
      expect(authError).toBeUndefined()
    })

    it.each(['edit', 'undo', 'redo', 'comment', 'comment-reply'] as const)(
      'rejects %s message without token',
      (writeType) => {
        const plugin = initPlugin()
        const server = mockServer()
        ;(plugin.configureServer as Function)(server)

        server.hot._trigger('cortex:msg', { type: 'init' })
        server.hot._trigger('cortex:msg', {
          type: writeType,
          editId: 'no-auth-1',
          property: 'color',
          value: 'red',
          source: 'div',
          elementSelector: 'div',
          text: 'test',
          elementSource: 'div',
          annotationId: 'ann-1',
        })

        const authError = server._sent.find((s) => (s.data as any).code === 'AUTH_FAILED')
        expect(authError).toBeDefined()
      },
    )
  })
})

describe('bug #20 regression: per-tab sessionId scoping', () => {
  it('hello response includes a sessionId', async () => {
    const plugin = initPlugin()
    const server = mockServer()
    ;(plugin.configureServer as Function)(server)

    server.hot._trigger('cortex:msg', { type: 'init' })

    await vi.waitFor(() => {
      expect(server._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
    })

    const hello = server._sent.find((s) => (s.data as any).type === 'hello')!
    const sessionId = (hello.data as any).sessionId
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)
  })

  it('transformIndexHtml injects sessionId into window global', () => {
    const plugin = initPlugin()
    const server = mockServer()
    ;(plugin.configureServer as Function)(server)

    const html = '<html><head></head><body></body></html>'
    const hook = plugin.transformIndexHtml as { order: string; handler: (html: string) => string }
    const result = hook.handler(html)

    expect(result).toContain('window.__CORTEX_SESSION_ID__=')
  })

  it('sessionId in hello matches sessionId in transformIndexHtml', async () => {
    const plugin = initPlugin()
    const server = mockServer()
    ;(plugin.configureServer as Function)(server)

    // Get sessionId from hello
    server.hot._trigger('cortex:msg', { type: 'init' })
    await vi.waitFor(() => {
      expect(server._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
    })
    const hello = server._sent.find((s) => (s.data as any).type === 'hello')!
    const helloSessionId = (hello.data as any).sessionId

    // Get sessionId from HTML injection
    const html = '<html><head></head><body></body></html>'
    const hook = plugin.transformIndexHtml as { order: string; handler: (html: string) => string }
    const result = hook.handler(html)

    // Extract the injected sessionId value from the script tag
    const match = result.match(/window\.__CORTEX_SESSION_ID__="([^"]+)"/)
    expect(match).not.toBeNull()
    const htmlSessionId = match![1]

    expect(htmlSessionId).toBe(helloSessionId)
  })

  it('configureServer re-entry produces a different sessionId', async () => {
    const plugin = initPlugin()

    // First session
    const server1 = mockServer()
    ;(plugin.configureServer as Function)(server1)
    server1.hot._trigger('cortex:msg', { type: 'init' })
    await vi.waitFor(() => {
      expect(server1._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
    })
    const hello1 = server1._sent.find((s) => (s.data as any).type === 'hello')!
    const sessionId1 = (hello1.data as any).sessionId

    // Re-entry — new session
    const server2 = mockServer()
    ;(plugin.configureServer as Function)(server2)
    server2.hot._trigger('cortex:msg', { type: 'init' })
    await vi.waitFor(() => {
      expect(server2._sent.find((s) => (s.data as any).type === 'hello')).toBeDefined()
    })
    const hello2 = server2._sent.find((s) => (s.data as any).type === 'hello')!
    const sessionId2 = (hello2.data as any).sessionId

    // Different sessions must have different sessionIds
    expect(sessionId2).not.toBe(sessionId1)
  })
})

// ─── shouldSuppressHmr (policy function) ─────────────────────────────────
//
// The write pipeline's HMR decision collapses to this pure function. Each
// case below asserts the specific policy branch that runs, so a regression
// that changes which branch fires fails the test rather than coincidentally
// still passing.
describe('shouldSuppressHmr', () => {
  it('honors explicit allowHmr:false regardless of kind', () => {
    expect(shouldSuppressHmr({ kind: 'jsx-immediate', allowHmr: false })).toBe(true)
    expect(shouldSuppressHmr({ kind: 'deferred', allowHmr: false })).toBe(true)
    expect(shouldSuppressHmr({ kind: 'immediate', allowHmr: false })).toBe(true)
  })

  it('honors explicit allowHmr:true regardless of kind (ZF0-1215 classOp contract)', () => {
    // classOp writes set kind:'immediate' but force allowHmr:true because
    // className mutations have no browser-side override. If this contract
    // regresses the Panel's bundle detection goes stale and pills accumulate.
    expect(shouldSuppressHmr({ kind: 'immediate', allowHmr: true })).toBe(false)
    expect(shouldSuppressHmr({ kind: 'undo', allowHmr: true })).toBe(false)
    expect(shouldSuppressHmr({ kind: 'redo', allowHmr: true })).toBe(false)
  })

  it('defaults to suppress for kinds that paint via browser-side override', () => {
    // The !important override already shows the correct value; HMR would
    // only cause a repaint flash.
    expect(shouldSuppressHmr({ kind: 'immediate' })).toBe(true)
    expect(shouldSuppressHmr({ kind: 'undo' })).toBe(true)
    expect(shouldSuppressHmr({ kind: 'redo' })).toBe(true)
  })

  it('defaults to NOT suppress for kinds that may restructure JSX', () => {
    // jsx-immediate / deferred may rewrite the source beyond a single inline
    // property — React must re-render to reflect the new source.
    expect(shouldSuppressHmr({ kind: 'jsx-immediate' })).toBe(false)
    expect(shouldSuppressHmr({ kind: 'deferred' })).toBe(false)
  })
})

// ─── performEditWrite (orchestration) ────────────────────────────────────
//
// The writeFile closure inside configureServer collapses to this helper.
// These tests exercise the exact side-effect contract that the ZF0-1215
// diagnostic fix relies on: atomic write + synthesized chokidar `change`
// event when HMR is not suppressed, nothing extra when it is suppressed.
//
// C1 addendum (Round 1 review): three additional invariants tested below —
//   (1) the timer entry lands AFTER the write succeeds (not before)
//   (2) rapid same-path writes refresh the single timer (no stacking)
//   (3) a failed write leaves the timers map untouched
describe('performEditWrite', () => {
  type Timers = Map<string, ReturnType<typeof setTimeout>>
  const emptyTimers = (): Timers => new Map()

  it('synthesizes a chokidar change event when HMR is not suppressed (ZF0-1215 Tailwind regen)', async () => {
    const emit = vi.fn()
    const write = vi.fn<(p: string, c: string) => Promise<void>>().mockResolvedValue(undefined)
    const timers = emptyTimers()

    await performEditWrite(
      { kind: 'immediate', allowHmr: true, filePath: '/project/src/App.tsx', content: 'new-source' },
      { server: { watcher: { emit } }, recentEditWriteTimers: timers, write },
    )

    expect(write).toHaveBeenCalledWith('/project/src/App.tsx', 'new-source')
    // Precise event shape — Vite's internal 'change' listener is what drives
    // moduleGraph invalidation + Tailwind re-scan.
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('change', '/project/src/App.tsx')
    // NOT suppressed ⇒ not tracked in recentEditWriteTimers (HMR will fire
    // and handleHotUpdate should let it through).
    expect(timers.has('/project/src/App.tsx')).toBe(false)
  })

  // Copilot review finding (ZF0-1215 Step 12, PR #71): a prior suppressed
  // write's TTL timer would be left in recentEditWriteTimers, causing a
  // subsequent non-suppressed write on the same path (within TTL) to be
  // treated as suppressed in handleHotUpdate → HMR silently dropped.
  // The fix clears any existing timer before emitting the non-suppressed
  // change event so a kind transition (suppressed → non-suppressed) on
  // the same file honors the new intent.
  it('clears stale suppression timer when a non-suppressed write follows a suppressed one on the same path', async () => {
    const emit = vi.fn()
    const write = vi.fn<(p: string, c: string) => Promise<void>>().mockResolvedValue(undefined)
    const timers = emptyTimers()

    // First: suppressed write leaves a timer for this path.
    await performEditWrite(
      { kind: 'immediate', filePath: '/project/src/styles.css', content: 'first' },
      { server: { watcher: { emit } }, recentEditWriteTimers: timers, write },
    )
    expect(timers.has('/project/src/styles.css')).toBe(true)

    // Second: non-suppressed write on the same path within the TTL window.
    // Without the fix: the stale timer would block handleHotUpdate from
    // forwarding this write's HMR. Regression guard: the timer must be
    // cleared BEFORE emit fires, so handleHotUpdate sees the path as
    // fresh and lets the 'change' event through.
    await performEditWrite(
      { kind: 'immediate', allowHmr: true, filePath: '/project/src/styles.css', content: 'second' },
      { server: { watcher: { emit } }, recentEditWriteTimers: timers, write },
    )
    expect(emit).toHaveBeenCalledWith('change', '/project/src/styles.css')
    expect(timers.has('/project/src/styles.css')).toBe(false)
  })

  it('does NOT emit a change event when HMR is suppressed', async () => {
    const emit = vi.fn()
    const write = vi.fn<(p: string, c: string) => Promise<void>>().mockResolvedValue(undefined)
    const timers = emptyTimers()

    await performEditWrite(
      { kind: 'immediate', filePath: '/project/src/styles.css', content: 'new-css' },
      { server: { watcher: { emit } }, recentEditWriteTimers: timers, write },
    )

    expect(write).toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    // Suppressed ⇒ tracked so handleHotUpdate filters this event.
    expect(timers.has('/project/src/styles.css')).toBe(true)
  })

  it('emits change for jsx-immediate kind even without explicit allowHmr (default policy)', async () => {
    const emit = vi.fn()
    const write = vi.fn<(p: string, c: string) => Promise<void>>().mockResolvedValue(undefined)

    await performEditWrite(
      { kind: 'jsx-immediate', filePath: '/p.tsx', content: 'x' },
      { server: { watcher: { emit } }, recentEditWriteTimers: emptyTimers(), write },
    )

    expect(emit).toHaveBeenCalledWith('change', '/p.tsx')
  })

  it('emits change for deferred kind even without explicit allowHmr', async () => {
    const emit = vi.fn()
    const write = vi.fn<(p: string, c: string) => Promise<void>>().mockResolvedValue(undefined)

    await performEditWrite(
      { kind: 'deferred', filePath: '/p.tsx', content: 'x' },
      { server: { watcher: { emit } }, recentEditWriteTimers: emptyTimers(), write },
    )

    expect(emit).toHaveBeenCalledWith('change', '/p.tsx')
  })

  it('propagates write errors without emitting a change event (failure must not leak HMR)', async () => {
    const emit = vi.fn()
    const failure = new Error('ENOSPC: disk full')
    const write = vi.fn<(p: string, c: string) => Promise<void>>().mockRejectedValue(failure)

    await expect(
      performEditWrite(
        { kind: 'immediate', allowHmr: true, filePath: '/p.tsx', content: 'x' },
        { server: { watcher: { emit } }, recentEditWriteTimers: emptyTimers(), write },
      ),
    ).rejects.toThrow('ENOSPC: disk full')

    // Critical: when the write fails, no partial HMR state leaks to the
    // browser. The user's source file is unchanged on disk (atomicWrite
    // guarantees); firing 'change' here would kick Vite into re-compiling
    // an unchanged file and potentially racing a rollback.
    expect(emit).not.toHaveBeenCalled()
  })

  // C1 addendum: a write that fails must NOT leave the path in the
  // suppression map. Old code added-then-awaited, so a rejection left
  // the path suppressed for 500ms while no write had actually landed —
  // the user's editor's own save would be filtered from HMR during that
  // window. New code adds AFTER await: a rejection never reaches the map.
  it('does NOT insert into recentEditWriteTimers when a suppressed write rejects (C1 ordering)', async () => {
    const emit = vi.fn()
    const write = vi.fn<(p: string, c: string) => Promise<void>>().mockRejectedValue(new Error('EACCES'))
    const timers = emptyTimers()

    await expect(
      performEditWrite(
        { kind: 'immediate', filePath: '/locked.tsx', content: 'x' },
        { server: { watcher: { emit } }, recentEditWriteTimers: timers, write },
      ),
    ).rejects.toThrow('EACCES')

    expect(timers.has('/locked.tsx')).toBe(false)
    expect(timers.size).toBe(0)
  })

  // C1 addendum: two rapid writes to the same path should REFRESH the
  // single timer, not stack independent ones. With stacked timers the
  // first would fire mid-window and evict the entry even though the
  // second write's TTL hadn't elapsed — leaking HMR flicker between
  // timers. The refresh pattern (clearTimeout + setTimeout) makes TTL
  // always measured from the most recent write.
  it('refreshes a single timer entry on rapid consecutive writes to the same path (C1 no stacking)', async () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn()
      const write = vi.fn<(p: string, c: string) => Promise<void>>().mockResolvedValue(undefined)
      const timers = emptyTimers()

      await performEditWrite(
        { kind: 'immediate', filePath: '/f.css', content: 'a' },
        { server: { watcher: { emit } }, recentEditWriteTimers: timers, write },
      )
      expect(timers.size).toBe(1)
      const firstTimer = timers.get('/f.css')
      expect(firstTimer).toBeDefined()

      // Second write arrives 300ms later — well within the 500ms window.
      vi.advanceTimersByTime(300)
      await performEditWrite(
        { kind: 'immediate', filePath: '/f.css', content: 'b' },
        { server: { watcher: { emit } }, recentEditWriteTimers: timers, write },
      )

      // Only ONE entry for this path, and the timer identity changed
      // (the old one was cleared, a new one armed).
      expect(timers.size).toBe(1)
      const secondTimer = timers.get('/f.css')
      expect(secondTimer).toBeDefined()
      expect(secondTimer).not.toBe(firstTimer)

      // Advance past the original 500ms mark. If timers had stacked,
      // the old timer would now fire and evict the entry. With refresh
      // semantics, the NEW timer's 500ms window restarted at t=300 and
      // doesn't expire until t=800.
      vi.advanceTimersByTime(300) // total = 600ms, old TTL expired, new still live
      expect(timers.has('/f.css')).toBe(true)

      // Advance past the new timer's expiry (t=800).
      vi.advanceTimersByTime(300) // total = 900ms, new TTL also expired
      expect(timers.has('/f.css')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-clears recentEditWriteTimers entry after the 500ms TTL when suppressed', async () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn()
      const write = vi.fn<(p: string, c: string) => Promise<void>>().mockResolvedValue(undefined)
      const timers = emptyTimers()

      await performEditWrite(
        { kind: 'immediate', filePath: '/q.css', content: 'x' },
        { server: { watcher: { emit } }, recentEditWriteTimers: timers, write },
      )

      expect(timers.has('/q.css')).toBe(true)
      vi.advanceTimersByTime(500)
      expect(timers.has('/q.css')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tolerates null recentEditWriteTimers (no active session) without crashing', async () => {
    const emit = vi.fn()
    const write = vi.fn<(p: string, c: string) => Promise<void>>().mockResolvedValue(undefined)

    await expect(
      performEditWrite(
        { kind: 'immediate', filePath: '/p.css', content: 'x' },
        { server: { watcher: { emit } }, recentEditWriteTimers: null, write },
      ),
    ).resolves.toBeUndefined()
  })
})

// ── staged-edits-acked protocol tests (ZF0-1469 T3) ────────────────────

describe('staged-edits-ready ack protocol', () => {
  it('vite emits staged-edits-acked to browser after successful CLI forward', () => {
    const plugin = initPlugin()
    const server = mockServer()
    ;(plugin.configureServer as Function)(server)
    const token = _getSessionTokenForTesting()!

    // Register a CLI client that successfully receives.
    const cliReceived: string[] = []
    const fakeClient = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => { cliReceived.push(data) },
      terminate: () => {},
    }
    _addCLIClientForTesting(fakeClient)

    server.hot._trigger('cortex:msg', {
      type: 'staged-edits-ready',
      count: 3,
      requestId: 'req-ack-test-001',
      token,
    })

    // CLI client must have received the forwarded message.
    expect(cliReceived).toHaveLength(1)
    const forwarded = JSON.parse(cliReceived[0]!) as Record<string, unknown>
    expect(forwarded.type).toBe('staged-edits-ready')

    // Browser must have received the ack.
    const ackMsg = server._sent.find(
      (e) => e.event === 'cortex:msg' && (e.data as Record<string, unknown>).type === 'staged-edits-acked',
    )
    expect(ackMsg).toBeDefined()
    expect((ackMsg!.data as Record<string, unknown>).requestId).toBe('req-ack-test-001')
  })

  it('vite does NOT ack browser when CLI forward fails (no CLI clients)', () => {
    const plugin = initPlugin()
    const server = mockServer()
    ;(plugin.configureServer as Function)(server)
    const token = _getSessionTokenForTesting()!

    // No CLI client added — forwardToCLI returns false.

    server.hot._trigger('cortex:msg', {
      type: 'staged-edits-ready',
      count: 2,
      requestId: 'req-no-ack-test-002',
      token,
    })

    // Assert ZERO ack messages sent to browser — specific check, not just "no error".
    const ackMessages = server._sent.filter(
      (e) => e.event === 'cortex:msg' && (e.data as Record<string, unknown>).type === 'staged-edits-acked',
    )
    expect(ackMessages).toHaveLength(0)
  })
})

// ── ZF0-1500: schema validation at vite.ts trust boundaries ─────────────────

describe('ZF0-1500: hotHandler schema validation (Boundary 1)', () => {
  function setupServer() {
    const plugin = initPlugin({ root: '/project' })
    const server = mockServer()
    ;(plugin.configureServer as Function)(server)
    const token = _getSessionTokenForTesting()!
    return { server, token }
  }

  it('rejects a malformed staged-edit-add (missing intentId) with SchemaViolationError in test mode', () => {
    const { server, token } = setupServer()
    expect(() => {
      server.hot._trigger('cortex:msg', { type: 'staged-edit-add', edit: { property: 'color' }, token })
    }).toThrow(SchemaViolationError)
    expect(_getStagedEditsForTesting()!.list()).toEqual([])
  })

  it('rejects a malformed comment message (missing elementSource) with SchemaViolationError in test mode', () => {
    const { server, token } = setupServer()
    expect(() => {
      server.hot._trigger('cortex:msg', { type: 'comment', text: 'hello', token })
    }).toThrow(SchemaViolationError)
  })

  it('rejects a completely unknown message type with SchemaViolationError in test mode', () => {
    const { server } = setupServer()
    expect(() => {
      server.hot._trigger('cortex:msg', { type: 'not-a-real-type', foo: 'bar' })
    }).toThrow(SchemaViolationError)
  })

  it('passes valid staged-edit-add without throwing', () => {
    const { server, token } = setupServer()
    const validEdit = makeEdit({ intentId: 'schema-test', property: 'color', value: 'red' })
    expect(() => {
      server.hot._trigger('cortex:msg', { type: 'staged-edit-add', edit: validEdit, token })
    }).not.toThrow()
    expect(_getStagedEditsForTesting()!.list()).toHaveLength(1)
  })
})

describe('ZF0-1500: channel.send outbound validation (Boundary 3)', () => {
  it('throws SchemaViolationError in test mode when channel.send receives a drift message', () => {
    const plugin = initPlugin({ root: '/project' })
    const server = mockServer()
    ;(plugin.configureServer as Function)(server)
    const channel = getChannel()!
    // Send a structurally invalid outbound message (unknown type)
    expect(() => {
      channel.send({ type: 'not-a-server-type' } as never)
    }).toThrow(SchemaViolationError)
  })

  it('sends valid messages without throwing', () => {
    const plugin = initPlugin({ root: '/project' })
    const server = mockServer()
    ;(plugin.configureServer as Function)(server)
    const channel = getChannel()!
    expect(() => {
      channel.send({ type: 'agent-status', connected: false })
    }).not.toThrow()
    const sent = server._sent.find((e) => e.event === 'cortex:msg' && (e.data as Record<string, unknown>).type === 'agent-status')
    expect(sent).toBeDefined()
  })

  it('PROD MODE: warns AND still emits the message when channel.send sees a drift message', () => {
    // Pin the documented prod-mode contract from validateAndSend in vite.ts:
    // "in prod: warns and STILL sends — never silently drop a message to the user session."
    // Without this test, a regression that silently swallows drift messages in prod would
    // ship undetected (test mode throws, hiding the failure mode).
    vi.stubEnv('CORTEX_TEST_BUILD', 'false')
    vi.stubEnv('VITEST', '')
    vi.stubEnv('NODE_ENV', 'production')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const plugin = initPlugin({ root: '/project' })
      const server = mockServer()
      ;(plugin.configureServer as Function)(server)
      const channel = getChannel()!

      // Drift message: invalid outbound type. In prod mode parseOrFail returns null
      // (no throw), and validateAndSend then proceeds to server.hot.send anyway.
      expect(() => {
        channel.send({ type: 'not-a-server-type' } as never)
      }).not.toThrow()

      // Assert console.warn was called with the schema-violation context.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('schema violation at vite.channel.send'),
        expect.anything(),
      )

      // Assert the message was STILL emitted to server.hot despite the violation.
      const sent = server._sent.find(
        (e) => e.event === 'cortex:msg' && (e.data as Record<string, unknown>).type === 'not-a-server-type',
      )
      expect(sent).toBeDefined()
    } finally {
      warnSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})

describe('ZF0-1500: hot-path performance — browserToServerSchema', () => {
  // ZF0-1566 sibling-branch audit: same wall-clock perf-test class as
  // source-transform.test.ts:535. Under V8 coverage instrumentation, 10k
  // schema parses with hooked branches can exceed the 2000ms CI ceiling —
  // measurement reflects coverage overhead, not real Zod hot-path cost.
  // Skip under coverage; the non-coverage `npm test` invocation still
  // gates against real regressions. See `tests/COVERAGE.md` for the
  // canonical detection contract and the sibling-audit rationale.
  it.skipIf(process.env.VITEST_COVERAGE === '1')('schema parse on hot path is fast (≤500ms local / ≤2000ms CI for 10k iterations)', () => {
    const payload = {
      type: 'staged-edit-add' as const,
      edit: makeEdit({ intentId: 'perf-test', property: 'color', value: 'red' }),
      token: 'test-token',
    }
    let successCount = 0
    const start = performance.now()
    for (let i = 0; i < 10000; i++) {
      const r = browserToServerSchema.safeParse(payload)
      if (r.success) successCount++
    }
    const elapsed = performance.now() - start
    // CI runners are slower; use a relaxed bound to avoid flakes.
    const maxMs = process.env['CI'] ? 2000 : 500
    expect(elapsed).toBeLessThan(maxMs)
    // Functional assertion: all 10k iterations must parse successfully.
    expect(successCount).toBe(10000)
  })
})

// ── ZF0-1500 review: graceful staged-edits-sync (IMPORTANT 1) ──────────────

describe('ZF0-1500 review: staged-edits-sync graceful per-element filtering', () => {
  it('drops only invalid entries from a mixed batch, keeps valid ones, warns on drops', () => {
    const plugin = initPlugin()
    const server = mockServer()
    ;(plugin.configureServer as Function)(server)
    const token = _getSessionTokenForTesting()!
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const validA = makeEdit({ intentId: 'valid-a', property: 'color', value: 'red' })
    const validB = makeEdit({ intentId: 'valid-b', property: 'fontSize', value: '14px' })
    const malformed = { property: 'broken' } // missing intentId, source, value, etc.

    expect(() => {
      server.hot._trigger('cortex:msg', {
        type: 'staged-edits-sync',
        edits: [validA, malformed, validB],
        token,
      })
    }).not.toThrow()

    const cache = _getStagedEditsForTesting()!
    const ids = cache.list().map((e) => e.intentId).sort()
    expect(ids).toEqual(['valid-a', 'valid-b'])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('staged-edits-sync filtered 1 invalid edits'),
    )
    warnSpy.mockRestore()
  })
})

// Note: the WRITE_TYPES_ARRAY / BROWSER_TO_CLI_FORWARD_TYPES_ARRAY schema-subset
// tests moved to tests/adapters/shared-server-constants.test.ts when those
// constants were extracted into the shared module (ZF0-1869 follow-up).

// ── ZF0-1500 review: intentId element bounds (MINOR 3) ─────────────────────

describe('ZF0-1500 review: intentIds elements are bounded by MAX_INTENT_ID_BYTES', () => {
  it('rejects a staged-edit-remove with a 257-char intentId (path points to array index)', () => {
    const oversize = 'x'.repeat(257)
    const result = browserToServerSchema.safeParse({
      type: 'staged-edit-remove',
      intentIds: ['ok', oversize],
      token: 't',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      // Path should include the array index for the offending entry.
      const issuePaths = result.error.issues.map((iss) => iss.path.join('.'))
      expect(issuePaths.some((p) => p.includes('intentIds.1'))).toBe(true)
    }
  })

  it('rejects a staged-edits-discard with a 257-char intentId', () => {
    const oversize = 'x'.repeat(257)
    const result = serverToBrowserSchema.safeParse({
      type: 'staged-edits-discard',
      intentIds: [oversize],
    })
    expect(result.success).toBe(false)
  })

  it('accepts a staged-edit-remove with an at-cap (256-char) intentId', () => {
    const atCap = 'x'.repeat(256)
    const result = browserToServerSchema.safeParse({
      type: 'staged-edit-remove',
      intentIds: [atCap],
      token: 't',
    })
    expect(result.success).toBe(true)
  })
})

// ── Pillar 1: cortex/set-active browser hotHandler (Task 4) ─────────────────

describe('hotHandler — cortex/set-active from browser (Pillar 1)', () => {
  // Helper: sets up a plugin + server and returns the token + the _sent array
  // for message assertions.
  function setupServer() {
    const plugin = initPlugin({ root: '/project' })
    const server = mockServer()
    ;(plugin.configureServer as Function)(server)
    const token = _getSessionTokenForTesting()!
    return { plugin, server, token }
  }

  it('first browser tab activation sets editorActive=true and activeBrowserId, broadcasts cortex/active-changed targeted to that tab', () => {
    const { server, token } = setupServer()

    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: true, tabId: 'tab-A', token })

    const state = _getActiveStateForTesting()
    expect(state).not.toBeNull()
    expect(state!.editorActive).toBe(true)
    expect(state!.activeBrowserId).toBe('tab-A')

    const broadcast = server._sent.find((e) => (e.data as any).type === 'cortex/active-changed')
    expect(broadcast).toBeDefined()
    expect((broadcast!.data as any).active).toBe(true)
    expect((broadcast!.data as any).targetTabId).toBe('tab-A')
  })

  it('second tab activation while first is active emits cortex/inactive-tab, preserves original state', () => {
    const { server, token } = setupServer()

    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: true, tabId: 'tab-A', token })
    server._sent.length = 0

    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: true, tabId: 'tab-B', token })

    const reject = server._sent.find((e) => (e.data as any).type === 'cortex/inactive-tab')
    expect(reject).toBeDefined()
    expect((reject!.data as any).targetTabId).toBe('tab-B')
    expect((reject!.data as any).message).toMatch(/another tab/i)

    const state = _getActiveStateForTesting()!
    expect(state.editorActive).toBe(true)
    expect(state.activeBrowserId).toBe('tab-A')
    // No cortex/active-changed sent
    const broadcast = server._sent.find((e) => (e.data as any).type === 'cortex/active-changed')
    expect(broadcast).toBeUndefined()
  })

  it('idempotent — second activation from same tab does not re-broadcast cortex/active-changed', () => {
    const { server, token } = setupServer()

    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: true, tabId: 'tab-A', token })
    server._sent.length = 0

    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: true, tabId: 'tab-A', token })

    const broadcast = server._sent.find((e) => (e.data as any).type === 'cortex/active-changed')
    expect(broadcast).toBeUndefined()
    expect(_getActiveStateForTesting()!.editorActive).toBe(true)
  })

  // Pillar 1 (ZF0-1881 codex P2.2): browser-originated activations (with
  // targetTabId) must NOT emit the untargeted legacy fan-out — CortexApp
  // dispatches legacy `cortex`/`cortex-close` without tabId filtering, so an
  // untargeted legacy broadcast would open/close the panel in EVERY tab and
  // bypass the single-tab gate the new shape correctly enforces.
  it('does NOT emit legacy cortex fan-out for browser-originated activation (single-tab gate)', () => {
    const { server, token } = setupServer()

    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: true, tabId: 'tab-A', token })

    const legacy = server._sent.find((e) => (e.data as any).type === 'cortex')
    expect(legacy).toBeUndefined()
  })

  it('does NOT emit legacy cortex-close fan-out for browser-originated deactivation', () => {
    const { server, token } = setupServer()

    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: true, tabId: 'tab-A', token })
    server._sent.length = 0

    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: false, tabId: 'tab-A', token })

    const legacy = server._sent.find((e) => (e.data as any).type === 'cortex-close')
    expect(legacy).toBeUndefined()
    expect(_getActiveStateForTesting()!.editorActive).toBe(false)
  })
})

// ── Pillar 1: injected client script — keyboard handler (Task 6) ─────────────

describe('vite injected client — Pillar 1 (keyboard handler emits cortex/set-active)', () => {
  it('no longer writes data-cortex-active imperatively', () => {
    const injected = _getInjectedClientScriptForTesting({ toggleShortcut: '$mod+Shift+Period' })
    expect(injected).not.toMatch(/setAttribute\(['"]data-cortex-active['"]/)
    expect(injected).not.toMatch(/removeAttribute\(['"]data-cortex-active['"]/)
  })

  it('emits cortex/set-active with a tab ID', () => {
    const injected = _getInjectedClientScriptForTesting({ toggleShortcut: '$mod+Shift+Period' })
    expect(injected).toMatch(/cortex\/set-active/)
    expect(injected).toMatch(/__cortex_tab_id__/)
  })

  it('reads current active state from __cortex_active_cache__ rather than the DOM attribute', () => {
    const injected = _getInjectedClientScriptForTesting({ toggleShortcut: '$mod+Shift+Period' })
    // The new handler reads __cortex_active_cache__.active for toggle state decision.
    expect(injected).toMatch(/__cortex_active_cache__/)
    expect(injected).not.toMatch(/hasAttribute\(['"]data-cortex-active['"]\)/)
  })

  it('preserves the __cortex_toggle_registered__ idempotency guard', () => {
    const injected = _getInjectedClientScriptForTesting({ toggleShortcut: '$mod+Shift+Period' })
    expect(injected).toMatch(/__cortex_toggle_registered__/)
  })

  it('preserves the XSS-hardening Object.defineProperty patterns for new Pillar 1 globals', () => {
    const injected = _getInjectedClientScriptForTesting({ toggleShortcut: '$mod+Shift+Period' })
    // tab ID, active cache, and toggle-registered should all use Object.defineProperty
    // with writable: false to prevent XSS-injected overrides.
    const defineCount = (injected.match(/Object\.defineProperty\(window/g) ?? []).length
    expect(defineCount).toBeGreaterThanOrEqual(3)
  })
})

// ── Pillar 1: active-tab takeover after fresh init (Task 7) ─────────────────

describe('vite — active-tab takeover after fresh init (Pillar 1 Task 7)', () => {
  function setupServer() {
    const plugin = initPlugin({ root: '/project' })
    const server = mockServer()
    ;(plugin.configureServer as Function)(server)
    const token = _getSessionTokenForTesting()!
    return { plugin, server, token }
  }

  it('clears activeBrowserId when a different tabId arrives in init, allowing fresh tab to activate', () => {
    const { server, token } = setupServer()

    // tab-A activates
    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: true, tabId: 'tab-A', token })
    expect(_getActiveStateForTesting()!.activeBrowserId).toBe('tab-A')

    // tab-A refreshes: sends init with a new tab ID (each new page load generates a fresh UUID)
    server.hot._trigger('cortex:msg', { type: 'init', tabId: 'tab-A2' })
    // Gate cleared; active state is now inactive
    expect(_getActiveStateForTesting()!.activeBrowserId).toBeNull()

    // Clear sent list then activate as tab-A2 — this should now succeed
    server._sent.length = 0
    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: true, tabId: 'tab-A2', token })
    expect(_getActiveStateForTesting()!.activeBrowserId).toBe('tab-A2')

    const broadcast = server._sent.find((e) => (e.data as any).type === 'cortex/active-changed')
    expect(broadcast).toBeDefined()
    expect((broadcast!.data as any).targetTabId).toBe('tab-A2')
  })

  it('init without tabId does not reset the active-tab gate (backward compat — old injected script)', () => {
    const { server, token } = setupServer()

    // tab-A activates
    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: true, tabId: 'tab-A', token })
    expect(_getActiveStateForTesting()!.activeBrowserId).toBe('tab-A')

    // Old browser (no tabId in init) — gate must remain intact
    server.hot._trigger('cortex:msg', { type: 'init' })
    expect(_getActiveStateForTesting()!.activeBrowserId).toBe('tab-A')
  })

  it('init with same tabId does not clear the gate (HMR re-mount from same tab)', () => {
    const { server, token } = setupServer()

    server.hot._trigger('cortex:msg', { type: 'cortex/set-active', active: true, tabId: 'tab-A', token })
    expect(_getActiveStateForTesting()!.activeBrowserId).toBe('tab-A')

    // Same tab sends init again (HMR re-mount) — gate stays intact
    server.hot._trigger('cortex:msg', { type: 'init', tabId: 'tab-A' })
    expect(_getActiveStateForTesting()!.activeBrowserId).toBe('tab-A')
  })
})


// ── Hook ordering + plugin-order audit (COR-28) ─────────────────────────────
//
// Plugin-level `enforce: 'pre'` is only a BUCKET. Within a bucket Vite preserves
// plain array order, so `plugins: [react(), cortexEditor()]` ran plugin-react
// first and handed cortex its already-rewritten output — every recorded line:col
// was then 19 lines off (COR-28). Hook-level `transform.order = 'pre'` is the
// stronger mechanism: Vite's getSortedPluginsByHook splices object-form hooks
// declaring 'pre' ahead of every function-form hook, whatever the array order.
describe('transform hook ordering (COR-28)', () => {
  it('declares transform as an OBJECT hook with order pre', () => {
    const plugin = cortexEditor()
    // Not a style preference. A function-form hook lands in Vite's `normal`
    // group and loses to array order; only the object form with an explicit
    // order can win regardless of where the user lists us.
    expect(typeof plugin.transform).toBe('object')
    expect((plugin.transform as { order?: string }).order).toBe('pre')
    expect(typeof (plugin.transform as { handler?: unknown }).handler).toBe('function')
  })

  it('still declares plugin-level enforce pre', () => {
    // Belt and braces: enforce puts us in the pre bucket, hook order sorts
    // within it. Losing either one reopens a different half of the bug.
    expect(cortexEditor().enforce).toBe('pre')
  })
})

describe('plugin-order audit (COR-28)', () => {
  function configWithPlugins(names: string[], command: 'serve' | 'build' = 'serve') {
    const plugins = names.map(name => ({ name, transform: () => null }))
    return {
      command,
      root: '/project',
      plugins,
      getSortedPlugins: () => plugins,
    } as unknown as Parameters<NonNullable<Plugin['configResolved']>>[0]
  }

  it('warns, naming the plugins that transform before cortex', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plugin = cortexEditor()
    ;(plugin.configResolved as Function)(configWithPlugins(['vite:react-babel', 'cortex-editor']))
    expect(warn).toHaveBeenCalled()
    const msg = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(msg).toContain('vite:react-babel')
    // Remediation must be followable. An earlier revision synthesised a call
    // expression from the plugin NAME and emitted `react-babel()` — a function
    // that does not exist. Plugin names are not factory names.
    expect(msg).not.toContain('react-babel()')
    expect(msg).toContain('move cortexEditor() earlier')
    warn.mockRestore()
  })

  it('stays silent when cortex already runs first', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plugin = cortexEditor()
    ;(plugin.configResolved as Function)(configWithPlugins(['cortex-editor', 'vite:react-babel']))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('stays silent during build (the transform is a no-op there)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plugin = cortexEditor()
    ;(plugin.configResolved as Function)(
      configWithPlugins(['vite:react-babel', 'cortex-editor'], 'build'),
    )
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reads the EFFECTIVE hook order, not the raw plugins array', () => {
    // Vite re-sorts per hook by transform.order, so the raw array is a different
    // order from what actually executes. Scanning the raw array both misses a
    // later-listed 'pre' plugin and falsely accuses an earlier-listed 'post' one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = [
      { name: 'cortex-editor', transform: () => null },
      { name: 'late-but-pre', transform: { order: 'pre', handler: () => null } },
    ]
    const sorted = [raw[1]!, raw[0]!] // what Vite actually runs
    const plugin = cortexEditor()
    ;(plugin.configResolved as Function)({
      command: 'serve',
      root: '/project',
      plugins: raw,
      getSortedPlugins: () => sorted,
    } as unknown as Parameters<NonNullable<Plugin['configResolved']>>[0])
    // Raw order says cortex is first and would stay silent; effective order says
    // otherwise. Reading the effective order is the whole point.
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('late-but-pre')
    warn.mockRestore()
  })

  it('never throws when getSortedPlugins is absent', () => {
    // An audit must not break a build on an older/newer Vite that lacks the API.
    const plugin = cortexEditor()
    expect(() => (plugin.configResolved as Function)({
      command: 'serve',
      root: '/project',
    } as unknown as Parameters<NonNullable<Plugin['configResolved']>>[0])).not.toThrow()
  })
})
