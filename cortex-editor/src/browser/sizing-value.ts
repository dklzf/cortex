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
 * That applies on Firefox 148 (no `computedStyleMap`) and to pseudo-elements
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
 * back `160px`. Percentages and keywords DO survive (`100%`, `stretch`,
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
  const used = (): string => {
    const cs = getComputedStyle(element, pseudo)
    return (cs as unknown as Record<string, string>)[axis] ?? ''
  }

  // Typed OM cannot address a pseudo-element. Reading the originating element
  // and labelling it as the pseudo's size would be worse than the used value.
  if (pseudo) return used()

  try {
    // Feature detection lives INSIDE the try: reading the property can itself
    // throw on an element with a throwing accessor, and a panel read must never
    // be able to take the panel down.
    const withTypedOM = element as Element & { computedStyleMap?: () => { get(p: string): unknown } }
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
export function classifySizingValue(value: string): SizingMode {
  const v = value.trim().toLowerCase()

  // An absent value is not a fixed size. Treated as `auto`, the CSS initial.
  if (v === '' || v === 'auto') return 'auto'

  if (v === FILL_VALUE) return 'fill'
  if (v === FIT_VALUE) return 'fit'

  // A length, and only a length. `50%` and `100vw` deliberately fail this —
  // parseFloat would accept both and report them as pixel counts.
  if (PX_LENGTH.test(v)) return 'fixed'

  // Percentages, calc(), clamp(), min()/max(), stretch, the intrinsic sizes,
  // and anything else the panel can display faithfully but has no control for.
  return 'custom'
}

/** True when the panel may offer a numeric pixel input for this mode. */
export function isEditableAsPixels(mode: SizingMode): boolean {
  return mode === 'fixed'
}

/**
 * The element's rendered size in pixels, as a CSS length string.
 *
 * `getComputedStyle().width` is the USED value — and therefore a pixel count —
 * only when `width` actually APPLIES to the element. On a non-replaced inline
 * box it does not, so the resolved value falls back to the computed one:
 * `<span style="width:100%">hello world</span>` returns `"100%"` in Chromium
 * while rendering at 73.33px. Trusting that string put "100" in the panel's W
 * field and staged `100px` when the user switched the element to Fixed.
 *
 * Only in that case do we measure the border-box rect, which is always a real
 * measurement. The common path returns the computed-style value unchanged so
 * padded and bordered elements keep reporting the same box they always have.
 *
 * @param computed the element's `getComputedStyle()` value for this axis
 */
export function usedPixelSize(
  element: Element,
  computed: string,
  axis: 'width' | 'height',
  pseudo?: string,
): string {
  if (PX_LENGTH.test(computed.trim().toLowerCase())) return computed
  // A pseudo-element has no box of its own to measure — getBoundingClientRect
  // would return the ORIGINATING element's box, a different thing entirely. Its
  // computed style is the best answer available even when it is not a length.
  if (pseudo) return computed
  if (typeof element.getBoundingClientRect !== 'function') return computed
  const rect = element.getBoundingClientRect()
  return `${axis === 'width' ? rect.width : rect.height}px`
}
