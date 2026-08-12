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
      reason: `${sizeProperty} on the element controls this edge.`,
    }
  }

  // ── Block / inline / everything else ────────────────────────────────────
  return {
    target: 'element',
    property: sizeProperty,
    appliesTo: 'self',
    edgeResponse: 1,
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
 *  masquerade as a response ratio, small enough not to trigger wrapping or a
 *  scrollbar in a tight container — either would measure a different layout
 *  than the one the user is dragging in. */
const PROBE_PX = 16

/** Below this, a measured delta is layout noise rather than a response. Chromium
 *  reports fractional device-pixel geometry, so exact zero is the wrong test. */
const EPSILON = 0.5

export interface ConstraintProbe {
  /** Used-size change actually obtained for a `PROBE_PX` request. */
  sizeDelta: number
  /** Signed movement of the grabbed edge. */
  edgeDelta: number
  /** Whether any sibling's position changed — the signal that the parent
   *  re-allocated space rather than the element simply growing into it. */
  siblingMoved: boolean
}

const edgeValue = (r: DOMRect, edge: ResizeEdge): number =>
  edge === 'left' ? r.left : edge === 'right' ? r.right : edge === 'top' ? r.top : r.bottom

/**
 * Write a size, read what happened, put it back.
 *
 * The write/read/restore runs inside ONE task with no await between, so the
 * browser has no opportunity to paint the perturbed state — `getBoundingClientRect`
 * forces a synchronous layout without a paint. The restore is in a `finally`, so
 * a throw mid-probe cannot leave the user's DOM permanently modified.
 *
 * Returns null when the element cannot be probed (no layout box, no inline style
 * access), which the caller must treat as "unknown", never as "no response".
 */
export function probeConstraint(element: Element, edge: ResizeEdge): ConstraintProbe | null {
  const el = element as HTMLElement
  if (!el.style || typeof el.getBoundingClientRect !== 'function') return null

  const inline = INLINE_EDGES.has(edge)
  const sizeProperty = inline ? 'width' : 'height'

  const before = el.getBoundingClientRect()
  const baseSize = inline ? before.width : before.height
  // A zero-size box gives no ratio to measure and division would produce
  // Infinity, which reads downstream as a confident answer.
  if (!(baseSize > 0)) return null

  const siblings = Array.from(el.parentElement?.children ?? []).filter(s => s !== el)
  const siblingsBefore = siblings.map(s => s.getBoundingClientRect())

  // Capture the inline declaration EXACTLY, including "not set at all" — writing
  // back an empty string is not the same as never having written, if the author
  // had `width: 200px` inline. Both the value and its priority must survive.
  const priorValue = el.style.getPropertyValue(sizeProperty)
  const priorPriority = el.style.getPropertyPriority(sizeProperty)

  try {
    el.style.setProperty(sizeProperty, `${baseSize + PROBE_PX}px`)
    const after = el.getBoundingClientRect()
    const siblingMoved = siblings.some((s, i) => {
      const b = siblingsBefore[i]
      if (!b) return false
      const a = s.getBoundingClientRect()
      return Math.abs(a.left - b.left) > EPSILON || Math.abs(a.top - b.top) > EPSILON
    })
    return {
      sizeDelta: (inline ? after.width : after.height) - baseSize,
      edgeDelta: edgeValue(after, edge) - edgeValue(before, edge),
      siblingMoved,
    }
  } finally {
    if (priorValue) el.style.setProperty(sizeProperty, priorValue, priorPriority)
    else el.style.removeProperty(sizeProperty)
  }
}

/**
 * Resolve ownership and edge response by MEASUREMENT.
 *
 * Falls back to `resolveConstraintOwner` only when the element cannot be probed
 * at all. That fallback is a prediction and is wrong in the five cases above, so
 * it is a last resort rather than a peer — but a detached or zero-size node has
 * no measurement to give, and returning a confident wrong answer would be worse
 * than returning the documented guess.
 */
export function measureConstraintOwner(element: Element, edge: ResizeEdge): ConstraintOwnership {
  const probe = probeConstraint(element, edge)
  if (!probe) return resolveConstraintOwner(element, edge)

  const inline = INLINE_EDGES.has(edge)
  const sizeProperty = inline ? 'width' : 'height'
  const axis = inline ? 'inline' : 'block'
  const parentStyle = element.parentElement ? readStyle(element.parentElement) : null
  const display = parentStyle?.display ?? ''
  const isGrid = display === 'grid' || display === 'inline-grid'
  const isFlex = display === 'flex' || display === 'inline-flex'

  // ── The size did not move ────────────────────────────────────────────────
  // The element does not control its own size along this axis, whatever its
  // declarations say. This is the `flex: 1` case AND the overflowing
  // `flex-shrink` case that `flex-grow > 0` misses entirely.
  if (Math.abs(probe.sizeDelta) < EPSILON) {
    if (isGrid) {
      return {
        target: 'grid-track',
        property: TRACK_PROPERTY[axis],
        appliesTo: 'parent',
        edgeResponse: 1,
        reason:
          `Measured: setting ${sizeProperty} on this element did not change its size — the parent's ` +
          `${TRACK_PROPERTY[axis]} track controls it. Resize the track instead.`,
      }
    }
    if (isFlex) {
      return {
        target: 'flex-allocation',
        property: 'flex-grow',
        appliesTo: 'self',
        edgeResponse: 1,
        reason:
          `Measured: setting ${sizeProperty} on this element did not change its size — the flex ` +
          `algorithm resolves it from the free space. Change its flex allocation ` +
          `(flex-grow / flex-basis) instead.`,
      }
    }
    return {
      target: 'element',
      property: sizeProperty,
      appliesTo: 'self',
      edgeResponse: 0,
      reason:
        `Measured: setting ${sizeProperty} on this element did not change its size, and its parent ` +
        `is not a flex or grid container. Something else is constraining it.`,
    }
  }

  // ── Partially honoured ───────────────────────────────────────────────────
  // Asked for PROBE_PX and got materially less. Measured case: a shrinking flex
  // child asked 250px and got 100px. Prediction called this `element` ownership
  // because flex-grow was 0 — the naive edit then writes a width the layout
  // silently overrules.
  if (isFlex && probe.sizeDelta < PROBE_PX - EPSILON) {
    return {
      target: 'flex-allocation',
      property: 'flex-shrink',
      appliesTo: 'self',
      edgeResponse: Math.abs(probe.edgeDelta) / probe.sizeDelta,
      reason:
        `Measured: this element was asked for ${PROBE_PX}px more ${sizeProperty} and got ` +
        `${probe.sizeDelta.toFixed(1)}px — the flex line is over-constrained, so flex-shrink is ` +
        `overruling the declaration. Change its flex allocation instead.`,
    }
  }

  const edgeResponse = Math.abs(probe.edgeDelta) / probe.sizeDelta

  // ── A grid item whose growth REALLY moves the track ──────────────────────
  // Not every grid item does. Measured: under `justify-items: start` the item
  // grew, its right edge moved 50px, and the sibling never moved — so the naive
  // edit is exactly right and routing to the track was wrong. Requiring an
  // observed sibling movement distinguishes them without guessing.
  if (isGrid && probe.siblingMoved) {
    return {
      target: 'grid-track',
      property: TRACK_PROPERTY[axis],
      appliesTo: 'parent',
      edgeResponse,
      reason:
        `Measured: growing this element moved a sibling — its ${TRACK_PROPERTY[axis]} track ` +
        `re-allocated space rather than the element growing into its own. Shrinking will not ` +
        `move the sibling back, so resize the track instead.`,
    }
  }

  if (edgeResponse < EPSILON / PROBE_PX) {
    return {
      target: 'element',
      property: sizeProperty,
      appliesTo: 'self',
      edgeResponse: 0,
      reason:
        `Measured: this element's ${sizeProperty} changed but the ${edge} edge did not move — ` +
        `alignment pins it, and growth goes to the opposite side. Drag the opposite edge, or ` +
        `change the parent's alignment.`,
    }
  }

  return {
    target: 'element',
    property: sizeProperty,
    appliesTo: 'self',
    edgeResponse,
    reason:
      edgeResponse > 0.95 && edgeResponse < 1.05
        ? `Measured: ${sizeProperty} on the element controls this edge, and the edge tracks it 1:1.`
        : `Measured: the ${edge} edge moves ${edgeResponse.toFixed(2)}px per 1px of ${sizeProperty} — ` +
          `the element grows in more than one direction, so the drag delta must be scaled.`,
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
  return signed / ownership.edgeResponse
}
