/**
 * The reorder gesture end to end, driven by real Chromium pointer events
 * (COR-7, M1).
 *
 * Business purpose: this is the first time a user can actually drag something.
 * Everything below it is verified in isolation — the state machine as a pure
 * reducer, the drop geometry against real layout, the producer against the
 * server schema. What NONE of them can show is whether a real press-move-release
 * arrives as the events the reducer expects, in the order it expects, and
 * survives the pointer leaving the element it started on.
 *
 * happy-dom cannot answer that: it has no layout for the drop geometry, so a
 * unit test here would be a mock of the browser behaviour under test.
 */
import { test, expect, type Page } from '@playwright/test'
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'

interface Recorded {
  phases: string[]
  results: { ok: boolean; reason?: string; order?: number[]; childKeys?: string[] }[]
}

let BUNDLE = ''

test.beforeAll(async () => {
  const result = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../../src/browser/reorder-drag-listener.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'RD',
    write: false,
    target: 'es2020',
  })
  BUNDLE = result.outputFiles[0]!.text
})

const ROW = 'height:40px;width:200px;background:#eee;user-select:none'

const FIXTURE = `<!doctype html><body style="margin:0">
  <ul id="list" style="position:absolute;top:0;left:0;margin:0;padding:0;list-style:none;width:200px">
    <li data-cortex-source="src/List.tsx:9:5" style="${ROW}"><span id="nested">Alpha</span></li>
    <li data-cortex-source="src/List.tsx:9:5" style="${ROW}">Bravo</li>
    <li data-cortex-source="src/List.tsx:9:5" style="${ROW}">Charlie</li>
  </ul>
  <p id="prose" style="position:absolute;top:200px;left:0;width:300px">
    Some prose the user might select by dragging across it.</p>
</body>`

/** Install the listener and start recording what it reports. */
async function arm(page: Page, opts: { canDragProse?: boolean } = {}): Promise<void> {
  await page.evaluate(({ canDragProse }) => {
    const w = window as unknown as {
      RD: { installReorderDrag: (o: Record<string, unknown>) => { cleanup(): void } }
      __rec: Recorded
    }
    w.__rec = { phases: [], results: [] }
    w.RD.installReorderDrag({
      // Only list items, unless a test opts prose in. This is the predicate
      // that stops a text selection from becoming a reorder.
      // Returns the LIST ITEM, not the pressed node — `event.target` is the
      // innermost element, so pressing the span inside `<li><span>` must
      // reorder the li among its siblings, not the span among the li's.
      resolveDraggable: (el: Element) =>
        canDragProse ? (el.closest('#prose') ?? el.closest('#list > li')) : el.closest('#list > li'),
      isOwnUI: () => false,
      onStateChange: (s: { phase: string }) => { w.__rec.phases.push(s.phase) },
      onResult: (r: { ok: boolean; reason?: string; intent?: { structural: { order: number[]; childKeys: string[] } } }) => {
        w.__rec.results.push(r.ok
          ? { ok: true, order: r.intent!.structural.order, childKeys: r.intent!.structural.childKeys }
          : { ok: false, reason: r.reason })
      },
    })
  }, { canDragProse: opts.canDragProse ?? false })
}

const recorded = (page: Page): Promise<Recorded> =>
  page.evaluate(() => (window as unknown as { __rec: Recorded }).__rec)

test.beforeEach(async ({ page }) => {
  await page.setContent(FIXTURE)
  await page.addScriptTag({ content: BUNDLE })
  await arm(page)
})

test.describe('reorder gesture — real pointer events', () => {
  test('press, move past the last row, release -> a staged reorder', async ({ page }) => {
    // Row centres are y=20, 60, 100. Grab Alpha and drop below Charlie.
    await page.mouse.move(100, 20)
    await page.mouse.down()
    await page.mouse.move(100, 115, { steps: 5 })
    await page.mouse.up()

    const rec = await recorded(page)
    expect(rec.phases).toContain('pressed')
    expect(rec.phases).toContain('dragging')
    expect(rec.results).toHaveLength(1)
    expect(rec.results[0]!.ok).toBe(true)
    // Alpha moved to the end: positions 1 and 2 shift up, 0 lands last.
    expect(rec.results[0]!.order).toEqual([1, 2, 0])
    // And the intent names the rows, which is what makes the reorder verifiable
    // — all three share one data-cortex-source.
    expect(rec.results[0]!.childKeys).toEqual(['#li:Alpha', '#li:Bravo', '#li:Charlie'])
  })

  test('a CLICK stages nothing', async ({ page }) => {
    // The threshold's whole purpose. Without it, selecting a row by clicking it
    // would stage a source edit the user never asked for.
    await page.mouse.move(100, 20)
    await page.mouse.down()
    await page.mouse.up()

    const rec = await recorded(page)
    expect(rec.results).toHaveLength(0)
    expect(rec.phases).not.toContain('dragging')
  })

  test('a jitter below the threshold is still a click', async ({ page }) => {
    // Hand tremor and trackpad noise on a deliberate press.
    await page.mouse.move(100, 20)
    await page.mouse.down()
    await page.mouse.move(102, 21)
    await page.mouse.up()

    expect((await recorded(page)).results).toHaveLength(0)
  })

  test('Escape mid-drag abandons without staging', async ({ page }) => {
    // Escape must not be a coin flip on whether the user's source changes.
    await page.mouse.move(100, 20)
    await page.mouse.down()
    await page.mouse.move(100, 115, { steps: 5 })
    await page.keyboard.press('Escape')
    await page.mouse.up()

    const rec = await recorded(page)
    expect(rec.phases).toContain('dragging')
    expect(rec.results).toHaveLength(0)
  })

  test('the gesture survives the pointer leaving the row it started on', async ({ page }) => {
    // A reorder is BY DEFINITION a move away from where it started, so the
    // pointer leaves the pressed element immediately and the browser retargets
    // every later event to whatever is underneath.
    //
    // What carries the gesture is that the listeners are on the WINDOW in the
    // capture phase, not `setPointerCapture`. That is worth stating because the
    // obvious reasoning says the opposite: an earlier version called
    // `setPointerCapture` for exactly this case, and deleting it changed no
    // test — including this one. It was removed rather than kept as insurance,
    // since it brought a try/catch, a pointer id to track, and a stale-capture
    // mode that silently swallows later events.
    await page.mouse.move(100, 20)
    await page.mouse.down()
    // Off the list entirely, then back — mid-gesture, over the prose element.
    await page.mouse.move(280, 260, { steps: 4 })
    await page.mouse.move(100, 115, { steps: 4 })
    await page.mouse.up()

    const rec = await recorded(page)
    expect(rec.results).toHaveLength(1)
    expect(rec.results[0]!.ok).toBe(true)
  })

  test('dragging across prose does NOT begin a reorder', async ({ page }) => {
    // `canDrag` is the gate. Without it every pointerdown starts a press, and a
    // text selection — which travels far more than the 4px threshold — becomes
    // a reorder gesture.
    // The coordinates matter and the first version got them wrong: `<p>` has a
    // default 1em margin, and for an absolutely positioned box `top` places the
    // MARGIN edge — so the prose box starts at y=216 and a press at y=210 hit
    // `<html>`, which has no parent and is refused before `canDrag` is ever
    // consulted. The test passed with the gate deleted, which is to say it
    // proved nothing. Press on the text itself.
    const prose = await page.locator('#prose').boundingBox()
    const midY = prose!.y + prose!.height / 2
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id,
      [10, midY] as [number, number])).toBe('prose')

    await page.mouse.move(10, midY)
    await page.mouse.down()
    await page.mouse.move(280, midY + 5, { steps: 5 })
    await page.mouse.up()

    const rec = await recorded(page)
    expect(rec.phases).toHaveLength(0)
    expect(rec.results).toHaveLength(0)
  })

  test('a press on NESTED markup reorders the list item, not the span', async ({ page }) => {
    // `event.target` is the innermost element under the pointer. A boolean
    // predicate left the caller no way to say "the li, please": strict made
    // every nested item undraggable, permissive reordered the span among the
    // li's own children. `resolveDraggable` returns the ancestor.
    const span = (await page.locator('#nested').boundingBox())!
    await page.mouse.move(span.x + 5, span.y + span.height / 2)
    await page.mouse.down()
    await page.mouse.move(100, 115, { steps: 5 })
    await page.mouse.up()

    const rec = await recorded(page)
    expect(rec.results).toHaveLength(1)
    expect(rec.results[0]!.ok).toBe(true)
    // Three keys means the LIST was reordered. Reordering the span among its
    // own siblings would have produced a refusal (one child) instead.
    expect(rec.results[0]!.childKeys).toHaveLength(3)
  })

  test('the click after a completed drag is swallowed', async ({ page }) => {
    // The browser dispatches a separate `click` after `pointerup`. Suppressing
    // pointerup does nothing to it, so a completed reorder would still activate
    // a link or reach the app's click-to-select handler.
    await page.evaluate(() => {
      ;(window as unknown as { __clicks: number }).__clicks = 0
      window.addEventListener('click', () => { (window as unknown as { __clicks: number }).__clicks += 1 })
    })
    await page.mouse.move(100, 20)
    await page.mouse.down()
    await page.mouse.move(100, 115, { steps: 5 })
    await page.mouse.up()
    expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(0)
  })

  test('a plain click still reaches the page', async ({ page }) => {
    // The other half — swallowing must be one-shot and only after a real drag,
    // or selecting a row by clicking it stops working entirely.
    await page.evaluate(() => {
      ;(window as unknown as { __clicks: number }).__clicks = 0
      window.addEventListener('click', () => { (window as unknown as { __clicks: number }).__clicks += 1 })
    })
    await page.mouse.move(100, 20)
    await page.mouse.down()
    await page.mouse.up()
    expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(1)
  })

  test('a second touch cannot drive the first touch\'s drag', async ({ page }) => {
    // Without tracking the initiating pointer id, every pointer's events drive
    // the one shared state: a second finger can cross the first's threshold,
    // pick a slot, and complete the reorder when IT lifts.
    await page.evaluate(() => {
      const li = document.querySelector('#list > li')!
      const opts = { bubbles: true, cancelable: true, clientX: 100, clientY: 20 }
      li.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, button: 0 }))
      // A DIFFERENT pointer travels far and releases.
      window.dispatchEvent(new PointerEvent('pointermove', { ...opts, pointerId: 99, clientY: 115 }))
      window.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 99, clientY: 115 }))
    })
    const rec = await recorded(page)
    expect(rec.results).toHaveLength(0)
    expect(rec.phases).not.toContain('dragging')
  })

  test('a right-click never starts a drag', async ({ page }) => {
    await page.mouse.move(100, 20)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(100, 115, { steps: 5 })
    await page.mouse.up({ button: 'right' })

    expect((await recorded(page)).phases).toHaveLength(0)
  })

  test('cleanup detaches every listener', async ({ page }) => {
    // A handle left attached after the panel unmounts keeps staging intents
    // from a session that is over.
    await page.evaluate(() => {
      const w = window as unknown as {
        RD: { installReorderDrag: (o: Record<string, unknown>) => { cleanup(): void } }
        __rec: Recorded
        __h: { cleanup(): void }
      }
      w.__rec = { phases: [], results: [] }
      w.__h = w.RD.installReorderDrag({
        resolveDraggable: (el: Element) => el.closest('#list > li'),
        isOwnUI: () => false,
        onStateChange: (s: { phase: string }) => { w.__rec.phases.push(s.phase) },
        onResult: () => { w.__rec.results.push({ ok: true }) },
      })
      w.__h.cleanup()
    })

    await page.mouse.move(100, 20)
    await page.mouse.down()
    await page.mouse.move(100, 115, { steps: 5 })
    await page.mouse.up()

    // The beforeEach handle is still attached and will record; the cleaned-up
    // one must contribute nothing. Recording into the SAME array is what makes
    // this falsifiable — a detached handle that still fired would double every
    // entry.
    const rec = await recorded(page)
    expect(rec.results).toHaveLength(1)
  })
})
