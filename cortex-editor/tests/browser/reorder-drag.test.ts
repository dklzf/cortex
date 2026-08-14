import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  beginPress,
  onPointerMove,
  onPointerUp,
  onCancel,
  IDLE,
  DRAG_THRESHOLD_PX,
  type ReorderDragState,
} from '../../src/browser/reorder-drag.js'
import * as dropTarget from '../../src/browser/drop-target.js'

/**
 * COR-7 (M1) — the drag state machine.
 *
 * The geometry lives in `drop-target` and is measured in real Chromium
 * (`drop-target-measured.spec.ts`); happy-dom returns a zero rect for
 * everything, so `resolveDropTarget` is STUBBED here. That is deliberate rather
 * than a shortcut: the property under test is when a press becomes a drag and
 * what a release produces, and mixing in unmeasurable layout would make every
 * assertion depend on a thing this DOM cannot do.
 */

function list(count: number): { container: Element; children: Element[] } {
  const host = document.createElement('div')
  host.innerHTML = `<ul>${Array.from({ length: count }, (_, i) => `<li>Row ${i}</li>`).join('')}</ul>`
  const container = host.firstElementChild!
  document.body.appendChild(host)
  return { container, children: Array.from(container.children) }
}

function stubDrop(toIndex: number): void {
  vi.spyOn(dropTarget, 'resolveDropTarget').mockReturnValue({ toIndex, axis: 'vertical' })
}

afterEach(() => { vi.restoreAllMocks() })

describe('beginPress', () => {
  it('captures the element position within its container', () => {
    const { children } = list(3)
    const state = beginPress(children[1]!, { x: 10, y: 10 })
    expect(state.phase).toBe('pressed')
    if (state.phase === 'idle') return
    expect(state.fromIndex).toBe(1)
  })

  it('refuses at PRESS time when the container has nothing to reorder', () => {
    // Declining here rather than at release lets the UI withhold the drag
    // affordance entirely, instead of letting the user drag a thing and only
    // then being told no.
    const { children } = list(1)
    expect(beginPress(children[0]!, { x: 0, y: 0 }).phase).toBe('idle')
  })

  it('refuses an element with no parent', () => {
    expect(beginPress(document.createElement('li'), { x: 0, y: 0 }).phase).toBe('idle')
  })
})

describe('the threshold', () => {
  const press = (): ReorderDragState => beginPress(list(3).children[0]!, { x: 100, y: 100 })

  it('does NOT become a drag below the threshold', () => {
    // Without this, every click on a row is a zero-distance drag that resolves
    // to some slot and stages a source edit. The user clicks to select and gets
    // a pending change they never asked for.
    stubDrop(1)
    const moved = onPointerMove(press(), { x: 100 + DRAG_THRESHOLD_PX - 1, y: 100 })
    expect(moved.phase).toBe('pressed')
  })

  it('becomes a drag at the threshold', () => {
    stubDrop(1)
    expect(onPointerMove(press(), { x: 100 + DRAG_THRESHOLD_PX, y: 100 }).phase).toBe('dragging')
  })

  it('treats the threshold as a CIRCLE, not a per-axis box', () => {
    // Comparing dx and dy separately makes a diagonal drag need ~1.4x the
    // travel of a straight one, which reads as the gesture being unresponsive
    // in one direction.
    //
    // The probe is chosen so the two rules DISAGREE: 3px on each axis is below
    // the threshold on both, so a per-axis rule stays pressed, while the
    // Euclidean distance is 4.24 and a circle promotes. An earlier version put
    // the probe at exactly the threshold distance and floating point decided
    // the outcome — a test on a knife edge asserts nothing about the design.
    stubDrop(1)
    const perAxis = DRAG_THRESHOLD_PX - 1
    expect(perAxis).toBeLessThan(DRAG_THRESHOLD_PX)
    expect(Math.hypot(perAxis, perAxis)).toBeGreaterThan(DRAG_THRESHOLD_PX)
    expect(onPointerMove(press(), { x: 100 + perAxis, y: 100 + perAxis }).phase).toBe('dragging')

    // And a diagonal genuinely inside the circle still does not promote.
    const inside = 1
    expect(Math.hypot(inside, inside)).toBeLessThan(DRAG_THRESHOLD_PX)
    expect(onPointerMove(press(), { x: 100 + inside, y: 100 + inside }).phase).toBe('pressed')
  })

  it('re-resolves the slot on every move rather than accumulating', () => {
    // The pointer is the only input, so there is no carried state to drift.
    stubDrop(2)
    let s = onPointerMove(press(), { x: 200, y: 200 })
    expect(s.phase === 'dragging' && s.toIndex).toBe(2)
    vi.restoreAllMocks()
    stubDrop(0)
    s = onPointerMove(s, { x: 100, y: 0 })
    expect(s.phase === 'dragging' && s.toIndex).toBe(0)
  })

  it('holds the last known slot when the container stops resolving mid-drag', () => {
    // Children removed under a held pointer. Inventing a slot here would stage
    // a reorder against a list that no longer exists; holding lets the release
    // re-resolve and refuse.
    stubDrop(2)
    const dragging = onPointerMove(press(), { x: 200, y: 200 })
    vi.restoreAllMocks()
    vi.spyOn(dropTarget, 'resolveDropTarget').mockReturnValue(null)
    const held = onPointerMove(dragging, { x: 300, y: 300 })
    expect(held.phase === 'dragging' && held.toIndex).toBe(2)
  })
})

describe('release and cancel', () => {
  it('a press that never crossed the threshold is a CLICK and stages nothing', () => {
    stubDrop(1)
    const pressed = beginPress(list(3).children[0]!, { x: 10, y: 10 })
    const { state, result } = onPointerUp(pressed)
    expect(state.phase).toBe('idle')
    expect(result).toBeUndefined()
  })

  it('a real drag produces the producer verdict', () => {
    stubDrop(2)
    const { children } = list(3)
    const dragging = onPointerMove(beginPress(children[0]!, { x: 10, y: 10 }), { x: 200, y: 200 })
    const { state, result } = onPointerUp(dragging)
    expect(state.phase).toBe('idle')
    expect(result?.ok).toBe(true)
  })

  it('surfaces a REFUSAL rather than swallowing it', () => {
    // Rows with no text and no authored identity cannot produce distinct keys,
    // so the producer refuses. The gesture must hand that reason back, not drop
    // it — a drag that silently does nothing is indistinguishable from a bug.
    stubDrop(1)
    const host = document.createElement('div')
    host.innerHTML = '<ul><li></li><li></li></ul>'
    document.body.appendChild(host)
    const container = host.firstElementChild!
    const dragging = onPointerMove(
      beginPress(container.children[0]!, { x: 10, y: 10 }),
      { x: 200, y: 200 },
    )
    const { result } = onPointerUp(dragging)
    expect(result?.ok).toBe(false)
    if (result?.ok !== false) return
    expect(result.reason).toMatch(/identical/i)
  })

  it('cancel returns to idle and can never stage', () => {
    // Escape must not be a coin flip on whether the user's source changes.
    expect(onCancel()).toEqual(IDLE)
  })

  it('a move from idle stays idle', () => {
    expect(onPointerMove(IDLE, { x: 5, y: 5 })).toEqual(IDLE)
  })
})

// Review round 3 on #196 — the release path trusted a press-time index, and
// the producer left attributes behind on a refusal.
describe('release re-derives the dragged element', () => {
  it('REFUSES when a sibling was inserted under the held pointer', () => {
    // `fromIndex` names a POSITION. If the app inserts a row above the dragged
    // one mid-drag, that position now holds a different element and the release
    // would build a perfectly valid intent for the wrong child. `toIndex` was
    // also resolved against the old arrangement, so the whole gesture is
    // refused rather than reinterpreted.
    stubDrop(2)
    const { container, children } = list(3)
    const dragging = onPointerMove(beginPress(children[0]!, { x: 10, y: 10 }), { x: 200, y: 200 })

    const inserted = document.createElement('li')
    inserted.textContent = 'Injected'
    container.insertBefore(inserted, container.firstElementChild)

    const { result } = onPointerUp(dragging)
    expect(result?.ok).toBe(false)
    if (result?.ok !== false) return
    expect(result.reason).toMatch(/changed while you were dragging/i)
  })

  it('REFUSES when the dragged element left the container', () => {
    stubDrop(2)
    const { children } = list(3)
    const dragging = onPointerMove(beginPress(children[0]!, { x: 10, y: 10 }), { x: 200, y: 200 })
    children[0]!.remove()

    const { result } = onPointerUp(dragging)
    expect(result?.ok).toBe(false)
    if (result?.ok !== false) return
    expect(result.reason).toMatch(/no longer in this list/i)
  })

  it('still stages when the list did NOT change', () => {
    // The control: re-deriving must not make every drag refuse.
    stubDrop(2)
    const { children } = list(3)
    const dragging = onPointerMove(beginPress(children[0]!, { x: 10, y: 10 }), { x: 200, y: 200 })
    expect(onPointerUp(dragging).result?.ok).toBe(true)
  })
})
