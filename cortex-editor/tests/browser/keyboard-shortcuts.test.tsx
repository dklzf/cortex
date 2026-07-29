import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import * as focusUtils from '../../src/browser/focus-utils.js'
import { dispatchKeyboardEvent, createShadowHost, createMockChannel, mockGetBoundingClientRect, cleanDocumentHead } from './helpers.js'
import { _resetBusForTesting } from '../../src/browser/override-bus.js'

// tinykeys maps $mod to Meta on Mac, Control elsewhere.
// happy-dom navigator.platform is not Mac, so $mod → Control.
const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)
const modKey = isMac ? 'metaKey' : 'ctrlKey'

// happy-dom does not implement getModifierState on KeyboardEvent.
// tinykeys relies on it, so polyfill it to reflect the event's modifier properties.
if (!KeyboardEvent.prototype.getModifierState) {
  KeyboardEvent.prototype.getModifierState = function (key: string): boolean {
    switch (key) {
      case 'Control': return this.ctrlKey
      case 'Shift': return this.shiftKey
      case 'Alt': return this.altKey
      case 'Meta': return this.metaKey
      default: return false
    }
  }
}

// Mock CommandStack so we can control undo/redo return values.
// Use a shared reference that tests can mutate before triggering shortcuts.
const _commandStackMock = {
  undo: vi.fn().mockReturnValue(null),
  redo: vi.fn().mockReturnValue(null),
  clear: vi.fn(),
  push: vi.fn(),
  canUndo: false,
  canRedo: false,
  undoCount: 0,
  redoCount: 0,
  peekUndo: vi.fn().mockReturnValue(null),
  peekRedo: vi.fn().mockReturnValue(null),
}
vi.mock('../../src/browser/command-stack.js', () => ({
  CommandStack: class MockCommandStack {
    undo = _commandStackMock.undo
    redo = _commandStackMock.redo
    clear = _commandStackMock.clear
    push = _commandStackMock.push
    get canUndo() { return _commandStackMock.canUndo }
    get canRedo() { return _commandStackMock.canRedo }
    get undoCount() { return _commandStackMock.undoCount }
    get redoCount() { return _commandStackMock.redoCount }
    peekUndo = _commandStackMock.peekUndo
    peekRedo = _commandStackMock.peekRedo
  }
}))

// Mock the selection module (same pattern as cortex-app.test.tsx).
// _resetCallbacks nulls the module-scope closure so a prior test's callbacks
// cannot be returned under async timing (ZF0-1297 test-hygiene fix).
vi.mock('../../src/browser/selection.js', () => {
  const cleanupFn = vi.fn()
  const setDesignModeFn = vi.fn()
  const setInterceptClicksFn = vi.fn()
  // These annotations were wrong on TWO axes and stayed wrong through at least
  // one prior signature change: onSelect takes (elements, action), not a single
  // element, and the type is Element (SVG selections are real). vi.mock replaces
  // the module wholesale so nothing forced them to stay honest — tests/browser
  // is in no typecheck program. Keep them accurate by hand.
  let hoverCb: ((el: Element | null) => void) | null = null
  let selectCb: ((elements: Element[], action: 'replace' | 'add' | 'toggle') => void) | null = null

  return {
    initSelection: vi.fn((
      _shadow: ShadowRoot,
      onHover: (el: Element | null) => void,
      onSelect: (elements: Element[], action: 'replace' | 'add' | 'toggle') => void,
    ) => {
      hoverCb = onHover
      selectCb = onSelect
      return { cleanup: cleanupFn, setDesignMode: setDesignModeFn, setInterceptClicks: setInterceptClicksFn }
    }),
    _getCallbacks: () => ({ hoverCb, selectCb }),
    _resetCallbacks: () => { hoverCb = null; selectCb = null },
    _cleanup: cleanupFn,
  }
})

// Allow synthetic events to pass the isTrusted check in tests
beforeEach(() => {
  vi.spyOn(focusUtils, 'isRealEvent').mockReturnValue(true)
})
afterEach(async () => {
  // Reset cross-test state that persists despite vi.restoreAllMocks:
  // module-scope selection-mock closures + override-bus listeners +
  // document.head style tags. See ZF0-1297 Step 12 hygiene fix.
  const mod = await import('../../src/browser/selection.js') as unknown as { _resetCallbacks?: () => void }
  mod._resetCallbacks?.()
  _resetBusForTesting()
  cleanDocumentHead()
  vi.restoreAllMocks()
})

// --- CortexApp integration tests for cascade + shortcuts ---

import { CortexApp } from '../../src/browser/components/CortexApp.js'

// Settle time for Preact useEffect to fire and tinykeys to register
const SETTLE = 30

describe('cascade priorities (integration)', () => {
  let root: HTMLDivElement
  let shadow: ShadowRoot
  let cleanupHost: () => void

  afterEach(async () => {
    if (root) render(null, root)
    await new Promise(r => setTimeout(r, SETTLE))
    if (cleanupHost) cleanupHost()
    vi.clearAllMocks()
    vi.spyOn(focusUtils, 'isRealEvent').mockReturnValue(true)
  })

  function setup() {
    const sh = createShadowHost()
    root = sh.root
    shadow = sh.shadow
    cleanupHost = sh.cleanup
    return sh
  }

  // Priority 2: Exit comment mode
  it('Escape exits comment mode when comment mode is active', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Enter comment mode by clicking the comment button
    const commentBtn = root.querySelector('[data-mode="comment"]') as HTMLButtonElement
    expect(commentBtn).not.toBeNull()
    commentBtn.click()
    await vi.waitFor(() => {
      // Verify comment mode is active
      expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(true)
    }, { timeout: 500 })

    // Press Escape
    dispatchKeyboardEvent(window, 'keydown', { key: 'Escape' })
    await vi.waitFor(() => {
      // Comment mode should be off, editor should still be active
      expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(false)
    }, { timeout: 500 })
    expect(root.querySelector('.cortex-toolbar')).not.toBeNull()
  })

  // Priority 3: Deselect element
  it('Escape deselects when element is selected and no comment mode', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Select an element
    const { _getCallbacks } = await import('../../src/browser/selection.js') as unknown as {
      _getCallbacks: () => { selectCb: (elements: Element[], action: 'replace' | 'add' | 'toggle') => void }
    }
    const { selectCb } = _getCallbacks()
    const target = document.createElement('div')
    document.body.appendChild(target)
    mockGetBoundingClientRect(target, { top: 50, left: 50, width: 100, height: 40 })
    selectCb([target], 'replace')
    await new Promise(r => setTimeout(r, SETTLE))

    // Should have selection overlay
    expect(root.querySelector('.cortex-selection-overlay')).not.toBeNull()

    // Press Escape
    dispatchKeyboardEvent(window, 'keydown', { key: 'Escape' })
    await vi.waitFor(() => {
      // Selection should be cleared
      expect(root.querySelector('.cortex-selection-overlay')).toBeNull()
    }, { timeout: 500 })
    // Editor still active
    expect(root.querySelector('.cortex-toolbar')).not.toBeNull()
    expect(channel._lastSent).not.toContainEqual({ type: 'cortex-closed' })

    target.remove()
  })

  // Priority 4: Escape deactivates Cortex when no selection and no comment mode
  // (H5 reversal in ZF0-1869: Esc-to-close re-added as required keyboard affordance)
  it('Escape deactivates Cortex when no selection and no comment mode', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Press Escape with nothing active — Priority 4 fires (no selection, no comment mode,
    // no focused input, no open popover) → handleClose() → Cortex deactivates.
    dispatchKeyboardEvent(window, 'keydown', { key: 'Escape' })
    await vi.waitFor(() => {
      // Toolbar should be gone and cortex-closed should have been sent
      expect(root.querySelector('.cortex-toolbar')).toBeNull()
    }, { timeout: 500 })
    // Falsifiability: remove Priority 4 from handleEscape (comment out handleClose()
    // and the e.stopPropagation/preventDefault) — the toolbar remains and this fails.
  })
})

describe('tinykeys shortcut integration', () => {
  let root: HTMLDivElement
  let shadow: ShadowRoot
  let cleanupHost: () => void

  afterEach(async () => {
    if (root) render(null, root)
    // Allow Preact cleanup (useEffect destructors incl. tinykeys unsubscribe) to run
    await new Promise(r => setTimeout(r, SETTLE))
    if (cleanupHost) cleanupHost()
    vi.clearAllMocks()
    vi.spyOn(focusUtils, 'isRealEvent').mockReturnValue(true)
  })

  function setup() {
    const sh = createShadowHost()
    root = sh.root
    shadow = sh.shadow
    cleanupHost = sh.cleanup
    return sh
  }

  it('V key exits comment mode (activates select mode)', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Enter comment mode
    const commentBtn = root.querySelector('[data-mode="comment"]') as HTMLButtonElement
    commentBtn.click()
    await vi.waitFor(() => {
      expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(true)
    }, { timeout: 500 })

    // Press V — should exit comment mode
    dispatchKeyboardEvent(window, 'keydown', { key: 'v' })
    await vi.waitFor(() => {
      expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(false)
    }, { timeout: 500 })
  })

  it('C key toggles comment mode on', async () => {
    setup()
    const channel = createMockChannel()
    // Wrap mount in act() so the useEffect that installs tinykeys' keydown listener
    // runs synchronously before we dispatch. Per ZF0-1361 cross-model review:
    // act() on the dispatch alone leaves the listener-installation race intact.
    await act(() => {
      render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    })

    const commentBtn = root.querySelector('[data-mode="comment"]') as HTMLButtonElement
    expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(false)

    // Press C — should toggle comment mode on
    // act() wraps the dispatch so tinykeys handler → setState → effect commit drains
    // synchronously. Replaces vi.waitFor polling race per ZF0-1361.
    await act(() => {
      dispatchKeyboardEvent(window, 'keydown', { key: 'c' })
    })
    expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(true)
  })

  it('C key toggles comment mode off when already on', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Enter comment mode
    const commentBtn = root.querySelector('[data-mode="comment"]') as HTMLButtonElement
    commentBtn.click()
    await vi.waitFor(() => {
      expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(true)
    }, { timeout: 500 })

    // Press C — should toggle comment mode off
    dispatchKeyboardEvent(window, 'keydown', { key: 'c' })
    await vi.waitFor(() => {
      expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(false)
    }, { timeout: 500 })
  })

  it('Cmd+Z sends undo message when command stack has entries', async () => {
    setup()
    const channel = createMockChannel()
    // Mock undo to return a command (non-null = stack had an entry)
    _commandStackMock.undo.mockReturnValueOnce({ editId: 'test', changes: [], execute: vi.fn(), undo: vi.fn(), hasServerEntry: true })
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Clear any sent messages from activation
    channel._lastSent.length = 0

    // Press Cmd+Z (metaKey on Mac, ctrlKey on other platforms)
    dispatchKeyboardEvent(window, 'keydown', { key: 'z', [modKey]: true })
    await vi.waitFor(() => {
      expect(_commandStackMock.undo).toHaveBeenCalled()
      expect(channel._lastSent).toContainEqual({ type: 'undo' })
    }, { timeout: 500 })
  })

  it('Cmd+Z does NOT send undo when command stack is empty', async () => {
    setup()
    const channel = createMockChannel()
    // Mock undo to return null (empty stack)
    _commandStackMock.undo.mockReturnValueOnce(null)
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Clear any sent messages from activation
    channel._lastSent.length = 0

    // Press Cmd+Z
    dispatchKeyboardEvent(window, 'keydown', { key: 'z', [modKey]: true })
    await new Promise(r => setTimeout(r, SETTLE))

    expect(_commandStackMock.undo).toHaveBeenCalled()
    expect(channel._lastSent).not.toContainEqual({ type: 'undo' })
  })

  it('Cmd+Shift+Z sends redo message when command stack has entries', async () => {
    setup()
    const channel = createMockChannel()
    // Mock redo to return a command
    _commandStackMock.redo.mockReturnValueOnce({ editId: 'test', changes: [], execute: vi.fn(), undo: vi.fn(), hasServerEntry: true })
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Clear any sent messages from activation
    channel._lastSent.length = 0

    // Press Cmd+Shift+Z
    dispatchKeyboardEvent(window, 'keydown', { key: 'z', [modKey]: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(_commandStackMock.redo).toHaveBeenCalled()
      expect(channel._lastSent).toContainEqual({ type: 'redo' })
    }, { timeout: 500 })
  })

  it('Cmd+Shift+Z does NOT send redo when command stack is empty', async () => {
    setup()
    const channel = createMockChannel()
    // Mock redo to return null (empty stack)
    _commandStackMock.redo.mockReturnValueOnce(null)
    // Wrap mount in act() so the useEffect that installs tinykeys' keydown
    // listener runs synchronously before we dispatch. Per ZF0-1361 cross-model
    // review: act() on the dispatch alone leaves the listener-installation
    // race intact.
    await act(() => {
      render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    })

    // Clear any sent messages from activation
    channel._lastSent.length = 0

    // act() wraps the dispatch so tinykeys handler → setState → effect commit
    // drains synchronously. Replaces SETTLE polling race per ZF0-1387 / ZF0-1361.
    await act(() => {
      dispatchKeyboardEvent(window, 'keydown', { key: 'z', [modKey]: true, shiftKey: true })
    })

    expect(_commandStackMock.redo).toHaveBeenCalled()
    expect(channel._lastSent).not.toContainEqual({ type: 'redo' })
  })

  it('single-key shortcuts are blocked when input is focused', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Mock isInputFocused to return true
    vi.spyOn(focusUtils, 'isInputFocused').mockReturnValue(true)

    const commentBtn = root.querySelector('[data-mode="comment"]') as HTMLButtonElement
    expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(false)

    // Press C — should NOT toggle comment mode because input is focused
    dispatchKeyboardEvent(window, 'keydown', { key: 'c' })
    await new Promise(r => setTimeout(r, SETTLE))

    expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(false)
  })

  it('single-key shortcuts are blocked when Cortex UI is focused', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Mock isCortexUIFocused to return true
    vi.spyOn(focusUtils, 'isCortexUIFocused').mockReturnValue(true)

    const commentBtn = root.querySelector('[data-mode="comment"]') as HTMLButtonElement
    expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(false)

    // Press C — should NOT toggle comment mode because Cortex UI is focused
    dispatchKeyboardEvent(window, 'keydown', { key: 'c' })
    await new Promise(r => setTimeout(r, SETTLE))

    expect(commentBtn.classList.contains('cortex-toolbar__mode--active')).toBe(false)
  })

  it('modifier shortcuts are blocked when input is focused', async () => {
    setup()
    const channel = createMockChannel()
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Mock isInputFocused to return true
    vi.spyOn(focusUtils, 'isInputFocused').mockReturnValue(true)

    // Clear sent messages
    channel._lastSent.length = 0

    // Press Cmd+Z — should NOT send undo because input is focused
    dispatchKeyboardEvent(window, 'keydown', { key: 'z', [modKey]: true })
    await new Promise(r => setTimeout(r, SETTLE))

    expect(channel._lastSent).not.toContainEqual({ type: 'undo' })
  })

  it('modifier shortcuts work when Cortex UI is focused (not blocked)', async () => {
    setup()
    const channel = createMockChannel()
    // Mock undo to return a command so the message gets sent
    _commandStackMock.undo.mockReturnValueOnce({ editId: 'test', changes: [], execute: vi.fn(), undo: vi.fn(), hasServerEntry: true })
    render(<CortexApp channel={channel} shadowRoot={shadow} initialActive />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Mock: Cortex UI is focused but NOT a text input
    vi.spyOn(focusUtils, 'isCortexUIFocused').mockReturnValue(true)
    vi.spyOn(focusUtils, 'isInputFocused').mockReturnValue(false)

    // Clear sent messages
    channel._lastSent.length = 0

    // Press Cmd+Z — should send undo because only isCortexUIFocused, not isInputFocused
    dispatchKeyboardEvent(window, 'keydown', { key: 'z', [modKey]: true })
    await vi.waitFor(() => {
      expect(channel._lastSent).toContainEqual({ type: 'undo' })
    }, { timeout: 500 })
  })

  it('shortcuts are inactive when editor is not active', async () => {
    setup()
    const channel = createMockChannel()
    // Explicitly NOT active
    render(<CortexApp channel={channel} shadowRoot={shadow} />, root)
    await new Promise(r => setTimeout(r, SETTLE))

    // Press C — should not do anything (editor not active)
    dispatchKeyboardEvent(window, 'keydown', { key: 'c' })
    await new Promise(r => setTimeout(r, SETTLE))

    // Editor is not active, so no toolbar to check
    expect(root.querySelector('.cortex-toolbar')).toBeNull()
  })
})
