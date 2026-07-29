/**
 * Read an element's class list as a string, for ANY element namespace.
 *
 * `Element.className` is a plain string only for HTML. On SVG and MathML it is
 * an `SVGAnimatedString` / `DOMTokenList`-adjacent object, so a bare
 * `el.className` read yields an object where callers expect text.
 *
 * Guarding with `typeof cls === 'string'` alone prevents the crash but silently
 * drops the classes — which matters most on the `agent-resolve` path, where a
 * third-party icon's `class="lucide lucide-check"` is the strongest signal
 * Claude gets for locating the call site. `getAttribute('class')` is namespace-
 * agnostic and returns the same text in every case, so it is the correct
 * fallback rather than an empty string.
 *
 * Returns `''` for an element with no class attribute — same shape callers
 * already branch on.
 */
export function classAttr(el: Element): string {
  return typeof el.className === 'string' ? el.className : (el.getAttribute('class') ?? '')
}
