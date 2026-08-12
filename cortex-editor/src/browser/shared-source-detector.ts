import { deepQueryAllElements } from './selection-metadata.js'

export interface SharedSourceInfo {
  /** The data-cortex-source value that is shared (e.g., 'src/Card.tsx:42') */
  source: string
  /**
   * All elements in the DOM that share this source value. Typed as `Element[]`
   * (not `HTMLElement[]`) because cortex's source-transform annotates every
   * JSX element — including SVG / MathML / other namespaced elements that
   * are not `HTMLElement` instances. A `.map()` over an icon list rendered
   * as `<svg>` siblings is a real case; filtering to `HTMLElement` here would
   * silently undercount.
   */
  elements: Element[]
  /** Count of elements sharing this source value */
  count: number
}

/**
 * Detect if a selected element's source location is shared by multiple DOM elements.
 *
 * Business logic: When a user selects an element in the visual editor, this
 * function determines whether editing it would affect other elements rendered
 * from the same source location (e.g., list items from the same .map() call).
 * If so, the Panel can display an "Editing all N" scope banner, letting the
 * designer make an informed decision before applying changes.
 *
 * This parallels detectSharedClasses (for CSS-Module elements) but operates
 * on `data-cortex-source` instead — covering non-CSS-Module elements such as
 * Mantine (~80%) and Tailwind (~17%) stacks.
 *
 * Returns SharedSourceInfo when 2+ elements share the source value, or null
 * if no sharing is detected (element has no attribute, or count <= 1).
 */
export function detectSharedSource(el: Element): SharedSourceInfo | null {
  const source = el.getAttribute('data-cortex-source')
  if (!source) return null

  // Build the attribute selector, applying defensive CSS.escape for malformed
  // source strings. Pattern reused verbatim from selection-source-expand.ts:44-49.
  let escaped: string
  try {
    escaped = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(source) : source.replace(/(["\\])/g, '\\$1')
  } catch {
    escaped = source.replace(/(["\\])/g, '\\$1')
  }

  const selector = `[data-cortex-source="${escaped}"]`

  let flat: Element[]
  try {
    // Always use deep traversal so the count is symmetric across both
    // shadow scenarios: (a) selected element lives in a shadow root with
    // siblings in light or shadow DOM; (b) selected element lives in light
    // DOM with siblings inside open shadow roots. A document-only query
    // would undercount in either case. Cost is one `*` walk per detection;
    // for typical apps without open shadow roots the recursion is a no-op
    // beyond the initial `*` scan, which is acceptable for correctness.
    //
    // deepQueryAllElements (Element[], no HTMLElement filter) so SVG /
    // MathML / other namespaced siblings that source-transform annotated
    // are counted too — `.map()` over icon lists rendered as <svg> nodes
    // is a real case the HTMLElement filter would silently miss.
    flat = deepQueryAllElements(selector)
  } catch {
    // Malformed selector despite escape — treat as no matches.
    return null
  }

  if (flat.length <= 1) return null

  return {
    source,
    elements: flat,
    count: flat.length,
  }
}
