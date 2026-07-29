import { VALID_PROPERTY, VALID_VALUE, REJECT_URL, REJECT_COMMENT } from './css-validation.js'

export interface StateDeclarations {
  hover: Map<string, string>
  focus: Map<string, string>
  active: Map<string, string>
}

export type StateName = 'hover' | 'focus' | 'active'

/** Interaction state including 'default' (no forced state). */
export type InteractionState = 'default' | StateName

const STATE_PSEUDOS: readonly StateName[] = ['hover', 'focus', 'active'] as const

/** Pre-compiled regex for stripping state pseudo-classes from selectors. */
const STATE_REGEX: Record<StateName, RegExp> = {
  hover: /:hover(?![\w-])/g,
  focus: /:focus(?![\w-])/g,
  active: /:active(?![\w-])/g,
}

/** Non-global regex for checking if a selector contains the exact pseudo-class. */
const STATE_INCLUDES: Record<StateName, RegExp> = {
  hover: /:hover(?![\w-])/,
  focus: /:focus(?![\w-])/,
  active: /:active(?![\w-])/,
}

/**
 * Inspect all document stylesheets to find :hover/:focus/:active rules
 * matching the given element. Returns declarations grouped by state.
 *
 * Business logic: This powers the "state lens" feature — when a user selects
 * an element, the editor needs to know which interaction states have CSS rules
 * so it can offer toggle buttons (e.g., show :hover appearance). The detected
 * declarations are later applied as CSS overrides to force-preview the state.
 */
export function detectStates(element: Element): StateDeclarations {
  const result: StateDeclarations = {
    hover: new Map(),
    focus: new Map(),
    active: new Map(),
  }

  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // cross-origin stylesheet
    }
    collectFromRules(rules, element, result)
  }

  return result
}

function collectFromRules(
  rules: CSSRuleList,
  element: Element,
  result: StateDeclarations,
): void {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      processStyleRule(rule, element, result)
      // CSS nesting: a CSSStyleRule can contain nested child rules (e.g. &:hover)
      if (rule.cssRules && rule.cssRules.length > 0) {
        collectFromRules(rule.cssRules, element, result)
      }
    } else if (
      rule instanceof CSSMediaRule ||
      rule instanceof CSSSupportsRule ||
      (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule)
    ) {
      collectFromRules(rule.cssRules, element, result)
    } else if (
      // Fallback: recurse into any grouping rule with a cssRules property
      // (covers CSSLayerBlockRule in environments where the global isn't defined)
      !(rule instanceof CSSStyleRule) &&
      'cssRules' in rule &&
      rule.cssRules instanceof CSSRuleList
    ) {
      collectFromRules(rule.cssRules, element, result)
    }
  }
}

/**
 * Walk up the parentRule chain to resolve nested `&` placeholders.
 * Returns the fully-resolved parent selector, or null if no nesting.
 *
 * Business logic: CSS nesting allows rules like `.card { &.primary { &:hover {} } }`.
 * Each `&` refers to the parent selector. This function resolves the full chain
 * so we can test `element.matches()` against the final flat selector.
 */
function resolveNestingSelector(rule: CSSStyleRule): string | null {
  const parts: string[] = []
  let current: CSSRule | null = rule.parentRule
  while (current instanceof CSSStyleRule) {
    parts.unshift(current.selectorText)
    current = current.parentRule
  }
  if (parts.length === 0) return null
  // Resolve from outermost to innermost
  let resolved = parts[0]!
  for (let i = 1; i < parts.length; i++) {
    resolved = parts[i]!.replaceAll('&', resolved)
  }
  return resolved
}

function processStyleRule(
  rule: CSSStyleRule,
  element: Element,
  result: StateDeclarations,
): void {
  // Split comma-separated selectors and process each independently
  const selectors = rule.selectorText.split(',').map(s => s.trim())

  for (const selector of selectors) {
    // Skip rules with pseudo-elements
    if (selector.includes('::before') || selector.includes('::after')) continue

    for (const state of STATE_PSEUDOS) {
      if (!STATE_INCLUDES[state].test(selector)) continue

      // Strip the pseudo-class and test if the base selector matches
      const baseSelector = selector.replace(STATE_REGEX[state], '').trim()
      if (!baseSelector) continue

      // CSS nesting: resolve `&` against parent rule chain
      if (baseSelector.includes('&')) {
        const parentSelector = resolveNestingSelector(rule)
        if (!parentSelector) continue
        const resolved = baseSelector.replaceAll('&', parentSelector)
        try {
          if (!element.matches(resolved)) continue
        } catch { continue }
      } else {
        try {
          if (!element.matches(baseSelector)) continue
        } catch { continue }
      }

      // Extract declarations
      const style = rule.style
      for (let i = 0; i < style.length; i++) {
        const prop = style[i] as string
        const val = style.getPropertyValue(prop).trim()
        if (!prop || !val) continue
        // Skip 'initial' values — these are noise from shorthand expansion
        if (val === 'initial') continue
        if (!VALID_PROPERTY.test(prop)) continue
        if (!VALID_VALUE.test(val) || REJECT_URL.test(val) || REJECT_COMMENT.test(val)) continue
        result[state].set(prop, val)
      }
    }
  }
}
