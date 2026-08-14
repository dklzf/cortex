import { MAX_SOURCE_HINT_FIELD_BYTES } from '../shared/preview-source.js'

/**
 * Per-child discriminators for a container's children (COR-35).
 *
 * ## The hole this closes
 *
 * The structural drift guard compared each live child to the `data-cortex-
 * source` it carried at capture. For N siblings rendered from one `.map()`
 * call site those are N IDENTICAL strings, so the comparison is satisfied
 * under ANY permutation and a reorder is never seen as drift. Insertion and
 * deletion were caught by the length check; reordering — the one mutation a
 * reorder intent is actually racing — was not.
 *
 * That failure is silent-wrong: drag row 3 above row 1, the app re-sorts or
 * refetches before Apply, the intent still compares clean, and the reorder
 * lands on a tree it no longer describes.
 *
 * ## What a discriminator has to be
 *
 * Unique WITHIN one parent's child list, never globally. That is a far weaker
 * requirement than per-instance identity and needs nothing from React
 * internals, source maps or the bundler.
 *
 * It also has to be STABLE across the window between capture and Apply, which
 * rules out more facets than it first appears:
 *
 * - `class` — the app mutates it constantly (hover, active, selected), and in a
 *   list every sibling usually carries the SAME classes anyway. It adds
 *   instability without adding distinctness, so it is excluded despite being
 *   the obvious candidate.
 * - `style` — same, plus staged edits are applied through a stylesheet rather
 *   than inline, so reading it would mostly report the app's own animations.
 * - `data-cortex-preview-id` — cortex MINTS this lazily when an element is
 *   clicked. A child that gains one after capture would change key and report
 *   drift on a tree that never moved. Cortex's own attributes are excluded for
 *   exactly this reason.
 *
 * What remains is authored identity (`data-testid`, `id`, `aria-label`, …) and,
 * failing that, tag plus text. Both are things the developer wrote and neither
 * moves on its own.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Attributes that express identity the developer AUTHORED, in preference
 * order. First present-and-non-empty wins.
 *
 * First-wins rather than a composite of all of them: when a developer has put a
 * `data-testid` on a row, that IS their statement of which row it is, and
 * folding volatile facets in on top can only turn a stable key into an unstable
 * one. The attribute NAME is part of the key, so a child keyed on `id` can
 * never collide with a sibling keyed on `aria-label` that happens to hold the
 * same string.
 *
 * `value` is deliberately absent — it tracks what the user has typed into an
 * input and changes under the guard.
 */
const IDENTITY_ATTRS = ['data-testid', 'id', 'name', 'aria-label', 'href', 'src', 'alt'] as const

/**
 * A stable, order-sensitive key for one child of a container.
 *
 * Pure: reads the DOM and mutates nothing. The guard runs during a read-only
 * reconcile, and `getElementEditTarget` has already shown what stamping during
 * a read costs — see `ensurePreviewId`.
 *
 * Two children of the same parent produce the same key only when they are
 * genuinely indistinguishable from the outside, which is the case the schema
 * refuses to stage rather than guess at.
 */
export function childDiscriminator(el: Element): string {
  for (const attr of IDENTITY_ATTRS) {
    const raw = el.getAttribute(attr)
    if (raw === null) continue
    const value = raw.trim()
    // `@` and `#` lead the two shapes so an attribute key can never collide
    // with a structural one. Attribute names cannot contain '=', so the first
    // '=' splits the pair unambiguously even when the VALUE contains one.
    if (value) return clampUtf8(`@${attr}=${value}`)
  }

  // `localName`, not `tagName.toLowerCase()` — SVG element names are
  // case-sensitive, and lowercasing collapses <linearGradient> and
  // <lineargradient> onto one key. Same reason preview-source.ts uses it.
  //
  // Whitespace is collapsed because JSX re-renders vary indentation inside an
  // element without changing what it says; comparing raw textContent would
  // report drift on a reformat.
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return clampUtf8(`#${el.localName}:${text}`)
}

/**
 * Discriminators for a container's element children, in DOM order.
 *
 * Walks `parent.children` — the same collection the guard reads sources from —
 * so the two arrays are index-aligned by construction rather than by a length
 * check that could pass while the entries described different nodes.
 */
export function childDiscriminators(parent: Element): string[] {
  return Array.from(parent.children, childDiscriminator)
}

/** Room reserved at the end of a truncated key for the `~<hash>` suffix. */
const HASH_SUFFIX_BYTES = 8

/**
 * Truncate to the wire byte budget without splitting a UTF-8 code point,
 * appending a digest of the FULL value whenever truncation occurred.
 *
 * Byte-bounded, not `.slice(N)`: the schema caps these fields in UTF-8 bytes
 * and would reject the whole staged-edit message rather than truncate it, so a
 * key built from a 4-byte-per-character label has to be measured the same way
 * the validator measures it.
 *
 * The digest is what keeps truncation from creating collisions. Two rows whose
 * text agrees for the first 500 bytes and diverges after would clamp to the
 * same key, the schema's distinctness rule would reject the intent, and the
 * user would see cortex refuse to reorder a perfectly ordinary list with no
 * visible reason. Truncating to a prefix PLUS a hash of the whole keeps the key
 * readable in diagnostics while still separating those two rows.
 */
function clampUtf8(value: string): string {
  const bytes = encoder.encode(value)
  if (bytes.length <= MAX_SOURCE_HINT_FIELD_BYTES) return value

  const budget = MAX_SOURCE_HINT_FIELD_BYTES - HASH_SUFFIX_BYTES
  const minEnd = Math.max(0, budget - 3)
  for (let end = budget; end >= minEnd; end -= 1) {
    try {
      return `${decoder.decode(bytes.subarray(0, end))}~${hash32(value)}`
    } catch {
      // Trimming up to three bytes handles a cut through one UTF-8 code point.
    }
  }
  return `~${hash32(value)}`
}

/**
 * FNV-1a, 32-bit, base36. Not cryptographic and does not need to be — it only
 * has to separate a handful of siblings that share a long prefix, and a
 * collision degrades to the refusal that truncation alone would have caused
 * anyway rather than to a wrong write.
 */
function hash32(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36).padStart(7, '0')
}
