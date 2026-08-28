import { test, expect } from '@playwright/test'
import { bootWithSendSpy, selectElement } from './helpers/panel.js'
import { handleCentre } from './helpers/resize-handle.js'

/**
 * Fan-out is the default the moment a shared class exists, so dragging one
 * card's edge writes to every sibling that shares it. The drag measured ONE
 * element's constraint owner. Where a sibling's differs — the same class reused
 * in a different container — that sibling gets a declaration that lands in its
 * source and does not move it.
 *
 * The product decision is to write anyway and say so, not to refuse: fan-out is
 * deliberate, and a drag that does nothing is the failure this surface exists
 * to prevent. This proves the "say so" half actually happens, which is the half
 * a user would never notice missing.
 */
test.describe('resize fan-out across mixed layouts', () => {
  test('warns, with counts, when siblings are laid out differently', async ({ page }) => {
    await bootWithSendSpy(page)

    // Same class, two DIFFERENT containers: a plain block and a stretched flex
    // child. `pinToFixed` writes `width` alone for the first and
    // `flex: none` + `width` for the second, so one measurement cannot
    // describe both.
    //
    // DIFFERENT `data-cortex-source` values, which is the realistic shape and
    // also load-bearing for this test: two elements sharing a source are the
    // same JSX site rendered twice, and the panel treats them as one multi
    // selection — which hides the handles entirely (that gate is deliberate).
    // Class reuse across containers means two separate call sites.
    await page.evaluate(() => {
      const host = document.createElement('div')
      // `data-cortex-css` is what drives fan-out — NOT the className. It maps an
      // element to `<css-module-path>:<selectors>`, and `detectSharedClasses`
      // groups every annotated element sharing a file+selector pair. Two
      // elements with the same `class` and no annotation are not a group, which
      // cost a round of debugging here.
      const CSS = 'src/Card.module.css:.fanCard'
      host.innerHTML = `
        <div id="plainWrap" style="display:block;width:600px">
          <div class="fanCard" data-cortex-source="App.tsx:10:3" data-cortex-css="${CSS}"
               style="height:60px;background:#eee"></div>
        </div>
        <div id="flexWrap" style="display:flex;width:600px">
          <div class="fanCard" data-cortex-source="App.tsx:24:5" data-cortex-css="${CSS}"
               style="flex:1 1 auto;height:60px;background:#ddd"></div>
        </div>`
      document.body.appendChild(host)
    })

    await selectElement(page, '#plainWrap .fanCard')
    const knob = await handleCentre(page, 'right', '#plainWrap .fanCard')

    await page.mouse.move(knob.x, knob.y)
    await page.mouse.down()
    await page.mouse.move(knob.x - 120, knob.y, { steps: 6 })
    await page.mouse.up()

    const banner = async () => await page.evaluate(() => {
      const root = (document.querySelector('[data-cortex-host]') as any)?.shadowRoot
      const n = root?.querySelector('.cortex-resize-refusal')
      return n ? n.textContent : null
    })

    // The banner must name BOTH numbers — how many were written, and how many
    // of those are suspect. A bare "some may not move" is not actionable.
    await expect.poll(banner).toMatch(/Resized 2 elements/)
    expect(await banner()).toMatch(/One of them is laid out differently/)
    // And it must point at the escape hatch, which is the only thing the user
    // can actually do about it.
    expect(await banner()).toMatch(/single element/)
  })
})
