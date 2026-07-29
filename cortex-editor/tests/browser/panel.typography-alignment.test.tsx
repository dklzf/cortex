import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { Panel } from '../../src/browser/components/Panel.js'
import { _resetTransformBusForTesting } from '../../src/browser/transform-bus.js'
import { _resetBusForTesting } from '../../src/browser/override-bus.js'
import { mockGetComputedStyle, renderInShadow, makeFakeBuffer } from './helpers.js'

const panelPositionProps = {
  position: { x: 1000, y: 12 },
  isSnapping: false,
  panelPointerDown: vi.fn(),
  panelPointerMove: vi.fn(),
  panelPointerUp: vi.fn(),
  panelPointerCancel: vi.fn(),
  hmrAppliedVersion: 0,
}

function createTextTarget(): HTMLParagraphElement {
  const target = document.createElement('p')
  target.setAttribute('data-cortex-source', 'src/Hero.tsx:14:5')
  target.textContent = 'Hero heading'
  document.body.appendChild(target)
  return target
}

function createTrackingOverrideManager() {
  const store = new Map<string, string>()
  return {
    set: vi.fn((src: string, prop: string, val: string) => {
      store.set(`${src}\0${prop}`, val)
    }),
    get: vi.fn((src: string, prop: string) => store.get(`${src}\0${prop}`)),
    remove: vi.fn(),
    clearAll: vi.fn(),
    dispose: vi.fn(),
    flush: vi.fn(),
    hasAnyOverrides: vi.fn(() => store.size > 0),
    readSourceValue: vi.fn(() => ''),
    store,
  }
}

function setupPanel(styles: Record<string, string>) {
  const target = createTextTarget()
  const restoreGCS = mockGetComputedStyle(target, {
    fontFamily: 'Inter',
    fontSize: '16px',
    fontWeight: '400',
    lineHeight: '24px',
    letterSpacing: '0px',
    textAlign: 'left',
    color: 'rgb(0, 0, 0)',
    display: 'block',
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    height: '80px',
    minHeight: '0px',
    ...styles,
  })
  const overrideManager = createTrackingOverrideManager()
  const rendered = renderInShadow(
    <Panel
      selectedElements={[target]}
      overrideManager={overrideManager as any}
      onClose={() => {}}
      onSelectElement={() => {}}
      {...panelPositionProps}
      buffer={makeFakeBuffer()}
    />,
  )
  return {
    ...rendered,
    target,
    overrideManager,
    cleanupAll() {
      rendered.cleanup()
      restoreGCS()
      target.remove()
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  _resetBusForTesting()
  _resetTransformBusForTesting()
})

describe('Panel — Typography alignment routing', () => {
  it('routes flex-row horizontal Typography alignment to justify-content', async () => {
    const { root, overrideManager, cleanupAll } = setupPanel({
      display: 'flex',
      flexDirection: 'row',
      justifyContent: 'flex-start',
      alignItems: 'stretch',
    })
    try {
      const typeSection = root.querySelector('[data-section-id="type"]')
      expect(typeSection).not.toBeNull()
      const horizontal = typeSection!.querySelector('[role="radiogroup"]') as HTMLElement
      const right = horizontal.querySelector('[data-value="right"]') as HTMLElement
      await act(async () => {
        right.click()
        await Promise.resolve()
      })
      expect(overrideManager.set).toHaveBeenCalledWith(
        'src/Hero.tsx:14:5',
        'justify-content',
        'flex-end',
        undefined,
      )
      expect(overrideManager.set).not.toHaveBeenCalledWith(
        'src/Hero.tsx:14:5',
        'text-align',
        'right',
        undefined,
      )
    } finally {
      cleanupAll()
    }
  })

  it('routes flex-column vertical Typography alignment to justify-content', async () => {
    const { root, overrideManager, cleanupAll } = setupPanel({
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-start',
      alignItems: 'stretch',
    })
    try {
      const groups = root.querySelectorAll('[data-section-id="type"] [role="radiogroup"]')
      const vertical = groups[1] as HTMLElement
      const middle = vertical.querySelector('[data-value="center"]') as HTMLElement
      await act(async () => {
        middle.click()
        await Promise.resolve()
      })
      expect(overrideManager.set).toHaveBeenCalledWith(
        'src/Hero.tsx:14:5',
        'justify-content',
        'center',
        undefined,
      )
      expect(overrideManager.set).not.toHaveBeenCalledWith(
        'src/Hero.tsx:14:5',
        'align-items',
        'center',
        undefined,
      )
    } finally {
      cleanupAll()
    }
  })
})
