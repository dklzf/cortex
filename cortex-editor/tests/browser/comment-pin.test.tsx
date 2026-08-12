import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from 'preact'
import { CommentPin } from '../../src/browser/components/CommentPin.js'
import type { Annotation, CortexChannel } from '../../src/adapters/types.js'

function mockChannel(): CortexChannel & { _lastSent: unknown[] } {
  const sent: unknown[] = []
  return {
    send: vi.fn((msg) => sent.push(msg)),
    onMessage: vi.fn(() => () => {}),
    connected: true,
    _lastSent: sent,
  }
}

const pinAnnotation: Annotation = {
  id: 'pin-1', status: 'pending', elementSource: 'App.tsx:10:5',
  text: 'Fix this', pinPosition: { x: 0.5, y: 0.3 },
  createdAt: Date.now(), updatedAt: Date.now(), thread: [],
}

const unpinnedAnnotation: Annotation = {
  id: 'unpin-1', status: 'pending', elementSource: 'App.tsx:20:1',
  text: 'No pin', createdAt: Date.now(), updatedAt: Date.now(), thread: [],
}

describe('CommentPin', () => {
  let container: HTMLDivElement
  let targetElement: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)

    // Create a DOM element with data-cortex-source that the pin can find
    targetElement = document.createElement('div')
    targetElement.setAttribute('data-cortex-source', 'App.tsx:10:5')
    document.body.appendChild(targetElement)
    // Mock getBoundingClientRect to return non-zero dimensions
    targetElement.getBoundingClientRect = () => ({
      x: 100, y: 200, width: 300, height: 100,
      top: 200, right: 400, bottom: 300, left: 100,
      toJSON() { return this },
    })
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    targetElement.remove()
  })

  it('renders nothing when no pinned annotations', () => {
    render(<CommentPin annotations={[]} commentMode={false} channel={mockChannel()} onReply={vi.fn()} />, container)
    expect(container.querySelector('.cortex-pin')).toBeNull()
  })

  it('does not render pin dots for annotations without pinPosition', () => {
    render(<CommentPin annotations={[unpinnedAnnotation]} commentMode={false} channel={mockChannel()} onReply={vi.fn()} />, container)
    expect(container.querySelector('.cortex-pin')).toBeNull()
  })

  it('renders pin dot for annotation with pinPosition and matching DOM element', async () => {
    render(<CommentPin annotations={[pinAnnotation]} commentMode={false} channel={mockChannel()} onReply={vi.fn()} />, container)
    const pin = await vi.waitFor(() => {
      const el = container.querySelector('.cortex-pin') as HTMLDivElement
      expect(el).not.toBeNull()
      return el
    }, { timeout: 500 })
    // Position: left = rect.left + 0.5*rect.width - 6 = 100 + 150 - 6 = 244
    // Position: top = rect.top + 0.3*rect.height - 6 = 200 + 30 - 6 = 224
    expect(pin.style.left).toBe('244px')
    expect(pin.style.top).toBe('224px')
  })

  it('does not render pin when element has zero dimensions', async () => {
    targetElement.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 0, height: 0,
      top: 0, right: 0, bottom: 0, left: 0,
      toJSON() { return this },
    })
    render(<CommentPin annotations={[pinAnnotation]} commentMode={false} channel={mockChannel()} onReply={vi.fn()} />, container)
    // Wait one tick for useEffect to run, then assert nothing rendered.
    await new Promise<void>(r => setTimeout(r, 0))
    expect(container.querySelector('.cortex-pin')).toBeNull()
  })

  it('renders crosshair overlay in comment mode', () => {
    render(<CommentPin annotations={[]} commentMode={true} channel={mockChannel()} onReply={vi.fn()} />, container)
    expect(container.querySelector('.cortex-pin--mode')).toBeTruthy()
  })

  it('does not render crosshair when not in comment mode', () => {
    render(<CommentPin annotations={[]} commentMode={false} channel={mockChannel()} onReply={vi.fn()} />, container)
    expect(container.querySelector('.cortex-pin--mode')).toBeNull()
  })

  it('clicking pin dot opens thread card', async () => {
    render(<CommentPin annotations={[pinAnnotation]} commentMode={false} channel={mockChannel()} onReply={vi.fn()} />, container)
    const pin = await vi.waitFor(() => {
      const el = container.querySelector('.cortex-pin') as HTMLDivElement
      expect(el).not.toBeNull()
      return el
    }, { timeout: 500 })
    pin.click()
    await vi.waitFor(() => {
      const thread = container.querySelector('.cortex-pin__thread')
      expect(thread).not.toBeNull()
      // Thread should show the annotation text
      expect(thread?.textContent).toContain('Fix this')
    }, { timeout: 500 })
  })

  it('clicking pin dot again closes thread card', async () => {
    render(<CommentPin annotations={[pinAnnotation]} commentMode={false} channel={mockChannel()} onReply={vi.fn()} />, container)
    const pin = await vi.waitFor(() => {
      const el = container.querySelector('.cortex-pin') as HTMLDivElement
      expect(el).not.toBeNull()
      return el
    }, { timeout: 500 })
    pin.click()
    await vi.waitFor(() => {
      expect(container.querySelector('.cortex-pin__thread')).not.toBeNull()
    }, { timeout: 500 })

    pin.click()
    await vi.waitFor(() => {
      expect(container.querySelector('.cortex-pin__thread')).toBeNull()
    }, { timeout: 500 })
  })
})

describe('CommentPin — the pin targets what the user CLICKED (COR-27)', () => {
  let container: HTMLDivElement
  let wrapper: HTMLDivElement
  let button: HTMLButtonElement

  const rect = (el: Element, box: { left: number; top: number; width: number; height: number }): void => {
    ;(el as HTMLElement).getBoundingClientRect = () => ({
      x: box.left, y: box.top, width: box.width, height: box.height,
      left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height,
      toJSON() { return this },
    }) as DOMRect
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)

    // An ANNOTATED layout wrapper containing an UNANNOTATED button — the shape
    // of a component-library app, where source-transform skips node_modules so
    // the majority of pointable nodes carry no source at all.
    wrapper = document.createElement('div')
    wrapper.setAttribute('data-cortex-source', 'src/Layout.tsx:4:3')
    rect(wrapper, { left: 0, top: 0, width: 1000, height: 800 })
    button = document.createElement('button')
    button.className = 'btn btn-primary'
    button.textContent = 'Save'
    rect(button, { left: 100, top: 200, width: 200, height: 40 })
    wrapper.appendChild(button)
    document.body.appendChild(wrapper)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    wrapper.remove()
  })

  // Effects must flush before the click: the handler is attached inside a
  // useEffect, and Preact defers those past render(). Dispatching immediately
  // hits a window with no listener, which surfaces as "the click was rejected"
  // and would have been read as a product bug.
  const flush = (): Promise<void> => new Promise(r => setTimeout(r, 20))

  const clickAndSubmit = async (channel: ReturnType<typeof mockChannel>, clientX: number, clientY: number): Promise<void> => {
    render(<CommentPin annotations={[]} commentMode channel={channel} onReply={vi.fn()} />, container)
    await flush()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }))
    await flush()
    const input = container.querySelector<HTMLInputElement>('.cortex-pin__input-field')
    if (!input) throw new Error('[test] comment input did not open — the click was rejected')
    input.value = 'this button is too small'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    // Enter must not be dispatched in the same tick: the submit handler closes
    // over pinText, and the state update from the input event has to commit
    // first or it reads the empty initial value and refuses to send.
    await flush()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
  }

  it('records the unannotated BUTTON, not the annotated wrapper above it', async () => {
    // The whole defect: `closest('[data-cortex-source]')` recorded the wrapper,
    // and nothing told the user their target had been substituted. The comment
    // gesture exists to describe ONE specific element.
    const channel = mockChannel()
    await clickAndSubmit(channel, 150, 220)
    const msg = channel._lastSent.find(
      (m): m is { type: string; elementSource: string } =>
        (m as { type?: string }).type === 'comment',
    )
    expect(msg).toBeDefined()
    expect(msg!.elementSource).not.toBe('src/Layout.tsx:4:3')
    expect(msg!.elementSource).toMatch(/^cortex-preview:/)
  })

  it('carries a resolution hint, or the agent has an id it cannot resolve', async () => {
    // A preview source is a page-session id. Without the hint the agent receives
    // a comment it can read and cannot act on — worse than the substitution,
    // because it looks like it worked.
    const channel = mockChannel()
    await clickAndSubmit(channel, 150, 220)
    const msg = channel._lastSent.find(
      (m): m is { type: string; sourceResolutionHint?: Record<string, string> } =>
        (m as { type?: string }).type === 'comment',
    )
    expect(msg!.sourceResolutionHint).toMatchObject({
      tagName: 'button',
      className: 'btn btn-primary',
      textPreview: 'Save',
    })
  })

  it('positions the pin within the CLICKED element rect, not the ancestor rect', async () => {
    // The second half of the bug, and the more visible one: pinPosition was a
    // fraction of the ANCESTOR's box. Clicking the button's centre stored
    // (0.15, 0.275) of a 1000x800 wrapper instead of (0.25, 0.5) of the button
    // — so the pin rendered somewhere else entirely.
    const channel = mockChannel()
    await clickAndSubmit(channel, 150, 220)
    const msg = channel._lastSent.find(
      (m): m is { type: string; pinPosition: { x: number; y: number } } =>
        (m as { type?: string }).type === 'comment',
    )
    expect(msg!.pinPosition.x).toBeCloseTo((150 - 100) / 200, 3)
    expect(msg!.pinPosition.y).toBeCloseTo((220 - 200) / 40, 3)
  })

  it('still uses the real source when the clicked element HAS one', async () => {
    // The annotated path must not regress into preview ids — that would push
    // every comment through agent resolution for no reason.
    const channel = mockChannel()
    render(<CommentPin annotations={[]} commentMode channel={channel} onReply={vi.fn()} />, container)
    await flush()
    wrapper.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }))
    await flush()
    const input = container.querySelector<HTMLInputElement>('.cortex-pin__input-field')
    if (!input) throw new Error('[test] comment input did not open')
    input.value = 'wrapper comment'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    const msg = channel._lastSent.find(
      (m): m is { type: string; elementSource: string; sourceResolutionHint?: unknown } =>
        (m as { type?: string }).type === 'comment',
    )
    expect(msg!.elementSource).toBe('src/Layout.tsx:4:3')
    expect(msg!.sourceResolutionHint).toBeUndefined()
  })
})

describe('CommentPin — a preview-sourced pin survives a reload (COR-27 review)', () => {
  let container: HTMLDivElement
  let button: HTMLButtonElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    // A FRESH element, exactly as a reload produces it: it matches the recorded
    // domSelector but carries no preview id, because that id only ever existed
    // as an attribute on the node from the previous page session.
    button = document.createElement('button')
    button.id = 'save-btn'
    document.body.appendChild(button)
    ;(button as HTMLElement).getBoundingClientRect = () => ({
      x: 100, y: 200, width: 200, height: 40,
      left: 100, top: 200, right: 300, bottom: 240,
      toJSON() { return this },
    }) as DOMRect
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    button.remove()
  })

  const rehydrated = (hint?: Record<string, string>): Annotation => ({
    id: 'a-reload', status: 'pending',
    elementSource: 'cortex-preview:p-from-last-session',
    text: 'too small', pinPosition: { x: 0.5, y: 0.5 },
    createdAt: Date.now(), updatedAt: Date.now(), thread: [],
    ...(hint ? { sourceResolutionHint: hint as never } : {}),
  })

  it('recovers the element through the hint domSelector', async () => {
    render(
      <CommentPin
        annotations={[rehydrated({ tagName: 'button', textPreview: 'Save', domSelector: 'button#save-btn' })]}
        commentMode={false} channel={mockChannel()} onReply={vi.fn()} />,
      container,
    )
    await new Promise(r => setTimeout(r, 20))
    // Before this, the selector matched nothing and the pin silently vanished
    // while the annotation was still active — a comment the user cannot see is
    // worse than one that is merely misplaced.
    expect(container.querySelector('.cortex-pin')).not.toBeNull()
    // And it re-stamps the id, so the recovery holds for the rest of the session
    // instead of re-running the selector on every scroll frame.
    expect(button.getAttribute('data-cortex-preview-id')).toBe('p-from-last-session')
  })

  // TODO: requires a real browser. happy-dom neither THROWS on an invalid
  // selector nor rejects it — `document.querySelector('button#((')` matches the
  // button — so this cannot distinguish a guarded implementation from an
  // unguarded one. In Chromium querySelector throws, which without the try/catch
  // aborts the position loop and hides EVERY pin on the page. Asserting it here
  // would inflate the pass count while proving nothing; the guard is exercised
  // by the e2e layer or not at all.
  it.skip('a malformed hint selector does not take down the OTHER pins', async () => {
    // domSelector is page-derived, so it can be invalid — and in a real browser
    // querySelector THROWS on one, which would abort the whole position loop and
    // hide every pin on the page. Asserting "this pin does not render" would be
    // theatre here: happy-dom returns null instead of throwing, so that
    // assertion passes with or without the try/catch. What IS observable in
    // either engine is the consequence — a second, valid annotation must still
    // get its pin.
    const good: Annotation = {
      ...rehydrated({ tagName: 'button', textPreview: 'Save', domSelector: 'button#save-btn' }),
      id: 'a-good',
    }
    const bad: Annotation = {
      ...rehydrated({ tagName: 'button', textPreview: '', domSelector: 'button#((' }),
      id: 'a-bad',
      // A DISTINCT source. Sharing one with `good` made this test measure the
      // wrong thing: recovery re-stamps the preview id on the element, so a
      // second annotation naming the SAME source then resolves directly and
      // never reaches the selector path at all.
      elementSource: 'cortex-preview:p-other-session',
    }
    render(
      <CommentPin annotations={[bad, good]} commentMode={false} channel={mockChannel()} onReply={vi.fn()} />,
      container,
    )
    await new Promise(r => setTimeout(r, 20))
    expect(container.querySelectorAll('.cortex-pin').length).toBe(1)
  })

  it('refuses to recover when the hint selector matches SEVERAL elements', async () => {
    // domSelector is a tag plus a first class, so repeated rows share one.
    // Taking the first match placed every annotation on the same element and
    // stamped each preview id over the last — pins collapsing onto one node,
    // and the DOM left carrying ids naming the wrong element for the session.
    // An arbitrary pick is indistinguishable from a correct recovery, which is
    // worse than a hidden pin: a hidden pin asserts nothing.
    const twin = document.createElement('button')
    twin.id = 'save-btn-2'
    twin.className = 'row'
    document.body.appendChild(twin)
    button.className = 'row'
    try {
      render(
        <CommentPin
          annotations={[rehydrated({ tagName: 'button', textPreview: '', domSelector: 'button.row' })]}
          commentMode={false} channel={mockChannel()} onReply={vi.fn()} />,
        container,
      )
      await new Promise(r => setTimeout(r, 20))
      expect(container.querySelector('.cortex-pin')).toBeNull()
      // And neither candidate is stamped — a wrong id would outlive the render.
      expect(button.hasAttribute('data-cortex-preview-id')).toBe(false)
      expect(twin.hasAttribute('data-cortex-preview-id')).toBe(false)
    } finally {
      twin.remove()
    }
  })

  it('does not guess when there is no hint at all', async () => {
    render(
      <CommentPin annotations={[rehydrated()]} commentMode={false} channel={mockChannel()} onReply={vi.fn()} />,
      container,
    )
    await new Promise(r => setTimeout(r, 20))
    expect(container.querySelector('.cortex-pin')).toBeNull()
  })
})
