import type { ConstraintOwnership, ResizeEdge } from './constraint-owner.js'

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
      // dragged axis lets `width` take effect, and leaves the TRACK alone —
      // editing `grid-template-columns` would resize the item's neighbours
      // too, which is not what the user dragged.
      return {
        ok: true,
        writes: [{ property: SELF_ALIGN[edge], value: 'start' }, { property: size, value }],
      }
  }
}
