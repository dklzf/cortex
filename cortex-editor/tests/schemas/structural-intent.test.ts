import { describe, it, expect } from 'vitest'
import { pendingEditSchema, isStructuralEdit } from '../../src/schemas/pending-edit.js'
import { StagedEditsCache } from '../../src/core/staged-edits.js'

/**
 * B2 — the pipeline can now carry a structural intent.
 *
 * Two properties matter and neither is expressible in the style shape:
 *   1. A move must never be routed to the deterministic path. The mechanizable
 *      edit is `style={{ order: N }}`, which changes visual order WITHOUT
 *      changing DOM order and silently breaks screen-reader sequence and tab
 *      order. Enforced in the schema so no producer can opt out.
 *   2. A move log is ORDERED. Last-write-wins dedupe by locus is correct for a
 *      style edit and destroys a move sequence.
 */

const HINT = { tagName: 'button', textPreview: 'Export', domSelector: 'div > button:nth-child(1)' }

function structural(over: Record<string, unknown> = {}) {
  return {
    kind: 'structural',
    intentId: '11111111-1111-4111-8111-111111111111',
    source: 'src/App.tsx:12:4',
    applyMode: 'agent-resolve',
    sourceResolutionHint: HINT,
    structural: { op: 'move', parentSource: 'src/App.tsx:10:2', fromIndex: 0, toIndex: 2 },
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
  it('accepts a well-formed move', () => {
    const parsed = pendingEditSchema.safeParse(structural())
    expect(parsed.success).toBe(true)
  })

  it('REJECTS a structural intent routed to the deterministic path', () => {
    // The a11y guarantee. If this ever passes, a move can reach
    // InlineStyleRewriter and be written as `style={{ order: N }}`.
    const parsed = pendingEditSchema.safeParse(structural({ applyMode: 'direct' }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.join('.') === 'applyMode')).toBe(true)
    }
  })

  it('rejects a no-op move rather than staging an intent that changes nothing', () => {
    const parsed = pendingEditSchema.safeParse(
      structural({ structural: { op: 'move', parentSource: 'src/App.tsx:10:2', fromIndex: 1, toIndex: 1 } }),
    )
    expect(parsed.success).toBe(false)
  })

  it('rejects a negative or fractional index', () => {
    for (const bad of [-1, 1.5]) {
      const parsed = pendingEditSchema.safeParse(
        structural({ structural: { op: 'move', parentSource: 'src/App.tsx:10:2', fromIndex: 0, toIndex: bad } }),
      )
      expect(parsed.success).toBe(false)
    }
  })
})

describe('back-compat — style intents are unchanged on the wire', () => {
  it('accepts a style intent with NO kind field, as older bundles send', () => {
    const parsed = pendingEditSchema.safeParse(style())
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(isStructuralEdit(parsed.data)).toBe(false)
  })

  it('still rejects a bad timestamp at path "timestamp", not inside a union blob', () => {
    // Regression guard: a plain z.union attempts every member and reports a
    // nested invalid_union, which destroyed the specific path the UI shows.
    // The discriminated union must keep reporting the real field.
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

describe('the move log survives the staging buffer', () => {
  const move = (id: string, fromIndex: number, toIndex: number, timestamp: number) =>
    structural({ intentId: id, structural: { op: 'move', parentSource: 'src/App.tsx:10:2', fromIndex, toIndex }, timestamp })

  it('keeps every move on ONE element, in order', () => {
    // The defect this exists to prevent: last-write-wins keyed by locus
    // collapses "A→2 then A→0" to a single entry, so replaying the log lands
    // the element somewhere the user never dragged it.
    const cache = new StagedEditsCache()
    cache.append(pendingEditSchema.parse(move('aaaaaaaa-1111-4111-8111-111111111111', 0, 2, 1)) as never)
    cache.append(pendingEditSchema.parse(move('bbbbbbbb-2222-4222-8222-222222222222', 2, 0, 2)) as never)

    const list = cache.list()
    expect(list).toHaveLength(2)
    expect(list.map(e => (e as { structural: { toIndex: number } }).structural.toIndex)).toEqual([2, 0])
  })

  it('still collapses repeated STYLE edits at one locus', () => {
    // The other half of the contract: exempting structural must not disable
    // dedupe for the case it was built for.
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
