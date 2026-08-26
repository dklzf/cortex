/**
 * Can an AGENT find the right JSX from the evidence cortex hands over?
 *
 * Every identity metric so far (N1/N3/N4) asks a different question: can CORTEX
 * compute a unique, deterministic address? That is the right bar for a
 * mechanical rewriter. It is the wrong bar for this product, because cortex
 * does not make the final edit — it hands evidence to Claude, who reads the
 * source and decides. An address cortex cannot compute may still be one Claude
 * can resolve from a rich enough description.
 *
 * ## The oracle: the corpus already exists
 *
 * Stamped elements are their own answer key. `data-cortex-source` is a
 * `file:line:col` the Babel transform wrote, so for any stamped element the
 * correct answer is already known. This script collects the evidence cortex
 * WOULD have for that element — deliberately WITHOUT its own stamp — and emits
 * the stamp separately as ground truth.
 *
 * Source files carry no stamps (the transform adds them at build time), so an
 * agent reading the repo cannot cheat by grepping for the answer.
 *
 * ## Two packets, so the comparison means something
 *
 *   A — exactly what ships today: the REAL `buildSourceResolutionHint`, reached
 *       through `getAgentResolveTarget`. Bundled from source and injected, never
 *       reimplemented here: a hand-written copy of "what I think today's hint
 *       looks like" would make the baseline measure my reconstruction, and any
 *       gain in B would be partly my copy being wrong.
 *   B — A plus the evidence cortex already computes and discards: ancestor
 *       chain, React owner-component path, the COR-35 discriminator, and
 *       sibling position.
 *
 * ## What this cannot do
 *
 * Stamped elements are by definition ones the transform could annotate — the
 * user's own JSX. A library-rendered node has no stamp and therefore no ground
 * truth here. This measures resolution on the population we can SCORE;
 * extending the conclusion to unstamped nodes is inference, not measurement.
 * Say so in any write-up.
 *
 * Usage:
 *   node scripts/resolve-oracle.mjs --base http://localhost:5173 --routes / \
 *     --out oracle.json [--limit 40] [--label dev-app]
 */
import { chromium } from '@playwright/test'
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

/** A positive integer, or throw. `Number()` alone accepts NaN, Infinity and
 *  negatives: `--limit NaN` never caps collection, and `--limit -1` writes an
 *  EMPTY corpus and exits 0, which reads as a successful run of nothing. */
function positiveInt(raw, flag) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return n
}

function parseArgs(argv) {
  const out = {
    base: null, routes: [], out: null, limit: 40, settleMs: 1500,
    label: 'unknown', verifyRoot: null,
    // Fixed default so a plain re-run reproduces the published corpus. The
    // shuffle is NOT optional — see the note where it is applied.
    seed: 20260814,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') out.base = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--limit') out.limit = positiveInt(argv[++i], '--limit')
    else if (a === '--settle') out.settleMs = positiveInt(argv[++i], '--settle')
    else if (a === '--seed') out.seed = positiveInt(argv[++i], '--seed')
    else if (a === '--verify-root') out.verifyRoot = path.resolve(argv[++i])
    else if (a === '--label') out.label = argv[++i]
    else if (a === '--routes') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) out.routes.push(argv[++i]) }
  }
  if (!out.base) throw new Error('--base is required')
  if (!out.out) throw new Error('--out is required')
  if (out.routes.length === 0) out.routes.push('/')
  return out
}

/**
 * Bundle `anchor-verify.ts` for use from Node, exactly as `anchor-coverage.mjs`
 * does. Emitted INSIDE the package: Node resolves a bare specifier by walking
 * node_modules up from the importing FILE, so an out-of-tree bundle has no path
 * back to `ts-morph`.
 */
async function loadVerifier() {
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
    try { text = fs.readFileSync(abs, 'utf8') } catch { text = null }
    cache.set(filePath, text)
    return text
  }
}

/**
 * Deterministic shuffle — mulberry32, seeded, so a re-run reproduces the corpus.
 *
 * NOT optional, and not cosmetic. The first run of this experiment scored 100%
 * on BOTH packets because the cases were emitted in `querySelectorAll` document
 * order: agents resolved the ambiguous ones by triangulating from neighbours
 * ("case ids 16-31 map 1:1 onto DOM preorder"). In production Claude receives
 * one intent at a time with no neighbours. The fix lived in ad-hoc scripting and
 * so was not reproducible — shuffling HERE is what makes the corpus honest for
 * anyone who runs it.
 */
function shuffled(list, seed) {
  let a = seed >>> 0
  const rand = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Bundle a browser module for injection, so the probe calls the SHIPPED code. */
async function bundle(rel, globalName) {
  const out = await esbuild.build({
    entryPoints: [new URL(`../src/browser/${rel}`, import.meta.url).pathname],
    bundle: true,
    format: 'iife',
    globalName,
    write: false,
    target: 'es2020',
    logLevel: 'silent',
  })
  return out.outputFiles[0].text
}

const PROBE = ({ limit }) => {
  const KEY_RE = /^__reactFiber\$/
  const fiberOf = (el) => {
    for (const k in el) if (KEY_RE.test(k)) return el[k]
    return null
  }
  const ownerName = (f) => f?.elementType?.name ?? f?.elementType?.displayName
    ?? f?.type?.name ?? f?.type?.displayName
    ?? f?.elementType?.render?.name ?? null

  const NON_VISUAL = new Set(['script', 'style', 'meta', 'link', 'title', 'head', 'base', 'noscript'])
  const PS = globalThis.PS   // preview-source, bundled
  const CD = globalThis.CD   // child-discriminator, bundled

  /** One CSS-ish step, mirroring how a person would describe an ancestor. */
  const step = (el) => {
    if (el.id) return `${el.localName}#${el.id}`
    const testId = el.getAttribute('data-testid')
    if (testId) return `${el.localName}[data-testid=${testId}]`
    const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0]
    return cls ? `${el.localName}.${cls}` : el.localName
  }

  const cases = []
  for (const el of document.querySelectorAll('[data-cortex-source]')) {
    if (cases.length >= limit) break
    const tag = el.tagName.toLowerCase()
    if (NON_VISUAL.has(tag)) continue
    if (el.closest('[data-cortex-host]')) continue
    // The SAME predicate `anchor-coverage.mjs` uses (:161, :167). Diverging
    // from it produced a corrupted published figure: a Next root layout
    // authors <html> and <body> in JSX, so the transform stamps them and both
    // have nonzero rects — two of six zerofog-web cases were those two
    // elements. `selection.ts` returns null for both, so neither can EVER
    // produce an agent-resolve gesture; scoring them measured a population the
    // product cannot reach.
    if (el === document.documentElement || el === document.body) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const cs = getComputedStyle(el)
    // `opacity: 0` keeps a nonzero box, so hidden tabs, mounted modals and
    // mid-transition trees pass a rect check and consume the --limit ahead of
    // elements a designer can actually see.
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue

    const truth = el.getAttribute('data-cortex-source')

    // ── Packet A — the REAL hint, produced by the shipped function ──
    //
    // `getAgentResolveTarget` is the agent-resolve entry point and returns the
    // hint `buildSourceResolutionHint` builds. Reading it here rather than
    // rebuilding it is what makes the baseline honest.
    //
    // It mints a `data-cortex-preview-id`, which is a DOM mutation — acceptable
    // on a throwaway measurement page, and it must run BEFORE the ancestor walk
    // below so the attribute cannot change what B observes.
    let packetA = null
    try { packetA = PS.getAgentResolveTarget(el).sourceResolutionHint } catch { packetA = null }

    // ── Packet B — what cortex computes and currently discards ──
    const names = []
    let owner = fiberOf(el)?._debugOwner
    const seenOwners = new Set()
    let guard = 0
    while (owner && guard++ < 200 && !seenOwners.has(owner)) {
      seenOwners.add(owner)
      const n = ownerName(owner)
      if (n) names.push(n)
      owner = owner._debugOwner
    }

    const ancestry = []
    let up = el.parentElement
    while (up && up !== document.body && ancestry.length < 6) {
      ancestry.unshift(step(up))
      up = up.parentElement
    }

    let discriminator = null
    try {
      if (CD && el.parentElement) {
        const keys = CD.childDiscriminators(el.parentElement)
        discriminator = keys[Array.prototype.indexOf.call(el.parentElement.children, el)] ?? null
      }
    } catch { discriminator = null }

    const parent = el.parentElement

    cases.push({
      truth,
      packetA,
      packetB: {
        ...packetA,
        ancestorChain: ancestry.join(' > ') || null,
        componentPath: names.reverse().join(' > ') || null,
        siblingDiscriminator: discriminator,
        siblingIndex: parent ? Array.prototype.indexOf.call(parent.children, el) : -1,
        siblingCount: parent ? parent.children.length : 0,
      },
    })
  }
  return cases
}

const { base, routes, out, limit, settleMs, label, verifyRoot, seed } = parseArgs(process.argv)
const [previewSrc, discSrc] = await Promise.all([
  bundle('preview-source.ts', 'PS'),
  bundle('child-discriminator.ts', 'CD'),
])

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const all = []
for (const route of routes) {
  await page.goto(new URL(route, base).toString(), { waitUntil: 'networkidle', timeout: 30_000 })
  await page.waitForTimeout(settleMs)
  await page.addScriptTag({ content: previewSrc })
  await page.addScriptTag({ content: discSrc })
  const cases = await page.evaluate(PROBE, { limit })
  for (const c of cases) all.push({ ...c, route, corpus: label })
}
await browser.close()

// A case with no Packet A is a harness failure, not a data point — the shipped
// hint builder threw. Drop it loudly rather than scoring an empty packet as a
// miss and blaming the evidence.
const withPacket = all.filter(c => c.packetA)
const droppedNoPacket = all.length - withPacket.length

// ── Ground truth must be VERIFIED, not assumed ───────────────────────────────
//
// Every case here is scored against a `data-cortex-source` the transform wrote.
// Annotation presence is not correctness: COR-28 was a regression where every
// anchor was 19 lines off, and this package ships `anchor-verify.ts` precisely
// because of it. An unverified oracle scores an agent WRONG for finding the
// RIGHT JSX — the experiment then drives a decision from invalid truth, which
// is worse than having no experiment.
//
// A stamp that cannot be verified is DROPPED and counted. `tag-only` is kept:
// it means the source tag agrees but nothing further discriminates, which is
// weak corroboration rather than evidence of a wrong stamp. Only
// `silently-wrong` — the anchor points at different JSX — disqualifies a case.
let usable = withPacket
let droppedUnverified = 0
let verdictCounts = null
if (verifyRoot) {
  const { verifyAnchor } = await loadVerifier()
  const read = makeReader(verifyRoot)
  const kept = []
  verdictCounts = {}
  for (const c of withPacket) {
    const r = await verifyAnchor(
      { source: c.truth, domTag: c.packetA.tagName, domClass: c.packetA.className || undefined },
      read,
    )
    verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1
    if (r.verdict === 'silently-wrong') { droppedUnverified++; continue }
    kept.push({ ...c, truthVerdict: r.verdict })
  }
  usable = kept
}

// Shuffled HERE so the file on disk is already safe to batch from.
const ordered = shuffled(usable, seed)
fs.writeFileSync(out, JSON.stringify({ seed, corpus: label, verified: !!verifyRoot, cases: ordered }, null, 2))

console.log(`${ordered.length} oracle cases (${label}) -> ${out}   [seed ${seed}]`)
if (droppedNoPacket) console.log(`  WARNING: ${droppedNoPacket} dropped — getAgentResolveTarget threw`)
if (verifyRoot) {
  console.log(`  ground truth VERIFIED: ${JSON.stringify(verdictCounts)}`)
  if (droppedUnverified) console.log(`  ${droppedUnverified} dropped as SILENTLY-WRONG stamps — not scored`)
} else {
  console.log('  ground truth UNVERIFIED — pass --verify-root <app> to check each stamp.')
  console.log('  Without it a stale or offset stamp scores a correct agent as wrong.')
}
console.log(`  ${ordered.filter(c => c.packetB.componentPath).length} carry a React component path`)
console.log(`  ${ordered.filter(c => c.packetB.siblingDiscriminator).length} carry a sibling discriminator`)

// NOTE for whoever builds the blind batches from this file: the packets contain
// an `id` field (the element's DOM id). Spreading a packet over a case-id key
// named `id` CLOBBERS the case id — the first run of this experiment shipped
// three batches keyed by `"verify"`/`"features"`/`"next-steps"` instead of case
// numbers. Use a non-colliding key such as `case_id`.
