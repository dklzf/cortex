// Element (not HTMLElement): tag-name classification works for all Elements.
const NON_VISUAL_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'meta', 'head', 'title', 'link', 'noscript', 'template'])
const DOCUMENT_ROOT_TAGS: ReadonlySet<string> = new Set(['html', 'body'])

/**
 * SVG elements that DEFINE resources rather than render anything: gradients,
 * clip paths, masks, symbols, and metadata. They have no geometry, so
 * `getBoundingClientRect()` is all-zero — selecting one parks the selection
 * overlay at the viewport origin, detached from the icon it belongs to, and
 * every box-model control in the panel is inert on it.
 *
 * These are unreachable by CLICK (hit-testing needs geometry) but ARE reachable
 * through the Layer Tree and the child-navigation button, which walk
 * `element.children` directly. Figma-exported SVG commonly opens with `<defs>`,
 * so this is the first child a designer would land on.
 *
 * Names are folded to lowercase before lookup, so the camelCase SVG spellings
 * (`clipPath`, `linearGradient`, `radialGradient`) appear here already folded.
 */
const NON_RENDERED_SVG_TAGS: ReadonlySet<string> = new Set([
  'defs', 'clippath', 'mask', 'marker', 'pattern', 'symbol', 'filter',
  'lineargradient', 'radialgradient', 'metadata', 'desc',
])

export function isNonEditable(el: Element): boolean {
  const tagName = el.tagName.toLowerCase()
  return NON_VISUAL_TAGS.has(tagName)
    || DOCUMENT_ROOT_TAGS.has(tagName)
    || NON_RENDERED_SVG_TAGS.has(tagName)
}
