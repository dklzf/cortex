import { isSizeInert } from './sizing-value.js'
/**
 * Who owns the edge you just grabbed (B3).
 *
 * ## The problem
 *
 * A resize gesture assumes the selected node owns its own size. It frequently
 * does not, and the naive edit — write `width` on the element — then produces a
 * result the user did not ask for. Measured in Chromium 147, each child asked
 * for +50px of width:
 *
 * | parent                          | width asked | width got | grabbed edge moved |
 * |---------------------------------|-------------|-----------|--------------------|
 * | `justify-content: flex-end`     | 200 → 250   | 250       | **0px**            |
 * | `justify-content: center`       | 200 → 250   | 250       | **25px**           |
 * | flex child with `flex: 1`       | 600 → 650   | **600**   | 0px                |
 * | grid `1fr 1fr` (grow)           | 300 → 350   | 350       | 50px, steals sibling |
 * | grid `1fr 1fr` (shrink)         | 300 → 250   | 250       | 50px, **layout inert** |
 *
 * Three distinct failures hide in there:
 *
 * 1. **`flex: 1` ignores `width` outright.** The flex algorithm resolves the
 *    main size from `flex-grow`/`flex-basis`; the used width never changes. The
 *    edit is written to source, the element does not move, and cortex looks
 *    broken.
 * 2. **A grid item's size fights its track, DIRECTIONALLY.** `1fr` is really
 *    `minmax(auto, 1fr)`, so the `auto` minimum means the track cannot be
 *    smaller than the item. Growing the item therefore forces the track up and
 *    STEALS width from its sibling (measured: tracks `300px 300px` became
 *    `350px 250px`). Shrinking does the opposite of nothing useful: the track
 *    stays at 300px and the item shrinks inside it, so no sibling moves and the
 *    gap is invisible — the gesture is simply dead. Surprising one way, inert
 *    the other; neither is what the user asked for. The track is owned by the
 *    parent's `grid-template-columns`.
 * 3. **Alignment decouples size from the edge.** Under `justify-content:
 *    flex-end` the element is pinned right, so growing it extends LEFTWARD and
 *    the right edge the user is dragging does not move at all. Under `center`
 *    it moves half as far. The size edit is correct; the pointer-to-size
 *    conversion is not.
 *
 * ## Why this is two questions, not one
 *
 * Earlier attempts at a single detector failed (an asked-vs-got width check
 * never fired; an edge-lag check false-fired on legitimate wrapping). They
 * failed because they conflated two independent things:
 *
 *   - **ownership** — which property, on which element, actually controls size
 *   - **edge response** — how far the grabbed edge travels per 1px of size
 *
 * `flex: 1` is an ownership problem. `justify-content: center` is an
 * edge-response problem with correct ownership. A grid item is an ownership
 * problem where the naive edit still *appears* to work. Answering them
 * separately is what makes both tractable.
 *
 * ## How the answers are obtained (COR-3)
 *
 * `measureConstraintOwner` is the entry point a gesture should use. It PERTURBS
 * the element and reads what actually happened, because predicting either answer
 * from parent CSS was wrong in every case anyone measured — see the second table
 * further down. `resolveConstraintOwner` below is the original prediction, kept
 * only as the fallback for an element with no measurable layout box.
 */

/** The edge the user grabbed. */
export type ResizeEdge = 'left' | 'right' | 'top' | 'bottom'

/** Which box actually controls the size along the dragged axis. */
export type ConstraintTarget = 'element' | 'flex-allocation' | 'grid-track'

export interface ConstraintOwnership {
  target: ConstraintTarget
  /** The CSS property that must change for the drag to have any effect. */
  property: string
  /** Whether `property` belongs to the selected element or to its parent. */
  appliesTo: 'self' | 'parent'
  /**
   * How far the grabbed edge moves per 1px added to the size.
   *
   * `1` — the edge tracks the pointer (the common case).
   * `0.5` — centred: the box grows both ways, so the edge moves half as far.
   * `0` — the edge is pinned by alignment; growth happens on the opposite side.
   *
   * A drag handler divides the pointer delta by this to get the size delta, and
   * must refuse to convert when it is `0` — no size change can move that edge.
   */
  edgeResponse: number
  /**
   * Transformed (screen) pixels per CSS pixel along the dragged axis. 1 when
   * nothing is scaled, which is the overwhelmingly common case.
   *
   * `edgeResponse` alone is scale-INVARIANT — both its numerator and denominator
   * are measured in screen space — so it looks correct under a transform and is
   * not. A drag handler reads a pointer delta in SCREEN pixels and writes a size
   * in CSS pixels, so on a 2x-scaled element a 20px drag must become a 10px
   * width change. Without this factor it wrote 20 and the element moved twice as
   * far as the cursor. Raised in review; `pointerDeltaToSizeDelta` applies it.
   */
  screenPxPerCssPx: number
  /** Plain-language explanation, suitable for surfacing to the user. */
  reason: string
}

const INLINE_EDGES: ReadonlySet<ResizeEdge> = new Set<ResizeEdge>(['left', 'right'])

/** Grid track properties, per axis. */
const TRACK_PROPERTY = { inline: 'grid-template-columns', block: 'grid-template-rows' } as const

function readStyle(el: Element): CSSStyleDeclaration | null {
  try {
    return getComputedStyle(el)
  } catch {
    return null
  }
}

/**
 * How far the grabbed edge travels per 1px of size, given the parent's
 * distribution along that axis.
 *
 * Only the alignment that positions the box along the DRAGGED axis matters.
 * `justify-content` governs the flex main axis; `align-items` the cross axis.
 * A box distributed from the start grows away from its start edge, so grabbing
 * the start edge moves nothing.
 */
function edgeResponseFor(distribution: string, edge: ResizeEdge, reversed: boolean): number {
  // `reversed` folds together the two things that can swap which PHYSICAL edge
  // is the inline start: `flex-direction: *-reverse` and an RTL writing mode.
  // The caller computes it from both, because either alone inverts every drag
  // in that container — and getting it wrong is silent, since the gesture still
  // "works", just in the wrong direction.
  const startEdge: ResizeEdge = INLINE_EDGES.has(edge)
    ? (reversed ? 'right' : 'left')
    : (reversed ? 'bottom' : 'top')
  const endEdge: ResizeEdge = INLINE_EDGES.has(edge)
    ? (reversed ? 'left' : 'right')
    : (reversed ? 'top' : 'bottom')

  switch (distribution) {
    case 'center':
    case 'space-around':
    case 'space-evenly':
      // Grows in both directions — the edge takes half the change.
      return 0.5
    case 'flex-end':
    case 'end':
    case 'right':
      // Pinned to the end edge; growth extends toward the start.
      return edge === endEdge ? 0 : 1
    default:
      // flex-start / start / stretch / space-between and anything unrecognised
      // behave start-anchored for the FIRST item, which is the conservative
      // reading: growth extends toward the end edge.
      return edge === startEdge ? 0 : 1
  }
}

/**
 * Decide where a resize of `element` along `edge` must actually be written.
 *
 * Returns `element` ownership when the element genuinely controls its own size,
 * which remains the common case. The other two targets exist because writing
 * `width` there is either ignored outright (`flex-allocation`) or applies to
 * the item while leaving the layout that positions it untouched (`grid-track`).
 */
export function resolveConstraintOwner(element: Element, edge: ResizeEdge): ConstraintOwnership {
  const inline = INLINE_EDGES.has(edge)
  const sizeProperty = inline ? 'width' : 'height'
  const axis = inline ? 'inline' : 'block'

  const parent = element.parentElement
  const parentStyle = parent ? readStyle(parent) : null

  // No parent, or styles unavailable (detached node, hostile accessor): the
  // element is the only thing we can honestly claim to know about.
  if (!parent || !parentStyle) {
    return {
      target: 'element',
      property: sizeProperty,
      appliesTo: 'self',
      edgeResponse: 1,
      screenPxPerCssPx: 1,
      reason: `No layout parent to defer to — ${sizeProperty} on the element controls this edge.`,
    }
  }

  const display = parentStyle.display
  const isFlex = display === 'flex' || display === 'inline-flex'
  const isGrid = display === 'grid' || display === 'inline-grid'

  // ── Grid ────────────────────────────────────────────────────────────────
  // The item's size is allocated by the TRACK, and the naive edit is wrong in
  // BOTH directions, differently. `1fr` is `minmax(auto, 1fr)`, so the auto
  // minimum means the track cannot be smaller than the item: growing forces the
  // track wider and takes width from the sibling (measured, tracks
  // `300px 300px` → `350px 250px`), while shrinking leaves the track at 300px so
  // the item shrinks inside it and nothing visibly moves. Surprising one way,
  // inert the other — never what the user asked for.
  if (isGrid) {
    return {
      target: 'grid-track',
      property: TRACK_PROPERTY[axis],
      appliesTo: 'parent',
      edgeResponse: 1,
      screenPxPerCssPx: 1,
      reason:
        `This element is a grid item; its ${sizeProperty} is allocated by the parent's ` +
        `${TRACK_PROPERTY[axis]} track. Setting ${sizeProperty} on the item behaves ` +
        `differently in each direction: growing forces the track wider and takes space from a ` +
        `sibling, while shrinking leaves the track alone so nothing visibly moves. Resize the ` +
        `track instead.`,
    }
  }

  // ── Flex ────────────────────────────────────────────────────────────────
  if (isFlex) {
    const direction = parentStyle.flexDirection || 'row'
    // RTL flips the inline axis, so an RTL row is start-anchored on the RIGHT.
    // Only the INLINE axis is affected — `direction` says nothing about block
    // flow — so it must not be folded in for a vertical drag. Raised in review.
    const rtl = inline && parentStyle.direction === 'rtl'
    const reversed = direction.endsWith('-reverse') !== rtl
    const mainIsInline = direction.startsWith('row')
    const draggingMainAxis = mainIsInline === inline

    const style = readStyle(element)
    const grow = Number.parseFloat(style?.flexGrow ?? '0')

    if (draggingMainAxis && Number.isFinite(grow) && grow > 0) {
      // Measured: a `flex: 1` child asked for 600 → 650 stayed at 600. The flex
      // algorithm resolves the main size from grow/basis and the used width
      // never changes, so the naive edit is written to source and does nothing.
      return {
        target: 'flex-allocation',
        property: 'flex-grow',
        appliesTo: 'self',
        edgeResponse: 1,
        screenPxPerCssPx: 1,
        reason:
          `This element has flex-grow: ${grow}, so the flex algorithm sets its ${sizeProperty} ` +
          `from the free space — a ${sizeProperty} declaration is ignored entirely. Change its ` +
          `flex allocation (flex-grow / flex-basis) instead.`,
      }
    }

    // Size is genuinely the element's, but alignment decides which edge moves.
    const distribution = draggingMainAxis
      ? (parentStyle.justifyContent || 'flex-start')
      : (parentStyle.alignItems || 'stretch')
    const edgeResponse = edgeResponseFor(distribution, edge, reversed)

    if (edgeResponse === 0) {
      return {
        target: 'element',
        property: sizeProperty,
        appliesTo: 'self',
        edgeResponse,
        screenPxPerCssPx: 1,
        reason:
          `The parent's ${draggingMainAxis ? 'justify-content' : 'align-items'}: ${distribution} ` +
          `pins this edge, so changing ${sizeProperty} grows the element away from it and the ` +
          `edge does not move. Drag the opposite edge, or change the parent's alignment.`,
      }
    }

    if (edgeResponse !== 1) {
      return {
        target: 'element',
        property: sizeProperty,
        appliesTo: 'self',
        edgeResponse,
        screenPxPerCssPx: 1,
        reason:
          `The parent's ${draggingMainAxis ? 'justify-content' : 'align-items'}: ${distribution} ` +
          `grows this element in both directions, so the edge moves ${edgeResponse}px per 1px of ` +
          `${sizeProperty}. The drag delta must be scaled accordingly.`,
      }
    }

    // Cross-axis stretch: the element has no cross size of its own until one is
    // set, and setting it opts the element out of stretching. Worth saying,
    // because the visible result of the FIRST drag is a permanent behaviour
    // change, not just a size change.
    if (!draggingMainAxis && distribution === 'stretch') {
      return {
        target: 'element',
        property: sizeProperty,
        appliesTo: 'self',
        edgeResponse: 1,
        screenPxPerCssPx: 1,
        reason:
          `This element currently stretches to its parent's ${sizeProperty}. Setting an explicit ` +
          `${sizeProperty} opts it out of stretching, so it will stop tracking the parent.`,
      }
    }

    return {
      target: 'element',
      property: sizeProperty,
      appliesTo: 'self',
      edgeResponse: 1,
      screenPxPerCssPx: 1,
      reason: `${sizeProperty} on the element controls this edge.`,
    }
  }

  // ── Block / inline / everything else ────────────────────────────────────
  return {
    target: 'element',
    property: sizeProperty,
    appliesTo: 'self',
    edgeResponse: 1,
    screenPxPerCssPx: 1,
    reason: `${sizeProperty} on the element controls this edge.`,
  }
}

// ── Measurement (COR-3) ─────────────────────────────────────────────────────
//
// Everything above predicts the answer from a handful of parent CSS properties.
// A post-merge review returned seven P1 findings, five confirmed by measurement
// in Chromium — the resolver was wrong in all five:
//
// | case                                    | measured                     | predicted    |
// |-----------------------------------------|------------------------------|--------------|
// | `space-between`, middle child +60w      | Δleft −30, Δright +30        | 0 / 1        |
// | `row-reverse`, cross-axis +50h          | top pinned, Δbottom +50      | bottom pinned|
// | `flex-shrink` overflow, +50w            | asked 250px, GOT 100px       | `element`    |
// | `align-self: center` override           | Δtop −25, Δbottom +25        | 0 / 1        |
// | grid `justify-items: start`             | Δright +50, sibling unmoved  | grid-track   |
//
// The failures share a cause, and it is not a missing switch case. Edge response
// depends on the item's INDEX among its siblings, its own `align-self`, its
// `margin: auto`, whether the line is currently overflowing, and which flex line
// it landed on. That is not a lookup table — it is the layout algorithm, and a
// switch over `justify-content` is re-implementing flexbox badly. Compound
// values (`safe center`, `last baseline`) and `writing-mode: vertical-rl` (where
// height is the flex MAIN size) fall through it entirely.
//
// So: perturb the element by a known delta, read what actually happened, revert
// before the browser paints. Correct by construction for space-between,
// align-self, auto margins, writing modes, safe alignment, wrap-reverse and
// grid item-vs-track — including cases nobody enumerated, which is the point.
//
// Ownership is settled the same way. `flex-grow > 0` is neither necessary nor
// sufficient: a default-shrinking child in an overflowing parent is flex-owned
// with `flex-grow: 0`. The honest question is "did writing this property change
// the used size?", and only a write can answer it.

/** How much to perturb by. Large enough that sub-pixel layout rounding cannot
 *  masquerade as a response ratio, small enough not to trigger a scrollbar in a
 *  tight container. It CAN still cross a flex wrap threshold, which the probe
 *  detects and refuses rather than reporting a different line arrangement's
 *  geometry as if it were this one's. */
const PROBE_PX = 16

/** Sub-pixel noise floor for "did this move at all". Chromium reports
 *  fractional device-pixel geometry, so exact zero is the wrong test for a SIZE
 *  that was asked to change. */
const EPSILON = 0.5

/** A genuinely pinned edge moves EXACTLY zero, so the floor for "the edge did
 *  not move" must be far tighter than the size floor. At 0.5px it erased real
 *  responses: a `space-between` row with 40 children moves the second-to-last
 *  child's edge by 16/39 ≈ 0.41px, a true ratio of ~0.026, and rounding that to
 *  zero disables the edge outright. Raised in review. */
const EDGE_EPSILON = 0.02

export interface ConstraintProbe {
  /** Used-size change actually obtained, in the same (possibly transformed)
   *  space as `edgeDelta`, so their ratio is unit-consistent. */
  sizeDelta: number
  /** Signed movement of the grabbed edge. */
  edgeDelta: number
  /** What the probe ASKED for, expressed in that same space. Compared against
   *  `sizeDelta` to detect a partially-honoured write; it is not simply
   *  PROBE_PX, because a CSS transform scales the two apart. */
  requested: number
  /** Whether any sibling's position OR size changed — the signal that the
   *  parent re-allocated space rather than the element growing into its own.
   *  Size matters as much as origin: two stretched grid items in different rows
   *  of one column keep their origins while the column widens. */
  siblingChanged: boolean
  /** True when the growth probe was clamped to nothing and a SHRINK probe moved
   *  the element instead — an element sitting on its `max-width`. Reporting the
   *  growth result alone would call a resizable element pinned. */
  shrinkOnly: boolean
  /** Transformed pixels per CSS pixel along this axis. 1 without a transform.
   *  Carried out because the RATIO is scale-invariant but a drag handler is not:
   *  it divides a SCREEN-space pointer delta and writes a CSS-space size, so
   *  under a 2x scale a 20px drag must become a 10px width change. */
  scale: number
}

const edgeValue = (r: DOMRect, edge: ResizeEdge): number =>
  edge === 'left' ? r.left : edge === 'right' ? r.right : edge === 'top' ? r.top : r.bottom

/** The nearest ancestor that actually generates a layout box.
 *
 *  `display: contents` boxes do not, and the child participates directly in the
 *  formatting context above them. Reading `parentElement` alone therefore missed
 *  the flex or grid container entirely, and a `flex: 1` child under a
 *  contents-wrapper was reported as an element-owned pinned width. */
function layoutParentOf(el: Element): { parent: Element; style: CSSStyleDeclaration } | null {
  let p = el.parentElement
  while (p) {
    const style = readStyle(p)
    if (!style) return null
    if (style.display !== 'contents') return { parent: p, style }
    p = p.parentElement
  }
  return null
}

/** Physical edge → the grid track axis that controls it, honouring writing mode.
 *
 *  Under `writing-mode: vertical-rl` the inline axis runs vertically, so physical
 *  width is the BLOCK axis and columns are laid out top-to-bottom. Naming
 *  `grid-template-columns` for a left/right drag there sends the user to edit a
 *  property that does not control the edge they grabbed. */
function trackPropertyFor(edge: ResizeEdge, containerStyle: CSSStyleDeclaration): string {
  const verticalWm = (containerStyle.writingMode || '').startsWith('vertical')
  const physicalInline = INLINE_EDGES.has(edge)
  const isInlineAxis = verticalWm ? !physicalInline : physicalInline
  return isInlineAxis ? TRACK_PROPERTY.inline : TRACK_PROPERTY.block
}

// KNOWN LIMITATION — an item in an IMPLICIT track is sized by
// `grid-auto-columns` / `grid-auto-rows`, and this names the `grid-template-*`
// property regardless. Raised in review, and I tried to fix it: the explicit /
// implicit distinction is NOT OBSERVABLE from computed styles on the item.
// Measured in Chromium:
//
//   explicit `grid-template-columns: 1fr 1fr`  -> computed '300px 300px'
//   implicit `grid-auto-columns: 1fr`          -> computed '300px 300px'
//   grid-column-start, both cases              -> 'auto'
//
// The computed template reports the RESOLVED USED tracks, implicit ones
// included, so counting them cannot separate the two — and an auto-placed item
// does not report a resolved line number to compare against. A heuristic here
// would be dead code that reads as coverage, which is worse than the gap it
// pretends to close. Deciding it needs a signal computed styles do not carry:
// either the CSSOM rule text, or `getComputedStyle` on the container plus a
// count of explicitly placed items. Filed rather than guessed.

/** True when the flex MAIN axis runs along the dragged physical edge. */
function draggingFlexMainAxis(edge: ResizeEdge, containerStyle: CSSStyleDeclaration): boolean {
  const dir = containerStyle.flexDirection || 'row'
  const verticalWm = (containerStyle.writingMode || '').startsWith('vertical')
  // `row` follows the INLINE axis, which a vertical writing mode rotates.
  const mainIsPhysicallyInline = dir.startsWith('row') !== verticalWm
  return mainIsPhysicallyInline === INLINE_EDGES.has(edge)
}

interface Snapshot { rect: DOMRect; siblings: DOMRect[] }

function snapshot(el: Element, siblings: Element[]): Snapshot {
  return { rect: el.getBoundingClientRect(), siblings: siblings.map(s => s.getBoundingClientRect()) }
}

const siblingsDiffer = (a: DOMRect[], b: DOMRect[]): boolean =>
  a.some((x, i) => {
    const y = b[i]
    if (!y) return false
    return Math.abs(x.left - y.left) > EPSILON || Math.abs(x.top - y.top) > EPSILON
      || Math.abs(x.width - y.width) > EPSILON || Math.abs(x.height - y.height) > EPSILON
  })

/**
 * Write a size, read what happened, put it back.
 *
 * The write/read/restore runs inside ONE task with no await between, so the
 * browser has no opportunity to paint the perturbed state — `getBoundingClientRect`
 * forces a synchronous layout without a paint. The restore is in a `finally`, so
 * a throw mid-probe cannot leave the user's DOM permanently modified.
 *
 * KNOWN, UNAVOIDABLE SIDE EFFECT: the write and the restore each enqueue a
 * style-attribute MutationRecord. An app observing this element sees two
 * mutations that were never a user edit, and restoring the value cannot retract
 * the records. There is no CSSOM API for "lay this out as if" — measurement
 * requires mutation — so this is a cost of the approach rather than a bug to
 * fix. Callers whose own observers watch inline styles should ignore records
 * whose before/after values are identical, which is what these are.
 *
 * Returns null when the element cannot be probed, or when the probe itself
 * changed the layout it was trying to measure (a crossed flex-wrap boundary).
 * Both mean "unknown", never "no response".
 */
export function probeConstraint(element: Element, edge: ResizeEdge): ConstraintProbe | null {
  const el = element as HTMLElement
  if (!el.style || typeof el.getBoundingClientRect !== 'function') return null

  const inline = INLINE_EDGES.has(edge)
  const sizeProperty = inline ? 'width' : 'height'

  const own = readStyle(el)
  if (!own) return null

  // Layout siblings, not DOM siblings. Under `display: contents` an item's real
  // siblings are children of the grid/flex container OUTSIDE its wrapper, so
  // snapshotting the wrapper's children missed the cousin that a widening track
  // actually resized — and `siblingChanged` stayed false for a genuinely
  // track-allocated item.
  const layoutHost = layoutParentOf(el)?.parent ?? el.parentElement
  const siblings = Array.from(layoutHost?.children ?? []).filter(s => s !== el && !s.contains(el))
  const before = snapshot(el, siblings)
  const baseSize = inline ? before.rect.width : before.rect.height
  if (!(baseSize > 0)) return null

  // `width` does not apply to a non-replaced inline box at all, and its computed
  // value stays `auto` there. Falling through would hand the element to the
  // prediction fallback, which cheerfully reports element-owned `width` at 1:1 —
  // a confident answer about a property that cannot move this edge. Refuse
  // instead; `isSizeInert` already encodes exactly this rule for the panel.
  if (isSizeInert(el)) return null

  // The write is in CSS pixels; the rect is in TRANSFORMED pixels, so the two
  // must be related before a requested delta can be compared to a measured one.
  //
  // The scale comes from offsetWidth, NOT from the computed width. Both
  // offsetWidth and the rect are BORDER-box, so their ratio is the pure
  // transform scale. Deriving it from the computed width divided by the rect
  // mixed box models: under the default `content-box`, computed width excludes
  // padding and border while the rect includes them, so the "scale" came out
  // greater than 1 with no transform present at all — and a fully honoured 16px
  // write was then compared against an inflated `requested` and misread as
  // partial. Raised in review.
  const offsetSize = inline ? el.offsetWidth : el.offsetHeight
  const scale = offsetSize > 0 ? baseSize / offsetSize : 1
  const cssBase = Number.parseFloat(own.getPropertyValue(sizeProperty))
  if (!Number.isFinite(cssBase) || cssBase <= 0) return null

  const priorValue = el.style.getPropertyValue(sizeProperty)
  const priorPriority = el.style.getPropertyPriority(sizeProperty)
  const priorTransition = el.style.getPropertyValue('transition')
  const priorTransitionPriority = el.style.getPropertyPriority('transition')

  /** One write/read cycle. `delta` is in CSS pixels. */
  const perturb = (delta: number): Snapshot => {
    // `important`, or an author rule like `.item { width: 100px !important }`
    // wins the cascade and the probe measures nothing — reporting a perfectly
    // resizable element as pinned, or handing ownership to the container.
    // Editing that important declaration WOULD resize it, so the probe has to
    // outrank it to find out.
    el.style.setProperty(sizeProperty, `${cssBase + delta}px`, 'important')
    return snapshot(el, siblings)
  }

  try {
    // A `transition: width` makes the synchronous read observe the transition's
    // STARTING value, so sizeDelta comes back ~0 and a resizable element looks
    // pinned or container-owned. Suppressing transitions for the duration is the
    // only way to read the settled value in one task.
    el.style.setProperty('transition', 'none', 'important')

    let after = perturb(PROBE_PX)
    let requested = PROBE_PX * scale
    let sizeDelta = (inline ? after.rect.width : after.rect.height) - baseSize
    let shrinkOnly = false

    // Growth clamped to nothing? The element may simply be sitting on its
    // `max-width`, in which case it shrinks perfectly well and calling the edge
    // pinned would refuse an inward drag the user is entitled to. Constraint
    // response is DIRECTIONAL, so ask the other question before concluding.
    if (Math.abs(sizeDelta) < EPSILON) {
      const shrunk = perturb(-PROBE_PX)
      const shrunkDelta = (inline ? shrunk.rect.width : shrunk.rect.height) - baseSize
      if (Math.abs(shrunkDelta) > EPSILON) {
        after = shrunk
        requested = -PROBE_PX * scale
        sizeDelta = shrunkDelta
        shrinkOnly = true
      }
    }

    // Did the probe re-arrange the flex LINES? +16px can tip a wrapping container
    // over its threshold, and everything measured after that describes a layout
    // the user is not dragging in — here the right edge "moved" 80.5px for a 16px
    // size change, a ratio of 5 that no alignment can produce.
    //
    // Checking the probed element alone is not enough, and that was the first
    // version's mistake: when a line wraps it is frequently a SIBLING that drops
    // to the next line while the probed element stays exactly where it was. Any
    // item crossing the axis means the arrangement changed.
    //
    // Gated on the container actually being wrappable, so a grid track
    // reallocation — which legitimately moves siblings — is not mistaken for it.
    // The LAYOUT parent's flex-wrap. Reading `el.parentElement` returned a
    // display:contents wrapper's value (always the initial `nowrap`) rather than
    // the actual flex container's, so a probe that crossed a line boundary was
    // accepted and produced exactly the discontinuous ratio this guard rejects.
    const wrappable = /wrap/.test(layoutParentOf(el)?.style.flexWrap ?? 'nowrap')
    if (wrappable) {
      const crossOf = (r: DOMRect): number => (inline ? r.top : r.left)
      const lineChanged =
        Math.abs(crossOf(after.rect) - crossOf(before.rect)) > EPSILON ||
        after.siblings.some((a, i) => {
          const b = before.siblings[i]
          return !!b && Math.abs(crossOf(a) - crossOf(b)) > EPSILON
        })
      if (lineChanged) return null
    }

    return {
      sizeDelta,
      edgeDelta: edgeValue(after.rect, edge) - edgeValue(before.rect, edge),
      requested,
      siblingChanged: siblingsDiffer(before.siblings, after.siblings),
      shrinkOnly,
      scale,
    }
  } finally {
    if (priorValue) el.style.setProperty(sizeProperty, priorValue, priorPriority)
    else el.style.removeProperty(sizeProperty)
    if (priorTransition) el.style.setProperty('transition', priorTransition, priorTransitionPriority)
    else el.style.removeProperty('transition')
  }
}

/**
 * Resolve ownership and edge response by MEASUREMENT.
 *
 * Falls back to `resolveConstraintOwner` only when the element cannot be probed
 * at all. That fallback is a prediction and is wrong in the five cases above, so
 * it is a last resort rather than a peer — but a detached or unmeasurable node
 * has no measurement to give, and returning a confident wrong answer would be
 * worse than returning the documented guess.
 */
export function measureConstraintOwner(element: Element, edge: ResizeEdge): ConstraintOwnership {
  const probe = probeConstraint(element, edge)
  if (!probe) return resolveConstraintOwner(element, edge)

  const inline = INLINE_EDGES.has(edge)
  const sizeProperty = inline ? 'width' : 'height'
  // Through `display: contents`, not `parentElement` — see layoutParentOf.
  const layout = layoutParentOf(element)
  const display = layout?.style.display ?? ''
  const isGrid = display === 'grid' || display === 'inline-grid'
  const isFlex = display === 'flex' || display === 'inline-flex'
  const trackProperty = layout ? trackPropertyFor(edge, layout.style) : TRACK_PROPERTY[inline ? 'inline' : 'block']
  const mainAxis = isFlex && layout ? draggingFlexMainAxis(edge, layout.style) : false

  // ── The size did not move in EITHER direction ────────────────────────────
  if (Math.abs(probe.sizeDelta) < EPSILON) {
    if (isGrid) {
      return {
        target: 'grid-track',
        property: trackProperty,
        appliesTo: 'parent',
        edgeResponse: 1,
        screenPxPerCssPx: probe.scale,
        reason:
          `Measured: setting ${sizeProperty} on this element did not change its size — the parent's ` +
          `${trackProperty} track controls it. Resize the track instead.`,
      }
    }
    // Only the MAIN axis is resolved by the flex algorithm. A cross-axis size
    // that refuses to move is being clamped by something else (max-height, an
    // aspect-ratio), and pointing the user at flex-grow would be a dead end.
    if (isFlex && mainAxis) {
      // WHICH flex property, not just "flex-allocation". With `flex: 0 0 100px`
      // the base size comes from flex-basis and there is no positive free space
      // to grow into, so naming flex-grow sends the user to edit a property that
      // changes nothing. Read the basis to say the true one.
      const selfStyle = readStyle(element)
      const basis = (selfStyle?.flexBasis ?? 'auto').trim()
      const grow = Number.parseFloat(selfStyle?.flexGrow ?? '0')
      // The lever is flex-basis only when the basis SUPPLIES the size, which
      // needs grow to be zero. `flex: 1` expands to `flex-basis: 0%` — non-auto,
      // but the size comes from free-space distribution there, so flex-grow is
      // what to change. Testing "basis is not auto" alone got that backwards and
      // the display:contents fixture caught it.
      const definiteBasis = basis !== 'auto' && basis !== 'content' && basis !== '' &&
        Number.parseFloat(basis) > 0
      const basisOverrides = definiteBasis && (!Number.isFinite(grow) || grow === 0)
      return {
        target: 'flex-allocation',
        property: basisOverrides ? 'flex-basis' : 'flex-grow',
        appliesTo: 'self',
        edgeResponse: 1,
        screenPxPerCssPx: probe.scale,
        reason: basisOverrides
          ? `Measured: setting ${sizeProperty} on this element did not change its size — its ` +
            `flex-basis (${basis}) supplies the base size, so ${sizeProperty} is ignored. Change ` +
            `flex-basis instead.`
          : `Measured: setting ${sizeProperty} on this element did not change its size — the flex ` +
            `algorithm resolves it from the free space. Change its flex allocation ` +
            `(flex-grow / flex-basis) instead.`,
      }
    }
    return {
      target: 'element',
      property: sizeProperty,
      appliesTo: 'self',
      edgeResponse: 0,
      screenPxPerCssPx: probe.scale,
      reason:
        `Measured: ${sizeProperty} on this element did not change in either direction — something ` +
        `other than its own ${sizeProperty} is fixing it (a min/max constraint, or an ancestor).`,
    }
  }

  const magnitude = Math.abs(probe.sizeDelta)
  const edgeResponse = Math.abs(probe.edgeDelta) / magnitude

  // ── Partially honoured, on the MAIN axis ─────────────────────────────────
  // Measured case: a shrinking flex child asked 250px and got 100px. Restricted
  // to the main axis because flex-shrink governs nothing else — a row child
  // whose HEIGHT probe is clamped by max-height is not a flex-shrink problem,
  // and saying so would send the user to edit a property with no effect.
  //
  // SIGNED against what was requested, not a magnitude comparison. Asking an
  // over-constrained child to GROW makes it SHRINK FURTHER — raising its basis
  // raises the total overflow that gets redistributed — so the measured delta is
  // negative for a positive request. Comparing |delta| to |requested| reads that
  // as "more than asked" and lets it through as element-owned; the sign is the
  // diagnostic. Caught by the e2e fixture, which is the only place it shows.
  if (isFlex && mainAxis && Math.abs(probe.sizeDelta - probe.requested) > EPSILON) {
    return {
      target: 'flex-allocation',
      property: 'flex-shrink',
      appliesTo: 'self',
      edgeResponse,
      screenPxPerCssPx: probe.scale,
      reason:
        `Measured: this element was asked for ${probe.requested.toFixed(0)}px of ${sizeProperty} ` +
        `and got ${probe.sizeDelta.toFixed(1)}px — the flex line is over-constrained, so the flex ` +
        `algorithm is overruling the declaration. Change its flex allocation instead.`,
    }
  }

  // ── A grid item whose growth REALLY moves the track ──────────────────────
  // Not every grid item does. Under `justify-items: start` the item grew, its
  // right edge moved, and no sibling changed — the naive edit is exactly right
  // there. `siblingChanged` compares SIZE as well as origin, because a column
  // widening leaves same-column siblings' origins untouched while resizing them.
  if (isGrid && probe.siblingChanged) {
    return {
      target: 'grid-track',
      property: trackProperty,
      appliesTo: 'parent',
      edgeResponse,
      screenPxPerCssPx: probe.scale,
      reason:
        `Measured: resizing this element changed a sibling — its ${trackProperty} track ` +
        `re-allocated space rather than the element growing into its own. Resize the track instead.`,
    }
  }

  if (edgeResponse < EDGE_EPSILON) {
    return {
      target: 'element',
      property: sizeProperty,
      appliesTo: 'self',
      edgeResponse: 0,
      screenPxPerCssPx: probe.scale,
      reason:
        `Measured: this element's ${sizeProperty} changed but the ${edge} edge did not move — ` +
        `alignment pins it, and growth goes to the opposite side. Drag the opposite edge, or ` +
        `change the parent's alignment.`,
    }
  }

  const directionNote = probe.shrinkOnly
    ? ` It cannot grow any further (a max ${sizeProperty} is binding), but it can shrink.`
    : ''
  return {
    target: 'element',
    property: sizeProperty,
    appliesTo: 'self',
    edgeResponse,
    screenPxPerCssPx: probe.scale,
    reason:
      (edgeResponse > 0.95 && edgeResponse < 1.05
        ? `Measured: ${sizeProperty} on the element controls this edge, and the edge tracks it 1:1.`
        : `Measured: the ${edge} edge moves ${edgeResponse.toFixed(2)}px per 1px of ${sizeProperty} — ` +
          `the element grows in more than one direction, so the drag delta must be scaled.`) +
      directionNote,
  }
}

/**
 * Convert a pointer delta along `edge` into a size delta.
 *
 * Returns `null` when no size change can move that edge (`edgeResponse === 0`),
 * so a caller cannot accidentally divide by zero and write an infinite width.
 * The sign flip for start edges is included: dragging a left edge leftward is a
 * negative pointer delta but a positive width change.
 */
export function pointerDeltaToSizeDelta(
  ownership: ConstraintOwnership,
  edge: ResizeEdge,
  pointerDelta: number,
): number | null {
  if (ownership.edgeResponse === 0) return null
  const towardStart = edge === 'left' || edge === 'top'
  const signed = towardStart ? -pointerDelta : pointerDelta
  // Divide by the transform scale as well as the edge response. `pointerDelta`
  // is SCREEN pixels and the result is written as a CSS length, so on a
  // 2x-scaled element a 20px drag is a 10px width change. edgeResponse cannot
  // carry this: it is a ratio of two screen-space measurements and so is
  // scale-invariant — it looks right under a transform and is not.
  const scale = ownership.screenPxPerCssPx || 1
  return signed / ownership.edgeResponse / scale
}
