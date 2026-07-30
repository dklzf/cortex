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
 * Output: per-route and aggregate buckets, plus a shared-source histogram.
 * Exits non-zero only on harness failure, never on a bad score — this measures,
 * it does not gate.
 */
import { chromium } from '@playwright/test'
import fs from 'node:fs'

function parseArgs(argv) {
  const out = { base: null, routes: [], viewport: { width: 1440, height: 900 }, settleMs: 1500 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') out.base = argv[++i]
    else if (a === '--settle') out.settleMs = Number(argv[++i])
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

  return {
    buckets,
    hit,
    hitTotal: hit.unique + hit.shared + hit.unannotated,
    total: buckets.unique + buckets.shared + buckets.unannotated,
    distinctSources: sourceCounts.size,
    sharedGroupSizes: sharedSizes,
    unannotatedSample,
    cortexPresent: !!document.querySelector('[data-cortex-source]'),
  }
}

const pct = (n, d) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1).padStart(5)}%`)

async function main() {
  const { base, routes, viewport, settleMs } = parseArgs(process.argv)
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport })

  const agg = { unique: 0, shared: 0, unannotated: 0, total: 0 }
  const allShared = []
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
    allShared.push(...r.sharedGroupSizes)
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
  } else {
    console.log('\nNo pages measured. Every route errored — see above.')
  }
  console.log('')
}

main().catch(err => { console.error('harness failure:', err); process.exit(1) })
