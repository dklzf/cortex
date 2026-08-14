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
 * Whether DOM order runs right-to-left WITHIN a row of a wrapped layout.
 *
 * A grid has no single axis to read reversal off, so it is read per row: take
 * the first band of items that share a row and compare the DOM-first against
 * the DOM-last. Under `direction: rtl` or `row-reverse` the later child sits
 * further left, and treating `pointer.x > centerX` as "past" would then stage
 * the OPPOSITE reorder — the reading order is mirrored, so the sides are too.
 */
function gridRowReversed(items: readonly Measured[]): boolean {
  const first = items[0]
  if (!first) return false
  // Items sharing the first item's row band, in DOM order.
  const row = items.filter(m => m.top < first.bottom && m.bottom > first.top)
  if (row.length < 2) return false
  return row[row.length - 1]!.centerX < row[0]!.centerX
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

  // Two populations, and conflating them was two separate bugs.
  //
  // `laidOut` — every child with a box, INCLUDING the dragged one — is what the
  // AXIS is measured from. Excluding the dragged child leaves a two-item row
  // with a single rectangle, `rows` and `cols` are both 1, the tie resolves to
  // vertical, and dragging the first of two side-by-side buttons to the far
  // right compares only the unchanged Y — returning slot 0, which the producer
  // then refuses as a no-op. The axis is a property of the CONTAINER, so it is
  // measured from everything in it.
  //
  // `others` — the same minus the dragged child — is what SLOTS are counted
  // from, because `reorderPermutation` splices the dragged child out before
  // inserting.
  const laidOut: Measured[] = []
  const others: Measured[] = []
  for (let i = 0; i < children.length; i += 1) {
    const rect = children[i]!.getBoundingClientRect()
    // Zero-area children carry no position worth comparing; including them
    // would put a `display: none` sibling's centre at the viewport origin and
    // drag every drop toward index 0.
    if (rect.width === 0 && rect.height === 0) continue
    const m: Measured = {
      index: i,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    }
    laidOut.push(m)
    if (i !== fromIndex) others.push(m)
  }
  if (others.length === 0) return null

  const { axis, reversed } = measureAxis(laidOut)

  /**
   * Convert a slot in the MEASURED list back to one in the full post-removal
   * DOM child list — the coordinate system `reorderPermutation` splices into.
   *
   * These differ whenever a child was skipped for having no box. For
   * `[dragged, hidden, visible]` the measured list is just `[visible]`, so a
   * drop after it is measured-slot 1 — and applied to the full list that means
   * "position 1", producing `[hidden, dragged, visible]`: the visible order
   * unchanged, which is not what the user did. Mapping through the retained DOM
   * `index` gives 2, and the drop lands after the visible child.
   */
  const toDomSlot = (measuredSlot: number): number => {
    if (measuredSlot >= others.length) return children.length - 1
    const domIndex = others[measuredSlot]!.index
    return domIndex - (domIndex > fromIndex ? 1 : 0)
  }

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
    // Rows can run right-to-left, and then the sides mirror too — `pointer.x >
    // centreX` would otherwise stage the opposite reorder on an RTL grid.
    // Measured from the laid-out cells rather than read off `direction`, same
    // as everything else here.
    const rtlRow = gridRowReversed(laidOut)
    const pastX = rtlRow ? pointer.x < n.centerX : pointer.x > n.centerX
    const past = withinRow ? pastX : pointer.y > n.centerY
    return { toIndex: toDomSlot(past ? nearest + 1 : nearest), axis }
  }

  const alongPointer = axis === 'vertical' ? pointer.y : pointer.x
  const alongItem = (m: Measured): number => (axis === 'vertical' ? m.centerY : m.centerX)

  // The counting loop below turns the pointer's VISUAL rank into a DOM
  // insertion index, and that identification only holds while visual order and
  // DOM order agree. CSS `order` can break it arbitrarily: DOM `[A,B,C,D]`
  // displayed as `[A,C,B,D]` leaves `reversed` false — first and last are still
  // in order — while B and C are transposed in the middle. Dropping between the
  // visually adjacent C and B then stages a different position, or a no-op.
  //
  // Refused rather than mapped. A general visual-to-DOM mapping is a real
  // feature and this is not the place to invent it silently; a reorder cortex
  // cannot describe is one it should decline, which is the same call every
  // other refusal here makes.
  const monotonic = others.every((m, i) => i === 0
    || (reversed ? alongItem(m) <= alongItem(others[i - 1]!) : alongItem(m) >= alongItem(others[i - 1]!)))
  if (!monotonic) return null

  // Count the slots the pointer has passed. `reversed` flips the comparison
  // rather than the array, so the returned index stays in DOM order — which is
  // the only order `baseline` and `order` are expressed in.
  let measuredSlot = 0
  for (const item of others) {
    const passed = reversed ? alongPointer < alongItem(item) : alongPointer > alongItem(item)
    if (passed) measuredSlot += 1
  }
  return { toIndex: toDomSlot(measuredSlot), axis }
}

/** A viewport-coordinate line, for the drop indicator to render. */
export interface DropIndicatorRect {
  left: number
  top: number
  width: number
  height: number
}

/** Thickness of the indicator line, in CSS pixels. */
const INDICATOR_PX = 2

/**
 * Where to draw the "it will land here" line for a resolved drop.
 *
 * Measured from the same rects the resolution used, so the line cannot claim a
 * boundary the resolver did not pick — the failure that makes a drag feel
 * possessed is an indicator drawn one slot away from where the release lands.
 *
 * Returns `null` when there is nothing to draw, on the same terms
 * `resolveDropTarget` returns null.
 */
export function dropIndicatorRect(
  container: Element,
  fromIndex: number,
  toIndex: number,
): DropIndicatorRect | null {
  const children = Array.from(container.children)
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= children.length) return null

  const others: Measured[] = []
  for (let i = 0; i < children.length; i += 1) {
    if (i === fromIndex) continue
    const rect = children[i]!.getBoundingClientRect()
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

  // `toIndex` arrives in full post-removal DOM coordinates (see `toDomSlot`),
  // and this function counts in MEASURED slots — the two differ whenever a
  // child was skipped for having no box. Map back by finding the first measured
  // item at or after the requested DOM position, or the end.
  const postRemoval = (m: Measured): number => m.index - (m.index > fromIndex ? 1 : 0)
  let clamped = others.length
  for (let k = 0; k < others.length; k += 1) {
    if (postRemoval(others[k]!) >= toIndex) { clamped = k; break }
  }
  // The axis comes from every laid-out child, including the dragged one — a
  // two-item row measured without it has one rectangle and always ties to
  // vertical. Same reason as in `resolveDropTarget`.
  const laidOutAll = others.slice()
  const draggedRect = children[fromIndex]!.getBoundingClientRect()
  if (draggedRect.width !== 0 || draggedRect.height !== 0) {
    laidOutAll.push({
      index: fromIndex,
      centerX: draggedRect.left + draggedRect.width / 2,
      centerY: draggedRect.top + draggedRect.height / 2,
      top: draggedRect.top,
      bottom: draggedRect.bottom,
      left: draggedRect.left,
      right: draggedRect.right,
    })
    laidOutAll.sort((a, b) => a.index - b.index)
  }
  const { axis, reversed } = measureAxis(laidOutAll)

  // The slot is a BOUNDARY, so it is described by the item on each side of it.
  // At the ends only one exists, and the line sits on that item's outer edge.
  const before = clamped > 0 ? others[clamped - 1]! : null
  const after = clamped < others.length ? others[clamped]! : null

  if (axis === 'vertical') {
    const span = others.reduce(
      (acc, m) => ({ left: Math.min(acc.left, m.left), right: Math.max(acc.right, m.right) }),
      { left: Infinity, right: -Infinity },
    )
    // `reversed` swaps which neighbour is visually above, and the midpoint of
    // the two edges keeps the line centred in whatever gap the layout leaves.
    const lo = reversed ? after : before
    const hi = reversed ? before : after
    const y = lo && hi ? (lo.bottom + hi.top) / 2 : lo ? lo.bottom : hi!.top
    return { left: span.left, top: y - INDICATOR_PX / 2, width: span.right - span.left, height: INDICATOR_PX }
  }

  // Horizontal and grid both draw a VERTICAL line: in a wrapped layout the
  // insertion point is still between two cells in reading order, and a
  // horizontal rule there would read as "between rows" rather than "here".
  const rowSource = after ?? before!
  const lo = reversed ? after : before
  const hi = reversed ? before : after
  const x = lo && hi && lo.bottom > hi.top && lo.top < hi.bottom
    // Same row: the gap between them.
    ? (lo.right + hi.left) / 2
    : lo && !hi ? lo.right
    : hi && !lo ? hi.left
    // Different rows (a wrap boundary): pin to the incoming cell's leading
    // edge rather than spanning the gap, which would draw across the page.
    : (reversed ? rowSource.right : rowSource.left)
  return {
    left: x - INDICATOR_PX / 2,
    top: rowSource.top,
    width: INDICATOR_PX,
    height: rowSource.bottom - rowSource.top,
  }
}
