import { describe, it, expect, beforeEach } from 'vitest'
import { expandSharedSource, resolveSelectionTargets } from '../../src/browser/selection-source-expand.js'

describe('expandSharedSource (ZF0-1195 Follow-up A)', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
  })

  it('expands one element to include all DOM nodes with same data-cortex-source', () => {
    const a = document.createElement('div')
    a.setAttribute('data-cortex-source', 'src/App.tsx:15:li')
    const b = document.createElement('div')
    b.setAttribute('data-cortex-source', 'src/App.tsx:15:li')
    const c = document.createElement('div')
    c.setAttribute('data-cortex-source', 'src/App.tsx:15:li')
    document.body.append(a, b, c)
    const result = expandSharedSource([a])
    expect(new Set(result)).toEqual(new Set([a, b, c]))
  })

  it('does NOT expand elements with distinct sources', () => {
    const a = document.createElement('div')
    a.setAttribute('data-cortex-source', 'src/A.tsx:10:button')
    const b = document.createElement('div')
    b.setAttribute('data-cortex-source', 'src/B.tsx:20:button')
    document.body.append(a, b)
    const result = expandSharedSource([a])
    expect(result).toEqual([a])
  })

  it('passes through elements without data-cortex-source unchanged', () => {
    const a = document.createElement('div')
    document.body.append(a)
    const result = expandSharedSource([a])
    expect(result).toEqual([a])
  })

  it('returns empty for empty input', () => {
    expect(expandSharedSource([])).toEqual([])
  })

  it('dedupes when input contains multiple shared-source elements', () => {
    const a = document.createElement('div')
    a.setAttribute('data-cortex-source', 'src/App.tsx:15:li')
    const b = document.createElement('div')
    b.setAttribute('data-cortex-source', 'src/App.tsx:15:li')
    document.body.append(a, b)
    const result = expandSharedSource([a, b])
    expect(new Set(result)).toEqual(new Set([a, b]))
    expect(result.length).toBe(2)
  })

  // TODO: requires real CSSOM — happy-dom doesn't fully implement CSS.escape
  // for quote chars in attribute selectors. Real cortex-editor sources are
  // file paths without quotes; the impl includes the fallback for safety.
  it.skip('handles sources with quote characters via CSS.escape', () => {})

  it('preserves clicked element as primary (PR #104 review C3)', () => {
    // Append 3 nodes in DOM order a → b → c, all sharing the same source.
    // querySelectorAll returns DOM-document order [a, b, c] regardless of
    // which element was clicked. The expander must put the clicked element
    // first so it remains the primary (selectedElements[0]) — otherwise
    // primary-selection behavior shifts unexpectedly.
    const a = document.createElement('div')
    a.setAttribute('data-cortex-source', 'src/App.tsx:15:li')
    const b = document.createElement('div')
    b.setAttribute('data-cortex-source', 'src/App.tsx:15:li')
    const c = document.createElement('div')
    c.setAttribute('data-cortex-source', 'src/App.tsx:15:li')
    document.body.append(a, b, c)
    // Click the middle one (b) — it should be index 0 in the result.
    const result = expandSharedSource([b])
    expect(result[0]).toBe(b)
    expect(result.length).toBe(3)
    expect(new Set(result)).toEqual(new Set([a, b, c]))
  })

  it('mixes shared-source expansion with distinct-source elements', () => {
    const a1 = document.createElement('div')
    a1.setAttribute('data-cortex-source', 'src/A.tsx:10:row')
    const a2 = document.createElement('div')
    a2.setAttribute('data-cortex-source', 'src/A.tsx:10:row')
    const b = document.createElement('div')
    b.setAttribute('data-cortex-source', 'src/B.tsx:20:button')
    document.body.append(a1, a2, b)
    const result = expandSharedSource([a1, b])
    expect(new Set(result)).toEqual(new Set([a1, a2, b]))
  })
})

describe('resolveSelectionTargets — per-instance selection for moves (B4)', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
  })

  /** A row of three buttons rendered from one .map() — they share a source. */
  function mappedRow(): { row: HTMLElement; buttons: HTMLElement[] } {
    const row = document.createElement('div')
    row.setAttribute('data-cortex-source', 'src/App.tsx:10:div')
    const buttons = ['Export', 'Sort', 'Filter'].map(label => {
      const b = document.createElement('button')
      b.setAttribute('data-cortex-source', 'src/App.tsx:12:button')
      b.textContent = label
      row.appendChild(b)
      return b
    })
    document.body.appendChild(row)
    return { row, buttons }
  }

  it('expands by default — a style edit reaches every instance, so selection must say so', () => {
    // The override layer keys on source: one rule matches all three buttons.
    // Letting the user select a subset would promise an edit cortex cannot make.
    const { buttons } = mappedRow()
    expect(resolveSelectionTargets([buttons[0]!])).toHaveLength(3)
  })

  it('expands by default when options are given but expandShared is not set', () => {
    const { buttons } = mappedRow()
    expect(resolveSelectionTargets([buttons[0]!], {})).toHaveLength(3)
  })

  it('selects exactly ONE mapped button when expansion is opted out', () => {
    // The motivating gesture: grab one button out of a grouped row. Impossible
    // while clicking one selects all N. A move acts on a single instance
    // because reordering .map() output means reordering the ARRAY — an edit
    // that a source-keyed CSS rule can never express.
    const { buttons } = mappedRow()
    const targets = resolveSelectionTargets([buttons[1]!], { expandShared: false })
    expect(targets).toEqual([buttons[1]])
  })

  it('keeps the clicked element as the primary when it does expand', () => {
    // Regression guard on the existing contract: document order would otherwise
    // put a sibling first and silently shift which element is primary.
    const { buttons } = mappedRow()
    expect(resolveSelectionTargets([buttons[2]!])[0]).toBe(buttons[2])
  })

  it('opting out is a no-op for elements that never shared a source', () => {
    const a = document.createElement('div')
    a.setAttribute('data-cortex-source', 'src/A.tsx:1:div')
    document.body.appendChild(a)
    expect(resolveSelectionTargets([a], { expandShared: false })).toEqual([a])
    expect(resolveSelectionTargets([a])).toEqual([a])
  })

  it('preserves the empty-selection clear path in both modes', () => {
    expect(resolveSelectionTargets([])).toEqual([])
    expect(resolveSelectionTargets([], { expandShared: false })).toEqual([])
  })
})
