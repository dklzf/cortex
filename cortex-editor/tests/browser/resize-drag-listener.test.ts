import { describe, it, expect, vi } from 'vitest'
import { installResizeDrag, RESIZE_EDGE_ATTR } from '../../src/browser/resize-drag-listener.js'

/**
 * The resize listener's own unit coverage.
 *
 * The e2e spec drives this through a real browser, which is the stronger
 * evidence for anything involving layout. What lives here is the behaviour a
 * real browser makes HARD to produce: a page whose DOM methods throw.
 */

/** A handle in light DOM. With no `shadowRoot` supplied, `resolvePressed`
 *  falls back to `event.target`, so this is what a press lands on. */
function handleFor(edge: string): HTMLElement {
  const h = document.createElement('div')
  h.setAttribute(RESIZE_EDGE_ATTR, edge)
  document.body.appendChild(h)
  return h
}

/** An element that measures fine right up until the probe touches it.
 *  The inline width matters: `beginResize` bails on a zero computed size
 *  BEFORE it probes, so without it the throw is never reached and the test
 *  passes for the wrong reason. */
function hostileElement(): HTMLElement {
  const el = document.createElement('div')
  el.style.width = '200px'
  el.style.height = '100px'
  document.body.appendChild(el)
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => { throw new TypeError('page redefined this') },
  })
  return el
}

const press = (node: Element) => node.dispatchEvent(new PointerEvent('pointerdown', {
  bubbles: true, cancelable: true, composed: true,
  clientX: 10, clientY: 10, pointerId: 1, button: 0,
}))

describe('installResizeDrag — when the measurement probe throws', () => {
  /**
   * The probe touches `style`, rects, animations and the parent chain, all of
   * which a page can redefine or make throw. The render path already guarded
   * this (`SelectionOverlay` wraps `canResizeEdge` in a try/catch); the event
   * path did not, so a press on a handle over such an element did nothing at
   * all — no drag, no message, no log.
   */
  it('declines the gesture and says so, instead of failing silently', () => {
    const hostile = hostileElement()
    const knob = handleFor('right')

    const said: string[] = []
    const results: unknown[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = installResizeDrag({
      getTarget: () => hostile,
      isOwnUI: () => true,
      onProbeError: (m) => said.push(m),
      onResult: (r) => results.push(r),
      target: window,
    })

    expect(() => press(knob)).not.toThrow()
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/could not measure/)
    // Declining means declining: nothing may reach the write path.
    expect(results).toHaveLength(0)
    // The user gets a sentence; the developer gets the element and the error.
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
    handle.cleanup()
    hostile.remove()
    knob.remove()
  })

  it('leaves a later listener on the same event running', () => {
    // The reason the guard is here and not around the whole listener: a throw
    // escaping `dispatchEvent` is a denial of service on every other handler
    // for that event. This exact failure took an unrelated panel-drag test down
    // once already.
    const hostile = hostileElement()
    const knob = handleFor('right')

    let laterRan = false
    const later = () => { laterRan = true }
    window.addEventListener('pointerdown', later, true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = installResizeDrag({
      getTarget: () => hostile, isOwnUI: () => true, target: window,
    })

    press(knob)
    expect(laterRan).toBe(true)

    warn.mockRestore()
    window.removeEventListener('pointerdown', later, true)
    handle.cleanup()
    hostile.remove()
    knob.remove()
  })
})

describe('installResizeDrag — a page cannot arm its own handle', () => {
  /**
   * Both gates are page-settable ATTRIBUTES: `isOwnUI` looks for
   * `[data-cortex-host]` on the composed path, and `begin` does
   * `closest('[data-cortex-resize-edge]')`. So two attributes in
   * server-rendered HTML — from a CMS, no script required — used to be enough
   * to arm a real resize handle in light DOM. A user's ordinary drag on an
   * ordinary-looking element would then resize whatever cortex had selected
   * and write that to their source.
   *
   * With a shadow root supplied, its hit-test is the only answer.
   */
  it('declines a light-DOM element wearing the handle attribute', () => {
    const target = document.createElement('div')
    target.style.width = '200px'
    target.style.height = '100px'
    document.body.appendChild(target)

    // The impostor: exactly what a page can write into its own markup.
    const impostor = document.createElement('div')
    impostor.setAttribute('data-cortex-host', '')
    impostor.setAttribute(RESIZE_EDGE_ATTR, 'right')
    document.body.appendChild(impostor)

    // A root that answers "nothing of mine is there" — the truthful answer for
    // a press that landed on the page.
    const root = { elementFromPoint: () => null } as unknown as ShadowRoot

    const states: string[] = []
    const handle = installResizeDrag({
      getTarget: () => target,
      isOwnUI: () => true,
      shadowRoot: root,
      onStateChange: (s) => states.push(s.phase),
      target: window,
    })

    press(impostor)
    // No gesture began. Before the fix, `event.target` was the impostor and
    // `closest` matched its attribute, so this armed a real drag.
    expect(states).toEqual([])

    handle.cleanup()
    target.remove()
    impostor.remove()
  })

  it('still resolves through event.target when there is no root to ask', () => {
    // The fallback has a real caller — light-DOM handles in the synthetic e2e
    // fixture, and happy-dom, which has no `ShadowRoot.elementFromPoint`.
    // Narrowing it must not delete it.
    const target = document.createElement('div')
    target.style.width = '200px'
    target.style.height = '100px'
    document.body.appendChild(target)
    const knob = handleFor('right')

    const states: string[] = []
    const handle = installResizeDrag({
      getTarget: () => target,
      isOwnUI: () => true,
      onStateChange: (s) => states.push(s.phase),
      target: window,
    })

    press(knob)
    expect(states).toEqual(['pressed'])

    handle.cleanup()
    target.remove()
    knob.remove()
  })
})
