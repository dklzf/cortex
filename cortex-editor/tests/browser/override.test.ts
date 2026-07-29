import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { CSSOverrideManager } from '../../src/browser/override.js'

describe('CSSOverrideManager', () => {
  let manager: CSSOverrideManager
  const originalRAF = window.requestAnimationFrame
  const originalCAF = window.cancelAnimationFrame

  beforeEach(() => {
    // Make RAF synchronous so existing set() tests work unchanged
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(performance.now())
      return 0
    }) as typeof requestAnimationFrame
    // Clean up any leftover elements from previous tests — sources are shared
    // across the suite (e.g. 'a:1:1') and a leftover target would poison the
    // next test's querySelector for `[data-cortex-source=...]`.
    document.querySelectorAll('[data-cortex-override]').forEach(el => el.remove())
    document.querySelectorAll('[data-cortex-source]').forEach(el => el.remove())
    manager = new CSSOverrideManager()
  })

  afterEach(() => {
    window.requestAnimationFrame = originalRAF
    window.cancelAnimationFrame = originalCAF
    // Belt-and-suspenders cleanup for test-created elements.
    document.querySelectorAll('[data-cortex-source]').forEach(el => el.remove())
  })

  it('creates a <style data-cortex-override> element in document.head', () => {
    const styleEl = document.head.querySelector('[data-cortex-override]')
    expect(styleEl).toBeInstanceOf(HTMLStyleElement)
  })

  it('set() generates a rule with !important', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red')
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    // CSS.escape escapes dots and colons: Hero\.tsx\:5\:3
    expect(styleEl.textContent).toBe(
      '[data-cortex-source="Hero\\.tsx\\:5\\:3"] { color: red !important; }',
    )
  })

  it('multiple properties for the same source combine into one rule', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red')
    manager.set('Hero.tsx:5:3', 'font-size', '16px')
    manager.flush()
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe(
      '[data-cortex-source="Hero\\.tsx\\:5\\:3"] { color: red !important; font-size: 16px !important; }',
    )
  })

  it('multiple sources produce separate rules', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red')
    manager.set('Nav.tsx:10:1', 'margin', '0')
    manager.flush()
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    const rules = styleEl.textContent!.split('\n')
    expect(rules).toHaveLength(2)
    expect(rules[0]).toContain('Hero\\.tsx\\:5\\:3')
    expect(rules[1]).toContain('Nav\\.tsx\\:10\\:1')
  })

  it('remove(source, prop) removes a single property', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red')
    manager.set('Hero.tsx:5:3', 'font-size', '16px')
    manager.remove('Hero.tsx:5:3', 'color')
    manager.flush()
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe(
      '[data-cortex-source="Hero\\.tsx\\:5\\:3"] { font-size: 16px !important; }',
    )
  })

  it('remove(source) removes all overrides for that source', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red')
    manager.set('Hero.tsx:5:3', 'font-size', '16px')
    manager.set('Nav.tsx:10:1', 'margin', '0')
    manager.remove('Hero.tsx:5:3')
    manager.flush()
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe(
      '[data-cortex-source="Nav\\.tsx\\:10\\:1"] { margin: 0 !important; }',
    )
  })

  it('remove() single prop cleans up empty source entry', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red')
    manager.remove('Hero.tsx:5:3', 'color')
    manager.flush()
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe('')
  })

  it('clearAll() empties the stylesheet', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red')
    manager.set('Nav.tsx:10:1', 'margin', '0')
    manager.clearAll()
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe('')
  })

  it('dispose() removes the <style> element from the DOM', () => {
    manager.dispose()
    const styleEl = document.head.querySelector('[data-cortex-override]')
    expect(styleEl).toBeNull()
  })

  it('set() overwrites existing value for same property', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red')
    manager.set('Hero.tsx:5:3', 'color', 'blue')
    manager.flush()
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe(
      '[data-cortex-source="Hero\\.tsx\\:5\\:3"] { color: blue !important; }',
    )
  })

  // Fix 2: CSS injection — source escaping via CSS.escape()
  it.each([
    ['injection payload', 'file"]{}body{display:none}[x="', 'body{display:none}'],
    ['double quotes', 'Hero"evil.tsx:5:3', '[data-cortex-source="Hero"'],
    ['closing brackets', 'file]:5:3', undefined],
  ] as const)('escapes %s in source via CSS.escape()', (_label, source, forbidden) => {
    manager.set(source, 'color', 'red')
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toContain('color: red !important')
    if (forbidden) expect(styleEl.textContent).not.toContain(forbidden)
  })

  // Fix 2: CSS injection — property validation
  it('rejects invalid property names with special characters', () => {
    manager.set('Hero.tsx:5:3', 'color;} body { display', 'none')
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe('')
  })

  it('rejects property names with braces', () => {
    manager.set('Hero.tsx:5:3', 'color}', 'red')
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe('')
  })

  it('accepts valid CSS custom properties', () => {
    manager.set('Hero.tsx:5:3', '--my-color', 'red')
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toContain('--my-color: red !important')
  })

  it('accepts hyphenated properties like font-size', () => {
    manager.set('Hero.tsx:5:3', 'font-size', '16px')
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toContain('font-size: 16px !important')
  })

  // Fix 7: CSS value injection
  it('rejects value containing }', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red } body { display:none')
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe('')
  })

  it('rejects value containing ;', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red; background: url(evil)')
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe('')
  })

  it('rejects value containing {', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red { font-size: 99px')
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe('')
  })

  it('rejects CSS comment injection (/* */)', () => {
    manager.set('Hero.tsx:5:3', 'color', 'red /*')
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toBe('')
  })

  // H4: RAF-batched rebuilds
  describe('RAF batching', () => {
    let rafCallbacks: Map<number, FrameRequestCallback>
    let nextId: number

    beforeEach(() => {
      rafCallbacks = new Map()
      nextId = 1
      // Override the synchronous RAF with a capturing version
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        const id = nextId++
        rafCallbacks.set(id, cb)
        return id
      }) as typeof requestAnimationFrame
      window.cancelAnimationFrame = ((id: number) => {
        rafCallbacks.delete(id)
      }) as typeof cancelAnimationFrame
    })

    // afterEach in outer describe restores the original RAF

    function flushRAF() {
      const cbs = Array.from(rafCallbacks.values())
      rafCallbacks.clear()
      cbs.forEach(cb => cb(performance.now()))
    }

    it('coalesces multiple set() calls into a single rebuild', () => {
      manager.set('a:1:1', 'color', 'red')
      manager.set('a:1:1', 'font-size', '16px')
      manager.set('b:1:1', 'margin', '0')

      // Before RAF fires, stylesheet should be empty (no synchronous rebuild)
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')

      // Flush RAF — single rebuild
      flushRAF()
      expect(styleEl.textContent).toContain('color: red !important')
      expect(styleEl.textContent).toContain('font-size: 16px !important')
      expect(styleEl.textContent).toContain('margin: 0 !important')
    })

    it('remove() rebuilds synchronously to prevent flicker', () => {
      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.set('a:1:1', 'font-size', '16px')
      flushRAF()

      manager.remove('a:1:1', 'font-size')
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe(
        '[data-cortex-source="a\\:1\\:1"] { color: red !important; }',
      )
    })

    it('clearAll() rebuilds synchronously', () => {
      manager.set('a:1:1', 'color', 'red')
      flushRAF()

      manager.clearAll()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })

    it('flush() forces pending rebuild synchronously', () => {
      manager.set('a:1:1', 'color', 'red')

      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')

      manager.flush()
      expect(styleEl.textContent).toContain('color: red !important')
      // RAF callback should have been cancelled
      expect(rafCallbacks.size).toBe(0)
    })

    it('flush() is a no-op when no rebuild is pending', () => {
      manager.set('a:1:1', 'color', 'red')
      flushRAF()

      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      const before = styleEl.textContent

      manager.flush()
      expect(styleEl.textContent).toBe(before)
    })

    it('remove() cancels pending RAF so stale rebuild does not fire', () => {
      manager.set('a:1:1', 'color', 'red')
      flushRAF()

      manager.set('a:1:1', 'font-size', '16px')
      expect(rafCallbacks.size).toBe(1)

      // remove() cancels the pending RAF and rebuilds synchronously
      manager.remove('a:1:1', 'font-size')
      expect(rafCallbacks.size).toBe(0)

      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      const afterRemove = styleEl.textContent
      flushRAF()
      expect(styleEl.textContent).toBe(afterRemove)
    })

    it('clearAll() clears state overrides too', () => {
      manager.set('a:1:1', 'color', 'red')
      manager.setStateOverrides('a:1:1', new Map([['background', 'blue']]))
      flushRAF()

      manager.clearAll()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })

    it('setStateOverrides with all-invalid entries clears previous entry for that source', () => {
      manager.setStateOverrides('a:1:1', new Map([['color', 'red']]))
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('color: red')

      // All entries invalid — should delete the previous state override
      manager.setStateOverrides('a:1:1', new Map([['invalid;prop', 'value']]))
      expect(styleEl.textContent).toBe('')
    })

    it('setStateOverrides rebuilds synchronously', () => {
      manager.setStateOverrides('a:1:1', new Map([['color', 'red']]))
      // Should be visible immediately (not deferred to RAF)
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('color: red')
      // No pending RAF
      expect(rafCallbacks.size).toBe(0)
    })

    it('clearAll() cancels pending RAF so stale rebuild does not fire', () => {
      manager.set('a:1:1', 'color', 'red')
      expect(rafCallbacks.size).toBe(1)

      // clearAll() should cancel the pending RAF
      manager.clearAll()
      expect(rafCallbacks.size).toBe(0)

      // Flushing RAF should be a no-op
      flushRAF()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })

    it('dispose() cancels pending RAF', () => {
      manager.set('a:1:1', 'color', 'red')
      // RAF is pending but not fired
      manager.dispose()

      // Flush any remaining RAF callbacks — should not throw
      flushRAF()

      const styleEl = document.head.querySelector('[data-cortex-override]')
      expect(styleEl).toBeNull()
    })
  })

  it('set() accepts calc() expressions with + and *', () => {
    manager.set('a:1:1', 'width', 'calc(100% - 20px)')
    manager.set('b:1:1', 'height', 'calc(50% + 10px)')
    manager.set('c:1:1', 'font-size', 'calc(1rem * 1.5)')
    manager.flush()
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toContain('width: calc(100% - 20px) !important')
    expect(styleEl.textContent).toContain('height: calc(50% + 10px) !important')
    expect(styleEl.textContent).toContain('font-size: calc(1rem * 1.5) !important')
  })

  it('accepts normal CSS values', () => {
    manager.set('a:1:1', 'color', 'red')
    manager.set('b:1:1', 'font-size', '16px')
    manager.set('c:1:1', 'color', 'rgb(0,0,0)')
    manager.set('d:1:1', 'border', '1px solid black')
    manager.set('e:1:1', 'margin', '0')
    manager.set('f:1:1', 'padding', '10%')
    manager.set('g:1:1', 'color', '#ff0000')
    manager.flush()
    const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
    expect(styleEl.textContent).toContain('color: red !important')
    expect(styleEl.textContent).toContain('font-size: 16px !important')
    expect(styleEl.textContent).toContain('color: rgb(0,0,0) !important')
    expect(styleEl.textContent).toContain('border: 1px solid black !important')
    expect(styleEl.textContent).toContain('margin: 0 !important')
    expect(styleEl.textContent).toContain('padding: 10% !important')
    expect(styleEl.textContent).toContain('color: #ff0000 !important')
  })

  describe('state overrides', () => {
    it('setStateOverrides generates a rule merged with user overrides', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      manager.flush()
      manager.setStateOverrides('Hero.tsx:5:3', new Map([['background', 'blue']]))
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      // Both declarations in one rule — user edit 'color' + state override 'background'
      expect(styleEl.textContent).toContain('color: red !important')
      expect(styleEl.textContent).toContain('background: blue !important')
    })

    it('user edits win over state overrides for same property', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      manager.setStateOverrides('Hero.tsx:5:3', new Map([['color', 'blue']]))
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('color: red !important')
      expect(styleEl.textContent).not.toContain('color: blue')
    })

    it('clearStateOverrides removes state overrides but keeps user edits', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      manager.setStateOverrides('Hero.tsx:5:3', new Map([['background', 'blue']]))
      manager.flush()
      manager.clearStateOverrides()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('color: red !important')
      expect(styleEl.textContent).not.toContain('background')
    })

    it('clearStateOverrides calls rebuild synchronously', () => {
      manager.setStateOverrides('Hero.tsx:5:3', new Map([['color', 'blue']]))
      manager.flush()
      // clearStateOverrides should update the style tag immediately (not via RAF)
      manager.clearStateOverrides()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })

    it('setStateOverrides validates property names and values', () => {
      manager.setStateOverrides('Hero.tsx:5:3', new Map([
        ['color', 'red'],
        ['invalid;prop', 'value'],          // invalid property
        ['background', 'url(http://evil)'],  // url() rejected
      ]))
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('color: red')
      expect(styleEl.textContent).not.toContain('invalid')
      expect(styleEl.textContent).not.toContain('url')
    })

    it('state overrides only for element (not pseudo) selectors', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      manager.set('Hero.tsx:5:3', 'width', '100px', '::before')
      manager.setStateOverrides('Hero.tsx:5:3', new Map([['background', 'blue']]))
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      // State override only merges with element rule, not pseudo rule
      const rules = styleEl.textContent!
      expect(rules).toContain('background: blue')
      // Pseudo rule should NOT have background
      const pseudoRuleMatch = rules.match(/::before\s*\{[^}]+\}/)
      expect(pseudoRuleMatch?.[0]).not.toContain('background')
    })
  })

  describe('pseudo-element selectors', () => {
    it('set with pseudo generates a pseudo-element selector', () => {
      manager.set('Hero.tsx:5:3', 'width', '100px', '::before')
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe(
        '[data-cortex-source="Hero\\.tsx\\:5\\:3"]::before { width: 100px !important; }',
      )
    })

    it('set with ::after generates correct selector', () => {
      manager.set('Hero.tsx:5:3', 'content', '"hello"', '::after')
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('::after')
      expect(styleEl.textContent).toContain('content: "hello" !important')
    })

    it('element and pseudo overrides for same source produce separate rules', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      manager.set('Hero.tsx:5:3', 'width', '100px', '::before')
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      const text = styleEl.textContent!
      expect(text.split('\n').length).toBe(2) // two separate rules
      expect(text).toContain('color: red')
      expect(text).toContain('::before')
    })

    it('remove with pseudo only removes the pseudo override', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      manager.set('Hero.tsx:5:3', 'width', '100px', '::before')
      manager.flush()
      manager.remove('Hero.tsx:5:3', 'width', '::before')
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('color: red')
      expect(styleEl.textContent).not.toContain('::before')
    })

    it('remove without property clears all overrides for source+pseudo', () => {
      manager.set('Hero.tsx:5:3', 'width', '100px', '::before')
      manager.set('Hero.tsx:5:3', 'height', '50px', '::before')
      manager.flush()
      manager.remove('Hero.tsx:5:3', undefined, '::before')
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })
  })

  describe('HMR verified override clearing', () => {
    it('trackPendingEdit + handleHMRVerified(match=true) removes the override', () => {
      manager.set('Hero.tsx:5:3', 'padding', '24px')
      manager.trackPendingEdit('edit-1', 'Hero.tsx:5:3', 'padding', '24px')
      manager.handleHMRVerified('edit-1', true)
      manager.onHMRApplied()
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })

    it('handleHMRVerified with unknown editId is a no-op', () => {
      manager.set('Hero.tsx:5:3', 'padding', '24px')
      manager.handleHMRVerified('unknown-id', true)
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('padding')
    })

    it('clearAll also clears pending edits', () => {
      manager.set('Hero.tsx:5:3', 'padding', '24px')
      manager.trackPendingEdit('edit-1', 'Hero.tsx:5:3', 'padding', '24px')
      manager.clearAll()
      manager.handleHMRVerified('edit-1', true)
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })

    it('pseudo override cleared by handleHMRVerified with matching pseudo', () => {
      manager.set('Hero.tsx:5:3', 'width', '100px', '::before')
      manager.trackPendingEdit('edit-1', 'Hero.tsx:5:3', 'width', '100px', '::before')
      manager.handleHMRVerified('edit-1', true)
      manager.onHMRApplied()
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })

    it('pseudo verification does not remove element-level override', () => {
      manager.set('Hero.tsx:5:3', 'width', '200px')
      manager.set('Hero.tsx:5:3', 'width', '100px', '::before')
      manager.trackPendingEdit('edit-1', 'Hero.tsx:5:3', 'width', '100px', '::before')
      manager.handleHMRVerified('edit-1', true)
      manager.onHMRApplied()
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('width: 200px')
      expect(styleEl.textContent).not.toContain('::before')
    })

    it('element verification does not remove pseudo override', () => {
      manager.set('Hero.tsx:5:3', 'width', '200px')
      manager.set('Hero.tsx:5:3', 'width', '100px', '::before')
      manager.trackPendingEdit('edit-2', 'Hero.tsx:5:3', 'width', '200px')
      manager.handleHMRVerified('edit-2', true)
      manager.onHMRApplied()
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('::before')
      expect(styleEl.textContent).toContain('width: 100px')
    })

    it('trackPendingEdit supersedes prior entry for same source+property', () => {
      manager.set('a:1:1', 'color', 'red')
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      manager.trackPendingEdit('edit-2', 'a:1:1', 'color', 'red')
      manager.handleHMRVerified('edit-1', true)
      manager.onHMRApplied()
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('color')
      manager.handleHMRVerified('edit-2', true)
      manager.onHMRApplied()
      manager.flush()
      expect(styleEl.textContent).toBe('')
    })

    it('trackPendingEdit does not supersede different property', () => {
      manager.set('a:1:1', 'color', 'red')
      manager.set('a:1:1', 'margin', '0')
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      manager.trackPendingEdit('edit-2', 'a:1:1', 'margin', '0')
      manager.handleHMRVerified('edit-1', true)
      manager.handleHMRVerified('edit-2', true)
      manager.onHMRApplied()
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })

    it('trackPendingEdit supersedes with matching pseudo', () => {
      manager.set('a:1:1', 'width', '100px', '::before')
      manager.trackPendingEdit('edit-1', 'a:1:1', 'width', '100px', '::before')
      manager.trackPendingEdit('edit-2', 'a:1:1', 'width', '100px', '::before')
      manager.handleHMRVerified('edit-1', true)
      manager.onHMRApplied()
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('width')
    })

    it('trackPendingEdit does not supersede different pseudo', () => {
      manager.set('a:1:1', 'width', '100px')
      manager.set('a:1:1', 'width', '200px', '::before')
      manager.trackPendingEdit('edit-1', 'a:1:1', 'width', '100px')
      manager.trackPendingEdit('edit-2', 'a:1:1', 'width', '200px', '::before')
      manager.handleHMRVerified('edit-1', true)
      manager.handleHMRVerified('edit-2', true)
      manager.onHMRApplied()
      manager.flush()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })

    it('dispose clears pending edits', () => {
      manager.set('Hero.tsx:5:3', 'padding', '24px')
      manager.trackPendingEdit('edit-1', 'Hero.tsx:5:3', 'padding', '24px')
      manager.dispose()
      // After dispose, handleHMRVerified should be a no-op (not throw)
      expect(() => manager.handleHMRVerified('edit-1', true)).not.toThrow()
    })

    it('stale pending edits are evicted after TTL', () => {
      vi.useFakeTimers()
      try {
        manager.set('a:1:1', 'color', 'red')
        manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
        vi.advanceTimersByTime(36_000)
        // Trigger eviction via a new trackPendingEdit
        manager.trackPendingEdit('edit-2', 'a:1:1', 'margin', 'test-value')
        // edit-1 should have been evicted — handleHMRVerified is a no-op
        manager.handleHMRVerified('edit-1', true)
        const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
        expect(styleEl.textContent).toContain('color')
      } finally {
        vi.useRealTimers()
      }
    })

    it('pending edits within TTL survive eviction', () => {
      vi.useFakeTimers()
      try {
        manager.set('a:1:1', 'color', 'red')
        manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
        vi.advanceTimersByTime(20_000)
        // Trigger eviction — edit-1 is within TTL, should survive
        manager.trackPendingEdit('edit-2', 'a:1:1', 'margin', 'test-value')
        manager.handleHMRVerified('edit-1', true)
        manager.onHMRApplied()
        // Drain the double-rAF verification schedule — fake timers intercept RAF.
        vi.runAllTimers()
        manager.flush()
        const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
        expect(styleEl.textContent).not.toContain('color')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('get()', () => {
    it('returns current override value', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      expect(manager.get('Hero.tsx:5:3', 'color')).toBe('red')
    })

    it('returns undefined for non-existent override', () => {
      expect(manager.get('Hero.tsx:5:3', 'color')).toBeUndefined()
    })

    it('returns value for pseudo-element override', () => {
      manager.set('Hero.tsx:5:3', 'content', '"hello"', '::before')
      expect(manager.get('Hero.tsx:5:3', 'content', '::before')).toBe('"hello"')
      expect(manager.get('Hero.tsx:5:3', 'content')).toBeUndefined()
    })
  })

  describe('getOverrides()', () => {
    it('returns an empty Map for a source with no overrides', () => {
      expect(manager.getOverrides('Hero.tsx:5:3')).toEqual(new Map())
    })

    it('returns property values for the requested source', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      manager.set('Hero.tsx:5:3', 'font-size', '16px')
      manager.set('Nav.tsx:10:1', 'margin', '0')

      expect(manager.getOverrides('Hero.tsx:5:3')).toEqual(new Map([
        ['color', 'red'],
        ['font-size', '16px'],
      ]))
    })

    it('reflects removing one property from a source', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      manager.set('Hero.tsx:5:3', 'font-size', '16px')

      manager.remove('Hero.tsx:5:3', 'color')

      expect(manager.getOverrides('Hero.tsx:5:3')).toEqual(new Map([
        ['font-size', '16px'],
      ]))
    })

    it('reflects removing all properties for a source', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      manager.set('Hero.tsx:5:3', 'font-size', '16px')

      manager.remove('Hero.tsx:5:3')

      expect(manager.getOverrides('Hero.tsx:5:3')).toEqual(new Map())
    })

    it('keeps element and pseudo-element overrides independent', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      manager.set('Hero.tsx:5:3', 'content', '"hello"', '::before')

      expect(manager.getOverrides('Hero.tsx:5:3')).toEqual(new Map([
        ['color', 'red'],
      ]))
      expect(manager.getOverrides('Hero.tsx:5:3', '::before')).toEqual(new Map([
        ['content', '"hello"'],
      ]))
      expect(manager.getOverrides('Hero.tsx:5:3', '::after')).toEqual(new Map())
    })

    it('returns a defensive copy that caller mutations cannot write through', () => {
      manager.set('Hero.tsx:5:3', 'color', 'red')
      const snapshot = manager.getOverrides('Hero.tsx:5:3')

      snapshot.set('margin', '0')
      snapshot.delete('color')

      expect(manager.getOverrides('Hero.tsx:5:3')).toEqual(new Map([
        ['color', 'red'],
      ]))
    })

    it('does not include state overrides', () => {
      manager.setStateOverrides('Hero.tsx:5:3', new Map([['background', 'blue']]))
      manager.set('Hero.tsx:5:3', 'color', 'red')

      expect(manager.getOverrides('Hero.tsx:5:3')).toEqual(new Map([
        ['color', 'red'],
      ]))
    })

    it('returns an empty Map for a source with only state overrides', () => {
      manager.setStateOverrides('Hero.tsx:5:3', new Map([['background', 'blue']]))

      expect(manager.getOverrides('Hero.tsx:5:3')).toEqual(new Map())
    })

    it('does not leak raw-source state overrides into pseudo-element reads', () => {
      manager.setStateOverrides('Hero.tsx:5:3', new Map([['background', 'blue']]))

      expect(manager.getOverrides('Hero.tsx:5:3', '::before')).toEqual(new Map())
    })
  })

  describe('verified override removal', () => {
    let rafCallbacks: Map<number, FrameRequestCallback>
    let nextId: number

    beforeEach(() => {
      rafCallbacks = new Map()
      nextId = 1
      // Capture RAF calls instead of executing them synchronously so each test
      // can advance the double-rAF schedule step-by-step.
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        const id = nextId++
        rafCallbacks.set(id, cb)
        return id
      }) as typeof requestAnimationFrame
      window.cancelAnimationFrame = ((id: number) => {
        rafCallbacks.delete(id)
      }) as typeof cancelAnimationFrame
    })

    function flushRAF() {
      const cbs = Array.from(rafCallbacks.values())
      rafCallbacks.clear()
      cbs.forEach(cb => cb(performance.now()))
    }

    // Call-order invariance: whether vite:afterUpdate lands before or after the
    // server's hmr_verified signal, the final state is the same — override is
    // removed after the double-rAF verification tick. Pre-refactor these took
    // different code paths via an in-cycle flag; post-refactor handleHMRVerified
    // always schedules via double-rAF so ordering is behaviorally equivalent.
    // Parameterized to prevent regression to an order-sensitive lifecycle.
    it.each([
      ['hmr_verified → onHMRApplied', (m: CSSOverrideManager) => {
        m.handleHMRVerified('edit-1', true, 'jsx-immediate')
        m.onHMRApplied()
      }],
      ['onHMRApplied → hmr_verified (late arrival)', (m: CSSOverrideManager) => {
        m.onHMRApplied()
        m.handleHMRVerified('edit-1', true, 'jsx-immediate')
      }],
    ])('ordering — %s: override removed after double-rAF', (_label, sequence) => {
      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'a:1:1')
      target.style.color = 'red'
      document.body.appendChild(target)

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      sequence(manager)

      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('color: red') // double-rAF pending

      flushRAF()
      flushRAF()
      expect(styleEl.textContent).toBe('')

      target.remove()
    })

    it('ZF0-1235: keeps override and emits divergence when inline never matches within retry window', async () => {
      // Simulates the observed failure mode: source verified by server but the
      // element's inline style stays at the OLD value (e.g., React Fast Refresh
      // skipped this component). After the retry window elapses without a match,
      // the override is preserved and a divergence event fires — no silent revert.
      // Shrink the retry window so the test is fast + deterministic.
      const originalWindow = CSSOverrideManager.VERIFY_RETRY_WINDOW_MS
      const originalPoll = CSSOverrideManager.VERIFY_POLL_INTERVAL_MS
      CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = 60
      CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = 20
      try {
        const { onDivergence } = await import('../../src/browser/override-bus.js')
        const divergences: Array<import('../../src/browser/override-bus.js').OverrideDivergence> = []
        const unsub = onDivergence(d => divergences.push(d))

        const target = document.createElement('div')
        target.setAttribute('data-cortex-source', 'a:1:1')
        target.style.color = 'green'
        document.body.appendChild(target)

        manager.set('a:1:1', 'color', 'red')
        flushRAF()
        manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
        manager.handleHMRVerified('edit-1', true, 'jsx-immediate')
        manager.onHMRApplied()

        flushRAF()
        flushRAF() // double-rAF — first verify fails, retry observer arms

        const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
        expect(styleEl.textContent).toContain('color: red')
        expect(divergences).toHaveLength(0) // not emitted yet — retry window active

        // Wait for the shrunk retry window to elapse, then flush the rAF-aligned
        // final verify (MTS-C2 fix: the final timeout schedules a rAF to read
        // post-layout before emitting divergence).
        await new Promise(resolve => setTimeout(resolve, 100))
        flushRAF()

        expect(styleEl.textContent).toContain('color: red') // still preserved
        expect(divergences).toHaveLength(1)
        expect(divergences[0]).toMatchObject({ source: 'a:1:1', property: 'color', expected: 'red', actual: 'green' })

        // ZF0-1293: divergence payload carries diagnostics — exercises the
        // retry-timeout emit path's enrichment. Without these, a mystery
        // divergence (like ZF0-1293's padding-bottom 30px) cannot distinguish
        // "inline style was stale" from "computed style was wrong".
        expect(divergences[0].diagnostics).toBeDefined()
        expect(divergences[0].diagnostics?.actualReadFrom).toBe('inline-style')
        expect(divergences[0].diagnostics?.kindUsed).toBe('jsx-immediate')
        expect(divergences[0].diagnostics?.priorValues).toEqual(['red'])
        // retryDurationMs should be >= the shrunk window (60ms) but well below
        // a generous upper bound (1s) to prove the arm-to-emit duration was
        // actually measured, not hardcoded.
        expect(divergences[0].diagnostics?.retryDurationMs).toBeGreaterThanOrEqual(50)
        expect(divergences[0].diagnostics?.retryDurationMs).toBeLessThan(1000)

        unsub()
        target.remove()
      } finally {
        CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = originalWindow
        CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = originalPoll
      }
    })

    it('ZF0-1293: prior-values ring buffer records last 5 set() values per key', async () => {
      // Core diagnostic for the 16px-expected/30px-actual mystery: if the user
      // previously scrubbed to 30px earlier in the session, the ring buffer
      // preserves that history so a future divergence card can show "you set
      // this to 30px earlier — the retry read an inline style that's still 30px".
      const originalWindow = CSSOverrideManager.VERIFY_RETRY_WINDOW_MS
      const originalPoll = CSSOverrideManager.VERIFY_POLL_INTERVAL_MS
      CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = 60
      CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = 20
      try {
        const { onDivergence } = await import('../../src/browser/override-bus.js')
        const divergences: Array<import('../../src/browser/override-bus.js').OverrideDivergence> = []
        const unsub = onDivergence(d => divergences.push(d))

        const target = document.createElement('div')
        target.setAttribute('data-cortex-source', 'App.tsx:13:5')
        // Simulate a DOM that still reports 30px from a prior session edit.
        target.style.setProperty('padding-bottom', '30px')
        document.body.appendChild(target)

        // Earlier in the session the user scrubbed through several values.
        manager.set('App.tsx:13:5', 'padding-bottom', '24px')
        manager.set('App.tsx:13:5', 'padding-bottom', '30px')
        manager.set('App.tsx:13:5', 'padding-bottom', '20px')
        manager.set('App.tsx:13:5', 'padding-bottom', '18px')
        manager.set('App.tsx:13:5', 'padding-bottom', '16px') // final value
        flushRAF()
        manager.trackPendingEdit('edit-final', 'App.tsx:13:5', 'padding-bottom', '16px')
        manager.handleHMRVerified('edit-final', true, 'jsx-immediate')
        manager.onHMRApplied()
        flushRAF()
        flushRAF()

        await new Promise(r => setTimeout(r, 100))
        flushRAF()

        expect(divergences).toHaveLength(1)
        const d = divergences[0]
        expect(d.actual).toBe('30px')
        expect(d.expected).toBe('16px')
        expect(d.diagnostics?.actualReadFrom).toBe('inline-style')
        // Ring buffer is capped at 5 — all five sets survive in FIFO order.
        expect(d.diagnostics?.priorValues).toEqual(['24px', '30px', '20px', '18px', '16px'])

        unsub()
        target.remove()
      } finally {
        CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = originalWindow
        CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = originalPoll
      }
    })

    it('ZF0-1293: prior-values ring buffer drops oldest when capacity exceeded', async () => {
      // Regression test for the bound: a long scrub gesture can emit many
      // set() calls. The buffer must not grow unbounded.
      const originalWindow = CSSOverrideManager.VERIFY_RETRY_WINDOW_MS
      const originalPoll = CSSOverrideManager.VERIFY_POLL_INTERVAL_MS
      CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = 60
      CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = 20
      try {
        const { onDivergence } = await import('../../src/browser/override-bus.js')
        const divergences: Array<import('../../src/browser/override-bus.js').OverrideDivergence> = []
        const unsub = onDivergence(d => divergences.push(d))

        const target = document.createElement('div')
        target.setAttribute('data-cortex-source', 'a:1:1')
        target.style.color = 'hotpink' // DOM value will never match
        document.body.appendChild(target)

        // Eight set() calls — only the last five must survive.
        for (const v of ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet', 'black']) {
          manager.set('a:1:1', 'color', v)
        }
        flushRAF()
        manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'black')
        manager.handleHMRVerified('edit-1', true, 'jsx-immediate')
        manager.onHMRApplied()
        flushRAF()
        flushRAF()
        await new Promise(r => setTimeout(r, 100))
        flushRAF()

        expect(divergences).toHaveLength(1)
        // Chronological order: oldest kept at index 0, most recent at last.
        // `toEqual` with an ordered array literal asserts both contents AND
        // direction — a LIFO reversal would produce the reversed array and
        // fail this assertion. No redundant positional assertions needed.
        expect(divergences[0]!.diagnostics.priorValues).toEqual(['green', 'blue', 'indigo', 'violet', 'black'])

        unsub()
        target.remove()
      } finally {
        CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = originalWindow
        CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = originalPoll
      }
    })

    it('ZF0-1293: emitted diagnostics.priorValues is an immutable snapshot (no retroactive mutation)', async () => {
      // Copilot PR #74 review finding: getPriorValues() previously returned
      // the same live array stored in this.priorValues. Because recordPriorValue
      // mutates that array in place (push/shift), later set() calls would
      // retroactively change the priorValues field in already-emitted
      // divergences — and any UI derived from them. This test captures a
      // divergence, fires more set() calls after emission, and asserts the
      // captured priorValues array is unaffected.
      const originalWindow = CSSOverrideManager.VERIFY_RETRY_WINDOW_MS
      const originalPoll = CSSOverrideManager.VERIFY_POLL_INTERVAL_MS
      CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = 60
      CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = 20
      try {
        const { onDivergence } = await import('../../src/browser/override-bus.js')
        const divergences: Array<import('../../src/browser/override-bus.js').OverrideDivergence> = []
        const unsub = onDivergence(d => divergences.push(d))

        const target = document.createElement('div')
        target.setAttribute('data-cortex-source', 'a:1:1')
        target.style.color = 'hotpink'
        document.body.appendChild(target)

        // Scrub through a few values → divergence captures priorValues=['red', 'orange', 'yellow']
        for (const v of ['red', 'orange', 'yellow']) manager.set('a:1:1', 'color', v)
        flushRAF()
        manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'yellow')
        manager.handleHMRVerified('edit-1', true, 'jsx-immediate')
        manager.onHMRApplied()
        flushRAF()
        flushRAF()
        await new Promise(r => setTimeout(r, 100))
        flushRAF()

        expect(divergences).toHaveLength(1)
        const capturedBefore = [...divergences[0]!.diagnostics.priorValues]
        expect(capturedBefore).toEqual(['red', 'orange', 'yellow'])

        // Fire more set() calls AFTER the divergence was emitted. If
        // priorValues was a live reference, these pushes would mutate the
        // array the divergence payload holds — and `diagnostics.priorValues`
        // would silently grow.
        manager.set('a:1:1', 'color', 'green')
        manager.set('a:1:1', 'color', 'blue')
        manager.set('a:1:1', 'color', 'indigo')
        manager.set('a:1:1', 'color', 'violet')  // now 7 total values, would overflow the cap AND retroactively mutate

        // The previously-captured array must be exactly what it was at emission.
        expect(divergences[0]!.diagnostics.priorValues).toEqual(capturedBefore)
        expect(divergences[0]!.diagnostics.priorValues).toEqual(['red', 'orange', 'yellow'])

        unsub()
        target.remove()
      } finally {
        CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = originalWindow
        CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = originalPoll
      }
    })

    it('ZF0-1293: server-mismatch emits divergence with server-mismatch readFrom, no retry duration', async () => {
      // handleHMRVerified(match=false) path: server refused the edit. No DOM
      // read happens, so actualReadFrom must be 'server-mismatch' and
      // retryDurationMs must be undefined. This lets the Panel's Debug
      // disclosure distinguish "server said no" from "DOM read stale".
      const { onDivergence } = await import('../../src/browser/override-bus.js')
      const divergences: Array<import('../../src/browser/override-bus.js').OverrideDivergence> = []
      const unsub = onDivergence(d => divergences.push(d))

      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'a:1:1')
      document.body.appendChild(target)

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      manager.handleHMRVerified('edit-1', false, 'jsx-immediate') // server said no

      expect(divergences).toHaveLength(1)
      expect(divergences[0].actual).toBe('')
      expect(divergences[0].diagnostics?.actualReadFrom).toBe('server-mismatch')
      expect(divergences[0].diagnostics?.kindUsed).toBe('jsx-immediate')
      expect(divergences[0].diagnostics?.retryDurationMs).toBeUndefined()
      expect(divergences[0].diagnostics?.priorValues).toEqual(['red'])

      unsub()
      target.remove()
    })

    it('ZF0-1293: remove() clears prior-values for the key so later episodes start fresh', async () => {
      // Without this clear, a successfully-verified-and-removed edit leaves
      // its priorValues in the buffer. A later unrelated edit on the same
      // key would surface those historical values on its divergence card,
      // misleading the developer into chasing a value that was long since
      // resolved.
      const originalWindow = CSSOverrideManager.VERIFY_RETRY_WINDOW_MS
      const originalPoll = CSSOverrideManager.VERIFY_POLL_INTERVAL_MS
      CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = 60
      CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = 20
      try {
        const { onDivergence } = await import('../../src/browser/override-bus.js')
        const divergences: Array<import('../../src/browser/override-bus.js').OverrideDivergence> = []
        const unsub = onDivergence(d => divergences.push(d))

        const target = document.createElement('div')
        target.setAttribute('data-cortex-source', 'a:1:1')
        document.body.appendChild(target)

        // Episode 1 — resolved cleanly.
        manager.set('a:1:1', 'color', 'red')
        manager.remove('a:1:1', 'color')
        // Episode 2 — starts fresh. Only "blue" should appear in priorValues.
        target.style.color = 'hotpink'
        manager.set('a:1:1', 'color', 'blue')
        flushRAF()
        manager.trackPendingEdit('edit-2', 'a:1:1', 'color', 'blue')
        manager.handleHMRVerified('edit-2', true, 'jsx-immediate')
        manager.onHMRApplied()
        flushRAF()
        flushRAF()
        await new Promise(r => setTimeout(r, 100))
        flushRAF()

        expect(divergences).toHaveLength(1)
        // "red" from the resolved prior episode MUST NOT appear.
        expect(divergences[0].diagnostics?.priorValues).toEqual(['blue'])

        unsub()
        target.remove()
      } finally {
        CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = originalWindow
        CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = originalPoll
      }
    })

    it('ZF0-1293: retry-error path includes errorMessage and distinguishes from stale-value divergence', async () => {
      // The retry-error catch path fires when the verifier's read throws.
      // Without errorMessage, the resulting card looks identical to a
      // "Fast Refresh was slow" divergence — but the user needs to know
      // the verifier itself failed, not the framework.
      const originalWindow = CSSOverrideManager.VERIFY_RETRY_WINDOW_MS
      const originalPoll = CSSOverrideManager.VERIFY_POLL_INTERVAL_MS
      CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = 60
      CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = 20
      try {
        const { onDivergence } = await import('../../src/browser/override-bus.js')
        const divergences: Array<import('../../src/browser/override-bus.js').OverrideDivergence> = []
        const unsub = onDivergence(d => divergences.push(d))

        const target = document.createElement('div')
        target.setAttribute('data-cortex-source', 'a:1:1')
        document.body.appendChild(target)

        // The outer tryVerify catch (inside armVerifyRetry) fires only when
        // something throws OUTSIDE `readUnderlyingValue`'s own catch. Force
        // it by making `valuesMatch` throw ONLY on retry calls, not on the
        // first-pass call from `verifyAndRemove` (which runs before
        // armVerifyRetry and would propagate uncaught if it threw).
        const origConsoleWarn = console.warn
        console.warn = () => {}
        const origValuesMatch = (CSSOverrideManager.prototype as unknown as { valuesMatch: (...a: unknown[]) => boolean }).valuesMatch
        let valuesMatchCalls = 0
        ;(CSSOverrideManager.prototype as unknown as { valuesMatch: () => boolean }).valuesMatch = function () {
          valuesMatchCalls++
          if (valuesMatchCalls === 1) {
            // First-pass call from verifyAndRemove — return false so retry arms.
            return false
          }
          throw new TypeError('simulated CSSOM failure')
        }

        try {
          manager.set('a:1:1', 'color', 'red')
          flushRAF()
          manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
          manager.handleHMRVerified('edit-1', true, 'jsx-immediate')
          manager.onHMRApplied()
          flushRAF()
          flushRAF()
          await new Promise(r => setTimeout(r, 100))
          flushRAF()
        } finally {
          ;(CSSOverrideManager.prototype as unknown as { valuesMatch: (...a: unknown[]) => boolean }).valuesMatch = origValuesMatch
          console.warn = origConsoleWarn
        }

        // Exactly one divergence from the catch path — any other count means
        // the monkey-patch didn't hit the expected code path (e.g., refactor
        // inlined `valuesMatch` or bypassed the method call). `toBeGreaterThanOrEqual`
        // would silently tolerate that failure mode.
        expect(divergences).toHaveLength(1)
        // Proves the monkey-patch was actually exercised — first call from
        // verifyAndRemove plus at least one retry call that threw. If a
        // refactor ever inlines `valuesMatch` and the prototype patch stops
        // being reached, this counter stays at 0 and the test fails loudly
        // instead of silently passing on a leaked divergence from a prior test.
        expect(valuesMatchCalls).toBeGreaterThanOrEqual(2)
        expect(divergences[0]!.diagnostics.errorMessage).toContain('simulated CSSOM failure')
        // Actual is empty — the read was aborted, so there's no value to report.
        expect(divergences[0]!.actual).toBe('')

        unsub()
        target.remove()
      } finally {
        CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = originalWindow
        CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = originalPoll
      }
    })

    it('ZF0-1293: computed-style read (non-jsx kind) is tagged as computed-style', async () => {
      // Disambiguation: when kind is classOp/deferred, readUnderlyingValue
      // detaches the override <style> and uses getComputedStyle. The
      // actualReadFrom tag must reflect that path.
      const originalWindow = CSSOverrideManager.VERIFY_RETRY_WINDOW_MS
      const originalPoll = CSSOverrideManager.VERIFY_POLL_INTERVAL_MS
      CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = 60
      CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = 20
      try {
        const { onDivergence } = await import('../../src/browser/override-bus.js')
        const divergences: Array<import('../../src/browser/override-bus.js').OverrideDivergence> = []
        const unsub = onDivergence(d => divergences.push(d))

        const target = document.createElement('div')
        target.setAttribute('data-cortex-source', 'a:1:1')
        document.body.appendChild(target)

        // Mock getComputedStyle to return a mismatching value regardless of
        // DOM state — proves the computed-style path was taken. Also records
        // whether the override <style> was detached at the moment of call —
        // that detach is the real purpose of the computed-style branch, and
        // a regression that skipped it would produce wrong values in prod.
        let styleDetachedAtReadTime = false
        const origCS = window.getComputedStyle
        window.getComputedStyle = ((el: Element, ps?: string | null) => {
          if (el === target) {
            if (document.head.querySelector('[data-cortex-override]') === null) {
              styleDetachedAtReadTime = true
            }
            return { getPropertyValue: (_prop: string) => 'purple' } as CSSStyleDeclaration
          }
          return origCS.call(window, el, ps)
        }) as typeof window.getComputedStyle

        try {
          manager.set('a:1:1', 'color', 'red')
          flushRAF()
          manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
          manager.handleHMRVerified('edit-1', true, 'immediate') // classOp kind → computed-style path
          manager.onHMRApplied()
          flushRAF()
          flushRAF()
          await new Promise(r => setTimeout(r, 100))
          flushRAF()
        } finally {
          window.getComputedStyle = origCS
        }

        expect(divergences).toHaveLength(1)
        expect(divergences[0].diagnostics?.actualReadFrom).toBe('computed-style')
        expect(divergences[0].diagnostics?.kindUsed).toBe('immediate')
        expect(divergences[0].actual).toBe('purple')
        // The detach-before-read is the whole point of the computed-style branch:
        // without it, `getComputedStyle` would pick up the override `!important`
        // rule and the override could never be removed.
        expect(styleDetachedAtReadTime).toBe(true)

        unsub()
        target.remove()
      } finally {
        CSSOverrideManager.VERIFY_RETRY_WINDOW_MS = originalWindow
        CSSOverrideManager.VERIFY_POLL_INTERVAL_MS = originalPoll
      }
    })

    it('ZF0-1235 happy case: retry mutation observer catches slow React and cleanly removes', async () => {
      // React Fast Refresh is sometimes delayed — the retry observer re-verifies
      // when the element's style attribute finally changes. If the new inline
      // style matches expected, the override is removed cleanly (no divergence).
      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'a:1:1')
      target.style.color = 'green' // old value — React hasn't caught up yet
      document.body.appendChild(target)

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      manager.handleHMRVerified('edit-1', true, 'jsx-immediate')
      manager.onHMRApplied()

      flushRAF()
      flushRAF() // first verify fails → retry armed

      // Simulate React catching up and committing the new inline style.
      target.style.color = 'red'

      await new Promise(resolve => setTimeout(resolve, 20))

      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('') // override removed cleanly

      target.remove()
    })

    it('superseded edit: newer override is preserved when older verified edit arrives', () => {
      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'a:1:1')
      document.body.appendChild(target)

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')

      // User edits again before the first verify completes.
      manager.set('a:1:1', 'color', 'blue')
      flushRAF()
      manager.trackPendingEdit('edit-2', 'a:1:1', 'color', 'blue')

      // Older edit's verified signal — should be filtered out by the stale guard.
      manager.handleHMRVerified('edit-1', true, 'jsx-immediate')
      manager.onHMRApplied()
      flushRAF()
      flushRAF()

      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('color: blue')

      target.remove()
    })

    it('non-jsx kind detaches the override <style> before reading computed value', () => {
      // The detach is the whole point of non-jsx verification: without it,
      // `getComputedStyle` would keep reporting the override value and the
      // override would never be removable. This test proves the detach happened
      // by observing the DOM state mid-call — if production skipped the detach
      // or forgot to reattach, the assertions below fail.
      const target = document.createElement('div')
      target.setAttribute('data-cortex-source', 'a:1:1')
      document.body.appendChild(target)

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')

      let overrideStyleDetachedDuringCall = false
      const original = window.getComputedStyle
      window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
        if (element === target) {
          // The override <style> must be out of the DOM right now — that's the
          // mechanism under test. Record the observation for a post-assertion.
          const overrideStyle = document.head.querySelector('[data-cortex-override]')
          overrideStyleDetachedDuringCall = overrideStyle === null
          return { getPropertyValue: (prop: string) => prop === 'color' ? 'red' : '' } as CSSStyleDeclaration
        }
        return original.call(window, element, pseudo)
      }) as typeof window.getComputedStyle

      manager.handleHMRVerified('edit-1', true, 'immediate') // classOp kind
      manager.onHMRApplied()
      flushRAF()
      flushRAF()
      window.getComputedStyle = original

      expect(overrideStyleDetachedDuringCall).toBe(true) // detach actually happened
      // Reattach must also have succeeded — the <style> is back in document.head.
      expect(document.head.querySelector('[data-cortex-override]')).not.toBeNull()

      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')

      target.remove()
    })

    it('non-matching verify — element gone — removes override (nothing to preview)', () => {
      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      manager.handleHMRVerified('edit-1', true, 'jsx-immediate')
      manager.onHMRApplied()
      flushRAF()
      flushRAF() // element never existed — verify drops override

      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })

    it('pendingClearAll takes precedence over pending verifications', () => {
      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      manager.handleHMRVerified('edit-1', true, 'jsx-immediate')
      manager.queueClearAll()

      manager.onHMRApplied()
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toBe('')
    })

    it('emits divergence when server reports match=false (ZF0-1126 precursor)', async () => {
      // The server's HMR verifier sends match=false on TTL eviction — "the
      // file was written but no HMR landed within 30s." Without surfacing this
      // the user would see a stale preview with no error signal.
      const { onDivergence } = await import('../../src/browser/override-bus.js')
      const divergences: Array<{ source: string; property: string }> = []
      const unsub = onDivergence(d => divergences.push({ source: d.source, property: d.property }))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      manager.handleHMRVerified('edit-1', false, 'jsx-immediate')

      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('color: red') // override preserved
      expect(divergences).toHaveLength(1)
      expect(divergences[0]).toMatchObject({ source: 'a:1:1', property: 'color' })

      unsub()
    })

    it.skip('canonicalizes CSS values before declaring divergence (hex vs rgb)', () => {
      // TODO: requires real CSSOM. happy-dom's getComputedStyle does not reliably
      // canonicalize color formats (`#ffffff` → `rgb(255, 255, 255)`), so this
      // test would silently pass via valuesMatch's trivial string-equality fast
      // path rather than exercising canonicalizeCssValue. Real coverage lives in
      // a Playwright e2e spec against a live dev server where the browser's CSS
      // engine actually canonicalizes.
    })

  describe('stale-detection API (ZF0-1467)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    // Helper: make RAF capture (not immediate) so timing-sensitive tests control flush.
    // The outer beforeEach sets RAF to synchronous — this describe overrides it.
    let rafCallbacks: Map<number, FrameRequestCallback>
    let nextId: number
    beforeEach(() => {
      rafCallbacks = new Map()
      nextId = 1
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        const id = nextId++
        rafCallbacks.set(id, cb)
        return id
      }) as typeof requestAnimationFrame
      window.cancelAnimationFrame = ((id: number) => {
        rafCallbacks.delete(id)
      }) as typeof cancelAnimationFrame
    })

    function flushRAF() {
      const cbs = Array.from(rafCallbacks.values())
      rafCallbacks.clear()
      cbs.forEach(cb => cb(performance.now()))
    }

    // #11: Override + hmr_verified arrives within TTL → no stale signal fires
    it('#11: hmr_verified within TTL does not fire stale listener', () => {
      const staleSets: Array<Set<string>> = []
      const unsub = manager.onStale(s => staleSets.push(new Set(s)))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')

      // Advance time less than the TTL (35s)
      vi.advanceTimersByTime(20_000)

      // Verify arrives within TTL
      manager.handleHMRVerified('edit-1', true)
      manager.onHMRApplied()
      flushRAF()
      flushRAF()

      expect(staleSets).toHaveLength(0)
      unsub()
    })

    // #12: Override applied + TTL elapses without hmr_verified → stale signal fires
    it('#12: TTL elapses without hmr_verified → stale listener fires with source', () => {
      const staleSets: Array<Set<string>> = []
      const unsub = manager.onStale(s => staleSets.push(new Set(s)))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')

      // Advance past TTL (35s) and trigger eviction via a new trackPendingEdit
      vi.advanceTimersByTime(36_000)
      manager.trackPendingEdit('edit-2', 'b:1:1', 'margin', '0')

      expect(staleSets).toHaveLength(1)
      expect(staleSets[0]).toEqual(new Set(['a:1:1']))

      unsub()
    })

    // #14: Multiple stale overrides → aggregate count (Set size > 1)
    it('#14: multiple stale overrides aggregate into one Set', () => {
      const staleSets: Array<Set<string>> = []
      const unsub = manager.onStale(s => staleSets.push(new Set(s)))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')

      manager.set('b:2:2', 'margin', '0')
      flushRAF()
      manager.trackPendingEdit('edit-2', 'b:2:2', 'margin', '0')

      vi.advanceTimersByTime(36_000)
      // Trigger eviction by calling trackPendingEdit for a new, unrelated edit
      manager.trackPendingEdit('edit-3', 'c:3:3', 'padding', '0')

      // Both sources should be stale
      const lastSet = staleSets[staleSets.length - 1]
      expect(lastSet).toEqual(new Set(['a:1:1', 'b:2:2']))

      unsub()
    })

    // Listener registration + dispose works (no leak)
    it('listener dispose prevents future calls', () => {
      const calls: number[] = []
      const unsub = manager.onStale(() => calls.push(1))

      unsub() // dispose immediately

      // Trigger a stale event — listener should NOT be called
      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      vi.advanceTimersByTime(36_000)
      manager.trackPendingEdit('edit-2', 'b:1:1', 'margin', '0')

      expect(calls).toHaveLength(0)
    })

    // Multiple listeners ALL fire on same event
    it('multiple listeners all fire on the same stale event', () => {
      const calls1: number[] = []
      const calls2: number[] = []
      const unsub1 = manager.onStale(() => calls1.push(1))
      const unsub2 = manager.onStale(() => calls2.push(1))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      vi.advanceTimersByTime(36_000)
      manager.trackPendingEdit('edit-2', 'b:1:1', 'margin', '0')

      expect(calls1).toHaveLength(1)
      expect(calls2).toHaveLength(1)

      unsub1()
      unsub2()
    })

    // Listener error isolation: a throwing listener must not block subsequent listeners
    // or corrupt the call path (e.g. rebuild still happens after remove())
    it('throwing listener does not block subsequent listeners or corrupt remove() path', () => {
      const secondListenerSets: Array<Set<string>> = []

      // First listener always throws
      const unsub1 = manager.onStale(() => { throw new Error('boom') })
      // Second listener captures the set — must still receive the call
      const unsub2 = manager.onStale(s => secondListenerSets.push(new Set(s)))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      vi.advanceTimersByTime(36_000)
      // Trigger eviction — emitStale fires inside evictStalePendingEdits → trackPendingEdit
      manager.trackPendingEdit('edit-2', 'b:1:1', 'margin', '0')

      // Second listener must have received the stale event despite first throwing
      expect(secondListenerSets).toHaveLength(1)
      expect(secondListenerSets[0]).toEqual(new Set(['a:1:1']))

      // Call path must be uncorrupted: remove() should still rebuild the style sheet
      manager.remove('a:1:1', 'color')
      flushRAF()
      // If emitStale threw through remove(), the rebuild would not run — textContent would be stale.
      // After removing 'a:1:1' color override, the sheet must not contain that rule.
      // The selector is serialized with CSS.escape, so the escaped form is 'a\:1\:1' (one backslash
      // before each colon). Asserting the unescaped literal 'a:1:1' is unfalsifiable because the
      // stylesheet text never contains the bare colon form — even when the rule is still present.
      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).not.toContain('a\\:1\\:1')

      unsub1()
      unsub2()
    })

    // Per-listener defensive copy: mutation by listener A must not affect listener B's set
    it('per-listener defensive copy — mutation by first listener does not affect second', () => {
      const secondListenerSets: Array<Set<string>> = []

      // First listener mutates its received set aggressively
      const unsub1 = manager.onStale(s => { s.add('hostile'); s.clear() })
      // Second listener captures its set
      const unsub2 = manager.onStale(s => secondListenerSets.push(new Set(s)))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      vi.advanceTimersByTime(36_000)
      manager.trackPendingEdit('edit-2', 'b:1:1', 'margin', '0')

      // Second listener must see the unmutated snapshot
      expect(secondListenerSets).toHaveLength(1)
      expect(secondListenerSets[0]).toEqual(new Set(['a:1:1']))

      // Internal state must also be unmutated
      expect(manager.getStaleSources()).toEqual(new Set(['a:1:1']))

      unsub1()
      unsub2()
    })

    // getStaleSources returns defensive copy
    it('getStaleSources returns defensive copy — caller mutation does not affect internal state', () => {
      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      vi.advanceTimersByTime(36_000)
      manager.trackPendingEdit('edit-2', 'b:1:1', 'margin', '0')

      const snapshot = manager.getStaleSources()
      expect(snapshot).toEqual(new Set(['a:1:1']))

      // Mutate the returned Set — internal state must be unaffected
      snapshot.add('injected-source')
      snapshot.delete('a:1:1')

      expect(manager.getStaleSources()).toEqual(new Set(['a:1:1']))
    })

    // getStaleSources is empty when no stale state
    it('getStaleSources is empty before any stale state', () => {
      expect(manager.getStaleSources()).toEqual(new Set())
    })

    // Stale set clears when corresponding override clears via remove()
    it('stale source removed from set when override cleared via remove()', () => {
      const staleSets: Array<Set<string>> = []
      const unsub = manager.onStale(s => staleSets.push(new Set(s)))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      vi.advanceTimersByTime(36_000)
      manager.trackPendingEdit('edit-2', 'b:1:1', 'margin', '0')

      expect(staleSets).toHaveLength(1)
      expect(staleSets[0]).toEqual(new Set(['a:1:1']))

      // Now clear the override — stale source should be removed
      manager.remove('a:1:1', 'color')

      expect(staleSets).toHaveLength(2)
      expect(staleSets[1]).toEqual(new Set())
      expect(manager.getStaleSources()).toEqual(new Set())

      unsub()
    })

    // Stale set clears when handleHMRVerified(match=true) fires for a stale source
    it('stale source cleared when handleHMRVerified(match=true) fires for stale source', () => {
      const staleSets: Array<Set<string>> = []
      const unsub = manager.onStale(s => staleSets.push(new Set(s)))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      vi.advanceTimersByTime(36_000)
      // Trigger first eviction — 'a:1:1' becomes stale
      manager.trackPendingEdit('edit-2', 'b:1:1', 'margin', '0')

      expect(staleSets).toHaveLength(1)
      expect(staleSets[0]).toEqual(new Set(['a:1:1']))

      // A late hmr_verified for edit-1 arrives (after eviction, so pendingEdits no longer has it)
      // Track a new pending edit for the stale source then verify it
      manager.trackPendingEdit('edit-3', 'a:1:1', 'color', 'red')
      manager.handleHMRVerified('edit-3', true)
      manager.onHMRApplied()
      flushRAF()
      flushRAF()

      // Source 'a:1:1' was stale; hmr_verified(match=true) should clear it
      expect(manager.getStaleSources()).toEqual(new Set())
      expect(staleSets).toHaveLength(2)
      expect(staleSets[1]).toEqual(new Set())

      unsub()
    })

    // Stale set fully clears on clearAll()
    it('stale set fully clears on clearAll()', () => {
      const staleSets: Array<Set<string>> = []
      const unsub = manager.onStale(s => staleSets.push(new Set(s)))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      vi.advanceTimersByTime(36_000)
      manager.trackPendingEdit('edit-2', 'b:1:1', 'margin', '0')

      expect(staleSets).toHaveLength(1)

      manager.clearAll()

      expect(staleSets).toHaveLength(2)
      expect(staleSets[1]).toEqual(new Set())
      expect(manager.getStaleSources()).toEqual(new Set())

      unsub()
    })

    // Stale set fully clears on dispose() and listeners are actually removed
    it('stale set fully clears on dispose() and listeners are removed', () => {
      const receivedSets: Array<Set<string>> = []
      const unsub = manager.onStale(s => receivedSets.push(new Set(s)))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      vi.advanceTimersByTime(36_000)
      manager.trackPendingEdit('edit-2', 'b:1:1', 'margin', '0')

      // First emission: stale eviction fired
      expect(receivedSets).toHaveLength(1)
      expect(receivedSets[0]).toEqual(new Set(['a:1:1']))

      manager.dispose()

      // dispose() fires a final clear emission, then removes all listeners
      expect(receivedSets).toHaveLength(2)
      expect(receivedSets[1]).toEqual(new Set())
      expect(manager.getStaleSources()).toEqual(new Set())

      // Falsifiable: assert the internal staleListeners Set was actually cleared.
      // A regression that forgot `this.staleListeners.clear()` would leave size > 0.
      const internalListeners = (manager as unknown as { staleListeners: Set<unknown> }).staleListeners
      expect(internalListeners.size).toBe(0)

      unsub() // no-op after dispose, but must not throw
    })

    // ZF0-1478 #2: Two stale properties on the same source — verifying one must NOT clear the other
    it('#ZF0-1478: verifying one stale property on a source does not clear the other stale property', () => {
      // Two pending edits on the same source but different properties
      manager.set('src/Hero.tsx:5:3', 'color', 'red')
      manager.set('src/Hero.tsx:5:3', 'font-size', '16px')
      flushRAF()
      manager.trackPendingEdit('edit-color', 'src/Hero.tsx:5:3', 'color', 'red')
      manager.trackPendingEdit('edit-fontsize', 'src/Hero.tsx:5:3', 'font-size', '16px')

      // Advance past TTL — both edits evict and both stale tuples are recorded
      vi.advanceTimersByTime(36_000)
      manager.trackPendingEdit('edit-trigger', 'unrelated:1:1', 'margin', '0')

      // Both stale properties should be reflected under the same source
      const afterEviction = manager.getStaleSources()
      expect(afterEviction).toEqual(new Set(['src/Hero.tsx:5:3']))

      // Re-register a new pending edit for color so handleHMRVerified can find it
      manager.trackPendingEdit('edit-color-2', 'src/Hero.tsx:5:3', 'color', 'red')
      manager.handleHMRVerified('edit-color-2', true)
      manager.onHMRApplied()
      flushRAF()
      flushRAF()

      // After verifying 'color', the font-size stale tuple must still exist →
      // the source should STILL appear in getStaleSources().
      // Under the pre-fix Set<string> keyed by source, staleSources.delete(source)
      // removes the source entirely even though font-size is still stale.
      expect(manager.getStaleSources()).toEqual(new Set(['src/Hero.tsx:5:3']))
    })

    // ZF0-1479 #1: Timer-driven sweep fires stale signal during idle session
    // Verifies that evictStalePendingEdits() runs autonomously via setInterval
    // even when the user makes no further edits and no hmr_verified arrives.
    it('#ZF0-1479: timer-driven sweep fires stale signal without new trackPendingEdit or hmr_verified', () => {
      const staleSets: Array<Set<string>> = []
      const unsub = manager.onStale(s => staleSets.push(new Set(s)))

      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')

      // Advance past TTL (35s) + one sweep period (5s) without any user action.
      // DO NOT call trackPendingEdit again. DO NOT call handleHMRVerified.
      // The timer-driven sweep must fire evictStalePendingEdits autonomously.
      vi.advanceTimersByTime(40_000)

      expect(staleSets).toHaveLength(1)
      expect(staleSets[0]).toEqual(new Set(['a:1:1']))

      unsub()
    })

    // ZF0-1479 #2: Timer disarmed on dispose — sweepTimerId is null after dispose
    // Verifies that the setInterval handle is cleared when dispose() is called.
    // Uses internal field inspection (same pattern as the staleListeners.size check
    // in the existing dispose test) because staleListeners.clear() runs during dispose,
    // which prevents a listener from observing post-dispose interval firings directly.
    it('#ZF0-1479: sweep timer is disarmed on dispose, sweepTimerId is null after dispose', () => {
      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')

      // Confirm the timer was armed by trackPendingEdit. Pair `toBeDefined`
      // (catches rename: cast → undefined) with `not.toBeNull` (catches arm
      // failure: field stays at initial null). Vitest's fake `setInterval` may
      // return either a number (browser-like) or a Sinon timer object — both
      // satisfy these two checks, so the assertion is implementation-agnostic.
      // A bare `not.toBeNull()` would silently pass against `undefined`
      // (Copilot caught this on PR #92).
      const internalBefore = (manager as unknown as { sweepTimerId: number | null }).sweepTimerId
      expect(internalBefore).toBeDefined()
      expect(internalBefore).not.toBeNull()

      // dispose() must disarm the timer.
      manager.dispose()

      const internalAfter = (manager as unknown as { sweepTimerId: number | null }).sweepTimerId
      expect(internalAfter).toBeNull()
    })
  })

  it('two sequential edit cycles both verify and remove their overrides', () => {
      // Guards against regressions where per-cycle state (flags, queues, caches)
      // fails to reset between edits and the second cycle silently no-ops.
      // Both targets start with their expected post-edit inline value so each
      // verify matches on the first attempt (no retry window delays the test).
      const targetA = document.createElement('div')
      targetA.setAttribute('data-cortex-source', 'a:1:1')
      targetA.style.color = 'red'
      document.body.appendChild(targetA)
      const targetB = document.createElement('div')
      targetB.setAttribute('data-cortex-source', 'b:1:1')
      targetB.style.margin = '8px'
      document.body.appendChild(targetB)

      // Cycle 1.
      manager.set('a:1:1', 'color', 'red')
      flushRAF()
      manager.trackPendingEdit('edit-1', 'a:1:1', 'color', 'red')
      manager.handleHMRVerified('edit-1', true, 'jsx-immediate')
      manager.onHMRApplied()
      flushRAF()
      flushRAF()

      // Cycle 2 — different source + property.
      manager.set('b:1:1', 'margin', '8px')
      flushRAF()
      manager.trackPendingEdit('edit-2', 'b:1:1', 'margin', '8px')
      manager.handleHMRVerified('edit-2', true, 'jsx-immediate')

      const styleEl = document.head.querySelector('[data-cortex-override]') as HTMLStyleElement
      expect(styleEl.textContent).toContain('margin: 8px') // double-rAF pending

      manager.onHMRApplied()
      flushRAF()
      flushRAF()
      expect(styleEl.textContent).toBe('')

      targetA.remove()
      targetB.remove()
    })
  })

  // hasAnyOverrides gates whether Panel pays for the override-bypassing read or
  // trusts a plain computed read as the staged-edit baseline. Every Panel test
  // supplies a hand-written mock of it, so without these the production formula
  // is never executed anywhere — and a wrong `false` silently reinstates the
  // polluted-baseline bug.
  describe('hasAnyOverrides', () => {
    it('is false on a fresh manager, true once a user edit is staged, false after clearAll', () => {
      expect(manager.hasAnyOverrides()).toBe(false)
      manager.set('a:1:1', 'color', 'red')
      expect(manager.hasAnyOverrides()).toBe(true)
      manager.clearAll()
      expect(manager.hasAnyOverrides()).toBe(false)
    })

    it('reports forced-state declarations with no user edits', () => {
      // The stateOverrides term is the only reason this is not just
      // `overrides.size > 0`. Forced :hover declarations land in the SAME
      // <style>, so a plain computed read is contaminated by them too —
      // dropping this term would send Panel down the cheap path while the
      // override sheet is actively lying to getComputedStyle.
      manager.setStateOverrides('a:1:1', new Map([['color', 'blue']]))
      expect(manager.hasAnyOverrides()).toBe(true)
      manager.clearStateOverrides()
      expect(manager.hasAnyOverrides()).toBe(false)
    })
  })

})

describe('OverrideManager dirty-flag short-circuit (ZF0-1835)', () => {
  let manager: CSSOverrideManager
  const originalRAF = window.requestAnimationFrame

  beforeEach(() => {
    // Synchronous RAF so flush() triggers rebuild() immediately
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(performance.now())
      return 0
    }) as typeof requestAnimationFrame
    document.querySelectorAll('[data-cortex-override]').forEach(el => el.remove())
    document.querySelectorAll('[data-cortex-source]').forEach(el => el.remove())
    manager = new CSSOverrideManager()
  })

  afterEach(() => {
    window.requestAnimationFrame = originalRAF
    manager.dispose()
    document.querySelectorAll('[data-cortex-source]').forEach(el => el.remove())
  })

  it('starts dirty so cold-start rebuild always runs', () => {
    expect(manager._isDirtyForTesting).toBe(true)
  })

  it('rebuild short-circuits when nothing changed since last rebuild', () => {
    manager.set('src.tsx:1:1', 'color', 'red')
    manager.flush()
    expect(manager._isDirtyForTesting).toBe(false)
    manager.flush() // second flush — no mutations between
    expect(manager._isDirtyForTesting).toBe(false)
  })

  it('set() marks manager dirty; RAF fires clear it', () => {
    // Drain initial cold-start dirty: primer set() + flush().
    // - set() schedules RAF; the beforeEach's synchronous RAF runs rebuild immediately,
    //   which clears isDirty. But the sync-RAF mock returns 0 (not null), so the outer
    //   assignment in scheduleRebuild leaves rafId=0 — preventing later set() calls from
    //   scheduling fresh RAFs (rafId !== null short-circuits the schedule guard).
    // - flush() runs cancelPendingRebuild(), restoring rafId=null, then runs a no-op
    //   rebuild (dirty already false). Clean state for the load-bearing assertion below.
    // Without this drain the subsequent set() assertion would be non-falsifiable.
    manager.set('primer.tsx:0:0', 'color', 'red')
    manager.flush()
    expect(manager._isDirtyForTesting).toBe(false)
    // Use a capturing RAF so we can inspect isDirty BEFORE the frame executes.
    // The outer beforeEach uses synchronous RAF which clears dirty inline;
    // swap it out for this single test so the intermediate state is visible.
    const rafQueue: FrameRequestCallback[] = []
    const capturingRaf = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    }) as typeof requestAnimationFrame
    window.requestAnimationFrame = capturingRaf

    manager.set('src.tsx:1:1', 'color', 'red')
    // Dirty must flip back to true via set() — would fail if set() did NOT mark dirty
    expect(manager._isDirtyForTesting).toBe(true)
    // Fire the queued frame — rebuild runs, clears dirty
    rafQueue.forEach(cb => cb(performance.now()))
    expect(manager._isDirtyForTesting).toBe(false)
  })

  it('remove() marks manager dirty before rebuild clears it', () => {
    manager.set('src.tsx:1:1', 'color', 'red')
    manager.flush()
    expect(manager._isDirtyForTesting).toBe(false)
    // Spy on rebuild to capture isDirty at the moment the mutator triggers it.
    // Without this, asserting only post-rebuild state would pass even if remove()
    // did NOT mark dirty (rebuild's exit clears it regardless).
    let dirtyAtRebuild: boolean | null = null
    const origRebuild = (manager as unknown as { rebuild: () => void }).rebuild
    ;(manager as unknown as { rebuild: () => void }).rebuild = function (this: { isDirty: boolean }) {
      dirtyAtRebuild = this.isDirty
      origRebuild.call(this)
    }
    manager.remove('src.tsx:1:1', 'color')
    ;(manager as unknown as { rebuild: () => void }).rebuild = origRebuild
    expect(dirtyAtRebuild).toBe(true)
    expect(manager._isDirtyForTesting).toBe(false)
  })

  it('setStateOverrides() marks manager dirty before rebuild clears it', () => {
    manager.set('src.tsx:1:1', 'color', 'red')
    manager.flush()
    expect(manager._isDirtyForTesting).toBe(false)
    let dirtyAtRebuild: boolean | null = null
    const origRebuild = (manager as unknown as { rebuild: () => void }).rebuild
    ;(manager as unknown as { rebuild: () => void }).rebuild = function (this: { isDirty: boolean }) {
      dirtyAtRebuild = this.isDirty
      origRebuild.call(this)
    }
    manager.setStateOverrides('src.tsx:1:1', new Map([['background-color', 'blue']]))
    ;(manager as unknown as { rebuild: () => void }).rebuild = origRebuild
    expect(dirtyAtRebuild).toBe(true)
    expect(manager._isDirtyForTesting).toBe(false)
  })

  it('clearStateOverrides() marks manager dirty before rebuild clears it', () => {
    manager.setStateOverrides('src.tsx:1:1', new Map([['background-color', 'blue']]))
    // already rebuilt synchronously
    expect(manager._isDirtyForTesting).toBe(false)
    let dirtyAtRebuild: boolean | null = null
    const origRebuild = (manager as unknown as { rebuild: () => void }).rebuild
    ;(manager as unknown as { rebuild: () => void }).rebuild = function (this: { isDirty: boolean }) {
      dirtyAtRebuild = this.isDirty
      origRebuild.call(this)
    }
    manager.clearStateOverrides()
    ;(manager as unknown as { rebuild: () => void }).rebuild = origRebuild
    expect(dirtyAtRebuild).toBe(true)
    expect(manager._isDirtyForTesting).toBe(false)
  })

  it('clearAll() marks manager dirty before rebuild clears it', () => {
    manager.set('src.tsx:1:1', 'color', 'red')
    manager.flush()
    expect(manager._isDirtyForTesting).toBe(false)
    let dirtyAtRebuild: boolean | null = null
    const origRebuild = (manager as unknown as { rebuild: () => void }).rebuild
    ;(manager as unknown as { rebuild: () => void }).rebuild = function (this: { isDirty: boolean }) {
      dirtyAtRebuild = this.isDirty
      origRebuild.call(this)
    }
    manager.clearAll()
    ;(manager as unknown as { rebuild: () => void }).rebuild = origRebuild
    expect(dirtyAtRebuild).toBe(true)
    expect(manager._isDirtyForTesting).toBe(false)
  })
})
