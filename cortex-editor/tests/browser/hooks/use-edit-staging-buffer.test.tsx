import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { useEditStagingBuffer, createPanelSyncEmitter, type PendingEdit, type SyncEmitter } from '../../../src/browser/hooks/useEditStagingBuffer.js'
import type { CortexChannel } from '../../../src/adapters/types.js'
import { cortexStorage } from '../../../src/browser/persistence.js'
import { makeEdit } from '../../core/helpers.js'

function renderHook<T>(hookFn: () => T): { result: { current: T }; unmount: () => void; rerender: (newHookFn: () => T) => void } {
  const result = { current: null as T }
  const container = document.createElement('div')
  document.body.appendChild(container)
  let currentFn = hookFn

  function Wrapper() {
    result.current = currentFn()
    return null
  }

  render(<Wrapper />, container)
  return {
    result,
    unmount: () => {
      render(null, container)
      container.remove()
    },
    rerender: (newHookFn: () => T) => {
      currentFn = newHookFn
      render(<Wrapper />, container)
    },
  }
}

describe('useEditStagingBuffer', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  // Change 4: memory-only — the old "append writes to localStorage debounced"
  // test is now inverted: see the "no persistence" test above, which proves
  // setItem is never called. This placeholder is removed; the no-persistence
  // test is the canonical assertion for this behavior.

  it('same composite key (source\\0property\\0pseudo) collapses last-write-wins', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    const edit1 = makeEdit({ intentId: 'id-1', value: 'red', source: 'src/Hero.tsx:14:5', property: 'color' })
    const edit2 = makeEdit({ intentId: 'id-2', value: 'green', source: 'src/Hero.tsx:14:5', property: 'color' })

    await act(() => {
      result.current.append(edit1)
      result.current.append(edit2)
    })

    const list = result.current.list()
    expect(list).toHaveLength(1)
    expect(list[0].value).toBe('green')
    expect(list[0].intentId).toBe('id-2')

    unmount()
  })

  it('remove drops intents from the buffer', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    const edit = makeEdit({ intentId: 'id-remove', source: 'src/Hero.tsx:14:5' })

    await act(() => {
      result.current.append(edit)
    })

    expect(result.current.list()).toHaveLength(1)

    await act(() => {
      result.current.remove(['id-remove'])
    })

    expect(result.current.list()).toHaveLength(0)
    expect(result.current.size()).toBe(0)

    unmount()
  })

  it('clear empties the buffer', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    await act(() => {
      result.current.append(makeEdit({ intentId: 'a', source: 'src/A.tsx:1:1' }))
      result.current.append(makeEdit({ intentId: 'b', source: 'src/B.tsx:2:2' }))
    })

    expect(result.current.size()).toBe(2)

    await act(() => {
      result.current.clear()
    })

    expect(result.current.size()).toBe(0)
    expect(result.current.list()).toHaveLength(0)

    unmount()
  })

  // Change 4: memory-only — rehydration removed. Buffer starts empty on every mount.
  it('memory-only: fresh mount ignores stale localStorage entries', () => {
    const staleEdit = makeEdit({ intentId: 'stale-1', property: 'color', value: 'red', previousValue: 'blue' })
    cortexStorage.set('staging-buffer', [staleEdit])

    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    expect(result.current.size()).toBe(0)
    expect(result.current.list()).toEqual([])

    unmount()
  })

  it('list returns intents in insertion order', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    const editA = makeEdit({ intentId: 'a', property: 'color', timestamp: 1000 })
    const editB = makeEdit({ intentId: 'b', property: 'fontSize', timestamp: 2000 })
    const editC = makeEdit({ intentId: 'c', property: 'padding', timestamp: 3000 })

    await act(() => {
      result.current.append(editA)
      result.current.append(editB)
      result.current.append(editC)
    })

    const list = result.current.list()
    expect(list).toHaveLength(3)
    expect(list[0].intentId).toBe('a')
    expect(list[1].intentId).toBe('b')
    expect(list[2].intentId).toBe('c')

    unmount()
  })

  it('buffer eviction at 500 entries evicts oldest first', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    // Append 501 entries — each has a unique property so no collapsing
    await act(() => {
      for (let i = 0; i < 501; i++) {
        result.current.append(makeEdit({
          intentId: `id-${i}`,
          property: `prop-${i}`,
          timestamp: i,
        }))
      }
    })

    const list = result.current.list()
    expect(list).toHaveLength(500)
    // The FIRST entry (oldest, id-0) should be gone
    expect(list.find(e => e.intentId === 'id-0')).toBeUndefined()
    // The last entry (id-500) should still be present
    expect(list.find(e => e.intentId === 'id-500')).toBeDefined()

    unmount()
  })

  it('reconcile for unchanged files returns empty divergent list', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    await act(() => {
      result.current.append(makeEdit({ source: 'src/Hero.tsx:14:5' }))
    })

    // reconcile with empty array
    const { divergent: d1 } = result.current.reconcile([])
    expect(d1).toHaveLength(0)

    // reconcile with unrelated file
    const { divergent: d2 } = result.current.reconcile(['src/Other.tsx'])
    expect(d2).toHaveLength(0)

    unmount()
  })

  // happy-dom + production-reader pairing rationale (ZF0-1452 Step 8.5 audit):
  // The reconcile tests below exercise inline-style reads, which production's
  // defaultReadSourceValue handles via el.style.getPropertyValue(prop) FIRST
  // (before the getComputedStyle fallback). happy-dom returns inline-style
  // values verbatim — same as real browsers — so the inline path is consistent
  // across both. The tests do NOT exercise the getComputedStyle fallback (which
  // normalizes 'green' → 'rgb(0, 128, 0)' in real browsers but not happy-dom);
  // tests that need the override-bypass path inject a custom reader (see the
  // 'reconcile uses readSourceValue callback' test). Pairing is intentional;
  // the assertions are NOT happy-dom theatre.
  it('reconcile flags divergent when current inline style differs from previousValue', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    // Create a DOM element with the matching source attribute
    const el = document.createElement('div')
    el.setAttribute('data-cortex-source', 'src/Hero.tsx:5:3')
    el.style.color = 'green' // differs from previousValue 'blue'
    document.body.appendChild(el)

    await act(() => {
      result.current.append(makeEdit({
        intentId: 'divergent-id',
        source: 'src/Hero.tsx:5:3',
        property: 'color',
        previousValue: 'blue',
      }))
    })

    const { divergent } = result.current.reconcile(['src/Hero.tsx'])
    expect(divergent).toHaveLength(1)
    expect(divergent[0].intentId).toBe('divergent-id')

    el.remove()
    unmount()
  })

  it('cross-file isolation — B intents reconcile after A is cleared', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    const editA1 = makeEdit({
      intentId: 'a1',
      source: 'src/A.tsx:1:1',
      property: 'color',
      previousValue: 'red',
    })
    const editA2 = makeEdit({
      intentId: 'a2',
      source: 'src/A.tsx:2:2',
      property: 'font-size',
      previousValue: '12px',
    })
    const editB1 = makeEdit({
      intentId: 'b1',
      source: 'src/B.tsx:1:1',
      property: 'color',
      previousValue: 'green',
    })

    await act(() => {
      result.current.append(editA1)
      result.current.append(editA2)
      result.current.append(editB1)
    })

    expect(result.current.size()).toBe(3)

    // Remove A file's intents only.
    await act(() => {
      result.current.remove(['a1', 'a2'])
    })

    // B's intent must survive.
    const remaining = result.current.list()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].intentId).toBe('b1')

    // (1) Reconcile against B with a divergent inline style — must flag b1.
    // Proves B's bookkeeping survived A's removal: if B had been incorrectly
    // dropped along with A, reconcile would return divergent: [].
    const elB = document.createElement('div')
    elB.setAttribute('data-cortex-source', 'src/B.tsx:1:1')
    elB.style.setProperty('color', 'blue') // differs from previousValue 'green'
    document.body.appendChild(elB)

    const { divergent: divergentB } = result.current.reconcile(['src/B.tsx'])
    expect(divergentB).toHaveLength(1)
    expect(divergentB[0].intentId).toBe('b1')

    // (2) Reconcile against A — must return empty. Both A intents are gone,
    // so reconcile has nothing to evaluate even though A elements aren't in DOM.
    // (If stale IDs lingered, reconcile would still iterate them and either
    // crash on the missing element or push them as divergent.)
    const { divergent: divergentA } = result.current.reconcile(['src/A.tsx'])
    expect(divergentA).toHaveLength(0)

    elB.remove()
    unmount()
  })

  it('reconcile uses readSourceValue callback when provided (bypasses override layer)', async () => {
    // Production HMR wiring passes a reader that detaches the cortex override
    // <style> tag before reading getComputedStyle, so the buffer sees the
    // SOURCE value rather than cortex's own !important override. This test
    // proves the callback path: a custom reader returns 'red' regardless of
    // the actual DOM state, and reconcile must compare against THAT — not
    // against any inline/computed value.
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    const el = document.createElement('div')
    el.setAttribute('data-cortex-source', 'src/Hero.tsx:5:3')
    // Inline style says 'green' — the default reader would see this. The
    // injected reader IGNORES it and returns 'red' instead, which matches
    // previousValue, so reconcile must NOT flag this entry as divergent.
    el.style.color = 'green'
    document.body.appendChild(el)

    await act(() => {
      result.current.append(makeEdit({
        intentId: 'reader-id',
        source: 'src/Hero.tsx:5:3',
        property: 'color',
        previousValue: 'red',
      }))
    })

    const customReader = vi.fn((_el: Element, _prop: string, _pseudo: string | null) => 'red')
    const { divergent } = result.current.reconcile(['src/Hero.tsx'], customReader)
    expect(divergent).toHaveLength(0)
    expect(customReader).toHaveBeenCalledTimes(1)
    expect(customReader).toHaveBeenCalledWith(el, 'color', null)

    // Sanity: with a reader that returns a divergent value, the entry IS flagged.
    const divergingReader = vi.fn(() => 'purple')
    const { divergent: d2 } = result.current.reconcile(['src/Hero.tsx'], divergingReader)
    expect(d2).toHaveLength(1)
    expect(d2[0].intentId).toBe('reader-id')

    el.remove()
    unmount()
  })

  it('reconcile passes pseudo to readSourceValue and skips inline-style for pseudo edits', async () => {
    // Pseudo-elements have no inline style, so the default reader must skip
    // the el.style check and go straight to getComputedStyle(el, pseudo).
    // We assert via the readSourceValue callback signature: the pseudo arg
    // must propagate to the reader.
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    const el = document.createElement('div')
    el.setAttribute('data-cortex-source', 'src/Hero.tsx:9:9')
    document.body.appendChild(el)

    await act(() => {
      result.current.append(makeEdit({
        intentId: 'pseudo-id',
        source: 'src/Hero.tsx:9:9',
        property: 'content',
        previousValue: '"x"',
        pseudo: '::before',
      }))
    })

    const reader = vi.fn((_el: Element, _prop: string, _pseudo: string | null) => '"x"')
    const { divergent } = result.current.reconcile(['src/Hero.tsx'], reader)
    expect(divergent).toHaveLength(0)
    expect(reader).toHaveBeenCalledWith(el, 'content', '::before')

    el.remove()
    unmount()
  })

  it('reconcile escapes data-cortex-source to support Next.js dynamic routes', async () => {
    // src/app/[id]/page.tsx is a valid Next.js path — the `[` and `]` are
    // attribute-selector metacharacters that throw SyntaxError without
    // CSS.escape. This test would crash without the escape.
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    const dynamicSource = 'src/app/[id]/page.tsx:14:5'
    const el = document.createElement('div')
    el.setAttribute('data-cortex-source', dynamicSource)
    el.style.color = 'orange' // differs from previousValue
    document.body.appendChild(el)

    await act(() => {
      result.current.append(makeEdit({
        intentId: 'dynamic-route-id',
        source: dynamicSource,
        property: 'color',
        previousValue: 'blue',
      }))
    })

    // Must not throw.
    const { divergent } = result.current.reconcile(['src/app/[id]/page.tsx'])
    expect(divergent).toHaveLength(1)
    expect(divergent[0].intentId).toBe('dynamic-route-id')

    el.remove()
    unmount()
  })

  it('eviction at 500 entries logs a console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    await act(() => {
      for (let i = 0; i < 501; i++) {
        result.current.append(makeEdit({
          intentId: `evict-id-${i}`,
          property: `prop-${i}`,
          source: `src/Evict.tsx:${i}:${i}`,
        }))
      }
    })

    // Exactly one eviction (501st append).
    const evictionWarns = warnSpy.mock.calls.filter(
      args => typeof args[0] === 'string' && args[0].includes('Staging buffer evicted'),
    )
    expect(evictionWarns).toHaveLength(1)
    // Evicted entry's source/property surfaced for downstream UI surfacing.
    expect(evictionWarns[0]).toEqual([
      expect.stringContaining('Staging buffer evicted'),
      'src/Evict.tsx:0:0',
      'prop-0',
    ])

    warnSpy.mockRestore()
    unmount()
  })

  // ZF0-1477 Item #1: version is exposed on StagingBufferHandle and increments on mutations
  it('exposes a version number that starts at 0', () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())
    expect(result.current.version).toBe(0)
    unmount()
  })

  it('version increments after append', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())
    const before = result.current.version
    await act(() => {
      result.current.append(makeEdit({ intentId: 'v-append' }))
    })
    expect(result.current.version).toBeGreaterThan(before)
    unmount()
  })

  it('version increments after remove', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())
    await act(() => {
      result.current.append(makeEdit({ intentId: 'v-remove' }))
    })
    const before = result.current.version
    await act(() => {
      result.current.remove(['v-remove'])
    })
    expect(result.current.version).toBeGreaterThan(before)
    unmount()
  })

  it('version increments after clear', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())
    await act(() => {
      result.current.append(makeEdit({ intentId: 'v-clear' }))
    })
    const before = result.current.version
    await act(() => {
      result.current.clear()
    })
    expect(result.current.version).toBeGreaterThan(before)
    unmount()
  })

  // Change 4: memory-only — the buffer has no persistence layer. This test
  // proves no setItem referencing the staging-buffer key is ever called after
  // a mutation.
  it('no persistence: append does not write staging-buffer to localStorage (memory-only)', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    const edit = makeEdit({ intentId: 'no-persist-check' })
    await act(() => {
      result.current.append(edit)
    })

    // Drain all timers — proves no deferred write was ever scheduled.
    await act(() => {
      vi.advanceTimersByTime(300)
    })

    // Verify no setItem call referenced the staging-buffer key
    const stagingBufferWrites = setItemSpy.mock.calls.filter(
      args => typeof args[0] === 'string' && args[0].includes('staging-buffer'),
    )
    expect(stagingBufferWrites).toHaveLength(0)

    unmount()
    setItemSpy.mockRestore()
  })

  // Change 4: memory-only — unmount has no persistence side-effect and the hook
  // tears down cleanly. The old assertion (localStorage written on unmount) is
  // inverted: no localStorage write must occur.
  it('unmount does not write to localStorage (memory-only buffer)', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    const edit = makeEdit({ intentId: 'no-write-on-unmount', value: 'staged-value' })
    await act(() => {
      result.current.append(edit)
    })

    // The staging-buffer key never exists — nothing is persisted.
    const keyBefore = Object.keys(localStorage).find(k => k.endsWith(':staging-buffer'))
    expect(keyBefore).toBeUndefined()

    // Unmount — no setItem for the staging-buffer key must fire.
    await act(() => {
      unmount()
    })

    const stagingBufferWrites = setItemSpy.mock.calls.filter(
      args => typeof args[0] === 'string' && args[0].includes('staging-buffer'),
    )
    expect(stagingBufferWrites).toHaveLength(0)

    setItemSpy.mockRestore()
  })

  it('reconcile resolves an intent whose source is on an <svg>', async () => {
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('data-cortex-source', 'src/Icon.tsx:3:5')
    svg.style.setProperty('color', 'blue')
    document.body.appendChild(svg)

    await act(() => {
      result.current.append(makeEdit({
        intentId: 'svg-intent',
        source: 'src/Icon.tsx:3:5',
        property: 'color',
        previousValue: 'blue',
      }))
    })

    const { divergent } = result.current.reconcile(['src/Icon.tsx'])
    // Pre-fix: [svg-intent]. The source->element index was built with an
    // HTMLElement-filtered walk, so the <svg> was never indexed, the lookup
    // missed, and the `!el` branch reported a live element as
    // "deleted / file refactored" on every HMR touching that file.
    expect(divergent).toHaveLength(0)

    svg.remove()
    unmount()
  })

})

describe('useEditStagingBuffer — sync emitter integration', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  function makeMockEmitter(): SyncEmitter & {
    syncAdd: ReturnType<typeof vi.fn>
    syncRemove: ReturnType<typeof vi.fn>
    syncClear: ReturnType<typeof vi.fn>
    syncFullState: ReturnType<typeof vi.fn>
  } {
    return {
      syncAdd: vi.fn(),
      syncRemove: vi.fn(),
      syncClear: vi.fn(),
      syncFullState: vi.fn(),
    }
  }

  it('append → calls emitter.syncAdd(edit) exactly once with the appended PendingEdit', async () => {
    const emitter = makeMockEmitter()
    const { result, unmount } = renderHook(() => useEditStagingBuffer(emitter))

    const edit = makeEdit({ intentId: 'sync-add' })
    await act(() => {
      result.current.append(edit)
    })

    expect(emitter.syncAdd).toHaveBeenCalledTimes(1)
    expect(emitter.syncAdd).toHaveBeenCalledWith(expect.objectContaining({ intentId: 'sync-add' }))
    expect(emitter.syncRemove).not.toHaveBeenCalled()
    expect(emitter.syncClear).not.toHaveBeenCalled()

    unmount()
  })

  it('remove → calls emitter.syncRemove(intentIds) exactly once', async () => {
    const emitter = makeMockEmitter()
    const { result, unmount } = renderHook(() => useEditStagingBuffer(emitter))

    await act(() => {
      result.current.append(makeEdit({ intentId: 'r-id' }))
    })

    emitter.syncAdd.mockClear()
    await act(() => {
      result.current.remove(['r-id'])
    })

    expect(emitter.syncRemove).toHaveBeenCalledTimes(1)
    expect(emitter.syncRemove).toHaveBeenCalledWith(['r-id'])
    expect(emitter.syncAdd).not.toHaveBeenCalled()
    expect(emitter.syncClear).not.toHaveBeenCalled()

    unmount()
  })

  it('clear → calls emitter.syncClear() exactly once', async () => {
    const emitter = makeMockEmitter()
    const { result, unmount } = renderHook(() => useEditStagingBuffer(emitter))

    await act(() => {
      result.current.append(makeEdit({ intentId: 'c-id' }))
    })

    emitter.syncAdd.mockClear()
    await act(() => {
      result.current.clear()
    })

    expect(emitter.syncClear).toHaveBeenCalledTimes(1)
    expect(emitter.syncAdd).not.toHaveBeenCalled()
    expect(emitter.syncRemove).not.toHaveBeenCalled()

    unmount()
  })

  it('reconcile does NOT emit sync (reconcile is a read, not a mutation)', async () => {
    const emitter = makeMockEmitter()
    const { result, unmount } = renderHook(() => useEditStagingBuffer(emitter))

    await act(() => {
      result.current.append(makeEdit({ intentId: 'rec-id', source: 'src/A.tsx:1:1' }))
    })

    // Clear all emitter calls from the append
    emitter.syncAdd.mockClear()

    // reconcile is a pure read operation — must not emit
    result.current.reconcile(['src/A.tsx'])

    expect(emitter.syncAdd).not.toHaveBeenCalled()
    expect(emitter.syncRemove).not.toHaveBeenCalled()
    expect(emitter.syncClear).not.toHaveBeenCalled()
    expect(emitter.syncFullState).not.toHaveBeenCalled()

    unmount()
  })

  it('back-compat: hook called with no emitter — all mutations work, no errors', async () => {
    // This test verifies that calling useEditStagingBuffer() with no emitter
    // preserves backward-compat behavior exactly.
    const { result, unmount } = renderHook(() => useEditStagingBuffer())

    const edit = makeEdit({ intentId: 'compat' })
    await act(() => {
      result.current.append(edit)
    })
    expect(result.current.list()).toHaveLength(1)

    await act(() => {
      result.current.remove(['compat'])
    })
    expect(result.current.list()).toHaveLength(0)

    await act(() => {
      result.current.append(makeEdit({ intentId: 'compat2' }))
      result.current.clear()
    })
    expect(result.current.size()).toBe(0)

    unmount()
  })

  it('emitter.syncAdd receives the exact same shape as list() returns (after append)', async () => {
    const emitter = makeMockEmitter()
    const { result, unmount } = renderHook(() => useEditStagingBuffer(emitter))

    const edit = makeEdit({ intentId: 'shape-check', pseudo: '::before', scope: 'all' })
    await act(() => {
      result.current.append(edit)
    })

    const emittedEdit = emitter.syncAdd.mock.calls[0][0] as PendingEdit
    expect(emittedEdit.intentId).toBe('shape-check')
    expect(emittedEdit.pseudo).toBe('::before')
    expect(emittedEdit.scope).toBe('all')

    // Must match what list() returns
    const listEdit = result.current.list()[0]
    expect(emittedEdit.intentId).toBe(listEdit.intentId)
    expect(emittedEdit.value).toBe(listEdit.value)

    unmount()
  })

  it('append at the 501st entry triggers syncRemove for the evicted oldest intent', async () => {
    // FIFO eviction is a mutation — sync invariant requires syncRemove for the
    // dropped entry. Without it, the server cache grows unbounded on long
    // sessions while the browser silently caps at 500.
    const emitter = makeMockEmitter()
    const { result, unmount } = renderHook(() => useEditStagingBuffer(emitter))

    // Capture the very first intentId for the assertion below.
    const firstIntentId = 'evict-id-0'

    // Append 500 unique edits — different composite keys (unique property)
    // so no last-write-wins collapse, ensuring true FIFO eviction.
    await act(() => {
      for (let i = 0; i < 500; i++) {
        result.current.append(makeEdit({
          intentId: i === 0 ? firstIntentId : `evict-id-${i}`,
          property: `prop-${i}`,
          source: `src/Evict.tsx:${i}:${i}`,
        }))
      }
    })

    expect(emitter.syncAdd).toHaveBeenCalledTimes(500)
    expect(emitter.syncRemove).not.toHaveBeenCalled()
    expect(result.current.size()).toBe(500)

    // Append the 501st — must evict the first AND emit syncRemove for it.
    await act(() => {
      result.current.append(makeEdit({
        intentId: 'evict-id-500',
        property: 'prop-500',
        source: 'src/Evict.tsx:500:500',
      }))
    })

    expect(emitter.syncAdd).toHaveBeenCalledTimes(501)
    expect(emitter.syncRemove).toHaveBeenCalledTimes(1)
    expect(emitter.syncRemove).toHaveBeenCalledWith([firstIntentId])
    expect(result.current.size()).toBe(500)

    unmount()
  })
})

// ---------------------------------------------------------------------------
// createPanelSyncEmitter — Panel.tsx wiring (ZF0-1452 critical fix)
//
// The factory delegates each SyncEmitter method to channel.send with the
// matching BrowserToServer message shape. Without this wiring (or with a
// shape regression), the server-side StagedEditsCache stays empty and
// Claude's MCP tools see nothing of what the designer staged. These tests
// pin every send shape so a refactor can't silently break the integration.
// ---------------------------------------------------------------------------

describe('createPanelSyncEmitter — channel.send wiring', () => {
  function makeMockChannel(): CortexChannel & { send: ReturnType<typeof vi.fn> } {
    return {
      send: vi.fn(),
      sendAndAck: vi.fn(),
      onMessage: vi.fn(() => () => {}),
      onConnectionChange: vi.fn(() => () => {}),
      connected: true,
      dispose: vi.fn(),
    } as CortexChannel & { send: ReturnType<typeof vi.fn> }
  }

  it('syncAdd → channel.send({ type: "staged-edit-add", edit, token: "" })', () => {
    const channel = makeMockChannel()
    const emitter = createPanelSyncEmitter(channel)
    const edit = makeEdit({ intentId: 'wire-add' })

    emitter.syncAdd(edit)

    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(channel.send).toHaveBeenCalledWith({ type: 'staged-edit-add', edit, token: '' })
  })

  it('syncRemove → channel.send({ type: "staged-edit-remove", intentIds, token: "" }) with mutable array copy', () => {
    const channel = makeMockChannel()
    const emitter = createPanelSyncEmitter(channel)
    const ids: readonly string[] = ['a', 'b', 'c']

    emitter.syncRemove(ids)

    expect(channel.send).toHaveBeenCalledTimes(1)
    const call = channel.send.mock.calls[0][0] as { type: string; intentIds: string[]; token: string }
    expect(call.type).toBe('staged-edit-remove')
    expect(call.intentIds).toEqual(['a', 'b', 'c'])
    expect(call.token).toBe('')
    // Boundary copy: the readonly input must not be passed by reference
    expect(call.intentIds).not.toBe(ids)
  })

  it('syncClear → channel.send({ type: "staged-edit-clear", token: "" })', () => {
    const channel = makeMockChannel()
    const emitter = createPanelSyncEmitter(channel)

    emitter.syncClear()

    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(channel.send).toHaveBeenCalledWith({ type: 'staged-edit-clear', token: '' })
  })

  it('syncFullState → channel.send({ type: "staged-edits-sync", edits, token: "" }) with mutable array copy', () => {
    const channel = makeMockChannel()
    const emitter = createPanelSyncEmitter(channel)
    const edits: readonly PendingEdit[] = [
      makeEdit({ intentId: 'full-1' }),
      makeEdit({ intentId: 'full-2' }),
    ]

    emitter.syncFullState(edits)

    expect(channel.send).toHaveBeenCalledTimes(1)
    const call = channel.send.mock.calls[0][0] as { type: string; edits: PendingEdit[]; token: string }
    expect(call.type).toBe('staged-edits-sync')
    expect(call.edits).toHaveLength(2)
    expect(call.edits[0].intentId).toBe('full-1')
    expect(call.edits[1].intentId).toBe('full-2')
    expect(call.token).toBe('')
    // Boundary copy: the readonly input must not be passed by reference
    expect(call.edits).not.toBe(edits)
  })
})
