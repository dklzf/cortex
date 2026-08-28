/**
 * Panel UI helpers for Playwright specs.
 *
 * Business purpose: the Panel header chrome (Apply button, drift banner, apply
 * error banner) and per-control stale indicators live inside a closed Shadow
 * DOM that ordinary Playwright locators cannot reach. These helpers encapsulate
 * the three-line shadow-root dance (host lookup → shadowRoot access → null
 * fallback) for every Panel UI surface, so specs can assert on business-level
 * outcomes without writing DOM traversal code.
 *
 * All getters are safe to call whether or not the Panel is mounted — they
 * return empty-state defaults (visible: false, etc.) when the shadow root is
 * not reachable. This prevents spurious Playwright errors when a spec asserts
 * a "not visible" state without first asserting that the Panel rendered.
 *
 * Companion to `bridge.ts`. Selectors use stable CSS classes + `data-action`
 * attributes — never text content. Text content is localization-fragile and
 * can match unintended elements.
 *
 * Pre-goto helpers (`installSendSpy`) MUST be called BEFORE `page.goto` and
 * MUST call `assertPreNavigation` to fail loudly on out-of-order use.
 *
 * Ordering constraint for `installSendSpy`:
 *   Call `setupDebugBridge(page)` first (which stubs `__cortex_send__` to
 *   no-op), then call `installSendSpy(page)`. Playwright runs init scripts in
 *   registration order, so the spy's init script fires AFTER the no-op stub
 *   and replaces it with the collecting spy. The Vite channel closure-captures
 *   `__cortex_send__` at bootstrap (channel.ts:132), so the spy persists for
 *   the lifetime of the page — including after any tombstone or reconnect.
 */
import { expect, type Page } from '@playwright/test'
import { assertPreNavigation, setupDebugBridge, activateDesignMode, waitForBridge, type CortexTestBridge } from './bridge.js'
import { installFixtureServer, FIXTURE_URL } from './fixture-server.js'
import { SchemaViolationError, formatIssues, serverToBrowserSchema, browserToServerSchema } from '../../../src/schemas/index.js'

// Re-export for spec author convenience — load fixtures alongside simulateServerMessage.
export { loadWireFormatFixture } from '../../../src/schemas/index.js'

// ─── Send spy ────────────────────────────────────────────────────────────────

/**
 * Pre-goto initScript: replaces `window.__cortex_send__` with a spy that
 * pushes every outbound BrowserToServer message onto
 * `window.__cortexSentMessages__`. The Vite channel closure-captures
 * `__cortex_send__` at bootstrap (channel.ts:132), so the spy persists
 * post-tombstone.
 *
 * MUST be called BEFORE `page.goto`. MUST be called AFTER
 * `setupDebugBridge(page)` in the boot sequence. Init scripts run in
 * registration order on every navigation; calling earlier means
 * `setupDebugBridge`'s no-op stub overwrites the spy and the spy silently
 * captures nothing — every assertion that reads `getSentMessages` returns
 * `[]` and the spec passes for the wrong reason.
 *
 * Usage:
 * ```ts
 * await setupDebugBridge(page)  // installs no-op stub
 * await installSendSpy(page)    // overwrites with collecting spy
 * await installFixtureServer(page)
 * await page.goto(FIXTURE_URL)
 * ```
 */
export async function installSendSpy(page: Page): Promise<void> {
  assertPreNavigation(page, 'installSendSpy')
  await page.addInitScript(() => {
    ;(globalThis as unknown as { __cortexSentMessages__?: unknown[] }).__cortexSentMessages__ = []
    ;(globalThis as unknown as { __cortex_send__?: (msg: unknown) => void }).__cortex_send__ = (msg: unknown) => {
      ;(globalThis as unknown as { __cortexSentMessages__?: unknown[] }).__cortexSentMessages__?.push(msg)
    }
  })
}

/**
 * Read the array of outbound BrowserToServer messages captured by the spy
 * installed by `installSendSpy`. Returns an empty array if the spy was not
 * installed or no messages have been sent.
 *
 * The returned array is a snapshot — it reflects messages sent up to the
 * moment of the call. Subsequent sends are NOT reflected until the next call.
 */
export async function getSentMessages(page: Page): Promise<unknown[]> {
  return await page.evaluate(() => {
    return (globalThis as unknown as { __cortexSentMessages__?: unknown[] }).__cortexSentMessages__ ?? []
  })
}

/**
 * Assert that every message captured by the send spy conforms to
 * `browserToServerSchema`. Throws `SchemaViolationError` on the first
 * violation so drift is surfaced loudly rather than silently ignored.
 *
 * This is the Node-side complement to `installSendSpy` — validation runs
 * in the test process (where the Zod schema is available) rather than inside
 * the page (where it is not). Call after any action you want to validate:
 *
 * ```ts
 * await installSendSpy(page)
 * // ... perform action ...
 * await assertSentMessagesValid(page)
 * ```
 *
 * @param page - Playwright `Page` instance. The spy must have been installed
 *   via `installSendSpy` before navigation.
 */
export async function assertSentMessagesValid(page: Page): Promise<void> {
  const messages = await getSentMessages(page)
  for (const msg of messages) {
    // Always throw on schema violations — this is test-only infrastructure.
    const result = browserToServerSchema.safeParse(msg)
    if (!result.success) {
      throw new SchemaViolationError(
        `panel.assertSentMessagesValid: ${formatIssues(result.error.issues)}`,
        result.error.issues,
        'panel.assertSentMessagesValid',
      )
    }
  }
}

/**
 * Inject a ServerToBrowser message into the page by calling
 * `window.__cortex_channel__.handleServerMessage(msg)`.
 *
 * `__cortex_channel__` is a frozen global with `configurable: true` whose
 * `handleServerMessage` is the ONLY way to inject server→browser messages
 * post-boot (per ZF0-1473 architecture constraints). This helper wraps the
 * call so spec authors don't need to know the global name.
 *
 * Throws if the channel global is not present (bundle not booted or wrong
 * test build).
 */
export async function simulateServerMessage(page: Page, msg: unknown): Promise<void> {
  // Validate against the canonical schema before dispatching. This is test-only
  // infrastructure, so we ALWAYS throw on schema violations (never just warn).
  // parseOrFail's test-mode detection is irrelevant here — e2e code must fail fast.
  const result = serverToBrowserSchema.safeParse(msg)
  if (!result.success) {
    throw new SchemaViolationError(
      `panel.simulateServerMessage: ${formatIssues(result.error.issues)}`,
      result.error.issues,
      'panel.simulateServerMessage',
    )
  }
  await page.evaluate((message) => {
    const ch = (globalThis as unknown as {
      __cortex_channel__?: { handleServerMessage: (m: unknown) => void }
    }).__cortex_channel__
    if (!ch) throw new Error('[panel] __cortex_channel__ not present — is the bundle booted?')
    ch.handleServerMessage(message)
  }, msg)
}

// ─── Boot composition ────────────────────────────────────────────────────────

/**
 * Standard boot sequence for Panel-UI specs that need outbound message
 * capture. Composes setupDebugBridge → activateDesignMode → installSendSpy →
 * installFixtureServer → page.goto → waitForBridge in the canonical order.
 *
 * Use this for any spec that calls getSentMessages or simulateServerMessage.
 * Specs that only assert on bus events (no message-capture needs) should use
 * bootFixture from boot.ts instead.
 *
 * Ordering rationale (from `installSendSpy` JSDoc):
 *   1. setupDebugBridge installs a no-op stub on `__cortex_send__` (init script).
 *   2. installSendSpy overwrites that stub with a collecting spy (init script).
 *   3. installFixtureServer routes fixture HTML/JS via page.route.
 *   4. page.goto navigates; init scripts fire in registration order, so
 *      the spy persists post-nav (channel.ts:132 closure-captures it).
 *   5. waitForBridge confirms `__CORTEX_TEST__` is exposed.
 *
 * The bundle-boot sentinel (`globalThis.CortexEditor`) is checked with a 5000ms
 * ceiling so a missing/broken bundle fails loudly with a diagnostic instead of
 * silently timing out inside `waitForBridge`.
 */
export async function bootWithSendSpy(page: Page): Promise<void> {
  await setupDebugBridge(page)
  await activateDesignMode(page)
  await installSendSpy(page)
  await installFixtureServer(page)
  await page.goto(FIXTURE_URL)
  try {
    await page.waitForFunction(
      () => typeof (globalThis as unknown as { CortexEditor?: unknown }).CortexEditor !== 'undefined',
      null,
      { timeout: 5000 },
    )
  } catch (err) {
    throw new Error(
      `[bootWithSendSpy] CortexEditor bundle did not boot within 5000ms.\n` +
        `Page URL: ${page.url()}\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  await waitForBridge(page)
}

// ─── Apply button ─────────────────────────────────────────────────────────────

/**
 * Snapshot of the Apply button state.
 *
 * Fields:
 * - `visible`: true if `[data-action="apply"]` is present in the shadow DOM.
 *   Corresponds to the `bufferSize > 0 && !pendingClaude` condition in
 *   PanelHeader.tsx:263.
 * - `label`: text content of the button (`"Apply (N)"` or `"Delivering…"`).
 *   null when not visible.
 * - `disabled`: true if the button has the `disabled` attribute. Corresponds
 *   to `delivering === true` (PanelHeader.tsx:270).
 * - `ariaBusy`: true if `aria-busy="true"` is set. Same condition as disabled.
 */
export interface ApplyButtonState {
  visible: boolean
  label: string | null
  disabled: boolean
  ariaBusy: boolean
}

/**
 * Snapshot the Apply button (`[data-action="apply"]`) from the Panel's Shadow
 * DOM. Returns `{ visible: false, label: null, disabled: false, ariaBusy: false }`
 * when the shadow root is not reachable or the button is not rendered.
 *
 * The button visibility follows a 3-state machine in PanelHeader.tsx:
 *   Hidden (`visible: false`) → `Apply (N)` → `Delivering…` (disabled) → Hidden
 */
export async function getApplyButtonState(page: Page): Promise<ApplyButtonState> {
  return await page.evaluate(() => {
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    if (!root) return { visible: false, label: null, disabled: false, ariaBusy: false }
    const btn = root.querySelector<HTMLButtonElement>('[data-action="apply"]')
    if (!btn) return { visible: false, label: null, disabled: false, ariaBusy: false }
    return {
      visible: true,
      label: btn.textContent?.trim() ?? null,
      disabled: btn.disabled,
      ariaBusy: btn.getAttribute('aria-busy') === 'true',
    }
  })
}

/**
 * Click the Apply button (`[data-action="apply"]`) in the Panel's Shadow DOM.
 * Returns `true` if the button was found and clicked, `false` otherwise —
 * callers should assert `true` so a missing/renamed button fails loudly.
 *
 * Does NOT wait for any resulting state transitions. Use `getApplyButtonState`
 * with `expect.poll` to assert the transition outcome.
 */
export async function clickApplyButton(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    if (!root) return false
    const btn = root.querySelector<HTMLButtonElement>('[data-action="apply"]')
    if (!btn) return false
    btn.click()
    return true
  })
}

// ─── Drift banner ─────────────────────────────────────────────────────────────

/**
 * Snapshot of the StagingDriftBanner state.
 *
 * Fields:
 * - `visible`: true if `.cortex-drift-banner` is present in the shadow DOM.
 * - `intentCount`: the count read from `[data-row="intent"]`'s `data-count`
 *   attribute. 0 if the intent row is absent.
 * - `staleCount`: the count read from `[data-row="stale"]`'s `data-count`
 *   attribute. 0 if the stale row is absent.
 * - `dismissAvailable`: true if `.cortex-drift-banner__dismiss` is present.
 */
export interface DriftBannerState {
  visible: boolean
  intentCount: number
  staleCount: number
  dismissAvailable: boolean
}

/**
 * Snapshot the StagingDriftBanner (`.cortex-drift-banner`) from the Panel's
 * Shadow DOM. Returns `{ visible: false, intentCount: 0, staleCount: 0,
 * dismissAvailable: false }` when the shadow root is not reachable or the
 * banner is not rendered.
 *
 * Count extraction reads `data-count` from each `[data-row="intent" | "stale"]`
 * element (set by `StagingDriftBanner.tsx`). Structural attributes are stable
 * against title-text edits and localization, unlike a regex over title text.
 */
export async function getDriftBannerState(page: Page): Promise<DriftBannerState> {
  return await page.evaluate(() => {
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    if (!root) return { visible: false, intentCount: 0, staleCount: 0, dismissAvailable: false }
    const banner = root.querySelector('.cortex-drift-banner')
    if (!banner) return { visible: false, intentCount: 0, staleCount: 0, dismissAvailable: false }

    const readRowCount = (rowKey: 'intent' | 'stale'): number => {
      const row = banner.querySelector<HTMLElement>(`[data-row="${rowKey}"]`)
      if (!row) return 0
      const raw = row.dataset['count']
      if (raw === undefined) return 0
      const n = parseInt(raw, 10)
      return Number.isFinite(n) ? n : 0
    }

    return {
      visible: true,
      intentCount: readRowCount('intent'),
      staleCount: readRowCount('stale'),
      dismissAvailable: !!banner.querySelector('.cortex-drift-banner__dismiss'),
    }
  })
}

/**
 * Click the Dismiss button (`.cortex-drift-banner__dismiss`) on the
 * StagingDriftBanner. Returns `true` if found and clicked, `false` otherwise.
 *
 * The dismiss button uses `data-action="dismiss"` (StagingDriftBanner.tsx:100)
 * and sets internal `dismissed` state — the banner unmounts on the next render.
 */
export async function dismissDriftBanner(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    if (!root) return false
    const btn = root.querySelector<HTMLButtonElement>('.cortex-drift-banner__dismiss')
    if (!btn) return false
    btn.click()
    return true
  })
}

// ─── Apply error banner ───────────────────────────────────────────────────────

/**
 * Snapshot of the apply error banner state.
 *
 * Fields:
 * - `visible`: true if `.cortex-apply-error[role="alert"]` is present in the
 *   shadow DOM (Panel.tsx:1211, 1391).
 * - `message`: text content of the `<span>` inside the banner, or null when
 *   not visible.
 */
export interface ApplyErrorBannerState {
  visible: boolean
  message: string | null
}

/**
 * Snapshot the apply error banner (`.cortex-apply-error[role="alert"]`) from
 * the Panel's Shadow DOM. Returns `{ visible: false, message: null }` when
 * the shadow root is not reachable or the banner is not rendered.
 *
 * The banner appears when `sendAndAck` rejects — `onApplyError` in Panel.tsx
 * sets `applyError` state, which renders the alert. The `<span>` child holds
 * the error message (typically the rejection's `.message` string).
 */
export async function getApplyErrorBannerState(page: Page): Promise<ApplyErrorBannerState> {
  return await page.evaluate(() => {
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    if (!root) return { visible: false, message: null }
    const banner = root.querySelector('.cortex-apply-error[role="alert"]')
    if (!banner) return { visible: false, message: null }
    const msgEl = banner.querySelector('span')
    return {
      visible: true,
      message: msgEl?.textContent?.trim() ?? null,
    }
  })
}

/**
 * Click the Dismiss button (`.cortex-apply-error__dismiss`) on the apply
 * error banner. Returns `true` if found and clicked, `false` otherwise.
 *
 * The dismiss button's `onClick` sets `applyError` to null in Panel.tsx, which
 * unmounts the banner on the next render. Callers should assert the return
 * value is `true` so a missing/renamed button fails loudly.
 */
export async function dismissApplyErrorBanner(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const host = document.querySelector('[data-cortex-host]')
    const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
    if (!root) return false
    const btn = root.querySelector<HTMLButtonElement>('.cortex-apply-error__dismiss')
    if (!btn) return false
    btn.click()
    return true
  })
}

// ─── Element selection ────────────────────────────────────────────────────────

/**
 * Select the given element via the bridge's `selectElement` callback.
 * Panel renders controls for the selected element — must be called after
 * `waitForBridge` resolves.
 *
 * This standalone helper exists for specs that need to select an element AFTER
 * the initial boot (e.g. to switch selection mid-test or to select AFTER
 * asserting the initial null-state Panel). Specs that need element selection
 * during boot should use `bootFixture({ selectElement: selector })` from
 * `boot.ts` instead — `bootFixture` accepts `selectElement` as an option so
 * the selection is wired into the canonical boot sequence.
 *
 * @param page - Playwright `Page` instance.
 * @param selector - CSS selector for the element to select. Throws if the
 *   element is not found or if `bridge.selectElement` is not present.
 */
export async function selectElement(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) throw new Error(`[selectElement] ${sel} not found`)
    const bridge = (globalThis as unknown as { __CORTEX_TEST__?: CortexTestBridge }).__CORTEX_TEST__
    if (!bridge?.selectElement) throw new Error('[selectElement] bridge.selectElement not present')
    bridge.selectElement(el)
  }, selector)
}

/**
 * Select SEVERAL elements at once (multi-selection).
 *
 * The bridge has exposed `selectElements` all along; nothing wrapped it, so
 * specs needing a multi-selection reached for `selectElement` with a second
 * argument — which the bridge ignores, silently leaving a single selection and
 * a test that asserts nothing about multi-select.
 *
 * @param page - Playwright `Page` instance.
 * @param selectors - CSS selectors, in the order the selection should hold.
 */
export async function selectElements(page: Page, selectors: string[]): Promise<void> {
  await page.evaluate((sels) => {
    const els = sels.map((s) => {
      const el = document.querySelector<HTMLElement>(s)
      if (!el) throw new Error(`[selectElements] ${s} not found`)
      return el
    })
    const bridge = (globalThis as unknown as { __CORTEX_TEST__?: CortexTestBridge }).__CORTEX_TEST__
    if (!bridge?.selectElements) throw new Error('[selectElements] bridge.selectElements not present')
    bridge.selectElements(els)
  }, selectors)
}

/**
 * Wait until Panel has committed the element-state branch — the branch that
 * renders CSS section controls alongside the StagingDriftBanner (Panel.tsx line
 * 1442). Presence of `.cortex-section-group` in the shadow root is the stable
 * marker: it only appears when `element !== null` inside Panel.tsx.
 *
 * Why this guard is necessary: Panel renders TWO independent
 * `StagingDriftBanner` instances — one in the null-state branch (Panel.tsx:1258)
 * and one in the element-state branch (Panel.tsx:1442). They have SEPARATE
 * `dismissed` React state. If a spec dismisses the null-state banner and then
 * the element-state Panel commits, a fresh element-state banner mounts with
 * `dismissed=false` and immediately shows again — producing a false
 * "visible after dismiss" failure.
 *
 * Calling this helper after `selectElement` ensures all subsequent banner
 * assertions target the element-state banner's committed state.
 *
 * Polling `{ timeout: 2000 }` is safe: `waitForBridge` already guarantees the
 * bundle is booted and bridge is ready; `selectElement` is a synchronous call
 * to Preact's `setState`; and Preact commits on the next microtask. The 2000ms
 * ceiling is far beyond any realistic Preact commit latency.
 */
export async function waitForElementStatePanel(page: Page): Promise<void> {
  try {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = document.querySelector('[data-cortex-host]')
            const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
            if (!root) return false
            return !!root.querySelector('.cortex-section-group')
          }),
        { timeout: 2000 },
      )
      .toBe(true)
  } catch (err) {
    throw new Error(
      `[waitForElementStatePanel] .cortex-section-group not found within 2000ms — ` +
        `did selectElement run before this call? Or is the panel showing the ` +
        `null-state branch (no element selected)?\n` +
        `Page URL: ${page.url()}\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Stage an edit directly into Panel's staging buffer via the TEST-ONLY
 * `bridge.stageEdit()` method (gated by `__CORTEX_TEST_BUILD__`). Calls
 * `buffer.append()` directly inside Panel.tsx without going through the scrub
 * UI. Returns the `intentId` that was appended — callers can pass it to a
 * `staged-edits-discard` server message to drain the buffer.
 *
 * Throws if `bridge.stageEdit` is not present (not a test build).
 *
 * @param page - Playwright `Page` instance.
 * @param source - Source file identifier (e.g. `FIXTURE_SEED_SOURCE`).
 * @param property - CSS property name (e.g. `'padding-top'`).
 * @param value - CSS value string (e.g. `'32px'`).
 * @returns The `intentId` string appended to the buffer.
 */
export async function stageEdit(
  page: Page,
  source: string,
  property: string,
  value: string,
): Promise<string> {
  return await page.evaluate(
    ({ src, prop, val }) => {
      const bridge = (globalThis as unknown as { __CORTEX_TEST__: CortexTestBridge }).__CORTEX_TEST__
      if (!bridge.stageEdit) throw new Error('[test] bridge.stageEdit not present — is this a test build?')
      return bridge.stageEdit(src, prop, val)
    },
    { src: source, prop: property, val: value },
  )
}

// ─── NumericInput stale state ─────────────────────────────────────────────────

/**
 * Snapshot of a NumericInput control's stale indicator state.
 *
 * Fields:
 * - `stale`: true if the wrapper has CSS class `cortex-numeric-input--stale`.
 *   Applied by NumericInput.tsx:238 when `stale` prop is true.
 * - `tooltipText`: value of the `data-tooltip` attribute on the wrapper, or
 *   null if absent. When stale, this is `"Edit saved but HMR didn't apply —
 *   refresh to verify"` (NumericInput.tsx:230).
 * - `hasOverriddenClass`: true if the wrapper has `cortex-numeric-input--overridden`.
 *   Mutually exclusive with stale (NumericInput.tsx:239): `overridden && !stale`.
 */
export interface NumericInputStaleState {
  stale: boolean
  tooltipText: string | null
  hasOverriddenClass: boolean
}

/**
 * Snapshot the stale indicator state of a NumericInput in the Panel's Shadow
 * DOM. Returns `{ stale: false, tooltipText: null, hasOverriddenClass: false }`
 * when the shadow root is not reachable or no matching control is found.
 *
 * Selector strategy: in the current Panel design only one element is selected
 * at a time, so any `.cortex-numeric-input` in the shadow root belongs to that
 * selected element. When `property` is omitted, the first `.cortex-numeric-input`
 * is returned (caller asserts which property). When `property` is provided, the
 * lookup matches the control's `__label` text exactly (case-insensitive equality
 * after trim). Empty/missing labels never match — a missing label fails loudly
 * instead of silently picking the wrong control.
 *
 * Future-extension: when the Panel grows to render multiple selections at once,
 * add a `source` parameter and scope the lookup via the selection metadata. Not
 * adding it now to avoid a tautological dead arg.
 *
 * @param property - Optional label text (case-insensitive exact match after
 *   trim) to disambiguate when multiple controls are visible. The label text
 *   is the abbreviated section label (e.g. `"T"` for padding-top, set in the
 *   parent section's `<span class="cortex-numeric-input__label">`). When the
 *   property doesn't match any non-empty label, the helper returns the empty
 *   default (`stale: false`) so callers see a falsifiable failure.
 */
export async function getNumericInputStaleState(
  page: Page,
  property?: string,
): Promise<NumericInputStaleState> {
  return await page.evaluate(
    (prop) => {
      const host = document.querySelector('[data-cortex-host]')
      const root = host && (host as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
      if (!root) return { stale: false, tooltipText: null, hasOverriddenClass: false }

      const allInputs = Array.from(root.querySelectorAll('.cortex-numeric-input'))
      if (allInputs.length === 0) return { stale: false, tooltipText: null, hasOverriddenClass: false }

      let target: Element | null = null

      if (prop) {
        // Match by exact label text (case-insensitive). Empty/missing labels
        // never match — a missing label would otherwise tautologically match
        // every property because "" is the prefix of any string. No silent
        // fallback to first-stale: a wrong-call site MUST fail loudly so the
        // assertion is falsifiable.
        const propLower = prop.toLowerCase()
        target = allInputs.find((el) => {
          const labelEl = el.querySelector('.cortex-numeric-input__label')
          const labelText = labelEl?.textContent?.toLowerCase().trim() ?? ''
          return labelText.length > 0 && labelText === propLower
        }) ?? null
      } else {
        // No property filter — return the first control. Caller asserts which
        // property they expect (sub-issue D selects exactly one element with
        // a single relevant control).
        target = allInputs[0] ?? null
      }

      if (!target) return { stale: false, tooltipText: null, hasOverriddenClass: false }

      return {
        stale: target.classList.contains('cortex-numeric-input--stale'),
        tooltipText: (target as HTMLElement).dataset['tooltip'] ?? null,
        hasOverriddenClass: target.classList.contains('cortex-numeric-input--overridden'),
      }
    },
    property ?? null,
  )
}
