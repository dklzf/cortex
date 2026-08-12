import { makeSizingDimension } from '../../../src/browser/sizing-value.js'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from 'preact'
import { SizingControls } from '../../../src/browser/components/sections/SizingControls.js'
import type { SizingControlsProps } from '../../../src/browser/components/sections/SizingControls.js'

vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 0, y: 30 }),
  flip: vi.fn().mockReturnValue({}),
  shift: vi.fn().mockReturnValue({}),
}))

describe('SizingControls', () => {
  let container: HTMLDivElement

  afterEach(() => {
    if (container) {
      render(null, container)
      container.remove()
    }
  })

  const DEFAULT_VALUES: SizingControlsProps['values'] = {
    // Units are load-bearing. getComputedStyle().width always returns a unit
    // ("320px"), and computedStyleMap() stringifies to one, so a bare `320`
    // cannot reach this component. It only ever passed because the old
    // deriveSizingMode fell through to 'fixed' for anything unrecognised.
    // COR-6: one structured value per axis. Constructed through the real
    // helper rather than hand-built, so a test fixture cannot express a
    // shape the producer never emits — which is how the authored/used pair
    // drifted apart in the first place.
    width: makeSizingDimension('320px', '320px'),
    height: makeSizingDimension('48px', '48px'),
    minWidth: '0px',
    maxWidth: 'none',
    minHeight: '0px',
    maxHeight: 'none',
    overflow: 'visible',
    boxSizing: 'content-box',
  }

  function setup(overrides?: Partial<SizingControlsProps>) {
    container = document.createElement('div')
    document.body.appendChild(container)
    const onChange = vi.fn()
    render(
      <SizingControls
        values={DEFAULT_VALUES}
        onChange={onChange}
        {...overrides}
      />,
      container,
    )
    return { onChange }
  }

  it('renders W and H inputs', () => {
    setup()
    expect(container.textContent).toContain('W')
    expect(container.textContent).toContain('H')
  })

  it('renders two sizing dropdown triggers', () => {
    setup()
    const triggers = container.querySelectorAll('.cortex-sizing-trigger')
    expect(triggers.length).toBe(2)
  })

  it('emits width change with px suffix', () => {
    const { onChange } = setup()
    const inputs = container.querySelectorAll('.cortex-numeric-input input')
    const widthInput = inputs[0] as HTMLInputElement
    expect(widthInput).toBeDefined()
    widthInput.focus()
    widthInput.value = '400'
    widthInput.dispatchEvent(new Event('input', { bubbles: true }))
    widthInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const widthCall = onChange.mock.calls.find((c: any) => c[0]?.property === 'width')
    expect(widthCall).toBeDefined()
    expect(widthCall![0].value).toBe('400px')
  })

  it('emits fit-content when width mode changed to fit', async () => {
    const { onChange } = setup()
    const triggers = container.querySelectorAll('.cortex-sizing-trigger')
    ;(triggers[0] as HTMLElement).click()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-value="fit"]')).not.toBeNull()
    }, { timeout: 500 })
    const fitOption = container.querySelector('[data-value="fit"]') as HTMLElement
    fitOption.click()
    expect(onChange).toHaveBeenCalledWith({ property: 'width', value: 'fit-content' })
  })

  it('emits 100% when width mode changed to fill', async () => {
    const { onChange } = setup()
    const triggers = container.querySelectorAll('.cortex-sizing-trigger')
    ;(triggers[0] as HTMLElement).click()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-value="fill"]')).not.toBeNull()
    }, { timeout: 500 })
    const fillOption = container.querySelector('[data-value="fill"]') as HTMLElement
    fillOption.click()
    expect(onChange).toHaveBeenCalledWith({ property: 'width', value: '100%' })
  })

  it.each([
    ['width', 'fit-content', 0],
    ['width', '100%', 0],
    ['height', 'fit-content', 1],
    ['height', '100%', 1],
  ] as const)('disables %s input when sizing mode is non-fixed (%s)', (dimension, value, fieldIndex) => {
    setup({
      values: {
        ...DEFAULT_VALUES,
        [dimension]: value,
      },
    })
    const fields = container.querySelectorAll('.cortex-layout-section__sizing-field')
    const field = fields[fieldIndex] as HTMLElement
    const input = field.querySelector('input') as HTMLInputElement
    const numeric = field.querySelector('.cortex-numeric-input') as HTMLElement
    expect(input.disabled).toBe(true)
    expect(numeric.getAttribute('aria-disabled')).toBe('true')
    expect(numeric.getAttribute('data-tooltip')).toBe('Switch to Fixed (px) to edit dimensions')
  })

  it('clip content toggle fires overflow:hidden / overflow:visible', () => {
    const { onChange } = setup()
    const clipBtn = container.querySelector('[data-tooltip="Clip content (overflow: hidden)"]') as HTMLElement
    expect(clipBtn).not.toBeNull()
    // Initially visible — click to clip
    clipBtn.click()
    expect(onChange).toHaveBeenCalledWith({ property: 'overflow', value: 'hidden' })

    // Now render with overflow: hidden and click again
    onChange.mockClear()
    render(null, container)
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    render(
      <SizingControls
        values={{ ...DEFAULT_VALUES, overflow: 'hidden' }}
        onChange={onChange}
      />,
      container,
    )
    const clipBtn2 = container.querySelector('[data-tooltip="Clip content (overflow: hidden)"]') as HTMLElement
    clipBtn2.click()
    expect(onChange).toHaveBeenCalledWith({ property: 'overflow', value: 'visible' })
  })

  it('border box toggle fires box-sizing:border-box / box-sizing:content-box', () => {
    const { onChange } = setup()
    const boxBtn = container.querySelector('[data-tooltip="Border box sizing"]') as HTMLElement
    expect(boxBtn).not.toBeNull()
    // Initially content-box — click for border-box
    boxBtn.click()
    expect(onChange).toHaveBeenCalledWith({ property: 'box-sizing', value: 'border-box' })

    // Now render with border-box and click again
    onChange.mockClear()
    render(null, container)
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    render(
      <SizingControls
        values={{ ...DEFAULT_VALUES, boxSizing: 'border-box' }}
        onChange={onChange}
      />,
      container,
    )
    const boxBtn2 = container.querySelector('[data-tooltip="Border box sizing"]') as HTMLElement
    boxBtn2.click()
    expect(onChange).toHaveBeenCalledWith({ property: 'box-sizing', value: 'content-box' })
  })

  it('aspect lock: changing W fires proportional H change', async () => {
    const { onChange } = setup({ values: { ...DEFAULT_VALUES, width: makeSizingDimension('200px', '200px'), height: makeSizingDimension('100px', '100px') } })
    // Lock aspect
    const lockBtn = container.querySelector('.cortex-lock-btn') as HTMLElement
    expect(lockBtn).not.toBeNull()
    lockBtn.click()
    await vi.waitFor(() => {
      expect(lockBtn.getAttribute('aria-pressed')).toBe('true')
    }, { timeout: 500 })
    // Now change width — need to re-query since the component re-rendered
    const inputs = container.querySelectorAll('.cortex-numeric-input input')
    const widthInput = inputs[0] as HTMLInputElement
    widthInput.focus()
    widthInput.value = '400'
    widthInput.dispatchEvent(new Event('input', { bubbles: true }))
    widthInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const widthCall = onChange.mock.calls.find((c: any) => c[0]?.property === 'width' && c[0]?.value === '400px')
    expect(widthCall).toBeDefined()
    const heightCall = onChange.mock.calls.find((c: any) => c[0]?.property === 'height' && c[0]?.value === '200px')
    expect(heightCall).toBeDefined()
  })

  it('aspect lock is disabled with an explanation when either dimension is non-fixed', async () => {
    setup({ values: { ...DEFAULT_VALUES, width: makeSizingDimension('fit-content', 'fit-content'), height: makeSizingDimension('100px', '100px') } })
    let lockBtn = container.querySelector('.cortex-lock-btn') as HTMLButtonElement
    expect(lockBtn).not.toBeNull()
    expect(lockBtn.classList.contains('cortex-lock-btn--disabled')).toBe(true)
    expect(lockBtn.getAttribute('aria-disabled')).toBe('true')
    expect(lockBtn.getAttribute('aria-pressed')).toBe('false')
    expect(lockBtn.getAttribute('data-tooltip')).toBe('Aspect lock requires fixed dimensions')

    lockBtn.click()
    await vi.waitFor(() => {
      lockBtn = container.querySelector('.cortex-lock-btn') as HTMLButtonElement
      expect(lockBtn.getAttribute('aria-pressed')).toBe('false')
    }, { timeout: 500 })
  })

  it('aspect lock active styling drops immediately when dimensions become non-fixed', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const onChange = vi.fn()
    render(
      <SizingControls
        values={{ ...DEFAULT_VALUES, width: makeSizingDimension('200px', '200px'), height: makeSizingDimension('100px', '100px') }}
        onChange={onChange}
      />,
      container,
    )

    let lockBtn = container.querySelector('.cortex-lock-btn') as HTMLButtonElement
    lockBtn.click()
    await vi.waitFor(() => {
      lockBtn = container.querySelector('.cortex-lock-btn') as HTMLButtonElement
      expect(lockBtn.getAttribute('aria-pressed')).toBe('true')
    }, { timeout: 500 })

    render(
      <SizingControls
        values={{ ...DEFAULT_VALUES, width: makeSizingDimension('fit-content', 'fit-content'), height: makeSizingDimension('100px', '100px') }}
        onChange={onChange}
      />,
      container,
    )

    lockBtn = container.querySelector('.cortex-lock-btn') as HTMLButtonElement
    expect(lockBtn.classList.contains('cortex-lock-btn--active')).toBe(false)
    expect(lockBtn.classList.contains('cortex-lock-btn--disabled')).toBe(true)
    expect(lockBtn.getAttribute('aria-pressed')).toBe('false')
    expect(lockBtn.getAttribute('aria-disabled')).toBe('true')
    expect(lockBtn.getAttribute('data-tooltip')).toBe('Aspect lock requires fixed dimensions')
  })

  it('min-width toggle shows min input and fires property', async () => {
    const { onChange } = setup()
    const triggers = container.querySelectorAll('.cortex-sizing-trigger')
    ;(triggers[0] as HTMLElement).click()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-action="toggle-min"]')).not.toBeNull()
    }, { timeout: 500 })
    const minToggle = container.querySelector('[data-action="toggle-min"]') as HTMLElement
    minToggle.click()
    // Should fire onChange to set min-width to a nonzero value
    expect(onChange).toHaveBeenCalledWith({ property: 'min-width', value: '1px' })
  })

  it('max-width toggle shows max input and fires property', async () => {
    const { onChange } = setup()
    const triggers = container.querySelectorAll('.cortex-sizing-trigger')
    ;(triggers[0] as HTMLElement).click()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-action="toggle-max"]')).not.toBeNull()
    }, { timeout: 500 })
    const maxToggle = container.querySelector('[data-action="toggle-max"]') as HTMLElement
    maxToggle.click()
    expect(onChange).toHaveBeenCalledWith({ property: 'max-width', value: '9999px' })
  })

  // ── REGRESSION TEST: stale widthMode/heightMode ─────────────────
  it('dropdown shows "fill" when values.width=100%, updates to "fixed" on re-render (stale-state fix)', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const onChange = vi.fn()

    // First render with width=100%
    render(
      <SizingControls
        values={{ ...DEFAULT_VALUES, width: makeSizingDimension('100%', '100%') }}
        onChange={onChange}
      />,
      container,
    )
    const triggers1 = container.querySelectorAll('.cortex-sizing-trigger__label')
    expect(triggers1[0]?.textContent).toBe('fill')

    // Re-render with width=320px — dropdown must update to "px" (fixed)
    render(
      <SizingControls
        values={{ ...DEFAULT_VALUES, width: makeSizingDimension('320px', '320px') }}
        onChange={onChange}
      />,
      container,
    )
    const triggers2 = container.querySelectorAll('.cortex-sizing-trigger__label')
    expect(triggers2[0]?.textContent).toBe('px')
  })

  // ── REGRESSION TEST: stale min/max ──────────────────────────────
  it('min-width input visible when values.minWidth is nonzero without toggling', () => {
    setup({ values: { ...DEFAULT_VALUES, minWidth: '100px' } })
    // The min-width input should be rendered because the value is > 0
    expect(container.textContent).toContain('Min')
    const minInput = container.querySelector('[data-tooltip="Min Width"]')
    expect(minInput).not.toBeNull()
  })

  it('max-width input visible when values.maxWidth is not "none" without toggling', () => {
    setup({ values: { ...DEFAULT_VALUES, maxWidth: '500px' } })
    expect(container.textContent).toContain('Max')
    const maxInput = container.querySelector('[data-tooltip="Max Width"]')
    expect(maxInput).not.toBeNull()
  })

  it('renders min/max dismiss affordance with the same Lucide icon size as the lock control', () => {
    setup({ values: { ...DEFAULT_VALUES, maxWidth: '500px' } })
    const dismiss = container.querySelector('[aria-label="Remove Max Width"]') as HTMLButtonElement
    const icon = dismiss.querySelector('svg')
    expect(dismiss.classList.contains('cortex-layout-section__minmax-dismiss')).toBe(true)
    expect(icon?.getAttribute('width')).toBe('14')
    expect(icon?.getAttribute('height')).toBe('14')
  })

  // B5: this previously asserted `auto` renders as "px" (Fixed) — the bug,
  // encoded as intended behaviour. `auto` means the browser decides; calling it
  // Fixed told the user a pixel width was authored when none was, and left the
  // px input enabled so editing it silently introduced one.
  it('reports auto as "auto" and disables the pixel input', () => {
    setup({ values: { ...DEFAULT_VALUES, width: makeSizingDimension('auto', 'auto') } })
    const modeLabels = container.querySelectorAll('.cortex-sizing-trigger__label')
    expect(modeLabels[0]?.textContent).toBe('auto')
    const widthInput = container.querySelector('.cortex-numeric-input input') as HTMLInputElement
    expect(widthInput.disabled).toBe(true)
  })

  it('reports an author-written 100% as fill — the headline B5 case', () => {
    // Before B5 this read as Fixed, because getComputedStyle resolved it to a
    // pixel count before the panel ever saw it.
    setup({ values: { ...DEFAULT_VALUES, width: makeSizingDimension('100%', '100%') } })
    const modeLabels = container.querySelectorAll('.cortex-sizing-trigger__label')
    expect(modeLabels[0]?.textContent).toBe('fill')
  })

  it('reports a percentage that is not 100% as custom, never as a pixel count', () => {
    // parseFloat('50%') === 50, so the pre-B5 path rendered "50 px" for an
    // element that is half its parent's width.
    setup({ values: { ...DEFAULT_VALUES, width: makeSizingDimension('50%', '50%') } })
    const modeLabels = container.querySelectorAll('.cortex-sizing-trigger__label')
    expect(modeLabels[0]?.textContent).toBe('custom')
    const widthInput = container.querySelector('.cortex-numeric-input input') as HTMLInputElement
    expect(widthInput.disabled).toBe(true)
  })

  // ── B5 follow-up: the authored value gives the MODE, not the MEASUREMENT ──
  // Deriving the mode correctly is only half the job. `100%` and `fit-content`
  // are not numbers, so the panel still needs the used pixel size — otherwise
  // it fabricates one.

  it('shows the element\'s rendered width for a fill element, not 0', () => {
    setup({ values: { ...DEFAULT_VALUES, width: makeSizingDimension('100%', '1264px') } })
    const widthInput = container.querySelector('.cortex-numeric-input input') as HTMLInputElement
    expect(widthInput.value).toBe('1264')
    expect(widthInput.disabled).toBe(true)
  })

  it('shows the rendered width for a fit-content element too', () => {
    setup({ values: { ...DEFAULT_VALUES, width: makeSizingDimension('fit-content', '86px') } })
    const widthInput = container.querySelector('.cortex-numeric-input input') as HTMLInputElement
    expect(widthInput.value).toBe('86')
  })

  it('falls back to 0 only when there is no measurement at all', () => {
    // `undefined`, not `'auto'` — the point is an ABSENT measurement. COR-6
    // makes that state explicit as `usedPx: null`, distinct from a measured 0.
    setup({ values: { ...DEFAULT_VALUES, width: makeSizingDimension('auto', undefined) } })
    const widthInput = container.querySelector('.cortex-numeric-input input') as HTMLInputElement
    expect(widthInput.value).toBe('0')
  })

  it('pins a fill element at its rendered width when switched to Fixed', async () => {
    // The regression this guards: seeding from the authored value wrote "0px"
    // and collapsed the element, because a `100%` width parses to NaN.
    const { onChange } = setup({ values: { ...DEFAULT_VALUES, width: makeSizingDimension('100%', '1264px') } })
    const triggers = container.querySelectorAll('.cortex-sizing-trigger')
    ;(triggers[0] as HTMLElement).click()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-value="fixed"]')).not.toBeNull()
    }, { timeout: 500 })
    ;(container.querySelector('[data-value="fixed"]') as HTMLElement).click()
    expect(onChange).toHaveBeenCalledWith({ property: 'width', value: '1264px' })
    expect(onChange).not.toHaveBeenCalledWith({ property: 'width', value: '0px' })
  })

  it('pins height at its rendered size when switched to Fixed', async () => {
    const { onChange } = setup({ values: { ...DEFAULT_VALUES, height: makeSizingDimension('fit-content', '40px') } })
    const triggers = container.querySelectorAll('.cortex-sizing-trigger')
    ;(triggers[1] as HTMLElement).click()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-value="fixed"]')).not.toBeNull()
    }, { timeout: 500 })
    ;(container.querySelector('[data-value="fixed"]') as HTMLElement).click()
    expect(onChange).toHaveBeenCalledWith({ property: 'height', value: '40px' })
  })

  it('does not offer the aspect lock when a dimension is auto', () => {
    // canLockAspect requires BOTH axes fixed. Everything read as fixed before
    // B5, so the lock was permanently enabled.
    setup({ values: { ...DEFAULT_VALUES, width: makeSizingDimension('auto', 'auto'), height: makeSizingDimension('48px', '48px') } })
    const lockBtn = container.querySelector('.cortex-lock-btn') as HTMLButtonElement
    expect(lockBtn.getAttribute('aria-disabled')).toBe('true')
  })

  // ZF0-1478 #4: stale prop must reach ALL 6 NumericInputs (width, height, min-w, max-w, min-h, max-h)
  it('stale=true propagates to all 6 NumericInputs (width, height, min-width, max-width, min-height, max-height)', () => {
    // Render with all min/max constraints active so all 6 inputs are present
    setup({
      stale: true,
      values: {
        ...DEFAULT_VALUES,
        minWidth: '10px',
        maxWidth: '500px',
        minHeight: '10px',
        maxHeight: '500px',
      },
    })
    // All NumericInputs that receive stale=true render the class 'cortex-numeric-input--stale'
    const staleInputs = container.querySelectorAll('.cortex-numeric-input--stale')
    // Expect all 6 (width, height, min-width, max-width, min-height, max-height)
    // Under pre-fix code only 2 (width + height) receive stale, so this must fail.
    expect(staleInputs.length).toBe(6)
  })

  it('refuses to write 0px when there is no measurement', async () => {
    // A `display: contents` element has no box and its computed width stays
    // `auto`, so `usedPx` is null. The display fallback legitimately shows 0 —
    // a blank field would be worse — but seeding a Fixed WRITE from that 0
    // emits `width: 0px` and collapses the element the moment its display
    // changes back. That is the exact bug this ticket exists to prevent,
    // recreated at the consumer instead of the producer.
    const { onChange } = setup({
      values: { ...DEFAULT_VALUES, width: makeSizingDimension('auto', undefined) },
    })
    const triggers = container.querySelectorAll('.cortex-sizing-trigger')
    ;(triggers[0] as HTMLElement).click()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-value="fixed"]')).not.toBeNull()
    }, { timeout: 500 })
    ;(container.querySelector('[data-value="fixed"]') as HTMLElement).click()
    expect(onChange).not.toHaveBeenCalledWith({ property: 'width', value: '0px' })
  })

  it('still pins at the rendered size when a measurement DOES exist', async () => {
    // The guard must not break the case it sits next to: a fill element with a
    // real measurement is exactly what "switch to Fixed" is for.
    const { onChange } = setup({
      values: { ...DEFAULT_VALUES, width: makeSizingDimension('100%', '1264px') },
    })
    const triggers = container.querySelectorAll('.cortex-sizing-trigger')
    ;(triggers[0] as HTMLElement).click()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-value="fixed"]')).not.toBeNull()
    }, { timeout: 500 })
    ;(container.querySelector('[data-value="fixed"]') as HTMLElement).click()
    expect(onChange).toHaveBeenCalledWith({ property: 'width', value: '1264px' })
  })
})
