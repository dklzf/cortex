import { describe, it, expect } from 'vitest'
import { pendingEditSchema, isStructuralEdit } from '../../src/schemas/pending-edit.js'
import { StagedEditsCache } from '../../src/core/staged-edits.js'

/**
 * B2 — the pipeline can carry a structural intent.
 *
 * The encoding states a container's intended final child ORDER rather than a
 * relative move. External review took the first cut (`fromIndex → toIndex`)
 * apart: relative coordinates are only meaningful against a baseline, and
 * nothing pinned it — applying a subset, discarding one intent, retrying after
 * a crash, merging two tabs, or evicting the oldest entry each silently
 * invalidated every later index and produced a confidently wrong reorder.
 *
 * Absolute intents make each of those a non-issue by construction, which is
 * what most of this file pins.
 */

const HINT = { tagName: 'li', textPreview: 'Item A', domSelector: 'ul > li:nth-child(1)' }

function structural(over: Record<string, unknown> = {}, inner: Record<string, unknown> = {}) {
  return {
    kind: 'structural',
    intentId: '11111111-1111-4111-8111-111111111111',
    source: 'src/App.tsx:12:4',
    applyMode: 'agent-resolve',
    sourceResolutionHint: HINT,
    structural: {
      op: 'reorder',
      parentSource: 'src/App.tsx:10:2',
      parentKey: 'body>div:nth-child(1)>ul',
      baseline: ['src/App.tsx:12:4', 'src/App.tsx:12:4', 'src/App.tsx:12:4'],
      // COR-35: three rows from one `.map()` share a source, so `baseline`
      // above is three identical strings and cannot witness a permutation.
      // These can.
      childKeys: ['#li:Item A', '#li:Item B', '#li:Item C'],
      order: [2, 0, 1],
      ...inner,
    },
    timestamp: 1,
    ...over,
  }
}

function style(over: Record<string, unknown> = {}) {
  return {
    intentId: '22222222-2222-4222-8222-222222222222',
    source: 'src/App.tsx:12:4',
    property: 'color',
    value: 'red',
    previousValue: 'blue',
    timestamp: 1,
    ...over,
  }
}

describe('structural intent — schema', () => {
  it('accepts a well-formed reorder', () => {
    expect(pendingEditSchema.safeParse(structural()).success).toBe(true)
  })

  it('REJECTS a structural intent routed to the deterministic path', () => {
    // The a11y guarantee. If this passes, a reorder can reach
    // InlineStyleRewriter and be written as `style={{ order: N }}` — visually
    // right, but DOM order is untouched, so screen readers and tab order break.
    const parsed = pendingEditSchema.safeParse(structural({ applyMode: 'direct' }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.join('.') === 'applyMode')).toBe(true)
    }
  })

  it('rejects the identity permutation rather than staging a no-op reorder', () => {
    expect(pendingEditSchema.safeParse(structural({}, { order: [0, 1, 2] })).success).toBe(false)
  })

  it.each([
    ['a duplicate index', [0, 0, 1]],
    ['an out-of-range index', [0, 1, 9]],
    ['a length mismatch', [1, 0]],
  ])('rejects %s — order must be a real permutation of baseline', (_label, order) => {
    // Anything that is not a permutation describes a tree that cannot exist and
    // would leave the agent guessing.
    expect(pendingEditSchema.safeParse(structural({}, { order })).success).toBe(false)
  })

  it('requires a parentKey, so two renders of one component are distinguishable', () => {
    // `<Column/>` rendered twice with identical rows gives both containers the
    // same parentSource and every row the same source. Without parentKey the
    // two reorders are byte-identical and the agent cannot tell which backing
    // array to edit.
    expect(pendingEditSchema.safeParse(structural({}, { parentKey: '' })).success).toBe(false)
  })

  it('carries the baseline it was captured against, so staleness is detectable', () => {
    const parsed = pendingEditSchema.parse(structural())
    expect(isStructuralEdit(parsed)).toBe(true)
    if (isStructuralEdit(parsed)) expect(parsed.structural.baseline).toHaveLength(3)
  })
})

// ── COR-35 ──────────────────────────────────────────────────────────────────
//
// `baseline` is N identical strings for a `.map()`, so comparing it
// position-by-position is satisfied under every permutation — a reorder between
// capture and Apply was invisible to the drift guard. `childKeys` is the array
// that can witness one, and only while these rules hold.
describe('structural intent — childKeys (COR-35)', () => {
  it('REJECTS an intent with no childKeys, so a producer cannot omit them', () => {
    // Required rather than optional, deliberately: no producer exists yet, so
    // there is nothing to migrate — and an optional field would let the first
    // producer skip it and silently restore the bug this closes.
    expect(pendingEditSchema.safeParse(structural({}, { childKeys: undefined })).success).toBe(false)
  })

  it('REJECTS childKeys that are not pairwise distinct', () => {
    // The guard's correctness argument is "given distinct keys, positional
    // comparison detects EVERY permutation". Duplicate keys void it — swapping
    // the two children they name compares clean — so the intent is refused
    // rather than staged with a guard that cannot see the swap.
    const parsed = pendingEditSchema.safeParse(
      structural({}, { childKeys: ['#li:Row', '#li:Row', '#li:Other'] }),
    )
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.join('.') === 'structural.childKeys')).toBe(true)
    }
  })

  it('REJECTS childKeys whose length disagrees with baseline', () => {
    // The guard indexes the two arrays together. A short array would leave the
    // trailing children unchecked — precisely the ones a reorder moves.
    const parsed = pendingEditSchema.safeParse(
      structural({}, { childKeys: ['#li:Item A', '#li:Item B'] }),
    )
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.join('.') === 'structural.childKeys')).toBe(true)
    }
  })

  it('REJECTS an empty-string key rather than treating it as "no identity"', () => {
    // '' is what an unannotated, textless child would collapse to. Two of them
    // are indistinguishable, and admitting one entry now is how a second gets
    // admitted later.
    expect(pendingEditSchema.safeParse(
      structural({}, { childKeys: ['', '#li:Item B', '#li:Item C'] }),
    ).success).toBe(false)
  })

  it('accepts distinct keys of the same length as baseline', () => {
    // Control: the rules above must not make well-formed intents unstageable.
    const parsed = pendingEditSchema.parse(structural())
    expect(isStructuralEdit(parsed)).toBe(true)
    if (isStructuralEdit(parsed)) {
      expect(parsed.structural.childKeys).toEqual(['#li:Item A', '#li:Item B', '#li:Item C'])
    }
  })
})

describe('back-compat — style intents are unchanged on the wire', () => {
  it('accepts a style intent with NO kind field and NORMALISES it to "style"', () => {
    // Asserting `!isStructuralEdit` alone would also pass if `kind` came back
    // undefined, which is the bug this normalisation exists to prevent.
    const parsed = pendingEditSchema.safeParse(style())
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.kind).toBe('style')
      expect(isStructuralEdit(parsed.data)).toBe(false)
    }
  })

  it('still rejects a bad timestamp at path "timestamp", not inside a union blob', () => {
    // A plain z.union attempts every member and reports a nested invalid_union,
    // which destroyed the specific path the UI shows.
    const parsed = pendingEditSchema.safeParse(style({ timestamp: Number.NaN }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.join('.') === 'timestamp')).toBe(true)
    }
  })

  it('still rejects an unknown pseudo at path "pseudo"', () => {
    const parsed = pendingEditSchema.safeParse(style({ pseudo: '::marker' }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.join('.') === 'pseudo')).toBe(true)
    }
  })
})

describe('absolute intents make the replay failures impossible', () => {
  const reorder = (id: string, key: string, order: number[], timestamp: number) =>
    pendingEditSchema.parse(structural({ intentId: id, timestamp }, { parentKey: key, order })) as never

  it('collapses repeated drags in ONE container to the latest intended order', () => {
    // Three drags in the same row leave one intent describing where things
    // ended up, not three that must be replayed in sequence. This is what
    // removes the ordered-log failure class AND the unbounded growth that
    // unique-per-drag keys caused.
    const cache = new StagedEditsCache()
    const KEY = 'body>ul'
    cache.append(reorder('aaaaaaaa-1111-4111-8111-111111111111', KEY, [1, 0, 2], 1))
    cache.append(reorder('bbbbbbbb-2222-4222-8222-222222222222', KEY, [2, 1, 0], 2))
    cache.append(reorder('cccccccc-3333-4333-8333-333333333333', KEY, [0, 2, 1], 3))

    const list = cache.list()
    expect(list).toHaveLength(1)
    expect((list[0] as { structural: { order: number[] } }).structural.order).toEqual([0, 2, 1])
  })

  it('keeps reorders of DIFFERENT container instances separate', () => {
    // The parentKey payoff: two renders of one component are independent
    // containers, and collapsing them would lose one of the user's edits.
    const cache = new StagedEditsCache()
    cache.append(reorder('aaaaaaaa-1111-4111-8111-111111111111', 'body>ul:nth-child(1)', [1, 0, 2], 1))
    cache.append(reorder('bbbbbbbb-2222-4222-8222-222222222222', 'body>ul:nth-child(2)', [2, 1, 0], 2))
    expect(cache.list()).toHaveLength(2)
  })

  it('still collapses repeated STYLE edits at one locus', () => {
    // The other half of the contract: the structural key must not disturb the
    // dedupe style edits have always relied on.
    const cache = new StagedEditsCache()
    cache.append(pendingEditSchema.parse(style({ value: 'red', timestamp: 1 })) as never)
    cache.append(pendingEditSchema.parse(
      style({ intentId: '33333333-3333-4333-8333-333333333333', value: 'green', timestamp: 2 }),
    ) as never)

    const list = cache.list()
    expect(list).toHaveLength(1)
    expect((list[0] as { value: string }).value).toBe('green')
  })
})

describe('review findings — hardening', () => {
  it('does not throw when `kind` is a throwing getter', () => {
    // safeParse must never throw. Returning the ORIGINAL value from the catch
    // was not enough: the discriminated union reads `.kind` itself, so the same
    // accessor threw again one frame later.
    const hostile = { ...style(), get kind(): string { throw new Error('boom') } }
    expect(() => pendingEditSchema.safeParse(hostile)).not.toThrow()
    expect(pendingEditSchema.safeParse(hostile).success).toBe(false)
  })

  it.each([[null], [[]], ['a string'], [42]])('passes non-object input %s through without throwing', (input) => {
    expect(() => pendingEditSchema.safeParse(input)).not.toThrow()
    expect(pendingEditSchema.safeParse(input).success).toBe(false)
  })

  it('bounds the server cache so a lost eviction sync cannot leak forever', () => {
    // The cache had no cap and relied on the browser mirroring its FIFO across
    // two separate channel sends; if the tab died between them the orphan was
    // permanent, and mergeFullSync cannot delete keys absent from a payload.
    const cache = new StagedEditsCache()
    for (let i = 0; i < 1200; i++) {
      const id = `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
      cache.append(pendingEditSchema.parse(
        structural({ intentId: id, timestamp: i }, { parentKey: `body>ul:nth-child(${i})` }),
      ) as never)
    }
    expect(cache.list().length).toBeLessThanOrEqual(1000)
    const kept = cache.list() as Array<{ timestamp: number }>
    expect(Math.max(...kept.map(e => e.timestamp))).toBe(1199)
  })
})
