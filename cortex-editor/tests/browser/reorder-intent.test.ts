import { describe, it, expect } from 'vitest'
import {
  buildReorderIntent,
  reorderPermutation,
  containerInstanceKey,
} from '../../src/browser/reorder-intent.js'
import { pendingEditSchema, MAX_INTENT_INSTANCE_SOURCES } from '../../src/schemas/pending-edit.js'
import { PREVIEW_SOURCE_PREFIX } from '../../src/shared/preview-source.js'

/**
 * COR-7 (M1) — the producer half of the move slice.
 *
 * Pure over a container and two indices, so what gets WRITTEN TO SOURCE can be
 * pinned exhaustively without simulating a pointer. The gesture is the other
 * half and carries the interaction risk; this carries the correctness risk.
 */

function mount(html: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  const el = host.firstElementChild!
  document.body.appendChild(host)
  return el
}

/** A `.map()`-shaped list: one shared source, distinct text. The motivating case. */
function mapList(...labels: string[]): Element {
  return mount(
    `<ul>${labels.map(l => `<li data-cortex-source="src/List.tsx:15:11">${l}</li>`).join('')}</ul>`,
  )
}

const structuralOf = (intent: unknown) =>
  (intent as { structural: { baseline: string[]; childKeys: string[]; order: number[]; parentKey: string; parentSource: string } }).structural

describe('reorderPermutation', () => {
  it.each([
    ['last to first', 3, 2, 0, [2, 0, 1]],
    ['first to last', 3, 0, 2, [1, 2, 0]],
    ['adjacent swap', 3, 0, 1, [1, 0, 2]],
    ['middle back one', 4, 2, 1, [0, 2, 1, 3]],
  ])('%s', (_label, length, from, to, expected) => {
    expect(reorderPermutation(length, from, to)).toEqual(expected)
  })

  it('states the intended RESULT, so applying it twice is the same as once', () => {
    // Idempotence is the property the absolute encoding was chosen for — it is
    // what lets one intent be dropped, retried or merged without invalidating
    // any other. A from/to pair could not promise it.
    const order = reorderPermutation(3, 2, 0)
    const items = ['a', 'b', 'c']
    const applied = order.map(i => items[i]!)
    const twice = order.map(i => applied[i]!)
    expect(applied).toEqual(['c', 'a', 'b'])
    expect(order.map(i => applied[i]!)).toEqual(twice)
  })
})

describe('containerInstanceKey', () => {
  it('distinguishes two renders of the SAME component', () => {
    // The case `parentKey` exists for: `<Column/>` twice with identical rows
    // gives both containers the same parentSource and every row the same
    // source, so without this the two reorders are byte-identical.
    const wrap = mount('<div><ul id="a"><li>x</li></ul><ul id="b"><li>y</li></ul></div>')
    const [first, second] = Array.from(wrap.children)
    expect(containerInstanceKey(first!)).not.toBe(containerInstanceKey(second!))
  })

  it('is stable for the same node across calls', () => {
    const ul = mapList('Alpha', 'Bravo')
    expect(containerInstanceKey(ul)).toBe(containerInstanceKey(ul))
  })
})

describe('buildReorderIntent — the happy path', () => {
  it('produces an intent that passes the SERVER schema', () => {
    // Not a shape assertion: this is the same validator the wire boundary runs,
    // so a producer bug becomes a refusal the user sees rather than a gesture
    // that vanishes at the server with no explanation.
    const ul = mapList('Alpha', 'Bravo', 'Charlie')
    const result = buildReorderIntent(ul, 2, 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(pendingEditSchema.safeParse(result.intent).success).toBe(true)
  })

  it('carries childKeys that can witness the reorder', () => {
    // The COR-35 contract. `baseline` is three identical strings here — that is
    // the whole problem — so childKeys is the only array that names the rows.
    const ul = mapList('Alpha', 'Bravo', 'Charlie')
    const result = buildReorderIntent(ul, 2, 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const s = structuralOf(result.intent)
    expect(new Set(s.baseline).size).toBe(1)
    expect(s.childKeys).toEqual(['#li:Alpha', '#li:Bravo', '#li:Charlie'])
    expect(s.order).toEqual([2, 0, 1])
  })

  it('addresses the dragged child by a PREVIEW source, not its shared anchor', () => {
    // Two reasons landing on one answer: the schema forces agent-resolve for
    // structural intents, and the guard resolves `source` through a
    // first-seen-wins document index — a shared `data-cortex-source` would
    // resolve to some OTHER container's row.
    const ul = mapList('Alpha', 'Bravo')
    const result = buildReorderIntent(ul, 1, 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.intent as { source: string }).source.startsWith(PREVIEW_SOURCE_PREFIX)).toBe(true)
    expect((result.intent as { applyMode: string }).applyMode).toBe('agent-resolve')
  })

  it('gives two renders of one component DIFFERENT payloads', () => {
    // Byte-identical intents for two different containers is the failure
    // `parentKey` was added to prevent; this is that failure as a test.
    const wrap = mount(
      '<div>' +
      '<ul><li data-cortex-source="src/L.tsx:9:5">a</li><li data-cortex-source="src/L.tsx:9:5">b</li></ul>' +
      '<ul><li data-cortex-source="src/L.tsx:9:5">a</li><li data-cortex-source="src/L.tsx:9:5">b</li></ul>' +
      '</div>',
    )
    const [first, second] = Array.from(wrap.children)
    const a = buildReorderIntent(first!, 1, 0)
    const b = buildReorderIntent(second!, 1, 0)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(structuralOf(a.intent).parentKey).not.toBe(structuralOf(b.intent).parentKey)
  })

  it('makes every child readable back from the DOM', () => {
    // The baseline has to be re-derivable by the guard, which reads WITHOUT
    // minting. An unstamped child with no preview id reads back as '' — and two
    // of those are indistinguishable to the comparison meant to tell them apart.
    const ul = mount('<ul><li>Alpha</li><li>Bravo</li></ul>')
    const result = buildReorderIntent(ul, 1, 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const child of Array.from(ul.children)) {
      expect(child.getAttribute('data-cortex-preview-id')).toBeTruthy()
    }
    expect(structuralOf(result.intent).baseline.every(s => s.startsWith(PREVIEW_SOURCE_PREFIX))).toBe(true)
  })
})

describe('buildReorderIntent — refusals', () => {
  it('refuses a container with fewer than two children', () => {
    const result = buildReorderIntent(mount('<ul><li>only</li></ul>'), 0, 0)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/at least two/i)
  })

  it('refuses a no-op move with a message about the gesture, not the encoding', () => {
    // The schema rejects the identity permutation too. This branch exists so the
    // user reads "already in this position" rather than a sentence about
    // permutations of baseline indices.
    const result = buildReorderIntent(mapList('Alpha', 'Bravo'), 1, 1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/already in this position/i)
  })

  it('refuses indices the container does not have', () => {
    const result = buildReorderIntent(mapList('Alpha', 'Bravo'), 0, 7)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('2 items')
  })

  it('refuses a list longer than the wire cap, naming the limit', () => {
    const many = Array.from({ length: MAX_INTENT_INSTANCE_SOURCES + 1 }, (_, i) => `Row ${i}`)
    const result = buildReorderIntent(mapList(...many), 1, 0)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain(String(MAX_INTENT_INSTANCE_SOURCES))
  })

  it('REFUSES when two children are indistinguishable, rather than guessing', () => {
    // The load-bearing refusal. Without distinct keys the drift guard cannot
    // see a reorder, so nothing downstream could catch a stale intent — staging
    // it would be the silent-wrong write this whole path exists to prevent.
    const ul = mount(
      '<ul>' +
      '<li data-cortex-source="src/L.tsx:9:5">Alpha</li>' +
      '<li data-cortex-source="src/L.tsx:9:5"></li>' +
      '<li data-cortex-source="src/L.tsx:9:5"></li>' +
      '</ul>',
    )
    const result = buildReorderIntent(ul, 2, 0)
    expect(result.ok).toBe(false)
    if (result.ok) return
    // Positions the user can check against the screen, in 1-based terms.
    expect(result.reason).toContain('Items 2 and 3')
    // And WHY, actionably — an identical-looking pair is not self-explanatory.
    expect(result.reason).toMatch(/id/i)
  })

  it('does NOT refuse identical text when an authored attribute separates them', () => {
    // The escalation from COR-35's review has to actually reach this decision:
    // two blank rows with distinct ids are reorderable, and refusing them would
    // be the false negative that makes the feature feel broken.
    const ul = mount(
      '<ul>' +
      '<li data-testid="row" id="a"></li>' +
      '<li data-testid="row" id="b"></li>' +
      '</ul>',
    )
    expect(buildReorderIntent(ul, 1, 0).ok).toBe(true)
  })

  it('mints no attributes on a refused gesture', () => {
    // A refusal must leave no trace on a tree the user never edited — stray
    // preview ids would change what a LATER capture reads back.
    const ul = mount('<ul><li>Alpha</li><li>Bravo</li></ul>')
    buildReorderIntent(ul, 1, 1)
    expect(ul.querySelector('[data-cortex-preview-id]')).toBeNull()
    expect(ul.getAttribute('data-cortex-preview-id')).toBeNull()
  })
})

// Review round 1 on #196 — three findings, each a way the instance anchor or
// the refusal path stops doing its job.
describe('buildReorderIntent — review findings', () => {
  it('crosses shadow boundaries, so two web-component instances differ', () => {
    // `parentElement` is null for a top-level child of a shadow root, so a walk
    // that stops there returns a bare `ul` for EVERY instance. Two instances
    // whose containers share a transformed parentSource then produce the same
    // composite key, and staging a reorder in the second silently displaces the
    // first — the exact collision parentKey exists to prevent, reintroduced at
    // the one boundary parentElement cannot see through.
    const wrap = mount('<div><div id="h1"></div><div id="h2"></div></div>')
    const keys = Array.from(wrap.children).map(host => {
      const root = host.attachShadow({ mode: 'open' })
      root.innerHTML = '<ul><li>a</li><li>b</li></ul>'
      return containerInstanceKey(root.firstElementChild!)
    })
    expect(keys[0]).not.toBe(keys[1])
    expect(keys[0]).toContain('::shadow')
  })

  it('replaces a preview id another element already answers to', () => {
    // `ensurePreviewId` preserves an existing attribute, and that attribute is
    // page-controlled twice over — markup writes it, and cloneNode copies it.
    // The guard indexes preview sources first-seen-wins, so dragging the SECOND
    // of two elements sharing an id makes reconcile inspect the FIRST one's
    // parent, and a reorder can keep comparing clean while the container the
    // user touched drifts underneath it.
    const wrap = mount(
      '<div>' +
      '<ul><li data-cortex-preview-id="dupe">a</li><li>b</li></ul>' +
      '<ul><li data-cortex-preview-id="dupe">c</li><li>d</li></ul>' +
      '</div>',
    )
    const [first, second] = Array.from(wrap.children)
    const a = buildReorderIntent(first!, 0, 1)
    const b = buildReorderIntent(second!, 0, 1)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect((a.intent as { source: string }).source).not.toBe((b.intent as { source: string }).source)
  })

  it('refuses an oversized list WITHOUT deriving a key for every child', () => {
    // `childDiscriminators` reads each child's whole textContent subtree and
    // then runs collision passes. Doing that before the cheap shape checks
    // makes dragging inside a thousand-row table synchronously walk all of it
    // to produce a refusal the row count alone already decided.
    const rows = Array.from({ length: MAX_INTENT_INSTANCE_SOURCES + 1 }, () => '<li>x</li>').join('')
    const ul = mount(`<ul>${rows}</ul>`)
    // The descriptor lives on Element, not Node, in this DOM. Locating the
    // owner rather than assuming it is what makes this test falsifiable at all
    // — patching the wrong prototype intercepts nothing and the assertion holds
    // whichever order the production code runs in.
    const owner = Element.prototype
    const proto = Object.getOwnPropertyDescriptor(owner, 'textContent')
    expect(proto?.get).toBeTypeOf('function')
    let textReads = 0
    Object.defineProperty(owner, 'textContent', {
      ...proto!,
      get(this: Element) { textReads += 1; return proto!.get!.call(this) },
    })
    try {
      const result = buildReorderIntent(ul, 1, 0)
      expect(result.ok).toBe(false)
    } finally {
      Object.defineProperty(owner, 'textContent', proto!)
    }
    // Zero, not "fewer": the refusal is decided by childElementCount alone.
    expect(textReads).toBe(0)
  })
})
