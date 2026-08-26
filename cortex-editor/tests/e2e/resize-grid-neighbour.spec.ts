import { test, expect } from '@playwright/test'

/**
 * What a grid pin actually does to the neighbours — measured, in a real engine.
 *
 * This exists because `resize-pin.ts` once carried a comment asserting the
 * opposite ("leaves the TRACK alone"), and nothing in the suite could
 * contradict it: `resize-pin.test.ts` builds `ConstraintOwnership` objects by
 * hand and never lays anything out, and happy-dom has no grid algorithm at all.
 * A claim about layout needs a browser to be a claim about anything.
 */
test.describe('grid pin — the neighbour is not left alone', () => {
  test('pinning one item in `1fr 1fr` takes the space from its sibling', async ({ page }) => {
    await page.setContent(`
      <div id="g" style="display:grid;grid-template-columns:1fr 1fr;width:600px">
        <div id="a">A</div><div id="b">B</div>
      </div>`)

    const widths = () => page.evaluate(() => ({
      a: document.getElementById('a')!.getBoundingClientRect().width,
      b: document.getElementById('b')!.getBoundingClientRect().width,
    }))

    expect(await widths()).toEqual({ a: 300, b: 300 })

    // Exactly what `pinToFixed` emits for `target: 'grid-track'`.
    await page.evaluate(() => {
      const a = document.getElementById('a')!
      a.style.justifySelf = 'start'
      a.style.width = '500px'
    })

    // The pin lands — that is the feature working.
    // The sibling moves — that is the part the old comment denied.
    expect(await widths()).toEqual({ a: 500, b: 100 })
  })

  test('no declaration on the ITEM protects the sibling', async ({ page }) => {
    // The obvious "fixes", recorded because I guessed at both and both were
    // wrong. Neither `min-width: 0` nor `max-width` changes the outcome by a
    // single pixel: the automatic minimum that grows the track is the TRACK's,
    // not the item's, so the item has no say in it.
    await page.setContent(`
      <div id="g" style="display:grid;grid-template-columns:1fr 1fr;width:600px">
        <div id="a">A</div><div id="b">B</div>
      </div>`)

    for (const extra of [{ minWidth: '0' }, { maxWidth: '500px' }]) {
      const r = await page.evaluate((extra) => {
        const a = document.getElementById('a')!
        a.removeAttribute('style')
        Object.assign(a.style, extra)
        a.style.justifySelf = 'start'
        a.style.width = '500px'
        return {
          a: a.getBoundingClientRect().width,
          b: document.getElementById('b')!.getBoundingClientRect().width,
        }
      }, extra)
      expect(r, `with ${JSON.stringify(extra)}`).toEqual({ a: 500, b: 100 })
    }
  })

  test('the only lever is the track definition, and it costs an overflow', async ({ page }) => {
    // `minmax(0,1fr)` DOES hold the track at 300 — but it lives on the parent,
    // and the item then overlaps its sibling rather than displacing it. This is
    // why the pin does not try to protect the neighbour: the reachable outcome
    // is worse than the one it is avoiding.
    await page.setContent(`
      <div id="g" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);width:600px">
        <div id="a">A</div><div id="b">B</div>
      </div>`)
    const r = await page.evaluate(() => {
      const a = document.getElementById('a')!
      a.style.justifySelf = 'start'
      a.style.width = '500px'
      const ar = a.getBoundingClientRect(), br = document.getElementById('b')!.getBoundingClientRect()
      return { a: ar.width, b: br.width, overflows: ar.right > br.left }
    })
    expect(r).toEqual({ a: 500, b: 300, overflows: true })
  })
})
