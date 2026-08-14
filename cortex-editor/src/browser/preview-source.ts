import { classAttr } from './class-attr.js'
import { MAX_SOURCE_HINT_FIELD_BYTES, PREVIEW_SOURCE_PREFIX, isPreviewSource } from '../shared/preview-source.js'
export { MAX_SOURCE_HINT_FIELD_BYTES, PREVIEW_SOURCE_PREFIX, isPreviewSource } from '../shared/preview-source.js'

export const PREVIEW_SOURCE_ATTR = 'data-cortex-preview-id'

let previewIdCounter = 0
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface SourceResolutionHint {
  tagName: string
  className?: string
  id?: string
  textPreview: string
  domSelector: string
}

export type ElementEditTarget =
  | { source: string; applyMode: 'direct'; sourceResolutionHint?: undefined }
  | { source: string; applyMode: 'agent-resolve'; sourceResolutionHint: SourceResolutionHint }

export function selectorForEditSource(source: string): string {
  if (isPreviewSource(source)) {
    return `[${PREVIEW_SOURCE_ATTR}="${CSS.escape(source.slice(PREVIEW_SOURCE_PREFIX.length))}"]`
  }
  return `[data-cortex-source="${CSS.escape(source)}"]`
}

/**
 * The source string a container child reads back as, WITHOUT minting anything.
 *
 * The read-only twin of `getElementEditTarget(el).source`, and the pair must
 * stay in lock-step: the producer calls the minting one to build a structural
 * intent's `baseline`, and the drift guard calls this one to re-derive it from
 * the live DOM. Two hand-written copies of "source first, else preview id"
 * disagree the moment one of them is edited — and the failure is not loud. The
 * producer would stamp a preview id on an already-annotated child, write that
 * into the baseline, and the guard would read the `data-cortex-source` beside
 * it and report drift on a tree nobody touched.
 *
 * Returns '' for a child with neither. That is a real state — the guard must
 * not mint during a read-only reconcile — and the empty string is why COR-35's
 * `childKeys` exists: two unannotated children are otherwise identical here.
 */
export function readChildSource(el: Element): string {
  const source = el.getAttribute('data-cortex-source')
  if (source) return source
  const previewId = el.getAttribute(PREVIEW_SOURCE_ATTR)
  return previewId ? `${PREVIEW_SOURCE_PREFIX}${previewId}` : ''
}

export function getElementEditTarget(el: Element): ElementEditTarget {
  const source = el.getAttribute('data-cortex-source')
  if (source) return { source, applyMode: 'direct' }

  const previewId = ensurePreviewId(el)
  const previewSource = `${PREVIEW_SOURCE_PREFIX}${previewId}`
  return {
    source: previewSource,
    applyMode: 'agent-resolve',
    sourceResolutionHint: buildSourceResolutionHint(el),
  }
}

/**
 * An agent-resolve target for `el`, minting a preview id EVEN IF the element
 * already carries a `data-cortex-source`.
 *
 * `getElementEditTarget` returns the direct target for a stamped element, and
 * for a style edit that is right — a file position is a better address than a
 * locator. A structural intent cannot use it, for two independent reasons that
 * happen to have the same fix:
 *
 *  1. `structuralIntentSchema` FORCES `applyMode: 'agent-resolve'` — there is
 *     no deterministic move rewriter — and that mode requires a hint.
 *  2. A `data-cortex-source` names a source LOCATION, and the drift guard
 *     resolves it through a first-seen-wins document index. Two `<Column/>`s
 *     rendering one `.map()` give every row the same source, so the lookup
 *     returns the FIRST column's row and the guard would check the wrong
 *     container's children. A preview id is unique per rendered instance.
 */
export function getAgentResolveTarget(el: Element): Extract<ElementEditTarget, { applyMode: 'agent-resolve' }> {
  return {
    source: `${PREVIEW_SOURCE_PREFIX}${ensurePreviewId(el)}`,
    applyMode: 'agent-resolve',
    sourceResolutionHint: buildSourceResolutionHint(el),
  }
}

function ensurePreviewId(el: Element): string {
  const existing = el.getAttribute(PREVIEW_SOURCE_ATTR)
  if (existing) return existing
  previewIdCounter += 1
  const previewId = `p${Date.now().toString(36)}-${previewIdCounter.toString(36)}`
  el.setAttribute(PREVIEW_SOURCE_ATTR, previewId)
  return previewId
}

function buildSourceResolutionHint(el: Element): SourceResolutionHint {
  // classAttr, not a bare `typeof el.className === 'string'` guard: on SVG the
  // guard yields '' and drops the classes entirely. For a third-party icon
  // (lucide et al., unannotated because source-transform skips node_modules)
  // `class="lucide lucide-check"` is the strongest signal Claude has for
  // locating the call site — dropping it leaves `{tagName:'svg', domSelector:'svg'}`.
  const className = clampUtf8(classAttr(el).trim())
  const id = clampUtf8(el.id.trim())
  const textPreview = clampUtf8((el.textContent ?? '').trim())
  return {
    // `localName`, not `tagName.toLowerCase()`: SVG element names are
    // case-sensitive, so lowercasing turned <linearGradient> into
    // "lineargradient" — a selector matching nothing, handed to Claude as a
    // source locator. clampUtf8 for parity with the other fields; the server
    // schema caps tagName at the same byte budget and would reject the whole
    // staged-edit message rather than truncate.
    tagName: clampUtf8(el.localName),
    ...(className ? { className } : {}),
    ...(id ? { id } : {}),
    textPreview,
    domSelector: buildDomSelectorHint(el, className, id),
  }
}

function buildDomSelectorHint(el: Element, className: string, id: string): string {
  const tagName = CSS.escape(el.localName)
  if (id) return clampUtf8(`${tagName}#${CSS.escape(id)}`)
  const testId = el.getAttribute('data-testid')
  const trimmedTestId = testId ? clampUtf8(testId.trim()) : ''
  if (trimmedTestId) return clampUtf8(`${tagName}[data-testid=${CSS.escape(trimmedTestId)}]`)
  if (className) {
    const firstClass = className.split(/\s+/)[0]
    if (firstClass) return clampUtf8(`${tagName}.${CSS.escape(firstClass)}`)
  }
  return tagName
}

function clampUtf8(value: string): string {
  const bytes = encoder.encode(value)
  if (bytes.length <= MAX_SOURCE_HINT_FIELD_BYTES) return value

  const minEnd = Math.max(0, MAX_SOURCE_HINT_FIELD_BYTES - 3)
  for (let end = MAX_SOURCE_HINT_FIELD_BYTES; end >= minEnd; end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end))
    } catch {
      // Trimming up to three bytes handles a cut through one UTF-8 code point.
    }
  }
  return ''
}
