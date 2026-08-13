#!/usr/bin/env node
/**
 * M0-zero/1 — unique-anchor coverage on a real app's rendered pages.
 *
 * The sketch-mode spec gates funding the identity corpus (M0a) on a cheap
 * leading indicator: of the nodes a designer could plausibly grab and drag,
 * what fraction carry a `data-cortex-source` that identifies ONE element?
 *
 * Why "unique" is the metric that matters, not "annotated": `data-cortex-source`
 * is per SOURCE LOCATION, not per rendered instance. A `.map()` over ten rows
 * emits ten DOM nodes sharing one source. Those nodes are annotated but not
 * identified — a gesture on row 7 is indistinguishable from row 2 at the anchor
 * level, and resolving it needs either a second signal or a question to the
 * user. Counting "has the attribute" would report ~100% on exactly the apps
 * where identity is hardest.
 *
 * Coverage alone cannot say the anchors are RIGHT (COR-29). Adding a constant to
 * every line number is one-to-one, so the 19-line offset that made 100% of Vite
 * anchors false in COR-28 left every figure in this report untouched. Pass
 * `--verify-root <app-dir>` to additionally resolve each anchor against its
 * source file and report how many point at the element they claim.
 *
 * Usage:
 *   node scripts/anchor-coverage.mjs --base http://localhost:3000 --routes / /about
 *   node scripts/anchor-coverage.mjs --base http://localhost:3000 --routes-file routes.txt
 *   node scripts/anchor-coverage.mjs --base http://localhost:5173 --verify-root ../dev-app
 *
 * Output: per-route and aggregate buckets, plus a shared-source histogram, and
 * a second table restricted to the REORDERABLE-SIBLING population (nodes with
 * >= 2 element siblings inside a flex/grid layout parent) — the only nodes a
 * drag-reorder gesture can target, and a strictly harder case for identity.
 * With --verify-root, a third table reports anchor CORRECTNESS over the same
 * pointable population the coverage table uses.
 * Exits non-zero only on harness failure, never on a bad score — this measures,
 * it does not gate.
 */
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const out = { base: null, routes: [], viewport: { width: 1440, height: 900 }, settleMs: 1500, verifyRoot: null, harvest: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') out.base = argv[++i]
    else if (a === '--settle') out.settleMs = Number(argv[++i])
    else if (a === '--verify-root') out.verifyRoot = path.resolve(argv[++i])
    else if (a === '--harvest') out.harvest = true
    else if (a === '--routes-file') {
      out.routes.push(...fs.readFileSync(argv[++i], 'utf8').split('\n').map(s => s.trim()).filter(Boolean))
    } else if (a === '--routes') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) out.routes.push(argv[++i])
    }
  }
  if (!out.base) throw new Error('--base is required (e.g. --base http://localhost:3000)')
  if (out.routes.length === 0) out.routes.push('/')
  return out
}

/**
 * Load the anchor verifier without shipping it.
 *
 * `src/core/anchor-verify.ts` is a MEASUREMENT utility, not product API. Adding
 * it to `src/index.ts` would put it on the package's public export surface —
 * which RELEASING.md treats as a breakable, semver-governed contract — to serve
 * one dev script. Bundling it on demand here keeps it out of both `exports` and
 * the published tarball (`files: ["dist"]`) while the vitest suite still imports
 * the TypeScript source directly.
 *
 * ts-morph stays external so the on-the-fly bundle resolves the same copy the
 * rest of the toolchain uses, and so this stays fast.
 */
async function loadVerifier() {
  const esbuild = await import('esbuild')
  // Emit INSIDE the package, not os.tmpdir(). Node resolves a bare specifier by
  // walking node_modules up from the importing FILE's directory, so an
  // out-of-tree bundle has no path back to `ts-morph` and fails at import time.
  // node_modules/.cache is on the resolution path and already ignored by git.
  const outfile = new URL('../node_modules/.cache/cortex/anchor-verify.mjs', import.meta.url).pathname
  fs.mkdirSync(path.dirname(outfile), { recursive: true })
  await esbuild.build({
    entryPoints: [new URL('../src/core/anchor-verify.ts', import.meta.url).pathname],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['ts-morph'],
    logLevel: 'silent',
  })
  return import(outfile)
}

/** Read a file named by an anchor, resolving relative paths against the app root. */
function makeReader(verifyRoot) {
  const cache = new Map()
  return (filePath) => {
    if (cache.has(filePath)) return cache.get(filePath)
    const abs = path.isAbsolute(filePath) ? filePath : path.join(verifyRoot, filePath)
    let text = null
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      text = null   // unreadable ⇒ `unresolvable`, never counted as wrong
    }
    cache.set(filePath, text)
    return text
  }
}

/**
 * Runs IN THE PAGE. Classifies every element a designer could plausibly grab.
 *
 * "Plausibly draggable" is deliberately generous — the point is to measure the
 * anchor layer, not to pre-filter to nodes we already know we can identify.
 * Excluded only: cortex's own UI, non-visual tags, zero-area boxes, and the
 * document roots (which are never edit targets).
 */
const PROBE = () => {
  const NON_VISUAL = new Set(['script', 'style', 'meta', 'head', 'title', 'link', 'noscript', 'template', 'br'])
  const NON_RENDERED_SVG = new Set(['defs', 'clippath', 'mask', 'marker', 'pattern', 'symbol', 'filter', 'metadata', 'desc', 'lineargradient', 'radialgradient'])

  // Count how many elements share each source value, so "annotated" can be
  // split into "identifies one element" vs "identifies N".
  const sourceCounts = new Map()
  for (const el of document.querySelectorAll('[data-cortex-source]')) {
    const s = el.getAttribute('data-cortex-source')
    if (s) sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1)
  }

  const buckets = { unique: 0, shared: 0, unannotated: 0 }
  const sharedSizes = []
  const unannotatedSample = []

  for (const el of document.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase()
    if (NON_VISUAL.has(tag) || NON_RENDERED_SVG.has(tag)) continue
    if (el === document.documentElement || el === document.body) continue
    if (el.closest('[data-cortex-host]') || el.hasAttribute('data-cortex-root')) continue

    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue

    const src = el.getAttribute('data-cortex-source')
    if (!src) {
      buckets.unannotated++
      if (unannotatedSample.length < 12) {
        unannotatedSample.push(tag + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''))
      }
      continue
    }
    const n = sourceCounts.get(src) ?? 1
    if (n === 1) buckets.unique++
    else { buckets.shared++; sharedSizes.push(n) }
  }

  // ── Second, stricter population: what a designer can actually POINT AT. ──
  // Walking every visible element overcounts badly on component-library apps —
  // most of those nodes are internal wrapper divs no one would ever target.
  // elementFromPoint over a grid returns exactly the set a cursor can hit, which
  // is the population a drag gesture actually draws from.
  const hit = { unique: 0, shared: 0, unannotated: 0 }
  const seen = new Set()
  // Correctness samples, drawn from the pointable population below. Capped so a
  // huge page cannot blow up the serialized probe result; `anchorSamplesDropped`
  // is returned and PRINTED rather than swallowed, because a silent cap reads as
  // "we verified everything" when we did not.
  const anchorSamples = []
  const SAMPLE_CAP = 3000
  let anchorSamplesDropped = 0
  const STEP = 24
  const maxY = Math.max(document.documentElement.scrollHeight, window.innerHeight)
  for (let y = 0; y < maxY; y += STEP) {
    window.scrollTo(0, Math.max(0, y - window.innerHeight / 2))
    const vy = y - window.scrollY
    if (vy < 0 || vy > window.innerHeight) continue
    for (let x = 0; x < window.innerWidth; x += STEP) {
      const el = document.elementFromPoint(x, vy)
      if (!el || seen.has(el)) continue
      seen.add(el)
      const tag = el.tagName.toLowerCase()
      if (NON_VISUAL.has(tag) || NON_RENDERED_SVG.has(tag)) continue
      if (el === document.documentElement || el === document.body) continue
      if (el.closest('[data-cortex-host]')) continue
      const s = el.getAttribute('data-cortex-source')
      if (!s) { hit.unannotated++; continue }
      ;(sourceCounts.get(s) ?? 1) === 1 ? hit.unique++ : hit.shared++
      // Sample from THIS population, not the all-elements walk. COVERAGE and
      // UNIQUE are computed over elementFromPoint hits, so verifying a different
      // (much larger) set would let correctness failures among real pointable
      // targets be diluted by non-pointable wrapper divs.
      if (anchorSamples.length < SAMPLE_CAP) {
        anchorSamples.push({
          source: s,
          // localName, NOT tagName: tagName upper-cases HTML but preserves case
          // for SVG (`linearGradient`), so it does not compare cleanly with the
          // JSX tag text on the source side.
          domTag: el.localName,
          ...(el.getAttribute('class') ? { domClass: el.getAttribute('class') } : {}),
        })
      } else anchorSamplesDropped++
    }
  }
  window.scrollTo(0, 0)

  // ── HARVEST (COR plan 2026-08-13) ────────────────────────────────────────
  // What does REACT already know that cortex did not stamp?
  //
  // Three numbers, deliberately separate because they decide different things:
  //   N1  of nodes with NO cortex stamp, how many get a user-code source
  //       location from React's own `_debugStack`?           → addressability
  //   N2  of `.map()` children, how many carry a USABLE key?  → per-instance
  //   N3  of plausible containers, how many are unique?       → can move ship
  //
  // All of this is DEV-ONLY and reads private React fields. That is acceptable
  // for a measurement; it is not a shipping decision. See the plan's §7.
  const fiberOf = (el) => {
    for (const k in el) if (k.charCodeAt(0) === 95 && k.startsWith('__reactFiber$')) return el[k]
    return null
  }

  // A user-code source location out of ONE fiber's own creation stack.
  const stackSrc = (fiber) => {
    const raw = fiber?._debugStack
    if (!raw) return null
    const stack = String(raw.stack ?? raw)
    for (const line of stack.split('\n')) {
      const m = /\((https?:\/\/[^)]+)\)/.exec(line) ?? /at\s+(https?:\/\/\S+)/.exec(line)
      const url = m?.[1]
      if (!url || !/\.[jt]sx?:\d+:\d+/.test(url)) continue
      if (url.includes('/node_modules/')) continue
      // Strip origin and Vite's ?v= cache-buster so this is comparable with a
      // `data-cortex-source` value.
      return url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?[^:]*(?=:\d+:\d+$)/, '')
    }
    return null
  }

  // MEASURED CORRECTION (2026-08-13): `_debugStack` alone does NOT cross the
  // library boundary. For a Radix-rendered <button> the whole stack is
  //   at Primitive.button (@radix-ui_react-accordion.js:921:40)
  //   at react_stack_bottom_frame (react-dom_client.js) …
  // with NO user frame at all — because the stack records where THAT element
  // was created, which is inside the library. So a stack-only harvest recovers
  // nothing for exactly the population it was meant to reach (measured: 0 of 16).
  //
  // `_debugOwner` is the field that does cross it. On the same node the owner
  // chain walks up through the library's wrappers and reaches `App`. So the
  // route is: climb owners until one of them was itself created in user code,
  // and take THAT owner's stack. The result is the user's call site — the
  // element the designer would recognise as theirs.
  const userSrcFrom = (fiber) => {
    const own = stackSrc(fiber)
    if (own) return { src: own, viaOwnerHops: 0 }
    let owner = fiber?._debugOwner, hops = 0
    while (owner && hops++ < 12) {
      const s = stackSrc(owner)
      if (s) return { src: s, viaOwnerHops: hops }
      owner = owner._debugOwner
    }
    return null
  }

  const ownerName = (f) => f?.elementType?.name ?? f?.elementType?.displayName
    ?? f?.type?.name ?? f?.type?.displayName
    ?? f?.elementType?.render?.name ?? null

  const harvest = {
    // N1
    unstamped: 0, unstampedWithReactSrc: 0,
    // How many needed an OWNER-CHAIN climb rather than the node's own stack.
    // This is the library-boundary population; a stack-only harvest reports 0.
    viaOwnerChain: 0,
    // N2 — one record per .map()-style GROUP (siblings sharing a parent+source)
    keyGroups: [],
    // N3
    containers: 0, containersUniquelyAnchored: 0,
    // evidence for the report
    samples: [],
  }

  if (window.__CORTEX_HARVEST__) {
    const seenGroup = new Set()
    for (const el of document.querySelectorAll('*')) {
      if (NON_VISUAL.has(el.tagName.toLowerCase())) continue
      if (el.closest('[data-cortex-host]') || el.hasAttribute('data-cortex-root')) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue

      const stamp = el.getAttribute('data-cortex-source')
      const f = fiberOf(el)

      // ── N1 ──
      if (!stamp) {
        harvest.unstamped++
        const found = userSrcFrom(f)
        if (found) {
          harvest.unstampedWithReactSrc++
          if (found.viaOwnerHops > 0) harvest.viaOwnerChain++
          if (harvest.samples.length < 25) {
            harvest.samples.push({
              tag: el.localName, reactSrc: found.src, hops: found.viaOwnerHops,
              owner: ownerName(f?._debugOwner),
            })
          }
        }
      }

      // ── N3: a plausible CONTAINER is a node with >= 2 element children ──
      if (el.children.length >= 2) {
        harvest.containers++
        // "Uniquely anchored" = carries a stamp that no other element carries.
        if (stamp && (sourceCounts.get(stamp) ?? 0) === 1) harvest.containersUniquelyAnchored++
      }

      // ── N2: keyed sibling groups ──
      // A group is the keyed children of one parent. Recorded once per parent.
      // The key does NOT necessarily live on the DOM node's own fiber. For
      // `{rows.map(r => <Accordion.Item key={r}/>)}` the key is on the COMPONENT
      // fiber, and the host <div> it renders has key null. Reading only the DOM
      // node's fiber therefore missed every component-keyed list — which is the
      // common shape in library code, and it under-counted N2 to 1 group on a
      // fixture that has two. Climb to the nearest keyed fiber instead.
      // MEASURED: 6 hops is too shallow. Radix stacks ~7 levels of its own
      // internals (Primitive.div -> Provider -> AccordionItemContext -> …)
      // between the host node and the keyed <Accordion.Item>, so a shallow
      // climb reports "no keyed group" for a list that plainly has one.
      // Raised to 20, and the siblings' keyed fibers must share a `return` —
      // otherwise the climb has walked past this list into an unrelated
      // ancestor whose key belongs to a different group entirely.
      const keyedOf = (node) => {
        let x = fiberOf(node), n = 0
        while (x && n++ < 20) { if (x.key !== null) return x; x = x.return }
        return null
      }
      const parent = el.parentElement
      const selfKeyed = keyedOf(el)
      if (parent && selfKeyed && !seenGroup.has(parent)) {
        seenGroup.add(parent)
        const kids = Array.from(parent.children)
          .map(c => ({ el: c, f: keyedOf(c) }))
          .filter(x => x.f && x.f.key !== null)
        // One list, not several: every keyed fiber must have the same parent.
        const sameList = kids.length >= 2 && kids.every(x => x.f.return === kids[0].f.return)
        if (sameList) {
          const keys = kids.map(x => String(x.f.key))
          // `key={index}` is the degenerate case and it is NOT directly
          // observable — at read time an index key is just a string. The
          // heuristic: if every key equals its own position, the group is
          // almost certainly index-keyed. Reported AS a heuristic, because it
          // cannot distinguish index-keying from data that happens to be
          // 0,1,2… — and that residual ambiguity is itself a finding.
          const looksIndexed = keys.every((k, i) => k === String(i))
          harvest.keyGroups.push({
            size: kids.length,
            looksIndexed,
            allDistinct: new Set(keys).size === keys.length,
            parentStamped: !!parent.getAttribute('data-cortex-source'),
            sampleKeys: keys.slice(0, 5),
          })
        }
      }
    }
  }

  // ── Third population: nodes that are actually REORDERABLE. ───────────────
  // The headline number above is a marginal over every pointable node, which
  // mixes in one-off chrome (headers, the single H1, a lone button) — elements
  // that are unique precisely BECAUSE they have no siblings to reorder among.
  // A drag-reorder gesture can only ever target a node that (a) sits in a
  // multi-child layout container and (b) has real siblings to swap with, and
  // those are by construction repeated renders. Measuring that population
  // separately says whether the anchor layer can support the reorder gesture,
  // as opposed to whether it can support pointing at things in general.
  //
  // Criteria: >= 2 element siblings under the same layout parent, and that
  // layout parent lays out its children (flex / grid, incl. the two-value
  // `block flex` forms). display:contents ancestors are transparent to layout,
  // so they are walked through on both the parent lookup and the sibling count.
  const laysOutChildren = (display) => {
    const parts = display.trim().split(/\s+/)
    const last = parts[parts.length - 1]
    return last === 'flex' || last === 'grid' || last === 'inline-flex' || last === 'inline-grid'
  }
  const displayOf = (el) => getComputedStyle(el).display
  // Nearest ancestor that actually generates a layout box for `el`.
  const layoutParentOf = (el) => {
    let p = el.parentElement
    while (p && displayOf(p) === 'contents') p = p.parentElement
    return p
  }
  // Children of `parent` as the layout tree sees them: display:contents boxes
  // are replaced by their own children, recursively.
  const layoutChildrenOf = (parent) => {
    const out = []
    const walk = (node) => {
      for (const c of node.children) {
        const d = displayOf(c)
        if (d === 'contents') { walk(c); continue }   // transparent to layout
        // A box that is not generated is not a sibling you could reorder among.
        // Counting these inflated the sibling count and contradicted this
        // function's own stated semantics ("as the layout tree sees them").
        if (d === 'none') continue
        if (NON_VISUAL.has(c.tagName.toLowerCase())) continue
        out.push(c)
      }
    }
    walk(parent)
    return out
  }
  const layoutChildCache = new Map()
  const layoutChildCount = (parent) => {
    if (!layoutChildCache.has(parent)) layoutChildCache.set(parent, layoutChildrenOf(parent).length)
    return layoutChildCache.get(parent)
  }

  const reorder = { unique: 0, shared: 0, unannotated: 0 }
  const reorderPointable = { unique: 0, shared: 0, unannotated: 0 }
  const reorderSharedSizes = []
  const reorderUnannotatedSample = []
  // Looser reading of "reorderable" (>= 1 sibling, i.e. a 2-item row) kept as a
  // sanity check that the >= 2 threshold is not what drives the result.
  const reorderPairs = { unique: 0, shared: 0, unannotated: 0 }

  for (const el of document.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase()
    if (NON_VISUAL.has(tag) || NON_RENDERED_SVG.has(tag)) continue
    if (el === document.documentElement || el === document.body) continue
    if (el.closest('[data-cortex-host]') || el.hasAttribute('data-cortex-root')) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue

    const parent = layoutParentOf(el)
    if (!parent || parent === document.documentElement) continue
    if (!laysOutChildren(displayOf(parent))) continue
    const siblings = layoutChildCount(parent) - 1
    if (siblings < 1) continue

    const src = el.getAttribute('data-cortex-source')
    const key = !src ? 'unannotated' : (sourceCounts.get(src) ?? 1) === 1 ? 'unique' : 'shared'
    reorderPairs[key]++
    if (siblings < 2) continue
    reorder[key]++
    if (seen.has(el)) reorderPointable[key]++
    if (key === 'shared') reorderSharedSizes.push(sourceCounts.get(src))
    if (key === 'unannotated' && reorderUnannotatedSample.length < 12) {
      reorderUnannotatedSample.push(tag + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''))
    }
  }

  return {
    buckets,
    hit,
    hitTotal: hit.unique + hit.shared + hit.unannotated,
    total: buckets.unique + buckets.shared + buckets.unannotated,
    distinctSources: sourceCounts.size,
    sharedGroupSizes: sharedSizes,
    unannotatedSample,
    reorder,
    reorderTotal: reorder.unique + reorder.shared + reorder.unannotated,
    reorderPointable,
    reorderPointableTotal: reorderPointable.unique + reorderPointable.shared + reorderPointable.unannotated,
    reorderPairs,
    reorderPairsTotal: reorderPairs.unique + reorderPairs.shared + reorderPairs.unannotated,
    reorderSharedSizes,
    reorderUnannotatedSample,
    anchorSamples,
    anchorSamplesDropped,
    harvest,
    cortexPresent: !!document.querySelector('[data-cortex-source]'),
  }
}

const pct = (n, d) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1).padStart(5)}%`)

async function main() {
  const { base, routes, viewport, settleMs, verifyRoot, harvest } = parseArgs(process.argv)
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport })

  const agg = { unique: 0, shared: 0, unannotated: 0, total: 0 }
  const aggR = { unique: 0, shared: 0, unannotated: 0, total: 0 }
  const aggRP = { unique: 0, shared: 0, unannotated: 0, total: 0 }
  const aggRPairs = { unique: 0, shared: 0, unannotated: 0, total: 0 }
  const allShared = []
  const allReorderShared = []
  const rows = []

  for (const route of routes) {
    const url = new URL(route, base).toString()
    let r
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
      if (resp && resp.status() >= 400) { rows.push({ route, error: `HTTP ${resp.status()}` }); continue }
      await page.addScriptTag({ content: `window.__CORTEX_HARVEST__ = ${harvest ? 'true' : 'false'}` })
      await page.waitForTimeout(settleMs)
      r = await page.evaluate(PROBE)
    } catch (err) {
      rows.push({ route, error: err.message.split('\n')[0] })
      continue
    }
    if (!r.cortexPresent) { rows.push({ route, error: 'no [data-cortex-source] on page — cortex not instrumenting this route' }); continue }

    agg.unique += r.hit.unique
    agg.shared += r.hit.shared
    agg.unannotated += r.hit.unannotated
    agg.total += r.hitTotal
    for (const k of ['unique', 'shared', 'unannotated']) {
      aggR[k] += r.reorder[k]
      aggRP[k] += r.reorderPointable[k]
      aggRPairs[k] += r.reorderPairs[k]
    }
    aggR.total += r.reorderTotal
    aggRP.total += r.reorderPointableTotal
    aggRPairs.total += r.reorderPairsTotal
    allShared.push(...r.sharedGroupSizes)
    allReorderShared.push(...r.reorderSharedSizes)
    rows.push({ route, ...r })
  }
  await browser.close()

  // ── Correctness pass (opt-in via --verify-root) ──────────────────────────
  // Runs against the SAME pointable population the coverage table reports, so
  // the two numbers describe one set of anchors rather than two.
  let verify = null
  let verifyFailed = false
  if (verifyRoot) {
    const samples = rows.filter(r => !r.error).flatMap(r => r.anchorSamples ?? [])
    const dropped = rows.filter(r => !r.error).reduce((n, r) => n + (r.anchorSamplesDropped ?? 0), 0)
    try {
      const { summarizeAnchors } = await loadVerifier()
      verify = { ...(await summarizeAnchors(samples, makeReader(verifyRoot))), dropped }
    } catch (err) {
      verify = { error: err.message.split('\n')[0] }
    }
  }

  console.log('\nM0-zero/1 — unique-anchor coverage')
  console.log('Population = elements reachable by elementFromPoint (what a cursor can actually grab),')
  console.log('not every visible node. All-elements figure shown alongside for contrast.')
  console.log('='.repeat(78))
  console.log('route'.padEnd(30) + 'pointable'.padStart(7) + 'unique'.padStart(9) + 'shared'.padStart(9) + 'none'.padStart(9))
  console.log('-'.repeat(78))
  for (const row of rows) {
    if (row.error) { console.log(row.route.padEnd(30) + '  ' + row.error); continue }
    console.log(
      row.route.slice(0, 29).padEnd(30) +
      String(row.hitTotal).padStart(7) +
      pct(row.hit.unique, row.hitTotal).padStart(9) +
      pct(row.hit.shared, row.hitTotal).padStart(9) +
      pct(row.hit.unannotated, row.hitTotal).padStart(9) +
      ('  [all-elements: ' + pct(row.buckets.unique, row.total).trim() + ' uniq]').padStart(26),
    )
  }
  console.log('-'.repeat(78))
  if (agg.total > 0) {
    console.log('AGGREGATE'.padEnd(30) + String(agg.total).padStart(7) +
      pct(agg.unique, agg.total).padStart(9) + pct(agg.shared, agg.total).padStart(9) + pct(agg.unannotated, agg.total).padStart(9))
    console.log('\nWhat the columns mean:')
    console.log('  unique  — one element carries this source. A gesture resolves to one node with no question.')
    console.log('  shared  — N elements share it (.map() rows, repeated components). Annotated but NOT identified;')
    console.log('            needs a second signal or a clarifying question. This is the number that decides M0a.')
    console.log('  none    — no source at all. Routes through agent-resolve with only a DOM hint.')
    if (allShared.length) {
      const sorted = [...allShared].sort((a, b) => a - b)
      const med = sorted[Math.floor(sorted.length / 2)]
      console.log(`\n  shared-group size: median ${med}, max ${sorted[sorted.length - 1]} (how many candidates a gesture must be disambiguated among)`)
    }
    const sample = rows.find(r => r.unannotatedSample?.length)?.unannotatedSample
    if (sample) console.log(`  unannotated sample: ${sample.slice(0, 8).join(', ')}`)

    // ── REORDERABLE-SIBLING population ───────────────────────────────────────
    console.log('\n' + '='.repeat(78))
    console.log('REORDERABLE-SIBLING population — what a drag-REORDER gesture can target')
    console.log('Filter: >= 2 element siblings under a layout parent whose display is flex/grid')
    console.log('(display:contents ancestors walked through). This drops one-off chrome, which is')
    console.log('unique precisely because it has nothing to reorder among.')
    console.log('='.repeat(78))
    console.log('route'.padEnd(30) + 'nodes'.padStart(7) + 'unique'.padStart(9) + 'shared'.padStart(9) + 'none'.padStart(9))
    console.log('-'.repeat(78))
    for (const row of rows) {
      if (row.error) continue
      console.log(
        row.route.slice(0, 29).padEnd(30) +
        String(row.reorderTotal).padStart(7) +
        pct(row.reorder.unique, row.reorderTotal).padStart(9) +
        pct(row.reorder.shared, row.reorderTotal).padStart(9) +
        pct(row.reorder.unannotated, row.reorderTotal).padStart(9),
      )
    }
    console.log('-'.repeat(78))
    console.log('AGGREGATE'.padEnd(30) + String(aggR.total).padStart(7) +
      pct(aggR.unique, aggR.total).padStart(9) + pct(aggR.shared, aggR.total).padStart(9) + pct(aggR.unannotated, aggR.total).padStart(9))
    console.log('∩ pointable'.padEnd(30) + String(aggRP.total).padStart(7) +
      pct(aggRP.unique, aggRP.total).padStart(9) + pct(aggRP.shared, aggRP.total).padStart(9) + pct(aggRP.unannotated, aggRP.total).padStart(9))
    console.log('>=1 sibling (looser)'.padEnd(30) + String(aggRPairs.total).padStart(7) +
      pct(aggRPairs.unique, aggRPairs.total).padStart(9) + pct(aggRPairs.shared, aggRPairs.total).padStart(9) + pct(aggRPairs.unannotated, aggRPairs.total).padStart(9))
    if (allReorderShared.length) {
      const s = [...allReorderShared].sort((a, b) => a - b)
      const med = s[Math.floor(s.length / 2)]
      const p90 = s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)]
      console.log(`\n  shared-group size (reorderable only): median ${med}, p90 ${p90}, max ${s[s.length - 1]}`)
    } else {
      console.log('\n  shared-group size (reorderable only): no shared nodes in this population')
    }
    const rSample = rows.find(r => r.reorderUnannotatedSample?.length)?.reorderUnannotatedSample
    if (rSample) console.log(`  unannotated sample: ${rSample.slice(0, 8).join(', ')}`)
    console.log('  ∩ pointable = reorderable nodes elementFromPoint also returned (the strict intersection).')
    console.log('  >=1 sibling  = same filter with the threshold relaxed to a 2-item row, as a sensitivity check.')

    // ── HARVEST ──────────────────────────────────────────────────────────────
    if (harvest) {
      const H = rows.filter(r => !r.error).map(r => r.harvest).filter(Boolean)
      const sum = (f) => H.reduce((n, h) => n + f(h), 0)
      const groups = H.flatMap(h => h.keyGroups)
      const unstamped = sum(h => h.unstamped)
      const withSrc = sum(h => h.unstampedWithReactSrc)
      const containers = sum(h => h.containers)
      const uniqueContainers = sum(h => h.containersUniquelyAnchored)
      const usable = groups.filter(g => !g.looksIndexed && g.allDistinct)
      const indexed = groups.filter(g => g.looksIndexed)

      console.log('\n' + '='.repeat(78))
      console.log('HARVEST — what React already knows that cortex did not stamp')
      console.log('='.repeat(78))
      // Counts WITH denominators, always. A bare percentage over an unstated
      // sample is how a measurement stops being checkable.
      console.log(`  N1 addressability   ${withSrc} of ${unstamped} unstamped nodes carry a user-code`)
      console.log(`                      source location from React   ${pct(withSrc, unstamped).trim()}`)
      console.log(`                      of those, ${sum(h => h.viaOwnerChain)} needed an OWNER-CHAIN climb — the`)
      console.log(`                      library-boundary population a stack-only read misses entirely`)
      console.log(`  N2 per-instance     ${usable.length} of ${groups.length} keyed sibling groups have a USABLE key`)
      console.log(`                      (distinct, and not index-shaped)          ${pct(usable.length, groups.length).trim()}`)
      console.log(`                      ${indexed.length} look INDEX-KEYED — see the caveat below`)
      console.log(`  N3 containers       ${uniqueContainers} of ${containers} multi-child containers are uniquely`)
      console.log(`                      anchored                                  ${pct(uniqueContainers, containers).trim()}`)

      console.log('\n  What each number decides:')
      console.log('    N1 — how much of the app becomes addressable WITHOUT a build-time stamp.')
      console.log('         React reports a call site even for library-rendered DOM, which the')
      console.log('         transform skips by design. This is the 83.6%-no-anchor population.')
      console.log('    N2 — whether "edit just this one" is reachable. A key is only as good as')
      console.log('         the developer\'s keys.')
      console.log('    N3 — whether drag-to-reorder can ship. A move needs an unambiguous')
      console.log('         CONTAINER plus an ordinal, NOT per-instance identity.')

      console.log('\n  CAVEAT on N2, and it is load-bearing: `key={index}` is not directly')
      console.log('  observable — at read time an index key is just a string. A group is counted')
      console.log('  index-shaped when every key equals its own position, which CANNOT separate')
      console.log('  index-keying from data that happens to run 0,1,2… If that residual ambiguity')
      console.log('  is large, keys must NOT drive a write: mistaking an index key for a real one')
      console.log('  edits the wrong row silently. That is the disqualifying outcome in the plan.')

      const ex = H.flatMap(h => h.samples).slice(0, 6)
      if (ex.length) {
        console.log('\n  Sample N1 recoveries (unstamped node -> React-reported source):')
        for (const e of ex) console.log(`    <${e.tag}>${e.owner ? ` in ${e.owner}` : ''}  ->  ${e.reactSrc}`)
      }
      if (groups.length === 0) {
        console.log('\n  NOTE: zero keyed sibling groups on these routes. N2 is undefined here,')
        console.log('  not zero — the routes contain no .map()-rendered lists to measure.')
      }
    }


    // ── ANCHOR CORRECTNESS ───────────────────────────────────────────────────
    console.log('\n' + '='.repeat(78))
    console.log('ANCHOR CORRECTNESS — does each anchor point at the element it claims?')
    console.log('='.repeat(78))
    if (!verify) {
      console.log('  not measured. Pass --verify-root <app-dir> to resolve anchors against source.')
      console.log('  Coverage above says anchors EXIST and are unique. It cannot say they are RIGHT:')
      console.log('  adding a constant to every line number is one-to-one, so a uniform offset leaves')
      console.log('  every uniqueness figure untouched while every anchor points elsewhere (COR-28).')
    } else if (verify.error) {
      console.log(`  verification FAILED: ${verify.error}`)
      console.log('  (exiting non-zero — a measurement you asked for and did not get is a harness')
      console.log('   failure, unlike a bad score, which this tool reports without gating.)')
      verifyFailed = true
    } else if (verify.total === 0) {
      // Not the same as "nothing wrong". Zero samples means no visible element
      // on any route carried an anchor at all — a louder result than any
      // percentage, and one that silently omitting the section would hide.
      console.log('  0 anchors sampled. Nothing on these routes carries a data-cortex-source,')
      console.log('  so correctness is undefined here — this is a coverage failure, not a clean bill.')
    } else {
      const t = verify.total
      console.log('  VERIFIED      ' + String(verify.verified).padStart(6) + pct(verify.verified, t).padStart(9) +
        '   resolved, tag agrees, and a class discriminator confirms it')
      console.log('  tag-only      ' + String(verify.tagOnly).padStart(6) + pct(verify.tagOnly, t).padStart(9) +
        '   tag agrees but nothing discriminates — NOT contradicted, NOT confirmed')
      console.log('  SILENTLY-WRONG' + String(verify.silentlyWrong).padStart(6) + pct(verify.silentlyWrong, t).padStart(9) +
        '   points at a different element, or at no JSX at all')
      console.log('  unreadable    ' + String(verify.unreadable).padStart(6) + pct(verify.unreadable, t).padStart(9) +
        '   file could not be read — a gap in what this harness saw, not a verdict')
      console.log('  component-anch' + String(verify.componentAnchor).padStart(6) + pct(verify.componentAnchor, t).padStart(9) +
        '   anchor names a COMPONENT, not a host tag — see note below')
      if (verify.dropped > 0) {
        console.log(`\n  NOTE: ${verify.dropped} pointable anchors exceeded the per-page sample cap and were NOT verified.`)
      }
      if (verify.mismatches.length) {
        console.log('\n  mismatches (first 10):')
        for (const m of verify.mismatches.slice(0, 10)) {
          console.log(`    ${m.source}  DOM <${m.domTag}> vs source <${m.sourceTag}>  — ${m.why}`)
        }
      }
      if (verify.componentAnchor > 0) {
        console.log('\n  component-anchor is NOT a failure under a call-site-addressing scheme — it is')
        console.log('  the expected result. It was previously folded into one `unresolvable` bucket')
        console.log('  alongside unreadable files, which made a fully working call-site scheme')
        console.log('  indistinguishable from a broken harness. Split so the two can be told apart.')
      }
      console.log('\n  SILENTLY-WRONG is the number that matters. Uniqueness cannot see it: a uniform')
      console.log('  line offset is one-to-one, so it leaves every coverage figure unchanged while')
      console.log('  making every anchor false. tag-only is reported separately and never folded into')
      console.log('  VERIFIED — "consistent with" is not "is".')
    }
  } else {
    console.log('\nNo pages measured. Every route errored — see above.')
  }
  console.log('')
  if (verifyFailed) process.exitCode = 1
}

main().catch(err => { console.error('harness failure:', err); process.exit(1) })
