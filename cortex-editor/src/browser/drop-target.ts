/**
 * Where a dragged child would land (COR-7, M1 — the gesture's geometric core).
 *
 * Pure over a container, a pointer position and the dragged index. The pointer
 * PLUMBING — capture, threshold, drop indicator, Shadow DOM hit-testing — is
 * the rest of the gesture; this is the part that decides which slot the user is
 * pointing at, and it is the part that can be wrong in a way no screenshot
 * shows.
 *
 * ## Measured, not predicted from CSS
 *
 * Nothing here reads `flex-direction`, `direction`, `writing-mode` or
 * `grid-auto-flow`. Predicting the axis from those means a combinatorial table
 * — `row`/`column` × `-reverse` × `rtl` × vertical writing modes × grid
 * auto-flow — and COR-3 already established what that costs: the CSS-prediction
 * version of `edgeResponse` was replaced with a measurement precisely because
 * the table was never complete.
 *
 * Bounding rects subsume all of it. Whichever axis the children's centres
 * actually spread along IS the axis, and if the LAST child's centre sits before
 * the first's, the layout is visually reversed no matter which of those seven
 * properties caused it.
 */

/** How the children are laid out, as measured. */
export type DropAxis = 'vertical' | 'horizontal' | 'grid'

export interface DropTarget {
  /**
   * The index to pass to `buildReorderIntent` as `toIndex` — a position in the
   * list WITH THE DRAGGED CHILD REMOVED, which is the coordinate system
   * `reorderPermutation` splices into.
   */
  toIndex: number
  /** The measured layout, for the drop indicator to orient itself. */
  axis: DropAxis
}

interface Measured {
  /** Index in the container's full child list. */
  index: number
  centerX: number
  centerY: number
  top: number
  bottom: number
  left: number
  right: number
}

/**
 * How many bands the items fall into along one axis — a "band" being a run of
 * items whose extents overlap, i.e. what a person would call a row or a column.
 *
 * Overlap, not centre spread. The first version compared how far the centres
 * ranged on each axis and called it a grid when the two were within 2×, and
 * real layout refuted it twice in one run: a vertical list of ragged widths
 * (80/300/150) has centres spread 110px horizontally and 40px vertically, so it
 * measured as HORIZONTAL — the axis its rows are least aligned on. Centres are a
 * proxy; overlap is the thing itself.
 */
function bandCount(items: readonly Measured[], axis: 'y' | 'x'): number {
  const start = (m: Measured): number => (axis === 'y' ? m.top : m.left)
  const end = (m: Measured): number => (axis === 'y' ? m.bottom : m.right)
  const sorted = [...items].sort((a, b) => start(a) - start(b))
  let bands = 0
  let reach = -Infinity
  for (const item of sorted) {
    // Greater-or-EQUAL, and the `=` is load-bearing: stacked rows share an edge
    // (row 1 ends at 40, row 2 starts at 40), touching is not overlapping, so a
    // shared edge must start a new band. Changing this to `>` merges every
    // adjacent row into one band and grid detection stops working.
    if (start(item) >= reach) { bands += 1; reach = end(item) }
    else reach = Math.max(reach, end(item))
  }
  return bands
}

/**
 * The dominant axis, and whether it runs backwards on screen.
 *
 * `grid` when the items form more than one band on BOTH axes — a wrapped flex
 * row or a multi-row grid. A midpoint rule along a single axis is meaningless
 * there, because the last item of row 1 and the first of row 2 are adjacent in
 * DOM order and far apart on screen.
 */
function measureAxis(items: readonly Measured[]): { axis: DropAxis; reversed: boolean } {
  const rows = bandCount(items, 'y')
  const cols = bandCount(items, 'x')
  if (rows > 1 && cols > 1) return { axis: 'grid', reversed: false }

  // More rows than columns means the items are stacked: vertical. The tie at
  // 1×1 (a single item, or fully overlapping ones) resolves to vertical, which
  // is the reading order a list defaults to.
  const axis: DropAxis = rows >= cols ? 'vertical' : 'horizontal'
  const along = (m: Measured): number => (axis === 'vertical' ? m.centerY : m.centerX)
  // DOM order versus screen order. `row-reverse` and `direction: rtl` both put
  // child 0 on the right; measuring says so without either being named here.
  const reversed = items.length > 1 && along(items[items.length - 1]!) < along(items[0]!)
  return { axis, reversed }
}

/**
 * Resolve the pointer to a drop slot.
 *
 * Returns `null` when there is nothing to resolve — fewer than two children, an
 * out-of-range `fromIndex`, or a container whose children have no box at all
 * (every rect zero-area, which is what `display: none` and a detached tree both
 * look like). A null is a "do not stage anything", never a guessed index: this
 * feeds a source rewrite, and a plausible-looking wrong slot is worse than no
 * drop at all.
 */
export function resolveDropTarget(
  container: Element,
  pointer: { x: number; y: number },
  fromIndex: number,
): DropTarget | null {
  const children = Array.from(container.children)
  if (children.length < 2) return null
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= children.length) return null

  // The dragged child is excluded from the measurement AND from the coordinate
  // system. `reorderPermutation` splices it out before inserting, so `toIndex`
  // counts positions in the list without it — computing against the full list
  // produces an off-by-one for every drop past the dragged element's own slot.
  const others: Measured[] = []
  for (let i = 0; i < children.length; i += 1) {
    if (i === fromIndex) continue
    const rect = children[i]!.getBoundingClientRect()
    // Zero-area children carry no position worth comparing; including them
    // would put a `display: none` sibling's centre at the viewport origin and
    // drag every drop toward index 0.
    if (rect.width === 0 && rect.height === 0) continue
    others.push({
      index: i,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    })
  }
  if (others.length === 0) return null

  const { axis, reversed } = measureAxis(others)

  if (axis === 'grid') {
    // Nearest centre, then before/after by which side of it the pointer sits.
    // A midpoint rule needs an ordering, and a wrapped layout has none along a
    // single axis — the last item of row 1 and the first of row 2 are adjacent
    // in DOM order and far apart on screen.
    let nearest = 0
    let best = Infinity
    for (let k = 0; k < others.length; k += 1) {
      const dx = others[k]!.centerX - pointer.x
      const dy = others[k]!.centerY - pointer.y
      const d = dx * dx + dy * dy
      if (d < best) { best = d; nearest = k }
    }
    // Which SIDE of that cell, in reading order. The first version compared y
    // and only fell back to x on an exact tie — which measured coordinates
    // essentially never produce, so the x comparison was dead. A pointer in the
    // upper half of a cell resolved to "before" it even when sitting well to
    // its right: at (190,15), right of the cell centred at (150,20), the answer
    // was that cell's own index instead of the slot after it. Plausible, and
    // wrong, which is the class this module exists to avoid.
    //
    // Inside the nearest cell's row band the HORIZONTAL side decides; outside
    // it the vertical one does. That is reading order — across a row, then down.
    const n = others[nearest]!
    const withinRow = pointer.y >= n.top && pointer.y <= n.bottom
    const past = withinRow ? pointer.x > n.centerX : pointer.y > n.centerY
    return { toIndex: past ? nearest + 1 : nearest, axis }
  }

  const alongPointer = axis === 'vertical' ? pointer.y : pointer.x
  const alongItem = (m: Measured): number => (axis === 'vertical' ? m.centerY : m.centerX)

  // Count the slots the pointer has passed. `reversed` flips the comparison
  // rather than the array, so the returned index stays in DOM order — which is
  // the only order `baseline` and `order` are expressed in.
  let toIndex = 0
  for (const item of others) {
    const passed = reversed ? alongPointer < alongItem(item) : alongPointer > alongItem(item)
    if (passed) toIndex += 1
  }
  return { toIndex, axis }
}
