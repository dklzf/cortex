/**
 * Authored sizing values and their classification into panel sizing modes.
 *
 * ## Why this module exists (B5)
 *
 * `getComputedStyle().width` cannot tell you an element's sizing mode. CSSOM
 * defines it to return the **resolved** value, and for `width`/`height` the
 * resolved value is specially defined as the **used** value — always pixels.
 * An element authored `width: 100%` reports `"1264px"`; one authored
 * `fit-content` reports `"10.67px"`; one authored `auto` reports `"1264px"`.
 * All three are indistinguishable from a genuine `width: 320px`.
 *
 * The Panel previously derived its mode from that pixel string, so every
 * element read as Fixed — including author-written `width: 100%`. The only
 * escape was `panel-style-snapshot.ts` substituting cortex's OWN override,
 * which is why keyword modes appeared to work for values cortex itself wrote.
 *
 * CSS Typed OM's `computedStyleMap()` returns the **computed** value —
 * post-cascade, post-inheritance, pre-layout — which is exactly what a sizing
 * mode is. Measured in Chromium 147 on the same elements:
 *
 * | authored        | getComputedStyle | computedStyleMap |
 * |-----------------|------------------|------------------|
 * | `100%`          | `1264px`         | `100%`           |
 * | `fit-content`   | `10.67px`        | `fit-content`    |
 * | `50%`           | `632px`          | `50%`            |
 * | `auto`          | `1264px`         | `auto`           |
 * | `.w-full` (TW)  | `1280px`         | `100%`           |
 *
 * Typed OM also sees cross-origin sheets, `adoptedStyleSheets`, shadow-root
 * styles and styled-components' `insertRule` mode — none of which a
 * `document.styleSheets` walker gets without reimplementing the cascade. It is
 * also ~3,000x cheaper than walking (0.0045ms for a 17-property snapshot vs
 * 13.5ms for a filtered walk over a real Tailwind + Bootstrap page).
 *
 * ## Known limitations, stated rather than hidden
 *
 * **1. Units do not survive.** Typed OM returns the COMPUTED value, and
 * computed-value time absolutises lengths. Measured in Chromium 147:
 * `20rem` -> `320px`, `50vw` -> `640px`, `10em` -> `160px`. So a rem- or
 * token-authored width is indistinguishable from a hand-written pixel width: it
 * reports Fixed, and editing it writes px and breaks the linkage. Percentages
 * and keywords DO survive, which is what makes mode detection work at all.
 * Recovering the original unit needs the SPECIFIED value — a cascade walk —
 * which is out of scope (plan §9b).
 *
 * **2. Where Typed OM is unavailable, the mode is unknowable and we say Fixed.**
 * That applies on any engine without `computedStyleMap` — Firefox 148 AND
 * WebKit/Safari, which has never shipped it, so this is two of the three major
 * engines rather than one; the earlier framing understated it — and to pseudo-elements
 * (no pseudo support). Both fall back to the used pixel value, which classifies
 * as `fixed`, so the pixel input stays enabled — a `::before { width: 50% }`
 * can still be edited into a fixed pixel width.
 *
 * This is a deliberate choice, not an oversight. Classifying the fallback as
 * `custom` would be more truthful, but `custom` disables the pixel input, which
 * would remove width editing ENTIRELY on Firefox and for every pseudo-element.
 * That trades a labelling inaccuracy for the loss of a working feature. Neither
 * behaviour is a regression — before this module every element reported Fixed
 * on every engine. Revisit if Firefox ships Typed OM, or if the panel grows a
 * read-only presentation that can show a mode without enabling its editor.
 *
 * Both limitations were raised in external review and consciously deferred.
 */

/**
 * A sizing mode as DISPLAYED by the panel.
 *
 * Note this is deliberately wider than the set a user can SELECT. `auto` and
 * `custom` are states an element can be in but not states you can switch to —
 * "make this auto" is not a coherent instruction, and `custom` covers values
 * (`calc()`, `50%`, `clamp()`) that the panel can report faithfully but has no
 * single control for. Selectable modes live in `SizingDropdown`.
 */
export type SizingMode = 'fixed' | 'fit' | 'fill' | 'auto' | 'custom'

/**
 * The modes a user can SWITCH TO — a strict subset of {@link SizingMode}.
 *
 * Separate type, not just a narrower array, so the invariant is enforced by the
 * compiler instead of by convention. `SizingControls.handleWidthModeChange`
 * branches `fit` / `fill` / else-write-pixels; handed `custom` or `auto` it
 * would take the else branch and pin a pixel width on an element the user never
 * asked to make fixed. Typing the callback with this makes that unrepresentable
 * rather than merely unlikely.
 */
export type SelectableSizingMode = Extract<SizingMode, 'fixed' | 'fit' | 'fill'>

/**
 * `fill` and `fit` are SELECTABLE modes, so the only values that may map to them
 * are the exact values cortex writes back — `100%` and `fit-content`.
 *
 * This is narrower than "values that mean roughly this", deliberately. Selecting
 * an already-active mode fires an unconditional write, so any value folded in
 * here is silently rewritten to the canonical one the moment the user clicks the
 * mode that is already showing:
 *
 *   - `stretch` sizes the MARGIN box; `100%` sizes the content box. Folding them
 *     together turned a 200px content-box child with 20px padding and 5px
 *     borders into a 250px overflowing one, from a click that looked like a
 *     no-op. (css-sizing-4 §stretch-fit-sizing)
 *   - `min-content` and `max-content` are distinct intrinsic sizes, measured at
 *     33.78px and 93.30px for identical content in Chromium. Folding them into
 *     `fit` rewrote them to `fit-content`.
 *
 * Everything else that means "fill-ish" or "fit-ish" classifies as `custom`:
 * reported faithfully, never silently rewritten. Verified in Chromium 147 —
 * Typed OM returns `stretch`, `min-content` and `max-content` verbatim, so they
 * genuinely do reach this function.
 */
const FILL_VALUE = '100%'
const FIT_VALUE = 'fit-content'

/** A CSS <length> in px, including the scientific notation Chromium emits for
 *  large values (`width: 1000000px` serialises as `1e+06px`). */
const PX_LENGTH = /^-?(?:\d*\.?\d+|\d*\.?\d+e[+-]?\d+)px$/

/**
 * Read an element's COMPUTED size for one axis.
 *
 * Computed, not authored — the distinction is load-bearing and this function was
 * originally misnamed `readAuthoredSize`. Computed-value time absolutises
 * lengths, so the original unit does not survive: measured in Chromium 147,
 * `width: 20rem` comes back `320px`, `50vw` comes back `640px`, `10em` comes
 * back `160px`. So viewport and font-relative units reach `classifySizingValue`
 * as plain pixel strings and report `fixed` — the `custom` bucket never sees
 * them in practice, and its `100vw` test case documents the classifier's
 * behaviour on an input the real pipeline cannot deliver. Percentages and keywords DO survive (`100%`, `stretch`,
 * `min-content`), which is what makes mode detection possible at all.
 *
 * Consequence, stated rather than implied: a token- or rem-authored width is
 * indistinguishable from a hand-written pixel width, so it reports `fixed` and
 * editing it writes px, breaking the unit linkage. Recovering unit provenance
 * needs the specified value (a cascade walk), which is out of scope here — see
 * the plan's §9b B5 scope note. This is pre-existing behaviour, not a
 * regression: before this module every element reported `fixed`.
 *
 * Falls back to the used pixel value — which cannot express a mode — when:
 *   - the engine lacks Typed OM (Firefox)
 *   - a pseudo-element is being inspected (Typed OM has no pseudo support;
 *     passing `'::before'` is silently ignored and you get the ORIGINATING
 *     element's value, which is a different box entirely)
 *   - `.get()` throws (it raises TypeError on an unrecognised property)
 *   - `.get()` returns undefined
 *
 * The fallback is honest but lossy: the caller will classify a pixel string as
 * `fixed`, which on Firefox is the pre-existing behaviour rather than a
 * regression.
 */
export function readComputedSize(
  element: Element,
  axis: 'width' | 'height',
  pseudo?: string,
): string {
  // `cs[axis]` needs no cast: lib.dom.d.ts declares `width`/`height` on
  // CSSStyleDeclaration as named `string` properties (not via an index
  // signature), so the union-typed `axis` indexes it natively.
  //
  // The `?? ''` looks provably dead against that type — and is NOT. Ambient DOM
  // types describe the SPEC, not whichever implementation is loaded: happy-dom
  // returns `undefined` here, and deleting the fallback on type-level reasoning
  // alone crashed 9 panel tests with `Cannot read properties of undefined
  // (reading 'trim')`. This codebase runs against three DOM implementations, so
  // "the declaration says it cannot be undefined" is not a runtime guarantee.
  const used = (): string => getComputedStyle(element, pseudo)[axis] ?? ''

  // Typed OM cannot address a pseudo-element. Reading the originating element
  // and labelling it as the pseudo's size would be worse than the used value.
  if (pseudo) return used()

  try {
    // Feature detection lives INSIDE the try: reading the property can itself
    // throw on an element with a throwing accessor, and a panel read must never
    // be able to take the panel down.
    // Optional because TS declares `computedStyleMap` unconditionally while
    // Firefox does not ship it — the `?` models runtime reality. The RETURN
    // type is the real ambient one, so `.get()` yields `CSSStyleValue |
    // undefined` rather than `unknown`.
    const withTypedOM = element as Element & { computedStyleMap?: () => StylePropertyMapReadOnly }
    if (typeof withTypedOM.computedStyleMap !== 'function') return used()
    const value = withTypedOM.computedStyleMap().get(axis)
    if (value === undefined || value === null) return used()
    return String(value)
  } catch {
    // TypeError on an unrecognised property. A panel read must never be able
    // to take the panel down.
    return used()
  }
}

/**
 * Classify an authored value into a displayable sizing mode.
 *
 * The old implementation was a *decoder* of cortex's own write vocabulary
 * (`fit-content` / `100%` / `<n>px`) with `return 'fixed'` as its fall-through.
 * Used as a *classifier* over arbitrary authored CSS, that fall-through is what
 * made every element read Fixed.
 *
 * `custom` matters as much as the rest: without it, `50%` classifies as fixed
 * and the panel renders "50 px" for an element that is half its parent's width.
 */
/**
 * One axis of sizing, as ONE value (COR-6).
 *
 * `LayoutValues` used to carry two independently-optional strings per axis:
 * `width` (what the developer wrote — `100%`, `fit-content`, `320px`) and
 * `widthUsed` (how wide the box actually is — `1264px`). Nothing forced them to
 * be filled in together.
 *
 * That was a trap with no type-level protection. A future producer setting a
 * non-fixed `width` and forgetting `widthUsed` makes the panel render "0",
 * indistinguishable from an empty selection — and clicking "Fixed" then writes
 * `width: 0px` and collapses the element. That is precisely the bug B5 was
 * written to fix, reachable through a second door.
 *
 * Three things this shape buys:
 *   - the pairing is enforced by there being ONE field, not two that must agree
 *   - `usedPx` is a number, which kills the `parseFloat(… ?? '')` NaN dance at
 *     every call site
 *   - `mode` is classified ONCE by the producer instead of re-derived on every
 *     render by each consumer
 */
export interface SizingDimension {
  /** What `classifySizingValue` decided about `authored`. */
  mode: SizingMode
  /** The value as WRITTEN. May be `100%`, `fit-content`, `auto` — none of which
   *  are measurements, which is exactly why `usedPx` exists separately. */
  authored: string
  /** The rendered size in CSS pixels, or null when genuinely unmeasured (an
   *  empty selection, a test that supplies no computed styles). Null is a real
   *  state and must not be conflated with zero — a box of width 0 and a box
   *  nobody measured are different facts. */
  usedPx: number | null
}

/**
 * Build a `SizingDimension` from the two strings a producer has.
 *
 * The single constructor is the point: it is the only place the authored value
 * and the used value are brought together, so they cannot be set apart. A
 * `used` string that is not a length (`auto` on a display:inline element)
 * yields `usedPx: null` rather than NaN.
 */
export function makeSizingDimension(authored: string, used: string | undefined): SizingDimension {
  const usedNum = used === undefined ? Number.NaN : Number.parseFloat(used)
  return {
    mode: classifySizingValue(authored),
    authored,
    usedPx: Number.isFinite(usedNum) ? usedNum : null,
  }
}

export function classifySizingValue(value: string): SizingMode {
  const v = value.trim().toLowerCase()

  // An absent value is not a fixed size. Treated as `auto`, the CSS initial.
  if (v === '' || v === 'auto') return 'auto'

  if (v === FILL_VALUE) return 'fill'
  if (v === FIT_VALUE) return 'fit'

  // A length, and only a length. `50%` and `100vw` deliberately fail this —
  // parseFloat would accept both and report them as pixel counts.
  //
  // The magnitude guard is defence-in-depth, not paranoia about CSS: these
  // values come from a page cortex does not control, and `computedStyleMap` /
  // `getComputedStyle` are page-overridable prototype methods. A hijacked one
  // returning `1e300px` would otherwise classify as fixed and seed that number
  // into a staged edit. Raised in security review; bounded well above any real
  // layout (100 million px) so it cannot reject a legitimate value.
  if (PX_LENGTH.test(v)) {
    const n = Number.parseFloat(v)
    return Number.isFinite(n) && Math.abs(n) <= 1e8 ? 'fixed' : 'custom'
  }

  // Percentages, calc(), clamp(), min()/max(), stretch, the intrinsic sizes,
  // and anything else the panel can display faithfully but has no control for.
  return 'custom'
}

/**
 * Tags whose inline boxes are REPLACED, and therefore do honour width/height.
 *
 * `width` does not apply to a non-replaced inline box (CSS2.1 §10.2), but it
 * applies normally to a replaced one — an `<img>` is `display: inline` by
 * default and is still sized by `width`. Detecting "replaced" from computed
 * style alone is not possible, so this is a tag allowlist, matching the
 * existing `SVG_SIZING_CAPABLE_TAGS` / `WIDGET_TAGS` pattern in this codebase.
 */
const REPLACED_TAGS: ReadonlySet<string> = new Set([
  'img', 'video', 'canvas', 'iframe', 'embed', 'object', 'audio', 'svg',
  'input', 'select', 'textarea', 'button', 'progress', 'meter', 'marquee',
])

/**
 * True when `width`/`height` have no effect on this element whatsoever.
 *
 * A non-replaced inline box ignores them completely — MEASURED, not inferred:
 * setting `width: 300px` and then `width: 40px` on a `<span>` left its rendered
 * width at 73.33px both times.
 *
 * This matters more than it looks. `getComputedStyle().width` on such an element
 * returns the COMPUTED value rather than a used pixel length, so before any edit
 * it reports `100%`. But once a pixel width has been written it dutifully echoes
 * `73.32px` back — which classifies as `fixed`, enables the pixel input, and
 * leaves the user scrubbing a number that can never move anything. That is the
 * dead-control failure this codebase already guards against for SVG geometry;
 * the same treatment applies here.
 */
export function isSizeInert(element: Element): boolean {
  let display: string
  try {
    display = getComputedStyle(element).display
  } catch {
    return false
  }
  if (display !== 'inline') return false
  return !REPLACED_TAGS.has(element.localName)
}
