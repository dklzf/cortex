/**
 * Selection metadata — identity signals that survive HMR-induced DOM replacement.
 *
 * `data-cortex-source` is per *source location*, not per *rendered instance*.
 * Two siblings from the same `.map()` share the attribute, so naive
 * `querySelector` can pick the wrong one after HMR swaps nodes. We capture
 * position (nth-index), content (textContent hash), and tree location
 * (shadow root) at selection time so we can re-resolve deterministically.
 */

/** Metadata captured at selection time. Must round-trip losslessly across
 *  HMR cycles — stored in a ref alongside the active selection. */
export interface SelectionMetadata {
  /** `data-cortex-source` value (file:line:col) at selection time.
   *  Null if the selected element had no source attribute. */
  source: string | null
  /** Zero-based index among elements returned by `findSourceMatches()` for
   *  the same `source` — which are all elements bearing that `data-cortex-
   *  source` value across the document (and open shadow roots, via
   *  fallback), not just DOM siblings. For the typical `.map()` case this
   *  is the sibling index; for loop-rendered elements scattered across
   *  different parent subtrees it's still a stable position within the
   *  source group. `-1` when source is null or the element isn't among
   *  matches (shouldn't happen in practice; guarded). */
  index: number
  /** Trimmed textContent at selection time. Used to distinguish array
   *  reorder from in-place content edit. Empty string is a valid hash for
   *  icon-only elements. */
  contentHash: string
  /** True if the selected element's root is a ShadowRoot (vs Document).
   *  Used to gate the deep-query fallback in re-resolution. */
  inShadowRoot: boolean
  /** How many elements shared this `source` at capture time.
   *
   *  Load-bearing for re-resolution, not diagnostics. `index` is only meaningful
   *  while the population is unchanged: if a sibling is REMOVED, every later
   *  index slides down one, and the element now sitting at the saved index is a
   *  different element that we would otherwise return labelled as a confident
   *  match. Comparing the population size is what separates "a sibling was
   *  deleted" from "the selected element's own text was edited" — those two
   *  reach the identical branch in `reResolveSelection` and demand opposite
   *  answers. `-1` when source is null. */
  groupSize: number
}

/**
 * Snapshot identity signals at the moment of selection. Must be called
 * while the element is still connected to the document/shadow tree.
 */
export function captureSelectionMetadata(el: Element): SelectionMetadata {
  const source = el.getAttribute('data-cortex-source')
  const contentHash = (el.textContent ?? '').trim()
  const inShadowRoot = el.getRootNode() instanceof ShadowRoot

  if (!source) {
    return { source: null, index: -1, contentHash, inShadowRoot, groupSize: -1 }
  }

  const siblings = findSourceMatches(source, inShadowRoot)
  const index = siblings.indexOf(el)
  return { source, index, contentHash, inShadowRoot, groupSize: siblings.length }
}

/**
 * Locate all elements sharing a `data-cortex-source` value. Uses the cheap flat
 * query for light-DOM selections, and the shadow-piercing walk whenever the
 * caller knows the element lived in a shadow tree.
 *
 * Deliberately NOT `flat.length === 0 && inShadowRoot`: if a shadow-hosted
 * element shares its source with a light-DOM render (the same component used in
 * both), the flat query returns a non-empty list that does not contain the
 * selected element, `indexOf` yields -1, and the selection is cleared on the next
 * HMR cycle. Latent today — `elementFromPoint` retargets to the shadow host, so
 * nothing can currently select a shadow-inner node and `inShadowRoot` is always
 * false — but the flat-first shape is a trap for whoever lands shadow selection.
 *
 * Keeps capture/re-resolve in lock-step — a regression where only one side runs
 * the deep query would silently desync.
 *
 * `Element[]`, not `HTMLElement[]`: source-transform annotates every lowercase
 * JSX tag (it filters on `/^[a-z]/` with no HTML allowlist), so `<svg>`,
 * `<path>`, `<circle>` and friends in the user's own .jsx carry
 * `data-cortex-source`. Filtering to `HTMLElement` made
 * `captureSelectionMetadata` compute `index === -1` for an SVG selection, which
 * made `reResolveSelection` return null on the next HMR cycle and silently
 * cleared the user's selection — a fix to the click path alone would have
 * evaporated on the first save.
 */
function findSourceMatches(source: string, inShadowRoot: boolean): Element[] {
  try {
    const selector = `[data-cortex-source="${CSS.escape(source)}"]`
    const flat = Array.from(document.querySelectorAll(selector))
    return inShadowRoot ? deepQueryAllElements(selector) : flat
  } catch (err) {
    // CSS.escape spec-throws on unpaired surrogates; querySelectorAll throws
    // SyntaxError on malformed selectors. Treat as "no matches" so the caller
    // falls into the clear-selection path rather than the channel pump dying.
    console.warn('[cortex] findSourceMatches selector error', { source, err })
    return []
  }
}

/**
 * Traverse open shadow roots recursively, returning ALL matching elements
 * regardless of namespace — SVG / MathML nodes that source-transform annotated
 * are included, because every lowercase JSX tag gets `data-cortex-source`.
 *
 * There used to be an `HTMLElement`-filtered twin (`deepQuerySelectorAll`). Its
 * three call sites — HMR re-resolution here, `buffer.reconcile`, and
 * `reconcileOnConnect` — all wanted the unfiltered result: the filter silently
 * cleared SVG selections on HMR and dropped SVG-sourced intents in reconcile. It
 * was deleted and every caller now uses this function. Two functions differing
 * only by a filter nobody wanted was the actual defect.
 *
 * Closed shadow roots are opaque from outside and cannot be traversed —
 * documented limitation. `shadowRoot` is only non-null for `{mode: 'open'}`.
 *
 * Performance: walks every element under `root` looking for shadow hosts.
 * On the re-resolution path this is a fallback only, invoked when the flat
 * query returns zero AND the selected element was originally in a shadow tree.
 */
export function deepQueryAllElements(
  selector: string,
  root: Document | ShadowRoot = document,
): Element[] {
  const matches: Element[] = []
  for (const el of root.querySelectorAll(selector)) {
    matches.push(el)
  }
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) {
      matches.push(...deepQueryAllElements(selector, el.shadowRoot))
    }
  }
  return matches
}

/**
 * Re-resolve a selection after HMR using the captured metadata.
 *
 * Algorithm is position-first, content-second, preserve-third:
 *   - stable position + matching content → keep as-is
 *   - stable position + changed content + content found elsewhere → follow content (reorder)
 *   - stable position + changed content + content not found → preserve position (edited in place)
 *   - no element at saved index → clear
 *
 * The content-search branch is gated on `meta.contentHash !== ''` because an
 * empty hash would false-match the first icon-only element in the list.
 */
export function reResolveSelection(meta: SelectionMetadata): Element | null {
  if (!meta.source) return null

  const matches = findSourceMatches(meta.source, meta.inShadowRoot)

  if (matches.length === 0) return null

  const atIndex = meta.index >= 0 ? matches[meta.index] ?? null : null
  if (!atIndex) return null // index out of bounds → clear

  if (atIndex.textContent?.trim() === meta.contentHash) return atIndex

  // Content differs at the saved index. Check if the saved content lives
  // elsewhere (list was reordered). Skip the search for empty content — it
  // would false-positive on the first icon-only element.
  //
  // Tie-break: if multiple matches carry the saved content (e.g., `[A, B, A]`
  // reordered to `[A, A, B]` — both zeroth and first carry the user's "A"),
  // prefer the candidate closest to the saved index. This handles the
  // duplicate-content reorder case where a naive find() would collapse to
  // index 0.
  if (meta.contentHash !== '') {
    const candidates: number[] = []
    for (let i = 0; i < matches.length; i++) {
      if (matches[i]?.textContent?.trim() === meta.contentHash) candidates.push(i)
    }
    if (candidates.length > 0) {
      const nearest = candidates.reduce((best, idx) =>
        Math.abs(idx - meta.index) < Math.abs(best - meta.index) ? idx : best,
      )
      return matches[nearest] ?? null
    }
  }

  // Two very different situations reach this point, and they demand opposite
  // answers:
  //
  //   (a) The selected element is still here and its own text was edited.
  //       `index` is still valid → returning `atIndex` is correct.
  //   (b) A SIBLING was deleted, so every later index slid down by one.
  //       `atIndex` is now a DIFFERENT element, and returning it hands the
  //       caller a confident wrong answer — the `[A,B,C]` / select B /
  //       delete B case silently re-anchors the selection onto C.
  //
  // Content alone cannot separate them (in both cases the saved hash is
  // nowhere to be found). Population size can: a deletion changes it, an
  // in-place text edit does not.
  //
  // NOTE: the review's stated fix — "return null when the content search comes
  // back empty" — would have covered (b) by breaking (a), which is the common
  // case (editing the text of the thing you have selected). Hence the extra
  // signal rather than an unconditional null.
  if (matches.length !== meta.groupSize) return null
  return atIndex
}

/** Decides whether a Panel refresh / re-resolution attempt should run on
 *  hmr-applied. Returns false when nothing is selected; returns true on
 *  unknown file lists (server signaled a cycle but did not enumerate files);
 *  otherwise delegates to hmrFilesAffectElement. */
export function shouldRefreshOnHMR(
  files: string[] | undefined,
  element: Element | null,
): boolean {
  if (!element) return false
  if (!files || files.length === 0) return true
  return hmrFilesAffectElement(files, element)
}

/** Source format is `relativePath:line:col` (per source-transform.ts:252).
 *  Strip only the trailing `:line:col` so file paths containing colons (rare
 *  but possible on Unix; ubiquitous on Windows drive letters) don't get
 *  truncated. */
export function stripLineCol(src: string): string {
  return src.replace(/:\d+:\d+$/, '')
}

/** File extensions treated as CSS for HMR-filter purposes. Any file in the
 *  HMR change list matching this regex triggers a full Panel refresh because
 *  cascade changes can affect any element. */
const CSS_EXT = /\.(css|scss|sass|less|styl|stylus)$/i

/** Virtual/synthetic module paths that Vite and plugins emit for CSS-in-JS
 *  runtimes (Tailwind JIT, Linaria, Emotion compile mode), virtual:* imports,
 *  Rollup's `\0`-prefixed module IDs, and `@id/` / `@fs/` / `@vite/` Vite
 *  synthetic prefixes. Matched AFTER path normalization (leading `/` and
 *  query string already stripped), so `/@id/...` shows up here as `@id/...`.
 *  We can't classify what these affect, so err toward refresh rather than
 *  silently skip. Missing this broke real Tailwind theme edits in testing. */
const VIRTUAL_MODULE = /^(\0|@id\/|@fs\/|@vite\/|virtual:)/

/** Default maximum depth for ancestor walk in `hmrFilesAffectElement`. Chosen
 *  empirically — 20 levels covers typical React component nesting without the
 *  unbounded-walk cost on pathological trees. Override via the `maxDepth`
 *  parameter if needed. */
const DEFAULT_ANCESTOR_DEPTH = 20

/**
 * Given a list of files changed in a single HMR cycle, decide whether the
 * Panel should refresh its computed state for the currently selected element.
 *
 * Returns true (refresh) if ANY of:
 *   - A CSS/SCSS/module CSS file is in the list (cascade could affect anything)
 *   - The element's own `data-cortex-source` file is in the list
 *   - Any ancestor's `data-cortex-source` file (up to maxDepth) is in the list
 *
 * Returns false (skip) only when we're confident the change is unrelated.
 * Conservative by design: false is only returned when all ancestor files are
 * known and none match. Callers should treat an empty or missing `files`
 * argument as "refresh always" (pass true) — this function assumes the caller
 * has already confirmed the list is present.
 */
export function hmrFilesAffectElement(
  files: string[],
  element: Element,
  maxDepth: number = DEFAULT_ANCESTOR_DEPTH,
): boolean {
  // Normalize paths FIRST so classification (CSS_EXT, VIRTUAL_MODULE) and
  // ancestor-file lookup both operate on the same shape. Vite's
  // `update.updates[].path` is URL-style with a leading `/` and may include
  // a cache-bust query string (e.g. `/src/app.css?t=12345`). `CSS_EXT` is
  // anchored on `$`, so a query string would silently defeat the CSS short-
  // circuit and skip the refresh on stylesheet-only HMR cycles.
  // `data-cortex-source` stores the relative form without leading slash,
  // which is what ancestor-walk comparison expects.
  const normalized = files.map(p => p.replace(/^\/+/, '').split('?')[0] ?? '')

  // Any CSS file OR virtual module: cascade (or runtime-injected styles)
  // may affect anything visible. Virtual modules are non-classifiable — we
  // default to refreshing rather than risking a stale Panel on Tailwind JIT
  // regenerations, CSS-in-JS runtime updates, or Vite plugin synthetics.
  if (normalized.some(f => CSS_EXT.test(f) || VIRTUAL_MODULE.test(f))) return true

  const normalizedFiles = new Set(normalized)

  // Ancestor walk with shadow-boundary crossing. When `parentElement` is null
  // and the current node is inside a ShadowRoot, continue from the host so
  // shadow-hosted selections still pick up ancestor source-file changes (e.g.
  // a web-component host app where cortex is selecting elements inside the
  // light-tree projection of a shadow component).
  let current: Element | null = element
  let depth = 0
  while (current && depth < maxDepth) {
    const src = current.getAttribute('data-cortex-source')
    if (src) {
      const file = stripLineCol(src)
      if (file && normalizedFiles.has(file)) return true
    }
    // `parentElement` is typed `HTMLElement | null` by lib.dom, which is a lie
    // inside namespaced trees — a <path>'s parent is an SVGElement.
    const parentEl: Element | null = current.parentElement
    if (parentEl) {
      current = parentEl
    } else {
      const root = current.getRootNode()
      // `ShadowRoot.host` is already `Element` — the cast that used to be here
      // was narrowing it to a lie.
      current = root instanceof ShadowRoot ? root.host : null
    }
    depth++
  }
  return false
}
