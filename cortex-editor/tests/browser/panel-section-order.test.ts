import { describe, it, expect, vi, afterEach } from 'vitest'
import { h } from 'preact'
import { Panel, hasTypographyContent } from '../../src/browser/components/Panel.js'
import { renderInShadow, makeFakeBuffer } from './helpers.js'

// Canonical Panel v2 ordering from DESIGN.md "Section ordering rationale":
// Elements -> Position -> Layout -> Typography (conditional) -> Appearance ->
// Background -> Border -> Effects.
//
// Task 3 (ZF0-1181) wired Appearance between Layout/Typography and Background.
// For non-text elements the order is Elements/Position/Layout/Appearance/...;
// for text-bearing elements Typography sits between Layout and Appearance.
const CANONICAL_ORDER_NO_TEXT = [
  'Elements',
  'Position',
  'Layout',
  'Appearance',
  'Background',
  'Border',
  'Effects',
]

const CANONICAL_ORDER_WITH_TEXT = [
  'Elements',
  'Position',
  'Layout',
  'Typography',
  'Appearance',
  'Background',
  'Border',
  'Effects',
]

const panelPositionProps = {
  position: { x: 1000, y: 12 },
  isSnapping: false,
  panelPointerDown: vi.fn(),
  panelPointerMove: vi.fn(),
  panelPointerUp: vi.fn(),
  panelPointerCancel: vi.fn(),
  // Required by PanelProps (Panel.tsx:254). Neither mount() helper here
  // exercises HMR behavior, so 0 is the correct stable value — matches the
  // panelPositionProps fixture pattern in panel.test.tsx.
  hmrAppliedVersion: 0,
}

function makeOverrideManager() {
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

function sectionLabels(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('.cortex-section-group__title'))
    .map(t => (t.textContent ?? '').trim())
}

describe('Panel — canonical section ordering', () => {
  let cleanup: (() => void) | null = null
  const createdElements: HTMLElement[] = []

  afterEach(() => {
    // Unconditional fake timer restoration (defense-in-depth against leakage).
    vi.useRealTimers()
    cleanup?.()
    cleanup = null
    while (createdElements.length > 0) createdElements.pop()?.remove()
  })

  function makeNonTextElement(): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('data-cortex-source', 'src/NonTextHost.tsx:5:3')
    // No text child — the element holds only an element child.
    const child = document.createElement('div')
    el.appendChild(child)
    document.body.appendChild(el)
    createdElements.push(el)
    return el
  }

  function makeTextElement(): HTMLElement {
    const el = document.createElement('p')
    el.setAttribute('data-cortex-source', 'src/TextHost.tsx:7:3')
    el.appendChild(document.createTextNode('Hello world'))
    document.body.appendChild(el)
    createdElements.push(el)
    return el
  }

  function mount(element: HTMLElement) {
    const overrideManager = makeOverrideManager()
    const result = renderInShadow(
      h(Panel, {
        selectedElements: [element],
        overrideManager: overrideManager as any,
        onClose: () => {},
        onSelectElement: () => {},
        ...panelPositionProps,
        buffer: makeFakeBuffer(),
      }),
    )
    cleanup = () => result.cleanup()
    return { ...result, overrideManager }
  }

  // The canonical-order tests below double as the regression guard for
  // old-"Style"-grouping absence and any accidental duplicate SectionGroup.
  // If any extra or missing SectionGroup sneaks in, the array-equality
  // assertion fails. Do not add dedicated "absence" tests — they would be
  // subsumed by these.
  it('renders 7 section groups in canonical order for a non-text element', () => {
    const target = makeNonTextElement()
    const { root } = mount(target)
    const groups = root.querySelectorAll('.cortex-section-group')
    expect(groups.length).toBe(7)
    expect(sectionLabels(root)).toEqual(CANONICAL_ORDER_NO_TEXT)
  })

  it('renders 8 section groups (Typography included) for a text-bearing element', () => {
    const target = makeTextElement()
    const { root } = mount(target)
    const groups = root.querySelectorAll('.cortex-section-group')
    expect(groups.length).toBe(8)
    expect(sectionLabels(root)).toEqual(CANONICAL_ORDER_WITH_TEXT)
  })

  it('wraps the LayerTree inside an Elements section group at the top', () => {
    const target = makeNonTextElement()
    const { root } = mount(target)
    const elementsGroup = root.querySelector('[data-group="elements"]')
    expect(elementsGroup).not.toBeNull()
    expect(elementsGroup!.querySelector('.cortex-layer-tree')).not.toBeNull()

    // Elements must be the first group in DOM order.
    const first = root.querySelectorAll('.cortex-section-group')[0]
    expect(first).toBe(elementsGroup)
  })

  it('exposes canonical data-group attributes for all sections', () => {
    const target = makeTextElement()
    const { root } = mount(target)
    expect(root.querySelector('[data-group="elements"]')).not.toBeNull()
    expect(root.querySelector('[data-group="position"]')).not.toBeNull()
    expect(root.querySelector('[data-group="layout"]')).not.toBeNull()
    expect(root.querySelector('[data-group="typography"]')).not.toBeNull()
    expect(root.querySelector('[data-group="appearance"]')).not.toBeNull()
    expect(root.querySelector('[data-group="background"]')).not.toBeNull()
    expect(root.querySelector('[data-group="border"]')).not.toBeNull()
    expect(root.querySelector('[data-group="effects"]')).not.toBeNull()
  })

  it('wires the Appearance group for non-text elements too (opacity/radius/visibility apply to every element)', () => {
    const target = makeNonTextElement()
    const { root } = mount(target)
    const appearanceGroup = root.querySelector('[data-group="appearance"]')
    expect(appearanceGroup).not.toBeNull()
    // The inner AppearanceSection is identified by data-section-id="appearance".
    expect(
      appearanceGroup!.querySelector('[data-section-id="appearance"]'),
    ).not.toBeNull()
  })

  it('hides the Position group when the element is part of a shared class selection (scope=all)', async () => {
    // Create two elements annotated with the same CSS-module selector.
    // `detectSharedClasses` keys off `data-cortex-css`, not className — it
    // parses the `file.module.css:selector` format to count shared elements.
    const cssMapping = 'src/Card.module.css:.badge'
    const a = document.createElement('div')
    a.setAttribute('data-cortex-source', 'src/A.tsx:1:1')
    a.setAttribute('data-cortex-css', cssMapping)
    document.body.appendChild(a)
    createdElements.push(a)

    const b = document.createElement('div')
    b.setAttribute('data-cortex-source', 'src/B.tsx:1:1')
    b.setAttribute('data-cortex-css', cssMapping)
    document.body.appendChild(b)
    createdElements.push(b)

    const { root } = mount(a)

    // detectSharedClasses runs in a useEffect, so the scope toggle only
    // appears after Preact flushes effects. Both position group and the
    // scope button must be present before proceeding.
    await vi.waitFor(() => {
      // Scope defaults to 'instance', so Position should be visible initially.
      expect(root.querySelector('[data-group="position"]')).not.toBeNull()
      // Scope button must also be present (requires second effect flush after setSharedInfo).
      expect(root.querySelector('.cortex-panel__scope-btn:last-child')).not.toBeNull()
    }, { timeout: 500 })

    // Click the "All" scope button (scope toggle is rendered when sharedInfo detected).
    const allButton = root.querySelector<HTMLButtonElement>(
      '.cortex-panel__scope-btn:last-child',
    )
    expect(allButton).not.toBeNull()
    allButton!.click()
    await vi.waitFor(() => {
      // Position group should now be hidden.
      expect(root.querySelector('[data-group="position"]')).toBeNull()
    }, { timeout: 500 })

    // And the remaining groups should be 6 (Elements, Layout, Appearance,
    // Background, Border, Effects) — Typography omitted for a non-text
    // element, Position hidden by scope=all. Appearance is instance-agnostic
    // (visual properties apply to every element in the shared class) so it
    // stays visible.
    const labels = sectionLabels(root)
    expect(labels).toEqual([
      'Elements',
      'Layout',
      'Appearance',
      'Background',
      'Border',
      'Effects',
    ])
  })
})

// ---------------------------------------------------------------------------
// `hasTypographyContent` — direct unit tests.
//
// These cover all the edge cases of the helper at the function level so the
// Panel-mount tests below only need to verify Panel WIRES the helper correctly
// (not that the helper itself is correct). Proper test layering.
// ---------------------------------------------------------------------------
describe('hasTypographyContent', () => {
  type Setup = (el: HTMLElement) => void
  const cases: [string, Setup, boolean][] = [
    ['empty element', () => {}, false],
    [
      'only whitespace text',
      (el) => el.appendChild(document.createTextNode('   \n\t')),
      false,
    ],
    [
      'non-empty text',
      (el) => el.appendChild(document.createTextNode('hello')),
      true,
    ],
    [
      'mixed text + element children',
      (el) => {
        el.appendChild(document.createTextNode('hi '))
        el.appendChild(document.createElement('span'))
      },
      true,
    ],
    [
      'element children only',
      (el) => {
        el.appendChild(document.createElement('span'))
        el.appendChild(document.createElement('br'))
      },
      false,
    ],
    [
      'nested text inside child',
      (el) => {
        const child = document.createElement('span')
        child.appendChild(document.createTextNode('nested'))
        el.appendChild(child)
      },
      true,
    ],
    [
      'only comment children',
      (el) => el.appendChild(document.createComment('a comment')),
      false,
    ],
    [
      'text surrounded by elements',
      (el) => {
        el.appendChild(document.createElement('br'))
        el.appendChild(document.createTextNode('middle'))
        el.appendChild(document.createElement('hr'))
      },
      true,
    ],
  ]

  it.each(cases)('%s -> %s', (_desc, setup, expected) => {
    const el = document.createElement('div')
    setup(el)
    expect(hasTypographyContent(el)).toBe(expected)
  })

  it.each(['input', 'textarea', 'select'] as const)(
    '<%s> is always typography-sensitive',
    (tag) => {
      const el = document.createElement(tag)
      expect(hasTypographyContent(el)).toBe(true)
    },
  )
})

// ---------------------------------------------------------------------------
// Panel Typography conditional rendering.
//
// Edge-case coverage for `hasTypographyContent` lives in the dedicated unit
// tests above. These tests only verify that Panel RESPECTS the helper's
// result at the render level — one representative case per branch is enough.
// Don't duplicate edge-case coverage across both layers (no subsumption).
// ---------------------------------------------------------------------------
describe('Panel — Typography conditional rendering', () => {
  let cleanup: (() => void) | null = null
  const createdElements: HTMLElement[] = []

  afterEach(() => {
    vi.useRealTimers()
    cleanup?.()
    cleanup = null
    while (createdElements.length > 0) createdElements.pop()?.remove()
  })

  function mount(element: HTMLElement) {
    const overrideManager = makeOverrideManager()
    const result = renderInShadow(
      h(Panel, {
        selectedElements: [element],
        overrideManager: overrideManager as any,
        onClose: () => {},
        onSelectElement: () => {},
        ...panelPositionProps,
        buffer: makeFakeBuffer(),
      }),
    )
    cleanup = () => result.cleanup()
    return result
  }

  type Setup = (el: HTMLElement) => void
  const typographyCases: [string, Setup, 'present' | 'absent'][] = [
    ['no children -> Typography absent', () => {}, 'absent'],
    [
      'text content -> Typography present',
      (el) => el.appendChild(document.createTextNode('hi')),
      'present',
    ],
    [
      'element child only -> Typography absent',
      (el) => el.appendChild(document.createElement('span')),
      'absent',
    ],
  ]

  it.each(typographyCases)('%s', (_desc, setup, expectation) => {
    const el = document.createElement('div')
    el.setAttribute('data-cortex-source', 'src/Case.tsx:1:1')
    setup(el)
    document.body.appendChild(el)
    createdElements.push(el)
    const { root } = mount(el)
    const typographyGroup = root.querySelector('[data-group="typography"]')
    if (expectation === 'present') {
      expect(typographyGroup).not.toBeNull()
    } else {
      expect(typographyGroup).toBeNull()
    }
  })
})
