import { classAttr } from './class-attr.js'
import type { ColorChip } from './token-detector.js'

const COLOR_UTILITY_PREFIXES = [
  'bg-',
  'text-',
  'border-',
  'ring-offset-',
  'ring-',
  'outline-',
  'decoration-',
  'caret-',
  'accent-',
  'fill-',
  'stroke-',
] as const

const BG_NON_COLOR_PREFIXES = [
  'bg-opacity', 'bg-clip', 'bg-gradient', 'bg-no-repeat', 'bg-repeat',
  'bg-cover', 'bg-contain', 'bg-center', 'bg-bottom', 'bg-top',
  'bg-left', 'bg-right', 'bg-fixed', 'bg-local', 'bg-scroll',
  'bg-origin', 'bg-blend', 'bg-none',
]

const INACTIVE_STATE_VARIANTS = new Set([
  'active',
  'autofill',
  'checked',
  'disabled',
  'empty',
  'enabled',
  'even',
  'first',
  'focus',
  'focus-visible',
  'focus-within',
  'hover',
  'in-range',
  'indeterminate',
  'invalid',
  'last',
  'only',
  'open',
  'optional',
  'out-of-range',
  'odd',
  'placeholder-shown',
  'read-only',
  'required',
  'target',
  'valid',
  'visited',
])

const MEDIA_VARIANT_QUERIES: Record<string, string> = {
  sm: '(min-width: 40rem)',
  md: '(min-width: 48rem)',
  lg: '(min-width: 64rem)',
  xl: '(min-width: 80rem)',
  '2xl': '(min-width: 96rem)',
  portrait: '(orientation: portrait)',
  landscape: '(orientation: landscape)',
  'motion-safe': '(prefers-reduced-motion: no-preference)',
  'motion-reduce': '(prefers-reduced-motion: reduce)',
  'contrast-more': '(prefers-contrast: more)',
  'contrast-less': '(prefers-contrast: less)',
  print: 'print',
}

export function markPageColorChips(
  chips: readonly ColorChip[],
  root: ParentNode = document,
): ColorChip[] {
  if (chips.length === 0) return []

  const usedColorNames = collectPageColorNames(root)
  const usedHexes = new Set<string>()

  for (const chip of chips) {
    const names = [chip.name, ...(chip.aliases ?? [])]
    if (names.some((name) => usedColorNames.has(name))) {
      usedHexes.add(chip.hex)
    }
  }

  return chips.map((chip) => ({
    ...chip,
    source: usedHexes.has(chip.hex) ? 'page' : 'theme',
  }))
}

export function collectPageColorNames(root: ParentNode = document): Set<string> {
  const doc = root instanceof Document ? root : root.ownerDocument ?? document
  const scope = root instanceof Document ? root.body ?? root.documentElement : root
  const used = new Set<string>()

  for (const element of elementsInScope(scope)) {
    if (element.closest('[data-cortex-host]')) continue

    // classAttr, not a bare typeof guard: `fill-` and `stroke-` are in
    // COLOR_UTILITY_PREFIXES and exist specifically for SVG, so the elements the
    // guard silently skipped were exactly the ones those prefixes target.
    const className = classAttr(element)
    for (const token of className.split(/\s+/)) {
      const name = colorNameFromUtility(token, doc)
      if (name) used.add(name)
    }
  }

  return used
}

function elementsInScope(scope: ParentNode): Element[] {
  const elements = [...scope.querySelectorAll('*')]
  if (scope instanceof Element) elements.unshift(scope)
  return elements
}

function colorNameFromUtility(token: string, doc: Document): string | null {
  const base = activeBaseToken(token, doc)
  if (!base) return null

  for (const prefix of COLOR_UTILITY_PREFIXES) {
    if (!base.startsWith(prefix)) continue
    if (prefix === 'bg-' && BG_NON_COLOR_PREFIXES.some((excluded) => base.startsWith(excluded))) {
      return null
    }
    const suffix = base.slice(prefix.length)
    if (!suffix) return null
    const name = suffix.split('/')[0] ?? ''
    return name || null
  }

  return null
}

function activeBaseToken(token: string, doc: Document): string | null {
  const segments = splitVariantSegments(token)
  const base = segments[segments.length - 1] ?? ''
  const variants = segments.slice(0, -1)

  for (const variant of variants) {
    if (!variantAppliesNow(variant, doc)) return null
  }

  return base
}

function splitVariantSegments(token: string): string[] {
  const segments: string[] = []
  let bracketDepth = 0
  let start = 0

  for (let i = 0; i < token.length; i++) {
    const ch = token[i]
    if (ch === '[') {
      bracketDepth++
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (ch === ':' && bracketDepth === 0) {
      segments.push(token.slice(start, i))
      start = i + 1
    }
  }

  segments.push(token.slice(start))
  return segments
}

function variantAppliesNow(variant: string, doc: Document): boolean {
  if (variant === 'dark') return doc.documentElement.classList.contains('dark')
  if (variant === 'light') return doc.documentElement.classList.contains('light')
  if (INACTIVE_STATE_VARIANTS.has(variant)) return false
  if (variant.startsWith('group-') || variant.startsWith('peer-')) return false
  const query = MEDIA_VARIANT_QUERIES[variant]
  if (query) return doc.defaultView?.matchMedia?.(query).matches ?? false
  return false
}
