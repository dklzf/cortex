import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from 'preact'
import { Panel } from '../../src/browser/components/Panel.js'
import { CommandStack } from '../../src/browser/command-stack.js'
import { CompoundEditCommand } from '../../src/browser/edit-command.js'
import { CSSOverrideManager } from '../../src/browser/override.js'
import { makeFakeBuffer } from './helpers.js'
import type { StagingBufferHandle } from '../../src/browser/hooks/useEditStagingBuffer.js'
import type { CortexChannel } from '../../src/adapters/types.js'
import type { TextComponent } from '../../src/core/text-components.js'
import type { ColorChip } from '../../src/browser/token-detector.js'

/**
 * Regression guard for C-R2-1 (Round 2 architecture review).
 *
 * The bug: Panel.applyClassChange sent the compound edit over the WebSocket
 * but did NOT push anything to the browser commandStack. When the user
 * pressed Ctrl+Z, CortexApp.tsx read `const cmd = commandStack.undo()`,
 * got undefined, and the `if (cmd)` gate blocked the server-side
 * `{ type: 'undo' }` message. Result: the compound UndoFileChange on the
 * server was never popped; user's linked bundle persisted despite Ctrl+Z.
 *
 * The load-bearing invariant under test: after applyClassChange runs, the
 * commandStack has exactly one new entry, and it is a CompoundEditCommand.
 * Without this, the Ctrl+Z gate never fires.
 */

vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 0, y: 30 }),
  flip: vi.fn().mockReturnValue({}),
  shift: vi.fn().mockReturnValue({}),
  offset: vi.fn().mockReturnValue({}),
  autoUpdate: vi.fn(() => () => {}),
}))

const BUNDLES: readonly TextComponent[] = [
  { name: 'body-md', fontSize: '14px', lineHeight: '21px', letterSpacing: '0px', fontWeight: '400' },
  { name: 'heading-1', fontSize: '32px', lineHeight: '40px', letterSpacing: '-0.5px', fontWeight: '700' },
]

const CHIPS: readonly ColorChip[] = [
  { name: 'brand-500', hex: '#3b82f6' },
  { name: 'gray-500', hex: '#6b7280' },
]

let container: HTMLDivElement
let targetElement: HTMLElement

const flushEffects = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

function createChannelMock(): CortexChannel & { sent: unknown[] } {
  const sent: unknown[] = []
  return {
    send: vi.fn((msg: unknown) => { sent.push(msg) }),
    // Panel.tsx subscribes to onMessage for staged-edits-discard handling
    // (T2). Return a no-op unsubscribe — these tests don't exercise that
    // path, but the mock must satisfy the CortexChannel contract.
    onMessage: vi.fn(() => () => {}),
    onConnectionChange: vi.fn(() => () => {}),
    connected: true,
    dispose: vi.fn(),
    sent,
  } as unknown as CortexChannel & { sent: unknown[] }
}

async function mountPanelWithLinkedHeading(
  commandStack: CommandStack,
  channel: CortexChannel,
  overrideManager: CSSOverrideManager,
  opts: { annotated?: boolean; buffer?: StagingBufferHandle } = {},
): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)

  targetElement = document.createElement('h1')
  targetElement.className = 'text-heading-1'
  // COR-25: `annotated: false` mounts an element with NO data-cortex-source —
  // the majority of the pointable surface on a component-library app, since
  // source-transform skips node_modules by design.
  if (opts.annotated !== false) {
    targetElement.setAttribute('data-cortex-source', 'Hero.tsx:5:3')
  }
  targetElement.textContent = 'Hero title'
  document.body.appendChild(targetElement)

  render(
    <Panel
      selectedElements={[targetElement]}
      overrideManager={overrideManager}
      commandStack={commandStack}
      channel={channel}
      onClose={vi.fn()}
      onSelectElement={vi.fn()}
      hmrAppliedVersion={0}
      swatches={[]}
      textComponents={[...BUNDLES]}
      colorChips={[...CHIPS]}
      position={{ x: 0, y: 0 }}
      isSnapping={false}
      panelPointerDown={vi.fn()}
      panelPointerMove={vi.fn()}
      panelPointerUp={vi.fn()}
      panelPointerCancel={vi.fn()}
      agentConnected={true}
      onEditDispatch={vi.fn()}
      buffer={opts.buffer ?? makeFakeBuffer()}
    />,
    container,
  )
  await flushEffects()
}

describe('Panel.applyClassChange records on commandStack (C-R2-1 regression)', () => {
  let commandStack: CommandStack
  let channel: CortexChannel & { sent: unknown[] }
  let overrideManager: CSSOverrideManager
  const originalRAF = window.requestAnimationFrame

  beforeEach(() => {
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(performance.now())
      return 0
    }) as typeof requestAnimationFrame
    document.querySelectorAll('[data-cortex-override]').forEach(el => el.remove())
    commandStack = new CommandStack()
    channel = createChannelMock()
    overrideManager = new CSSOverrideManager()
  })

  afterEach(() => {
    window.requestAnimationFrame = originalRAF
    if (container) {
      render(null, container)
      container.remove()
    }
    if (targetElement && targetElement.parentElement) {
      targetElement.remove()
    }
  })

  it('records a CompoundEditCommand when user unlinks a text bundle (Detach token)', async () => {
    await mountPanelWithLinkedHeading(commandStack, channel, overrideManager)

    expect(commandStack.undoCount).toBe(0) // baseline

    // Find the Detach token button inside TypographySection's pill.
    const unlinkButton = container.querySelector('button[aria-label="Detach token"]') as HTMLElement | null
    expect(unlinkButton, 'Detach token button should render when element has text-* class').not.toBeNull()

    unlinkButton!.click()
    await vi.waitFor(() => {
      // LOAD-BEARING: commandStack must have one new entry AND it must be a
      // CompoundEditCommand. Without this push, CortexApp's `if (cmd)` gate
      // blocks the server-side `{ type: 'undo' }` dispatch on Ctrl+Z.
      expect(commandStack.undoCount).toBe(1)
    }, { timeout: 500 })
    const cmd = commandStack.peekUndo()
    expect(cmd, 'peekUndo must return the recorded command').not.toBeNull()
    expect(cmd).toBeInstanceOf(CompoundEditCommand)
  })

  // ── COR-25 ────────────────────────────────────────────────────────────────
  //
  // The gesture used to read `data-cortex-source` directly and `return` when it
  // was absent: no error, no warning, no intent. The user clicked and nothing
  // happened, indistinguishable from a UI that ignored them.
  //
  // Two consequences, and the second is the one that mattered: the gesture is
  // dead on the majority of a component-library app, AND it is invisible to the
  // identity hit-rate gate, which scores intents that reached the agent. A
  // gesture that never became an intent cannot be scored, so the gate
  // over-reported.

  it('COR-25: a class op on an UNANNOTATED element stages an agent-resolve intent', async () => {
    const buffer = makeFakeBuffer()
    await mountPanelWithLinkedHeading(commandStack, channel, overrideManager, {
      annotated: false,
      buffer,
    })

    const unlinkButton = container.querySelector('button[aria-label="Detach token"]') as HTMLElement | null
    expect(unlinkButton, 'Detach token renders from the class, not from the anchor').not.toBeNull()

    unlinkButton!.click()
    await vi.waitFor(() => {
      expect((buffer.append as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
    }, { timeout: 500 })

    const staged = (buffer.append as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>
    expect(staged.kind).toBe('class')
    expect(staged.applyMode).toBe('agent-resolve')
    // The hint is what lets the agent find the call site with no file position;
    // the schema REQUIRES it for a preview source, so its absence is not a
    // degraded intent — it is an invalid one.
    expect(staged.sourceResolutionHint).toBeTruthy()
    expect(String(staged.source).startsWith('cortex-preview:')).toBe(true)
    expect(staged.classOp).toBeTruthy()
  })

  it('COR-25: the unannotated gesture does NOT take the direct-write wire path', async () => {
    // The direct path writes source at a file position. Sending a preview source
    // down it would ask the server to rewrite a file it cannot locate — the
    // staged intent is the whole point, so the wire must stay quiet.
    const buffer = makeFakeBuffer()
    await mountPanelWithLinkedHeading(commandStack, channel, overrideManager, {
      annotated: false,
      buffer,
    })

    const unlinkButton = container.querySelector('button[aria-label="Detach token"]') as HTMLElement | null
    unlinkButton!.click()
    await vi.waitFor(() => {
      expect((buffer.append as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
    }, { timeout: 500 })

    const classOpEdits = channel.sent.filter(
      (m) => (m as { type?: string; classOp?: unknown }).type === 'edit'
        && (m as { classOp?: unknown }).classOp !== undefined,
    )
    expect(classOpEdits).toHaveLength(0)
  })

  it('COR-25: an ANNOTATED element still takes the direct path, unchanged', async () => {
    // The fix must not reroute the case that already worked. This is the control:
    // with an anchor present, the wire message still carries the classOp and
    // nothing is staged.
    const buffer = makeFakeBuffer()
    await mountPanelWithLinkedHeading(commandStack, channel, overrideManager, { buffer })

    const unlinkButton = container.querySelector('button[aria-label="Detach token"]') as HTMLElement | null
    unlinkButton!.click()
    await vi.waitFor(() => {
      expect(commandStack.undoCount).toBe(1)
    }, { timeout: 500 })

    const classOpEdits = channel.sent.filter(
      (m) => (m as { type?: string; classOp?: unknown }).type === 'edit'
        && (m as { classOp?: unknown }).classOp !== undefined,
    )
    expect(classOpEdits.length).toBeGreaterThan(0)
    expect((buffer.append as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('the recorded CompoundEditCommand carries editId that matches the compound edit message', async () => {
    await mountPanelWithLinkedHeading(commandStack, channel, overrideManager)

    const unlinkButton = container.querySelector('button[aria-label="Detach token"]') as HTMLElement
    unlinkButton.click()
    await vi.waitFor(() => {
      const cmd = commandStack.peekUndo()
      expect(cmd).toBeInstanceOf(CompoundEditCommand)
    }, { timeout: 500 })

    const cmd = commandStack.peekUndo() as CompoundEditCommand
    expect(cmd).toBeInstanceOf(CompoundEditCommand)

    // Find the compound edit message that was sent.
    const editMessage = (channel as unknown as { sent: Array<Record<string, unknown>> }).sent
      .find((m) => m.type === 'edit' && m.classOp)
    expect(editMessage, 'channel must have received the compound edit').toBeDefined()

    // The editId on the command and the edit message must match — this is
    // how the server's HMR-verification cycle correlates override cleanup.
    expect(cmd.editId).toBe(editMessage!.editId)
  })

  it('the recorded command survives a subsequent undo() call and dispatches to the Ctrl+Z gate', async () => {
    await mountPanelWithLinkedHeading(commandStack, channel, overrideManager)

    const unlinkButton = container.querySelector('button[aria-label="Detach token"]') as HTMLElement
    unlinkButton.click()
    await vi.waitFor(() => {
      expect(commandStack.undoCount).toBeGreaterThan(0)
    }, { timeout: 500 })

    // Simulate what CortexApp's Cmd+Z handler does:
    //   const cmd = commandStackRef.current?.undo()
    //   if (cmd) channel.send({ type: 'undo' })
    const poppedCmd = commandStack.undo()
    expect(poppedCmd, 'commandStack.undo() must return a truthy command for the gate to fire').not.toBeNull()
    expect(poppedCmd).toBeInstanceOf(CompoundEditCommand)
  })
})
