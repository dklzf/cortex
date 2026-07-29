/**
 * Auto-expand a selection to include all DOM nodes sharing the same
 * `data-cortex-source` attribute (ZF0-1195 Follow-up A).
 *
 * Why: cortex-editor's source-attribution model is "edit source code, see all
 * runtime instances update." JSX inside a `.map()` (or any component used N
 * times) produces N runtime DOM nodes with the SAME `data-cortex-source`. The
 * CSS override layer keys on source — overrideManager.set(source, prop, val)
 * writes one rule that targets `[data-cortex-source="<src>"]`, matching all N
 * instances. There is no way to edit a strict subset of shared-source nodes,
 * because they share the same source code.
 *
 * Without this expand, the user can multi-select 2 of 3 .map() instances and
 * be surprised when their edit affects all 3. Expanding the selection makes
 * the editor model honest: if the user clicks one shared-source node, they
 * select the whole group.
 *
 * Elements without `data-cortex-source` (e.g., DOM nodes outside the user's
 * source tree) pass through unchanged — those are typically excluded from
 * fan-out anyway, but the expander preserves them for selection-overlay
 * rendering and the `setSelection([], 'replace')` clear path.
 */
export function expandSharedSource(elements: Element[]): Element[] {
  if (elements.length === 0) return elements
  const result: Element[] = []
  const seen = new Set<Element>()
  const seenSources = new Set<string>()
  for (const el of elements) {
    if (seen.has(el)) continue
    const source = el.getAttribute('data-cortex-source')
    if (!source) {
      seen.add(el)
      result.push(el)
      continue
    }
    if (seenSources.has(source)) continue
    seenSources.add(source)
    // PR #104 review C3: emit the explicitly clicked element FIRST so it
    // becomes the primary (selectedElements[0]) — querySelectorAll order is
    // DOM-document order, which may put a sibling before the clicked element
    // and silently shift primary-selection behavior.
    seen.add(el)
    result.push(el)
    let escaped: string
    try {
      escaped = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(source) : source.replace(/(["\\])/g, '\\$1')
    } catch {
      escaped = source.replace(/(["\\])/g, '\\$1')
    }
    // No `<HTMLElement>` generic: it was a compile-time lie. SVG siblings
    // sharing a source already flowed through here at runtime.
    let matches: NodeListOf<Element>
    try {
      matches = document.querySelectorAll(`[data-cortex-source="${escaped}"]`)
    } catch {
      // Malformed selector despite escape — clicked element already pushed above.
      continue
    }
    for (const m of matches) {
      if (!seen.has(m)) {
        seen.add(m)
        result.push(m)
      }
    }
  }
  return result
}
