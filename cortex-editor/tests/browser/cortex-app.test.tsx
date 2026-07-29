import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { CortexApp } from '../../src/browser/components/CortexApp.js'
import { createShadowHost, createMockChannel, mockGetBoundingClientRect, dispatchKeyboardEvent, dispatchPointerEvent, cleanDocumentHead } from './helpers.js'
import * as focusUtils from '../../src/browser/focus-utils.js'
import { _resetBusForTesting } from '../../src/browser/override-bus.js'
import { _resetTransformBusForTesting } from '../../src/browser/transform-bus.js'
import { _resetPopoverStackForTesting } from '../../src/browser/popover-stack.js'

const WAIT_FOR_COMMIT_MS = 2000

// Mock the selection module to verify it's called correctly.
// _resetCallbacks nulls the module-scope hoverCb/selectCb closure so a prior
// test's unmounted-component callbacks cannot be returned by _getCallbacks
// under async timing — call from afterEach (ZF0-1297 test-hygiene fix).
//
// selectCb now receives (elements: Element[], action: 'replace' | 'add' | 'toggle').
// Tests that need to select a single element use: selectCb([target], 'replace')
// Tests that need to clear selection use: selectCb([], 'replace')
// For back-compat with existing tests, a selectOne(el) helper is also exported.
vi.mock('../../src/browser/selection.js', () => {
  const cleanupFn = vi.fn()
  const setDesignModeFn = vi.fn()
  const setInterceptClicksFn = vi.fn()
  let hoverCb: ((el: Element | null) => void) | null = null
  let selectCb: ((elements: Element[], action: 'replace' | 'add' | 'toggle') => void) | null = null

  return {
    initSelection: vi.fn((_shadow: ShadowRoot, onHover: (el: Element | null) => void, onSelect: (elements: Element[], action: 'replace' | 'add' | 'toggle') => void) => {
      hoverCb = onHover
      selectCb = onSelect
      return { cleanup: cleanupFn, setDesignMode: setDesignModeFn, setInterceptClicks: setInterceptClicksFn }
    }),
    _getCallbacks: () => ({ hoverCb, selectCb }),
    _resetCallbacks: () => { hoverCb = null; selectCb = null },
    _cleanup: cleanupFn,
  }
})

// Import the mocked module to access internals
import { initSelection } from '../../src/browser/selection.js'

// ZF0-1564: spy on the selected-element refresh callback so the HMR file-list
// filter tests can assert "the gated refresh path did not fire" against a
// specific function rather than a global side-effect count. The passthrough
// keeps the real implementation for tests that exercise re-resolution end-to-end
// (related-files cases); the spy only captures whether/how often the function
// was invoked. Replaces brittle `expect(gcs.mock.calls.length).toBe(before)`
// assertions that flaked under coverage instrumentation.
vi.mock('../../src/browser/selection-metadata.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/browser/selection-metadata.js')>()
  return {
    ...actual,
    reResolveSelection: vi.fn(actual.reResolveSelection),
  }
})

// Import the mocked module to access the spy
import { reResolveSelection } from '../../src/browser/selection-metadata.js'

describe('CortexApp', () => {
  let root: HTMLDivElement
  let shadow: ShadowRoot
  let cleanupHost: (() => void) | null = null
  const orphans: HTMLElement[] = []

  afterEach(async () => {
    if (root) render(null, root)
    cleanupHost?.()
    cleanupHost = null
    for (const el of orphans) el.remove()
    orphans.length = 0
    // Sweep any data-cortex-source elements that leaked out of `orphans`
    // tracking (e.g., from a test that threw before push). Without this,
    // stale elements survive into the next test and pollute document-level
    // queries in selection-metadata helpers, producing intermittent failures.
    for (const el of document.querySelectorAll('[data-cortex-source]')) el.remove()
    // Clear data-cortex-active on documentElement — CortexApp.tsx:723-725 sets
    // this while active=true; if a test unmounts while active, the attribute
    // persists across tests and can affect selectors in subsequent tests.
    document.documentElement.removeAttribute('data-cortex-active')
    // Clear window debug flags — the try/finally in the ZF0-1293 integration
    // test only protects if the setup block completes; a throw before the flag
    // is set leaks it forever without this safety net.
    delete (window as any).__CORTEX_TEST__
    delete (window as any).__CORTEX_DEBUG_OVERRIDES__
    // Reset cross-test state that persists despite vi.clearAllMocks:
    // module-scope selection-mock closures + override-bus listeners +
    // popover stack + document.head style tags + canary div.
    // See ZF0-1297 Step 12 hygiene fix; extended in ZF0-1332.
    const mod = await import('../../src/browser/selection.js') as unknown as { _resetCallbacks?: () => void }
    mod._resetCallbacks?.()
    _resetBusForTesting()
    _resetTransformBusForTesting()
    _resetPopoverStackForTesting()
    cleanDocumentHead()
    // Defensive real-timer reset — several tests use vi.useFakeTimers() in a
    // try/finally; if the try body throws before the finally runs
    // vi.useRealTimers(), fake timers leak and break subsequent tests.
    vi.useRealTimers()
    // restoreAllMocks (not clearAllMocks) fully uninstalls spies so a
    // spy-wrapping-a-spy can't accumulate across tests. Must be last so the
    // restored original method isn't around while a detached cleanup still fires.
    vi.restoreAllMocks()
  })

  function setup() {
    // Sentinel `data-cortex-source` element — keeps NoAnnotationsBanner's
    // initial `hasAnnotation()` check returning true, so the banner never
    // mounts visible and never attaches a MutationObserver. Without this,
    // every test that adds annotated fixtures via createEditableDiv() or
    // setAttribute('data-cortex-source', ...) triggers the banner's observer,
    // which calls setHidden(true), causing CortexApp's transform-wrapper to
    // shift mid-test. The shift races test assertions and produces flaky
    // "expected null not to be null" failures across this file. Idempotent —
    // safe to call multiple times per test session.
    if (!document.querySelector('[data-cortex-source="__cortex-app-test-sentinel__"]')) {
      const sentinel = document.createElement('div')
      sentinel.setAttribute('data-cortex-source', '__cortex-app-test-sentinel__')
      sentinel.style.display = 'none'
      document.body.appendChild(sentinel)
    }
    const sh = createShadowHost()
    root = sh.root
    shadow = sh.shadow
    cleanupHost = sh.cleanup
    return sh
  }

  async function activateEditor(channel: ReturnType<typeof createMockChannel>) {
    await vi.waitFor(() => {
      expect(channel._handlerCount()).toBeGreaterThan(0)
    }, { timeout: WAIT_FOR_COMMIT_MS })
    await act(async () => {
      channel._simulateMessage({ type: 'cortex' } as any)
    })
    await vi.waitFor(() => {
      expect(root.querySelector('.cortex-toolbar')).not.toBeNull()
    }, { timeout: WAIT_FOR_COMMIT_MS })
  }

  it('renders without crash', () => {
    setup()
    const channel = createMockChannel()
    expect(() => {
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    }).not.toThrow()
  })

  it('calls initSelection on mount with shadow root', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)

    // Wait for useEffect to fire
    await new Promise(r => setTimeout(r, 10))

    expect(initSelection).toHaveBeenCalledWith(
      shadow,
      expect.any(Function),
      expect.any(Function),
    )
  })

  it('hover callback updates HoverOverlay', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 10))
    await activateEditor(channel)

    // Get the hover callback passed to initSelection
    const { _getCallbacks } = await import('../../src/browser/selection.js') as unknown as {
      _getCallbacks: () => { hoverCb: (el: HTMLElement | null) => void }
    }
    const { hoverCb } = _getCallbacks()

    // Create a target element with mocked rect
    const target = document.createElement('div')
    target.className = 'test-target'
    document.body.appendChild(target)
    orphans.push(target)
    mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })

    // Trigger hover
    hoverCb(target)
    await vi.waitFor(() => {
      expect(root.querySelector('.cortex-hover-overlay')).not.toBeNull()
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  it('select callback updates SelectionOverlay', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 10))
    await activateEditor(channel)

    const { _getCallbacks } = await import('../../src/browser/selection.js') as unknown as {
      _getCallbacks: () => { selectCb: (elements: Element[], action: 'replace' | 'add' | 'toggle') => void }
    }
    const { selectCb } = _getCallbacks()

    const target = document.createElement('div')
    document.body.appendChild(target)
    orphans.push(target)
    mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })

    selectCb([target], 'replace')

    await vi.waitFor(() => {
      expect(root.querySelector('.cortex-selection-overlay')).not.toBeNull()
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  it('creates CSSOverrideManager on mount', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 10))

    await vi.waitFor(() => {
      const styleEl = document.head.querySelector('[data-cortex-override]')
      expect(styleEl).not.toBeNull()
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  it('subscribes to channel.onMessage', async () => {
    setup()
    const channel = createMockChannel()
    const spy = vi.spyOn(channel, 'onMessage')
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(expect.any(Function))
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  it('cleanup calls onMessage unsubscribe', async () => {
    setup()
    const channel = createMockChannel()
    const unsubscribe = vi.fn()
    const onMessageSpy = vi.spyOn(channel, 'onMessage').mockReturnValue(unsubscribe)
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await vi.waitFor(() => {
      expect(onMessageSpy).toHaveBeenCalledWith(expect.any(Function))
    }, { timeout: WAIT_FOR_COMMIT_MS })

    // Unmount to trigger cleanup
    render(null, root)
    await vi.waitFor(() => {
      expect(unsubscribe).toHaveBeenCalled()
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  it('switching elements clears state overrides', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 10))
    await activateEditor(channel)

    const { _getCallbacks } = await import('../../src/browser/selection.js') as unknown as {
      _getCallbacks: () => { selectCb: (elements: Element[], action: 'replace' | 'add' | 'toggle') => void }
    }
    const { selectCb } = _getCallbacks()

    // Select element A
    const elA = document.createElement('div')
    elA.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
    document.body.appendChild(elA)
    orphans.push(elA)
    mockGetBoundingClientRect(elA, { top: 50, left: 50, width: 100, height: 40 })

    selectCb([elA], 'replace')
    // Verify CSSOverrideManager style element exists
    const styleEl = await vi.waitFor(() => {
      const el = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(el).not.toBeNull()
      return el
    }, { timeout: WAIT_FOR_COMMIT_MS })

    // Inject state override content to make the assertion falsifiable.
    // clearStateOverrides() calls rebuild() which regenerates from the internal maps.
    // If clearStateOverrides is NOT called on element switch, this content persists.
    styleEl.textContent = '[data-cortex-source="Hero.tsx:5:3"] { color: red !important; }'
    expect(styleEl.textContent).not.toBe('')

    // Select element B — clearStateOverrides → rebuild() should clear the style tag
    const elB = document.createElement('div')
    elB.setAttribute('data-cortex-source', 'Card.tsx:10:1')
    document.body.appendChild(elB)
    orphans.push(elB)
    mockGetBoundingClientRect(elB, { top: 150, left: 50, width: 100, height: 40 })

    selectCb([elB], 'replace')

    // Wait for clearStateOverrides → rebuild() effect to fire. A fixed
    // setTimeout(10) flaked under CI load on GitHub Linux runners; vi.waitFor
    // polls until the assertion holds, bounded by the timeout.
    await vi.waitFor(() => {
      expect(styleEl.textContent).toBe('')
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  it('cleans up on unmount', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)

    // Wait for the mount effect to actually run before unmounting. The effect
    // appends the CSSOverrideManager style element and registers the teardown
    // (selectionHandle.cleanup / dispose). A bare setTimeout(10) raced the
    // effect-flush tick under Node-20 coverage instrumentation on CI — unmount
    // then had no registered cleanup to call. Polling for the override element
    // proves the effect committed. Mirrors the vi.waitFor fix on the test above.
    await vi.waitFor(() => {
      expect(document.head.querySelector('[data-cortex-override]')).not.toBeNull()
    }, { timeout: WAIT_FOR_COMMIT_MS })

    const { _cleanup } = await import('../../src/browser/selection.js') as unknown as {
      _cleanup: ReturnType<typeof vi.fn>
    }

    // Unmount
    render(null, root)
    await vi.waitFor(() => {
      expect(_cleanup).toHaveBeenCalled()
      // CSSOverrideManager should be disposed (style element removed)
      expect(document.head.querySelector('[data-cortex-override]')).toBeNull()
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  it('renders toolbar even without selection', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 20))
    await activateEditor(channel)
    await vi.waitFor(() => {
      expect(root.querySelector('.cortex-toolbar')).not.toBeNull()
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  it('starts inactive — no toolbar or overlays rendered', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 10))
    expect(root.querySelector('.cortex-toolbar')).toBeNull()
  })

  it('activates when receiving cortex message', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 10))
    channel._simulateMessage({ type: 'cortex' } as any)
    await vi.waitFor(() => {
      expect(root.querySelector('.cortex-toolbar')).not.toBeNull()
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  // --- Esc cascade tests (ZF0-1869, Task 15) ---
  // Priority 4 (deactivate) was re-added per ZF0-1869's selection-first redesign.
  // These tests exercise the full cascade and guard against regression.

  it('Esc cascade Priority 4: Escape with nothing selected/focused deactivates Cortex', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await activateEditor(channel)

    // Ensure no Cortex input is focused, no host input, no selection, no comment mode
    vi.spyOn(focusUtils, 'isCortexUIFocused').mockReturnValue(false)
    vi.spyOn(focusUtils, 'isInputFocused').mockReturnValue(false)
    vi.spyOn(focusUtils, 'isRealEvent').mockReturnValue(true)

    dispatchKeyboardEvent(window, 'keydown', { key: 'Escape' })

    // Priority 4 fires: Cortex must deactivate (cortex-closed sent, toolbar gone)
    await vi.waitFor(() => {
      expect(channel._lastSent).toContainEqual({ type: 'cortex-closed' })
    }, { timeout: WAIT_FOR_COMMIT_MS })
    await vi.waitFor(() => {
      expect(root.querySelector('.cortex-toolbar')).toBeNull()
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  it('Esc cascade Priority 1: Escape with a Cortex input focused blurs it and stays active', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await activateEditor(channel)

    // Create a fake Cortex UI input element and focus it
    const input = document.createElement('input')
    shadow.appendChild(input)
    input.focus()

    // Mock: Cortex UI is focused (Priority 1 guard passes), no open popover
    vi.spyOn(focusUtils, 'isCortexUIFocused').mockReturnValue(true)
    vi.spyOn(focusUtils, 'isRealEvent').mockReturnValue(true)
    // Mock getDeepActiveElement to return our input
    vi.spyOn(focusUtils, 'getDeepActiveElement').mockReturnValue(input)

    const blurSpy = vi.spyOn(input, 'blur')

    dispatchKeyboardEvent(window, 'keydown', { key: 'Escape' })
    await new Promise(r => setTimeout(r, 10))

    // Priority 1: input was blurred, Cortex stays active
    expect(blurSpy).toHaveBeenCalledOnce()
    expect(root.querySelector('.cortex-toolbar')).not.toBeNull()
    expect(channel._lastSent).not.toContainEqual({ type: 'cortex-closed' })

    input.remove()
  })

  it('Esc cascade host-app passthrough: Escape with a host-app input focused is a no-op for Cortex', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await activateEditor(channel)

    // Simulate host-app input focused (not Cortex UI)
    vi.spyOn(focusUtils, 'isInputFocused').mockReturnValue(true)
    vi.spyOn(focusUtils, 'isCortexUIFocused').mockReturnValue(false)
    vi.spyOn(focusUtils, 'isRealEvent').mockReturnValue(true)

    dispatchKeyboardEvent(window, 'keydown', { key: 'Escape' })
    await new Promise(r => setTimeout(r, 10))

    // Cortex must not deactivate — host owns the Escape
    expect(channel._lastSent).not.toContainEqual({ type: 'cortex-closed' })
    expect(root.querySelector('.cortex-toolbar')).not.toBeNull()
  })

  it('annotation-created message renders pin dot for pinned annotation', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 10))
    await activateEditor(channel)

    // Create a DOM element the pin can find
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
    document.body.appendChild(target)
    orphans.push(target)
    mockGetBoundingClientRect(target, { top: 100, left: 100, width: 200, height: 50 })

    const annotation = {
      id: 'ann-1',
      status: 'pending' as const,
      elementSource: 'Hero.tsx:5:3',
      text: 'Make this bigger',
      pinPosition: { x: 0.5, y: 0.5 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      thread: [],
    }
    channel._simulateMessage({ type: 'annotation-created', annotation })

    // Wait for Preact render cycle to commit the pin dot. Fixed timeout
    // flaked under CI load on Node 20 Linux runners.
    const pinDot = await vi.waitFor(() => {
      const el = root.querySelector('.cortex-pin')
      expect(el).not.toBeNull()
      return el
    }, { timeout: WAIT_FOR_COMMIT_MS })
    expect(pinDot).not.toBeNull()
  })

  it('Escape with selection deselects but does not exit', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await activateEditor(channel)

    // Simulate element selection
    const { _getCallbacks } = await import('../../src/browser/selection.js') as any
    const { selectCb } = _getCallbacks()
    expect(selectCb).toBeTypeOf('function')
    const target = document.createElement('div')
    document.body.appendChild(target)
    orphans.push(target)
    mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })
    selectCb([target], 'replace')
    await vi.waitFor(() => {
      expect(root.querySelector('.cortex-selection-overlay')).not.toBeNull()
    }, { timeout: WAIT_FOR_COMMIT_MS })

    // Escape deselects, not exits (mock isRealEvent for cascading handler)
    vi.spyOn(focusUtils, 'isRealEvent').mockReturnValue(true)
    dispatchKeyboardEvent(window, 'keydown', { key: 'Escape' })

    await vi.waitFor(() => {
      expect(root.querySelector('.cortex-toolbar')).not.toBeNull() // still active
      expect(root.querySelector('.cortex-selection-overlay')).toBeNull() // deselected
    }, { timeout: WAIT_FOR_COMMIT_MS })
    expect(channel._lastSent).not.toContainEqual({ type: 'cortex-closed' })
  })

  it('thread reply sends comment-reply with annotationId, not a new comment', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 10))
    await activateEditor(channel)

    // Create target element with pin
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
    document.body.appendChild(target)
    orphans.push(target)
    mockGetBoundingClientRect(target, { top: 100, left: 100, width: 200, height: 50 })

    const annotation = {
      id: 'ann-reply-test',
      status: 'pending' as const,
      elementSource: 'Hero.tsx:5:3',
      text: 'Make this bigger',
      pinPosition: { x: 0.5, y: 0.5 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      thread: [],
    }
    channel._simulateMessage({ type: 'annotation-created', annotation })
    await new Promise(r => setTimeout(r, 50))

    // Click pin to open thread
    const pinDot = root.querySelector('.cortex-pin') as HTMLDivElement
    expect(pinDot).not.toBeNull()
    pinDot.click()
    await new Promise(r => setTimeout(r, 10))

    // Type reply in thread input
    const replyInput = root.querySelector('.cortex-thread__reply') as HTMLInputElement
    expect(replyInput).not.toBeNull()
    replyInput.value = 'How much bigger?'
    replyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 10))

    // Clear sent messages to isolate the reply
    channel._lastSent.length = 0

    // Press Enter to submit reply
    replyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => {
      // Verify it sends comment-reply, NOT comment
      expect(channel._lastSent).toHaveLength(1)
      const msg = channel._lastSent[0] as any
      expect(msg.type).toBe('comment-reply')
      expect(msg.annotationId).toBe('ann-reply-test')
      expect(msg.text).toBe('How much bigger?')
      // Should NOT have elementSource (that's the old comment pattern)
      expect(msg.elementSource).toBeUndefined()
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  describe('error tracking', () => {
    /** Helper: mount CortexApp, activate, select element, return refs. */
    async function setupWithSelectedElement() {
      const { _getCallbacks } = await import('../../src/browser/selection.js') as any
      const { selectCb } = _getCallbacks()

      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
      document.body.appendChild(target)
      orphans.push(target)
      mockGetBoundingClientRect(target, { top: 50, left: 50, width: 200, height: 100 })

      // Error cards are scoped to the selected element source, so wait for
      // the selected Panel commit before injecting edit_status messages.
      await act(async () => {
        selectCb([target], 'replace')
      })
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      return target
    }

    it('edit_status:failed populates editErrors and renders error card', async () => {
      // Decoupled from scrub UI path (ZF0-1451): scrub commits now go to staging buffer,
      // not channel.send. Seed editDispatchRef directly via the test bridge.
      ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))
      await activateEditor(channel)

      await setupWithSelectedElement()

      // Synthetic edit dispatch — simulates what the Apply gesture will eventually do.
      const editId = 'test-edit-failed-1'
      const testBridge = (window as any).__CORTEX_TEST__ as { handleEditDispatch: (id: string, src: string, prop: string, val: string) => void }
      await act(async () => {
        testBridge.handleEditDispatch(editId, 'Hero.tsx:5:3', 'padding-bottom', '16px')
        // Simulate server failure for this edit
        channel._simulateMessage({ type: 'edit_status', editId, status: 'failed', reason: 'CSS parse error' })
      })
      await vi.waitFor(() => {
        // Error card should be visible
        const errorCard = root.querySelector('.cortex-error-card')
        expect(errorCard).not.toBeNull()
        expect(errorCard!.textContent).toContain('edit failed')
        expect(errorCard!.textContent).toContain('CSS parse error')
      }, { timeout: WAIT_FOR_COMMIT_MS })
    })

    it('ZF0-1293: divergence with diagnostics flows end-to-end to Debug disclosure', async () => {
      // Integration test for the diagnostics wiring: if CortexApp.tsx drops
      // the `diagnostics: d.diagnostics` pass-through on the EditError, the
      // Debug disclosure in EditErrorCard would silently stop receiving data
      // in production. Each unit test layer (override.ts emits, EditErrorCard
      // renders) would still pass. This test closes that gap by driving the
      // full path: emitDivergence → CortexApp handler → EditError map →
      // EditErrorCard filter → DebugDisclosure render.
      ;(window as unknown as { __CORTEX_DEBUG_OVERRIDES__: boolean }).__CORTEX_DEBUG_OVERRIDES__ = true
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))
      await activateEditor(channel)

      await setupWithSelectedElement()
      const { emitDivergence } = await import('../../src/browser/override-bus.js')

      emitDivergence({
        source: 'Hero.tsx:5:3', // matches setupWithSelectedElement's source
        property: 'padding-bottom',
        expected: '16px',
        actual: '30px',
        diagnostics: {
          actualReadFrom: 'inline-style',
          kindUsed: 'jsx-immediate',
          priorValues: ['24px', '30px', '16px'],
          retryDurationMs: 812,
        },
      })
      await vi.waitFor(() => {
        const card = root.querySelector('.cortex-error-card')
        expect(card).not.toBeNull()
        const debug = card!.querySelector('.cortex-error-card__debug')
        expect(debug).not.toBeNull()
        // Falsifiability: assertions below fail if the pass-through in
        // CortexApp.tsx is removed (err.diagnostics becomes undefined →
        // DebugDisclosure is not rendered). We test that the DATA reached
        // the disclosure, not the FORMATTING (that's edit-error-card.test's
        // job — asserting the arrow separator here would couple this
        // integration test to a presentation detail).
        expect(debug!.textContent).toContain('inline-style')
        expect(debug!.textContent).toContain('jsx-immediate')
        expect(debug!.textContent).toContain('24px')
        expect(debug!.textContent).toContain('30px')
        expect(debug!.textContent).toContain('16px')
        expect(debug!.textContent).toContain('812') // retry duration number
      }, { timeout: WAIT_FOR_COMMIT_MS })
    })
  })

  describe('C1 regression: close→reopen cycle (ZF0-1363)', () => {
    // This test would fail without the C1 fix. The bug: cortex-close left
    // reducerStateRef.active===true while React active===false, so a subsequent
    // {type:'cortex'} hit the idempotent short-circuit and never re-opened.
    it('editor re-opens after being closed via cortex-close message', async () => {
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))

      // Step 1: Activate — toolbar visible
      channel._simulateMessage({ type: 'cortex' } as any)
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-toolbar')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Step 2: Close via cortex-close — toolbar hidden
      channel._simulateMessage({ type: 'cortex-close' } as any)
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-toolbar')).toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Step 3: Re-open — without the C1 fix, the reducer sees active===true in
      // its ref and short-circuits, so the toolbar never re-appears.
      channel._simulateMessage({ type: 'cortex' } as any)
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-toolbar')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })
    })
  })

  describe('I1 regression: skip-path wiring (ZF0-1363)', () => {
    it('edit_status:writing does not throw and does not consume dispatch entry', async () => {
      // Decoupled from scrub UI path (ZF0-1451): scrub commits now go to staging buffer,
      // not channel.send. Seed editDispatchRef directly via the test bridge.
      ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
      setup()
      const channel = createMockChannel()
      const warnSpy = vi.spyOn(console, 'warn')
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))
      await activateEditor(channel)

      // Select an element so the Panel renders and error cards are visible.
      // Source 'Hero.tsx:5:3' must match the handleEditDispatch source below
      // (EditErrorCard filters errors by elementSource).
      const { _getCallbacks: _getCb1 } = await import('../../src/browser/selection.js') as any
      const { selectCb: selectCb1 } = _getCb1()
      const target1 = document.createElement('div')
      target1.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
      document.body.appendChild(target1)
      orphans.push(target1)
      mockGetBoundingClientRect(target1, { top: 50, left: 50, width: 100, height: 40 })
      selectCb1([target1], 'replace')
      await new Promise(r => setTimeout(r, 50))

      // Synthetic edit dispatch — simulates what the Apply gesture will eventually do.
      // Source must match the selected element's data-cortex-source ('Hero.tsx:5:3').
      const trackedEditId = 'test-edit-writing-1'
      const testBridge = (window as any).__CORTEX_TEST__ as { handleEditDispatch: (id: string, src: string, prop: string, val: string) => void }
      testBridge.handleEditDispatch(trackedEditId, 'Hero.tsx:5:3', 'display', 'flex')

      // Send writing — must be silently skipped (no dispatch entry consumed, no throw)
      channel._simulateMessage({ type: 'edit_status', editId: trackedEditId, status: 'writing' } as any)
      await new Promise(r => setTimeout(r, 10))

      // No reducer-exhaustive throw should surface as console.warn
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled cortex-app-reducer'))

      // Entry survived — a subsequent failed status should produce an error card
      channel._simulateMessage({ type: 'edit_status', editId: trackedEditId, status: 'failed', reason: 'post-writing-fail' } as any)
      await vi.waitFor(() => {
        const card = root.querySelector('.cortex-error-card')
        expect(card).not.toBeNull()
        expect(card!.textContent).toContain('post-writing-fail')
      }, { timeout: WAIT_FOR_COMMIT_MS })
    })

    it('edit_status:cancelled does not throw and does not consume dispatch entry', async () => {
      // Decoupled from scrub UI path (ZF0-1451): scrub commits now go to staging buffer,
      // not channel.send. Seed editDispatchRef directly via the test bridge.
      ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
      setup()
      const channel = createMockChannel()
      const warnSpy = vi.spyOn(console, 'warn')
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))
      await activateEditor(channel)

      // Select an element so the Panel renders and error cards are visible.
      // Source 'Hero.tsx:5:3' must match the handleEditDispatch source below
      // (EditErrorCard filters errors by elementSource).
      const { _getCallbacks: _getCb2 } = await import('../../src/browser/selection.js') as any
      const { selectCb: selectCb2 } = _getCb2()
      const target2 = document.createElement('div')
      target2.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
      document.body.appendChild(target2)
      orphans.push(target2)
      mockGetBoundingClientRect(target2, { top: 50, left: 50, width: 100, height: 40 })
      selectCb2([target2], 'replace')
      await new Promise(r => setTimeout(r, 50))

      // Synthetic edit dispatch — simulates what the Apply gesture will eventually do.
      // Source must match the selected element's data-cortex-source ('Hero.tsx:5:3').
      const trackedEditId = 'test-edit-cancelled-1'
      const testBridge = (window as any).__CORTEX_TEST__ as { handleEditDispatch: (id: string, src: string, prop: string, val: string) => void }
      testBridge.handleEditDispatch(trackedEditId, 'Hero.tsx:5:3', 'display', 'grid')

      // Send cancelled — must be silently skipped
      channel._simulateMessage({ type: 'edit_status', editId: trackedEditId, status: 'cancelled' } as any)
      await new Promise(r => setTimeout(r, 10))

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled cortex-app-reducer'))

      // Entry survived — proven by sending failed after cancelled and asserting
      // the error card surfaces with the dispatch entry's reason. (Without the
      // dispatch entry, failed would only emit a log_warning, not an error card.)
      channel._simulateMessage({ type: 'edit_status', editId: trackedEditId, status: 'failed', reason: 'post-cancelled-fail' } as any)
      await vi.waitFor(() => {
        const card = root.querySelector('.cortex-error-card')
        expect(card).not.toBeNull()
        expect(card!.textContent).toContain('post-cancelled-fail')
      }, { timeout: WAIT_FOR_COMMIT_MS })
    })

    it('error channel message does not throw and does not reach reducer', async () => {
      setup()
      const channel = createMockChannel()
      const warnSpy = vi.spyOn(console, 'warn')
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))

      // Send an error message — should be silently dropped before reaching the reducer
      channel._simulateMessage({ type: 'error', code: 'AUTH_FAILED', message: 'test error' } as any)
      await new Promise(r => setTimeout(r, 10))

      // The reducer's exhaustive throw would surface as a thrown error — not a
      // console.warn. We verify nothing unexpected was warned either way.
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled cortex-app-reducer'))
    })

    it('staged-edits-discard channel message does not throw and does not reach reducer', async () => {
      // Pins the early-return at CortexApp.tsx — Panel.tsx owns this message
      // (mirrors the discard into the canonical buffer). If the early-return
      // is removed, the reducer's exhaustive throw at cortex-app-reducer.ts
      // would fire on every cortex_discard_edits call, surfacing as a
      // console.warn from channel.ts:46. The error pattern guard is a
      // load-bearing assertion: a regression that drops the guard would
      // emit "Unhandled cortex-app-reducer action: staged-edits-discard".
      setup()
      const channel = createMockChannel()
      const warnSpy = vi.spyOn(console, 'warn')
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))

      channel._simulateMessage({ type: 'staged-edits-discard', intentIds: ['some-id'] } as any)
      await new Promise(r => setTimeout(r, 10))

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled cortex-app-reducer'))
    })

    it('staged-edits-acked channel message does not throw and does not reach reducer', async () => {
      // Pins the early-return at CortexApp.tsx for ZF0-1469's new ack variant.
      // The ack is consumed by channel.sendAndAck's one-shot listener — it
      // resolves the pending Apply Promise via requestId correlation. If the
      // early-return is removed, the reducer's exhaustive throw at
      // cortex-app-reducer.ts would fire on every Apply, surfacing as a
      // console.warn from channel.ts:46.
      setup()
      const channel = createMockChannel()
      const warnSpy = vi.spyOn(console, 'warn')
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))

      channel._simulateMessage({ type: 'staged-edits-acked', requestId: 'test-req-id' } as any)
      await new Promise(r => setTimeout(r, 10))

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled cortex-app-reducer'))
    })

    it('source-edit-failed channel message does not throw and does not reach reducer (ZF0-1869 integration gap)', async () => {
      // Pins the early-return at CortexApp.tsx for Change 7's source-edit-failed variant.
      // CortexApp.tsx owns this message — its onMessage handler sets applyError so the
      // failure banner survives Panel unmount (lifted from Panel in Step-4 FIX 1).
      // CortexApp must not pass it to the reducer — if the early-return is absent, the
      // reducer's exhaustive default throws and channel.ts swallows it as a console.warn
      // on every cortex_report_source_edit_failed call.
      //
      // Falsifiability: without the allowlist entry, the reducer throws
      // "Unhandled cortex-app-reducer action: source-edit-failed", channel.ts
      // swallows it and emits console.warn('[cortex] Message handler error: Unhandled
      // cortex-app-reducer action: source-edit-failed'). The spy would catch that warn
      // and the assertion below would FAIL. With the fix the warn is never emitted.
      setup()
      const channel = createMockChannel()
      const warnSpy = vi.spyOn(console, 'warn')
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))

      channel._simulateMessage({ type: 'source-edit-failed', intentIds: ['intent-1'], reason: 'edit tool failed' } as any)
      await new Promise(r => setTimeout(r, 10))

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled cortex-app-reducer'))
    })
  })

  describe('connection status', () => {
    it('clears reconnected timer if connection drops again', async () => {
      vi.useFakeTimers()
      try {
        setup()
        const channel = createMockChannel()
        await act(() => {
          render(<CortexApp channel={channel} shadowRoot={shadow} initialActive={true} />, root)
        })
        await vi.advanceTimersByTimeAsync(10)

        // Select an element so Panel mounts and ConnectionStatus is visible.
        // (Task 16: Panel is gated on selection; ConnectionStatus lives inside Panel.)
        const { _getCallbacks: _getCbs } = await import('../../src/browser/selection.js') as any
        const { selectCb: _sCb } = _getCbs()
        const _target = document.createElement('div')
        _target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
        document.body.appendChild(_target)
        orphans.push(_target)
        mockGetBoundingClientRect(_target, { top: 50, left: 50, width: 100, height: 40 })
        await act(() => { _sCb([_target], 'replace') })
        await vi.advanceTimersByTimeAsync(10)

        // Simulate: reconnecting → connected (starts 2s timer) → reconnecting (should cancel timer)
        channel._simulateConnectionChange({ status: 'reconnecting', retryCount: 1, maxRetries: 5 })
        await vi.advanceTimersByTimeAsync(10)

        channel._simulateConnectionChange({ status: 'connected' })
        await vi.advanceTimersByTimeAsync(10)

        // Connection drops again before the 2s timer fires
        channel._simulateConnectionChange({ status: 'reconnecting', retryCount: 2, maxRetries: 5 })
        await vi.advanceTimersByTimeAsync(10)

        // Advance past original 2s window — should NOT auto-dismiss to connected
        // because the timer was cancelled on re-disconnect
        await vi.advanceTimersByTimeAsync(2000)

        const footer = root.querySelector('.cortex-connection-status')
        expect(footer).not.toBeNull()
        expect(footer!.classList.contains('cortex-connection-status--reconnecting')).toBe(true)
        expect(footer!.textContent).toContain('Reconnecting')
      } finally {
        vi.useRealTimers()
      }
    })

    it('reconnected footer auto-dismisses after 2s timer fires', async () => {
      // Covers the FIRES branch of the reconnected timer: CortexApp's 2s
      // setTimeout callback must flip connectionStatus from 'reconnected' →
      // 'connected', which hides the footer. The sibling 'clears reconnected
      // timer...' test covers the CANCEL branch; this one covers the fire path.
      //
      // Uses fake timers throughout to drive Preact's macrotask-based render
      // batching deterministically. The earlier real-timers + waitFor variant
      // produced an intermittent CI flake where the reconnecting render hadn't
      // committed by the time waitFor first polled (line 795 null assertion);
      // act() + vi.advanceTimersByTimeAsync replaces the polling race per the
      // ZF0-1387 lineage of flake fixes.
      vi.useFakeTimers()
      try {
        setup()
        const channel = createMockChannel()
        await act(() => {
          render(<CortexApp channel={channel} shadowRoot={shadow} initialActive={true} />, root)
        })
        await vi.advanceTimersByTimeAsync(10)

        // Select an element so Panel mounts and ConnectionStatus is visible.
        // (Task 16: Panel is gated on selection; ConnectionStatus lives inside Panel.)
        const { _getCallbacks: _getCbs2 } = await import('../../src/browser/selection.js') as any
        const { selectCb: _sCb2 } = _getCbs2()
        const _target2 = document.createElement('div')
        _target2.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
        document.body.appendChild(_target2)
        orphans.push(_target2)
        mockGetBoundingClientRect(_target2, { top: 50, left: 50, width: 100, height: 40 })
        await act(() => { _sCb2([_target2], 'replace') })
        await vi.advanceTimersByTimeAsync(10)

        // Reconnecting → marks wasDisconnected=true internally. act() flushes
        // the Preact render synchronously so the footer is visible before
        // we proceed.
        await act(() => {
          channel._simulateConnectionChange({ status: 'reconnecting', retryCount: 1, maxRetries: 5 })
        })
        await vi.advanceTimersByTimeAsync(10)

        const reconnecting = root.querySelector('.cortex-connection-status')
        expect(reconnecting).not.toBeNull()
        expect(reconnecting!.textContent).toContain('Reconnecting')

        // Connected + wasDisconnected → CortexApp flips status to 'reconnected'
        // and starts the 2s auto-dismiss timer.
        await act(() => {
          channel._simulateConnectionChange({ status: 'connected' })
        })
        await vi.advanceTimersByTimeAsync(50)

        const reconnectedFooter = root.querySelector('.cortex-connection-status')
        expect(reconnectedFooter).not.toBeNull()
        expect(reconnectedFooter!.textContent).toContain('Reconnected')
        expect(reconnectedFooter!.classList.contains('cortex-connection-status--reconnected')).toBe(true)

        // Fire the 2s timer — callback must setConnectionStatus('connected'),
        // which hides the footer (empty aria-live container + --hidden class).
        await vi.advanceTimersByTimeAsync(2000)

        const dismissed = root.querySelector('.cortex-connection-status')
        expect(dismissed).not.toBeNull()
        expect(dismissed!.classList.contains('cortex-connection-status--hidden')).toBe(true)
        expect(dismissed!.textContent?.trim()).toBe('')
      } finally {
        vi.useRealTimers()
      }
    })

    it('pushes a full-state sync to the server on reconnect (ZF0-1869)', async () => {
      ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))
      await activateEditor(channel)

      // Select an element + stage an edit so the staging buffer is non-empty.
      const { _getCallbacks } = await import('../../src/browser/selection.js') as any
      const { selectCb } = _getCallbacks()
      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
      document.body.appendChild(target)
      orphans.push(target)
      mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })
      selectCb([target], 'replace')
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      const bridge = (window as any).__CORTEX_TEST__ as {
        stageEdit: (source: string, property: string, value: string) => Promise<string>
        buffer: { size: () => number }
      }
      await act(async () => {
        await bridge.stageEdit('Hero.tsx:5:3', 'color', 'red')
      })
      await vi.waitFor(() => {
        expect(bridge.buffer.size()).toBe(1)
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Drop the message log, then simulate a disconnect → reconnect cycle.
      channel._lastSent.length = 0
      await act(() => {
        channel._simulateConnectionChange({ status: 'reconnecting', retryCount: 1, maxRetries: 5 })
      })
      await act(() => {
        channel._simulateConnectionChange({ status: 'connected' })
      })

      // On reconnect, CortexApp must re-establish the server cache from the
      // browser-canonical buffer with authoritative replace semantics:
      // staged-edit-clear FIRST (so removes done while disconnected are not
      // retained as ghost intents), then staged-edits-sync to repopulate.
      // Without the fix, no resync is emitted and the server cache diverges.
      const types = channel._lastSent
        .filter((m): m is { type: string } => typeof m === 'object' && m !== null && 'type' in m)
        .map(m => m.type)
      const clearIdx = types.indexOf('staged-edit-clear')
      const syncIdx = types.indexOf('staged-edits-sync')
      expect(clearIdx).toBeGreaterThanOrEqual(0)
      expect(syncIdx).toBeGreaterThan(clearIdx) // clear must precede sync
      const syncMsg = channel._lastSent[syncIdx] as { type: string; edits: unknown[] }
      expect(syncMsg.edits).toHaveLength(1)
    })

    it('does NOT resync on a first connect with no prior disconnect (ZF0-1869)', async () => {
      // Pins the wasDisconnected guard: a plain 'connected' event with no
      // preceding disconnected/reconnecting state must NOT emit a resync.
      // Without the guard, the browser would spam the server on every connect.
      ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))
      await activateEditor(channel)

      channel._lastSent.length = 0
      await act(() => {
        channel._simulateConnectionChange({ status: 'connected' })
      })

      const types = channel._lastSent
        .filter((m): m is { type: string } => typeof m === 'object' && m !== null && 'type' in m)
        .map(m => m.type)
      expect(types).not.toContain('staged-edit-clear')
      expect(types).not.toContain('staged-edits-sync')
    })
  })

  describe('panel position reset on deselect (ZF0-1869)', () => {
    it('returns the panel to its home position after drag + deselect + reselect', async () => {
      ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))
      await activateEditor(channel)

      const { _getCallbacks } = await import('../../src/browser/selection.js') as any
      const { selectCb } = _getCallbacks()
      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
      document.body.appendChild(target)
      orphans.push(target)
      mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })

      const panelTransform = (): string => {
        const p = root.querySelector('.cortex-panel') as HTMLElement | null
        return p?.style.transform ?? ''
      }

      // Select → Panel mounts at the default home position (top-right).
      selectCb([target], 'replace')
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })
      const homeTransform = panelTransform()
      expect(homeTransform).toContain('translate(')

      // Drag the panel far from home via the header's pointer handlers (the
      // panel-header is the drag surface — see PanelHeader onPointerDown wiring).
      // happy-dom getBoundingClientRect is 0,0 so the drag delta == clientXY.
      const header = root.querySelector('.cortex-panel-header') as HTMLElement
      await act(() => {
        dispatchPointerEvent(header, 'pointerdown', { clientX: 700, clientY: 200 })
        dispatchPointerEvent(header, 'pointermove', { clientX: 200, clientY: 450 })
        dispatchPointerEvent(header, 'pointerup', { clientX: 200, clientY: 450 })
      })
      await vi.waitFor(() => {
        expect(panelTransform()).not.toBe(homeTransform)
      }, { timeout: WAIT_FOR_COMMIT_MS })
      const draggedTransform = panelTransform()

      // Deselect — the CortexApp deselect effect must fire panelReset().
      await act(() => { selectCb([], 'replace') })
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Reselect — without the reset, useSnapToEdge state (CortexApp-scoped,
      // survives Panel unmount) would still hold draggedTransform.
      await act(() => { selectCb([target], 'replace') })
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })
      expect(panelTransform()).toBe(homeTransform)
      expect(panelTransform()).not.toBe(draggedTransform)
    })

    it('does NOT reset on initial mount — preserves localStorage-restored position (codex post-#142)', async () => {
      // The naive `if (length === 0) panelReset()` body fires on every render
      // where length is 0 — including initial mount. That overwrites the
      // position useSnapToEdge() restored from localStorage. Pin the
      // transition-only semantic: only a non-empty → empty change resets.
      const PORT = location.port || '0'
      const persisted = { x: 100, y: 50 } // not the home (top-right) position
      localStorage.setItem(`cortex:${PORT}:panel-position`, JSON.stringify(persisted))

      try {
        ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
        setup()
        const channel = createMockChannel()
        render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
        await new Promise(r => setTimeout(r, 10))
        await activateEditor(channel)

        const { _getCallbacks } = await import('../../src/browser/selection.js') as any
        const { selectCb } = _getCallbacks()
        const target = document.createElement('div')
        target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
        document.body.appendChild(target)
        orphans.push(target)
        mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })

        selectCb([target], 'replace')
        await vi.waitFor(() => {
          expect(root.querySelector('.cortex-panel')).not.toBeNull()
        }, { timeout: WAIT_FOR_COMMIT_MS })

        const transform = (root.querySelector('.cortex-panel') as HTMLElement).style.transform
        // The persisted position survived — was NOT clobbered by an initial-mount reset.
        expect(transform).toBe(`translate(${persisted.x}px, ${persisted.y}px)`)
      } finally {
        localStorage.removeItem(`cortex:${PORT}:panel-position`)
      }
    })
  })

  describe('Task 2 — buffer hoisted to CortexApp (ZF0-1869)', () => {
    // Falsifiability contract: this test asserts CortexApp owns the staging
    // buffer by verifying the `__CORTEX_TEST__` bridge exposes a
    // `getCortexAppBufferVersion` function that reads buffer.version directly
    // from CortexApp's scope (not from Panel via bufferListRef). Before the
    // hoist, CortexApp has no buffer — the field does not exist on the bridge →
    // the `toBeDefined()` assertion fails. After the hoist, CortexApp creates
    // its own buffer instance and exposes it via the bridge → the field is
    // defined and the version tracks mutations.
    it('CortexApp owns the staging buffer — version readable from CortexApp-level bridge', async () => {
      ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))
      await activateEditor(channel)

      // Select an element so Panel mounts and stageEditRef is populated.
      const { _getCallbacks } = await import('../../src/browser/selection.js') as any
      const { selectCb } = _getCallbacks()
      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
      document.body.appendChild(target)
      orphans.push(target)
      mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })
      selectCb([target], 'replace')
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      const bridge = (window as any).__CORTEX_TEST__ as {
        getCortexAppBufferVersion?: () => number
        stageEdit: (source: string, property: string, value: string) => Promise<string>
        buffer: { list: () => unknown[]; size: () => number }
      }

      // Before hoist: getCortexAppBufferVersion does not exist on the bridge.
      // This assertion is the TDD red-bar. After hoist it becomes green.
      expect(bridge.getCortexAppBufferVersion).toBeDefined()

      const versionBefore = bridge.getCortexAppBufferVersion!()
      expect(typeof versionBefore).toBe('number')

      // Stage an edit — buffer.version must increment so CortexApp's buffer
      // is the live instance receiving mutations (not just Panel's local one).
      await act(async () => {
        await bridge.stageEdit('Hero.tsx:5:3', 'color', 'red')
      })

      await vi.waitFor(() => {
        expect(bridge.getCortexAppBufferVersion!()).toBeGreaterThan(versionBefore)
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // The buffer must also be readable via the existing bridge surface —
      // the hoisted buffer IS the one Panel uses (bufferProp path, not localBuffer).
      expect(bridge.buffer.size()).toBe(1)
    })
  })

  it('ActivityLog is never mounted (removed in Change 3)', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await activateEditor(channel)
    expect(root.querySelector('.cortex-activity-log')).toBeNull()
  })

  describe('Task 16 — Panel gated on selection (ZF0-1869, Change 1)', () => {
    // Panel renders ONLY when Cortex is active AND an element is selected.
    // The Toolbar stays visible regardless. Buffer survives Panel unmount on
    // deselect (buffer is hoisted to CortexApp — Task 2).

    it('Panel NOT rendered when Cortex is active but nothing is selected', async () => {
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await activateEditor(channel)

      // Cortex is active (toolbar visible), nothing selected
      expect(root.querySelector('.cortex-toolbar')).not.toBeNull()
      expect(root.querySelector('.cortex-panel')).toBeNull()
    })

    it('Panel rendered when Cortex is active and an element is selected', async () => {
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await activateEditor(channel)

      const { _getCallbacks } = await import('../../src/browser/selection.js') as any
      const { selectCb } = _getCallbacks()
      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
      document.body.appendChild(target)
      orphans.push(target)
      mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })

      selectCb([target], 'replace')

      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })
    })

    it('Panel unmounts on deselect but buffer survives (Change 1 integration payoff)', async () => {
      ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await activateEditor(channel)

      const { _getCallbacks } = await import('../../src/browser/selection.js') as any
      const { selectCb } = _getCallbacks()
      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
      document.body.appendChild(target)
      orphans.push(target)
      mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })

      // Select an element — Panel should mount
      selectCb([target], 'replace')
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Stage an edit so the buffer has 1 item
      const bridge = (window as any).__CORTEX_TEST__ as {
        stageEdit: (source: string, property: string, value: string) => Promise<string>
        buffer: { list: () => unknown[]; size: () => number }
      }
      await act(async () => {
        await bridge.stageEdit('Hero.tsx:5:3', 'color', 'red')
      })
      await vi.waitFor(() => {
        expect(bridge.buffer.size()).toBe(1)
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Clear selection — Panel should unmount
      await act(async () => {
        selectCb([], 'replace')
      })
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Buffer MUST survive Panel unmount — staged edits are not lost
      expect(bridge.buffer.size()).toBe(1)
    })
  })

  describe('Fix 1 — CortexApp handles staged-edits-discard + source-edit-failed while Panel unmounted (ZF0-1869 Round-1)', () => {
    // FALSIFIABILITY: Before Fix 1, CortexApp had early-returns for both
    // staged-edits-discard and source-edit-failed. With Panel unmounted (no
    // selection), the messages were silently dropped:
    //   • staged-edits-discard → buffer diverged (intent stayed in buffer)
    //   • source-edit-failed   → applyError never set (error was swallowed)
    // After Fix 1, CortexApp owns both handlers unconditionally. These tests
    // target that exact scenario: message arrives while Panel is unmounted.

    it('staged-edits-discard while Panel unmounted removes the intent from CortexApp buffer', async () => {
      ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))
      await activateEditor(channel)

      const { _getCallbacks } = await import('../../src/browser/selection.js') as any
      const { selectCb } = _getCallbacks()
      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
      document.body.appendChild(target)
      orphans.push(target)
      mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })

      // Select element — Panel mounts
      selectCb([target], 'replace')
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Stage an edit so there is an intent in the buffer
      const bridge = (window as any).__CORTEX_TEST__ as {
        stageEdit: (source: string, property: string, value: string) => Promise<string>
        buffer: { list: () => Array<{ intentId: string }>; size: () => number }
      }
      let intentId!: string
      await act(async () => {
        intentId = await bridge.stageEdit('Hero.tsx:5:3', 'color', 'red')
      })
      await vi.waitFor(() => {
        expect(bridge.buffer.size()).toBe(1)
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Deselect — Panel unmounts (the correctness-critical condition)
      await act(async () => {
        selectCb([], 'replace')
      })
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Deliver staged-edits-discard WHILE Panel is unmounted.
      // Before Fix 1: CortexApp had `return` for this message → buffer unchanged.
      // After Fix 1:  CortexApp calls buffer.remove(intentIds) → size drops to 0.
      await act(async () => {
        channel._simulateMessage({ type: 'staged-edits-discard', intentIds: [intentId] } as any)
      })

      // Buffer MUST be 0 — intent removed even though Panel was unmounted
      expect(bridge.buffer.size()).toBe(0)
    })

    it('source-edit-failed while Panel unmounted sets applyError — banner visible after reselect', async () => {
      ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
      setup()
      const channel = createMockChannel()
      render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
      await new Promise(r => setTimeout(r, 10))
      await activateEditor(channel)

      const { _getCallbacks } = await import('../../src/browser/selection.js') as any
      const { selectCb } = _getCallbacks()
      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
      document.body.appendChild(target)
      orphans.push(target)
      mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })

      // Select element — Panel mounts; stage an edit
      selectCb([target], 'replace')
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      const bridge = (window as any).__CORTEX_TEST__ as {
        stageEdit: (source: string, property: string, value: string) => Promise<string>
        buffer: { list: () => Array<{ intentId: string }>; size: () => number }
      }
      await act(async () => {
        await bridge.stageEdit('Hero.tsx:5:3', 'color', 'red')
      })

      // Deselect — Panel unmounts (the correctness-critical condition)
      await act(async () => {
        selectCb([], 'replace')
      })
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Deliver source-edit-failed WHILE Panel is unmounted.
      // Before Fix 1: CortexApp had `return` for this message → applyError never set.
      // After Fix 1:  CortexApp calls setApplyError(msg.reason) → state persists.
      await act(async () => {
        channel._simulateMessage({
          type: 'source-edit-failed',
          intentIds: ['intent-xyz'],
          reason: 'pattern not found at Hero.tsx:31',
        } as any)
      })

      // Re-select the element — Panel remounts and receives applyError prop from CortexApp.
      // If the error was dropped, applyError would be null → no banner.
      // If the error was captured, applyError is set → banner present.
      await act(async () => {
        selectCb([target], 'replace')
      })
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-panel')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })

      // Banner MUST be visible — applyError survived Panel unmount/remount
      await vi.waitFor(() => {
        expect(root.querySelector('.cortex-apply-error')).not.toBeNull()
      }, { timeout: WAIT_FOR_COMMIT_MS })
    })
  })
})

describe('CortexApp — HMR-driven selection re-resolution (ZF0-1292)', () => {
  // Track elements by attribute prefix so we can sweep any stragglers at
  // end-of-test even if a prior run's cleanup missed them. This defends
  // against the cross-test state leak patterns that produce intermittent
  // failures in the combined-run scenario.
  let root: HTMLDivElement
  let shadow: ShadowRoot
  let cleanupHost: (() => void) | null = null
  const orphans: HTMLElement[] = []

  afterEach(async () => {
    if (root) render(null, root)
    cleanupHost?.()
    cleanupHost = null
    for (const el of orphans) el.remove()
    orphans.length = 0
    // Sweep any data-cortex-source elements that leaked out of `orphans`
    // tracking (e.g., from a test that threw before push). Without this,
    // stale elements survive into the next test and pollute document-level
    // queries in selection-metadata helpers, producing intermittent failures.
    for (const el of document.querySelectorAll('[data-cortex-source]')) el.remove()
    document.documentElement.removeAttribute('data-cortex-active')
    delete (window as any).__CORTEX_TEST__
    delete (window as any).__CORTEX_DEBUG_OVERRIDES__
    const mod = await import('../../src/browser/selection.js') as unknown as { _resetCallbacks?: () => void }
    mod._resetCallbacks?.()
    _resetBusForTesting()
    _resetTransformBusForTesting()
    _resetPopoverStackForTesting()
    cleanDocumentHead()
    vi.useRealTimers()
    // restoreAllMocks rather than clearAllMocks to fully uninstall any
    // spies (getComputedStyle, etc.) a failed test may have left behind.
    vi.restoreAllMocks()
  })

  async function setupAndSelect(
    sourceValue: string,
    tag: string,
  ): Promise<{ channel: ReturnType<typeof createMockChannel>; el: HTMLElement }> {
    const sh = createShadowHost()
    root = sh.root
    shadow = sh.shadow
    cleanupHost = sh.cleanup
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 10))

    // Activate editor.
    channel._simulateMessage({ type: 'cortex' } as any)
    await new Promise(r => setTimeout(r, 10))

    // Select an element.
    const { _getCallbacks } = await import('../../src/browser/selection.js') as unknown as {
      _getCallbacks: () => { selectCb: (elements: Element[], action: 'replace' | 'add' | 'toggle') => void }
    }
    const { selectCb } = _getCallbacks()

    const el = document.createElement(tag)
    el.setAttribute('data-cortex-source', sourceValue)
    document.body.appendChild(el)
    orphans.push(el)
    mockGetBoundingClientRect(el, { top: 50, left: 50, width: 100, height: 40 })

    selectCb([el], 'replace')
    await new Promise(r => setTimeout(r, 20))

    return { channel, el }
  }

  // Cascade-only: exercises rAF/setTimeout retry fan-out inside CortexApp.tsx attemptReResolve.
  // No pure-function equivalent — retry logic is bound to the effect.
  it('retries re-resolution via double-rAF when Fast Refresh commit is deferred', async () => {
    // Simulate framework-commit latency: element is STILL connected at the
    // sync-handler tick (Fast Refresh hasn't run yet). The sync pass in the
    // HMR handler early-returns (isConnected === true). Then we defer the
    // actual swap to land between the two rAFs. The async pass should
    // re-check and resolve to the replacement.
    const SOURCE = 'src/deferred.tsx:8:3'
    const { channel, el } = await setupAndSelect(SOURCE, 'p')
    expect(el.isConnected).toBe(true)

    // Fire hmr-applied while the element is still connected.
    channel._simulateMessage({ type: 'hmr-applied' })

    // Between sync pass and double-rAF: defer swap by one microtask so the
    // sync handler has already returned. Then use an rAF to detach+insert
    // the replacement before the retry fires.
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => {
        el.remove()
        const replacement = document.createElement('p')
        replacement.setAttribute('data-cortex-source', SOURCE)
        replacement.textContent = 'Original'
        document.body.appendChild(replacement)
        orphans.push(replacement)
        mockGetBoundingClientRect(replacement, { top: 50, left: 50, width: 100, height: 40 })
        resolve()
      })
    })

    // Wait for the second rAF + Preact commit.
    await vi.waitFor(() => {
      // Falsifiable observable: the Panel stays populated. If the async
      // (double-rAF) pass didn't re-resolve, `selectedElement` would be
      // null (the original <p> was removed), and the Panel would render
      // its empty-state prompt. The tag swap from <p> to <span> via the
      // replacement node is observable through the header label too, but
      // the empty-state guard is the tightest assertion for "async
      // retry actually happened."
      expect(root.textContent).not.toContain('Click any element to start editing')
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })

  // Cascade-only: isConnected early-return + styleVersion bump in CortexApp effect;
  // getComputedStyle re-read is bound to the Preact render cycle, not a pure function.
  it('leaves selection untouched and re-reads computed styles when the selected element is still connected after HMR', async () => {
    // Stylesheet-only HMR case: the element stays in place, but the Panel
    // must still receive the version bump so computed styles re-read.
    // This test guards against both:
    //  (1) An over-eager re-resolver that would clear selection on every HMR cycle.
    //  (2) A silent-no-op where the hmr-applied handler doesn't actually bump
    //      styleVersion (the assertion on (1) alone would still pass).
    const SOURCE = 'src/stable-el.tsx:3:1'

    // Count getComputedStyle invocations as a falsifiable proxy for the re-read.
    // If the bump path is broken, the count stays flat after hmr-applied.
    const gcsSpy = vi.spyOn(window, 'getComputedStyle')

    const { channel, el } = await setupAndSelect(SOURCE, 'div')

    expect(root.textContent).toContain('<div>')
    expect(el.isConnected).toBe(true)
    const gcsBefore = gcsSpy.mock.calls.length
    expect(gcsBefore).toBeGreaterThan(0) // sanity: Panel already read styles on mount

    channel._simulateMessage({ type: 'hmr-applied' })
    await vi.waitFor(() => {
      // (1) Selection preserved — still showing the same element.
      expect(root.textContent).toContain('<div>')
      expect(root.textContent).not.toContain('Click any element to start editing')
      // (2) Panel re-read computed styles — proves the version-bump path fired
      // and propagated through to Panel's computedStyles useMemo invalidation.
      expect(gcsSpy.mock.calls.length).toBeGreaterThan(gcsBefore)
    }, { timeout: WAIT_FOR_COMMIT_MS })

    gcsSpy.mockRestore()
  })
})

describe('CortexApp — HMR file-list filter (ZF0-1292 follow-up)', () => {
  let root: HTMLDivElement
  let shadow: ShadowRoot
  let cleanupHost: (() => void) | null = null
  const orphans: HTMLElement[] = []

  afterEach(async () => {
    if (root) render(null, root)
    cleanupHost?.()
    cleanupHost = null
    for (const el of orphans) el.remove()
    orphans.length = 0
    for (const el of document.querySelectorAll('[data-cortex-source]')) el.remove()
    document.documentElement.removeAttribute('data-cortex-active')
    delete (window as any).__CORTEX_TEST__
    delete (window as any).__CORTEX_DEBUG_OVERRIDES__
    delete (window as any).__cortex_test_get_hmr_applied_version
    const mod = await import('../../src/browser/selection.js') as unknown as { _resetCallbacks?: () => void }
    mod._resetCallbacks?.()
    _resetBusForTesting()
    _resetTransformBusForTesting()
    _resetPopoverStackForTesting()
    cleanDocumentHead()
    vi.useRealTimers()
    // restoreAllMocks (not clearAllMocks) fully resets the file-scope
    // reResolveSelection spy between tests — including its call history,
    // which the `not.toHaveBeenCalled()` assertions in this describe
    // depend on. Without this, a test that threw mid-setup would leak
    // its accumulated calls into the next test's spy state.
    vi.restoreAllMocks()
  })

  /** Render CortexApp, activate, and select an element with the given source.
   *  The file-scope `reResolveSelection` spy (set up at the top of this file
   *  via vi.mock + importOriginal passthrough) is the observable signal for
   *  "selected-element refresh path fired". Tests assert via that spy. */
  async function setup(source: string): Promise<{
    channel: ReturnType<typeof createMockChannel>
    element: HTMLElement
  }> {
    const sh = createShadowHost()
    root = sh.root
    shadow = sh.shadow
    cleanupHost = sh.cleanup
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 10))
    channel._simulateMessage({ type: 'cortex' } as any)
    await new Promise(r => setTimeout(r, 10))

    const { _getCallbacks } = await import('../../src/browser/selection.js') as unknown as {
      _getCallbacks: () => { selectCb: (elements: Element[], action: 'replace' | 'add' | 'toggle') => void }
    }
    const { selectCb } = _getCallbacks()

    const element = document.createElement('div')
    element.setAttribute('data-cortex-source', source)
    element.appendChild(document.createTextNode('target'))
    document.body.appendChild(element)
    orphans.push(element)
    mockGetBoundingClientRect(element, { top: 50, left: 50, width: 100, height: 40 })

    selectCb([element], 'replace')
    // Wait for Panel to fully settle before clearing the spy. Initial mount,
    // override-bus subscription, and Preact's commit phase can fire ambient
    // effects; we want them done BEFORE the test starts asserting against
    // the reResolveSelection spy. Under serial-loop load 20ms wasn't enough.
    await new Promise(r => setTimeout(r, 50))

    // ZF0-1564: clear the file-scope reResolveSelection spy so each test
    // starts with zero recorded calls. Cross-test pollution would otherwise
    // make `not.toHaveBeenCalled()` reflect prior tests, not gate behavior.
    vi.mocked(reResolveSelection).mockClear()
    return { channel, element }
  }

  // ZF0-1564 rename: previously "skips Panel refresh ..." but the assertion only
  // verifies the re-resolution gate at CortexApp.tsx:779, not the version-bump
  // gate at lines 686-688. The version-bump-gate verification is a separate
  // coverage concern tracked as a follow-up (the shared `shouldRefresh` variable
  // means a typical regression breaks BOTH gates and is caught here, but a
  // surgical refactor of one gate alone would be missed).
  it('skips selected-element re-resolution when hmr files are fully unrelated', async () => {
    const { channel } = await setup('src/foo.tsx:10:5')
    channel._simulateMessage({ type: 'hmr-applied', files: ['src/bar.tsx', 'src/baz.tsx'] })

    // ZF0-1564 (audit Finding 2 fix): wait past the gated fan-out's longest
    // scheduling delay. Production at CortexApp.tsx:779-790 contains:
    //   - synchronous attemptReResolve()              (fires at +0)
    //   - requestAnimationFrame → requestAnimationFrame (fires at ~+32ms)
    //   - setTimeout(attemptReResolve, 100)           (fires at +100ms)
    //   - setTimeout(attemptReResolve, 250)           (fires at +250ms)
    // A synchronous assertion at +0 would miss a future regression that
    // moves the rAF/setTimeout schedulers outside the gate while leaving the
    // sync call gated. 260ms is the bounded upper edge of the production
    // code's scheduling window (250 + 10ms buffer for setTimeout drift),
    // NOT an empirical flake bound — increase only if CortexApp.tsx adds a
    // longer scheduler.
    await new Promise(r => setTimeout(r, 260))

    // ZF0-1564: assert against a SPECIFIC function (reResolveSelection) instead
    // of `gcs.mock.calls.length`. Production gate at CortexApp.tsx:779 calls
    // `attemptReResolve()` synchronously inside `if (shouldRefresh)` AND
    // schedules its rAF/setTimeout fan-out inside the same block. When the
    // gate returns false (this test's scenario: no CSS in list, no ancestor
    // match, no own-file match), reResolveSelection is never called.
    // Immune to coverage-instrumentation noise on shared globals — the
    // original gcs.mock.calls.length flaked because coverage probed styles;
    // coverage cannot call reResolveSelection.
    expect(reResolveSelection).not.toHaveBeenCalled()
  })

  // ZF0-1470 (T4 fix-up, IMPORTANT 1): hmrEventVersion always-bumps, even when
  // shouldRefreshOnHMR returns false (unrelated files). The Panel still receives
  // hmrChangedFiles so buffer.reconcile() can check non-selected element sources.
  // Observable: hmrChangedFiles prop contains the unrelated files (not empty) even
  // when the DOM refresh was skipped.
  //
  // Falsifiability fix (ZF0-1480 #6): the previous test only checked absence of
  // side-effects (no crash, no extra gcs call). That assertion passes even if
  // setHmrChangedFiles regressed to setHmrChangedFiles([]) — because with an empty
  // buffer there is nothing to reconcile either way. We now pre-seed a staged intent
  // for a file that IS in the incoming changedFiles list, but whose DOM element does
  // NOT exist → reconcile marks it divergent → intentDriftCount rises to 1 →
  // StagingDriftBanner renders. The banner ONLY renders when hmrChangedFiles is
  // propagated non-empty; if the regression collapses it to [], the early-return
  // branch fires (setIntentDriftCount(0)) and the banner stays hidden.
  it('hmr-applied with unrelated files still propagates hmrChangedFiles for buffer reconcile', async () => {
    // Stage an intent targeting src/Sidebar.tsx — one of the files that the
    // hmr-applied message will carry — but no DOM element with that
    // data-cortex-source is present, so reconcile treats it as divergent
    // (element deleted/refactored). Buffer is memory-only (Change 4), so we
    // stage the edit via the test bridge after mount instead of seeding
    // localStorage.
    ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
    const { channel } = await setup('src/foo.tsx:10:5')

    const bridge = (window as any).__CORTEX_TEST__ as {
      stageEdit: (source: string, property: string, value: string) => Promise<string>
    }
    await act(async () => {
      await bridge.stageEdit('src/Sidebar.tsx:1:1', 'color', 'red')
    })

    // Fire hmr-applied with files that include src/Sidebar.tsx — shouldRefreshOnHMR
    // returns false (src/foo.tsx:10:5 is selected, Sidebar.tsx is unrelated),
    // hmrAppliedVersion stays flat, but hmrEventVersion MUST bump and
    // hmrChangedFiles MUST be updated with the incoming files so buffer.reconcile()
    // can find the staged intent and report intentDriftCount = 1.
    const hmrSentAt = Date.now()
    expect(() => {
      channel._simulateMessage({ type: 'hmr-applied', files: ['src/Sidebar.tsx', 'src/Other.tsx'] })
    }).not.toThrow()

    // ZF0-1564 positive signal: the drift banner must appear, proving
    // hmrChangedFiles was propagated non-empty. If setHmrChangedFiles regressed
    // to setHmrChangedFiles([]), the Panel reconcile effect takes the
    // early-return path (intentDriftCount stays 0) and the banner does not render.
    await vi.waitFor(() => {
      expect(root.textContent).toContain('staged edit(s) may be affected')
    }, { timeout: WAIT_FOR_COMMIT_MS })

    // ZF0-1564 negative signal (audit Finding 2 + Copilot review fix): the
    // banner waitFor above can complete as fast as ~10-50ms (Panel's reconcile
    // effect runs on the next React commit after setHmrEventVersion fires),
    // which is BEFORE the 250ms setTimeout in the gated block at
    // CortexApp.tsx:789. If a future regression moved that setTimeout
    // outside the gate, an assertion right after the banner waitFor could
    // false-pass (the 250ms timeout hasn't fired yet). Wait for the FULL
    // gated-fan-out window (250ms max + 10ms buffer) measured from when we
    // sent hmr-applied. Bounded by production code structure, not empirical
    // flake-mitigation.
    const elapsed = Date.now() - hmrSentAt
    if (elapsed < 260) {
      await new Promise(r => setTimeout(r, 260 - elapsed))
    }

    // If the gate at CortexApp.tsx:779 fired correctly, reResolveSelection is
    // never called. Specific function assertion — immune to coverage-
    // instrumentation noise on shared globals (the failure mode of the original
    // gcs.mock.calls.length).
    expect(reResolveSelection).not.toHaveBeenCalled()
  })

  // ZF0-1804: independently verifies the version-bump gate in CortexApp.tsx
  // (the `if (shouldRefresh) setHmrAppliedVersion(v => v + 1)` block inside
  // the hmr-applied handler). Existing tests above verify the re-resolve gate
  // (the sibling `if (shouldRefresh) attemptReResolve(); requestAnimationFrame
  // (...); setTimeout(...)` block further down in the same handler) via the
  // reResolveSelection spy — but both gates share `shouldRefresh`. A surgical
  // refactor that forces `if (true)` around setHmrAppliedVersion while keeping
  // the re-resolve gate intact would pass those tests. This test closes that
  // gap by reading hmrAppliedVersion directly via a DCE-gated window hook
  // (__cortex_test_get_hmr_applied_version). Reading pure React state via a
  // ref is coverage-instrumentation-immune — coverage probes cannot call
  // setHmrAppliedVersion, so the value only changes when the real gate fires
  // (contrast: gcs.mock.calls.length flaked because coverage probed styles,
  // see ZF0-1564 audit).
  it('does not bump hmrAppliedVersion when hmr files are fully unrelated', async () => {
    const { channel } = await setup('src/foo.tsx:10:5')

    // ZF0-1804: read the DCE-gated hook installed by CortexApp on mount.
    // If undefined, the hook is not installed — fail loudly so the missing
    // production change (not a test-setup issue) is immediately obvious.
    const getVersion = (window as any).__cortex_test_get_hmr_applied_version as (() => number) | undefined
    expect(getVersion).toBeDefined()
    const versionBefore = getVersion!()

    // Fire hmr-applied with files unrelated to the selected element (src/foo.tsx).
    // shouldRefreshOnHMR returns false → the version-bump gate must NOT fire →
    // hmrAppliedVersion must remain unchanged.
    channel._simulateMessage({ type: 'hmr-applied', files: ['src/bar.tsx', 'src/baz.tsx'] })

    // Wait past the full gated fan-out window (250ms max + 10ms buffer) — same
    // bounded scheduling window used by the existing tests in this describe block.
    await new Promise(r => setTimeout(r, 260))

    // If the version-bump gate fired correctly (shouldRefresh is false),
    // setHmrAppliedVersion was never called and the version stays flat.
    expect(getVersion!()).toBe(versionBefore)
  })

  // ZF0-1804: symmetric positive-case companion to the test above. The negative
  // test alone catches "gate forced open" regressions (if (true)), but a
  // regression that closes the gate entirely (if (false), or removing
  // setHmrAppliedVersion) would slip past — the cited gcsSpy test above proves
  // the downstream Panel re-read, not that this gate's own setter fired (the
  // re-resolve gate's rAF/setTimeout fan-out would still trigger a Panel commit
  // and getComputedStyle cascade independently). This test closes the symmetric
  // gap by asserting hmrAppliedVersion DOES bump when hmr files match the
  // selected source, using the same DCE-gated hook for a falsifiable signal.
  it('does bump hmrAppliedVersion when hmr files match the selected source', async () => {
    const { channel } = await setup('src/foo.tsx:10:5')

    const getVersion = (window as any).__cortex_test_get_hmr_applied_version as (() => number) | undefined
    expect(getVersion).toBeDefined()
    const versionBefore = getVersion!()

    // hmr-applied with files that include src/foo.tsx — the same source the
    // selected element was registered with. shouldRefreshOnHMR returns true →
    // the version-bump gate fires → hmrAppliedVersion increments.
    channel._simulateMessage({ type: 'hmr-applied', files: ['src/foo.tsx'] })

    // vi.waitFor polls until the assertion succeeds (or times out at
    // WAIT_FOR_COMMIT_MS). Preferred over a bare setTimeout for the positive
    // path because the bump fires synchronously inside the handler — typical
    // wait is <10ms, but the re-resolve gate's rAF/setTimeout fan-out could
    // contribute additional bumps (lines that call setHmrAppliedVersion inside
    // attemptReResolve when indexShifted), so we want "greater than before"
    // rather than "exactly +1".
    await vi.waitFor(() => {
      expect(getVersion!()).toBeGreaterThan(versionBefore)
    }, { timeout: WAIT_FOR_COMMIT_MS })
  })


  // The highest-value test in the SVG-selection fix: it is the only one that
  // proves the fix OUTLIVES A SAVE. Pre-fix, findSourceMatches filtered to
  // HTMLElement, so captureSelectionMetadata recorded index === -1 for an SVG,
  // reResolveSelection returned null, and CortexApp swapped the selection to
  // null — unmounting the Panel on the next hot reload. A fix to the click
  // path alone would have looked correct and then evaporated.
  it('keeps an SVG selection alive across an hmr-applied cycle', async () => {
    const sh = createShadowHost()
    root = sh.root
    shadow = sh.shadow
    cleanupHost = sh.cleanup
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, 10))
    channel._simulateMessage({ type: 'cortex' } as any)
    await new Promise(r => setTimeout(r, 10))

    const { _getCallbacks } = await import('../../src/browser/selection.js') as unknown as {
      _getCallbacks: () => { selectCb: (elements: Element[], action: 'replace' | 'add' | 'toggle') => void }
    }
    const { selectCb } = _getCallbacks()

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('data-cortex-source', 'src/Icon.tsx:3:5')
    icon.appendChild(document.createTextNode('icon'))
    document.body.appendChild(icon)
    mockGetBoundingClientRect(icon, { top: 50, left: 50, width: 24, height: 24 })

    selectCb([icon], 'replace')
    await vi.waitFor(() => {
      expect(root.querySelector('.cortex-panel')).not.toBeNull()
    }, { timeout: WAIT_FOR_COMMIT_MS })

    channel._simulateMessage({ type: 'hmr-applied', files: ['src/Icon.tsx'] })
    // Past the gated fan-out's longest scheduler (250ms + drift), same bound
    // the sibling tests in this describe use.
    await new Promise(r => setTimeout(r, 260))

    expect(vi.mocked(reResolveSelection)).toHaveBeenCalled()
    expect(vi.mocked(reResolveSelection).mock.results.some(r => r.value === icon)).toBe(true)
    // Pre-fix: the Panel is gone — reResolveSelection returned null and
    // CortexApp cleared the selection.
    expect(root.querySelector('.cortex-panel')).not.toBeNull()

    icon.remove()
  })

})

// ── Task 12 — mcp-session-hello / Change 6 ────────────────────────────────

describe('CortexApp — mcp-session-hello never wipes; reconcile fires on every hello (0.3.1)', () => {
  // History: Task 12/Change 6 wiped the buffer on a UUID change ("new Claude
  // session"). That keyed a destructive clear on the MCP PROCESS lifetime, but
  // Claude Code spawns a fresh `cortex mcp` (fresh UUID) per conversation — so
  // every Claude restart destroyed the designer's staged work. The designer's
  // session is THIS page's lifetime (memory-only buffer); no hello wipes, and
  // reconcileOnConnect runs unconditionally instead.
  const VALID_UUID_A = '00000000-0000-4000-a000-000000000001'
  const VALID_UUID_B = '00000000-0000-4000-a000-000000000002'

  let root: HTMLDivElement
  let shadow: ShadowRoot
  let cleanupHost: (() => void) | null = null
  const orphans: HTMLElement[] = []

  afterEach(async () => {
    if (root) render(null, root)
    cleanupHost?.()
    cleanupHost = null
    for (const el of orphans) el.remove()
    orphans.length = 0
    for (const el of document.querySelectorAll('[data-cortex-source]')) el.remove()
    document.documentElement.removeAttribute('data-cortex-active')
    delete (window as any).__CORTEX_TEST__
    delete (window as any).__CORTEX_DEBUG_OVERRIDES__
    const mod = await import('../../src/browser/selection.js') as unknown as { _resetCallbacks?: () => void }
    mod._resetCallbacks?.()
    _resetBusForTesting()
    _resetTransformBusForTesting()
    _resetPopoverStackForTesting()
    cleanDocumentHead()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function setupWithBuffer() {
    ;(window as any).__CORTEX_DEBUG_OVERRIDES__ = true
    const sh = createShadowHost()
    root = sh.root
    shadow = sh.shadow
    cleanupHost = sh.cleanup
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)

    // Listener-before-message contract: _simulateMessage() does NOT buffer —
    // it fans out only to handlers registered AT call time (helpers.ts:138).
    // CortexApp subscribes via channel.onMessage() inside its mount effect,
    // which Preact runs asynchronously after the initial render commit. A fixed
    // setTimeout before _simulateMessage races that effect: under serial-loop
    // load the 'cortex' activation message can fire BEFORE the handler exists,
    // get dropped, and the toolbar never renders → the vi.waitFor below times
    // out with "expected null not to be null". Wait on _handlerCount() (the
    // helper exposes it for exactly this) so activation is always delivered.
    await vi.waitFor(() => {
      expect(channel._handlerCount()).toBeGreaterThan(0)
    }, { timeout: 2000 })

    // Activate so Panel mounts and stageEditRef is available. Wrap in act()
    // so the resulting re-render flushes before the toolbar wait — mirrors the
    // proven-stable activateEditor() helper in the sibling describe block.
    await act(async () => {
      channel._simulateMessage({ type: 'cortex' } as any)
    })
    await vi.waitFor(() => {
      expect(root.querySelector('.cortex-toolbar')).not.toBeNull()
    }, { timeout: 2000 })

    // Select an element so Panel mounts.
    const { _getCallbacks } = await import('../../src/browser/selection.js') as any
    const { selectCb } = _getCallbacks()
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
    document.body.appendChild(target)
    orphans.push(target)
    mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })
    selectCb([target], 'replace')
    await vi.waitFor(() => {
      expect(root.querySelector('.cortex-panel')).not.toBeNull()
    }, { timeout: 2000 })

    const bridge = (window as any).__CORTEX_TEST__ as {
      buffer: { list: () => unknown[]; size: () => number }
      stageEdit: (source: string, property: string, value: string) => Promise<string>
    }
    return { channel, bridge }
  }

  // Deliver an mcp-session-hello and flush. _simulateMessage fans out
  // synchronously to CortexApp's onMessage handler, which runs
  // reconcileOnConnect inline. Wrapping in act() flushes any resulting Preact
  // re-render/effect synchronously, so a plain assertion afterwards is
  // deterministic — no arbitrary setTimeout settle window.
  async function deliverHello(channel: ReturnType<typeof createMockChannel>, sessionId: string) {
    await act(async () => {
      channel._simulateMessage({ type: 'mcp-session-hello', sessionId } as any)
    })
  }

  it('first mcp-session-hello does NOT wipe the buffer', async () => {
    // Verifies: receiving the very first hello from MCP keeps staged edits.
    const { channel, bridge } = await setupWithBuffer()

    // Stage one edit before the hello arrives.
    await act(async () => { await bridge.stageEdit('Hero.tsx:5:3', 'color', 'red') })
    await vi.waitFor(() => { expect(bridge.buffer.size()).toBe(1) }, { timeout: 2000 })

    // First mcp-session-hello — buffer stays intact (the staged edit is
    // divergent: the element's live color ≠ 'red', so reconcile keeps it).
    await deliverHello(channel, VALID_UUID_A)

    // act() above flushed the handler synchronously — no settle delay needed.
    expect(bridge.buffer.size()).toBe(1)
  })

  it('second mcp-session-hello with SAME UUID does NOT wipe the buffer', async () => {
    // Verifies: transient reconnects (same UUID re-announced) do not wipe.
    const { channel, bridge } = await setupWithBuffer()

    await act(async () => { await bridge.stageEdit('Hero.tsx:5:3', 'color', 'blue') })
    await vi.waitFor(() => { expect(bridge.buffer.size()).toBe(1) }, { timeout: 2000 })

    // First hello — adopt UUID.
    await deliverHello(channel, VALID_UUID_A)
    expect(bridge.buffer.size()).toBe(1)

    // Second hello — SAME UUID → must NOT wipe.
    await deliverHello(channel, VALID_UUID_A)
    expect(bridge.buffer.size()).toBe(1)
  })

  it('second mcp-session-hello with DIFFERENT UUID does NOT wipe the buffer (0.3.1 — Claude restart survives)', async () => {
    // The reported data-loss bug: a fresh Claude Code conversation spawns a
    // fresh `cortex mcp` process with a NEW UUID. Staged-but-unapplied work
    // must SURVIVE that hello — the old UUID-change wipe destroyed it.
    const { channel, bridge } = await setupWithBuffer()

    await act(async () => { await bridge.stageEdit('Hero.tsx:5:3', 'color', 'green') })
    await vi.waitFor(() => { expect(bridge.buffer.size()).toBe(1) }, { timeout: 2000 })

    // First hello — the first Claude session announces itself.
    await deliverHello(channel, VALID_UUID_A)
    expect(bridge.buffer.size()).toBe(1)

    // Second hello — DIFFERENT UUID (Claude restarted). The intent is
    // divergent (live color ≠ 'green'), so reconcile keeps it too: the staged
    // work survives, still applicable by the new Claude session.
    await deliverHello(channel, VALID_UUID_B)
    expect(bridge.buffer.size()).toBe(1)
    const surviving = bridge.buffer.list() as Array<{ source: string; property: string; value: string }>
    expect(surviving[0]).toMatchObject({ source: 'Hero.tsx:5:3', property: 'color', value: 'green' })
  })

  // ── ZF0-1869 criterion 25: reconcile-on-connect ───────────────────────────

  it('reconcile-on-connect: auto-clears already-matched intent, keeps divergent (first-adopt path)', async () => {
    // Verifies spec criterion 25: on the no-wipe paths (first-adopt + same-UUID),
    // intents whose target element's live value ALREADY matches the intent's
    // target value are auto-cleared from the buffer.
    //
    // Falsifiable:
    //   - Fails without reconcile: both intents survive the hello.
    //   - Fails if reconcile over-clears: the divergent intent is removed.
    const { channel, bridge } = await setupWithBuffer()

    // The 'Hero.tsx:5:3' element was appended to document.body by setupWithBuffer.
    // Set its inline style so getComputedStyle('padding') returns the intent's
    // target value (reconcile-on-connect checks edit.value vs live computed value).
    const convergedEl = document.querySelector('[data-cortex-source="Hero.tsx:5:3"]') as HTMLElement
    expect(convergedEl).not.toBeNull()
    convergedEl.style.padding = '12px'

    // Add a second element for the divergent intent (live value ≠ intent value).
    const divergentEl = document.createElement('div')
    divergentEl.setAttribute('data-cortex-source', 'App.tsx:10:5')
    divergentEl.style.padding = '0px'  // does NOT match the intent's target '24px'
    document.body.appendChild(divergentEl)
    orphans.push(divergentEl)

    // Stage intent A: converged — element already has padding:12px, intent wants 12px.
    await act(async () => { await bridge.stageEdit('Hero.tsx:5:3', 'padding', '12px') })
    // Stage intent B: divergent — element has padding:0px, intent wants 24px.
    await act(async () => { await bridge.stageEdit('App.tsx:10:5', 'padding', '24px') })
    await vi.waitFor(() => { expect(bridge.buffer.size()).toBe(2) }, { timeout: 2000 })

    // First mcp-session-hello — no-wipe path (first adoption). Reconcile-on-connect
    // must fire and auto-clear the converged intent only.
    await deliverHello(channel, VALID_UUID_A)

    // Buffer must drop to 1: converged intent cleared, divergent intent survives.
    await vi.waitFor(() => {
      expect(bridge.buffer.size()).toBe(1)
    }, { timeout: 2000 })
    // The surviving intent must be the divergent one (App.tsx:10:5, padding: 24px).
    const surviving = bridge.buffer.list() as Array<{ source: string; property: string; value: string }>
    expect(surviving).toHaveLength(1)
    expect(surviving[0]!.source).toBe('App.tsx:10:5')
    expect(surviving[0]!.property).toBe('padding')
    expect(surviving[0]!.value).toBe('24px')
  })

  it('reconcile-on-connect: auto-clears already-matched intent on same-UUID reconnect path', async () => {
    // Verifies criterion 25 on the same-UUID reconnect (no-wipe) path as well.
    // The mechanism must fire on ANY no-wipe hello, not only on first-adopt.
    const { channel, bridge } = await setupWithBuffer()

    // Adopt UUID_A first so the second hello is a same-UUID reconnect.
    await deliverHello(channel, VALID_UUID_A)

    const convergedEl = document.querySelector('[data-cortex-source="Hero.tsx:5:3"]') as HTMLElement
    expect(convergedEl).not.toBeNull()
    convergedEl.style.color = 'red'

    await act(async () => { await bridge.stageEdit('Hero.tsx:5:3', 'color', 'red') })
    await vi.waitFor(() => { expect(bridge.buffer.size()).toBe(1) }, { timeout: 2000 })

    // Same-UUID reconnect — must trigger reconcile and auto-clear the converged intent.
    await deliverHello(channel, VALID_UUID_A)
    await vi.waitFor(() => {
      expect(bridge.buffer.size()).toBe(0)
    }, { timeout: 2000 })
  })

  it('reconcile-on-connect fires on the different-UUID hello: converged intent auto-cleared, divergent survives (0.3.1)', async () => {
    // With the wipe gone, the different-UUID hello (Claude restart) runs the
    // SAME reconcile as every other hello: intents whose edits verifiably
    // landed in source (live value matches) are auto-cleared — a restarted
    // Claude may have applied them via the Edit tool before dying — while
    // divergent intents survive for the new session to apply.
    //
    // Falsifiable:
    //   - Fails if the old wipe returns: BOTH intents vanish (divergent lost).
    //   - Fails if reconcile is skipped on this path: BOTH survive (converged kept).
    const { channel, bridge } = await setupWithBuffer()

    // Converged element: live color already matches the intent's target.
    const convergedEl = document.querySelector('[data-cortex-source="Hero.tsx:5:3"]') as HTMLElement
    expect(convergedEl).not.toBeNull()
    convergedEl.style.color = 'blue'

    // Divergent element: live padding ≠ the intent's target.
    const divergentEl = document.createElement('div')
    divergentEl.setAttribute('data-cortex-source', 'App.tsx:10:5')
    divergentEl.style.padding = '0px'
    document.body.appendChild(divergentEl)
    orphans.push(divergentEl)

    await deliverHello(channel, VALID_UUID_A)  // first Claude session announces

    await act(async () => { await bridge.stageEdit('Hero.tsx:5:3', 'color', 'blue') })      // converged
    await act(async () => { await bridge.stageEdit('App.tsx:10:5', 'padding', '24px') })    // divergent
    await vi.waitFor(() => { expect(bridge.buffer.size()).toBe(2) }, { timeout: 2000 })

    // Claude restarts: DIFFERENT UUID hello → reconcile runs, no wipe.
    await deliverHello(channel, VALID_UUID_B)
    await vi.waitFor(() => { expect(bridge.buffer.size()).toBe(1) }, { timeout: 2000 })
    const surviving = bridge.buffer.list() as Array<{ source: string; property: string; value: string }>
    expect(surviving[0]).toMatchObject({ source: 'App.tsx:10:5', property: 'padding', value: '24px' })
  })
})
