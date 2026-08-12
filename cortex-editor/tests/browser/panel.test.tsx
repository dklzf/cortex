import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from 'preact'
import { useRef } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { Panel } from '../../src/browser/components/Panel.js'
import { renderInShadow, mockGetComputedStyle, createShadowHost, createMockChannel, makeFakeBuffer } from './helpers.js'
import { _resetTransformBusForTesting } from '../../src/browser/transform-bus.js'
import { _resetBusForTesting } from '../../src/browser/override-bus.js'
import { useEditStagingBuffer, type PendingEdit, type StagingBufferHandle } from '../../src/browser/hooks/useEditStagingBuffer.js'
import * as bufferModule from '../../src/browser/hooks/useEditStagingBuffer.js'
import { CommandStack } from '../../src/browser/command-stack.js'
import { PREVIEW_SOURCE_ATTR, PREVIEW_SOURCE_PREFIX } from '../../src/browser/preview-source.js'

/**
 * Wrapper component for tests that need a real useEditStagingBuffer instance.
 * Calls the hook internally and passes the result to Panel as the `buffer` prop.
 * Optional `bufferRef` receives the buffer handle so tests can inspect in-memory
 * state directly (Change 4: memory-only — no localStorage observation needed).
 */
/** Minimal CSSOverrideManager stub. Panel touches only a handful of methods, and
 *  every new method on the real class used to mean editing ~19 inline literals in
 *  this file. Pass `overrides` to specialise a single test. */
function createStubOverrideManager(overrides: Record<string, unknown> = {}) {
  return {
    set: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    clearAll: vi.fn(),
    dispose: vi.fn(),
    flush: vi.fn(),
    hasAnyOverrides: vi.fn(() => false),
    readSourceValue: vi.fn(() => ''),
    ...overrides,
  }
}

function PanelWithRealBuffer(props: Omit<Parameters<typeof Panel>[0], 'buffer'> & {
  bufferRef?: { current: StagingBufferHandle | null }
}) {
  const { bufferRef, ...rest } = props
  const buffer = useEditStagingBuffer()
  if (bufferRef) bufferRef.current = buffer
  return <Panel {...rest} buffer={buffer} />
}

/**
 * Like PanelWithRealBuffer but also appends `initialEdits` to the buffer
 * synchronously during the render phase (before useEffect), so the buffer
 * is pre-populated at mount time without relying on localStorage rehydration
 * (which is removed in Change 4: memory-only buffer).
 */
function PanelWithInitEdits({
  initialEdits,
  bufferRef,
  ...props
}: Omit<Parameters<typeof Panel>[0], 'buffer'> & {
  initialEdits: PendingEdit[]
  bufferRef?: { current: StagingBufferHandle | null }
}) {
  const buffer = useEditStagingBuffer()
  if (bufferRef) bufferRef.current = buffer
  const seededRef = useRef(false)
  if (!seededRef.current) {
    seededRef.current = true
    for (const edit of initialEdits) {
      buffer.append(edit)
    }
  }
  return <Panel {...props} buffer={buffer} />
}

const panelPositionProps = {
  position: { x: 1000, y: 12 },
  isSnapping: false,
  panelPointerDown: vi.fn(),
  panelPointerMove: vi.fn(),
  panelPointerUp: vi.fn(),
  panelPointerCancel: vi.fn(),
  // ZF0-1292: required since the architecture-review follow-up made the
  // prop mandatory. Tests that don't exercise HMR behavior pass 0 to keep
  // the Panel stable (no version bumps fired during the test body).
  hmrAppliedVersion: 0,
}

// Global defense-in-depth against fake-timer leakage across tests.
// A previous iteration had two tests that installed vi.useFakeTimers() and
// relied on end-of-test vi.useRealTimers() — when those tests threw an
// assertion error they skipped cleanup, leaving fake timers installed and
// causing every subsequent `await new Promise(r => setTimeout(r, 0))` to
// hang forever. See panel-section-order.test.ts for the same guard.
afterEach(() => {
  vi.useRealTimers()
  // Reset module-scope event-bus listeners (override-bus + transform-bus).
  // Panel + overlays subscribe to these in useEffect; a leaked listener from
  // a prior test (e.g., one that threw before unmount) fires on the next
  // test's emissions and contaminates assertions on render counts /
  // computed-style polling. ZF0-1322 root-cause fix.
  _resetBusForTesting()
  _resetTransformBusForTesting()
})

describe('Panel', () => {
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  function setup(element?: HTMLElement, overrides?: Partial<Parameters<typeof Panel>[0]>) {
    const target = element ?? (() => {
      const el = document.createElement('div')
      el.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
      el.className = 'test-target'
      document.body.appendChild(el)
      return el
    })()

    const onClose = vi.fn()
    const onSelectElement = vi.fn()
    const overrideManager = {
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
    }

    const result = renderInShadow(
      <Panel
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={onClose}
        onSelectElement={onSelectElement}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
        {...overrides}
      />
    )
    cleanup = () => {
      result.cleanup()
      target.remove()
    }
    return { ...result, onClose, onSelectElement, overrideManager, target }
  }

  it('renders panel with correct class', () => {
    const { root } = setup()
    const panel = root.querySelector('.cortex-panel')
    expect(panel).not.toBeNull()
  })

  it('plays the enter animation on mount only — does NOT replay on element switch (ZF0-1876)', async () => {
    // Contract: the cortex-panel--entering class (which triggers the 800ms+
    // staggered section-group cascade in styles.css:1256-1267) must apply on
    // initial Panel mount but NOT re-apply when the user switches selection
    // from one element to another while the Panel stays mounted. Switching
    // is a silent content swap (per Panel.tsx:505 — "sections update via
    // normal prop changes"). A future refactor that re-introduces the
    // [element] dep on the entering useEffect will fail the assertion below.
    const makeTarget = (source: string): HTMLElement => {
      const el = document.createElement('div')
      el.setAttribute('data-cortex-source', source)
      document.body.appendChild(el)
      return el
    }
    const elA = makeTarget('src/A.tsx:1:1')
    const elB = makeTarget('src/B.tsx:2:2')
    const overrideManager = createStubOverrideManager()
    const commonProps = {
      overrideManager: overrideManager as any,
      onClose: vi.fn(),
      onSelectElement: vi.fn(),
      buffer: makeFakeBuffer(),
      ...panelPositionProps,
    }
    const entering = (r: ParentNode): boolean =>
      r.querySelector('.cortex-panel')!.classList.contains('cortex-panel--entering')

    const { root, host } = renderInShadow(
      <Panel selectedElements={[elA]} {...commonProps} />,
    )
    cleanup = () => { host.remove(); elA.remove(); elB.remove() }

    // isEntering starts true on mount (useState(true)).
    expect(entering(root)).toBe(true)
    // Animation clears ~250ms after mount.
    await vi.waitFor(() => expect(entering(root)).toBe(false), { timeout: 800 })

    // Switching to a different element must NOT re-arm the animation.
    // act() flushes the element-switch effects synchronously so state updates
    // are committed before the assertion.
    act(() => { render(<Panel selectedElements={[elB]} {...commonProps} />, root) })

    // Poll for ~300ms after the switch, sampling at ~30ms intervals. A
    // single-sample-at-end check (codex P2 #1) would miss a delayed transient
    // flash that appears at t=100ms and clears by t=300ms. Polling catches
    // any window in which the class re-applied, not just the boundaries.
    const POLL_DURATION_MS = 300
    const POLL_INTERVAL_MS = 30
    const startTime = Date.now()
    while (Date.now() - startTime < POLL_DURATION_MS) {
      expect(entering(root)).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  })

  it('renders panel header with element info', () => {
    const { root } = setup()
    expect(root.textContent).toContain('Hero')
  })

  it('renders section labels', () => {
    // Use a text-bearing element so the Typography section renders.
    // The default setup() target is a childless <div> which intentionally
    // omits Typography (see `containsDirectText` helper in Panel.tsx).
    const target = document.createElement('p')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    target.appendChild(document.createTextNode('Hero heading'))
    document.body.appendChild(target)
    const { root } = setup(target)
    expect(root.textContent).toContain('Size')
    expect(root.textContent).toContain('Spacing')
    // v2: "Font" sub-label removed; the SectionGroup header reads "Typography"
    expect(root.textContent).toContain('Typography')
  })

  it('renders Phase 5b sections', () => {
    const { root } = setup()
    // BackgroundSection only renders when background has a value;
    // with a default transparent background, the group is present
    // but the section content is not. Assert the group exists.
    expect(root.querySelector('[data-group="background"]')).not.toBeNull()
    // BorderSection only renders when border has a value; with default
    // styles (borderStyle: 'none'), the group is present but the section
    // content is not. Same pattern as BackgroundSection above.
    expect(root.querySelector('[data-group="border"]')).not.toBeNull()
    // Task 15 consolidated ShadowSection + EffectsSection into a single
    // unified EffectsSection with data-section-id="effects".
    expect(root.querySelector('[data-section-id="effects"]')).not.toBeNull()
  })

  // Canonical section group count, data-group presence, and header label
  // order are all owned by tests/browser/panel-section-order.test.ts. Do not
  // re-assert them here — the array-equality tests in that file are the
  // single source of truth and any duplicate here would be subsumed.

  it('groups sections under correct parent groups', () => {
    const { root } = setup()
    const elementsGroup = root.querySelector('[data-group="elements"]')!
    expect(elementsGroup.querySelector('.cortex-layer-tree')).not.toBeNull()

    const layoutGroup = root.querySelector('[data-group="layout"]')!
    expect(layoutGroup.querySelector('[data-section-id="layout"]')).not.toBeNull()
    expect(layoutGroup.querySelector('[data-section-id="spacing"]')).not.toBeNull()

    const positionGroup = root.querySelector('[data-group="position"]')!
    expect(positionGroup.querySelector('[data-section-id="position"]')).not.toBeNull()

    // Background group always renders; BackgroundSection content renders
    // only when the background is non-transparent.  With default mock
    // styles the element has no background, so assert the group exists.
    const backgroundGroup = root.querySelector('[data-group="background"]')!
    expect(backgroundGroup).not.toBeNull()

    // Border group always renders; BorderSection content renders
    // only when the border has a value (borderStyle !== 'none'). With
    // default mock styles the element has no border, so assert the
    // group exists but section content is absent.
    const borderGroup = root.querySelector('[data-group="border"]')!
    expect(borderGroup).not.toBeNull()

    // Task 15 consolidated shadow + effects into a single EffectsSection.
    const effectsGroup = root.querySelector('[data-group="effects"]')!
    expect(effectsGroup.querySelector('[data-section-id="effects"]')).not.toBeNull()
  })

  it('places element navigation and hover controls in the Elements header', () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    const child = document.createElement('span')
    target.appendChild(child)
    document.body.appendChild(target)

    const { root, onSelectElement } = setup(target)
    const elementsGroup = root.querySelector('[data-group="elements"]')!
    const parentBtn = elementsGroup.querySelector('[data-action="parent"]') as HTMLButtonElement
    const childBtn = elementsGroup.querySelector('[data-action="child"]') as HTMLButtonElement
    const hoverBtn = elementsGroup.querySelector('[data-action="toggle-hover"]') as HTMLButtonElement

    expect(parentBtn).not.toBeNull()
    expect(childBtn).not.toBeNull()
    expect(hoverBtn).not.toBeNull()
    expect(root.querySelector('.cortex-panel-header [data-action="parent"]')).toBeNull()
    expect(hoverBtn.disabled).toBe(true)
    expect(hoverBtn.getAttribute('aria-pressed')).toBe('true')

    parentBtn.click()
    childBtn.click()

    expect(onSelectElement).toHaveBeenCalledWith(target.parentElement)
    expect(onSelectElement).toHaveBeenCalledWith(child)
  })

  // Fails on main today with no type widening at all: `hasChildren` counts
  // element.children unfiltered (so the button renders ENABLED), while
  // handleSelectChild filtered the first child to HTMLElement (so clicking it
  // did nothing). A div whose only child is an icon had a dead button.
  it('select-child navigates into an SVG first child', () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    target.appendChild(icon)
    document.body.appendChild(target)

    const { root, onSelectElement } = setup(target)
    const childBtn = root.querySelector('[data-group="elements"] [data-action="child"]') as HTMLButtonElement

    expect(childBtn.disabled).toBe(false)
    childBtn.click()
    expect(onSelectElement).toHaveBeenCalledWith(icon) // pre-fix: never called

    target.remove()
  })

  it('enables the hover overlay toggle when a handler is present and exposes pressed state', () => {
    const onToggleHover = vi.fn()
    const { root } = setup(undefined, { hoverEnabled: false, onToggleHover })
    const hoverBtn = root.querySelector('[data-action="toggle-hover"]') as HTMLButtonElement

    expect(hoverBtn.disabled).toBe(false)
    expect(hoverBtn.getAttribute('aria-pressed')).toBe('false')

    hoverBtn.click()
    expect(onToggleHover).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when close button clicked', () => {
    const { root, onClose } = setup()
    const closeBtn = root.querySelector('[data-action="close"]') as HTMLButtonElement
    closeBtn?.click()
    expect(onClose).toHaveBeenCalled()
  })

  // The empty-state branch (if !element) was deleted in Task 17 — Panel is
  // gated at the CortexApp level (Task 16) and never mounts without a selected
  // element. The `if (!element) return null` guard makes Panel no-element-safe.
  // This test pins both invariants and is FALSIFIABLE:
  //   - Remove the guard → main return derefs element.tagName → render throws.
  //   - Re-add the empty-state branch → rendering [] emits .cortex-panel markup
  //     instead of null → assertion fails.
  it('Panel renders nothing when no element is selected (empty-state branch deleted)', () => {
    const { root } = renderInShadow(
      <Panel
        selectedElements={[]}
        overrideManager={{} as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
    )
    // Guard returns null → no Panel output at all in the shadow tree.
    expect(root.querySelector('.cortex-panel')).toBeNull()
    expect(root.querySelector('.cortex-panel__empty')).toBeNull()
  })

  // NOTE: The old `cortex-panel--cross-fade` animation was removed in ZF0-1122
  // when LayerTree was introduced; see the comment at Panel.tsx around the
  // `useEffect(() => { ... prevElementRef.current !== element ... }, [element])`
  // block: "No cross-fade or body remount — sections update via normal prop
  // changes." The two cross-fade tests that used to live here asserted a class
  // that never rendered and were only passing-or-timing-out at random due to
  // a vi.useFakeTimers() cleanup that the failing assertion skipped. Deleted
  // as dead zombie tests rather than ported.

  it('re-detects typography bundle when element.className mutates (ZF0-1215 class observer)', async () => {
    // Invariant under test: Panel lives in a Preact shadow tree decoupled
    // from the user's React tree. When HMR rewrites the user's className,
    // the Panel MUST observe the mutation and re-run bundle detection so
    // the typography pill reflects the current class.
    //
    // Before the Task 17 observer fix, this test would show a stale bundle
    // name after className mutation because nothing bumped styleVersion.
    const BUNDLES = [
      { name: 'body-md', fontSize: '14px', lineHeight: '21px', letterSpacing: '0px', fontWeight: '400' },
      { name: 'heading-1', fontSize: '32px', lineHeight: '40px', letterSpacing: '-0.5px', fontWeight: '700' },
    ]

    const target = document.createElement('p')
    target.setAttribute('data-cortex-source', 'src/App.tsx:10:5')
    target.appendChild(document.createTextNode('Scenario'))
    target.className = 'text-heading-1'
    document.body.appendChild(target)
    const restoreStyles = mockGetComputedStyle(target, {
      fontSize: '32px',
      fontFamily: 'Inter',
      fontWeight: '700',
      lineHeight: '40px',
      letterSpacing: '-0.5px',
      textAlign: 'left',
      color: 'rgb(0,0,0)',
      display: 'block',
    })

    const overrideManager = createStubOverrideManager()
    const result = renderInShadow(
      <Panel
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        textComponents={BUNDLES}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />
    )
    cleanup = () => {
      result.cleanup()
      target.remove()
      restoreStyles()
    }

    // Initial render: pill shows heading-1.
    const typographySection = result.root.querySelector('[data-section-id="type"]')
    expect(typographySection).not.toBeNull()
    expect(typographySection!.textContent).toContain('heading-1')
    expect(typographySection!.textContent).not.toContain('body-md')

    // Mutate className — simulates React re-rendering after an HMR update.
    target.className = 'text-body-md'

    // Wait for MutationObserver callback + microtask coalescing + Preact re-render.
    await vi.waitFor(() => {
      expect(typographySection!.textContent).toContain('body-md')
      expect(typographySection!.textContent).not.toContain('heading-1')
    }, { timeout: 500 })
  })
})

describe('Panel — library detection wiring', () => {
  it('passes isLibrary and ancestor info to PanelHeader for node_modules element', async () => {
    // Create a library element (path includes /node_modules/)
    const libEl = document.createElement('div')
    libEl.setAttribute('data-cortex-source', '/project/node_modules/@ui/Button.tsx:10:3')
    document.body.appendChild(libEl)

    // Create a user-space ancestor
    const parent = document.createElement('div')
    parent.setAttribute('data-cortex-source', 'src/App.tsx:5:1')
    parent.appendChild(libEl)
    document.body.appendChild(parent)

    const overrideManager = createStubOverrideManager()

    const container = document.createElement('div')
    document.body.appendChild(container)

    render(
      <Panel
        selectedElements={[libEl]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      container,
    )
    // PanelHeader should show "(library)" badge
    await vi.waitFor(() => {
      const badge = container.querySelector('.cortex-panel-header__library')
      expect(badge).not.toBeNull()
      expect(badge?.textContent).toContain('library')
    }, { timeout: 500 })

    render(null, container)
    container.remove()
    parent.remove()
  })

  it('does not show library badge for user-space elements', async () => {
    const userEl = document.createElement('div')
    userEl.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    document.body.appendChild(userEl)

    const overrideManager = createStubOverrideManager()

    const container = document.createElement('div')
    document.body.appendChild(container)

    render(
      <Panel
        selectedElements={[userEl]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      container,
    )
    await new Promise(r => setTimeout(r, 0))

    const badge = container.querySelector('.cortex-panel-header__library')
    expect(badge).toBeNull()

    render(null, container)
    container.remove()
    userEl.remove()
  })
})

describe('Panel — activeState + activePseudo + dimming', () => {
  function createTarget(): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    el.className = 'test-target'
    document.body.appendChild(el)
    return el
  }

  function createOverrideManager() {
    return {
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
    }
  }

  it('re-reads computedStyles when activeState changes', async () => {
    const target = createTarget()
    const overrideManager = createOverrideManager()
    const container = document.createElement('div')
    document.body.appendChild(container)

    // Render with default state
    render(
      <Panel
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        activeState="default"
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      container,
    )
    await new Promise(r => setTimeout(r, 0))

    // Install mock + spy wrapper to detect getComputedStyle calls on our target
    const cleanupMock = mockGetComputedStyle(target, { color: 'rgb(255, 0, 0)' })
    let targetCallCount = 0
    const mockedGCS = window.getComputedStyle
    window.getComputedStyle = ((...args: [Element, string?]) => {
      if (args[0] === target) targetCallCount++
      return mockedGCS.apply(window, args)
    }) as typeof window.getComputedStyle

    // Re-render with hover state — should trigger useMemo re-read
    render(
      <Panel
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        activeState="hover"
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      container,
    )
    // useMemo must re-run when activeState changes — proves it's in the dep array
    await vi.waitFor(() => {
      expect(targetCallCount).toBeGreaterThanOrEqual(1)
    }, { timeout: 500 })

    cleanupMock()
    render(null, container)
    container.remove()
    target.remove()
  })

  it('uses getComputedStyle with pseudo when activePseudo is ::before', async () => {
    const target = createTarget()
    const overrideManager = createOverrideManager()
    const container = document.createElement('div')
    document.body.appendChild(container)

    // Mock pseudo computed styles
    const original = window.getComputedStyle
    const gcsCallLog: Array<{ target: Element; pseudo: string | null | undefined }> = []
    window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
      gcsCallLog.push({ target: el, pseudo })
      return original.call(window, el, pseudo)
    }) as typeof window.getComputedStyle

    // Render with hasBefore=true, then click the ::before tab
    render(
      <Panel
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        hasBefore={true}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      container,
    )
    await new Promise(r => setTimeout(r, 0))

    // Click the ::before pseudo tab
    const pseudoTab = container.querySelector('[data-pseudo="::before"]') as HTMLButtonElement
    expect(pseudoTab).not.toBeNull()
    pseudoTab?.click()
    // Verify getComputedStyle was called with '::before' pseudo
    await vi.waitFor(() => {
      const pseudoCalls = gcsCallLog.filter(c => c.target === target && c.pseudo === '::before')
      expect(pseudoCalls.length).toBeGreaterThan(0)
    }, { timeout: 500 })

    window.getComputedStyle = original
    render(null, container)
    container.remove()
    target.remove()
  })

  it('stores defaultComputedStyles snapshot on element mount (not on styleVersion)', async () => {
    const target = createTarget()
    const overrideManager = createOverrideManager()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const original = window.getComputedStyle
    let gcsCallCount = 0
    window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
      if (el === target && !pseudo) gcsCallCount++
      return original.call(window, el, pseudo)
    }) as typeof window.getComputedStyle

    // Initial render
    render(
      <Panel
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        activeState="default"
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      container,
    )
    // The defaultStylesRef should have been populated by the useEffect on [element].
    // Verify it was called at least once for the snapshot.
    await vi.waitFor(() => {
      expect(gcsCallCount).toBeGreaterThanOrEqual(1)
    }, { timeout: 500 })

    window.getComputedStyle = original
    render(null, container)
    container.remove()
    target.remove()
  })

  it('renders pseudo tabs when hasBefore or hasAfter is true', async () => {
    const target = createTarget()
    const overrideManager = createOverrideManager()
    const container = document.createElement('div')
    document.body.appendChild(container)

    render(
      <Panel
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        hasBefore={true}
        hasAfter={true}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      container,
    )
    // Should render pseudo tabs
    await vi.waitFor(() => {
      const tabs = container.querySelector('.cortex-pseudo-tabs')
      expect(tabs).not.toBeNull()
      expect(container.querySelector('[data-pseudo="::before"]')).not.toBeNull()
      expect(container.querySelector('[data-pseudo="::after"]')).not.toBeNull()
    }, { timeout: 500 })

    render(null, container)
    container.remove()
    target.remove()
  })

  it('does not render pseudo tabs when hasBefore and hasAfter are false', async () => {
    const target = createTarget()
    const overrideManager = createOverrideManager()
    const container = document.createElement('div')
    document.body.appendChild(container)

    render(
      <Panel
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      container,
    )
    await new Promise(r => setTimeout(r, 0))

    const tabs = container.querySelector('.cortex-pseudo-tabs')
    expect(tabs).toBeNull()

    render(null, container)
    container.remove()
    target.remove()
  })

  it('passes pseudo parameter to overrideManager.set when activePseudo is not element', async () => {
    const target = createTarget()
    const overrideManager = createOverrideManager()
    const container = document.createElement('div')
    document.body.appendChild(container)

    render(
      <Panel
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        hasBefore={true}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      container,
    )
    await new Promise(r => setTimeout(r, 0))

    // Click the ::before pseudo tab
    const pseudoTab = container.querySelector('[data-pseudo="::before"]') as HTMLButtonElement
    pseudoTab?.click()
    await vi.waitFor(() => {
      expect(pseudoTab?.classList.contains('cortex-pseudo-tab--active')).toBe(true)
    }, { timeout: 500 })

    // Trigger a property change via ArrowUp on a NumericInput to exercise the
    // applyOverride → overrideManager.set path with the pseudo parameter.
    const numericInput = container.querySelector('.cortex-numeric-input__value') as HTMLInputElement
    expect(numericInput).not.toBeNull()
    numericInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    // overrideManager.set must have been called with '::before' as the pseudo parameter
    await vi.waitFor(() => {
      const setCall = (overrideManager.set as ReturnType<typeof vi.fn>).mock.calls.find(
        (args: unknown[]) => args[3] === '::before'
      )
      expect(setCall).toBeDefined()
    }, { timeout: 500 })

    render(null, container)
    container.remove()
    target.remove()
  })

  // Bug #17: blast-radius style tag removed on unmount (ZF0-1321).
  // Preact's useEffect cleanup is registered only after the mount effect runs.
  // Under fake timers the mount effect is scheduled via an rAF/setTimeout race
  // inside preact/hooks `afterNextFrame`, and under concurrent fork load that
  // schedule doesn't reliably drain with `vi.advanceTimersByTimeAsync`. If the
  // mount effect never ran, `hook._cleanup` stays undefined, so Preact's
  // synchronous `options.unmount` -> `invokeCleanup` is a no-op and the style
  // tag survives. `act()` from preact/test-utils patches
  // `options.requestAnimationFrame` and synchronously drains the effect queue,
  // so wrapping mount AND unmount in act() guarantees `_cleanup` is set before
  // unmount. preact/test-utils ships with the preact package (no new dep) —
  // same primitive @testing-library/preact uses.
  it('removes blast-radius style tag from document.head on unmount', async () => {
    const el = document.createElement('div')
    const el2 = document.createElement('div')
    const container = document.createElement('div')

    try {
      el.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
      el.className = 'shared-class'
      document.body.appendChild(el)

      el2.setAttribute('data-cortex-source', 'src/Card.tsx:8:3')
      el2.className = 'shared-class'
      document.body.appendChild(el2)

      const overrideManager = {
        set: vi.fn(), get: vi.fn(), remove: vi.fn(), clearAll: vi.fn(),
        dispose: vi.fn(), flush: vi.fn(),
        hasAnyOverrides: vi.fn(() => false),
        readSourceValue: vi.fn(() => ''),
      }

      document.body.appendChild(container)

      await act(() => {
        render(
          <Panel selectedElements={[el]} overrideManager={overrideManager as any}
            onClose={() => {}} onSelectElement={() => {}} buffer={makeFakeBuffer()} {...panelPositionProps} />,
          container,
        )
      })

      // Manually inject the blast-radius style tag to simulate a highlight having occurred.
      // The style is lazily injected on first highlightSharedElements() call, not on mount.
      if (!document.head.querySelector('[data-cortex-blast-radius-style]')) {
        const style = document.createElement('style')
        style.setAttribute('data-cortex-blast-radius-style', '')
        style.textContent = '[data-cortex-blast-radius] { outline: 2px dashed #f97316 !important; }'
        document.head.appendChild(style)
      }

      expect(document.head.querySelector('[data-cortex-blast-radius-style]')).not.toBeNull()

      await act(() => {
        render(null, container)
      })

      expect(document.head.querySelector('[data-cortex-blast-radius-style]')).toBeNull()
    } finally {
      container.remove()
      el.remove()
      el2.remove()
    }
  })

  it('resets activePseudo to element when element changes', async () => {
    const el1 = createTarget()
    const el2 = document.createElement('div')
    el2.setAttribute('data-cortex-source', 'src/Card.tsx:8:3')
    document.body.appendChild(el2)

    const overrideManager = createOverrideManager()
    const container = document.createElement('div')
    document.body.appendChild(container)

    // Render with hasBefore, click ::before tab
    const fakeBufferForPseudoTest = makeFakeBuffer()
    render(
      <Panel
        selectedElements={[el1]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        hasBefore={true}
        buffer={fakeBufferForPseudoTest}
        {...panelPositionProps}
      />,
      container,
    )
    await new Promise(r => setTimeout(r, 0))

    const pseudoTab = container.querySelector('[data-pseudo="::before"]') as HTMLButtonElement
    pseudoTab?.click()
    await vi.waitFor(() => {
      expect(pseudoTab?.classList.contains('cortex-pseudo-tab--active')).toBe(true)
    }, { timeout: 500 })

    // Switch to a different element
    render(
      <Panel
        selectedElements={[el2]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        hasBefore={true}
        buffer={fakeBufferForPseudoTest}
        {...panelPositionProps}
      />,
      container,
    )
    // The element tab should be active (reset on element change)
    // Two microtask cycles needed: useEffect on [element] fires setActivePseudo('element'),
    // then re-render completes.
    await vi.waitFor(() => {
      const elementTab = container.querySelector('[data-pseudo="element"]') as HTMLButtonElement
      expect(elementTab?.classList.contains('cortex-pseudo-tab--active')).toBe(true)
    }, { timeout: 500 })

    render(null, container)
    container.remove()
    el1.remove()
    el2.remove()
  })
})

describe('Panel — hmrAppliedVersion (ZF0-1292)', () => {
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
    vi.useRealTimers()
  })

  // Panel — hmrAppliedVersion (ZF0-1292): the integration test that previously
  // lived here was deleted as part of ZF0-1360 rescope. The contract it verified
  // (Panel re-reads computed styles when hmrAppliedVersion prop changes) is now
  // covered by direct unit tests of `computePanelStyleSnapshot` in
  // tests/browser/components/panel-style-snapshot.test.ts. The integration test
  // was deterministically flaky on Linux Node 22 due to render-scheduler timing
  // pressure; the pure-function unit test is synchronous and immune.

  it('Panel re-runs computed-style read when hmrAppliedVersion bumps (deps-array contract)', () => {
    // Render with reference-stable props except hmrAppliedVersion. Spy on
    // window.getComputedStyle and assert call count strictly grows after
    // a version bump. This is the deterministic replacement for the
    // deleted integration test's deps-array assertion — synchronous,
    // no scheduler waits.
    const target = document.createElement('p')
    target.setAttribute('data-cortex-source', 'src/dummy.tsx:1:1')
    document.body.appendChild(target)

    const styles: Record<string, string> = {
      textAlign: 'left',
      fontSize: '16px',
      fontFamily: 'Inter',
      fontWeight: '400',
      lineHeight: '24px',
      letterSpacing: '0px',
      color: 'rgb(0,0,0)',
      display: 'block',
    }
    const restoreStyles = mockGetComputedStyle(target, styles)

    const overrideManager = createStubOverrideManager()

    // Capture every getComputedStyle invocation since the spy is set.
    const gcsSpy = vi.spyOn(window, 'getComputedStyle')

    const { root: shadowRoot, cleanup: removeHost } = createShadowHost()

    const fakeBufferForHmrTest = makeFakeBuffer()
    const renderPanel = (version: number): void => {
      render(
        <Panel
          selectedElements={[target]}
          overrideManager={overrideManager as any}
          onClose={() => {}}
          onSelectElement={() => {}}
          buffer={fakeBufferForHmrTest}
          {...panelPositionProps}
          hmrAppliedVersion={version}
        />,
        shadowRoot,
      )
    }

    try {
      renderPanel(0)
      const callsAfterFirstRender = gcsSpy.mock.calls.length
      expect(callsAfterFirstRender).toBeGreaterThan(0)

      // Bump version. All other props are reference-stable
      // (overrideManager same instance, panelPositionProps spread,
      // identity callbacks unchanged across the synchronous re-render).
      renderPanel(1)
      const callsAfterSecondRender = gcsSpy.mock.calls.length

      // The deps-array contract: hmrAppliedVersion change forces useMemo
      // re-run, which calls getComputedStyle again. Assertion is on
      // strict growth — exact count varies by platform but must increase.
      expect(callsAfterSecondRender).toBeGreaterThan(callsAfterFirstRender)
    } finally {
      gcsSpy.mockRestore()
      render(null, shadowRoot)
      removeHost()
      target.remove()
      restoreStyles()
    }
  })

  it('preserves editScope across hmrAppliedVersion bumps (split-useEffect regression guard)', async () => {
    // Locks in the commit f9b0e13 architectural fix: scope reset +
    // highlight clear fire ONLY on `[element]` changes, NOT on
    // `hmrAppliedVersion`. Without this split, an HMR cycle after the user
    // narrowed to "This element" would silently flip them back to the default
    // mid-edit. (Direction inverted with COR-12: the default is now "All", so
    // the deviation worth protecting is the narrowing.) Flagged as HIGH by three independent reviewers in the
    // ZF0-1292 architecture review. If someone merges the two useEffects
    // back into one, this test fails.

    // Create two siblings annotated with `data-cortex-css` pointing at the
    // same CSS module file + selector — this is what `detectSharedClasses`
    // treats as a shared class (count > 1).
    const sharedCss = 'Component.module.css:.badge'
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/component.tsx:5:3')
    target.setAttribute('data-cortex-css', sharedCss)
    target.appendChild(document.createTextNode('Target'))
    document.body.appendChild(target)

    const sibling = document.createElement('div')
    sibling.setAttribute('data-cortex-source', 'src/component.tsx:10:3')
    sibling.setAttribute('data-cortex-css', sharedCss)
    document.body.appendChild(sibling)

    // When scope === 'all', Panel iterates sharedInfo.elements and calls
    // `cs.getPropertyValue(prop)` on both the target's and siblings' computed
    // styles. The default mockGetComputedStyle returns a spread object that
    // drops the CSSStyleDeclaration prototype, so getPropertyValue is missing.
    // Install a Proxy-based mock that provides getPropertyValue on any element.
    const originalGCS = window.getComputedStyle
    const defaultStyles: Record<string, string> = { display: 'block' }
    const makeProxy = (styles: Record<string, string>): CSSStyleDeclaration =>
      new Proxy(styles, {
        get(obj, prop) {
          if (prop === 'getPropertyValue') {
            return (p: string) => {
              const camel = p.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
              return (obj as Record<string, string>)[camel] ?? (obj as Record<string, string>)[p] ?? ''
            }
          }
          return (obj as Record<string, string>)[prop as string] ?? ''
        },
      }) as unknown as CSSStyleDeclaration
    window.getComputedStyle = ((_el: Element, _pseudo?: string | null) =>
      makeProxy(defaultStyles)) as typeof window.getComputedStyle
    const restoreStyles = (): void => { window.getComputedStyle = originalGCS }

    const overrideManager = createStubOverrideManager()

    const { shadow, root: shadowRoot, cleanup: removeHost } = createShadowHost()
    const fakeBufferForScopeTest = makeFakeBuffer()
    const renderPanel = (version: number): void => {
      render(
        <Panel
          selectedElements={[target]}
          overrideManager={overrideManager as any}
          onClose={() => {}}
          onSelectElement={() => {}}
          buffer={fakeBufferForScopeTest}
          {...panelPositionProps}
          hmrAppliedVersion={version}
        />,
        shadowRoot,
      )
    }

    renderPanel(0)
    cleanup = () => {
      render(null, shadowRoot)
      removeHost()
      target.remove()
      sibling.remove()
      restoreStyles()
      void shadow
    }

    // Sanity: the scope toggle is rendered, meaning detectSharedClasses
    // found 2+ matching elements and sharedInfo is non-null.
    let allBtn!: HTMLButtonElement
    let instanceBtn!: HTMLButtonElement
    await vi.waitFor(() => {
      allBtn = shadowRoot.querySelector('.cortex-panel__scope-btn:last-child') as HTMLButtonElement
      expect(allBtn).not.toBeNull()
      expect(allBtn!.textContent).toContain('All')
      instanceBtn = shadowRoot.querySelector('.cortex-panel__scope-btn:first-child') as HTMLButtonElement
      // Initial state: "All" is active — edit-all is the default (COR-12).
      expect(allBtn!.classList.contains('cortex-panel__scope-btn--active')).toBe(true)
      expect(instanceBtn.classList.contains('cortex-panel__scope-btn--active')).toBe(false)
    }, { timeout: 500 })

    // User clicks "This element" to narrow scope. Testing the DEVIATION from the
    // default is the stronger direction: an HMR bump silently restoring the
    // default is exactly the regression this guards, and it is only observable
    // when the user has moved away from it.
    instanceBtn.click()
    await vi.waitFor(() => {
      expect(instanceBtn.classList.contains('cortex-panel__scope-btn--active')).toBe(true)
      expect(allBtn!.classList.contains('cortex-panel__scope-btn--active')).toBe(false)
    }, { timeout: 500 })

    // Now bump hmrAppliedVersion — simulates an HMR cycle (stylesheet edit,
    // @theme token change, etc). The invariant under test: scope stays "All".
    renderPanel(1)
    // Re-query because Preact may have reconciled the buttons.
    await vi.waitFor(() => {
      const allBtnAfter = shadowRoot.querySelector('.cortex-panel__scope-btn:last-child') as HTMLButtonElement
      const instanceBtnAfter = shadowRoot.querySelector('.cortex-panel__scope-btn:first-child') as HTMLButtonElement
      expect(instanceBtnAfter.classList.contains('cortex-panel__scope-btn--active')).toBe(true)
      expect(allBtnAfter.classList.contains('cortex-panel__scope-btn--active')).toBe(false)
    }, { timeout: 500 })
  })
})

describe('Panel mixedProperties (ZF0-1195 / T3)', () => {
  function createOverrideManager() {
    return {
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
    }
  }

  it('mixedProperties is empty for single selection — no mixed-state controls rendered', () => {
    const el = document.createElement('div')
    el.setAttribute('data-cortex-source', 'src/Single.tsx:1:1')
    document.body.appendChild(el)

    const overrideManager = createOverrideManager()
    const container = document.createElement('div')
    document.body.appendChild(container)

    render(
      <Panel
        selectedElements={[el]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      container,
    )

    // No mixed-state NumericInput (class .cortex-numeric-input--mixed) should appear
    // for a single-element selection, even if the panel renders controls
    expect(container.querySelector('.cortex-numeric-input--mixed')).toBeNull()

    render(null, container)
    container.remove()
    el.remove()
  })

  it('mixedProperties populated when selected elements have differing opacity', async () => {
    // Create two elements with different computed opacity values
    const el1 = document.createElement('div')
    el1.setAttribute('data-cortex-source', 'src/A.tsx:1:1')
    const el2 = document.createElement('div')
    el2.setAttribute('data-cortex-source', 'src/B.tsx:2:2')
    document.body.appendChild(el1)
    document.body.appendChild(el2)

    // Override getComputedStyle to return differing opacity for the two elements.
    // PR #104 review I3: wrap in try/finally so the global is restored even if
    // the assertion or waitFor throws — otherwise the proxy leaks into later
    // tests and produces unrelated failures.
    const originalGCS = window.getComputedStyle
    const overrideManager = createOverrideManager()
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      window.getComputedStyle = ((target: Element, pseudo?: string | null) => {
        if (target === el1) {
          const base = originalGCS.call(window, target, pseudo)
          return new Proxy(base, {
            get(obj, prop) {
              if (prop === 'getPropertyValue') {
                return (p: string) => p === 'opacity' ? '1' : (obj as any).getPropertyValue?.(p) ?? ''
              }
              if (prop === 'opacity') return '1'
              return (obj as any)[prop]
            },
          }) as CSSStyleDeclaration
        }
        if (target === el2) {
          const base = originalGCS.call(window, target, pseudo)
          return new Proxy(base, {
            get(obj, prop) {
              if (prop === 'getPropertyValue') {
                return (p: string) => p === 'opacity' ? '0.5' : (obj as any).getPropertyValue?.(p) ?? ''
              }
              if (prop === 'opacity') return '0.5'
              return (obj as any)[prop]
            },
          }) as CSSStyleDeclaration
        }
        return originalGCS.call(window, target, pseudo)
      }) as typeof window.getComputedStyle

      render(
        <Panel
          selectedElements={[el1, el2]}
          overrideManager={overrideManager as any}
          onClose={() => {}}
          onSelectElement={() => {}}
          buffer={makeFakeBuffer()}
          {...panelPositionProps}
        />,
        container,
      )

      // When opacity differs across selection, AppearanceSection's opacity NumericInput
      // should be in mixed state (renders with .cortex-numeric-input--mixed class)
      await vi.waitFor(() => {
        const mixedInputs = container.querySelectorAll('.cortex-numeric-input--mixed')
        expect(mixedInputs.length).toBeGreaterThan(0)
      }, { timeout: 500 })
    } finally {
      window.getComputedStyle = originalGCS
      render(null, container)
      container.remove()
      el1.remove()
      el2.remove()
    }
  })
})

describe('Panel — staging buffer wiring (ZF0-1451)', () => {
  beforeEach(() => {
    // Clear before each test so leftover state from a sibling test or other
    // suite can't satisfy assertions accidentally (CLAUDE.md anti-pattern #2).
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    _resetBusForTesting()
    _resetTransformBusForTesting()
  })

  it('commitScrub appends PendingEdit to staging buffer', async () => {
    vi.useFakeTimers()

    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    document.body.appendChild(target)

    // overrideManager.set is called by applyOverride to store the new value.
    // overrideManager.get in commitScrub gets the current override value.
    // We use a Map to simulate: after set(source, prop, val), get(source, prop) returns val.
    // This way previousValue (from getComputedStyle = '' for default div) !== currentValue (the set value).
    const overrideStore = new Map<string, string>()
    const overrideManager = {
      set: vi.fn((src: string, prop: string, val: string) => {
        overrideStore.set(`${src}\0${prop}`, val)
      }),
      get: vi.fn((src: string, prop: string) => overrideStore.get(`${src}\0${prop}`)),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
    }

    const bufferRef: { current: StagingBufferHandle | null } = { current: null }
    const { root, cleanup } = renderInShadow(
      <PanelWithRealBuffer
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        bufferRef={bufferRef}
        {...panelPositionProps}
      />
    )

    // Click a non-active SegmentedControl option in the layout section.
    // The first SegmentedControl in the layout section is Display, so
    // capturing the segment's `data-value` at click time lets us assert
    // the exact property/value pair that flows to the staging buffer
    // (CLAUDE.md "Test Anti-Patterns" #2 — assertions must be falsifiable).
    const layoutSection = root.querySelector('[data-section-id="layout"]')
    expect(layoutSection).not.toBeNull()
    const segment = layoutSection!.querySelector(
      '.cortex-segmented__option:not(.cortex-segmented__option--active)',
    ) as HTMLButtonElement | null
    expect(segment).not.toBeNull()
    const expectedValue = segment!.getAttribute('data-value')
    expect(expectedValue).not.toBeNull()
    expect(expectedValue).not.toBe('')

    await act(async () => {
      segment!.click()
      // Allow microtask commit to fire (queueMicrotask in applyOverride)
      await Promise.resolve()
    })

    // Change 4: memory-only — assert in-memory buffer directly (no localStorage).
    // append() is synchronous; the intent is in the buffer immediately after the click.
    const stored = bufferRef.current!.list()
    expect(stored.length).toBeGreaterThan(0)
    const edit = stored[0]
    expect(edit.source).toBe('src/Hero.tsx:14:5')
    expect(edit.property).toBe('display')
    expect(edit.value).toBe(expectedValue)
    // Accepts both crypto.randomUUID() output and generateId()'s non-secure-context
    // fallback (cortex-<base36>-<base36>) — see uuid.ts.
    expect(edit.intentId).toMatch(/^[0-9a-f-]{36}$|^cortex-[0-9a-z]+-[0-9a-z]+$/)
    expect(edit.timestamp).toBeGreaterThan(0)

    cleanup()
    target.remove()
  })

  it('commitScrub stages unannotated visual elements as agent-resolve intents', async () => {
    vi.useFakeTimers()

    const target = document.createElement('div')
    target.className = 'hero-card'
    target.textContent = 'Unannotated hero'
    document.body.appendChild(target)

    const overrideStore = new Map<string, string>()
    const overrideManager = {
      set: vi.fn((src: string, prop: string, val: string) => {
        overrideStore.set(`${src}\0${prop}`, val)
      }),
      get: vi.fn((src: string, prop: string) => overrideStore.get(`${src}\0${prop}`)),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
    }

    const bufferRef2: { current: StagingBufferHandle | null } = { current: null }
    const { root, cleanup } = renderInShadow(
      <PanelWithRealBuffer
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        bufferRef={bufferRef2}
        {...panelPositionProps}
      />
    )

    const layoutSection = root.querySelector('[data-section-id="layout"]')
    expect(layoutSection).not.toBeNull()
    const segment = layoutSection!.querySelector(
      '.cortex-segmented__option:not(.cortex-segmented__option--active)',
    ) as HTMLButtonElement | null
    expect(segment).not.toBeNull()
    const expectedValue = segment!.getAttribute('data-value')
    expect(expectedValue).not.toBeNull()

    await act(async () => {
      segment!.click()
      await Promise.resolve()
    })

    // Change 4: memory-only — assert in-memory buffer directly.
    const stored = bufferRef2.current!.list()
    expect(stored).toHaveLength(1)
    expect(stored[0].source).toMatch(/^cortex-preview:/)
    expect(stored[0].applyMode).toBe('agent-resolve')
    expect(stored[0].property).toBe('display')
    expect(stored[0].value).toBe(expectedValue)
    expect(stored[0].sourceResolutionHint).toMatchObject({
      tagName: 'div',
      className: 'hero-card',
      textPreview: 'Unannotated hero',
    })

    cleanup()
    target.remove()
  })

  it('coalesces color picker drag updates into one PropertyEditCommand (ZF0-1569)', async () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    document.body.appendChild(target)

    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
      const base = originalGetComputedStyle.call(window, el, pseudo)
      if (el !== target) return base
      return new Proxy(base, {
        get(obj, prop) {
          if (prop === 'backgroundColor') return '#000000'
          if (prop === 'backgroundImage') return 'none'
          if (prop === 'getPropertyValue') {
            return (property: string) => {
              if (property === 'background-color') return '#000000'
              if (property === 'background-image') return 'none'
              return base.getPropertyValue(property)
            }
          }
          return (obj as any)[prop]
        },
      }) as CSSStyleDeclaration
    }) as typeof window.getComputedStyle

    const overrideStore = new Map<string, string>()
    const overrideManager = {
      set: vi.fn((src: string, prop: string, val: string, pseudo?: string) => {
        overrideStore.set(`${src}\0${prop}\0${pseudo ?? ''}`, val)
      }),
      get: vi.fn((src: string, prop: string, pseudo?: string) =>
        overrideStore.get(`${src}\0${prop}\0${pseudo ?? ''}`),
      ),
      remove: vi.fn((src: string, prop: string, pseudo?: string) => {
        overrideStore.delete(`${src}\0${prop}\0${pseudo ?? ''}`)
      }),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
    }
    const commandStack = new CommandStack()

    const { root, cleanup } = renderInShadow(
      <PanelWithRealBuffer
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        commandStack={commandStack}
        onClose={() => {}}
        onSelectElement={() => {}}
        {...panelPositionProps}
      />,
    )

    try {
      const swatch = root.querySelector('.cortex-color-input__swatch') as HTMLButtonElement | null
      expect(swatch).not.toBeNull()

      await act(async () => {
        swatch!.click()
        await new Promise(r => setTimeout(r, 0))
      })

      const picker = root.querySelector('hex-color-picker') as HTMLElement | null
      expect(picker).not.toBeNull()

      const emitColor = async (value: string) => {
        await act(async () => {
          picker!.dispatchEvent(new CustomEvent('color-changed', {
            bubbles: true,
            composed: true,
            detail: { value },
          }))
          await Promise.resolve()
        })
      }

      await act(async () => {
        picker!.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true,
          composed: true,
          cancelable: true,
          button: 0,
        }))
      })

      await emitColor('#111111')
      await emitColor('#222222')
      await emitColor('#333333')

      expect(commandStack.undoCount).toBe(0)
      expect(overrideManager.set).toHaveBeenLastCalledWith(
        'src/Hero.tsx:14:5',
        'background-color',
        '#333333',
        undefined,
      )

      await act(async () => {
        document.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true,
          composed: true,
          cancelable: true,
          button: 0,
        }))
        await Promise.resolve()
      })

      expect(commandStack.undoCount).toBe(1)
      const cmd = commandStack.peekUndo()
      expect(cmd?.changes).toEqual([
        {
          source: 'src/Hero.tsx:14:5',
          property: 'background-color',
          value: '#333333',
          previousValue: '#000000',
          pseudo: undefined,
        },
      ])
    } finally {
      cleanup()
      target.remove()
      window.getComputedStyle = originalGetComputedStyle
    }
  })

  it('unlinks a background color token by removing the class and preserving the rendered color', async () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    target.className = 'bg-white'
    document.body.appendChild(target)

    const restoreStyles = mockGetComputedStyle(target, {
      backgroundColor: 'rgb(255, 255, 255)',
      backgroundImage: 'none',
      borderWidth: '0px',
      borderTopWidth: '0px',
      borderRightWidth: '0px',
      borderBottomWidth: '0px',
      borderLeftWidth: '0px',
      borderStyle: 'none',
    })
    const overrideManager = {
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
      trackPendingEdit: vi.fn(),
    }
    const channel = createMockChannel()
    const commandStack = new CommandStack()

    const { root, cleanup } = renderInShadow(
      <PanelWithRealBuffer
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        commandStack={commandStack}
        channel={channel}
        onClose={() => {}}
        onSelectElement={() => {}}
        {...panelPositionProps}
      />,
    )

    try {
      const unlink = root.querySelector('button[aria-label="Detach token"]') as HTMLButtonElement | null
      expect(unlink).not.toBeNull()

      await act(async () => {
        unlink!.click()
        await Promise.resolve()
      })

      const editMessage = channel._lastSent.find(
        (msg): msg is { type: string } => (msg as { type?: string }).type === 'edit',
      )
      expect(editMessage).toMatchObject({
        type: 'edit',
        source: 'src/Hero.tsx:14:5',
        classOp: { kind: 'remove', remove: 'bg-white' },
        inlineSets: [{ property: 'background-color', value: 'rgb(255, 255, 255)' }],
        // COR-12: a class op declares 'instance' on the wire because that is
        // what it DOES — it rewrites one className attribute and has no fan-out.
        // Omitting the field let the message stay silent while the panel's scope
        // default (now 'all') implied otherwise; codex flagged the mismatch.
        scope: 'instance',
      })
      expect(commandStack.undoCount).toBe(1)
    } finally {
      cleanup()
      restoreStyles()
      target.remove()
    }
  })

  it('links a raw background color back to a color token', async () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    document.body.appendChild(target)

    const restoreStyles = mockGetComputedStyle(target, {
      backgroundColor: 'rgb(59, 130, 246)',
      backgroundImage: 'none',
      borderWidth: '0px',
      borderTopWidth: '0px',
      borderRightWidth: '0px',
      borderBottomWidth: '0px',
      borderLeftWidth: '0px',
      borderStyle: 'none',
    })
    const overrideManager = {
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
      trackPendingEdit: vi.fn(),
    }
    const channel = createMockChannel()
    const commandStack = new CommandStack()

    const { root, cleanup } = renderInShadow(
      <PanelWithRealBuffer
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        commandStack={commandStack}
        channel={channel}
        colorChips={[{ name: 'brand-500', hex: '#3b82f6' }]}
        onClose={() => {}}
        onSelectElement={() => {}}
        {...panelPositionProps}
      />,
    )

    try {
      const link = root.querySelector('button[aria-label="Link to color chip"]') as HTMLButtonElement | null
      expect(link).not.toBeNull()

      await act(async () => {
        link!.click()
        await Promise.resolve()
      })

      const option = root.querySelector('.cortex-color-chip-picker__option') as HTMLButtonElement | null
      expect(option).not.toBeNull()

      await act(async () => {
        option!.click()
        await Promise.resolve()
      })

      const editMessage = channel._lastSent.find(
        (msg): msg is { type: string } => (msg as { type?: string }).type === 'edit',
      )
      expect(editMessage).toMatchObject({
        type: 'edit',
        source: 'src/Hero.tsx:14:5',
        classOp: { kind: 'add', add: 'bg-brand-500' },
        inlineRemoves: [{ property: 'background-color' }],
      })
      expect(commandStack.undoCount).toBe(1)
    } finally {
      cleanup()
      restoreStyles()
      target.remove()
    }
  })

  it('unlinks a border color token by removing the class and preserving the rendered color', async () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    target.className = 'border border-slate-200'
    document.body.appendChild(target)

    const restoreStyles = mockGetComputedStyle(target, {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      backgroundImage: 'none',
      borderWidth: '1px',
      borderTopWidth: '1px',
      borderRightWidth: '1px',
      borderBottomWidth: '1px',
      borderLeftWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'rgb(226, 232, 240)',
    })
    const overrideManager = {
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
      trackPendingEdit: vi.fn(),
    }
    const channel = createMockChannel()
    const commandStack = new CommandStack()

    const { root, cleanup } = renderInShadow(
      <PanelWithRealBuffer
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        commandStack={commandStack}
        channel={channel}
        onClose={() => {}}
        onSelectElement={() => {}}
        {...panelPositionProps}
      />,
    )

    try {
      const unlink = root.querySelector('button[aria-label="Detach token"]') as HTMLButtonElement | null
      expect(unlink).not.toBeNull()

      await act(async () => {
        unlink!.click()
        await Promise.resolve()
      })

      const editMessage = channel._lastSent.find(
        (msg): msg is { type: string } => (msg as { type?: string }).type === 'edit',
      )
      expect(editMessage).toMatchObject({
        type: 'edit',
        source: 'src/Hero.tsx:14:5',
        classOp: { kind: 'remove', remove: 'border-slate-200' },
        inlineSets: [{ property: 'border-color', value: 'rgb(226, 232, 240)' }],
      })
      expect(commandStack.undoCount).toBe(1)
    } finally {
      cleanup()
      restoreStyles()
      target.remove()
    }
  })

  it('links a raw border color back to a color token', async () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    document.body.appendChild(target)

    const restoreStyles = mockGetComputedStyle(target, {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      backgroundImage: 'none',
      borderWidth: '1px',
      borderTopWidth: '1px',
      borderRightWidth: '1px',
      borderBottomWidth: '1px',
      borderLeftWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'rgb(59, 130, 246)',
    })
    const overrideManager = {
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
      trackPendingEdit: vi.fn(),
    }
    const channel = createMockChannel()
    const commandStack = new CommandStack()

    const { root, cleanup } = renderInShadow(
      <PanelWithRealBuffer
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        commandStack={commandStack}
        channel={channel}
        colorChips={[{ name: 'brand-500', hex: '#3b82f6' }]}
        onClose={() => {}}
        onSelectElement={() => {}}
        {...panelPositionProps}
      />,
    )

    try {
      const link = root.querySelector('button[aria-label="Link to color chip"]') as HTMLButtonElement | null
      expect(link).not.toBeNull()

      await act(async () => {
        link!.click()
        await Promise.resolve()
      })

      const option = root.querySelector('.cortex-color-chip-picker__option') as HTMLButtonElement | null
      expect(option).not.toBeNull()

      await act(async () => {
        option!.click()
        await Promise.resolve()
      })

      const editMessage = channel._lastSent.find(
        (msg): msg is { type: string } => (msg as { type?: string }).type === 'edit',
      )
      expect(editMessage).toMatchObject({
        type: 'edit',
        source: 'src/Hero.tsx:14:5',
        classOp: { kind: 'add', add: 'border-brand-500' },
        inlineRemoves: [{ property: 'border-color' }],
      })
      expect(commandStack.undoCount).toBe(1)
    } finally {
      cleanup()
      restoreStyles()
      target.remove()
    }
  })

  it('buffer.remove() removes intents from canonical buffer (staged-edits-discard now CortexApp-owned)', async () => {
    // ZF0-1869 Round-1 Fix 1: staged-edits-discard is now handled in CortexApp
    // (not Panel) so it survives Panel unmount on deselect. This test validates
    // that buffer.remove() correctly removes the discarded intent — the same call
    // CortexApp makes in its onMessage handler when staged-edits-discard arrives.
    // The channel-simulation path is intentionally dropped: Panel no longer
    // subscribes to staged-edits-discard. CortexApp-level wire coverage is in
    // cortex-app.test.tsx.

    const initialEdits: PendingEdit[] = [
      {
        intentId: 'keep-me',
        source: 'src/A.tsx:1:1',
        property: 'color',
        value: 'red',
        previousValue: 'blue',
        timestamp: 1000,
      },
      {
        intentId: 'discard-me',
        source: 'src/B.tsx:2:2',
        property: 'font-size',
        value: '16px',
        previousValue: '14px',
        timestamp: 2000,
      },
    ]

    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/A.tsx:1:1')
    document.body.appendChild(target)

    const channel = createMockChannel()
    const overrideManager = {
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
    }

    const discardBufRef: { current: StagingBufferHandle | null } = { current: null }
    const { cleanup } = renderInShadow(
      <PanelWithInitEdits
        initialEdits={initialEdits}
        selectedElements={[target]}
        channel={channel}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        bufferRef={discardBufRef}
        {...panelPositionProps}
      />,
    )

    // Flush effects so Panel mounts fully.
    await act(async () => {
      await new Promise(r => setTimeout(r, 50))
    })

    // CortexApp (not Panel) handles staged-edits-discard. Simulate what CortexApp
    // does in its onMessage handler: call buffer.remove() with the discarded IDs.
    await act(async () => {
      discardBufRef.current!.remove(['discard-me'])
      await Promise.resolve()
    })

    // remove() is synchronous; assert in-memory buffer directly.
    const remaining = discardBufRef.current!.list()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].intentId).toBe('keep-me')

    cleanup()
    target.remove()
  })

  it('applyError prop surfaces reason in applyError banner (ZF0-1869 Round-1 Fix 1)', async () => {
    // ZF0-1869 Round-1 Fix 1: applyError state lifted to CortexApp. Panel now
    // receives the error string as the `applyError` prop (set by CortexApp's
    // onMessage handler when source-edit-failed arrives). This test validates
    // that Panel renders the banner from the prop.
    // The channel-simulation path is dropped: Panel no longer subscribes to
    // source-edit-failed. CortexApp-level wire coverage is in cortex-app.test.tsx.
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/App.tsx:31:5')
    document.body.appendChild(target)

    const channel = createMockChannel()
    const overrideManager = {
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
    }

    const reason = "couldn't find pattern at App.tsx:31"

    const { root, cleanup } = renderInShadow(
      <PanelWithInitEdits
        initialEdits={[]}
        selectedElements={[target]}
        channel={channel}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        applyError={reason}
        onSetApplyError={() => {}}
        {...panelPositionProps}
      />,
    )

    // Flush effects so Panel mounts fully.
    await act(async () => {
      await new Promise(r => setTimeout(r, 50))
    })

    // Banner must be visible and contain the reason.
    const banner = root.querySelector('.cortex-apply-error[role="alert"]')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain(reason)

    cleanup()
    target.remove()
  })
})

describe('commitScrub multi-select fan-out (ZF0-1195 / T4)', () => {
  // Shared override-manager factory that actually stores values so commitScrub
  // can distinguish changed from unchanged properties.
  function createTrackingOverrideManager(sourceValue = '') {
    const store = new Map<string, string>()
    return {
      set: vi.fn((src: string, prop: string, val: string, _pseudo?: string) => {
        store.set(`${src}\0${prop}`, val)
      }),
      get: vi.fn((src: string, prop: string, _pseudo?: string) =>
        store.get(`${src}\0${prop}`),
      ),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      // Mirrors the real manager: true once anything is staged. Panel uses this
      // to decide whether a plain computed read is trustworthy as a baseline.
      hasAnyOverrides: vi.fn(() => store.size > 0),
      // Stands in for the override-bypassing read. Tests that care about the
      // baseline override this via `sourceValue`.
      readSourceValue: vi.fn(() => sourceValue),
      _store: store,
    }
  }

  // Install a getComputedStyle proxy that provides getPropertyValue on any
  // element (needed when applyOverride reads computed styles for previousValue).
  //  `store` (optional): when supplied, the proxy models what a REAL browser does
  //  — computed style REFLECTS a staged !important override. Without it the proxy
  //  returns the source value no matter what is staged, and a baseline test cannot
  //  distinguish readSourceValue (which detaches the override sheet) from a plain
  //  computed read (which does not). That made the chained-baseline test pass
  //  against an implementation that read computed style directly.
  function installGCSProxy(values: Record<string, string> = {}, store?: Map<string, string>): () => void {
    const original = window.getComputedStyle
    window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
      const base = original.call(window, el, pseudo)
      return new Proxy(base, {
        get(obj, prop) {
          if (prop === 'getPropertyValue') {
            return (p: string) => {
              const src = el.getAttribute?.('data-cortex-source')
              const staged = src ? store?.get(`${src}\0${p}`) : undefined
              return staged ?? values[p] ?? ''
            }
          }
          return (obj as any)[prop]
        },
      }) as CSSStyleDeclaration
    }) as typeof window.getComputedStyle
    return () => { window.getComputedStyle = original }
  }

  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    _resetBusForTesting()
    _resetTransformBusForTesting()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    _resetBusForTesting()
    _resetTransformBusForTesting()
  })

  // Helper: trigger a single commitScrub by clicking an inactive SegmentedControl
  // option in the layout section. Returns the clicked segment's data-value.
  async function triggerCommitScrub(container: Element): Promise<string | null> {
    const layoutSection = container.querySelector('[data-section-id="layout"]')
    if (!layoutSection) return null
    const segment = layoutSection.querySelector(
      '.cortex-segmented__option:not(.cortex-segmented__option--active)',
    ) as HTMLButtonElement | null
    if (!segment) return null
    const expectedValue = segment.getAttribute('data-value')
    await act(async () => {
      segment.click()
      await Promise.resolve() // flush microtask commit
    })
    return expectedValue
  }

  it('AC1: 2-element selection appends 2 intents with correct sources', async () => {
    const el1 = document.createElement('div')
    el1.setAttribute('data-cortex-source', 'src/A.tsx:10:3')
    const el2 = document.createElement('div')
    el2.setAttribute('data-cortex-source', 'src/B.tsx:20:3')
    document.body.append(el1, el2)

    const overrideManager = createTrackingOverrideManager()
    const restoreGCS = installGCSProxy()
    const commandStack = new CommandStack()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const ac1BufRef: { current: StagingBufferHandle | null } = { current: null }
    render(
      <PanelWithRealBuffer
        selectedElements={[el1, el2]}
        overrideManager={overrideManager as any}
        commandStack={commandStack}
        onClose={() => {}}
        onSelectElement={() => {}}
        bufferRef={ac1BufRef}
        {...panelPositionProps}
      />,
      container,
    )

    await triggerCommitScrub(container)

    // Change 4: memory-only — assert in-memory buffer directly.
    const stored = ac1BufRef.current!.list()
    expect(stored).toHaveLength(2)

    const sources = stored.map(e => e.source).sort()
    expect(sources).toEqual(['src/A.tsx:10:3', 'src/B.tsx:20:3'])

    for (const e of stored) {
      expect(e.instanceSources).toBeUndefined()
      // 'instance', NOT the editScope default: the MULTI-select branch computes
      // scope from `isShared`, not from the toggle. COR-12's default flip does
      // not reach here, and changing this to 'all' was wrong — the suite caught it.
      expect(e.scope).toBe('instance')
      expect(e.property).toBe('display')
      expect(e.intentId).toMatch(/^[0-9a-f-]{36}$|^cortex-[0-9a-z]+-[0-9a-z]+$/)
    }

    // O(N²) intent-inflation guard: assert the command's pendingEdits array
    // has exactly N entries, not N² × P. The buffer's last-write-wins dedup
    // hides inflation from the surface `stored` array — we MUST inspect the
    // command directly to catch a regression where each outer-loop iteration
    // pushes intents for every source's properties (not just its own).
    expect(commandStack.undoCount).toBe(1)
    const cmd = commandStack.peekUndo()!
    // pendingEdits is private on PropertyEditCommand; access via cast for test.
    // @ts-expect-error — accessing private field for inflation regression check
    const cmdPendingEdits: readonly PendingEdit[] = cmd.pendingEdits
    expect(cmdPendingEdits).toHaveLength(2)
    expect(new Set(cmdPendingEdits.map(e => e.source))).toEqual(new Set([
      'src/A.tsx:10:3',
      'src/B.tsx:20:3',
    ]))

    render(null, container)
    container.remove()
    restoreGCS()
    el1.remove()
    el2.remove()
  })

  it('AC5: 3-element selection appends 3 intents', async () => {
    const el1 = document.createElement('div')
    el1.setAttribute('data-cortex-source', 'src/A.tsx:10:3')
    const el2 = document.createElement('div')
    el2.setAttribute('data-cortex-source', 'src/B.tsx:20:3')
    const el3 = document.createElement('div')
    el3.setAttribute('data-cortex-source', 'src/C.tsx:30:3')
    document.body.append(el1, el2, el3)

    const overrideManager = createTrackingOverrideManager()
    const restoreGCS = installGCSProxy()
    const commandStack = new CommandStack()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const ac5BufRef: { current: StagingBufferHandle | null } = { current: null }
    render(
      <PanelWithRealBuffer
        selectedElements={[el1, el2, el3]}
        overrideManager={overrideManager as any}
        commandStack={commandStack}
        onClose={() => {}}
        onSelectElement={() => {}}
        bufferRef={ac5BufRef}
        {...panelPositionProps}
      />,
      container,
    )

    await triggerCommitScrub(container)

    // Change 4: memory-only — assert in-memory buffer directly.
    const stored = ac5BufRef.current!.list()
    expect(stored).toHaveLength(3)

    const sources = stored.map(e => e.source).sort()
    expect(sources).toEqual(['src/A.tsx:10:3', 'src/B.tsx:20:3', 'src/C.tsx:30:3'])

    // O(N²) inflation guard at N=3: command.pendingEdits must be 3, not 9.
    // Without this assertion the buffer-dedup'd `stored` would hide the bug.
    expect(commandStack.undoCount).toBe(1)
    const cmd = commandStack.peekUndo()!
    // @ts-expect-error — accessing private field for inflation regression check
    const cmdPendingEdits: readonly PendingEdit[] = cmd.pendingEdits
    expect(cmdPendingEdits).toHaveLength(3)
    expect(new Set(cmdPendingEdits.map(e => e.source))).toEqual(new Set([
      'src/A.tsx:10:3',
      'src/B.tsx:20:3',
      'src/C.tsx:30:3',
    ]))

    render(null, container)
    container.remove()
    restoreGCS()
    el1.remove()
    el2.remove()
    el3.remove()
  })

  it('AC2: single PropertyEditCommand — cmd.undo() removes all intent ids', async () => {
    const el1 = document.createElement('div')
    el1.setAttribute('data-cortex-source', 'src/A.tsx:10:3')
    const el2 = document.createElement('div')
    el2.setAttribute('data-cortex-source', 'src/B.tsx:20:3')
    document.body.append(el1, el2)

    const overrideManager = createTrackingOverrideManager()
    const restoreGCS = installGCSProxy()
    const commandStack = new CommandStack()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const ac2BufRef: { current: StagingBufferHandle | null } = { current: null }
    render(
      <PanelWithRealBuffer
        selectedElements={[el1, el2]}
        overrideManager={overrideManager as any}
        commandStack={commandStack}
        onClose={() => {}}
        onSelectElement={() => {}}
        bufferRef={ac2BufRef}
        {...panelPositionProps}
      />,
      container,
    )

    await triggerCommitScrub(container)

    // Change 4: memory-only — assert in-memory buffer directly.
    // Verify 2 intents in the buffer
    const before = ac2BufRef.current!.list()
    expect(before).toHaveLength(2)

    // One command was recorded
    expect(commandStack.undoCount).toBe(1)

    // Undo the command — should remove both intents from the buffer
    await act(async () => {
      commandStack.undo()
      await Promise.resolve()
    })

    const after = ac2BufRef.current!.list()
    expect(after).toHaveLength(0)

    render(null, container)
    container.remove()
    restoreGCS()
    el1.remove()
    el2.remove()
  })

  // ONE root cause, three symptoms. `previousValue` served as BOTH the undo
  // target (the prior override, so undo steps back one gesture) and the diff
  // base shipped to the server (which must be the true source value). A second
  // edit to the same property therefore recorded a staged intermediate the file
  // never contained, and last-write-wins destroyed the prior intent with no
  // record that it existed. No test anywhere did commit -> commit-same-property
  // -> undo, which is why this survived.
  //
  // Built on commitEditRef, NOT triggerCommitScrub: the latter re-clicks the
  // same segment on a second call and the phantom-recommit guard suppresses it.
  describe('chained edits to one property', () => {
    const SRC = 'src/Hero.tsx:14:5'

    // Belt-and-braces: a mid-test throw skips the explicit cleanup, and a
    // leaked [data-cortex-source] node is visible to the document-wide
    // shared-source queries the sibling tests in this file rely on.
    afterEach(() => {
      for (const el of document.querySelectorAll(`[data-cortex-source="${SRC}"]`)) el.remove()
    })

    async function setupChain() {
      const el = document.createElement('div')
      el.setAttribute('data-cortex-source', SRC)
      document.body.appendChild(el)

      // "The file" says display: block. readSourceValue bypasses the override
      // layer, so it must keep reporting block no matter what is staged on top.
      const overrideManager = createTrackingOverrideManager('block')
      // Pass the override store: after the first commit, computed style reports
      // the STAGED value ('flex') while readSourceValue still reports 'block'.
      // That gap is what makes the baseline assertion below falsifiable.
      const restoreGCS = installGCSProxy({ display: 'block' }, overrideManager._store)
      const commandStack = new CommandStack()
      const container = document.createElement('div')
      document.body.appendChild(container)

      const bufRef: { current: StagingBufferHandle | null } = { current: null }
      const commitEditRef: { current: ((p: string, v: string) => Promise<void>) | null } = { current: null }

      // act() so Panel's effects run — commitEditRef is assigned in a useEffect,
      // and a bare render() leaves it null.
      await act(async () => {
        render(
          <PanelWithRealBuffer
            selectedElements={[el]}
            overrideManager={overrideManager as any}
            commandStack={commandStack}
            commitEditRef={commitEditRef}
            onClose={() => {}}
            onSelectElement={() => {}}
            bufferRef={bufRef}
            {...panelPositionProps}
          />,
          container,
        )
      })

      return {
        commandStack,
        overrideManager,
        list: () => bufRef.current!.list(),
        commit: async (value: string) => {
          await act(async () => { await commitEditRef.current!('display', value) })
        },
        step: async (fn: () => void) => {
          await act(async () => { fn(); await Promise.resolve() })
        },
        cleanup: () => {
          render(null, container)
          container.remove()
          restoreGCS()
          el.remove()
        },
      }
    }

    it('a second edit records the true source baseline, not the staged intermediate', async () => {
      const c = await setupChain()
      await c.commit('flex')
      await c.commit('grid')

      const stored = c.list()
      expect(stored).toHaveLength(1)
      expect(stored[0]!.value).toBe('grid')
      // Pre-fix: 'flex'. The server resolves the Tailwind old-token from this,
      // so a staged intermediate means searching the file for a class it never
      // held -> "Token '...' not found in className", a silent apply failure.
      expect(stored[0]!.previousValue).toBe('block')

      c.cleanup()
    })

    it('undo of a chained edit restores the displaced intent so buffer matches the override', async () => {
      const c = await setupChain()
      await c.commit('flex')
      await c.commit('grid')
      await c.step(() => { c.commandStack.undo() })

      // Pre-fix: 0 — undo removed the current intent and restored nothing, so
      // the screen showed 'flex' while the Apply badge read 0 and Apply wrote
      // nothing at all.
      const after = c.list()
      expect(after).toHaveLength(1)
      expect(after[0]!.value).toBe('flex')
      expect(after[0]!.previousValue).toBe('block')
      // The override and the buffer now agree on what Apply would write.
      expect(c.overrideManager.get(SRC, 'display')).toBe('flex')

      c.cleanup()
    })

    // Guard, not a repro — passes pre-fix too (pre-fix undo #1 also left the
    // buffer empty, and cmd1's previousValue was already 'block'). Kept as a
    // terminal-state invariant; the falsifying assertions are the two above.
    it('undoing the whole chain empties the buffer and restores the source value', async () => {
      const c = await setupChain()
      await c.commit('flex')
      await c.commit('grid')
      await c.step(() => { c.commandStack.undo() })
      await c.step(() => { c.commandStack.undo() })

      expect(c.list()).toHaveLength(0)
      expect(c.overrideManager.get(SRC, 'display')).toBe('block')

      c.cleanup()
    })

    // Guards the throughput fix. readSourceValue detaches the override <style>
    // and forces two style recalcs per call; scrubPreviousRef is cleared on every
    // commit, and NumericInput's wheel/arrow affordances commit once per input
    // EVENT — so without the version-keyed cache a held arrow key re-pays the
    // full detach set per repeat, times every fan-out target.
    it('reads the source baseline at most once per key within one HMR generation', async () => {
      const c = await setupChain()
      // Seed an unrelated override so hasAnyOverrides() is true from the first
      // capture and the detached read path is genuinely taken.
      c.overrideManager.set(SRC, 'opacity', '0.5')

      await c.commit('flex')
      await c.commit('grid')
      await c.commit('block')

      const displayReads = c.overrideManager.readSourceValue.mock.calls
        .filter((args: unknown[]) => args[1] === 'display').length
      expect(displayReads).toBe(1) // without the cache: one per commit (3)

      c.cleanup()
    })

    it('undo -> redo -> undo is stable', async () => {
      const c = await setupChain()
      await c.commit('flex')
      await c.commit('grid')
      await c.step(() => { c.commandStack.undo() })
      await c.step(() => { c.commandStack.redo() })
      await c.step(() => { c.commandStack.undo() })

      // Redo re-displaces what undo restored; execute() refreshes the command's
      // displacedEdits from its own appends, so the cycle does not drift.
      const after = c.list()
      expect(after).toHaveLength(1)
      expect(after[0]!.value).toBe('flex')
      expect(after[0]!.previousValue).toBe('block')

      c.cleanup()
    })
  })

  it('AC3: multi-select + scope=all packs instanceSources per selected source', async () => {
    // Set up shared class: el1 and its sibling share the same CSS module selector.
    // el2 is an independent element with its own class.
    const sharedCss = 'Component.module.css:.badge'

    const el1 = document.createElement('div')
    el1.setAttribute('data-cortex-source', 'src/A.tsx:10:3')
    el1.setAttribute('data-cortex-css', sharedCss)

    const el1Sibling = document.createElement('div')
    el1Sibling.setAttribute('data-cortex-source', 'src/A.tsx:15:3')
    el1Sibling.setAttribute('data-cortex-css', sharedCss)

    const el2 = document.createElement('div')
    el2.setAttribute('data-cortex-source', 'src/B.tsx:20:3')
    // el2 has no shared class — scope=all on its source won't find siblings

    document.body.append(el1, el1Sibling, el2)

    const overrideManager = createTrackingOverrideManager()
    const restoreGCS = installGCSProxy()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const ac3BufRef: { current: StagingBufferHandle | null } = { current: null }
    render(
      <PanelWithRealBuffer
        selectedElements={[el1, el2]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        bufferRef={ac3BufRef}
        {...panelPositionProps}
      />,
      container,
    )

    // Wait for sharedInfo to populate (detectSharedClasses runs in a useEffect)
    let allBtn!: HTMLButtonElement
    await vi.waitFor(() => {
      allBtn = container.querySelector('.cortex-panel__scope-btn:last-child') as HTMLButtonElement
      expect(allBtn).not.toBeNull()
      expect(allBtn.textContent).toContain('All')
    }, { timeout: 500 })

    // Click "All" scope button
    await act(async () => {
      allBtn.click()
      await Promise.resolve()
    })

    // Now trigger an edit
    await triggerCommitScrub(container)

    // Change 4: memory-only — assert in-memory buffer directly.
    const stored = ac3BufRef.current!.list()
    // 2 intents: one for el1-source, one for el2-source
    expect(stored).toHaveLength(2)

    const el1Intent = stored.find(e => e.source === 'src/A.tsx:10:3')
    const el2Intent = stored.find(e => e.source === 'src/B.tsx:20:3')

    expect(el1Intent).toBeDefined()
    expect(el2Intent).toBeDefined()

    // el1 has a shared sibling — its instanceSources should include the sibling
    expect(el1Intent!.scope).toBe('all')
    expect(el1Intent!.instanceSources).toBeDefined()
    expect(el1Intent!.instanceSources!).toContain('src/A.tsx:15:3')

    // el2 has no shared class siblings — instanceSources may be undefined or empty
    expect(el2Intent!.scope).toBe('all')

    // Per-element isolation: el2's instanceSources must NOT match el1's. If a
    // regression collapses both intents onto the same instanceSources array
    // (e.g., reusing the primary element's sharedInfo for both), this assertion
    // catches it. el1 has a sibling, el2 doesn't — they cannot be equal.
    expect(el2Intent!.instanceSources).not.toEqual(el1Intent!.instanceSources)

    render(null, container)
    container.remove()
    restoreGCS()
    el1.remove()
    el1Sibling.remove()
    el2.remove()
  })

  it('scope=all packs preview sources for unannotated shared siblings', async () => {
    const sharedCss = 'Component.module.css:.badge'

    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/A.tsx:10:3')
    target.setAttribute('data-cortex-css', sharedCss)

    const unannotatedSibling = document.createElement('div')
    unannotatedSibling.setAttribute('data-cortex-css', sharedCss)

    document.body.append(target, unannotatedSibling)

    const overrideManager = createTrackingOverrideManager()
    const restoreGCS = installGCSProxy()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const scopeAllBufRef: { current: StagingBufferHandle | null } = { current: null }
    render(
      <PanelWithRealBuffer
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        bufferRef={scopeAllBufRef}
        {...panelPositionProps}
      />,
      container,
    )

    let allBtn!: HTMLButtonElement
    await vi.waitFor(() => {
      allBtn = container.querySelector('.cortex-panel__scope-btn:last-child') as HTMLButtonElement
      expect(allBtn).not.toBeNull()
      expect(allBtn.textContent).toContain('All')
    }, { timeout: 500 })

    await act(async () => {
      allBtn.click()
      await Promise.resolve()
    })

    await triggerCommitScrub(container)

    // Change 4: memory-only — assert in-memory buffer directly.
    const stored = scopeAllBufRef.current!.list()
    expect(stored).toHaveLength(1)
    expect(stored[0].source).toBe('src/A.tsx:10:3')
    expect(stored[0].instanceSources).toContain('src/A.tsx:10:3')

    const siblingPreviewId = unannotatedSibling.getAttribute(PREVIEW_SOURCE_ATTR)
    expect(siblingPreviewId).not.toBeNull()
    expect(stored[0].instanceSources).toContain(`${PREVIEW_SOURCE_PREFIX}${siblingPreviewId}`)

    render(null, container)
    container.remove()
    restoreGCS()
    target.remove()
    unannotatedSibling.remove()
  })

  it('AC4 regression: single-select unchanged — 1 intent, no instanceSources', async () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    document.body.appendChild(target)

    const overrideManager = createTrackingOverrideManager()
    const restoreGCS = installGCSProxy()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const ac4BufRef: { current: StagingBufferHandle | null } = { current: null }
    render(
      <PanelWithRealBuffer
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        bufferRef={ac4BufRef}
        {...panelPositionProps}
      />,
      container,
    )

    await triggerCommitScrub(container)

    // Change 4: memory-only — assert in-memory buffer directly.
    const stored = ac4BufRef.current!.list()
    // Single-select: exactly 1 intent for the primary element
    expect(stored).toHaveLength(1)
    expect(stored[0].source).toBe('src/Hero.tsx:14:5')
    expect(stored[0].instanceSources).toBeUndefined()
    // Default scope ('all' since COR-12). What this test guards is the ABSENCE
    // of fan-out for a single-select, not the scope label.
    expect(stored[0].scope).toBe('all')

    render(null, container)
    container.remove()
    restoreGCS()
    target.remove()
  })
})

// ── ZF0-1583: source-only banner (warning-only, no scope toggle) ─────────────

describe('Panel — source-only blast-radius banner (ZF0-1583)', () => {
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  it('renders source-only banner with no scope toggle when shared source detected (data-cortex-source matches 2+ elements)', async () => {
    // Two elements share the same data-cortex-source → detectSharedSource returns count=2
    // Neither element has data-cortex-css → detectSharedClasses returns null
    const source = 'src/Card.tsx:42:5'
    const el1 = document.createElement('div')
    el1.setAttribute('data-cortex-source', source)
    document.body.appendChild(el1)

    const el2 = document.createElement('div')
    el2.setAttribute('data-cortex-source', source)
    document.body.appendChild(el2)

    const overrideManager = createStubOverrideManager()

    const { shadow, root: shadowRoot, cleanup: removeHost } = createShadowHost()
    render(
      <Panel
        selectedElements={[el1]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      shadowRoot,
    )
    cleanup = () => {
      render(null, shadowRoot)
      removeHost()
      el1.remove()
      el2.remove()
      void shadow
    }

    // Wait for the source-only banner to appear (useEffect is async)
    await vi.waitFor(() => {
      const sourceBanner = shadowRoot.querySelector('.cortex-panel__scope--source-only')
      expect(sourceBanner).not.toBeNull()
    }, { timeout: 500 })

    const sourceBanner = shadowRoot.querySelector('.cortex-panel__scope--source-only')!
    // COR-12: the label now STATES why there is no per-instance option, rather
    // than only reporting a count. A control that cannot be honoured is not
    // rendered here; saying nothing about why left the user to infer it.
    expect(sourceBanner.textContent).toContain('Editing all 2')
    expect(sourceBanner.textContent).toContain('share one source location')
    // No scope-toggle buttons inside the source banner
    expect(sourceBanner.querySelector('.cortex-panel__scope-toggle')).toBeNull()
    expect(sourceBanner.querySelector('.cortex-panel__scope-btn')).toBeNull()
  })

  it('hovering the ALREADY-ACTIVE All option still previews the blast radius', async () => {
    // COR-12 regression, found by codex. The handler used to gate on
    // `editScope !== 'all'`, which was safe only while 'all' was reached
    // exclusively by CLICKING here — the click highlights, so hovering an active
    // All had nothing to add. Making 'all' the DEFAULT broke that premise: a user
    // who never clicked has nothing lit, and the gate made hover a no-op, leaving
    // the preview reachable only by clicking an already-selected radio.
    const sharedCss = 'Card.module.css:.card'
    const els = ['src/A.tsx:1:1', 'src/B.tsx:2:2', 'src/C.tsx:3:3'].map(src => {
      const el = document.createElement('div')
      el.setAttribute('data-cortex-source', src)
      el.setAttribute('data-cortex-css', sharedCss)
      document.body.appendChild(el)
      return el
    })

    const overrideManager = createStubOverrideManager()
    const { shadow, root: shadowRoot, cleanup: removeHost } = createShadowHost()
    render(
      <Panel
        selectedElements={[els[0]!]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      shadowRoot,
    )
    cleanup = () => {
      render(null, shadowRoot)
      removeHost()
      els.forEach(el => el.remove())
      void shadow
    }

    await vi.waitFor(() => {
      expect(shadowRoot.querySelector('.cortex-panel__scope-toggle')).not.toBeNull()
    }, { timeout: 500 })

    const allBtn = shadowRoot.querySelector<HTMLButtonElement>('.cortex-panel__scope-btn:last-child')!
    // Precondition: All is ALREADY active and NOTHING is highlighted. Without
    // this the test would pass on a stale highlight left by some other action.
    expect(allBtn.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelectorAll('[data-cortex-blast-radius]').length).toBe(0)

    await act(async () => {
      allBtn.dispatchEvent(new MouseEvent('mouseenter'))
      await new Promise(r => requestAnimationFrame(() => r(null)))  // highlight is rAF-batched
    })

    // The two NON-selected siblings light up; the selected element never does.
    expect(els[1]!.hasAttribute('data-cortex-blast-radius')).toBe(true)
    expect(els[2]!.hasAttribute('data-cortex-blast-radius')).toBe(true)
    expect(els[0]!.hasAttribute('data-cortex-blast-radius')).toBe(false)
  })

  it('shared SOURCE outranks shared CLASS — the scope toggle is replaced, not suppressed', async () => {
    // Element has BOTH shared CSS class AND shared source. This assertion is the
    // REVERSE of ZF0-1583's: codex flagged (COR-12 review) that letting the class
    // banner win offers "This element", an option that cannot be honoured here.
    //
    // Sharing a class is a SOFT grouping — distinct JSX call sites that happen to
    // carry the same className, so editing exactly one IS possible. Sharing a
    // source is a HARD constraint — one JSX location renders all N, so rewriting
    // it changes every one of them whatever the toggle says. When both hold the
    // hard constraint decides.
    const source = 'src/Badge.tsx:10:3'
    const sharedCss = 'Badge.module.css:.badge'

    const el1 = document.createElement('div')
    el1.setAttribute('data-cortex-source', source)
    el1.setAttribute('data-cortex-css', sharedCss)
    document.body.appendChild(el1)

    const el2 = document.createElement('div')
    el2.setAttribute('data-cortex-source', source)
    el2.setAttribute('data-cortex-css', sharedCss)
    document.body.appendChild(el2)

    const overrideManager = createStubOverrideManager()

    const { shadow, root: shadowRoot, cleanup: removeHost } = createShadowHost()
    render(
      <Panel
        selectedElements={[el1]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      shadowRoot,
    )
    cleanup = () => {
      render(null, shadowRoot)
      removeHost()
      el1.remove()
      el2.remove()
      void shadow
    }

    // Wait for CSS-class banner to appear
    await vi.waitFor(() => {
      expect(shadowRoot.querySelector('.cortex-panel__scope')).not.toBeNull()
    }, { timeout: 500 })

    // The scope BANNER is present (both variants share this base class)...
    expect(shadowRoot.querySelector('.cortex-panel__scope')).not.toBeNull()
    // ...and it is the SOURCE variant, carrying no per-instance option.
    expect(shadowRoot.querySelector('.cortex-panel__scope--source-only')).not.toBeNull()
    // The load-bearing half: no toggle, so "This element" is never offered.
    // Asserting only the banner class would pass if the toggle rendered beside it.
    expect(shadowRoot.querySelector('.cortex-panel__scope-toggle')).toBeNull()
    expect(shadowRoot.querySelector('.cortex-panel__scope-btn')).toBeNull()
  })

  it('renders neither banner when neither detector returns sharing', async () => {
    // Element with a unique source — detectSharedSource returns null, detectSharedClasses returns null
    const el = document.createElement('div')
    el.setAttribute('data-cortex-source', 'src/Unique.tsx:99:1')
    // No data-cortex-css attribute — detectSharedClasses returns null immediately
    document.body.appendChild(el)

    const overrideManager = createStubOverrideManager()

    const { shadow, root: shadowRoot, cleanup: removeHost } = createShadowHost()
    render(
      <Panel
        selectedElements={[el]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        buffer={makeFakeBuffer()}
        {...panelPositionProps}
      />,
      shadowRoot,
    )
    cleanup = () => {
      render(null, shadowRoot)
      removeHost()
      el.remove()
      void shadow
    }

    // Wait for the panel root to be present — proves render + effects have flushed
    await vi.waitFor(() => {
      expect(shadowRoot.querySelector('.cortex-panel')).not.toBeNull()
    }, { timeout: 500 })

    // Neither banner should appear (panel is rendered but no sharing detected)
    expect(shadowRoot.querySelector('.cortex-panel__scope')).toBeNull()
    expect(shadowRoot.querySelector('.cortex-panel__scope--source-only')).toBeNull()
  })
})

describe('PanelProps.buffer', () => {
  afterEach(() => {
    localStorage.clear()
    _resetBusForTesting()
    _resetTransformBusForTesting()
  })

  it('uses the passed buffer prop instead of a fresh local hook', () => {
    // Falsifiable runtime test for Task 1's transitional `bufferProp ?? localBuffer`
    // wiring. Panel reads buffer.size() during render to drive the Apply-button
    // count, so if it picked the prop, the prop's spy must have been invoked.
    // Reverting the impl to `const buffer = localBuffer` makes this FAIL because
    // the local hook is a different object and the prop's spies stay untouched.
    const fakeBuffer: StagingBufferHandle = {
      append: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(() => []),
      clear: vi.fn(),
      size: vi.fn(() => 0),
      version: 0,
      reconcile: vi.fn(() => ({ divergent: [] })),
    }

    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    document.body.appendChild(target)

    const overrideManager = {
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
    }

    const { cleanup } = renderInShadow(
      <Panel
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        buffer={fakeBuffer}
        {...panelPositionProps}
      />
    )

    // Panel called size() on the PASSED buffer — proves `bufferProp ?? localBuffer`
    // resolved to the prop, not a freshly-constructed local hook.
    expect(fakeBuffer.size).toHaveBeenCalled()

    cleanup()
    target.remove()
  })

  it('Panel does not create its own buffer when buffer prop provided (Task 3)', () => {
    // Proves Task 3: local fallback removed. Panel must NOT call useEditStagingBuffer
    // internally when the buffer prop is provided.
    // Reverting to the Task-1 `bufferProp ?? localBuffer` fallback makes this FAIL
    // because useEditStagingBuffer IS still called for localBuffer.
    const useBufferSpy = vi.spyOn(bufferModule, 'useEditStagingBuffer')

    const fakeBuffer = makeFakeBuffer()

    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
    document.body.appendChild(target)

    const overrideManager = {
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
      dispose: vi.fn(),
      flush: vi.fn(),
      hasAnyOverrides: vi.fn(() => false),
      readSourceValue: vi.fn(() => ''),
    }

    const { cleanup } = renderInShadow(
      <Panel
        selectedElements={[target]}
        overrideManager={overrideManager as any}
        onClose={() => {}}
        onSelectElement={() => {}}
        buffer={fakeBuffer}
        {...panelPositionProps}
      />
    )

    // useEditStagingBuffer must NOT have been called inside Panel —
    // Panel now delegates entirely to the passed prop.
    expect(useBufferSpy).not.toHaveBeenCalled()

    useBufferSpy.mockRestore()
    cleanup()
    target.remove()
  })
})
