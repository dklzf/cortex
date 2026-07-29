import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initSelection } from '../../src/browser/selection.js'
import { createShadowHost, mockElementFromPoint, dispatchMouseEvent, createEditableDiv } from './helpers.js'

describe('initSelection', () => {
  let host: HTMLDivElement
  let shadow: ShadowRoot
  let cleanupHost: () => void
  let onHover: ReturnType<typeof vi.fn>
  // onSelect receives (elements: HTMLElement[], action: 'replace' | 'add' | 'toggle')
  let onSelect: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const shadowHost = createShadowHost()
    host = shadowHost.host
    shadow = shadowHost.shadow
    cleanupHost = shadowHost.cleanup

    onHover = vi.fn()
    onSelect = vi.fn()
  })

  afterEach(() => {
    cleanupHost()
  })

  // Canary: verify capture-phase listener on window receives events dispatched on child elements
  it('canary: capture-phase listener fires for child element events', () => {
    const captured = vi.fn()
    window.addEventListener('click', captured, { capture: true })
    const child = document.createElement('div')
    document.body.appendChild(child)
    child.click()
    expect(captured).toHaveBeenCalled()
    window.removeEventListener('click', captured, { capture: true })
    child.remove()
  })

  it('returns cleanup and setDesignMode', () => {
    const handle = initSelection(shadow, onHover, onSelect)
    expect(handle).toHaveProperty('cleanup')
    expect(handle).toHaveProperty('setDesignMode')
    expect(typeof handle.cleanup).toBe('function')
    expect(typeof handle.setDesignMode).toBe('function')
    handle.cleanup()
  })

  it('capture-phase mousemove calls onHover with the element', () => {
    const target = createEditableDiv()
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    dispatchMouseEvent(target, 'mousemove', { clientX: 50, clientY: 50 })
    expect(onHover).toHaveBeenCalledWith(target)

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('capture-phase click calls onSelect and prevents default', () => {
    const target = createEditableDiv()
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    const event = dispatchMouseEvent(target, 'click', { clientX: 50, clientY: 50 })
    expect(onSelect).toHaveBeenCalledWith([target], 'replace')
    expect(event.defaultPrevented).toBe(true)

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('capture-phase click selects visual elements without data-cortex-source', () => {
    const target = document.createElement('div')
    target.textContent = 'Unannotated visual card'
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    const cases = [
      [{}, 'replace'],
      [{ shiftKey: true }, 'add'],
      [{ metaKey: true }, 'toggle'],
      [{ ctrlKey: true }, 'toggle'],
    ] as const
    for (const [modifiers, action] of cases) {
      onSelect.mockClear()
      const event = dispatchMouseEvent(target, 'click', { clientX: 50, clientY: 50, ...modifiers })
      expect(onSelect).toHaveBeenCalledWith([target], action)
      expect(event.defaultPrevented).toBe(true)
    }

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('events from Cortex shadow DOM are passed through', () => {
    const handle = initSelection(shadow, onHover, onSelect)

    // Create an element inside the shadow DOM (simulating panel UI)
    const panelButton = document.createElement('button')
    shadow.appendChild(panelButton)

    // Mock elementFromPoint to return the cortex host
    const restoreEfp = mockElementFromPoint(host)

    // Dispatch from inside shadow — composedPath will include host with data-cortex-host
    dispatchMouseEvent(panelButton, 'click', { clientX: 50, clientY: 50 })

    // Should not intercept — onSelect should not be called
    expect(onSelect).not.toHaveBeenCalled()

    handle.cleanup()
    restoreEfp()
  })

  it('setDesignMode(false) disables interception', () => {
    const target = createEditableDiv()
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    handle.setDesignMode(false)
    dispatchMouseEvent(target, 'mousemove', { clientX: 50, clientY: 50 })
    dispatchMouseEvent(target, 'click', { clientX: 50, clientY: 50 })
    expect(onHover).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('setDesignMode(true) re-enables interception', () => {
    const target = createEditableDiv()
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    handle.setDesignMode(false)
    handle.setDesignMode(true)
    dispatchMouseEvent(target, 'mousemove', { clientX: 50, clientY: 50 })
    expect(onHover).toHaveBeenCalledWith(target)

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('cleanup removes all listeners', () => {
    const target = createEditableDiv()
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    handle.cleanup()

    dispatchMouseEvent(target, 'mousemove', { clientX: 50, clientY: 50 })
    dispatchMouseEvent(target, 'click', { clientX: 50, clientY: 50 })

    expect(onHover).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()

    restoreEfp()
    target.remove()
  })

  it('onHover is called with null when elementFromPoint returns null', () => {
    const restoreEfp = mockElementFromPoint(null)
    const handle = initSelection(shadow, onHover, onSelect)

    const target = document.createElement('div')
    document.body.appendChild(target)
    dispatchMouseEvent(target, 'mousemove', { clientX: 50, clientY: 50 })
    expect(onHover).toHaveBeenCalledWith(null)

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('excludes elements with data-cortex-host attribute from targeting', () => {
    const restoreEfp = mockElementFromPoint(host)
    const handle = initSelection(shadow, onHover, onSelect)

    dispatchMouseEvent(document.body, 'mousemove', { clientX: 50, clientY: 50 })
    expect(onHover).toHaveBeenCalledWith(null)

    handle.cleanup()
    restoreEfp()
  })

  it('setInterceptClicks(false) allows clicks through without interception', () => {
    const target = createEditableDiv()
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    handle.setInterceptClicks(false)
    const event = dispatchMouseEvent(target, 'click', { clientX: 50, clientY: 50 })
    expect(onSelect).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('hover still works when setInterceptClicks(false)', () => {
    const target = createEditableDiv()
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    handle.setInterceptClicks(false)
    dispatchMouseEvent(target, 'mousemove', { clientX: 50, clientY: 50 })
    expect(onHover).toHaveBeenCalledWith(target)

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('setInterceptClicks(true) re-enables click interception', () => {
    const target = createEditableDiv()
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    handle.setInterceptClicks(false)
    handle.setInterceptClicks(true)
    const event = dispatchMouseEvent(target, 'click', { clientX: 50, clientY: 50 })
    expect(onSelect).toHaveBeenCalledWith([target], 'replace')
    expect(event.defaultPrevented).toBe(true)

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('click on <script> tag reaches onSelect([], replace) through getTargetElement', () => {
    const scriptEl = document.createElement('script')
    document.body.appendChild(scriptEl)
    const restoreEfp = mockElementFromPoint(scriptEl)
    const handle = initSelection(shadow, onHover, onSelect)

    dispatchMouseEvent(document.body, 'click', { clientX: 50, clientY: 50 })
    expect(onSelect).toHaveBeenCalledWith([], 'replace')

    handle.cleanup()
    restoreEfp()
    scriptEl.remove()
  })

  it('shift+click calls onSelect with action="add"', () => {
    const target = createEditableDiv()
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    dispatchMouseEvent(target, 'click', { clientX: 50, clientY: 50, shiftKey: true })
    expect(onSelect).toHaveBeenCalledWith([target], 'add')

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('meta+click calls onSelect with action="toggle"', () => {
    const target = createEditableDiv()
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    dispatchMouseEvent(target, 'click', { clientX: 50, clientY: 50, metaKey: true })
    expect(onSelect).toHaveBeenCalledWith([target], 'toggle')

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('ctrl+click calls onSelect with action="toggle"', () => {
    const target = createEditableDiv()
    document.body.appendChild(target)
    const restoreEfp = mockElementFromPoint(target)
    const handle = initSelection(shadow, onHover, onSelect)

    dispatchMouseEvent(target, 'click', { clientX: 50, clientY: 50, ctrlKey: true })
    expect(onSelect).toHaveBeenCalledWith([target], 'toggle')

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  it('click on null target calls onSelect with action="replace" and empty array', () => {
    const restoreEfp = mockElementFromPoint(null)
    const handle = initSelection(shadow, onHover, onSelect)

    const target = document.createElement('div')
    document.body.appendChild(target)
    dispatchMouseEvent(target, 'click', { clientX: 50, clientY: 50 })
    expect(onSelect).toHaveBeenCalledWith([], 'replace')

    handle.cleanup()
    restoreEfp()
    target.remove()
  })

  // `SVGElement extends Element`, NOT HTMLElement — in happy-dom exactly as in a
  // real browser — so these reproduce the shipped bug without any shim.
  describe('SVG targets', () => {
    const SVG_NS = 'http://www.w3.org/2000/svg'

    /** A two-path icon, matching what a lucide-style component renders. */
    function createIcon(): { svg: SVGSVGElement; path1: SVGPathElement; path2: SVGPathElement } {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('data-cortex-source', 'src/Icon.tsx:3:5')
      svg.setAttribute('class', 'lucide lucide-check')
      const path1 = document.createElementNS(SVG_NS, 'path')
      const path2 = document.createElementNS(SVG_NS, 'path')
      svg.append(path1, path2)
      document.body.appendChild(svg)
      return { svg, path1, path2 }
    }

    it('click on an inline <svg> selects it instead of clearing the selection', () => {
      const { svg } = createIcon()
      const restoreEfp = mockElementFromPoint(svg)
      const handle = initSelection(shadow, onHover, onSelect)

      dispatchMouseEvent(document.body, 'click', { clientX: 50, clientY: 50 })
      // Pre-fix: ([], 'replace') — the instanceof HTMLElement guard returned
      // null, and handleClick reads null as "backdrop, clear the selection".
      expect(onSelect).toHaveBeenCalledWith([svg], 'replace')

      handle.cleanup()
      restoreEfp()
      svg.remove()
    })

    it('click on an inner <path> selects the owning icon, not the path', () => {
      const { svg, path1 } = createIcon()
      const restoreEfp = mockElementFromPoint(path1)
      const handle = initSelection(shadow, onHover, onSelect)

      dispatchMouseEvent(document.body, 'click', { clientX: 50, clientY: 50 })
      // Pre-fix: ([], 'replace'). Also fails a NAIVE widening, which would
      // report ([path1], 'replace') — a selection that flips between <path> and
      // the icon depending on sub-pixel geometry hit-testing.
      expect(onSelect).toHaveBeenCalledWith([svg], 'replace')

      handle.cleanup()
      restoreEfp()
      svg.remove()
    })

    it('mousemove over an <svg> reports it to onHover', () => {
      const { svg } = createIcon()
      const restoreEfp = mockElementFromPoint(svg)
      const handle = initSelection(shadow, onHover, onSelect)

      dispatchMouseEvent(document.body, 'mousemove', { clientX: 50, clientY: 50 })
      expect(onHover).toHaveBeenCalledWith(svg) // pre-fix: onHover(null)

      handle.cleanup()
      restoreEfp()
      svg.remove()
    })

    it('hover does not re-fire while crossing between paths of one icon', () => {
      const { svg, path1, path2 } = createIcon()
      const handle = initSelection(shadow, onHover, onSelect)

      const restore1 = mockElementFromPoint(path1)
      dispatchMouseEvent(document.body, 'mousemove', { clientX: 50, clientY: 50 })
      restore1()
      const restore2 = mockElementFromPoint(path2)
      dispatchMouseEvent(document.body, 'mousemove', { clientX: 52, clientY: 52 })
      restore2()

      // Assert on `.mock.calls`, NOT toHaveBeenCalledTimes(1): pre-fix the count
      // is ALSO 1 (both moves resolve to null, and the null dedupe swallows the
      // second), so a count assertion would pass against the bug. The VALUE is
      // what distinguishes them — pre-fix this is [[null]].
      expect(onHover.mock.calls).toEqual([[svg]])

      handle.cleanup()
      svg.remove()
    })

    it('does not normalize HTML inside <foreignObject> to the enclosing icon', () => {
      const { svg } = createIcon()
      const fo = document.createElementNS(SVG_NS, 'foreignObject')
      const inner = document.createElement('div')
      inner.setAttribute('data-cortex-source', 'src/Icon.tsx:9:7')
      fo.appendChild(inner)
      svg.appendChild(fo)
      const restoreEfp = mockElementFromPoint(inner)
      const handle = initSelection(shadow, onHover, onSelect)

      dispatchMouseEvent(document.body, 'click', { clientX: 50, clientY: 50 })
      // Guard, not a repro — passes pre-fix too. foreignObject content is HTML,
      // so it must keep its own identity rather than collapsing to the icon.
      expect(onSelect).toHaveBeenCalledWith([inner], 'replace')

      handle.cleanup()
      restoreEfp()
      svg.remove()
    })

    it('click on a <style> inside an <svg> still clears the selection', () => {
      const { svg } = createIcon()
      const svgStyle = document.createElementNS(SVG_NS, 'style')
      svg.appendChild(svgStyle)
      const restoreEfp = mockElementFromPoint(svgStyle)
      const handle = initSelection(shadow, onHover, onSelect)

      dispatchMouseEvent(document.body, 'click', { clientX: 50, clientY: 50 })
      // Ordering guard: isNonEditable must run on the ORIGINAL node. If SVG
      // normalization ran first, this would promote to the icon and select it,
      // silently breaking the non-editable contract asserted above for <script>.
      expect(onSelect).toHaveBeenCalledWith([], 'replace')

      handle.cleanup()
      restoreEfp()
      svg.remove()
    })
  })
})
