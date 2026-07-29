import { describe, it, expect, vi, afterEach } from 'vitest'
import { computePanelStyleSnapshot } from '../../../src/browser/components/panel-style-snapshot.js'
import { mockGetComputedStyle } from '../helpers.js'

describe('computePanelStyleSnapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns empty parsed shells when element is null', () => {
    const result = computePanelStyleSnapshot({
      element: null,
      activePseudo: 'element',
      activeState: 'default',
      sharedInfo: null,
      editScope: 'instance',
      overrideManager: { get: vi.fn().mockReturnValue(undefined) },
      defaultStyles: null,
    })
    // Early-return branch: numeric zero-value fields come from the parse shells.
    // These assertions ARE falsifiable: if the early return were removed, the
    // function would crash on getComputedStyle(null) before returning.
    expect(result.computedStyles.spacing.padding.top).toBe(0)
    expect(result.computedStyles.spacing.padding.right).toBe(0)
    // dimmedProperties and mixedProperties must be undefined from the early-return path
    expect(result.dimmedProperties).toBeUndefined()
    expect(result.mixedProperties).toBeUndefined()
  })

  it('returns text-align from getComputedStyle', () => {
    const target = document.createElement('p')
    target.setAttribute('data-cortex-source', 'src/hero.tsx:10:5')
    document.body.appendChild(target)

    const styles: Record<string, string> = { textAlign: 'left' }
    const restoreStyles = mockGetComputedStyle(target, styles)

    try {
      const result = computePanelStyleSnapshot({
        element: target,
        activePseudo: 'element',
        activeState: 'default',
        sharedInfo: null,
        editScope: 'instance',
        overrideManager: { get: vi.fn().mockReturnValue(undefined) },
        defaultStyles: null,
      })
      // THIS IS THE FAILING ASSERTION from the original flaky integration test,
      // restated as a synchronous unit test.
      expect(result.computedStyles.typography.textAlign).toBe('left')
    } finally {
      restoreStyles()
      target.remove()
    }
  })

  it('reflects style change on second call', () => {
    const target = document.createElement('p')
    target.setAttribute('data-cortex-source', 'src/hero.tsx:10:5')
    document.body.appendChild(target)

    const styles: Record<string, string> = { textAlign: 'left' }
    const restoreStyles = mockGetComputedStyle(target, styles)

    const overrideManager = { get: vi.fn().mockReturnValue(undefined) }
    const input = {
      element: target,
      activePseudo: 'element' as const,
      activeState: 'default' as const,
      sharedInfo: null,
      editScope: 'instance' as const,
      overrideManager,
      defaultStyles: null,
    }

    try {
      const first = computePanelStyleSnapshot(input)
      expect(first.computedStyles.typography.textAlign).toBe('left')

      // Mutate styles ref — mockGetComputedStyle spreads on every call
      styles.textAlign = 'center'

      const second = computePanelStyleSnapshot(input)
      expect(second.computedStyles.typography.textAlign).toBe('center')
    } finally {
      restoreStyles()
      target.remove()
    }
  })

  it('override-manager value takes precedence over getComputedStyle for width/height', () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/comp.tsx:5:3')
    document.body.appendChild(target)

    // getComputedStyle returns a resolved pixel width
    const styles: Record<string, string> = { width: '200px', height: '100px' }
    const restoreStyles = mockGetComputedStyle(target, styles)

    // overrideManager.get returns keyword for width
    const overrideManager = { get: vi.fn() }
    overrideManager.get.mockImplementation((_source: string, prop: string, _pseudo?: string) => {
      if (prop === 'width') return '100%'
      if (prop === 'height') return 'fit-content'
      return undefined
    })

    try {
      const result = computePanelStyleSnapshot({
        element: target,
        activePseudo: 'element',
        activeState: 'default',
        sharedInfo: null,
        editScope: 'instance',
        overrideManager,
        defaultStyles: null,
      })
      expect(result.computedStyles.layout.width).toBe('100%')
      expect(result.computedStyles.layout.height).toBe('fit-content')
    } finally {
      restoreStyles()
      target.remove()
    }
  })

  it('override-manager value takes precedence for border-top-width when present', () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/comp.tsx:5:3')
    document.body.appendChild(target)

    const styles: Record<string, string> = { borderTopWidth: '1px' }
    const restoreStyles = mockGetComputedStyle(target, styles)

    const overrideManager = { get: vi.fn() }
    overrideManager.get.mockImplementation((_source: string, prop: string, _pseudo?: string) => {
      if (prop === 'border-top-width') return '4px'
      return undefined
    })

    try {
      const result = computePanelStyleSnapshot({
        element: target,
        activePseudo: 'element',
        activeState: 'default',
        sharedInfo: null,
        editScope: 'instance',
        overrideManager,
        defaultStyles: null,
      })
      expect(result.computedStyles.border.borderTopWidth).toBe(4)
    } finally {
      restoreStyles()
      target.remove()
    }
  })

  it('dimmedProperties is undefined when activeState is "default"', () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/comp.tsx:5:3')
    document.body.appendChild(target)

    const restoreStyles = mockGetComputedStyle(target, { color: 'rgb(0,0,0)' })

    try {
      const result = computePanelStyleSnapshot({
        element: target,
        activePseudo: 'element',
        activeState: 'default',
        sharedInfo: null,
        editScope: 'instance',
        overrideManager: { get: vi.fn().mockReturnValue(undefined) },
        defaultStyles: { color: 'rgb(255,0,0)' },
      })
      expect(result.dimmedProperties).toBeUndefined()
    } finally {
      restoreStyles()
      target.remove()
    }
  })

  it('dimmedProperties contains property when activeState is non-default AND defaultStyles differ', () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/comp.tsx:5:3')
    document.body.appendChild(target)

    // Proxy-based mock so getPropertyValue works (needed by dimming logic)
    const originalGCS = window.getComputedStyle
    const currentStyles: Record<string, string> = { color: 'rgb(255,0,0)' }
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
      makeProxy(currentStyles)) as typeof window.getComputedStyle

    try {
      const result = computePanelStyleSnapshot({
        element: target,
        activePseudo: 'element',
        activeState: 'hover',
        sharedInfo: null,
        editScope: 'instance',
        overrideManager: { get: vi.fn().mockReturnValue(undefined) },
        // Default state has different color
        defaultStyles: { color: 'rgb(0,0,0)' },
      })
      expect(result.dimmedProperties).toBeDefined()
      expect(result.dimmedProperties?.has('color')).toBe(true)
    } finally {
      window.getComputedStyle = originalGCS
      target.remove()
    }
  })

  it('mixedProperties is undefined when sharedInfo is null', () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/comp.tsx:5:3')
    document.body.appendChild(target)

    const restoreStyles = mockGetComputedStyle(target, { color: 'rgb(0,0,0)' })

    try {
      const result = computePanelStyleSnapshot({
        element: target,
        activePseudo: 'element',
        activeState: 'default',
        sharedInfo: null,
        editScope: 'all',
        overrideManager: { get: vi.fn().mockReturnValue(undefined) },
        defaultStyles: null,
      })
      expect(result.mixedProperties).toBeUndefined()
    } finally {
      restoreStyles()
      target.remove()
    }
  })

  it('mixedProperties contains property when sharedInfo siblings differ for that property in "all" editScope', () => {
    const target = document.createElement('div')
    target.setAttribute('data-cortex-source', 'src/comp.tsx:5:3')
    document.body.appendChild(target)

    const sibling = document.createElement('div')
    sibling.setAttribute('data-cortex-source', 'src/comp.tsx:10:3')
    document.body.appendChild(sibling)

    // Proxy-based mock so getPropertyValue works for both elements
    const originalGCS = window.getComputedStyle
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

    const targetStyles: Record<string, string> = { color: 'rgb(0,0,0)', display: 'block' }
    const siblingStyles: Record<string, string> = { color: 'rgb(255,0,0)', display: 'block' }

    window.getComputedStyle = ((el: Element, _pseudo?: string | null) => {
      if (el === target) return makeProxy(targetStyles)
      if (el === sibling) return makeProxy(siblingStyles)
      return makeProxy({})
    }) as typeof window.getComputedStyle

    const sharedInfo = {
      selector: '.badge',
      cssFilePath: 'Component.module.css',
      elements: [target, sibling],
      count: 2,
    }

    try {
      const result = computePanelStyleSnapshot({
        element: target,
        activePseudo: 'element',
        activeState: 'default',
        sharedInfo,
        editScope: 'all',
        overrideManager: { get: vi.fn().mockReturnValue(undefined) },
        defaultStyles: null,
      })
      expect(result.mixedProperties).toBeDefined()
      expect(result.mixedProperties?.has('color')).toBe(true)
      // display is same across siblings, should not be mixed
      expect(result.mixedProperties?.has('display')).toBe(false)
    } finally {
      window.getComputedStyle = originalGCS
      target.remove()
      sibling.remove()
    }
  })

  // Regression: codex review (P2) on Position QOL PR flagged that pseudo-
  // element self-alignment gating used element.parentElement, but pseudos
  // are laid out as children of their ORIGINATING element — so a ::before
  // on a flex container should see parentDisplay='flex', not whatever the
  // flex container's DOM parent's display happens to be.
  it('uses the originating element\'s display as parentDisplay when activePseudo is set', () => {
    const parent = document.createElement('div')
    const child = document.createElement('span')
    parent.appendChild(child)
    document.body.appendChild(parent)

    const originalGCS = window.getComputedStyle
    window.getComputedStyle = ((target: Element, pseudo?: string | null) => {
      // Parent of the originating element is a plain block.
      if (target === parent) {
        return { ...originalGCS.call(window, target, pseudo ?? null), display: 'block' } as CSSStyleDeclaration
      }
      // Originating element is the flex container — its ::before pseudo
      // is therefore a flex item, so self-alignment SHOULD apply.
      if (target === child) {
        return { ...originalGCS.call(window, target, pseudo ?? null), display: 'flex' } as CSSStyleDeclaration
      }
      return originalGCS.call(window, target, pseudo ?? null)
    }) as typeof window.getComputedStyle

    try {
      const result = computePanelStyleSnapshot({
        element: child,
        activePseudo: '::before',
        activeState: 'default',
        sharedInfo: null,
        editScope: 'instance',
        overrideManager: { get: vi.fn().mockReturnValue(undefined) },
        defaultStyles: null,
      })
      // Without the pseudo-aware fix this would be 'block' (the parent's
      // display), making PositionSection hide the self-alignment block on
      // a pseudo that actually IS a flex item.
      expect(result.computedStyles.position.parentDisplay).toBe('flex')
    } finally {
      window.getComputedStyle = originalGCS
      parent.remove()
    }
  })

  it('uses parentElement\'s display as parentDisplay for non-pseudo selections', () => {
    const parent = document.createElement('div')
    const child = document.createElement('span')
    parent.appendChild(child)
    document.body.appendChild(parent)

    const originalGCS = window.getComputedStyle
    window.getComputedStyle = ((target: Element, pseudo?: string | null) => {
      if (target === parent) {
        return { ...originalGCS.call(window, target, pseudo ?? null), display: 'grid' } as CSSStyleDeclaration
      }
      if (target === child) {
        return { ...originalGCS.call(window, target, pseudo ?? null), display: 'block' } as CSSStyleDeclaration
      }
      return originalGCS.call(window, target, pseudo ?? null)
    }) as typeof window.getComputedStyle

    try {
      const result = computePanelStyleSnapshot({
        element: child,
        activePseudo: 'element',
        activeState: 'default',
        sharedInfo: null,
        editScope: 'instance',
        overrideManager: { get: vi.fn().mockReturnValue(undefined) },
        defaultStyles: null,
      })
      expect(result.computedStyles.position.parentDisplay).toBe('grid')
    } finally {
      window.getComputedStyle = originalGCS
      parent.remove()
    }
  })

  // Regression: codex review (P2) on PR #162 — pseudo-element snapshots
  // should NOT carry the host element's tag because the pseudo-element
  // isn't subject to widget-display coercion. ::before on a <button> is
  // a generated box, not the button itself; display:inline works fine.
  it('layout.tagName is empty for pseudo-element snapshots (widget host bypass)', () => {
    const target = document.createElement('button')
    document.body.appendChild(target)
    try {
      const result = computePanelStyleSnapshot({
        element: target,
        activePseudo: '::before',
        activeState: 'default',
        sharedInfo: null,
        editScope: 'instance',
        overrideManager: { get: vi.fn().mockReturnValue(undefined) },
        defaultStyles: null,
      })
      expect(result.computedStyles.layout.tagName).toBe('')
    } finally {
      target.remove()
    }
  })

  it('layout.tagName is the element tag for non-pseudo snapshots', () => {
    const target = document.createElement('button')
    document.body.appendChild(target)
    try {
      const result = computePanelStyleSnapshot({
        element: target,
        activePseudo: 'element',
        activeState: 'default',
        sharedInfo: null,
        editScope: 'instance',
        overrideManager: { get: vi.fn().mockReturnValue(undefined) },
        defaultStyles: null,
      })
      expect(result.computedStyles.layout.tagName).toBe('button')
    } finally {
      target.remove()
    }
  })

})

describe('SVG geometry dimming', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const base = {
    activePseudo: 'element' as const,
    activeState: 'default' as const,
    sharedInfo: null,
    editScope: 'instance' as const,
    overrideManager: { get: () => undefined },
    defaultStyles: null,
  }

  it('dims box-model controls on SVG geometry', () => {
    const path = document.createElementNS(SVG_NS, 'path')
    document.body.appendChild(path)

    const { dimmedProperties } = computePanelStyleSnapshot({ ...base, element: path })

    // Pre-fix: undefined — the user could scrub padding on a <path>, see nothing
    // move, and Apply would still write it into their JSX.
    expect(dimmedProperties?.has('padding-top')).toBe(true)
    expect(dimmedProperties?.has('border-radius')).toBe(true)
    expect(dimmedProperties?.has('background-color')).toBe(true)

    path.remove()
  })

  it('does NOT dim them on the outer <svg>, which is a real CSS box', () => {
    const svg = document.createElementNS(SVG_NS, 'svg')
    document.body.appendChild(svg)

    const { dimmedProperties } = computePanelStyleSnapshot({ ...base, element: svg })
    expect(dimmedProperties?.has('padding-top') ?? false).toBe(false)

    svg.remove()
  })
})
