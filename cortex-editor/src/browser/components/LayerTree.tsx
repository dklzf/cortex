import type { JSX } from 'preact'
import { useMemo, useState } from 'preact/hooks'
import { getTreeLabel } from '../label.js'
import { ChevronRight } from './icons.js'

export interface TreeNode {
  element: Element
  label: string
  depth: number
  selected: boolean
  expanded: boolean
  hasChildren: boolean
  children: TreeNode[]
}

/** Build a scoped tree: ancestor chain from <body> to selected, siblings at each level,
 *  and direct children of selected. Returns null if element is null or detached.
 *
 *  Complexity: O(depth * max_siblings) — only visits nodes on the ancestor path
 *  and their siblings, never the full DOM tree. */
export function buildScopedTree(element: Element | null): TreeNode | null {
  if (!element) return null
  if (!element.isConnected || !document.body.contains(element)) return null

  // Walk from element up to body, collecting the ancestor chain (excluding body).
  // ancestors[0] is a direct child of body, ancestors[last] is the selected element.
  const ancestors: Element[] = []
  let current: Element | null = element
  while (current && current !== document.body) {
    ancestors.unshift(current)
    current = current.parentElement
  }

  function leafNode(c: Element, depth: number): TreeNode {
    // No HTMLElement filter: it was type plumbing, not intent. It hid SVG
    // children from the tree entirely while `hasChildren` elsewhere counted
    // them — an expanded row with nothing under it.
    const childCount = c.children.length
    return { element: c, label: getTreeLabel(c), depth, selected: false, expanded: false, hasChildren: childCount > 0, children: [] }
  }

  function buildNode(el: Element, depth: number, isOnPath: boolean): TreeNode {
    const isSelected = el === element
    // The ancestor at this depth in the chain (depth 0 = direct child of body)
    const pathChild: Element | undefined = ancestors[depth]

    let children: TreeNode[] = []
    if (isSelected) {
      // Selected element: show direct children as leaf nodes
      children = Array.from(el.children).map(c => leafNode(c, depth + 1))
    } else if (isOnPath && pathChild) {
      // Ancestor on the path: show all element children at this level,
      // recurse into the one that's on the ancestor path
      children = Array.from(el.children)
        .map(c => c === pathChild ? buildNode(c, depth + 1, true) : leafNode(c, depth + 1))
    }

    const childCount = el.children.length
    return {
      element: el,
      label: getTreeLabel(el),
      depth,
      selected: isSelected,
      expanded: isSelected || isOnPath,
      hasChildren: childCount > 0,
      children,
    }
  }

  return buildNode(document.body, 0, true)
}

interface LayerTreeProps {
  element: Element | null
  onSelectElement: (el: Element, ev?: MouseEvent) => void
  height: number
  /** Counter that bumps on every HMR cycle. Forces `buildScopedTree` to
   *  rebuild when the selected element's DOM node is preserved but its
   *  sibling layout changed (e.g., array reorder in a .map() loop).
   *  Without this dep, the memo keeps the stale sibling order. */
  hmrAppliedVersion?: number
}

function TreeNodeRow({ node, onSelectElement }: { node: TreeNode; onSelectElement: (el: Element, ev?: MouseEvent) => void }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const hasChildren = node.hasChildren
  const showChildren = node.children.length > 0 && node.expanded && !collapsed

  return (
    <>
      <div
        class={`cortex-layer-node${node.selected ? ' cortex-layer-node--selected' : ''}`}
        style={{ paddingLeft: `${node.depth * 12 + 8}px` }}
        onClick={(e) => {
          e.stopPropagation()
          onSelectElement(node.element, e as MouseEvent)
        }}
      >
        {hasChildren ? (
          <span
            class={`cortex-layer-chevron${showChildren ? ' cortex-layer-chevron--expanded' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              // Expanded nodes (on ancestor path): toggle collapse/expand
              // Non-expanded leaf nodes: navigate to element (rebuilds tree with its children)
              if (node.expanded) setCollapsed(c => !c)
              else onSelectElement(node.element)
            }}
          >
            <ChevronRight size={8} />
          </span>
        ) : (
          <span class="cortex-layer-chevron-spacer" />
        )}
        <span class="cortex-layer-label">{node.label}</span>
      </div>
      {showChildren && node.children.map((child, i) => (
        <TreeNodeRow key={`${child.depth}-${i}`} node={child} onSelectElement={onSelectElement} />
      ))}
    </>
  )
}

export const DEFAULT_LAYER_HEIGHT = 160
export const MIN_LAYER_HEIGHT = 60

export function LayerTree({ element, onSelectElement, height, hmrAppliedVersion = 0 }: LayerTreeProps): JSX.Element | null {
  const tree = useMemo(() => buildScopedTree(element), [element, hmrAppliedVersion])

  if (!tree) return null

  return (
    <div class="cortex-layer-tree" style={{ height: `${height}px` }}>
      <div class="cortex-layer-tree__scroll">
        <TreeNodeRow key={element} node={tree} onSelectElement={onSelectElement} />
      </div>
    </div>
  )
}
