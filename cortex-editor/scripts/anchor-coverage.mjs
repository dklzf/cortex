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
 * Usage:
 *   node scripts/anchor-coverage.mjs --base http://localhost:3000 --routes / /about
 *   node scripts/anchor-coverage.mjs --base http://localhost:3000 --routes-file routes.txt
 *
 * With --verify-root <project dir> it also reports CORRECTNESS (COR-29): whether
 * each anchor's recorded position resolves to the element it claims. Uniqueness
 * cannot answer that — adding a constant to every line number is a one-to-one
 * mapping, so COR-28's 19-line offset left every label exactly as unique as
 * before while pointing all of them at the wrong element.
 *
 * Output: per-route and aggregate buckets, plus a shared-source histogram, and
 * a second table restricted to the REORDERABLE-SIBLING population (nodes with
 * >= 2 element siblings inside a flex/grid layout parent) — the only nodes a
 * drag-reorder gesture can target, and a strictly harder case for identity.
 * Exits non-zero only on harness failure, never on a bad score — this measures,
 * it does not gate.
 */
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const out = { base: null, routes: [], viewport: { width: 1440, height: 900 }, settleMs: 1500, verifyRoot: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') out.base = argv[++i]
    else if (a === '--settle') out.settleMs = Number(argv[++i])
    else if (a === '--verify-root') out.verifyRoot = argv[++i]
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
  // COR-29: every (source, localName) pair, for CORRECTNESS verification back in
  // Node. localName, not tagName — it lower-cases HTML while preserving SVG
  // casing, and an SVG anchor compared against an upper-cased tagName would read
  // as a mismatch that is really a casing artifact.
  const anchorSamples = []

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
    anchorSamples.push({ source: src, domTag: el.localName })
  }

  // ── Second, stricter population: what a designer can actually POINT AT. ──
  // Walking every visible element overcounts badly on component-library apps —
  // most of those nodes are internal wrapper divs no one would ever target.
  // elementFromPoint over a grid returns exactly the set a cursor can hit, which
  // is the population a drag gesture actually draws from.
  const hit = { unique: 0, shared: 0, unannotated: 0 }
  const seen = new Set()
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
    }
  }
  window.scrollTo(0, 0)

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
    anchorSamples,
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
    cortexPresent: !!document.querySelector('[data-cortex-source]'),
  }
}

const pct = (n, d) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1).padStart(5)}%`)

async function main() {
  const { base, routes, viewport, settleMs, verifyRoot } = parseArgs(process.argv)
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport })

  const agg = { unique: 0, shared: 0, unannotated: 0, total: 0 }
  const aggR = { unique: 0, shared: 0, unannotated: 0, total: 0 }
  const aggRP = { unique: 0, shared: 0, unannotated: 0, total: 0 }
  const aggRPairs = { unique: 0, shared: 0, unannotated: 0, total: 0 }
  const allShared = []
  const allAnchorSamples = []
  const allReorderShared = []
  const rows = []

  for (const route of routes) {
    const url = new URL(route, base).toString()
    let r
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
      if (resp && resp.status() >= 400) { rows.push({ route, error: `HTTP ${resp.status()}` }); continue }
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
    allAnchorSamples.push(...(r.anchorSamples ?? []))
    allReorderShared.push(...r.reorderSharedSizes)
    rows.push({ route, ...r })
  }
  await browser.close()

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
  } else {
    console.log('\nNo pages measured. Every route errored — see above.')
  }

  // ── COR-29: CORRECTNESS, which uniqueness cannot see ──────────────────────
  //
  // Adding a constant to every line number is a one-to-one mapping, so every
  // label stays exactly as unique as it was. COR-28's 19-line offset — where
  // 100% of Vite anchors pointed at the wrong element — would have scored
  // identically above. These four numbers are kept SEPARATE on purpose: one
  // blended "accuracy" figure scores a tool that refuses 40% of the time and is
  // never wrong the same as one that answers always and is wrong 10% of the
  // time, and those are not the same tool.
  if (verifyRoot && allAnchorSamples.length) {
    let summarize
    try {
      ;({ summarizeAnchors: summarize } = await import('../dist/index.js'))
    } catch {
      console.log('\nCORRECTNESS: skipped — run `npm run build` first (the verifier ships from dist).')
      console.log('')
      return
    }
    const fileCache = new Map()
    const readFile = (rel) => {
      if (fileCache.has(rel)) return fileCache.get(rel)
      let text = null
      try { text = fs.readFileSync(path.resolve(verifyRoot, rel), 'utf8') } catch { text = null }
      fileCache.set(rel, text)
      return text
    }
    const sum = summarize(allAnchorSamples, readFile)
    console.log('\nCORRECTNESS — does each anchor resolve to the element it claims?')
    console.log(`corpus: ${verifyRoot}  (always name the corpus — the same harness scored dev-app 91.7% and real routes 7.0%)`)
    console.log('='.repeat(78))
    console.log(`  COVERAGE        ${pct(agg.unique + agg.shared, agg.total)}  of pointable elements carry a label`)
    console.log(`  VERIFIED        ${pct(sum.verified, sum.total)}  position resolves to a matching tag`)
    console.log(`  UNIQUE          ${pct(agg.unique, agg.total)}  identifies exactly one element (NOT a correctness claim)`)
    console.log(`  SILENTLY-WRONG  ${pct(sum.silentlyWrong, sum.total)}  resolves to a DIFFERENT element — must be 0`)
    console.log(`  (unresolvable   ${pct(sum.unresolvable, sum.total)}  refused, not wrong: component anchors, unreadable files)`)
    if (sum.mismatches.length) {
      console.log('\n  mismatches (first 10) — named, because a bare count is not actionable:')
      for (const m of sum.mismatches.slice(0, 10)) {
        console.log(`    ${m.source}  DOM <${m.domTag}>  but source has <${m.sourceTag}>`)
      }
    }
  } else if (!verifyRoot) {
    console.log('\nCORRECTNESS: not measured. Pass --verify-root <project dir> to check whether')
    console.log('anchors point at the elements they claim. Uniqueness above CANNOT answer that.')
  }
  console.log('')
}

main().catch(err => { console.error('harness failure:', err); process.exit(1) })
