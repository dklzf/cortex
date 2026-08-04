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

/**
 * Why a selection is sometimes expanded and sometimes not (B4).
 *
 * `expandSharedSource` is correct for a STYLE edit and wrong for a STRUCTURAL
 * one, and the difference is not a preference — it falls out of how each kind
 * of edit reaches source.
 *
 * A style edit is written by the CSS override layer, which keys on source:
 * `overrideManager.set(source, prop, val)` emits ONE rule targeting
 * `[data-cortex-source="<src>"]`, matching every instance. There is no way to
 * style a strict subset of shared-source nodes, because they are one piece of
 * source code. Expanding the selection makes the editor honest about that: the
 * user sees the full set their edit will affect.
 *
 * A structural move is not written that way. Reordering `.map()`-rendered
 * siblings means reordering the underlying ARRAY — an edit that acts on one
 * instance and is perfectly expressible. So the source-keyed justification does
 * not transfer, and expanding actively breaks the gesture: cortex's own
 * motivating example is "grab one button out of a grouped row", which cannot
 * happen if clicking one button selects all N.
 *
 * Hence an explicit opt-out rather than a global change. Default behaviour is
 * unchanged; only a caller that knows it is performing a per-instance operation
 * turns expansion off, and it must say so.
 */
export interface SelectionTargetOptions {
  /**
   * `true` (default) — expand to every instance sharing a `data-cortex-source`.
   * Correct for style edits, which the override layer applies per source.
   *
   * `false` — take the elements exactly as given. Correct for structural moves,
   * which act on a single instance.
   */
  expandShared?: boolean
}

/**
 * Resolve the elements a selection should actually contain.
 *
 * Extracted as a pure function (rather than inlined in CortexApp's
 * `setSelection`) so the expand/no-expand decision is testable on its own,
 * without mounting the app or synthesising a drag.
 */
export function resolveSelectionTargets(
  elements: Element[],
  options?: SelectionTargetOptions,
): Element[] {
  if (options?.expandShared === false) return elements
  return expandSharedSource(elements)
}
