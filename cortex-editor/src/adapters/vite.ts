import type { Plugin, ResolvedConfig, HmrContext } from 'vite'
import type { SourceMapInput } from 'rollup'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer, WebSocket } from 'ws'
import { createSourceTransform } from './source-transform.js'
import { resolveAnnotationsFilePath } from './annotations-path-resolver.js'
import { createTelemetry, type Telemetry } from './telemetry.js'
import { resolveTelemetryEnabled, resolveTelemetryEndpoint } from './telemetry-config.js'
import { version as cortexVersion } from '../version.js'
import {
  ALLOWED_ORIGINS,
  CLI_ALLOWED_TYPES,
  BROWSER_TO_CLI_FORWARD_TYPES,
  WRITE_TYPES,
  HEARTBEAT_INTERVAL,
  MAX_CLI_CONNECTIONS,
  tokensEqual,
} from './shared-server-constants.js'
import type { ServerChannel, BrowserToServer, ServerToBrowser, Annotation } from './types.js'
import { TailwindResolver } from '../core/tailwind-resolver.js'
import { TailwindRewriter } from '../core/rewriter/tailwind.js'
import { InlineStyleRewriter } from '../core/rewriter/inline-style.js'
import { HMRVerifier } from '../core/hmr-verifier.js'
import { EditPipeline } from '../core/edit-pipeline.js'
import type { EditRequest, WriteIntent } from '../core/edit-pipeline.js'
import { StyleDetector } from '../core/rewriter/detector.js'
import type { DetectionResult } from '../core/rewriter/detector.js'
import { computeCapabilities } from '../core/capabilities.js'
import type { ResolverState } from '../core/capabilities.js'
import { CSSModulesRewriter } from '../core/rewriter/css-modules.js'
import { RuntimeCSSResolver } from '../core/rewriter/runtime-resolver.js'
import { UndoStack } from '../core/session/undo-stack.js'
import { CortexSession } from '../core/session.js'
import { LockHeldError } from '../core/cortex-lock.js'
import {
  evaluateSetActive,
  clearActiveBrowser,
  type SetActiveResult,
} from './cortex-active-state.js'
import { applyEditsCore, sliceIntentContext, checkIntentFileSize, parseIntentSource, agentResolveIntentContext } from '../core/staged-edits.js'
import { isPreviewSource } from '../shared/preview-source.js'
import type { StagedEditsCache } from '../core/staged-edits.js'
import { atomicWrite } from './atomic-write.js'
import {
  browserToServerSchema,
  serverToBrowserSchema,
  cliRpcRequestSchema,
  pendingEditSchema,
  parseOrFail,
  formatIssues,
  cortexApplyEditsInputSchema,
  cortexDiscardEditsInputSchema,
  cortexGetIntentContextInputSchema,
  cortexAcknowledgeSourceEditInputSchema,
  cortexReportSourceEditFailedInputSchema,
  cortexGetDetailsInputSchema,
  cortexAcknowledgeInputSchema,
  cortexResolveInputSchema,
  cortexDismissInputSchema,
  cortexRespondInputSchema,
} from '../schemas/index.js'

export interface CortexEditorOptions {
  /** Package names in node_modules to instrument (for library component detection). */
  includeNodeModules?: string[]
  /** Keyboard shortcut for toggling the editor. Uses KeyboardEvent.code values.
   *  Default: '$mod+Shift+Period' (Cmd+Shift+. on Mac, Ctrl+Shift+. on Windows/Linux).
   *  See https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code */
  toggleShortcut?: string
}

const CORTEX_CLIENT_PATH = '/@cortex/client.js'
const CORTEX_BROWSER_PATH = '/@cortex/browser.js'
const VIRTUAL_CORTEX_CLIENT = '\0cortex-client'
const CORTEX_MSG_EVENT = 'cortex:msg'

// CLI WebSocket bridge constants — shared with the Webpack adapter so the two
// dev-server bridges cannot drift on security/protocol invariants.
// See: ./shared-server-constants.ts

// Resolve browser IIFE path relative to this file (dist/vite/vite.js → dist/browser/index.js)
// CJS: __dirname is reliable. ESM: use import.meta.url.
function resolveBrowserIIFEPath(): string {
  if (typeof __dirname !== 'undefined') {
    return path.join(__dirname, '..', 'browser', 'index.js')
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browser', 'index.js')
}

const VALID_SHORTCUT = /^\$mod\+(?:Shift\+)?(?:Alt\+)?(?:Key[A-Z]|Digit\d|Period|Comma|Slash|Backslash|BracketLeft|BracketRight|Semicolon|Quote|Backquote|Minus|Equal)$/

export function validateToggleShortcut(shortcut: string): string {
  if (!VALID_SHORTCUT.test(shortcut)) {
    throw new Error(
      `[cortex] Invalid toggleShortcut: "${shortcut}". ` +
      `Expected format: "$mod+Shift+KeyCode" (e.g., "$mod+Shift+Period"). ` +
      `See https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code`
    )
  }
  return shortcut
}

/** Path-containment predicate — defense-in-depth for any code path that
 *  resolves a user-provided path against a project root. Returns true if
 *  `resolved` is `root` itself or a descendant of `root`, false otherwise.
 *
 *  The `+ path.sep` is load-bearing: it prevents `/Users/test/project-evil`
 *  from being mistaken for a child of `/Users/test/project`.
 *
 *  Used by the cortex_get_intent_context RPC handler. The fix-request
 *  elementSource validator (search "data.kind === 'fix-request'" in
 *  hotHandler) does NOT use this helper
 *  because it operates on `realpathSync`-resolved paths (symlink-aware), which
 *  is a related-but-distinct concern; consolidating the two would conflate the
 *  syntactic check with the symlink-aware check. Centralizing this predicate
 *  prevents shadow-copy drift between production code and tests per cortex's
 *  CLAUDE.md test rule #1. */
export function isPathInsideRoot(resolved: string, root: string): boolean {
  // Normalize root via path.resolve — idempotent, strips any trailing
  // separator, collapses `..` segments. Without this, a caller-supplied
  // root that ends with path.sep (e.g. `/project/`) would build the
  // comparison string `/project//` and return false for legitimate paths
  // like `/project/foo`. (Copilot review on PR #90.)
  const normalizedRoot = path.resolve(root)
  return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep)
}

/** Result variant for requireRealpathInsideRoot. Discriminated by `ok`. */
export type RealpathContainmentResult =
  | { ok: true; real: string; realRoot: string }
  | { ok: false; error: string }

/** Symlink-aware containment guard. Resolves both `resolved` and `root`
 *  through fs.realpathSync.native, then re-checks containment via
 *  isPathInsideRoot. Returns a structured ok/error result so callers can
 *  differentiate "stat failed" (symlink target gone) from "real path escapes
 *  the root" (security violation).
 *
 *  Shape choice: returns realRoot as well as real so callers that need to
 *  stat/read the resolved file use the same root-relative interpretation
 *  the predicate enforced. Centralizing this here lets the security
 *  regression test exercise the real symbol against a real on-disk symlink
 *  (no shadow copy in the test — same convention as isPathInsideRoot).
 *
 *  realpathSync.native errors carry an ENOENT/EACCES/etc. code; the result's
 *  error string includes the code so Claude can distinguish failure modes.
 *
 *  realpathFn is injectable for tests that don't want to touch the real fs;
 *  default uses fs.realpathSync.native. */
export function requireRealpathInsideRoot(
  resolved: string,
  root: string,
  realpathFn: (p: string) => string = fs.realpathSync.native,
): RealpathContainmentResult {
  let real: string
  let realRoot: string
  try {
    real = realpathFn(resolved)
    realRoot = realpathFn(root)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return { ok: false, error: `Could not resolve symlinks${code ? ` (${code})` : ''}` }
  }
  if (!isPathInsideRoot(real, realRoot)) {
    return { ok: false, error: 'Path outside project root (symlink-resolved)' }
  }
  return { ok: true, real, realRoot }
}

/** Escape JSON for safe embedding in <script> context. */
function safeJSONForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function getClientScript(options: { toggleShortcut: string }): string {
  const config = safeJSONForScript({ toggleShortcut: options.toggleShortcut })
  return `\
if (import.meta.hot) {
  import.meta.hot.on('${CORTEX_MSG_EVENT}', (data) => {
    window.__cortex_channel__?.handleServerMessage(data);
  });
  // Notify browser when HMR stylesheet update is applied — override clearing
  // must wait for this to avoid flash (hmr_verified arrives before HMR applies).
  // Include the changed file paths from the Vite update payload so the browser
  // can skip the (expensive) Panel refresh when the change is unrelated to
  // the currently selected element (ZF0-1292 follow-up).
  import.meta.hot.on('vite:afterUpdate', (update) => {
    var files;
    if (Array.isArray(update?.updates)) {
      files = update.updates.map((u) => u.path).filter((p) => typeof p === 'string');
    } else if (update != null) {
      // Vite schema drift: log ONCE so the first divergence leaves a
      // breadcrumb in devtools; without a guard, every subsequent HMR
      // cycle would spam the same warning.
      if (!window.__cortex_vite_shape_warned__) {
        window.__cortex_vite_shape_warned__ = true;
        console.warn('[cortex] unexpected vite:afterUpdate shape', update);
      }
      files = undefined;
    }
    window.__cortex_channel__?.handleServerMessage({ type: 'hmr-applied', files });
  });
  if (!Object.prototype.hasOwnProperty.call(window, '__cortex_send__')) {
    // configurable: true is load-bearing (ZF0-1326 Task 1).
    // The browser channel captures this primitive into closure scope and
    // then deletes it from window to close the XSS-via-dev-server RCE
    // vector. configurable: false would block the delete — keep this true.
    Object.defineProperty(window, '__cortex_send__', {
      value: (msg) => import.meta.hot.send('${CORTEX_MSG_EVENT}', msg),
      writable: false, configurable: true,
    });
  }
}
// Pillar 1: generate a stable per-tab ID at injection time (before any cortex
// script loads). Used by the single-tab gate and to filter cortex/active-changed
// broadcasts. Each new page load generates a fresh UUID so a refreshed tab gets
// a new ID and can take over from the stale one.
if (!window.__cortex_tab_id__) {
  Object.defineProperty(window, '__cortex_tab_id__', {
    value: 'tab-' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + '-' + Date.now()),
    writable: false, configurable: false,
  });
}
// Pillar 1: cache of the server's last cortex/active-changed for this tab —
// read by the keyboard handler to decide which state to flip to. Defined as a
// mutable wrapper object so the channel can write .active after setup without
// needing to redefine the property.
if (!Object.prototype.hasOwnProperty.call(window, '__cortex_active_cache__')) {
  Object.defineProperty(window, '__cortex_active_cache__', {
    value: { active: false }, writable: false, configurable: false,
  });
}
// Toggle shortcut — capture phase, always active. Pillar 1 rewrite: no DOM
// mutation here — the reducer's useEffect on active (CortexApp.tsx) is the
// SINGLE writer of data-cortex-active. Keyboard handler captures __cortex_send__
// into its OWN closure at injection time (before the channel's capture-and-delete
// XSS-hardening step), so subsequent keypresses still have a working send even
// after the channel deletes the window global. Falls back to a pending queue if
// __cortex_send__ wasn't available at injection time (e.g. legacy fallback path).
if (!Object.prototype.hasOwnProperty.call(window, '__cortex_toggle_registered__')) {
  Object.defineProperty(window, '__cortex_toggle_registered__', {
    value: true, writable: false, configurable: false,
  });
  var __cortexConfig = ${config};
  var __cortexParts = __cortexConfig.toggleShortcut.split('+');
  var __cortexCode = __cortexParts[__cortexParts.length - 1];
  var __cortexNeedShift = __cortexParts.includes('Shift');
  var __cortexNeedAlt = __cortexParts.includes('Alt');
  // Capture __cortex_send__ at injection time into closure scope. The channel
  // module captures-and-deletes the window global for XSS hardening; this
  // closure-capture keeps a working reference for the keyboard handler so
  // subsequent keypresses still reach the server post-bootstrap. ZF0-1881
  // codex P1.1 root cause — fix-forward after merge regression caught by E2E.
  var __cortexKeyboardSend = window.__cortex_send__;
  window.addEventListener('keydown', function(e) {
    if (!e.isTrusted) return;
    var mod = /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    if (__cortexNeedShift && !e.shiftKey) return;
    if (!__cortexNeedShift && e.shiftKey) return;
    if (__cortexNeedAlt && !e.altKey) return;
    if (!__cortexNeedAlt && e.altKey) return;
    if (e.code !== __cortexCode) return;
    e.preventDefault();
    e.stopPropagation();
    var nextActive = !window.__cortex_active_cache__.active;
    var msg = {
      type: 'cortex/set-active',
      active: nextActive,
      tabId: window.__cortex_tab_id__,
    };
    if (typeof __cortexKeyboardSend === 'function') {
      __cortexKeyboardSend(msg);
    } else if (typeof window.__cortex_send__ === 'function') {
      // Fallback: legacy non-HMR bootstrap path may not have set up the
      // closure-captured send. Use the window global if still present.
      window.__cortex_send__(msg);
    } else {
      // Channel not initialized yet (rare — only on the very first keypress
      // before HMR boot, which doesn't happen in practice). Queue for drain.
      window.__cortex_pending_set_active__ = msg;
    }
  }, { capture: true });
}
if (!document.querySelector('[data-cortex-host]')) {
  var __cortexScript = document.createElement('script');
  __cortexScript.src = '${CORTEX_BROWSER_PATH}';
  __cortexScript.onerror = function() { console.error('[cortex] Failed to load browser UI.'); };
  document.head.appendChild(__cortexScript);
}
`
}

/**
 * Expose the injected client script for testing only — lets the test suite
 * assert on the text of the script without going through Vite's virtual module
 * system. Do not import this in production code.
 * @internal
 */
export function _getInjectedClientScriptForTesting(options: { toggleShortcut: string }): string {
  return getClientScript(options)
}

let currentSession: CortexSession | null = null

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

    // Telemetry: record activation when the editor is turning ON.
    if (result.broadcast.active) {
      void session.telemetry?.recordActivation()
    }
  }

  if (result.reject) {
    session.channel?.send({
      type: 'cortex/inactive-tab',
      targetTabId: result.reject.targetTabId,
      message: 'Cortex is active in another tab — switch to it or close it first',
    })
  }
}

// ZF0-1851: set to true when configureServer refused to start because another
// cortex instance already owns this project's .cortex/. Distinct from
// `currentSession === null` (which is also the pre-configureServer state — tests
// exercise transforms in that state and expect injection). When this flag is
// true, the plugin is cleanly inert: no WS server, no /@cortex/* routes, and
// no transform injection (which would otherwise 404).
let cortexDisabledByLock = false

// Single shutdown handler registered on both SIGINT and SIGTERM, tracked for cleanup on re-entry
let shutdownHandler: (() => void) | null = null

// RPC dispatch — handles annotation methods (Phase 7) and staged-edit methods (ZF0-1452 T2).
// Renamed from handleAnnotationRPC → handleRPC as staged-edit methods are now co-located here.
// Option B chosen: single dispatcher, TypeScript compile-time safety catches stale call sites.
const ALLOWED_RPC_METHODS = new Set([
  // Annotation methods (Phase 7)
  'getActive', 'getPending', 'getDetails', 'acknowledge', 'resolve', 'dismiss', 'respond',
  // Staged-edit methods (ZF0-1452 T2)
  'getPendingEdits', 'applyEdits', 'discardEdits', 'getIntentContext', 'acknowledgeSourceEdit', 'reportSourceEditFailed',
])

// Method-specific param schemas. `null` means "method takes no params — skip validation".
// The outer envelope's `params: z.record(z.string(), z.unknown())` allows anything;
// these schemas enforce the actual per-method contract (F1 fix).
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
  // No-param methods — null means skip params validation
  getActive: null,
  getPending: null,
  getPendingEdits: null,
} as const

function handleRPC(method: string, params: Record<string, unknown>): unknown {
  // --- Annotation methods ---
  // params.annotationId is schema-validated as string upstream (via
  // RPC_METHOD_SCHEMAS) for any method that reads it; no-id methods ignore
  // the empty-string fallback.
  const id = params.annotationId as string | undefined ?? ''
  switch (method) {
    case 'getActive': return currentSession!.annotations.getActive()
    case 'getPending': return currentSession!.annotations.getPending()
    case 'getDetails': return currentSession!.annotations.getById(id)
    case 'acknowledge': {
      const result = currentSession!.annotations.acknowledge(id)
      if (result && currentSession!.channel) {
        // ZF0-1856: result is DeepReadonly<Annotation> (compile-time only).
        // The wire boundary is where that immutability view ends — the payload
        // is serialized, never mutated. Cast to the mutable wire shape here.
        currentSession!.channel.send({ type: 'annotation-updated', annotation: result as Annotation })
        const entry = currentSession!.activityLog.add({ type: 'status-change', description: `Acknowledged: ${result.text}`, elementSource: result.elementSource })
        currentSession!.channel.send({ type: 'activity-entry', entry })
      }
      return result
    }
    case 'resolve': {
      // params.summary is schema-validated as string before handleRPC is called.
      const summary = params.summary as string
      const result = currentSession!.annotations.resolve(id, summary)
      if (result && currentSession!.channel) {
        // ZF0-1856: result is DeepReadonly<Annotation> (compile-time only).
        // The wire boundary is where that immutability view ends — the payload
        // is serialized, never mutated. Cast to the mutable wire shape here.
        currentSession!.channel.send({ type: 'annotation-updated', annotation: result as Annotation })
        const entry = currentSession!.activityLog.add({ type: 'status-change', description: `Resolved: ${summary}`, elementSource: result.elementSource })
        currentSession!.channel.send({ type: 'activity-entry', entry })
      }
      return result
    }
    case 'dismiss': {
      // params.reason is schema-validated as string | undefined before handleRPC is called.
      const reason = params.reason as string | undefined
      const result = currentSession!.annotations.dismiss(id, reason)
      if (result && currentSession!.channel) {
        // ZF0-1856: result is DeepReadonly<Annotation> (compile-time only).
        // The wire boundary is where that immutability view ends — the payload
        // is serialized, never mutated. Cast to the mutable wire shape here.
        currentSession!.channel.send({ type: 'annotation-updated', annotation: result as Annotation })
        const entry = currentSession!.activityLog.add({ type: 'status-change', description: `Dismissed: ${result.text}`, elementSource: result.elementSource })
        currentSession!.channel.send({ type: 'activity-entry', entry })
      }
      return result
    }
    case 'respond': {
      // params.text is schema-validated as string before handleRPC is called.
      const text = params.text as string
      const result = currentSession!.annotations.addMessage(id, { from: 'agent', text })
      if (result && currentSession!.channel) {
        // ZF0-1856: result is DeepReadonly<Annotation> (compile-time only).
        // The wire boundary is where that immutability view ends — the payload
        // is serialized, never mutated. Cast to the mutable wire shape here.
        currentSession!.channel.send({ type: 'annotation-updated', annotation: result as Annotation })
      }
      return result
    }

    // --- Staged-edit methods (ZF0-1452 T2) ---

    case 'getPendingEdits': {
      // FUTURE: drift-recovery — could send a forced-resync request to the
      // browser here so it emits syncFullState(allEntries) right before
      // Claude reads, closing the silent-drift window between browser and
      // server cache. Honest scope of today's self-heal: an already-mounted
      // page that RECONNECTS does a clear-then-set (syncClear + syncFullState),
      // which authoritatively replaces the cache; mergeFullSync itself is
      // upsert-only and cannot delete ghosts, and a FRESH page load sends no
      // sync at all — so a closed page's cache lingers until dev-server
      // restart (tracked: browser-owned session-nonce follow-up).
      const intents = currentSession!.stagedEdits.list()
      return { intents, count: intents.length }
    }

    case 'applyEdits': {
      const intentIds = params.intentIds as string[]
      // Race-during-init guard: pipeline is constructed asynchronously after
      // detection + Tailwind config resolution complete. Mirror the pattern
      // at vite.ts:1077-1086 (data.type === 'edit' / 'undo' / 'redo' branches)
      // — friendly fallback per intent so Claude can surface a useful message
      // instead of a generic TypeError.
      if (!currentSession!.pipeline) {
        return {
          results: intentIds.map((intentId) => ({
            intentId,
            status: 'failed' as const,
            error: 'Editor is still initializing. Please try again.',
          })),
          browserNotified: true, // vacuous: nothing to notify, RPC shape symmetric with ready path
        }
      }
      // Capture session refs BEFORE await — currentSession can be replaced
      // or disposed during pipeline init/restart; deref'ing currentSession in
      // the .then continuation could throw or notify a different/new session
      // (Codex P2 finding from PR review).
      const stagedEdits = currentSession!.stagedEdits
      const pipeline = currentSession!.pipeline
      const channel = currentSession!.channel
      // Returns Promise<{results, browserNotified}> — handleRPC's caller awaits via Promise.resolve.
      return applyEditsCore(stagedEdits, intentIds, pipeline)
        .then(results => {
          // Browser-buffer sync: send `staged-edits-discard` for any intent
          // that was deterministically applied. Without this, the browser's
          // localStorage staging buffer still holds the intent; on next sync
          // it would re-add to the server cache, undoing the AC3 cache.remove.
          // Mirrors the discardEdits MCP tool's notification pattern at
          // vite.ts:436 — including the `browserNotified` flag in the response
          // so the MCP caller knows whether the browser saw the discard
          // (false → next full-sync reconciles, but Claude can warn the user).
          const appliedIds = results.filter((r) => r.status === 'applied').map((r) => r.intentId)
          let browserNotified = appliedIds.length === 0  // vacuously true: nothing to notify
          if (appliedIds.length > 0 && channel) {
            try {
              channel.send({ type: 'staged-edits-discard', intentIds: appliedIds })
              browserNotified = true
            } catch (err) {
              console.warn(
                '[cortex] Failed to send staged-edits-discard for applied intents:',
                err instanceof Error ? err.message : String(err),
              )
            }
          }
          return { results, browserNotified }
        })
    }

    case 'discardEdits': {
      // params.intentIds is schema-validated as string[] before handleRPC is called.
      const intentIds = params.intentIds as string[]

      currentSession!.stagedEdits.remove(intentIds)

      // Notify browser so its canonical buffer stays in sync with server cache.
      // Best-effort: if channel.send throws (transport closed) or the Panel
      // isn't mounted (HMR transient), the browser reconciles on its next
      // RECONNECT via the clear-then-set sync (syncClear + syncFullState —
      // authoritative replace; note mergeFullSync alone is upsert-only and a
      // fresh page load sends no sync).
      // FIX 4: browserNotified is now false when browserConnected is false —
      // server.hot.send is fire-and-forget; the channel existing is not evidence
      // that a browser actually received the message. browserConnected flips to
      // true only on a successful 'init' handshake from the browser.
      let browserNotified = false
      if (currentSession!.channel && currentSession!.browserConnected) {
        try {
          currentSession!.channel.send({ type: 'staged-edits-discard', intentIds })
          browserNotified = true
        } catch (err) {
          console.warn(
            '[cortex] Failed to send staged-edits-discard to browser:',
            err instanceof Error ? err.message : String(err),
          )
        }
      }
      return { discarded: intentIds, browserNotified }
    }

    case 'acknowledgeSourceEdit': {
      // params.intentIds is schema-validated as string[] before handleRPC is called.
      const intentIds = params.intentIds as string[]
      currentSession!.stagedEdits.remove(intentIds)
      // Same wire effect as discardEdits — broadcast to keep the browser canonical
      // buffer in sync. The apply-acked vs user-discarded distinction lives at the
      // MCP tool layer, not the channel layer.
      // FIX 4: gate on browserConnected (parity with discardEdits).
      let browserNotified = false
      if (currentSession!.channel && currentSession!.browserConnected) {
        try {
          currentSession!.channel.send({ type: 'staged-edits-discard', intentIds })
          browserNotified = true
        } catch (err) {
          console.warn(
            '[cortex] Failed to send staged-edits-discard (ack) to browser:',
            err instanceof Error ? err.message : String(err),
          )
        }
      }
      return { acknowledged: intentIds, browserNotified }
    }

    case 'reportSourceEditFailed': {
      const intentIds = params.intentIds as string[]
      const reason = params.reason as string
      // STATE-MACHINE INVARIANT: do NOT remove intents from the cache. The source
      // edit FAILED — the intent did not land. Keep it so the user can retry/discard.
      // FIX 4: gate on browserConnected (parity with discardEdits).
      let browserNotified = false
      if (currentSession!.channel && currentSession!.browserConnected) {
        try {
          currentSession!.channel.send({ type: 'source-edit-failed', intentIds, reason })
          browserNotified = true
        } catch (err) {
          console.warn('[cortex] Failed to send source-edit-failed to browser:', err instanceof Error ? err.message : String(err))
        }
      }
      return { reported: intentIds, browserNotified }
    }

    case 'getIntentContext': {
      // params.intentId is schema-validated as non-empty string before handleRPC is called.
      const intentId = params.intentId as string
      const intent = currentSession!.stagedEdits.getById(intentId)
      if (!intent) {
        return { error: 'intent not found' }
      }

      // Agent-resolve intents carry `cortex-preview:<id>`, a runtime DOM handle
      // with no file position, so there is nothing to slice. Answer with the
      // evidence instead of an error — COR-24: this branch was missing, so the
      // tool failed for 100% of agent-resolve intents, and since the schema
      // forces every structural intent onto that path, Claude's only
      // source-inspection tool was dead across the majority of the surface.
      // Shared with the webpack adapter so the two cannot drift.
      if (isPreviewSource(intent.source)) {
        return agentResolveIntentContext(intent)
      }

      // Parse + validate source format. parseIntentSource handles the colon-
      // split and rejects malformed line components (NaN/0/negative/decimal)
      // BEFORE any path resolution or fs access — extracted to core/staged-edits
      // so the regression test exercises the real symbol (Copilot review on PR #90).
      const parsed = parseIntentSource(intent.source)
      if (!parsed.ok) {
        return { error: parsed.error }
      }
      const { filePath, line } = parsed

      const projectRoot = currentSession!.config.root
      const resolvedPath = path.resolve(projectRoot, filePath)

      // Path containment — defense-in-depth against path-traversal injection in
      // intent.source. Without this, a `../../../etc/passwd:1:1` intent source
      // would escape the project root. Check BEFORE fs.readFileSync so an
      // out-of-bounds path is never read. The predicate is extracted to
      // isPathInsideRoot so its security regression test exercises the real
      // code path (no shadow copy in the test).
      if (!isPathInsideRoot(resolvedPath, projectRoot)) {
        return { error: 'Path outside project root' }
      }

      // Symlink-aware containment: resolvedPath is the syntactic resolution
      // only. fs.readFileSync follows symlinks transparently, so a
      // node_modules/.../leak symlink to /etc/passwd planted by a malicious
      // npm postinstall would pass the syntactic check above but read outside
      // the root. Mirror the realpathSync.native pattern from the
      // comment-fix-request elementSource validator (search "data.kind ===
      // 'fix-request'" in hotHandler). The predicate is extracted to
      // requireRealpathInsideRoot so its security regression test exercises
      // the real code path (no shadow copy in the test).
      const containment = requireRealpathInsideRoot(resolvedPath, projectRoot)
      if (!containment.ok) {
        return { error: containment.error.includes('outside') ? containment.error : `${containment.error} in: ${filePath}` }
      }
      const realPath = containment.real

      // Size cap — reject before reading so a 10MB+ generated file (lockfile,
      // asset bundle, db dump) under projectRoot can't stall the Vite event
      // loop via the synchronous read below. See MAX_INTENT_FILE_BYTES docstring.
      // Stat + read against realPath so the size check matches what
      // readFileSync will actually load (symlinks already resolved).
      let stats: fs.Stats
      try {
        stats = fs.statSync(realPath)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        return { error: `Could not stat file: ${filePath}${code ? ` (${code})` : ''}` }
      }
      // Size cap and slicing extracted to core/staged-edits.ts so contract is
      // unit-testable in isolation (no shadow copy in tests).
      const sizeCheck = checkIntentFileSize(filePath, stats.size)
      if (sizeCheck) return sizeCheck

      let fileContent: string
      try {
        fileContent = fs.readFileSync(realPath, 'utf8')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        return { error: `Could not read file: ${filePath}${code ? ` (${code})` : ''}` }
      }

      const slice = sliceIntentContext(fileContent, line)
      return {
        intentId,
        context: { before: slice.before, target: slice.target, after: slice.after },
        currentValue: slice.currentValue,
      }
    }

    default: throw new Error(`Unknown RPC method: ${method}`)
  }
}

/** Forward a message to all connected CLI WebSocket clients.
 *
 *  Returns true when at least one client successfully received the data,
 *  false in every failure case (no session, no clients, serialization error,
 *  or all client.send() calls threw / had non-OPEN readyState).
 *
 *  The boolean is used by the staged-edits-ready ack gate: the server
 *  emits 'staged-edits-acked' to the browser ONLY when this returns true.
 *  Returning false means the browser's sendAndAck() timeout will trip and
 *  surface retry UI — silent ack on failed forward is the failure mode this
 *  design prevents. */
function forwardToCLI(msg: unknown): boolean {
  if (!currentSession || currentSession.cliClients.size === 0) return false
  let data: string
  try {
    data = JSON.stringify(msg)
  } catch (err) {
    // Surface the failure instead of swallowing — T2 routes Apply-prompt
    // notifications (`staged-edits-ready`) through this path; a swallowed
    // serialization failure means Claude never receives the prompt and the
    // designer presses Apply with no feedback.
    const type = (msg as Record<string, unknown> | null)?.type ?? '<unknown>'
    console.error(
      `[cortex] forwardToCLI: JSON.stringify failed for type=${String(type)}:`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
  let delivered = false
  for (const client of currentSession.cliClients) {
    if (client.readyState !== WebSocket.OPEN) continue
    try {
      client.send(data)
      delivered = true
    } catch (err) {
      const type = (msg as Record<string, unknown> | null)?.type ?? '<unknown>'
      console.warn(
        `[cortex] forwardToCLI: client.send failed for type=${String(type)}, evicting client:`,
        err instanceof Error ? err.message : String(err),
      )
      currentSession.cliClients.delete(client)
    }
  }
  return delivered
}

export function getChannel(): ServerChannel {
  if (!currentSession?.channel) {
    throw new Error(
      'getChannel() called before the Vite dev server started. ' +
      'Ensure cortexEditor() is in your vite.config.ts plugins[] and you are running `vite dev`.'
    )
  }
  return currentSession.channel
}

export function onHMRUpdate(cb: (files: string[]) => void): () => void {
  if (!currentSession) throw new Error('onHMRUpdate() called before configureServer')
  const session = currentSession
  session.hmrCallbacks.push(cb)
  return () => {
    const idx = session.hmrCallbacks.indexOf(cb)
    if (idx >= 0) session.hmrCallbacks.splice(idx, 1)
  }
}

/**
 * Get the current session's token. Exposed for testing only.
 * @internal
 */
export function _getSessionTokenForTesting(): string | null {
  return currentSession?.token ?? null
}

/**
 * Get the current session's StagedEditsCache. Exposed for testing only —
 * lets the hotHandler integration tests in vite.test.ts assert that
 * staged-edit-* WS branches actually mutate the session cache.
 * @internal
 */
export function _getStagedEditsForTesting(): StagedEditsCache | null {
  return currentSession?.stagedEdits ?? null
}

/**
 * Get the current session's ActiveState. Exposed for testing only —
 * lets hotHandler integration tests in vite.test.ts assert that
 * cortex/set-active WS branches update the Pillar 1 state machine.
 * @internal
 */
export function _getActiveStateForTesting() {
  return currentSession?.activeState ?? null
}

/**
 * Add a fake CLI client to the current session. Exposed for testing only —
 * lets vite.test.ts verify forwardToCLI dispatch (e.g., for the
 * staged-edits-ready BROWSER_TO_CLI_FORWARD_TYPES allowlist test) without
 * setting up a real WebSocket server.
 * @internal
 */
export function _addCLIClientForTesting(client: { readyState: number; send: (data: string) => void; terminate: () => void }): void {
  if (!currentSession) return
  // Cast: real cliClients is Set<WebSocket>; the test fake satisfies the
  // structural shape used inside forwardToCLI (readyState + send).
  currentSession.cliClients.add(client as never)
}

/**
 * Reset module-level state. Exposed for testing only.
 * @internal
 */
export async function _resetForTesting(): Promise<void> {
  await currentSession?.dispose()
  currentSession = null
  if (shutdownHandler) {
    process.removeListener('SIGINT', shutdownHandler)
    process.removeListener('SIGTERM', shutdownHandler)
    shutdownHandler = null
  }
}

// ── Edit-write helpers (exported for direct unit testing) ───────────────

/** Minimal Vite server shape the edit-write path depends on. Narrowed from
 *  `ViteDevServer` so tests can pass a plain object with a `watcher.emit`
 *  spy without constructing the full server. */
export interface EditWriteServer {
  watcher: { emit: (event: string, path: string) => void }
}

/** How long (ms) a path stays in the HMR-suppression window after a
 *  cortex-originated write lands. Named constant so tests and production
 *  can't drift. */
export const RECENT_EDIT_WRITE_TTL_MS = 500

/** Dependencies threaded into `performEditWrite`. Explicit so tests can
 *  inject mocks for each side-effect (fs write, watcher emit, session
 *  tracking) without needing the full plugin/pipeline wiring. */
export interface EditWriteDeps {
  server: EditWriteServer
  /** Map from filePath → active suppression timer, lives on the active
   *  CortexSession. `.has(path)` answers "is this path currently in the
   *  HMR-suppression window?"; the timer values are only read by
   *  performEditWrite to clearTimeout before arming a fresh one.
   *  `null` when no session exists (tests). */
  recentEditWriteTimers: Map<string, ReturnType<typeof setTimeout>> | null
  /** Atomic write implementation. Production uses `atomicWrite` from
   *  `./atomic-write.js`; tests pass a `vi.fn()`. */
  write: (filePath: string, content: string) => Promise<void>
}

/** Decide whether a WriteIntent should suppress HMR.
 *
 *  Policy: honor an explicit `allowHmr`. Otherwise suppress iff the
 *  edit paints via the browser-side `!important` override layer — i.e.,
 *  `'immediate'`, `'undo'`, `'redo'`. Kinds that may restructure JSX
 *  (`'jsx-immediate'`, `'deferred'`) must NOT suppress, because the
 *  framework needs to re-render with the new source.
 *
 *  ZF0-1215 note: classOp writes pass `{ kind: 'immediate', allowHmr:
 *  true }` explicitly — className mutations have no browser-side override
 *  layer and need HMR to re-render the element with the new class. */
export function shouldSuppressHmr(intent: Pick<WriteIntent, 'kind' | 'allowHmr'>): boolean {
  return !(intent.allowHmr
    ?? (intent.kind === 'deferred' || intent.kind === 'jsx-immediate'))
}

/** Orchestrate an edit write: atomic-rename the target file, then (if HMR
 *  is not suppressed) synthesize a chokidar `change` event on Vite's
 *  watcher so Tailwind v4's CSS generator re-scans the changed source.
 *
 *  Why the explicit watcher emit: chokidar/FSEvents (macOS) frequently
 *  reports `fs.rename`-over-existing as unlink+add rather than change.
 *  Vite's moduleGraph invalidation — the trigger for Tailwind's CSS
 *  re-transform — listens on 'change' only. Emitting directly makes
 *  the fix deterministic across platforms and watcher backends.
 *
 *  Suppression-window ordering (ZF0-1215 C1): the write must LAND before
 *  the path enters the suppression window. If the map-add happened first
 *  and `deps.write` then rejected, the path would remain suppressed for
 *  500ms while never actually having been written, blocking the user's
 *  own editor-save from HMR'ing through during the window. By placing
 *  the map-add after `await deps.write`, a rejection propagates cleanly
 *  with no suppression state leaked.
 *
 *  Timer refresh (ZF0-1215 C1): rapid consecutive writes to the same
 *  path refresh the existing timer rather than stacking independent
 *  ones. A Set + naive `setTimeout` would expire the path mid-window
 *  when the first timer fires, re-exposing the file to chokidar events
 *  even though a second write was still in the middle of its own TTL.
 *  The Map<path, timer> plus clearTimeout-before-set implements a
 *  refreshing-timeout pattern: the TTL is always measured from the
 *  most recent write, not the first.
 *
 *  Throws whatever `deps.write` throws. Callers should catch
 *  `ExternalRevertError` specifically to surface
 *  `edit_status: { reason_code: 'external_revert' }`. */
export async function performEditWrite(
  intent: WriteIntent,
  deps: EditWriteDeps,
): Promise<void> {
  const suppress = shouldSuppressHmr(intent)
  await deps.write(intent.filePath, intent.content)
  if (!suppress) {
    // Clear any existing suppression timer for this path before emitting
    // change — otherwise a prior suppressed write's stale timer would cause
    // handleHotUpdate to skip THIS write's HMR too, silently dropping the
    // update. The TTL exists to debounce rapid same-kind writes; a kind
    // transition (suppressed → non-suppressed) on the same file must reset
    // it so non-suppressed intent is honored.
    const timers = deps.recentEditWriteTimers
    if (timers) {
      const existing = timers.get(intent.filePath)
      if (existing !== undefined) clearTimeout(existing)
      timers.delete(intent.filePath)
    }
    deps.server.watcher.emit('change', intent.filePath)
    return
  }
  const timers = deps.recentEditWriteTimers
  if (!timers) return
  const existing = timers.get(intent.filePath)
  if (existing !== undefined) clearTimeout(existing)
  const timer = setTimeout(() => timers.delete(intent.filePath), RECENT_EDIT_WRITE_TTL_MS)
  timer.unref?.()
  timers.set(intent.filePath, timer)
}

export function cortexEditor(_options?: CortexEditorOptions): Plugin {
  let config: ResolvedConfig
  let transformSource: ReturnType<typeof createSourceTransform>
  const messageHandlers: ((msg: BrowserToServer) => void)[] = []
  let aliasMap: Record<string, string> = {}
  const validatedToggleShortcut = validateToggleShortcut(_options?.toggleShortcut ?? '$mod+Shift+Period')
  const clientScript = getClientScript({ toggleShortcut: validatedToggleShortcut })

  return {
    name: 'cortex-editor',
    enforce: 'pre',

    configResolved(resolved) {
      config = resolved

      // ── Plugin-order audit ──────────────────────────────────────────────
      // `enforce: 'pre'` is a BUCKET in Vite, not a phase guarantee. Within a
      // bucket Vite preserves plain array order, so `plugins: [react(), cortex()]`
      // runs plugin-react's transform first and hands cortex a rewritten string.
      // Every line:col cortex then records is measured against text the apply
      // side will never see (COR-28: a 19-line refresh preamble shifted every
      // anchor onto an unrelated element).
      //
      // The provenance guard in source-transform.ts REFUSES in that situation,
      // which makes the failure safe but not self-explanatory. This turns it
      // into an actionable one, at boot, naming the plugin responsible.
      //
      // webpack and Next need no equivalent: webpack's `enforce: 'pre'` is a
      // real phase (pre-loaders always precede normal loaders, webpack.ts) and
      // the Next adapter appends its loader last to exploit right-to-left chain
      // order (next.ts). Vite is the only adapter where ordering is advisory.
      try {
        // Only meaningful while serving — the transform is a no-op for `build`,
        // so a build-time warning would be pure noise.
        //
        // getSortedPlugins('transform') returns the EFFECTIVE execution order for
        // this hook, which is what actually matters. The raw `resolved.plugins`
        // array is a different order: Vite re-sorts per hook by `transform.order`,
        // so scanning the raw array both MISSES a later-listed plugin declaring
        // `order: 'pre'` and FALSELY ACCUSES an earlier-listed one declaring
        // `order: 'post'`. There is deliberately NO fallback to that array —
        // warning from the wrong list trains users to ignore the warning. Vite
        // 5.1, 6.4 and 7.3 all provide getSortedPlugins; if a version does not,
        // skipping this advisory is strictly better than being confidently wrong,
        // and the provenance guard still enforces either way.
        //
        // Both conditions are folded into this one `if` rather than an early
        // return: this runs INSIDE configResolved, and returning here would skip
        // the alias extraction and transformSource construction below.
        if (resolved.command === 'serve' && typeof resolved.getSortedPlugins === 'function') {
          const sorted = resolved.getSortedPlugins('transform')
          const selfIndex = sorted.findIndex(p => p?.name === 'cortex-editor')
          if (selfIndex > 0) {
            const before = sorted.slice(0, selfIndex).map(p => p?.name).filter(Boolean)
            if (before.length > 0) {
              // Warn, never throw: running after another transform is not proof
              // of harm — it may not touch .jsx/.tsx at all. The provenance guard
              // in source-transform.ts is the enforcing check, per file and on
              // evidence. This exists to make that refusal self-explanatory.
              //
              // Remediation is stated generically on purpose. An earlier version
              // tried to synthesise a call expression from the plugin name and
              // turned `vite:react-babel` into `react-babel()` — a function that
              // does not exist. Plugin NAMES are not factory names, and guessing
              // produces advice that cannot be followed.
              console.warn(
                `[cortex] cortex-editor's transform runs AFTER ${before.length} other transform hook(s): ` +
                `${before.join(', ')}.\n` +
                `[cortex] cortex declares transform.order='pre', so this means one of them also declares ` +
                `'pre' and is listed earlier. If it rewrites JSX, cortex will refuse to annotate those ` +
                `files rather than record positions that point at the wrong element.\n` +
                `[cortex] Fix: move cortexEditor() earlier in your plugins array than the plugin(s) above.`,
              )
            }
          }
        }
      } catch {
        // An audit must never break a build. Ordering is advisory here; the
        // provenance guard is the enforcing check.
      }

      // Extract aliases for source transform (CSS Module import resolution)
      aliasMap = {}
      const aliases = config.resolve?.alias
      if (Array.isArray(aliases)) {
        for (const a of aliases) {
          if (typeof a.find === 'string' && typeof a.replacement === 'string') {
            aliasMap[a.find] = a.replacement
          }
        }
      } else if (aliases && typeof aliases === 'object') {
        for (const [key, val] of Object.entries(aliases)) {
          if (typeof val === 'string') aliasMap[key] = val
        }
      }

      transformSource = createSourceTransform(config.root, {
        includeNodeModules: _options?.includeNodeModules,
        resolveAlias: (spec) => {
          for (const [k, v] of Object.entries(aliasMap)) {
            if (spec === k || spec.startsWith(k + '/')) return v + spec.slice(k.length)
          }
          return null
        },
      })
    },

    resolveId(id) {
      if (id === CORTEX_CLIENT_PATH) return VIRTUAL_CORTEX_CLIENT
    },

    load(id) {
      if (id === VIRTUAL_CORTEX_CLIENT) return clientScript
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (config.command !== 'serve') return html
        // ZF0-1851: when configureServer refused due to LockHeldError, no WS
        // server and no /@cortex/* routes are registered. Injecting the client
        // script anyway would 404 + pollute the user's console — skip
        // injection entirely so cortex is cleanly inert.
        if (cortexDisabledByLock) return html
        // Inject token + sessionId before the module script so globals are available at import time
        const authScript = currentSession
          ? `<script>window.__CORTEX_TOKEN__=${safeJSONForScript(currentSession.token)};window.__CORTEX_SESSION_ID__=${safeJSONForScript(currentSession.sessionId)}</script>\n`
          : ''
        const script = `<script type="module" src="${CORTEX_CLIENT_PATH}"></script>`
        const injected = html.replace(/<\/head>/i, `${authScript}${script}\n</head>`)
        if (injected === html) {
          console.warn('[cortex] transformIndexHtml: </head> not found — client script not injected')
        }
        return injected
      },
    },

    // OBJECT-FORM hook with `order: 'pre'` — this is load-bearing, not style.
    //
    // Plugin-level `enforce: 'pre'` only puts cortex in the pre BUCKET; within a
    // bucket Vite preserves plain array order, so `plugins: [react(), cortex()]`
    // ran plugin-react first and handed us its output. Every line:col we then
    // recorded was measured against text the apply side never sees (COR-28: a
    // 19-line refresh preamble shifted every anchor onto an unrelated element).
    //
    // Hook-level order is a different, stronger mechanism. Vite's
    // getSortedPluginsByHook splices object-form hooks declaring `order: 'pre'`
    // ahead of every function-form hook, regardless of array position:
    //
    //     const hook = plugin[hookName]
    //     if (typeof hook === "object") {
    //       if (hook.order === "pre") { sortedPlugins.splice(pre++, 0, plugin); continue }
    //
    // @vitejs/plugin-react declares `transform` in object form but sets NO order,
    // so it lands in the normal group and we now precede it — whichever way the
    // user lists them. That makes the correct ordering a property of cortex
    // rather than of the consumer's config, which we cannot reach.
    //
    // The provenance guard in source-transform.ts stays as the fallback for the
    // case this cannot cover: another plugin that ALSO declares `order: 'pre'`
    // and is listed before us.
    transform: {
      order: 'pre',
      handler(code, id) {
        if (config.command !== 'serve') return null
        // ZF0-1851: skip source transforms when cortex is disabled (lock held);
        // the runtime support is absent, so rewriting source would just produce
        // dangling references.
        if (cortexDisabledByLock) return null
        const result = transformSource(code, id)
        if (!result) return null
        // Our SourceMap allows nullable optional fields (per source map spec)
        // that Rollup's stricter types reject. Cast the map.
        return { code: result.code, map: result.map as SourceMapInput }
      },
    },

    configureServer(server) {
      // Dispose previous session (Vite restart / configureServer re-entry)
      // Remove upgrade handler from httpServer before dispose nulls the ref —
      // session can't do this because it doesn't hold an httpServer reference.
      if (currentSession) {
        if (currentSession.upgradeHandlerRef && server.httpServer) {
          server.httpServer.removeListener('upgrade', currentSession.upgradeHandlerRef)
        }
        currentSession.listeningCleanup?.()
        currentSession.listeningCleanup = null
        // ZF0-1851: release the .cortex/ lock synchronously BEFORE constructing
        // the new session. dispose() is fire-and-forget (we don't await its
        // async channel teardown), so without the explicit handoff the new
        // acquire would see the old session still in the in-process registry
        // and refuse with LockHeldError. The full dispose still runs and
        // re-releases the lock idempotently as its last step.
        currentSession.releaseLockForHandoff()
        currentSession.dispose().catch((err) => {
          console.warn('[cortex] Failed to dispose previous session:', err instanceof Error ? err.message : err)
        })
      }

      // Remove old signal handlers before registering new ones
      if (shutdownHandler) {
        process.removeListener('SIGINT', shutdownHandler)
        process.removeListener('SIGTERM', shutdownHandler)
        shutdownHandler = null
      }

      // Create fresh session for this server lifecycle.
      // Annotations persistence opt-in lives in resolveAnnotationsFilePath —
      // shared by the webpack adapter and unit-tested without a dev server.
      const annotationsFilePath = resolveAnnotationsFilePath({ root: config.root })

      // ZF0-1851: acquire the .cortex/ single-writer lock inside CortexSession's
      // constructor. A live conflicting instance throws LockHeldError here; we
      // log it and bail out of configureServer so cortex doesn't start — the
      // user's Vite dev server itself keeps running.
      try {
        currentSession = new CortexSession({
          root: config.root,
          mode: config.mode,
          annotationsFilePath,
          cortexDir: path.join(config.root, '.cortex'),
        })
        // Re-arm in case a prior configureServer run set the flag; a fresh
        // successful acquire means cortex is enabled for this lifecycle.
        cortexDisabledByLock = false
      } catch (err) {
        if (err instanceof LockHeldError) {
          console.error(err.message)
          currentSession = null
          cortexDisabledByLock = true
          return
        }
        throw err
      }

      // Attach telemetry to the session. Fully inert when CORTEX_TELEMETRY is unset.
      currentSession.telemetry = createTelemetry({
        enabled: resolveTelemetryEnabled({}),
        endpoint: resolveTelemetryEndpoint({}),
        cortexRoot: config.root,
        version: cortexVersion,
      })

      // Register signal handlers for graceful shutdown.
      // The ?? Promise.resolve() ensures process.exit runs even if currentSession is null
      // (optional chaining would short-circuit the entire .then chain, hanging the process).
      shutdownHandler = () => {
        (currentSession?.dispose() ?? Promise.resolve()).then(
          () => process.exit(0),
          (err) => { console.error('[cortex] Shutdown cleanup failed:', err instanceof Error ? err.message : err); process.exit(1) },
        )
      }
      process.on('SIGINT', shutdownHandler)
      process.on('SIGTERM', shutdownHandler)

      // Serve browser IIFE — read fresh on each request so rebuilds take effect without restart
      server.middlewares.use(CORTEX_BROWSER_PATH, (_req, res, next) => {
        let content: string
        try {
          content = fs.readFileSync(resolveBrowserIIFEPath(), 'utf8')
        } catch (e) {
          console.error(`[cortex] Browser bundle not found: ${resolveBrowserIIFEPath()}`)
          return next(e instanceof Error ? e : new Error(String(e)))
        }
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(content)
      })

      // Cache resolved project root (avoids blocking realpathSync per comment message)
      let realRootCache: string | null = null

      // Resolve Tailwind design-system data at server start — promises awaited in hotHandler.
      // All four run in parallel; hello ships as fast as the slowest resolver.
      const swatchesPromise = TailwindResolver.resolveColors(config.root).catch((err) => {
        console.warn('[cortex] Tailwind color resolution failed:', err instanceof Error ? err.message : err)
        return null
      })
      const colorChipsPromise = TailwindResolver.resolveColorChips(config.root).catch((err) => {
        console.warn('[cortex] Tailwind color chip resolution failed:', err instanceof Error ? err.message : err)
        return null
      })
      const textComponentsPromise = TailwindResolver.resolveTextComponents(config.root).catch((err) => {
        console.warn('[cortex] Tailwind text component resolution failed:', err instanceof Error ? err.message : err)
        return null
      })
      // The .catch here is defensive — resolveSpacingTokens only rejects on
      // programmer error (non-absolute config.root, which Vite always provides
      // as absolute). Internal failures are already swallowed inside the
      // resolver. Kept symmetric with the other three resolver promises.
      const spacingTokensPromise = TailwindResolver.resolveSpacingTokens(config.root).catch((err) => {
        console.warn('[cortex] Tailwind spacing token resolution failed:', err instanceof Error ? err.message : err)
        return null
      })

      // Vite 5.1+ API: server.hot replaces deprecated server.ws
      const hotHandler = (rawData: unknown) => {
        // Guard against race during session disposal or configureServer re-entry
        if (!currentSession || currentSession.isDisposed) return

        // Schema validation — reject any message that doesn't match the protocol.
        // In test mode: throws SchemaViolationError for immediate test failure.
        // In prod: logs a warning and returns null so user sessions are not disrupted.
        const data = parseOrFail(browserToServerSchema, rawData, 'vite.hotHandler')
        if (data === null) {
          // parseOrFail already warned; send a structured rejection back to the browser.
          if (currentSession.channel) {
            const issues = browserToServerSchema.safeParse(rawData)
            const message = issues.success ? 'Schema validation failed' : formatIssues(issues.error.issues)
            currentSession.channel.send({ type: 'error', code: 'SCHEMA_VIOLATION', message })
          }
          return
        }

        // Token validation for write operations — must precede forwardToCLI to prevent
        // unauthenticated messages from being fanned out to CLI clients.
        if (WRITE_TYPES.has(data.type)) {
          if (!('token' in data) || !tokensEqual(data.token, currentSession.token)) {
            if (currentSession.channel) {
              currentSession!.channel.send({ type: 'error', code: 'AUTH_FAILED', message: 'Invalid or missing auth token' })
            }
            return
          }
        }

        // Forward browser messages to CLI clients — after auth so only valid messages propagate.
        // Strip token from forwarded data to avoid leaking it to CLI clients. Gate behind
        // BROWSER_TO_CLI_FORWARD_TYPES allowlist so high-frequency staged-edit-* sync
        // messages (browser↔Vite-cache only) don't burn bandwidth/CPU on the MCP process.
        const { token: _stripped, ...forwardData } = data as Record<string, unknown>
        if (BROWSER_TO_CLI_FORWARD_TYPES.has(data.type)) {
          const forwarded = forwardToCLI(forwardData)
          // Protocol ack: for 'staged-edits-ready', emit 'staged-edits-acked' back to the
          // originating browser ONLY when at least one CLI client actually received the
          // message. If forwarding failed (no CLI clients, serialization error, or all
          // client.send() calls threw), we deliberately stay silent — the browser's
          // sendAndAck() timeout trips and surfaces retry UI. A silent ack on failed
          // forward would hide the delivery failure and leave Claude unnotified.
          if (data.type === 'staged-edits-ready' && forwarded) {
            const requestId = (data as { requestId: string }).requestId
            // Validate the outbound message (Boundary 3 coverage — was previously
            // bypassing the schema validator). Not routed through validateAndSend because
            // staged-edits-acked is a pure browser ack; forwardToCLI would noise-flood
            // CLI clients with a server→browser protocol message they don't consume.
            const ackMsg: ServerToBrowser = { type: 'staged-edits-acked', requestId }
            parseOrFail(serverToBrowserSchema, ackMsg, 'vite.stagedEditsAck')
            server.hot.send(CORTEX_MSG_EVENT, ackMsg)
          }
        }

        // Pillar 1: unified activation request from the browser.
        if (data.type === 'cortex/set-active') {
          const result = evaluateSetActive(currentSession!.activeState, {
            active: data.active,
            tabId: data.tabId,
          })
          applySetActiveResult(currentSession!, result)
          return
        }

        // Track state from browser messages.
        // Pillar 1 (ZF0-1881 codex P1): legacy cortex-closed from Esc/X-button
        // must route through evaluateSetActive so activeState stays consistent
        // with editorActive. Without this the same-tab activation is treated
        // as idempotent and other tabs are rejected — user stuck.
        if (data.type === 'cortex-closed') {
          const result = evaluateSetActive(currentSession!.activeState, {
            active: false,
            tabId: currentSession!.activeState.activeBrowserId ?? undefined,
          })
          applySetActiveResult(currentSession!, result)
        }

        // Handshake contract: 'init' is the browser's explicit "ready" signal.
        // Idempotent — every init gets a hello response so multi-tab, HMR re-mount,
        // and strict-mode double-mount all work without special-casing. Resolvers
        // are cached at server boot so repeat responses cost ~nothing.
        if (data.type === 'init' && currentSession!.channel) {
          const session = currentSession!
          const channel = session.channel!
          Promise.all([swatchesPromise, colorChipsPromise, textComponentsPromise, spacingTokensPromise])
            .then(([colors, chips, textComponents, spacingTokens]) => {
              if (currentSession !== session || session.isDisposed) return
              channel.send({
                type: 'hello',
                protocolVersion: 1,
                sessionId: session.sessionId,
                swatches: colors && colors.length > 0 ? colors : undefined,
                colorChips: chips && chips.length > 0 ? chips : undefined,
                textComponents:
                  textComponents && textComponents.length > 0 ? textComponents : undefined,
                spacingTokens:
                  spacingTokens && spacingTokens.length > 0 ? spacingTokens : undefined,
              })
            })
            .catch((err) => {
              console.warn('[cortex] Failed to send hello:', err instanceof Error ? err.message : err)
            })
        }

        if (data.type === 'comment') {
          // Validate elementSource for fix-request annotations (defense-in-depth).
          // Regular comments are allowed through — only fix-requests drive Claude Code file edits.
          if (data.kind === 'fix-request') {
            const lastColon = data.elementSource.lastIndexOf(':')
            const secondLastColon = data.elementSource.lastIndexOf(':', lastColon - 1)
            const sourceFile = secondLastColon > 0 ? data.elementSource.slice(0, secondLastColon) : data.elementSource.split(':')[0] ?? data.elementSource
            const resolved = path.resolve(config.root, sourceFile)
            const realRoot = realRootCache ?? (realRootCache = (() => { try { return fs.realpathSync.native(config.root) } catch { return config.root } })())
            let outsideRoot = false
            try {
              const realParent = fs.realpathSync.native(path.dirname(resolved))
              outsideRoot = !realParent.startsWith(realRoot + path.sep) && realParent !== realRoot
            } catch {
              outsideRoot = !resolved.startsWith(config.root + path.sep) && resolved !== config.root
            }
            if (outsideRoot) {
              console.warn(`[cortex] Rejected fix-request: elementSource "${sourceFile}" is outside project root`)
              return
            }
          }
          const ann = currentSession!.annotations.create({
            elementSource: data.elementSource,
            text: data.text,
            elementContext: data.elementContext,
            currentStyles: data.currentStyles,
            pinPosition: data.pinPosition,
            kind: data.kind,
            fixMeta: data.fixMeta,
          })
          const entry = currentSession!.activityLog.add({ type: 'comment', description: data.text, elementSource: data.elementSource })
          if (currentSession!.channel) {
            // ZF0-1856: DeepReadonly snapshot → mutable wire shape at the send boundary.
            currentSession!.channel.send({ type: 'annotation-created', annotation: ann as Annotation })
            currentSession!.channel.send({ type: 'activity-entry', entry })
          }
        }

        if (data.type === 'comment-reply') {
          const ann = currentSession!.annotations.addMessage(data.annotationId, { from: 'user', text: data.text })
          if (ann && currentSession!.channel) {
            const entry = currentSession!.activityLog.add({ type: 'comment', description: data.text, elementSource: ann.elementSource })
            // ZF0-1856: DeepReadonly snapshot → mutable wire shape at the send boundary.
            currentSession!.channel.send({ type: 'annotation-updated', annotation: ann as Annotation })
            currentSession!.channel.send({ type: 'activity-entry', entry })
          }
        }

        // Staging buffer sync messages — mirror browser-canonical state into server cache.
        // Shape and bounds were already validated by browserToServerSchema at the top of
        // hotHandler (pendingEditSchema enforces all size caps). No secondary checks needed.
        if (data.type === 'staged-edit-add') {
          currentSession!.stagedEdits.append(data.edit)
          return
        }
        if (data.type === 'staged-edit-remove') {
          currentSession!.stagedEdits.remove(data.intentIds)
          return
        }
        if (data.type === 'staged-edit-clear') {
          currentSession!.stagedEdits.clear()
          return
        }
        if (data.type === 'staged-edits-sync') {
          // Graceful per-element filtering — drop invalid entries rather than rejecting
          // the whole batch. One malformed edit shouldn't lose 499 valid ones during
          // multi-tab merge. The envelope schema accepts z.array(z.unknown()) so we
          // can validate each entry here and warn on drops.
          const results = data.edits.map((e) => pendingEditSchema.safeParse(e))
          const validEdits = results.flatMap((r) => (r.success ? [r.data] : []))
          if (validEdits.length < data.edits.length) {
            // Surface the FIRST failed issue's path/message so operators debugging
            // client-server schema drift have a concrete signal — not just a count.
            const firstFailure = results.find((r) => !r.success)
            const firstIssueDesc = firstFailure && !firstFailure.success
              ? `${firstFailure.error.issues[0]?.path.join('.') ?? '<root>'}: ${firstFailure.error.issues[0]?.message ?? '<no message>'}`
              : 'unknown'
            console.warn(
              `[cortex] staged-edits-sync filtered ${data.edits.length - validEdits.length} invalid edits (first issue: ${firstIssueDesc})`,
            )
          }
          currentSession!.stagedEdits.mergeFullSync(validEdits)
          return
        }
        // 'staged-edits-ready' is forwarded to CLI clients via forwardToCLI() at the top
        // of hotHandler; the MCP-side handler in mcp.ts dispatches the channel
        // notification. Do NOT add a server-side branch here.

        // Route edit/undo/redo to EditPipeline (or notify if still initializing)
        if (data.type === 'edit') {
          if (currentSession!.pipeline) currentSession!.pipeline.handleEdit(data as EditRequest)
          else currentSession!.channel?.send({ type: 'edit_status', editId: (data as EditRequest).editId, status: 'failed', reason: 'Editor is still initializing. Please try again.' })
        }
        if (data.type === 'undo') {
          if (currentSession!.pipeline) currentSession!.pipeline.handleUndo()
          else currentSession!.channel?.send({ type: 'undo_sync_status', status: 'failed', reason: 'Editor is still initializing.' })
        }
        if (data.type === 'redo') {
          if (currentSession!.pipeline) currentSession!.pipeline.handleRedo()
          else currentSession!.channel?.send({ type: 'redo_sync_status', status: 'failed', reason: 'Editor is still initializing.' })
        }
        if (data.type === 'clear_server_undo') {
          currentSession!.pipeline?.clearUndoStack()
        }

        // Track browser connection + send current agent status on init
        if (data.type === 'init') {
          currentSession!.browserConnected = true

          // Pillar 1: a fresh init with a different tab ID means the previously
          // adopted tab is gone (user refreshed). Clear the gate so the new tab
          // can claim it. Backward-compatible: init without tabId (old injected
          // script) leaves the gate intact.
          if (data.tabId && currentSession!.activeState.activeBrowserId &&
              currentSession!.activeState.activeBrowserId !== data.tabId) {
            const result = clearActiveBrowser(
              currentSession!.activeState,
              currentSession!.activeState.activeBrowserId,
            )
            applySetActiveResult(currentSession!, result)
          }

          if (currentSession!.channel) {
            currentSession!.channel.send({ type: 'agent-status', connected: currentSession!.cliClients.size > 0 })
            if (currentSession!.editorActive) currentSession!.channel.send({ type: 'cortex' })
            // Re-send capabilities for late-connecting browsers
            if (currentSession!.capabilitiesCache) {
              currentSession!.channel.send({ type: 'capabilities', systems: currentSession!.capabilitiesCache })
            }
            // Hydrate the browser with annotations the server has in memory.
            // Always emit — even an empty snapshot is authoritative. A reconnecting
            // browser (network blip, HMR re-mount) needs to know the server's
            // current state so any stale local annotations get replaced. The reducer
            // performs a full Map replacement on this message.
            currentSession!.channel.send({
              type: 'annotations-snapshot',
              // ZF0-1856: DeepReadonly snapshots → mutable wire shape at the send boundary.
              annotations: currentSession!.annotations.getAll() as Annotation[],
            })
          }
          return
        }

        const handlers = [...messageHandlers]
        for (const h of handlers) {
          try { h(data) } catch (err) {
            console.warn('[cortex] Message handler error:', err instanceof Error ? err.message : err)
          }
        }
      }
      server.hot.on(CORTEX_MSG_EVENT, hotHandler)

      // send() and broadcast() are identical because Vite's server.hot
      // has no per-client targeting — all messages go to all connected tabs.
      // Both retained for intent clarity in calling code.
      // forwardToCLI echoes server→browser messages to connected CLI clients.
      //
      // Outbound validation via serverToBrowserSchema (Boundary 3):
      // In test mode: throws SchemaViolationError on drift (catches our own bugs early).
      // In prod: warns and STILL sends — never silently drop a message to the user session.
      function validateAndSend(msg: ServerToBrowser): void {
        parseOrFail(serverToBrowserSchema, msg, 'vite.channel.send')
        server.hot.send(CORTEX_MSG_EVENT, msg)
        forwardToCLI(msg)
      }
      currentSession.channel = {
        send(msg: ServerToBrowser) {
          validateAndSend(msg)
        },
        broadcast(msg: ServerToBrowser) {
          validateAndSend(msg)
        },
        onMessage(handler: (msg: BrowserToServer) => void): () => void {
          messageHandlers.push(handler)
          return () => {
            const idx = messageHandlers.indexOf(handler)
            if (idx >= 0) messageHandlers.splice(idx, 1)
          }
        },
        async dispose() {
          server.hot.off(CORTEX_MSG_EVENT, hotHandler)
          messageHandlers.length = 0
        },
      }

      // --- Edit pipeline construction ---
      // Build the edit pipeline with all deps. Tailwind deps are lazy/optional.
      const projectRoot = config.root
      const rewriter = new TailwindRewriter()
      const inlineStyleRewriter = new InlineStyleRewriter()
      const verifier = new HMRVerifier(currentSession.channel)
      const cssModulesRewriter = new CSSModulesRewriter({
        readFile: (p) => fs.promises.readFile(p, 'utf-8'),
      })
      const runtimeResolver = new RuntimeCSSResolver()
      const undoStack = new UndoStack()

      // Style detection + Tailwind resolver are async — kick off in parallel
      const detector = new StyleDetector()
      const detectionPromise = detector.detect(projectRoot).catch((err) => {
        console.warn('[cortex] Style detection failed:', err instanceof Error ? err.message : err)
        return { hasCSSModules: false, hasTailwind: false, hasCSSInJS: false, hasComponentLibrary: false, hasPlainCSS: true, summary: 'Detection failed' } satisfies DetectionResult
      })
      const resolverPromise = TailwindResolver.fromConfig(projectRoot).catch((err) => {
        console.warn('[cortex] Tailwind config resolution failed:', err instanceof Error ? err.message : err)
        return null
      })

      const session = currentSession
      const channel = currentSession.channel
      Promise.all([detectionPromise, resolverPromise]).then(([detection, resolver]) => {
        // Abort if server was disposed or session was replaced during async init
        if (!currentSession || currentSession !== session) return

        // Dispose previous pipeline + HMR callback (e.g., from server restart)
        if (currentSession.pipeline) currentSession.pipeline.dispose()
        if (currentSession.hmrUnsubscribe) currentSession.hmrUnsubscribe()

        // Surface theme loading failures: if Tailwind was detected but the
        // resolver failed to load, warn clearly so the user knows why edits fail.
        if (!resolver && detection.hasTailwind) {
          console.warn('[cortex] ⚠ Tailwind detected but theme could not be loaded. Class-based editing will be limited. Check that tailwindcss is installed and theme.css is accessible.')
        }

        currentSession.pipeline = new EditPipeline({
          channel,
          resolver: resolver ?? TailwindResolver.fromTheme({}),
          // Real resolver may be null (theme unresolved) — the pipeline needs
          // to know it's an empty stand-in, not a resolved theme.
          resolverAvailable: !!resolver,
          rewriter,
          inlineStyleRewriter,
          verifier,
          cssModulesRewriter,
          detector: detection,
          runtimeResolver,
          undoStack,
          telemetry: currentSession.telemetry ?? undefined,
          writeFile: async (intent) => {
            // Delegates to `performEditWrite` which atomically replaces the
            // target file, tracks suppressed writes in
            // recentEditWriteTimers, and (when HMR is not suppressed)
            // synthesizes a chokidar `change` event on `server.watcher`
            // so Vite's moduleGraph invalidates and Tailwind v4 re-scans
            // the source. See helper docstring above cortexEditor() for
            // the full rationale.
            await performEditWrite(intent, {
              server,
              recentEditWriteTimers: currentSession?.recentEditWriteTimers ?? null,
              write: atomicWrite,
            })
          },
          readFile: (p) => fs.promises.readFile(p, 'utf-8'),
          projectRoot,
        })

        currentSession.hmrUnsubscribe = onHMRUpdate((files) => verifier.onHMRUpdate(files))

        // Compute and send capability status to browser
        const resolverState: ResolverState = {
          resolverAvailable: resolver !== null,
          aiAvailable: false,
          inlineStyleAvailable: true,
        }
        const capabilities = computeCapabilities(detection, resolverState)
        currentSession.capabilitiesCache = capabilities.length > 0 ? capabilities : null
        if (currentSession.capabilitiesCache) {
          channel.send({ type: 'capabilities', systems: currentSession.capabilitiesCache })
        }
      }).catch((err) => {
        console.error('[cortex] Failed to initialize edit pipeline:', err instanceof Error ? err.message : err)
      })

      // --- CLI WebSocket bridge ---
      // Only set up when httpServer is available (not in middleware mode)
      if (server.httpServer) {
        currentSession.cliWss = new WebSocketServer({
          noServer: true,
          maxPayload: 64 * 1024,
          verifyClient: ({ origin }: { origin: string }) => {
            if (!origin) return true // non-browser clients (CLI) don't send Origin
            return ALLOWED_ORIGINS.test(origin)
          },
        })

        currentSession.cliWss.on('connection', (ws) => {
          if (currentSession!.cliClients.size >= MAX_CLI_CONNECTIONS) {
            ws.close(1013, 'Too many CLI connections')
            return
          }

          currentSession!.cliClients.add(ws)
          currentSession!.aliveFlags.set(ws, true)

          // Send current status on connect (untyped JSON — not part of ServerToBrowser protocol)
          try {
            ws.send(JSON.stringify({ type: 'cortex-status', editorActive: currentSession!.editorActive, browserConnected: currentSession!.browserConnected }))
          } catch {
            currentSession!.cliClients.delete(ws)
            ws.terminate()
            return
          }

          // Notify browser that an agent connected
          if (currentSession!.channel) currentSession!.channel.send({ type: 'agent-status', connected: true })

          ws.on('pong', () => { currentSession?.aliveFlags.set(ws, true) })

          ws.on('message', async (raw) => {
            let parsed: unknown
            try { parsed = JSON.parse(raw.toString()) } catch { return }
            if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return
            const type = (parsed as { type: unknown }).type
            if (typeof type !== 'string') return

            // Token validation for ALL CLI messages
            const msgToken = (parsed as Record<string, unknown>).token
            if (!tokensEqual(msgToken, currentSession!.token)) {
              try {
                ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'Invalid or missing auth token' }))
              } catch (sendErr) {
                console.warn('[cortex] Failed to send AUTH_FAILED to CLI client:', sendErr instanceof Error ? sendErr.message : sendErr)
              }
              return
            }

            // mcp-session-hello — MCP server announces its process-scoped UUID; the
            // browser uses the forwarded hello as its reconcile trigger (phantom-intent
            // self-heal). Still gated behind the same token check as every other
            // privileged CLI message above — the MCP server attaches the token (see
            // mcp.ts socket.on('open')). The /@cortex/ws upgrade is only Origin-checked
            // at connect; the per-message token is the actual auth, so handling this
            // AFTER the gate prevents any other local process from forging hellos.
            //
            // DELIBERATELY NO stagedEdits.clear() here (0.3.1): the wipe formerly keyed
            // on a UUID change, but Claude Code spawns a fresh `cortex mcp` process —
            // fresh UUID — per conversation, so every Claude restart (and every
            // interleaved hello from two concurrent Claude clients) destroyed the
            // designer's staged-but-unapplied work. The designer's session is the
            // BROWSER page's lifetime (the buffer is memory-only), not any MCP process
            // lifetime. Live-page staleness self-heals via the browser's reconnect
            // clear-then-set sync and reconcileOnConnect. Residual (pre-existing): a
            // closed page leaves its server cache until dev-server restart — benign
            // resurrection, tracked as the browser-owned session-nonce follow-up.
            if (type === 'mcp-session-hello') {
              const sessionId = (parsed as Record<string, unknown>).sessionId
              if (typeof sessionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
                // FIX 3: mcp-session-hello is a server→browser message; send BROWSER-ONLY
                // via server.hot.send (bypassing forwardToCLI). The channel.send path goes
                // through validateAndSend → forwardToCLI which would echo this back to CLI
                // clients — wrong direction, no consumer, latent mis-handle risk.
                if (currentSession && !currentSession.isDisposed) {
                  parseOrFail(serverToBrowserSchema, { type: 'mcp-session-hello', sessionId } as ServerToBrowser, 'vite.mcpSessionHello')
                  server.hot.send(CORTEX_MSG_EVENT, { type: 'mcp-session-hello', sessionId })
                }
              } else {
                console.warn('[cortex] mcp-session-hello rejected: sessionId is not a valid UUID')
              }
              return
            }

            // Handle RPC requests from CLI (annotation queries)
            if (type === 'cortex-rpc') {
              // Schema validation — rejects malformed envelopes before dispatching.
              const rpcMsg = parseOrFail(cliRpcRequestSchema, parsed, 'vite.cliDispatcher.cortex-rpc')
              if (rpcMsg === null) {
                // parseOrFail already warned; send a generic error (no requestId available to echo)
                try { ws.send(JSON.stringify({ type: 'error', code: 'SCHEMA_VIOLATION', message: 'Invalid cortex-rpc envelope' })) } catch {}
                return
              }
              const requestId = rpcMsg.requestId
              const method = rpcMsg.method
              let params = rpcMsg.params
              if (!ALLOWED_RPC_METHODS.has(method)) {
                try { ws.send(JSON.stringify({ type: 'cortex-rpc-error', requestId, error: `Unknown RPC method: ${method}` })) } catch {}
                return
              }
              // Method-specific param validation (F1): the envelope schema only checks the
              // outer shape; here we enforce the per-method contract so invalid params are
              // rejected with SCHEMA_VIOLATION instead of being silently coerced or ignored.
              // In test mode parseOrFail throws — that throw is caught below and forwarded
              // as cortex-rpc-error so the test can assert on it.
              try {
                const methodSchema = RPC_METHOD_SCHEMAS[method as keyof typeof RPC_METHOD_SCHEMAS]
                if (methodSchema !== null && methodSchema !== undefined) {
                  // Cast to z.ZodType<unknown> to allow parseOrFail to accept the union
                  // of method schemas (each has a distinct output type; the generic T
                  // can't be inferred from the union — we only need the validation side-effect).
                  const schemaResult = (methodSchema as import('zod').ZodType<unknown>).safeParse(params)
                  if (!schemaResult.success) {
                    // Use parseOrFail in test mode so it throws (caught below → cortex-rpc-error).
                    // In prod mode, send cortex-rpc-error paired by requestId so only this RPC
                    // fails — NOT a generic 'error' envelope that would fan-out reject ALL in-flight RPCs.
                    parseOrFail(methodSchema as import('zod').ZodType<unknown>, params, `vite.handleRPC.${method}`)
                    // prod mode: parseOrFail returned null (warned); send paired error to CLI
                    const formatted = formatIssues(schemaResult.error.issues)
                    try { ws.send(JSON.stringify({ type: 'cortex-rpc-error', requestId, error: `SCHEMA_VIOLATION: ${formatted}` })) } catch {}
                    return
                  }
                  params = schemaResult.data as Record<string, unknown>
                }
                const result = await Promise.resolve(handleRPC(method, params))
                try {
                  ws.send(JSON.stringify({ type: 'cortex-rpc-result', requestId, result }))
                } catch (sendErr) {
                  console.warn('[cortex] Failed to send RPC result to CLI client:', sendErr instanceof Error ? sendErr.message : sendErr)
                }
              } catch (err) {
                try {
                  ws.send(JSON.stringify({ type: 'cortex-rpc-error', requestId, error: err instanceof Error ? err.message : String(err) }))
                } catch (sendErr) {
                  console.warn('[cortex] Failed to send RPC error to CLI client:', sendErr instanceof Error ? sendErr.message : sendErr)
                }
              }
              return
            }

            // Pillar 1 unified path — accept new shape and route through helper.
            if (type === 'cortex/set-active') {
              const active = (parsed as unknown as { active: boolean }).active
              const result = evaluateSetActive(currentSession!.activeState, { active })
              applySetActiveResult(currentSession!, result)
              return
            }

            // Dual-mode legacy paths — translate into set-active. Drop after one
            // minor release once all clients have migrated to cortex/set-active.
            if (type === 'cortex' || type === 'cortex-close') {
              const result = evaluateSetActive(currentSession!.activeState, {
                active: type === 'cortex',
              })
              applySetActiveResult(currentSession!, result)
              return
            }

            // Reconstruct message — don't forward arbitrary properties from CLI
            if (!CLI_ALLOWED_TYPES.has(type)) return
            if (currentSession!.channel) {
              currentSession!.channel.send({ type } as ServerToBrowser)
            }
          })

          ws.on('close', () => {
            currentSession?.cliClients.delete(ws)
            if (currentSession?.channel) currentSession.channel.send({ type: 'agent-status', connected: currentSession.cliClients.size > 0 })
          })
          ws.on('error', () => currentSession?.cliClients.delete(ws))
        })

        // Heartbeat — 30s ping/pong, matching CortexTransport pattern
        currentSession.heartbeatTimer = setInterval(() => {
          if (!currentSession) return
          for (const client of currentSession.cliClients) {
            if (!currentSession.aliveFlags.get(client)) {
              client.terminate()
              currentSession.cliClients.delete(client)
              continue
            }
            currentSession.aliveFlags.set(client, false)
            try { client.ping() } catch { currentSession.cliClients.delete(client) }
          }
        }, HEARTBEAT_INTERVAL)
        currentSession.heartbeatTimer.unref()

        // WebSocket upgrade handler — route /@cortex/ws to CLI WSS
        currentSession.upgradeHandlerRef = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          if (req.url !== '/@cortex/ws') return
          // Do NOT close the socket for non-matching paths — Vite's HMR handler needs them

          // Loopback enforcement — reject non-local connections (defense-in-depth for --host mode)
          const remote = req.socket.remoteAddress
          if (!remote || !(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
            socket.destroy()
            return
          }

          // Host header validation — DNS rebinding defense
          const host = req.headers.host
          if (!host || !ALLOWED_ORIGINS.test(`http://${host}`)) {
            socket.destroy()
            return
          }

          if (!currentSession?.cliWss) { socket.destroy(); return }
          currentSession.cliWss.handleUpgrade(req, socket, head, (ws: InstanceType<typeof WebSocket>) => {
            if (!currentSession?.cliWss) { ws.terminate(); return }
            currentSession.cliWss.emit('connection', ws, req)
          })
        }

        server.httpServer.on('upgrade', currentSession.upgradeHandlerRef)

        // Write port + token files for MCP discovery
        const cortexDir = path.join(config.root, '.cortex')
        currentSession.portFilePath = path.join(cortexDir, 'port')
        currentSession.tokenFilePath = path.join(cortexDir, 'token')
        const session = currentSession!
        const writeDiscoveryFiles = () => {
          if (currentSession !== session || session.isDisposed) return
          session.listeningCleanup = null
          const addr = server.httpServer!.address()
          if (addr && typeof addr === 'object') {
            try {
              fs.mkdirSync(cortexDir, { recursive: true, mode: 0o700 })
            } catch (err) {
              console.warn('[cortex] Could not create .cortex/ directory:', err instanceof Error ? err.message : err)
              return
            }
            try {
              fs.writeFileSync(session.portFilePath!, String(addr.port))
            } catch (err) {
              console.warn('[cortex] Could not write port file:', err instanceof Error ? err.message : err)
            }
            try {
              fs.writeFileSync(session.tokenFilePath!, session.token, { mode: 0o600 })
              // Ensure 0o600 even if the file pre-existed with looser permissions
              fs.chmodSync(session.tokenFilePath!, 0o600)
            } catch (err) {
              console.error('[cortex] Could not write token file — CLI authentication will fail:', err instanceof Error ? err.message : err)
            }
          }
        }
        server.httpServer.once('listening', writeDiscoveryFiles)
        session.listeningCleanup = () => {
          server.httpServer?.removeListener('listening', writeDiscoveryFiles)
        }
      } else {
        console.warn('[cortex] No httpServer — running in middleware mode. CLI connections unavailable.')
      }
    },

    handleHotUpdate({ modules }: HmrContext) {
      if (modules.length === 0) return

      // Suppress HMR for files cortex just wrote — the override is already
      // showing the correct value. HMR would cause a full-page style recalc
      // + repaint visible as a flash. The override stays until hmr_verified
      // clears it (which is now a no-op since we handled verification above).
      const cortexFiles = modules.filter(m => m.file && currentSession?.recentEditWriteTimers.has(m.file))

      // Only fire HMR callbacks for non-suppressed files — otherwise the
      // verifier would track edits for files whose HMR was intentionally blocked.
      const nonSuppressed = modules.filter(m => !m.file || !currentSession?.recentEditWriteTimers.has(m.file))
      const files = nonSuppressed
        .map(m => m.file)
        .filter((f): f is string => f != null && (/\.[jt]sx$/.test(f) || /\.css$/.test(f)))

      if (files.length > 0) {
        const cbs = [...(currentSession?.hmrCallbacks ?? [])]
        for (const cb of cbs) {
          try { cb(files) } catch (err) {
            console.warn('[cortex] HMR callback error:', err instanceof Error ? err.message : err)
          }
        }
      }

      if (cortexFiles.length > 0) {
        // Return only non-cortex modules — suppresses HMR for cortex-written files
        return nonSuppressed
      }
    },
  }
}
