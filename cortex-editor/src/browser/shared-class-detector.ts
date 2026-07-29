export interface SharedClassInfo {
  /** The CSS selector that's shared (e.g., '.badge') */
  selector: string
  /** Path to the CSS module file */
  cssFilePath: string
  /** All elements in the DOM that share this selector. `Element[]`, not
   *  `HTMLElement[]` — source-transform annotates SVG too, and the
   *  `querySelectorAll<HTMLElement>` generic this replaced was a runtime lie:
   *  SVG matches were already being returned and counted. */
  elements: Element[]
  /** Count of elements sharing this selector */
  count: number
}

/**
 * Parse a `data-cortex-css` attribute value into its CSS file path and selectors.
 *
 * Format: `path/to/file.module.(css|scss|less|sass):selector1,selector2`
 *
 * Uses the same parsing strategy as `parseCssMapping` in edit-pipeline.ts:
 * anchors to the `.module.(css|scss|less|sass)` extension to locate the colon
 * delimiter between file path and selectors.
 */
export function parseCssMappingBrowser(raw: string): { cssFilePath: string; selectors: string[] } | null {
  const extMatch = raw.match(/\.module\.(css|scss|less|sass)/)
  if (!extMatch) return null
  const delimIdx = raw.indexOf(':', extMatch.index! + extMatch[0].length)
  if (delimIdx === -1) return null
  const cssPath = raw.slice(0, delimIdx)
  const selectorStr = raw.slice(delimIdx + 1)
  const selectors = selectorStr.split(',').map(s => s.trim()).filter(Boolean)
  if (selectors.length === 0) return null
  return { cssFilePath: cssPath, selectors }
}

/**
 * Detect if a selected element's CSS class is shared by multiple DOM elements.
 *
 * Business logic: When a user selects an element in the visual editor, this
 * function determines whether editing its CSS class would affect other elements
 * too. If so, the Panel displays a "Shared by N elements" indicator, letting
 * the designer make an informed decision before changing shared styles.
 *
 * Returns info about the most-shared selector, or null if no sharing detected
 * (i.e., all selectors appear on at most 1 element).
 */
export function detectSharedClasses(element: Element): SharedClassInfo | null {
  const raw = element.getAttribute('data-cortex-css')
  if (!raw) return null

  const parsed = parseCssMappingBrowser(raw)
  if (!parsed) return null

  // Query all annotated elements once
  const allAnnotated = document.querySelectorAll('[data-cortex-css]')

  let best: SharedClassInfo | null = null

  for (const selector of parsed.selectors) {
    const matches: Element[] = []

    for (const candidate of allAnnotated) {
      const candidateRaw = candidate.getAttribute('data-cortex-css')
      if (!candidateRaw) continue
      const candidateParsed = parseCssMappingBrowser(candidateRaw)
      if (!candidateParsed) continue
      if (candidateParsed.cssFilePath === parsed.cssFilePath && candidateParsed.selectors.includes(selector)) {
        matches.push(candidate)
      }
    }

    // Only report sharing when more than 1 element has the selector
    if (matches.length > 1 && (best === null || matches.length > best.count)) {
      best = {
        selector,
        cssFilePath: parsed.cssFilePath,
        elements: matches,
        count: matches.length,
      }
    }
  }

  return best
}
