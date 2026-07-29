import { describe, it, expect, afterEach } from 'vitest'
import { isNonEditable } from '../../src/browser/classify-non-editable.js'
import { createEditableDiv } from './helpers.js'

describe('isNonEditable', () => {
  afterEach(() => {
    // Remove all body children appended during tests to avoid DOM pollution
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild)
    }
  })

  it.each([
    ['script'],
    ['style'],
    ['meta'],
    ['head'],
    ['title'],
    ['link'],
    ['noscript'],
    ['template'],
  ])('returns true for non-visual tag: %s', (tag) => {
    const el = document.createElement(tag)
    expect(isNonEditable(el)).toBe(true)
  })

  it.each([
    ['html', document.documentElement],
    ['body', document.body],
  ])('returns true for document root tag: %s', (_tag, el) => {
    expect(isNonEditable(el)).toBe(true)
  })

  it('returns false for visual elements without data-cortex-source', () => {
    const parent = document.createElement('div')
    const child = document.createElement('div')
    parent.appendChild(child)
    document.body.appendChild(parent)
    expect(isNonEditable(child)).toBe(false)
  })

  it('returns false when element itself has data-cortex-source', () => {
    const el = createEditableDiv('/src/App.tsx:10:5')
    expect(isNonEditable(el)).toBe(false)
  })

  it('returns false when an ancestor has data-cortex-source', () => {
    const parent = createEditableDiv('/src/App.tsx:5:1')
    const child = document.createElement('span')
    parent.appendChild(child)
    expect(isNonEditable(child)).toBe(false)
  })

  it('returns false for an editable div with annotation', () => {
    const el = createEditableDiv('/src/components/Hero.tsx:20:3')
    expect(isNonEditable(el)).toBe(false)
  })

  // Reachable via the Layer Tree / child-nav, never via a click (no geometry to
  // hit-test). All-zero getBoundingClientRect, so selecting one detaches the
  // overlay to the viewport origin and every box-model control is inert.
  it.each(['defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'symbol', 'desc'])(
    'treats the non-rendered SVG container <%s> as non-editable',
    (tag) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
      expect(isNonEditable(el)).toBe(true)
    },
  )

  it('still treats rendered SVG geometry as editable', () => {
    for (const tag of ['svg', 'path', 'circle', 'rect', 'g']) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
      expect(isNonEditable(el)).toBe(false)
    }
  })
})
