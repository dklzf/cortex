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
 * Firefox 148 does not implement it, so we fall back to the used value there.
 * That fallback is lossy by construction: on Firefox a `100%` element still
 * reports a pixel length and classifies as Fixed. Stated rather than hidden.
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

/** Values that mean "take the space my parent gives me". */
const FILL_KEYWORDS = new Set(['100%', 'stretch', '-webkit-fill-available'])

/** Prefixes that mean "size to my content". `fit-content(<len>)` is included. */
const FIT_PREFIXES = ['fit-content', 'max-content', 'min-content']

/**
 * Read an element's authored (computed) size for one axis.
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
export function readAuthoredSize(
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

  const withTypedOM = element as Element & { computedStyleMap?: () => { get(p: string): unknown } }
  if (typeof withTypedOM.computedStyleMap !== 'function') return used()

  try {
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

  if (FILL_KEYWORDS.has(v)) return 'fill'
  if (FIT_PREFIXES.some(p => v === p || v.startsWith(`${p}(`))) return 'fit'

  // A length, and only a length. `50%` and `100vw` deliberately fail this —
  // parseFloat would accept both and report them as pixel counts.
  if (v.endsWith('px')) {
    const n = Number.parseFloat(v)
    if (Number.isFinite(n) && `${n}px` === v) return 'fixed'
    // Tolerate serialisation differences (e.g. `12.50px`) without accepting
    // anything that merely starts with a number.
    if (Number.isFinite(n) && /^-?\d*\.?\d+px$/.test(v)) return 'fixed'
  }

  // Percentages, calc(), clamp(), min()/max(), viewport units, and anything
  // else the panel can display faithfully but cannot offer a control for.
  return 'custom'
}

/** True when the panel may offer a numeric pixel input for this mode. */
export function isEditableAsPixels(mode: SizingMode): boolean {
  return mode === 'fixed'
}
