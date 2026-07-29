import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from 'preact'
import { buildScopedTree, LayerTree } from '../../src/browser/components/LayerTree.js'
import type { TreeNode } from '../../src/browser/components/LayerTree.js'

describe('buildScopedTree', () => {
  it('returns null for null element', () => {
    expect(buildScopedTree(null)).toBeNull()
  })

  it('returns null for detached element', () => {
    const el = document.createElement('div')
    expect(buildScopedTree(el)).toBeNull()
  })

  it('builds ancestor chain from body to selected', () => {
    const container = document.createElement('div')
    const child = document.createElement('span')
    container.appendChild(child)
    document.body.appendChild(container)

    const tree = buildScopedTree(child)
    expect(tree).not.toBeNull()
    expect(tree!.element).toBe(document.body)
    const containerNode = tree!.children.find(n => n.element === container)
    expect(containerNode).toBeDefined()
    const spanNode = containerNode!.children.find(n => n.element === child)
    expect(spanNode).toBeDefined()
    expect(spanNode!.selected).toBe(true)

    document.body.removeChild(container)
  })

  it('includes siblings at each ancestor level', () => {
    const parent = document.createElement('div')
    const sibling1 = document.createElement('p')
    const sibling2 = document.createElement('p')
    const selected = document.createElement('span')
    parent.appendChild(sibling1)
    parent.appendChild(selected)
    parent.appendChild(sibling2)
    document.body.appendChild(parent)

    const tree = buildScopedTree(selected)
    const parentNode = tree!.children.find(n => n.element === parent)!
    expect(parentNode.children).toHaveLength(3)
    expect(parentNode.children.map(n => n.element)).toEqual([sibling1, selected, sibling2])

    document.body.removeChild(parent)
  })

  it('includes direct children of selected element', () => {
    const parent = document.createElement('div')
    const child1 = document.createElement('h1')
    const child2 = document.createElement('p')
    parent.appendChild(child1)
    parent.appendChild(child2)
    document.body.appendChild(parent)

    const tree = buildScopedTree(parent)
    const parentNode = tree!.children.find(n => n.element === parent)!
    expect(parentNode.selected).toBe(true)
    expect(parentNode.children).toHaveLength(2)
    expect(parentNode.children[0].element).toBe(child1)
    expect(parentNode.children[1].element).toBe(child2)

    document.body.removeChild(parent)
  })

  it('returns tree with just body + children when body is selected', () => {
    const child = document.createElement('div')
    document.body.appendChild(child)

    const tree = buildScopedTree(document.body)
    expect(tree!.element).toBe(document.body)
    expect(tree!.selected).toBe(true)
    const addedChild = tree!.children.find(n => n.element === child)
    expect(addedChild).toBeDefined()
    expect(addedChild!.selected).toBe(false)
    expect(addedChild!.depth).toBe(1)

    document.body.removeChild(child)
  })
})

describe('LayerTree rendering', () => {
  let container: HTMLDivElement
  let fixtures: HTMLElement[] = []

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    for (const el of fixtures) {
      if (el.parentNode) el.parentNode.removeChild(el)
    }
    fixtures = []
  })

  /** Helper: find the rendered node whose label text matches */
  function findNodeByLabel(label: string): HTMLElement | undefined {
    const nodes = container.querySelectorAll('.cortex-layer-node')
    return Array.from(nodes).find(n => {
      const labelEl = n.querySelector('.cortex-layer-label')
      return labelEl?.textContent === label
    }) as HTMLElement | undefined
  }

  it('renders nothing when element is null', () => {
    render(<LayerTree element={null} onSelectElement={() => {}} />, container)
    expect(container.querySelector('.cortex-layer-tree')).toBeNull()
  })

  it('renders tree nodes with correct indentation', () => {
    const parent = document.createElement('div')
    parent.className = 'card'
    const child = document.createElement('span')
    parent.appendChild(child)
    document.body.appendChild(parent)
    fixtures.push(parent)

    render(<LayerTree element={child} onSelectElement={() => {}} />, container)

    // Verify indentation by label, not index — body has other children (test container)
    const bodyNode = findNodeByLabel('body')!
    const cardNode = findNodeByLabel('div.card')!
    const spanNode = findNodeByLabel('span')!

    expect(bodyNode).toBeDefined()
    expect(cardNode).toBeDefined()
    expect(spanNode).toBeDefined()

    expect(parseInt(bodyNode.style.paddingLeft, 10)).toBe(8)   // depth 0 → 0*12+8
    expect(parseInt(cardNode.style.paddingLeft, 10)).toBe(20)  // depth 1 → 1*12+8
    expect(parseInt(spanNode.style.paddingLeft, 10)).toBe(32)  // depth 2 → 2*12+8
  })

  it('highlights the selected node', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    fixtures.push(el)

    render(<LayerTree element={el} onSelectElement={() => {}} />, container)

    const selected = container.querySelector('.cortex-layer-node--selected')
    expect(selected).not.toBeNull()
  })

  it('fires onSelectElement when clicking a node', () => {
    const parent = document.createElement('div')
    parent.className = 'wrapper'
    const child = document.createElement('span')
    parent.appendChild(child)
    document.body.appendChild(parent)
    fixtures.push(parent)

    const onSelect = vi.fn()
    render(<LayerTree element={child} onSelectElement={onSelect} />, container)

    const parentNode = findNodeByLabel('div.wrapper')
    expect(parentNode).toBeDefined()
    parentNode!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    // ZF0-1195 (T2): LayerTree now forwards the native MouseEvent as an
    // optional second arg. Assert on the element only — modifier-key behavior
    // is exercised in ElementTree.test.tsx where it actually matters.
    expect(onSelect).toHaveBeenCalledWith(parent, expect.anything())
  })

  it('shows chevron for nodes with children', () => {
    const parent = document.createElement('div')
    const child = document.createElement('span')
    parent.appendChild(child)
    document.body.appendChild(parent)
    fixtures.push(parent)

    render(<LayerTree element={child} onSelectElement={() => {}} />, container)

    // Verify at least 2 chevrons exist: body (has children) and the on-path div (has child span)
    // Both are expanded ancestors, so both should have the expanded chevron class
    const expandedChevrons = container.querySelectorAll('.cortex-layer-chevron--expanded')
    expect(expandedChevrons.length).toBeGreaterThanOrEqual(2)
  })
})

// The HTMLElement filters these replace were type plumbing, not intent: they hid
// SVG children from the tree while Panel's own `hasChildren` counted them
// unfiltered, so the child-navigation button rendered enabled with nothing under it.
describe('buildScopedTree with SVG children', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg'

  it('includes SVG children of the selected element', () => {
    const container = document.createElement('div')
    const span = document.createElement('span')
    const svg = document.createElementNS(SVG_NS, 'svg')
    container.append(span, svg)
    document.body.appendChild(container)

    const tree = buildScopedTree(container)
    const node = tree!.children.find(n => n.element === container)!
    expect(node.children.map(c => c.element)).toEqual([span, svg]) // pre-fix: [span]

    container.remove()
  })

  it('counts an SVG-only child in hasChildren', () => {
    const container = document.createElement('div')
    container.appendChild(document.createElementNS(SVG_NS, 'svg'))
    document.body.appendChild(container)

    const tree = buildScopedTree(container)
    const node = tree!.children.find(n => n.element === container)!
    expect(node.hasChildren).toBe(true) // pre-fix: false

    container.remove()
  })
})
