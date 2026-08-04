import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from 'preact'
import { LayoutSection, parseLayoutValues, inlineDisplayApplies } from '../../../src/browser/components/sections/LayoutSection.js'
import type { LayoutValues } from '../../../src/browser/components/sections/LayoutSection.js'

vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 0, y: 30 }),
  flip: vi.fn().mockReturnValue({}),
  shift: vi.fn().mockReturnValue({}),
}))

describe('LayoutSection', () => {
  let container: HTMLDivElement

  afterEach(() => {
    if (container) {
      render(null, container)
      container.remove()
    }
  })

  const DEFAULT_VALUES: LayoutValues = {
    display: 'block',
    visibility: 'visible',
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    rowGap: 0,
    columnGap: 0,
    flexWrap: 'nowrap',
    gridTemplateColumns: 'none',
    gridTemplateRows: 'none',
    gridAutoFlow: 'row',
    justifyItems: 'stretch',
    // Units matter: getComputedStyle().width always returns one, so a bare
    // `320` cannot reach this component. See SizingControls.test.tsx.
    width: '320px',
    height: '48px',
    minWidth: '0px',
    maxWidth: 'none',
    minHeight: '0px',
    maxHeight: 'none',
    overflow: 'visible',
    boxSizing: 'content-box',
    // Default to <div> with block parent so 'inline' option is enabled —
    // gating tests set tagName/parentDisplay explicitly per-case.
    tagName: 'div',
    parentDisplay: 'block',
  }

  const DEFAULT_SPACING = {
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  }

  function setup(overrides?: Partial<Parameters<typeof LayoutSection>[0]>) {
    container = document.createElement('div')
    document.body.appendChild(container)
    const onChange = vi.fn()
    render(
      <LayoutSection
        values={DEFAULT_VALUES}
        onChange={onChange}
        spacing={DEFAULT_SPACING}
        onSpacingChange={vi.fn()}
        {...overrides}
      />,
      container,
    )
    return { onChange }
  }

  it('has data-section-id="layout"', () => {
    setup()
    const root = container.querySelector('[data-section-id="layout"]')
    expect(root).not.toBeNull()
  })

  it('renders display segmented control with block active', () => {
    setup()
    const displayGroup = container.querySelector('[role="radiogroup"]')
    expect(displayGroup).not.toBeNull()
    const active = container.querySelector('[aria-checked="true"]')
    expect(active).not.toBeNull()
  })

  it('does not render visibility control (moved to AppearanceSection)', () => {
    setup()
    expect(container.textContent).not.toContain('Visibility')
    expect(container.querySelector('[data-group="visibility"]')).toBeNull()
  })

  it('shows flex direction segmented control for flex display', () => {
    setup({ values: { ...DEFAULT_VALUES, display: 'flex' } })
    expect(container.querySelector('.cortex-flex-controls__direction [role="radiogroup"]')).not.toBeNull()
  })

  it('hides flex direction for block display', () => {
    setup()
    expect(container.textContent).not.toContain('Direction')
  })

  it('shows FlexControls for flex display with X/Y dropdowns', () => {
    setup({ values: { ...DEFAULT_VALUES, display: 'flex' } })
    expect(container.querySelector('.cortex-flex-controls')).not.toBeNull()
    expect(container.querySelector('.cortex-flex-controls .cortex-alignment-grid')).not.toBeNull()
    expect(
      container.querySelector('[data-xy-axis="x"] .cortex-xy-dropdown__trigger'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-xy-axis="y"] .cortex-xy-dropdown__trigger'),
    ).not.toBeNull()
  })

  it('renders GridControls for grid display (Task 9 / ZF0-1187)', () => {
    setup({ values: { ...DEFAULT_VALUES, display: 'grid' } })
    expect(container.querySelector('.cortex-grid-controls')).not.toBeNull()
    expect(container.querySelector('.cortex-grid-controls .cortex-alignment-grid')).not.toBeNull()
    expect(
      container.querySelector('.cortex-grid-controls [data-xy-axis="x"] .cortex-xy-dropdown__trigger'),
    ).not.toBeNull()
    expect(
      container.querySelector('.cortex-grid-controls [data-xy-axis="y"] .cortex-xy-dropdown__trigger'),
    ).not.toBeNull()
    // Direction merged into template row.
    expect(
      container.querySelector('.cortex-grid-controls__template [role="radiogroup"]'),
    ).not.toBeNull()
  })

  it('hides GridControls and FlexControls for block display', () => {
    setup()
    expect(container.querySelector('.cortex-grid-controls')).toBeNull()
    expect(container.querySelector('.cortex-flex-controls')).toBeNull()
  })

  it('renders W and H sizing inputs via SizingControls', () => {
    setup()
    expect(container.querySelector('[data-testid="sizing-controls"]')).not.toBeNull()
    expect(container.textContent).toContain('W')
    expect(container.textContent).toContain('H')
  })

  it('emits display change on segmented control click', () => {
    const { onChange } = setup()
    const flexBtn = container.querySelector('[data-value="flex"]') as HTMLElement
    flexBtn?.click()
    expect(onChange).toHaveBeenCalledWith({ property: 'display', value: 'flex' })
  })

  it('renders display as text-label segmented control (no icons)', () => {
    setup()
    const group = container.querySelector('[role="radiogroup"]')!
    const options = group.querySelectorAll('[role="radio"]')
    expect(options.length).toBe(5)
    expect(options[0]?.textContent).toBe('block')
    expect(options[4]?.textContent).toBe('none')
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
    const calls = onChange.mock.calls
    const widthCall = calls.find((c: any) => c[0]?.property === 'width')
    expect(widthCall).toBeDefined()
    expect(widthCall![0].value).toBe('400px')
  })

  // B5: previously asserted `auto` renders as "px". LayoutSection passes
  // values straight through to SizingControls, so the mode it shows is the
  // mode SizingControls derives — this is the pass-through half of the same
  // contract asserted in SizingControls.test.tsx.
  it('passes auto width through to SizingControls, which reports it as auto', () => {
    setup({ values: { ...DEFAULT_VALUES, width: 'auto' } })
    expect(container.querySelector('[data-testid="sizing-controls"]')).not.toBeNull()
    const modeLabels = container.querySelectorAll('.cortex-sizing-trigger__label')
    expect(modeLabels[0]?.textContent).toBe('auto')
  })

  it('renders sizing dropdown triggers for W and H', () => {
    setup()
    const triggers = container.querySelectorAll('.cortex-sizing-trigger')
    expect(triggers.length).toBe(2)
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

  it('shows min-width input when toggled on', async () => {
    setup()
    const triggers = container.querySelectorAll('.cortex-sizing-trigger')
    ;(triggers[0] as HTMLElement).click()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-action="toggle-min"]')).not.toBeNull()
    }, { timeout: 500 })
    const minToggle = container.querySelector('[data-action="toggle-min"]') as HTMLElement
    minToggle.click()
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Min')
    }, { timeout: 500 })
  })

  // ── display=none hides SizingControls + SpacingControls ─────────
  it('display=none renders neither SizingControls nor SpacingControls', () => {
    setup({ values: { ...DEFAULT_VALUES, display: 'none' } })
    expect(container.querySelector('[data-testid="sizing-controls"]')).toBeNull()
    expect(container.querySelector('[data-testid="spacing-controls"]')).toBeNull()
  })

  // ── display=block renders SizingControls + SpacingControls ──────
  it('display=block renders SizingControls + SpacingControls (no flex/grid)', () => {
    setup()
    expect(container.querySelector('[data-testid="sizing-controls"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="spacing-controls"]')).not.toBeNull()
    expect(container.querySelector('.cortex-flex-controls')).toBeNull()
    expect(container.querySelector('.cortex-grid-controls')).toBeNull()
  })

  // ── Regression: flex→block transition must not crash ────────────
  it('survives block→flex→block re-render without errors', () => {
    // Start with block
    const onChange = vi.fn()
    const baseProps = {
      values: DEFAULT_VALUES,
      onChange,
      spacing: DEFAULT_SPACING,
      onSpacingChange: vi.fn(),
    }
    render(<LayoutSection {...baseProps} />, container)
    expect(container.querySelector('.cortex-flex-controls')).toBeNull()

    // Switch to flex
    render(<LayoutSection {...baseProps} values={{ ...DEFAULT_VALUES, display: 'flex' }} />, container)
    expect(container.querySelector('.cortex-flex-controls')).not.toBeNull()

    // Switch back to block — this must not throw
    render(<LayoutSection {...baseProps} values={{ ...DEFAULT_VALUES, display: 'block' }} />, container)
    expect(container.querySelector('.cortex-flex-controls')).toBeNull()
    // Display segmented control still shows block
    const active = container.querySelector('[aria-checked="true"]') as HTMLElement
    expect(active?.getAttribute('data-value')).toBe('block')
  })

  // ── parseLayoutValues ───────────────────────────────────────────
  it('parseLayoutValues includes min/max fields', () => {
    const cs = {
      display: 'block',
      visibility: 'visible',
      flexDirection: 'row',
      justifyContent: 'flex-start',
      alignItems: 'stretch',
      width: '320px',
      height: '48px',
      minWidth: '100px',
      maxWidth: '500px',
      minHeight: '0px',
      maxHeight: 'none',
    } as unknown as CSSStyleDeclaration
    const result = parseLayoutValues(cs)
    expect(result.minWidth).toBe('100px')
    expect(result.maxWidth).toBe('500px')
  })

  it('parseLayoutValues reads gap and flex-wrap fields from a CSSStyleDeclaration', () => {
    const cs = {
      display: 'flex',
      visibility: 'visible',
      flexDirection: 'column-reverse',
      justifyContent: 'center',
      alignItems: 'flex-end',
      rowGap: '12px',
      columnGap: '8px',
      flexWrap: 'wrap-reverse',
      width: 'auto',
      height: 'auto',
      minWidth: '0px',
      maxWidth: 'none',
      minHeight: '0px',
      maxHeight: 'none',
    } as unknown as CSSStyleDeclaration
    const result = parseLayoutValues(cs)
    expect(result.rowGap).toBe(12)
    expect(result.columnGap).toBe(8)
    expect(result.flexWrap).toBe('wrap-reverse')
    expect(result.flexDirection).toBe('column-reverse')
    expect(result.justifyContent).toBe('center')
    expect(result.alignItems).toBe('flex-end')
  })

  it('parseLayoutValues defaults gap and flex-wrap when fields are absent', () => {
    const cs = {
      display: 'block',
      visibility: 'visible',
      flexDirection: '',
      justifyContent: '',
      alignItems: '',
      rowGap: '',
      columnGap: '',
      flexWrap: '',
      width: 'auto',
      height: 'auto',
      minWidth: '0px',
      maxWidth: 'none',
      minHeight: '0px',
      maxHeight: 'none',
    } as unknown as CSSStyleDeclaration
    const result = parseLayoutValues(cs)
    expect(result.rowGap).toBe(0)
    expect(result.columnGap).toBe(0)
    expect(result.flexWrap).toBe('nowrap')
    expect(result.flexDirection).toBe('row')
    expect(result.justifyContent).toBe('flex-start')
    expect(result.alignItems).toBe('stretch')
  })

  it('parseLayoutValues reads grid fields from a CSSStyleDeclaration', () => {
    const cs = {
      display: 'grid',
      visibility: 'visible',
      flexDirection: '',
      justifyContent: '',
      alignItems: 'center',
      rowGap: '',
      columnGap: '',
      flexWrap: '',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gridTemplateRows: 'repeat(2, 1fr)',
      gridAutoFlow: 'column',
      justifyItems: 'center',
      width: 'auto',
      height: 'auto',
      minWidth: '0px',
      maxWidth: 'none',
      minHeight: '0px',
      maxHeight: 'none',
    } as unknown as CSSStyleDeclaration
    const result = parseLayoutValues(cs)
    expect(result.gridTemplateColumns).toBe('repeat(3, 1fr)')
    expect(result.gridTemplateRows).toBe('repeat(2, 1fr)')
    expect(result.gridAutoFlow).toBe('column')
    expect(result.justifyItems).toBe('center')
    expect(result.alignItems).toBe('center')
  })

  it('parseLayoutValues defaults grid fields when absent', () => {
    const cs = {
      display: 'block',
      visibility: 'visible',
      flexDirection: '',
      justifyContent: '',
      alignItems: '',
      rowGap: '',
      columnGap: '',
      flexWrap: '',
      gridTemplateColumns: '',
      gridTemplateRows: '',
      gridAutoFlow: '',
      justifyItems: '',
      width: 'auto',
      height: 'auto',
      minWidth: '0px',
      maxWidth: 'none',
      minHeight: '0px',
      maxHeight: 'none',
    } as unknown as CSSStyleDeclaration
    const result = parseLayoutValues(cs)
    expect(result.gridTemplateColumns).toBe('none')
    expect(result.gridTemplateRows).toBe('none')
    expect(result.gridAutoFlow).toBe('row')
    expect(result.justifyItems).toBe('stretch')
  })

  // ── parseLayoutValues overflow + boxSizing ──────────────────────
  it('parseLayoutValues includes overflow and boxSizing fields', () => {
    const cs = {
      display: 'block',
      visibility: 'visible',
      flexDirection: '',
      justifyContent: '',
      alignItems: '',
      rowGap: '',
      columnGap: '',
      flexWrap: '',
      gridTemplateColumns: '',
      gridTemplateRows: '',
      gridAutoFlow: '',
      justifyItems: '',
      width: 'auto',
      height: 'auto',
      minWidth: '0px',
      maxWidth: 'none',
      minHeight: '0px',
      maxHeight: 'none',
      overflow: 'hidden',
      boxSizing: 'border-box',
    } as unknown as CSSStyleDeclaration
    const result = parseLayoutValues(cs)
    expect(result.overflow).toBe('hidden')
    expect(result.boxSizing).toBe('border-box')
  })

  it('parseLayoutValues defaults overflow and boxSizing when absent', () => {
    const cs = {
      display: 'block',
      visibility: 'visible',
      flexDirection: '',
      justifyContent: '',
      alignItems: '',
      width: 'auto',
      height: 'auto',
      minWidth: '0px',
      maxWidth: 'none',
      minHeight: '0px',
      maxHeight: 'none',
    } as unknown as CSSStyleDeclaration
    const result = parseLayoutValues(cs)
    expect(result.overflow).toBe('visible')
    expect(result.boxSizing).toBe('content-box')
  })

  // ── inline-display gating (CSS blockification + widget UA coercion) ──
  //
  // /investigate root cause: clicking "inline" silently no-ops for two
  // CSS-spec-driven reasons that combine in the most common UI cases:
  //   (1) Flexbox §4 / Grid §3.4 blockify any child's display:inline to
  //       block when parent is a flex/grid container.
  //   (2) HTML widget UA stylesheets coerce display:inline to inline-
  //       block on <button>, <input>, <select>, <textarea>, etc.
  // The panel disables the 'inline' option in both cases with an
  // explanatory tooltip rather than letting the user click into a no-op.

  it('inlineDisplayApplies: <div> with block parent → true (works)', () => {
    expect(inlineDisplayApplies({ tagName: 'div', parentDisplay: 'block' })).toBe(true)
  })

  it('inlineDisplayApplies: <button> with block parent → false (UA coercion)', () => {
    expect(inlineDisplayApplies({ tagName: 'button', parentDisplay: 'block' })).toBe(false)
  })

  it('inlineDisplayApplies: <input> with block parent → false (UA coercion)', () => {
    expect(inlineDisplayApplies({ tagName: 'input', parentDisplay: 'block' })).toBe(false)
  })

  it('inlineDisplayApplies: <select> with block parent → false (UA coercion)', () => {
    expect(inlineDisplayApplies({ tagName: 'select', parentDisplay: 'block' })).toBe(false)
  })

  it('inlineDisplayApplies: <textarea> with block parent → false (UA coercion)', () => {
    expect(inlineDisplayApplies({ tagName: 'textarea', parentDisplay: 'block' })).toBe(false)
  })

  it('inlineDisplayApplies: <div> with flex parent → false (blockification)', () => {
    expect(inlineDisplayApplies({ tagName: 'div', parentDisplay: 'flex' })).toBe(false)
  })

  it('inlineDisplayApplies: <div> with inline-flex parent → false (blockification)', () => {
    expect(inlineDisplayApplies({ tagName: 'div', parentDisplay: 'inline-flex' })).toBe(false)
  })

  it('inlineDisplayApplies: <div> with grid parent → false (blockification)', () => {
    expect(inlineDisplayApplies({ tagName: 'div', parentDisplay: 'grid' })).toBe(false)
  })

  it('inlineDisplayApplies: <div> with inline-grid parent → false (blockification)', () => {
    expect(inlineDisplayApplies({ tagName: 'div', parentDisplay: 'inline-grid' })).toBe(false)
  })

  // Regression: codex review (P2) on PR #162 caught that <img>, <video>,
  // <canvas>, <iframe>, <embed>, <object> all honor display:inline
  // correctly (verified live: each computes to "inline" when set).
  // They're atomic-inline by default but display:inline remains a valid
  // edit — switching from block/flex/grid BACK to inline must stay
  // available. The original PR over-included these in WIDGET_TAGS.
  it.each([
    ['img'],
    ['video'],
    ['canvas'],
    ['iframe'],
    ['embed'],
    ['object'],
  ])('inlineDisplayApplies: <%s> (replaced/media element) in block parent → true', (tag) => {
    expect(inlineDisplayApplies({ tagName: tag, parentDisplay: 'block' })).toBe(true)
  })

  it('inlineDisplayApplies: pseudo-element on a widget host → true', () => {
    // Regression: codex review (P2) on PR #162. When editing ::before on
    // a <button>, the pseudo-element is NOT subject to widget coercion —
    // it's a generated box, not the form control itself. panel-style-
    // snapshot now sets tagName='' for pseudo-element snapshots, which
    // bypasses WIDGET_TAGS. Verified at the predicate level here.
    expect(inlineDisplayApplies({ tagName: '', parentDisplay: 'block' })).toBe(true)
  })

  // ── UI: disabled state on the inline option ───────────────────────────

  it('renders inline option enabled for <div> with block parent', () => {
    setup({ values: { ...DEFAULT_VALUES, tagName: 'div', parentDisplay: 'block' } })
    const inlineBtn = container.querySelector('[data-value="inline"]') as HTMLElement
    expect(inlineBtn).not.toBeNull()
    expect(inlineBtn.getAttribute('aria-disabled')).toBeNull()
    expect(inlineBtn.classList.contains('cortex-segmented__option--disabled')).toBe(false)
  })

  it('renders inline option disabled for <button> (widget coercion)', () => {
    setup({ values: { ...DEFAULT_VALUES, tagName: 'button', parentDisplay: 'block' } })
    const inlineBtn = container.querySelector('[data-value="inline"]') as HTMLElement
    expect(inlineBtn).not.toBeNull()
    expect(inlineBtn.getAttribute('aria-disabled')).toBe('true')
    expect(inlineBtn.classList.contains('cortex-segmented__option--disabled')).toBe(true)
    const tooltip = inlineBtn.getAttribute('data-tooltip')
    expect(tooltip).toContain('button')
    expect(tooltip).toContain('inline-block')
  })

  it('renders inline option disabled for <div> with flex parent (blockification)', () => {
    setup({ values: { ...DEFAULT_VALUES, tagName: 'div', parentDisplay: 'flex' } })
    const inlineBtn = container.querySelector('[data-value="inline"]') as HTMLElement
    expect(inlineBtn.getAttribute('aria-disabled')).toBe('true')
    const tooltip = inlineBtn.getAttribute('data-tooltip')
    expect(tooltip).toContain('flex')
    expect(tooltip).toContain('block')
  })

  it('renders inline option disabled for <div> with grid parent', () => {
    setup({ values: { ...DEFAULT_VALUES, tagName: 'div', parentDisplay: 'grid' } })
    const inlineBtn = container.querySelector('[data-value="inline"]') as HTMLElement
    expect(inlineBtn.getAttribute('aria-disabled')).toBe('true')
  })

  it('clicking the disabled inline option does NOT fire onChange', () => {
    const { onChange } = setup({ values: { ...DEFAULT_VALUES, tagName: 'button', parentDisplay: 'block' } })
    const inlineBtn = container.querySelector('[data-value="inline"]') as HTMLElement
    inlineBtn.click()
    const inlineCall = onChange.mock.calls.find((c: any) => c[0]?.property === 'display' && c[0]?.value === 'inline')
    expect(inlineCall).toBeUndefined()
  })

  it('clicking other display options still fires onChange when inline is disabled', () => {
    const { onChange } = setup({ values: { ...DEFAULT_VALUES, tagName: 'button', parentDisplay: 'block' } })
    const flexBtn = container.querySelector('[data-value="flex"]') as HTMLElement
    flexBtn.click()
    expect(onChange).toHaveBeenCalledWith({ property: 'display', value: 'flex' })
  })
})
