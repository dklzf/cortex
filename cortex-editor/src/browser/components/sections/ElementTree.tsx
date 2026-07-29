import type { JSX } from 'preact'
import { LayerTree } from '../LayerTree.js'

export interface ElementTreeProps {
  element: Element | null
  onSelectElements: (elements: Element[], action: 'replace' | 'add' | 'toggle') => void
  height: number
  hmrAppliedVersion?: number
}

export function ElementTree({ element, onSelectElements, height, hmrAppliedVersion }: ElementTreeProps): JSX.Element {
  const handleSelect = (el: Element, ev?: MouseEvent): void => {
    const action: 'replace' | 'add' | 'toggle' =
      ev?.shiftKey ? 'add' : (ev?.metaKey || ev?.ctrlKey) ? 'toggle' : 'replace'
    onSelectElements([el], action)
  }
  return (
    <div class="cortex-element-tree">
      <LayerTree
        element={element}
        onSelectElement={handleSelect}
        height={height}
        hmrAppliedVersion={hmrAppliedVersion}
      />
    </div>
  )
}
