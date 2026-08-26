import { measureConstraintOwner, type ConstraintOwnership, type ResizeEdge } from './constraint-owner.js'

/**
 * What to write so a dragged element ends up at a FIXED size it owns itself.
 *
 * ## The product rule this encodes
 *
 * A drag always pins. Whatever the element's width was doing before —
 * stretching to fill a flex line, filling a grid track, hugging its content —
 * dragging an edge makes it a fixed number of pixels, and the panel (or undo)
 * puts it back. That is Figma's model, and it is one rule with no special
 * cases for the user to learn.
 *
 * ## Why that needs MORE than a width write
 *
 * `width: 300px` does not survive a parent that overrules it. A flex child with
 * `flex-grow: 1` is sized by the line's free space, and a stretched grid item
 * is sized by its track — in both cases the declaration lands and the element
 * does not move, which reads as a broken drag. `measureConstraintOwner` already
 * identifies which case applies (that is the whole point of COR-3), so pinning
 * means neutralising the parent's control AND setting the size, together.
 *
 * The writes are returned as a list so the caller can put them through
 * `applyOverride` in one tick — `commitScrub` coalesces same-tick writes into a
 * single undo entry, so Cmd+Z restores the element's previous behaviour in one
 * step rather than unpicking three declarations.
 */

/**
 * Beyond this, the number is a symptom rather than an intent.
 *
 * `pointerDeltaToSizeDelta` divides pointer travel by `edgeResponse`, and the
 * engine accepts any response at or above `EDGE_EPSILON` (0.02). At the bottom
 * of that band the division amplifies 50x, so a 100px drag asks for ~5000px of
 * width — and responses in the 0.02-0.1 range are ordinary output from
 * sub-pixel alignment and partial-absorption layouts, not a hostile page.
 *
 * The engine's threshold answers "does this edge respond at all". It cannot
 * answer "is the amplified number still something a person meant", because
 * that depends on the drag. This is where that question belongs.
 *
 * 100,000px is ~26x a 4K viewport: past any real layout, short of the range
 * where CSS itself gives up, and deliberately not tight enough to argue about.
 */
const MAX_PX = 100_000

export interface PinWrite {
  property: string
  value: string
}

export type PinResult =
  | { ok: true; writes: PinWrite[] }
  /** The size cannot be pinned by writing on this element. `reason` is prose
   *  from the engine, meant to be shown to the user. */
  | { ok: false; reason: string }

const SIZE_PROPERTY: Record<ResizeEdge, 'width' | 'height'> = {
  left: 'width', right: 'width', top: 'height', bottom: 'height',
}

/** `justify-self` runs along the inline axis, `align-self` along the block one. */
const SELF_ALIGN: Record<ResizeEdge, 'justify-self' | 'align-self'> = {
  left: 'justify-self', right: 'justify-self', top: 'align-self', bottom: 'align-self',
}

/**
 * Turn a measured ownership plus a target size into the declarations to write.
 *
 * `px` is the size the user dragged to, in CSS pixels, already converted from
 * pointer travel by `pointerDeltaToSizeDelta`.
 */
export function pinToFixed(
  ownership: ConstraintOwnership,
  edge: ResizeEdge,
  px: number,
): PinResult {
  const size = SIZE_PROPERTY[edge]

  // Refuse a number before it becomes a string, because after that it is
  // indistinguishable from an intentional one.
  //
  // `VALID_VALUE` (css-validation.ts) is a CHARSET allowlist, not a grammar —
  // `NaNpx` and `Infinitypx` are pure letters and pass it cleanly. They would
  // reach the staging buffer and be handed to the agent as the value to write
  // into source. `NaN` arrives whenever a rect read yields a non-number, and
  // it survives every arithmetic guard upstream: `Math.max(1, NaN)` is `NaN`,
  // and the `edgeResponse === 0` check does not fire because `NaN !== 0`.
  if (!Number.isFinite(px)) {
    return { ok: false, reason: 'cortex measured an impossible size for this element, so nothing was changed.' }
  }
  if (px > MAX_PX) {
    return {
      ok: false,
      reason: 'This edge barely moves when its size changes, so cortex would have to write an unreasonable number to follow your drag. Nothing was changed.',
    }
  }

  // Rounded to whole pixels. A drag produces sub-pixel floats, and writing
  // `width: 300.4px` into someone's source is noise in a diff for a precision
  // no one asked for and no display can show.
  const value = `${Math.round(px)}px`

  // `edgeResponse: 0` means the probe moved the size and the edge did not
  // follow — the element is genuinely pinned by something this write cannot
  // reach (`position: fixed` inside a clamp, an `!important` author rule, a
  // non-rendered box). The engine's `reason` explains which, in prose written
  // for a person.
  if (ownership.edgeResponse === 0) {
    return { ok: false, reason: ownership.reason }
  }

  switch (ownership.target) {
    case 'element':
      return { ok: true, writes: [{ property: size, value }] }

    case 'flex-allocation':
      // `flex: none` is the shorthand for `0 0 auto` — stop growing, stop
      // shrinking, take your size from `width`. Written as the shorthand
      // rather than three longhands because it is what a developer reads as
      // "this one is fixed now", and it cannot leave a stale `flex-basis`
      // behind the way setting grow/shrink alone would.
      return { ok: true, writes: [{ property: 'flex', value: 'none' }, { property: size, value }] }

    case 'grid-track':
      // The item is stretched to fill its track. Un-stretching it along the
      // dragged axis is what lets `width` take effect at all.
      //
      // It does NOT leave the neighbours alone, and an earlier version of this
      // comment claimed it did. Measured in Chromium 147 (and pinned by
      // `resize-grid-neighbour.spec.ts`): in `grid-template-columns: 1fr 1fr`
      // at 600px, pinning one item to 500px takes the sibling from 300 to 100.
      //
      // `1fr` is `minmax(auto, 1fr)`, and that `auto` minimum is content-based,
      // so an explicit `width` RAISES it and the track grows to fit. In a
      // fixed-width grid that space comes out of the neighbour.
      // `justify-self` governs the item's alignment INSIDE its track; it has no
      // say in how the track is sized. The two are separate mechanisms and the
      // old comment conflated them.
      //
      // Kept anyway, because there is no better write available. Measured, all
      // in the same spec — on a 600px `1fr 1fr` grid, pinning item A to 500px:
      //
      //   1fr 1fr                        -> A 500, B 100   (sibling absorbs it)
      //   1fr 1fr + min-width: 0 on A    -> A 500, B 100   (no effect)
      //   1fr 1fr + max-width on A       -> A 500, B 100   (no effect)
      //   minmax(0,1fr) x2               -> A 500, B 300, A OVERFLOWS B
      //
      // So NO declaration on the item protects the sibling. The only lever is
      // the track definition, which lives on the PARENT — and when an author has
      // already written `minmax(0,1fr)`, the sibling is protected and the item
      // overflows it instead, which is worse than moving it.
      //
      // That is COR-3's whole thesis arriving as a measurement: the parent owns
      // the allocation, and no child declaration takes that back. The pin can
      // neutralise the parent's ALIGNMENT control (`justify-self`); its
      // ALLOCATION control is `grid-template-columns` and stays where it is.
      // Rewriting that would resize every item in the row, which is not what
      // the user dragged.
      return {
        ok: true,
        writes: [{ property: SELF_ALIGN[edge], value: 'start' }, { property: size, value }],
      }
  }
}


/**
 * Do the other elements this write will reach have the SAME constraint owner?
 *
 * A drag measures ONE element. `applyOverride` fans the result out to every
 * selected element and — when the scope is `all`, which is the default the
 * moment a shared class exists — to every element sharing that class. So a
 * single-handle drag on one card routinely writes to several.
 *
 * Usually that is fine, because shared-class elements usually sit in the same
 * container and therefore share a layout context. It stops being fine when the
 * same class is reused across DIFFERENT containers: `.card` in a flex row here
 * and a plain block there. The pin for a plain block is `width` alone, and a
 * stretched flex child receiving `width` alone does not move — the declaration
 * lands in source and nothing happens, which is exactly the failure
 * `pinToFixed` exists to prevent, arriving through the fan-out door.
 *
 * Costs one probe per target, at release only — never per pointermove. `others`
 * should exclude the measured element; probing it again would only re-derive
 * `measured`.
 */
export function fanOutOwnershipConflicts(
  measured: ConstraintOwnership,
  others: Element[],
  edge: ResizeEdge,
): { element: Element; ownership: ConstraintOwnership }[] {
  const conflicts: { element: Element; ownership: ConstraintOwnership }[] = []
  for (const el of others) {
    let owner: ConstraintOwnership
    try {
      owner = measureConstraintOwner(el, edge)
    } catch {
      // A target we cannot measure is a target we cannot vouch for. Counting it
      // as a conflict is the conservative read, and it keeps a cross-origin or
      // detached element from being silently treated as agreeing — "I could not
      // check" and "I checked and it is fine" are different answers.
      conflicts.push({
        element: el,
        ownership: { ...measured, target: 'element', edgeResponse: 0, reason: 'cortex could not measure this element.' },
      })
      continue
    }
    // `target` is what decides WHICH declarations the pin writes, so it is the
    // field that has to agree. `edgeResponse` is a magnitude and will differ by
    // a few percent between siblings without changing what gets written.
    if (owner.target !== measured.target || owner.edgeResponse === 0) {
      conflicts.push({ element: el, ownership: owner })
    }
  }
  return conflicts
}
