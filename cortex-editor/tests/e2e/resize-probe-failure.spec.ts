import { test, expect } from '@playwright/test'
import { bootWithSendSpy, selectElement } from './helpers/panel.js'

/**
 * When the capability probe throws for EVERY edge, no handle renders — so the
 * press that would have surfaced `installResizeDrag`'s `onProbeError` can never
 * happen. The event path was hardened to explain exactly this failure and the
 * explanation was unreachable through the UI.
 *
 * The render path has to report it instead, which means telling a thrown probe
 * apart from an inert edge rather than collapsing both to `false`.
 */
test.describe('resize capability probe failure', () => {
  test('says why there are no handles, instead of showing none silently', async ({ page }) => {
    await bootWithSendSpy(page)
    await page.evaluate(() => {
      const el = document.createElement('div')
      el.id = 'poisoned'
      el.setAttribute('data-cortex-source', 'App.tsx:44:3')
      el.style.cssText = 'width:200px;height:60px;background:#eee'
      document.body.appendChild(el)
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => { throw new TypeError('page redefined this') },
      })
    })
    await selectElement(page, '#poisoned')

    const state = async () => await page.evaluate(() => {
      const root = (document.querySelector('[data-cortex-host]') as any)?.shadowRoot
      return {
        handles: root?.querySelectorAll('[data-cortex-resize-edge]').length ?? -1,
        banner: root?.querySelector('.cortex-resize-readout--error')?.textContent ?? null,
      }
    })

    // Both halves matter. No handles is correct — none of them could act.
    // A silent absence is what this fixes.
    await expect.poll(async () => (await state()).banner).toMatch(/could not measure/)
    expect((await state()).handles).toBe(0)
  })

  test('a PARTIAL failure keeps the working handles and stays quiet', async ({ page }) => {
    // The report must be narrow: a banner over a working affordance is worse
    // than no banner. Proving that needs a page where SOME edges throw and
    // others do not, which the all-or-nothing fixture above cannot show —
    // without this, dropping the `handles.length === 0` condition passes.
    //
    // `offsetWidth` is read only on the inline axis (`constraint-owner.ts`), so
    // poisoning it breaks left/right while top/bottom measure normally.
    await bootWithSendSpy(page)
    await page.evaluate(() => {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'display:block;width:600px'
      const el = document.createElement('div')
      el.id = 'halfPoisoned'
      el.setAttribute('data-cortex-source', 'App.tsx:55:3')
      el.style.cssText = 'width:200px;height:60px;background:#eee'
      wrap.appendChild(el)
      document.body.appendChild(wrap)
      Object.defineProperty(el, 'offsetWidth', {
        get() { throw new TypeError('page redefined this') },
      })
    })
    await selectElement(page, '#halfPoisoned')

    const r0 = await page.evaluate(() => {
      const root = (document.querySelector('[data-cortex-host]') as any)?.shadowRoot
      return {
        handles: root?.querySelectorAll('[data-cortex-resize-edge]').length ?? -1,
        banner: root?.querySelector('.cortex-resize-readout--error')?.textContent ?? null,
      }
    })
    // Some handles survived, so there is nothing to announce.
    expect(r0.handles).toBeGreaterThan(0)
    expect(r0.banner).toBeNull()
  })

  test('an ordinary element gets its handles and no error', async ({ page }) => {
    await bootWithSendSpy(page)
    await selectElement(page, '#center')
    const r = await page.evaluate(() => {
      const root = (document.querySelector('[data-cortex-host]') as any)?.shadowRoot
      return {
        handles: root?.querySelectorAll('[data-cortex-resize-edge]').length ?? -1,
        banner: root?.querySelector('.cortex-resize-readout--error')?.textContent ?? null,
      }
    })
    expect(r.handles).toBe(4)
    expect(r.banner).toBeNull()
  })
})
