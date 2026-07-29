import { describe, it, expect, afterEach } from 'vitest'
import {
  hmrFilesAffectElement,
  reResolveSelection,
  captureSelectionMetadata,
  shouldRefreshOnHMR,
} from '../../src/browser/selection-metadata.js'

describe('hmrFilesAffectElement', () => {
  const orphans: HTMLElement[] = []

  afterEach(() => {
    for (const el of orphans) el.remove()
    orphans.length = 0
  })

  function build(ancestrySources: (string | null)[]): HTMLElement {
    // Build a nested ancestor chain from outer→inner, attach sources at each
    // level per the input array (null = no source attribute at that level).
    // Returns the innermost element.
    let parent: HTMLElement | null = null
    let innermost: HTMLElement | null = null
    for (const src of ancestrySources) {
      const el = document.createElement('div')
      if (src) el.setAttribute('data-cortex-source', src)
      if (parent) {
        parent.appendChild(el)
      } else {
        document.body.appendChild(el)
        orphans.push(el)
      }
      parent = el
      innermost = el
    }
    return innermost!
  }

  it('returns false for an empty files list on an element with no ancestors', () => {
    const el = build(['src/leaf.tsx:5:3'])
    expect(hmrFilesAffectElement([], el)).toBe(false)
  })

  it('returns true when any CSS file is in the list (cascade may affect anything)', () => {
    const el = build(['src/leaf.tsx:5:3'])
    expect(hmrFilesAffectElement(['src/app.css'], el)).toBe(true)
    expect(hmrFilesAffectElement(['styles/theme.scss'], el)).toBe(true)
    expect(hmrFilesAffectElement(['styles/reset.less'], el)).toBe(true)
    expect(hmrFilesAffectElement(['src/foo.module.css'], el)).toBe(true)
  })

  it('returns true when the element\'s own source file is in the list', () => {
    const el = build(['src/leaf.tsx:5:3'])
    expect(hmrFilesAffectElement(['src/leaf.tsx'], el)).toBe(true)
  })

  it('returns true when an ancestor\'s source file is in the list (within default depth)', () => {
    // 3-deep chain: outer (parent.tsx) → middle (middle.tsx) → inner (leaf.tsx)
    const inner = build(['src/parent.tsx:1:1', 'src/middle.tsx:2:2', 'src/leaf.tsx:3:3'])
    expect(hmrFilesAffectElement(['src/parent.tsx'], inner)).toBe(true)
    expect(hmrFilesAffectElement(['src/middle.tsx'], inner)).toBe(true)
  })

  it('returns false when only a sibling file is in the list (not ancestor)', () => {
    const el = build(['src/leaf.tsx:5:3'])
    expect(hmrFilesAffectElement(['src/other.tsx', 'src/unrelated.tsx'], el)).toBe(false)
  })

  it('caps ancestor walk at the provided maxDepth', () => {
    // Build a 25-deep chain. The outermost has a source, the innermost is
    // the target. Walk depth of 20 misses the outermost (index 0 in ancestry,
    // depth 24 from the target).
    const sources: string[] = []
    for (let i = 0; i < 25; i++) sources.push(`src/level-${i}.tsx:1:1`)
    const inner = build(sources)
    // With depth 20, the outermost source (level-0) is unreachable (at depth 24)
    expect(hmrFilesAffectElement(['src/level-0.tsx'], inner, 20)).toBe(false)
    // A source within depth 20 is found (level-5 is depth 19 from inner)
    expect(hmrFilesAffectElement(['src/level-5.tsx'], inner, 20)).toBe(true)
    // With unlimited depth, the outermost is found
    expect(hmrFilesAffectElement(['src/level-0.tsx'], inner, 100)).toBe(true)
  })

  it('returns true on any-match when multiple files are in the list', () => {
    const el = build(['src/leaf.tsx:5:3'])
    // One match among many unrelated entries still returns true
    expect(hmrFilesAffectElement(
      ['src/a.tsx', 'src/b.tsx', 'src/leaf.tsx', 'src/c.tsx'],
      el,
    )).toBe(true)
  })

  it('skips ancestors with no data-cortex-source attribute', () => {
    // middle has no source, leaf does. Walking up should skip middle and
    // examine grandparent which also has a source.
    const inner = build(['src/root.tsx:1:1', null, 'src/leaf.tsx:3:3'])
    expect(hmrFilesAffectElement(['src/root.tsx'], inner)).toBe(true)
  })

  it('returns false when the element has no source and no ancestor source matches', () => {
    const el = build([null, null, null])
    expect(hmrFilesAffectElement(['src/unrelated.tsx'], el)).toBe(false)
  })

  it('normalizes Vite URL-style paths (leading slash + query string) before comparing', () => {
    // Regression test for the Round 2 ship-blocker (C1): Vite's
    // vite:afterUpdate payload sends `/src/App.tsx?t=123` (URL-style with
    // leading slash, optional query string). data-cortex-source stores
    // `src/App.tsx:10:5` (relative). The filter must normalize both sides
    // or the ancestor-match path silently returns false for every JSX edit.
    const el = build(['src/leaf.tsx:5:3'])
    expect(hmrFilesAffectElement(['/src/leaf.tsx'], el)).toBe(true)
    expect(hmrFilesAffectElement(['/src/leaf.tsx?t=12345'], el)).toBe(true)
    expect(hmrFilesAffectElement(['//src/leaf.tsx'], el)).toBe(true) // double slash tolerated
    // Sanity: unrelated URL-style path doesn't match
    expect(hmrFilesAffectElement(['/src/other.tsx'], el)).toBe(false)
  })

  it('matches CSS extensions on every supported extension', () => {
    const el = build(['src/leaf.tsx:5:3'])
    for (const ext of ['.css', '.scss', '.sass', '.less', '.styl', '.stylus']) {
      expect(hmrFilesAffectElement([`styles/foo${ext}`], el)).toBe(true)
    }
  })

  it('crosses shadow boundaries during ancestor walk (regression — Copilot review)', () => {
    // Selected element inside a web-component's shadow tree: `parentElement`
    // returns null at the shadow root, but the HOST has a data-cortex-source
    // in the light tree that should match. Without the shadow-host handoff,
    // the filter silently skipped refresh for shadow-hosted selections.
    const host = document.createElement('div')
    host.setAttribute('data-cortex-source', 'src/ancestor.tsx:10:1')
    document.body.appendChild(host)
    orphans.push(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const inner = document.createElement('div')
    inner.setAttribute('data-cortex-source', 'src/leaf.tsx:5:3')
    shadow.appendChild(inner)
    // Ancestor source file is present in the HMR files list; the walk must
    // cross the shadow boundary to find it.
    expect(hmrFilesAffectElement(['src/ancestor.tsx'], inner)).toBe(true)
    // Self-source still matches (doesn't require crossing).
    expect(hmrFilesAffectElement(['src/leaf.tsx'], inner)).toBe(true)
    // Unrelated file: still false.
    expect(hmrFilesAffectElement(['src/unrelated.tsx'], inner)).toBe(false)
  })

  it('matches CSS files that have a cache-bust query string (regression — Copilot review)', () => {
    // Vite appends `?t=<timestamp>` to asset paths on HMR. Because `CSS_EXT`
    // is anchored on `$`, the classification has to happen AFTER query-string
    // stripping. Without this, every stylesheet HMR cycle silently fell
    // through the extension check and the Panel stayed stale on real Vite
    // — would have caught the ship-blocker in automated tests if it had
    // existed at the time.
    const el = build(['src/leaf.tsx:5:3'])
    expect(hmrFilesAffectElement(['/src/app.css?t=12345'], el)).toBe(true)
    expect(hmrFilesAffectElement(['styles/theme.scss?import'], el)).toBe(true)
    expect(hmrFilesAffectElement(['/src/app.css?t=1&inline'], el)).toBe(true)
  })

  it('treats virtual modules as unknown → refresh (Tailwind JIT, virtual:, /@id/, null-prefix)', () => {
    // Vite and plugins emit non-file paths for CSS-in-JS runtimes, virtual
    // imports, and Rollup virtual module IDs. We can't classify their impact,
    // so the safe posture is to refresh rather than silently skip.
    const el = build(['src/leaf.tsx:5:3'])
    expect(hmrFilesAffectElement(['virtual:tailwind-jit'], el)).toBe(true)
    expect(hmrFilesAffectElement(['/@id/virtual:cortex-client'], el)).toBe(true)
    expect(hmrFilesAffectElement(['/@fs/some/absolute/path'], el)).toBe(true)
    expect(hmrFilesAffectElement(['\0rollup-virtual'], el)).toBe(true)
    // A mixed list where only one entry is virtual still triggers refresh.
    expect(hmrFilesAffectElement(['src/other.tsx', 'virtual:foo'], el)).toBe(true)
  })
})

describe('reResolveSelection', () => {
  const orphans: HTMLElement[] = []

  afterEach(() => {
    for (const el of orphans) el.remove()
    orphans.length = 0
  })

  function buildSiblings(source: string, contents: string[]): HTMLElement[] {
    return contents.map((content) => {
      const el = document.createElement('div')
      el.setAttribute('data-cortex-source', source)
      if (content) el.appendChild(document.createTextNode(content))
      document.body.appendChild(el)
      orphans.push(el)
      return el
    })
  }

  it('returns null when source is null (never-selected element)', () => {
    const result = reResolveSelection({
      source: null, index: -1, contentHash: '', inShadowRoot: false,
    })
    expect(result).toBeNull()
  })

  it('returns null when no matches exist (element removed)', () => {
    const result = reResolveSelection({
      source: 'src/ghost.tsx:1:1', index: 0, contentHash: 'X', inShadowRoot: false,
    })
    expect(result).toBeNull()
  })

  it('preserves selection at saved index when content is unchanged', () => {
    const source = 'src/list.tsx:10:5'
    const siblings = buildSiblings(source, ['A', 'B', 'C'])
    const result = reResolveSelection({
      source, index: 1, contentHash: 'B', inShadowRoot: false,
    })
    expect(result).toBe(siblings[1])
  })

  it('follows content to new index when the list is reordered', () => {
    const source = 'src/list.tsx:10:5'
    const siblings = buildSiblings(source, ['B', 'C', 'A'])
    // User had selected index 0 when content was "A"; after reorder, "A" is at index 2.
    const result = reResolveSelection({
      source, index: 0, contentHash: 'A', inShadowRoot: false,
    })
    expect(result).toBe(siblings[2])
  })

  it('preserves at saved index when content was edited in place (no match elsewhere)', () => {
    const source = 'src/list.tsx:10:5'
    const siblings = buildSiblings(source, ['Hello, world', 'B', 'C'])
    // User had selected index 0 when content was "Hello"; content was edited to
    // "Hello, world" in place. Saved content "Hello" not found elsewhere → preserve position.
    const result = reResolveSelection({
      source, index: 0, contentHash: 'Hello', inShadowRoot: false,
    })
    expect(result).toBe(siblings[0])
  })

  it('returns null when list shrinks past saved index', () => {
    const source = 'src/list.tsx:10:5'
    buildSiblings(source, ['A', 'B']) // only 2 left
    const result = reResolveSelection({
      source, index: 2, contentHash: 'C', inShadowRoot: false,
    })
    expect(result).toBeNull()
  })

  it('empty contentHash preserves at saved index (icon-only element)', () => {
    const source = 'src/icons.tsx:5:3'
    const siblings = buildSiblings(source, ['', '', ''])
    // Icon-only elements have empty textContent. Skip byContent search
    // (would false-positive on first empty sibling); preserve at index.
    const result = reResolveSelection({
      source, index: 1, contentHash: '', inShadowRoot: false,
    })
    expect(result).toBe(siblings[1])
  })

  it('tie-breaks duplicate-content reorder by preferring nearest index', () => {
    // `[A, B, A]` — user selected index 2 (third "A"). Reorder to `[A, A, B]`
    // — "A" exists at both index 0 AND index 1. Nearest to saved index 2 is
    // index 1. Without the tie-break, `matches.find()` would collapse to
    // index 0 (the first "A") — wrong logical element.
    const source = 'src/list.tsx:10:5'
    const siblings = buildSiblings(source, ['A', 'A', 'B'])
    const result = reResolveSelection({
      source, index: 2, contentHash: 'A', inShadowRoot: false,
    })
    expect(result).toBe(siblings[1])
  })

  it('finds element inside an open shadow root via deep-query fallback', () => {
    // When inShadowRoot is true and the flat document query returns nothing
    // (shadow DOM is opaque to querySelectorAll), findSourceMatches falls back
    // to deepQuerySelectorAll.
    const host = document.createElement('div')
    document.body.appendChild(host)
    orphans.push(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const inner = document.createElement('span')
    inner.setAttribute('data-cortex-source', 'src/shadow.tsx:5:1')
    inner.appendChild(document.createTextNode('Shadow content'))
    shadow.appendChild(inner)

    // Sanity: flat query cannot see it.
    expect(document.querySelectorAll('[data-cortex-source="src/shadow.tsx:5:1"]').length).toBe(0)

    const result = reResolveSelection({
      source: 'src/shadow.tsx:5:1',
      index: 0,
      contentHash: 'Shadow content',
      inShadowRoot: true,
    })
    expect(result).toBe(inner)
  })
})

describe('captureSelectionMetadata', () => {
  const orphans: HTMLElement[] = []

  afterEach(() => {
    for (const el of orphans) el.remove()
    orphans.length = 0
  })

  it('returns null source + -1 index when element has no data-cortex-source', () => {
    const el = document.createElement('div')
    el.appendChild(document.createTextNode('hi'))
    document.body.appendChild(el)
    orphans.push(el)
    const meta = captureSelectionMetadata(el)
    expect(meta.source).toBeNull()
    expect(meta.index).toBe(-1)
    expect(meta.contentHash).toBe('hi')
    expect(meta.inShadowRoot).toBe(false)
  })

  it('captures nth index among siblings sharing the same source', () => {
    const source = 'src/list.tsx:10:5'
    const sibs = ['A', 'B', 'C'].map((content) => {
      const el = document.createElement('div')
      el.setAttribute('data-cortex-source', source)
      el.appendChild(document.createTextNode(content))
      document.body.appendChild(el)
      orphans.push(el)
      return el
    })
    expect(captureSelectionMetadata(sibs[0]!).index).toBe(0)
    expect(captureSelectionMetadata(sibs[1]!).index).toBe(1)
    expect(captureSelectionMetadata(sibs[2]!).index).toBe(2)
  })

  it('trims textContent whitespace when capturing contentHash', () => {
    const el = document.createElement('div')
    el.setAttribute('data-cortex-source', 'src/a.tsx:1:1')
    el.appendChild(document.createTextNode('  hello  \n'))
    document.body.appendChild(el)
    orphans.push(el)
    expect(captureSelectionMetadata(el).contentHash).toBe('hello')
  })

  it('sets inShadowRoot true when element is inside an open shadow root', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    orphans.push(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const el = document.createElement('span')
    el.setAttribute('data-cortex-source', 'src/widget.tsx:3:2')
    shadow.appendChild(el)
    const meta = captureSelectionMetadata(el)
    expect(meta.inShadowRoot).toBe(true)
    expect(meta.source).toBe('src/widget.tsx:3:2')
  })
})

describe('shouldRefreshOnHMR', () => {
  const orphans: HTMLElement[] = []

  afterEach(() => {
    for (const el of orphans) el.remove()
    orphans.length = 0
  })

  function build(source: string): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('data-cortex-source', source)
    document.body.appendChild(el)
    orphans.push(el)
    return el
  }

  it('returns false when element is null (nothing selected, nothing to refresh)', () => {
    expect(shouldRefreshOnHMR(['src/foo.tsx'], null)).toBe(false)
  })

  it('returns true when files is undefined (backward-compat with older server)', () => {
    const el = build('src/foo.tsx:1:1')
    expect(shouldRefreshOnHMR(undefined, el)).toBe(true)
  })

  it('returns true when files is empty (server signaled cycle but could not enumerate)', () => {
    const el = build('src/foo.tsx:1:1')
    expect(shouldRefreshOnHMR([], el)).toBe(true)
  })

  it('delegates to hmrFilesAffectElement when files is non-empty', () => {
    const el = build('src/foo.tsx:1:1')
    expect(shouldRefreshOnHMR(['src/foo.tsx'], el)).toBe(true)
    expect(shouldRefreshOnHMR(['src/bar.tsx'], el)).toBe(false)
  })
})

// source-transform annotates every lowercase JSX tag, so <svg>/<path> in the
// user's own .jsx carry data-cortex-source. These lock in that an SVG selection
// SURVIVES an HMR cycle — the HTMLElement filter that used to live in
// findSourceMatches made captureSelectionMetadata report index === -1, which
// made reResolveSelection return null and silently cleared the selection on the
// next save. A fix to the click path alone would have evaporated there.
describe('SVG selections survive re-resolution', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const orphans: Element[] = []

  afterEach(() => {
    for (const el of orphans) el.remove()
    orphans.length = 0
  })

  /** N sibling icons sharing one source — the `.map()` over an icon list case. */
  function appendIcons(wrap: Element, source: string, count: number): SVGSVGElement[] {
    const svgs: SVGSVGElement[] = []
    for (let i = 0; i < count; i++) {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('data-cortex-source', source)
      svg.textContent = `icon-${i}`
      wrap.appendChild(svg)
      svgs.push(svg)
    }
    return svgs
  }

  function makeWrap(): HTMLDivElement {
    const wrap = document.createElement('div')
    document.body.appendChild(wrap)
    orphans.push(wrap)
    return wrap
  }

  it('captureSelectionMetadata computes a real index for an <svg>', () => {
    const svgs = appendIcons(makeWrap(), 'src/Icons.tsx:7:9', 3)
    const meta = captureSelectionMetadata(svgs[1]!)
    expect(meta.source).toBe('src/Icons.tsx:7:9')
    expect(meta.index).toBe(1) // pre-fix: -1, because indexOf ran over a filtered list
  })

  it('reResolveSelection follows an <svg> selection onto its replacement node', () => {
    const wrap = makeWrap()
    const original = appendIcons(wrap, 'src/Icons.tsx:7:9', 3)
    const meta = captureSelectionMetadata(original[1]!)

    // Simulate the HMR swap: same markup, brand-new DOM nodes.
    for (const svg of original) svg.remove()
    const fresh = appendIcons(wrap, 'src/Icons.tsx:7:9', 3)

    const resolved = reResolveSelection(meta)
    expect(resolved).toBe(fresh[1]) // pre-fix: null → CortexApp clears the selection
    expect(resolved).not.toBe(original[1])
  })
})
