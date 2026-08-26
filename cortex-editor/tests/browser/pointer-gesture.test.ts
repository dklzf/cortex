import { describe, it, expect, vi } from 'vitest'
import { installPointerGesture } from '../../src/browser/pointer-gesture.js'

/**
 * The shared gesture plumbing.
 *
 * Extracted from `reorder-drag-listener.ts` so the resize gesture could reuse
 * it. The reorder e2e suite (`reorder-drag-gesture.spec.ts`, 12 real-pointer
 * tests) is the primary proof the extraction is behaviour-preserving; this file
 * covers the two behaviours Playwright's `mouse` API cannot reach, which were
 * disclosed as gaps on PR #196:
 *
 *   - `dragstart` refusal — Playwright cannot initiate a NATIVE HTML drag.
 *   - `touch-action` pinning — `page.mouse` never produces touch pointers.
 *
 * Both are driven here with synthetic events. That is weaker evidence than a
 * real browser gesture: it proves the handler runs and does the right thing,
 * not that the browser dispatches what we think it does. Stated rather than
 * implied — the alternative was leaving them untested entirely.
 */

type S = { phase: string; el?: Element }

function harness(over: Partial<Parameters<typeof installPointerGesture<S, string>>[0]> = {}) {
  const win = window
  const seen: string[] = []
  const handle = installPointerGesture<S, string>({
    begin: (pressed) => ({ phase: 'pressed', el: pressed }),
    onMove: (s) => ({ ...s, phase: 'dragging' }),
    onUp: (s) => ({ state: { phase: 'idle' }, result: s.phase === 'dragging' ? 'done' : undefined }),
    onCancel: () => ({ phase: 'idle' }),
    isOwnUI: () => false,
    onStateChange: (s) => seen.push(s.phase),
    target: win,
    ...over,
  })
  return { handle, seen }
}

function el(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  const node = host.firstElementChild as HTMLElement
  document.body.appendChild(host)
  return node
}

const down = (target: Element, over: Partial<PointerEventInit> = {}) =>
  target.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, composed: true,
    clientX: 10, clientY: 10, pointerId: 1, button: 0, ...over,
  }))

describe('installPointerGesture — native drag refusal', () => {
  it('cancels dragstart while a gesture is active', () => {
    // Images, links and `draggable="true"` elements start a native HTML drag
    // once the pointer travels. `preventDefault` on pointermove does NOT stop
    // it — it comes from the compatibility mouse sequence — and once it starts
    // the browser takes the pointer away, pointercancel fires, and the gesture
    // is abandoned. So dragging a list of images would simply never work.
    const { handle } = harness()
    const img = el('<img src="x.png" alt="row">')
    down(img)

    const ev = new Event('dragstart', { bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    handle.cleanup()
  })

  it('does NOT cancel dragstart when idle', () => {
    // Cortex is a guest in the page. Suppressing drag-and-drop the user did not
    // start would break the page's own features.
    const { handle } = harness()
    const ev = new Event('dragstart', { bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    handle.cleanup()
  })
})

describe('installPointerGesture — touch-action pinning', () => {
  it('pins touch-action for a TOUCH pointer and restores it on release', () => {
    // The browser decides pan-vs-gesture BEFORE the threshold is crossed, so a
    // later preventDefault cannot change its mind.
    const { handle } = harness()
    const row = el('<li>Row</li>')
    down(row, { pointerType: 'touch' })
    expect(row.style.touchAction).toBe('none')

    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
    // Restored to the PRIOR INLINE VALUE — empty — not to 'auto'. Writing
    // 'auto' would leave a declaration on an element that had none, silently
    // overriding whatever the page's stylesheet says.
    expect(row.style.touchAction).toBe('')
    handle.cleanup()
  })

  it('leaves a MOUSE pointer alone', () => {
    const { handle } = harness()
    const row = el('<li>Row</li>')
    down(row, { pointerType: 'mouse' })
    expect(row.style.touchAction).toBe('')
    handle.cleanup()
  })

  it('pins the element the gesture names, not the one pressed', () => {
    // A press on <span> inside <li> reorders the LI, so the li is what must not
    // pan. This distinction was implicit while the code was inline and had to
    // become explicit once shared.
    const row = el('<li><span>Alpha</span></li>')
    const span = row.firstElementChild!
    const { handle } = harness({
      begin: () => ({ phase: 'pressed', el: row }),
      touchTarget: (s: S) => s.el ?? null,
    })
    down(span, { pointerType: 'touch' })
    expect(row.style.touchAction).toBe('none')
    expect((span as HTMLElement).style.touchAction).toBe('')
    handle.cleanup()
  })

  it('restores touch-action on CANCEL, not only on release', () => {
    // A gesture the browser takes away must not leave the page unable to scroll.
    const { handle } = harness()
    const row = el('<li>Row</li>')
    down(row, { pointerType: 'touch' })
    window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }))
    expect(row.style.touchAction).toBe('')
    handle.cleanup()
  })
})

describe('installPointerGesture — declines it should make', () => {
  it('ignores a non-primary button', () => {
    const { seen, handle } = harness()
    down(el('<li>Row</li>'), { button: 2 })
    expect(seen).toHaveLength(0)
    handle.cleanup()
  })

  it('ignores a press on cortex chrome', () => {
    const { seen, handle } = harness({ isOwnUI: () => true })
    down(el('<li>Row</li>'))
    expect(seen).toHaveLength(0)
    handle.cleanup()
  })

  it('declines when begin returns null', () => {
    const { seen, handle } = harness({ begin: () => null })
    down(el('<li>Row</li>'))
    expect(seen).toHaveLength(0)
    handle.cleanup()
  })
})
