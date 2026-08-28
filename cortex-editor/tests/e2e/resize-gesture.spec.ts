/**
 * The resize gesture end to end, driven by real Chromium pointer events.
 *
 * Business purpose: the second gesture a designer can perform. COR-3 built the
 * engine that answers "which property actually controls this size" and shipped
 * it with 33 tests and ZERO production consumers — a finished engine with no
 * ignition. This is the ignition.
 *
 * Why e2e and not happy-dom: `measureConstraintOwner` PROBES real layout (it
 * writes an inline !important size, reads where the edge went, reverts), and
 * happy-dom does not lay out. A unit test would assert against a stub of the
 * thing under test — exactly how the predicted `edgeResponse` resolver passed
 * its own tests while being wrong about CSS in five separate ways.
 */
import { test, expect, type Page } from '@playwright/test'
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'

interface Recorded {
  phases: string[]
  results: { ok: boolean; reason?: string; writes?: { property: string; value: string }[] }[]
}

let BUNDLE = ''

test.beforeAll(async () => {
  const result = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../../src/browser/resize-drag-listener.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'RS', write: false, target: 'es2020',
  })
  BUNDLE = result.outputFiles[0]!.text
})

/**
 * Handles are rendered by cortex INSIDE its shadow host in production. Here they
 * are plain elements carrying the same attribute, because what is under test is
 * the gesture, not Preact's rendering — and a real shadow host would need the
 * whole editor booted, which `panel-*.spec.ts` already covers.
 */
const FIXTURE = `<!doctype html><body style="margin:0">
  <div id="box" style="position:absolute;top:50px;left:50px;width:200px;height:100px;background:#ddd"></div>

  <!-- A flex child that STRETCHES: width alone will not move it, so pinning has
       to neutralise the parent's control first. -->
  <div id="flexrow" style="position:absolute;top:200px;left:0;display:flex;width:600px">
    <div id="flexchild" style="flex:1;height:60px;background:#cde"></div>
    <div style="flex:1;height:60px;background:#edc"></div></div>

  <!-- A PADDED, bordered, content-box element. The case that exposed the box
       model bug: its bounding rect is 250 (200 content + 40 padding + 10
       border) while a width declaration sets only the content area, so the rect
       and writing it back grew a 60px drag into 110px of movement. -->
  <div id="padded" style="position:absolute;top:320px;left:0;width:200px;padding:20px;border:5px solid;background:#dfd"></div>

  <!-- Handles, positioned over each target's right edge. -->
  <div id="h-box" data-cortex-resize-edge="right"
       style="position:absolute;top:95px;left:246px;width:9px;height:9px;background:#00f"></div>
  <div id="h-flex" data-cortex-resize-edge="right"
       style="position:absolute;top:225px;left:296px;width:9px;height:9px;background:#00f"></div>
  <div id="h-padded" data-cortex-resize-edge="right"
       style="position:absolute;top:355px;left:246px;width:9px;height:9px;background:#00f"></div>
</body>`

async function arm(page: Page, targetId: string): Promise<void> {
  await page.evaluate(({ id }) => {
    const w = window as unknown as {
      RS: { installResizeDrag: (o: Record<string, unknown>) => { cleanup(): void } }
      __rec: Recorded
      __h?: { cleanup(): void }
    }
    w.__h?.cleanup()
    w.__rec = { phases: [], results: [] }
    w.__h = w.RS.installResizeDrag({
      getTarget: () => document.getElementById(id),
      // In production this is cortex's real `isOwnUI`, and handles live inside
      // the shadow host so it returns true for them. Here the handles are light
      // DOM, so the stub reports "is own UI" for anything carrying the attribute
      // — the same partition, reachable without booting the editor.
      isOwnUI: (e: Event) => {
        const t = e.target
        return t instanceof Element && t.closest('[data-cortex-resize-edge]') !== null
      },
      onStateChange: (s: { phase: string }) => { w.__rec.phases.push(s.phase) },
      onResult: (r: { ok: boolean; reason?: string; writes?: unknown }) => {
        w.__rec.results.push(r as Recorded['results'][number])
      },
    })
  }, { id: targetId })
}

const recorded = (page: Page): Promise<Recorded> =>
  page.evaluate(() => (window as unknown as { __rec: Recorded }).__rec)

async function dragHandle(page: Page, handleId: string, dx: number): Promise<void> {
  const h = (await page.locator(`#${handleId}`).boundingBox())!
  const x = h.x + h.width / 2, y = h.y + h.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 6 })
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.setContent(FIXTURE)
  await page.addScriptTag({ content: BUNDLE })
})

test.describe('resize gesture — real pointer events', () => {
  test('dragging the right edge writes the new width', async ({ page }) => {
    await arm(page, 'box')
    await dragHandle(page, 'h-box', 60)

    const rec = await recorded(page)
    expect(rec.phases).toContain('dragging')
    expect(rec.results).toHaveLength(1)
    expect(rec.results[0]!.ok).toBe(true)
    // 200 + 60. Asserting the VALUE, not just that something was written —
    // a gesture that writes the wrong number still "works" by any weaker check.
    expect(rec.results[0]!.writes).toEqual([{ property: 'width', value: '260px' }])
  })

  test('a PADDED element grows by exactly what the user dragged', async ({ page }) => {
    // The bug this pins, found in architecture review and reproduced in a real
    // browser before fixing: `getBoundingClientRect().width` is the BORDER box
    // (250 here), while a `width:` declaration under the default `content-box`
    // sets only the CONTENT area (200). Measuring the rect and writing it back
    // re-adds the 50px of padding and border, so a 60px drag moved the edge
    // 110px — a confidently wrong number, no error anywhere.
    //
    // `constraint-owner.ts` had already been burned by this exact mix and says
    // so in a comment; measuring independently one layer up reintroduced it.
    await arm(page, 'padded')
    await dragHandle(page, 'h-padded', 60)

    const rec = await recorded(page)
    expect(rec.results).toHaveLength(1)
    expect(rec.results[0]!.ok).toBe(true)
    // 200 (authored content width) + 60, NOT 250 + 60.
    expect(rec.results[0]!.writes).toEqual([{ property: 'width', value: '260px' }])
  })

  test('a CLICK on a handle writes nothing', async ({ page }) => {
    // Without a threshold, tapping a handle stages a zero-delta edit — the user
    // touches the corner and gets a pending change they never asked for.
    await arm(page, 'box')
    const h = (await page.locator('#h-box').boundingBox())!
    await page.mouse.move(h.x + 4, h.y + 4)
    await page.mouse.down()
    await page.mouse.up()

    const rec = await recorded(page)
    expect(rec.results).toHaveLength(0)
    expect(rec.phases).not.toContain('dragging')
  })

  test('PINS a stretched flex child — the product rule', async ({ page }) => {
    // The element was filling half the row. `width` alone would land in source
    // and change nothing on screen, because flex-grow still decides. This is
    // the case the whole constraint-owner engine was written to detect.
    await arm(page, 'flexchild')
    await dragHandle(page, 'h-flex', 50)

    const rec = await recorded(page)
    expect(rec.results).toHaveLength(1)
    expect(rec.results[0]!.ok).toBe(true)
    const props = rec.results[0]!.writes!.map(w => w.property)
    expect(props).toEqual(['flex', 'width'])
    // Order is load-bearing for a reader of the diff: "stop filling, then be
    // this wide" is the gesture in the order the user performed it.
    expect(rec.results[0]!.writes![0]).toEqual({ property: 'flex', value: 'none' })
  })

  test('Escape mid-drag abandons without writing', async ({ page }) => {
    await arm(page, 'box')
    const h = (await page.locator('#h-box').boundingBox())!
    await page.mouse.move(h.x + 4, h.y + 4)
    await page.mouse.down()
    await page.mouse.move(h.x + 80, h.y + 4, { steps: 5 })
    await page.keyboard.press('Escape')
    await page.mouse.up()

    const rec = await recorded(page)
    expect(rec.phases).toContain('dragging')
    expect(rec.results).toHaveLength(0)
  })

  // NOT COVERED, and stated rather than implied: a press on cortex chrome that
  // is not a handle. The `closest([data-cortex-resize-edge])` lookup is what
  // declines it, and I could not build a falsifiable e2e for it — three
  // attempts (state phases, staged results, probe-count via MutationObserver)
  // all passed with BOTH handle guards deleted, because the press begins on an
  // element that is not the resize target and the gesture produces no
  // observable effect either way.
  //
  // Rather than keep reshaping the assertion until it goes green — which is how
  // a test ends up asserting the harness instead of the code — this is recorded
  // as a gap. In production the risk is real: cortex chrome is the whole panel,
  // so without the lookup a click on a panel button would begin a resize. The
  // unit-level guard is exercised by `resize-drag.test.ts`; what is missing is
  // the end-to-end proof.

  test('a press on the PAGE does not start a resize', async ({ page }) => {
    // The inverted isOwnUI: this gesture accepts ONLY its own handles. Without
    // that, dragging anywhere on the page would resize the selection.
    await arm(page, 'box')
    await page.mouse.move(300, 100)
    await page.mouse.down()
    await page.mouse.move(400, 100, { steps: 5 })
    await page.mouse.up()

    expect((await recorded(page)).phases).toHaveLength(0)
  })

  test('a right-click on a handle never starts a resize', async ({ page }) => {
    await arm(page, 'box')
    const h = (await page.locator('#h-box').boundingBox())!
    await page.mouse.move(h.x + 4, h.y + 4)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(h.x + 80, h.y + 4, { steps: 5 })
    await page.mouse.up({ button: 'right' })

    expect((await recorded(page)).phases).toHaveLength(0)
  })

  test('cleanup detaches every listener', async ({ page }) => {
    await arm(page, 'box')
    await page.evaluate(() => (window as unknown as { __h: { cleanup(): void } }).__h.cleanup())
    await dragHandle(page, 'h-box', 60)
    expect((await recorded(page)).results).toHaveLength(0)
  })
})
