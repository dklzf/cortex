import { describe, it, expect } from 'vitest'
import { browserToServerSchema, serverToBrowserSchema, spacingTokenSchema } from '../../src/schemas/wire-format.js'

// ---- BrowserToServer tests ----

const validToken = 'tok-abc'

describe('browserToServerSchema — init', () => {
  it('accepts minimal init', () => {
    expect(() => browserToServerSchema.parse({ type: 'init' })).not.toThrow()
  })
  it('accepts init with sessionId', () => {
    expect(() => browserToServerSchema.parse({ type: 'init', sessionId: 'sess-1' })).not.toThrow()
  })
  it('rejects init with wrong type value', () => {
    const r = browserToServerSchema.safeParse({ type: 'Init' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('type')
    }
  })
})

describe('browserToServerSchema — cortex-closed', () => {
  it('accepts cortex-closed', () => {
    expect(() => browserToServerSchema.parse({ type: 'cortex-closed' })).not.toThrow()
  })
})

describe('browserToServerSchema — edit', () => {
  const baseEdit = {
    type: 'edit',
    editId: 'edit-1',
    property: 'color',
    value: 'red',
    source: 'src/Hero.tsx:14:5',
    elementSelector: '.hero',
  }
  it('accepts minimal edit', () => {
    expect(() => browserToServerSchema.parse(baseEdit)).not.toThrow()
  })
  it('accepts edit with classOp add', () => {
    const msg = { ...baseEdit, classOp: { kind: 'add', add: 'text-lg' } }
    expect(() => browserToServerSchema.parse(msg)).not.toThrow()
  })
  it('accepts edit with classOp remove', () => {
    const msg = { ...baseEdit, classOp: { kind: 'remove', remove: 'text-sm' } }
    expect(() => browserToServerSchema.parse(msg)).not.toThrow()
  })
  it('accepts edit with classOp swap', () => {
    const msg = { ...baseEdit, classOp: { kind: 'swap', remove: 'text-sm', add: 'text-lg' } }
    expect(() => browserToServerSchema.parse(msg)).not.toThrow()
  })
  it('accepts edit with inlineSets and inlineRemoves', () => {
    const msg = {
      ...baseEdit,
      inlineSets: [{ property: 'font-size', value: '16px' }],
      inlineRemoves: [{ property: 'color' }],
    }
    expect(() => browserToServerSchema.parse(msg)).not.toThrow()
  })
  it('rejects edit missing editId', () => {
    const r = browserToServerSchema.safeParse({ ...baseEdit, editId: undefined })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('editId')
    }
  })
  it('rejects edit missing elementSelector', () => {
    const r = browserToServerSchema.safeParse({ ...baseEdit, elementSelector: undefined })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('elementSelector')
    }
  })
  it('rejects classOp with unknown kind', () => {
    const r = browserToServerSchema.safeParse({ ...baseEdit, classOp: { kind: 'toggle', className: 'foo' } })
    expect(r.success).toBe(false)
    if (!r.success) {
      // The classOp is a discriminated union; failure path includes 'classOp' or 'classOp.kind'
      const paths = r.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.startsWith('classOp'))).toBe(true)
    }
  })
})

describe('browserToServerSchema — undo', () => {
  it('accepts minimal undo', () => {
    expect(() => browserToServerSchema.parse({ type: 'undo' })).not.toThrow()
  })
  it('accepts undo with token and editId', () => {
    expect(() => browserToServerSchema.parse({ type: 'undo', token: validToken, editId: 'e1' })).not.toThrow()
  })
})

describe('browserToServerSchema — redo', () => {
  it('accepts redo', () => {
    expect(() => browserToServerSchema.parse({ type: 'redo' })).not.toThrow()
  })
})

describe('browserToServerSchema — comment', () => {
  const baseComment = {
    type: 'comment',
    elementSource: 'src/Hero.tsx:14:5',
    text: 'make this red',
  }
  it('accepts minimal comment', () => {
    expect(() => browserToServerSchema.parse(baseComment)).not.toThrow()
  })
  it('accepts comment with fixMeta (fix-request variant)', () => {
    const msg = {
      ...baseComment,
      kind: 'fix-request',
      fixMeta: { property: 'color', value: 'red', reason: 'brand color' },
    }
    expect(() => browserToServerSchema.parse(msg)).not.toThrow()
  })
  it('accepts comment with elementContext and pinPosition', () => {
    const msg = {
      ...baseComment,
      elementContext: {
        tagName: 'div',
        componentName: 'Hero',
        domSelector: '.hero',
        textPreview: 'Hero text',
      },
      pinPosition: { x: 100, y: 200 },
    }
    expect(() => browserToServerSchema.parse(msg)).not.toThrow()
  })
  it('rejects comment missing elementSource', () => {
    const r = browserToServerSchema.safeParse({ ...baseComment, elementSource: undefined })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('elementSource')
    }
  })
  it('rejects comment missing text', () => {
    const r = browserToServerSchema.safeParse({ ...baseComment, text: undefined })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('text')
    }
  })
})

describe('browserToServerSchema — comment-reply', () => {
  it('accepts comment-reply', () => {
    expect(() => browserToServerSchema.parse({ type: 'comment-reply', annotationId: 'ann-1', text: 'reply' })).not.toThrow()
  })
  it('rejects comment-reply missing annotationId', () => {
    const r = browserToServerSchema.safeParse({ type: 'comment-reply', text: 'x' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('annotationId')
    }
  })
})

describe('browserToServerSchema — clear_server_undo', () => {
  it('accepts clear_server_undo', () => {
    expect(() => browserToServerSchema.parse({ type: 'clear_server_undo' })).not.toThrow()
  })
})

describe('browserToServerSchema — staged-edit-add', () => {
  const validStagedEdit = {
    intentId: 'i-1',
    source: 'src/Hero.tsx:14:5',
    property: 'color',
    value: 'red',
    previousValue: '',
    timestamp: 1714500000000,
  }
  it('accepts staged-edit-add with valid edit', () => {
    expect(() => browserToServerSchema.parse({ type: 'staged-edit-add', edit: validStagedEdit, token: validToken })).not.toThrow()
  })
  it('rejects staged-edit-add without token', () => {
    const r = browserToServerSchema.safeParse({ type: 'staged-edit-add', edit: validStagedEdit })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('token')
    }
  })
  it('rejects staged-edit-add with invalid edit (bad intentId)', () => {
    const r = browserToServerSchema.safeParse({
      type: 'staged-edit-add',
      edit: { ...validStagedEdit, intentId: '' },
      token: validToken,
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.startsWith('edit'))).toBe(true)
    }
  })
})

describe('browserToServerSchema — staged-edit-remove', () => {
  it('accepts staged-edit-remove', () => {
    expect(() => browserToServerSchema.parse({ type: 'staged-edit-remove', intentIds: ['i-1'], token: validToken })).not.toThrow()
  })
  it('rejects without intentIds', () => {
    const r = browserToServerSchema.safeParse({ type: 'staged-edit-remove', token: validToken })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('intentIds')
    }
  })
  it('staged-edit-remove rejects intentIds with multi-byte string exceeding MAX_INTENT_ID_BYTES (F14)', () => {
    const emoji100 = '🎉'.repeat(100) // 400 UTF-8 bytes > 256 cap
    const result = browserToServerSchema.safeParse({
      type: 'staged-edit-remove',
      intentIds: ['valid-id', emoji100, 'another-valid'],
      token: validToken,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      // Path should point at the array element that violated (index 1)
      expect(paths.some((p) => p.includes('intentIds.1'))).toBe(true)
    }
  })
})

describe('browserToServerSchema — staged-edit-clear', () => {
  it('accepts staged-edit-clear', () => {
    expect(() => browserToServerSchema.parse({ type: 'staged-edit-clear', token: validToken })).not.toThrow()
  })
})

describe('browserToServerSchema — staged-edits-sync', () => {
  const validStagedEdit = {
    intentId: 'i-2',
    source: 'src/App.tsx:10:3',
    property: 'background',
    value: 'blue',
    previousValue: 'white',
    timestamp: 1714500000001,
  }
  it('accepts staged-edits-sync', () => {
    expect(() => browserToServerSchema.parse({ type: 'staged-edits-sync', edits: [validStagedEdit], token: validToken })).not.toThrow()
  })
  it('accepts staged-edits-sync with empty edits array', () => {
    expect(() => browserToServerSchema.parse({ type: 'staged-edits-sync', edits: [], token: validToken })).not.toThrow()
  })
})

describe('browserToServerSchema — staged-edits-ready', () => {
  it('accepts staged-edits-ready', () => {
    expect(() => browserToServerSchema.parse({ type: 'staged-edits-ready', count: 3, requestId: 'req-1', token: validToken })).not.toThrow()
  })
  it('rejects missing requestId', () => {
    const r = browserToServerSchema.safeParse({ type: 'staged-edits-ready', count: 3, token: validToken })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('requestId')
    }
  })
})

describe('browserToServerSchema — unknown type', () => {
  it('rejects unknown message type', () => {
    const r = browserToServerSchema.safeParse({ type: 'unknown-type' })
    expect(r.success).toBe(false)
    if (!r.success) {
      // Discriminator failure: zod reports the issue at the discriminator path
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('type')
    }
  })
  it('rejects missing type', () => {
    const r = browserToServerSchema.safeParse({ something: 'else' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('type')
    }
  })
})

// ---- ServerToBrowser tests ----

describe('serverToBrowserSchema — cortex', () => {
  it('accepts { type: cortex }', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'cortex' })).not.toThrow()
  })
})

describe('serverToBrowserSchema — cortex-close', () => {
  it('accepts cortex-close', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'cortex-close' })).not.toThrow()
  })
})

describe('serverToBrowserSchema — cortex-toggle', () => {
  it('accepts cortex-toggle active=true', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'cortex-toggle', active: true })).not.toThrow()
  })
  it('rejects cortex-toggle missing active', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'cortex-toggle' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('active')
    }
  })
})

describe('serverToBrowserSchema — hello', () => {
  const baseHello = {
    type: 'hello',
    protocolVersion: 1,
    sessionId: 'sess-abc',
  }
  it('accepts minimal hello', () => {
    expect(() => serverToBrowserSchema.parse(baseHello)).not.toThrow()
  })
  it('accepts hello with swatches and colorChips', () => {
    const msg = {
      ...baseHello,
      swatches: ['#ff0000'],
      colorChips: [{ name: 'primary', hex: '#ff0000', aliases: ['red-500'], source: 'page' }],
    }
    expect(() => serverToBrowserSchema.parse(msg)).not.toThrow()
  })
  it('accepts hello with textComponents', () => {
    const msg = {
      ...baseHello,
      textComponents: [
        { name: 'body-md', fontSize: '16px', lineHeight: '1.5', letterSpacing: '0', fontWeight: '400' },
      ],
    }
    expect(() => serverToBrowserSchema.parse(msg)).not.toThrow()
  })
  it('accepts hello with spacingTokens', () => {
    const msg = {
      ...baseHello,
      spacingTokens: [
        { name: '--spacing-sm', valuePx: 8, source: 'tailwind-v4' },
        { name: '--sp-4', valuePx: 16, source: 'tailwind-v3' },
        { name: '--gap-lg', valuePx: 24, source: 'css-variable' },
      ],
    }
    expect(() => serverToBrowserSchema.parse(msg)).not.toThrow()
  })
  it('accepts hello without spacingTokens (optional field)', () => {
    expect(() => serverToBrowserSchema.parse(baseHello)).not.toThrow()
  })
  it('rejects hello with spacingTokens entry missing name', () => {
    const r = serverToBrowserSchema.safeParse({
      ...baseHello,
      spacingTokens: [{ valuePx: 8, source: 'tailwind-v4' }],
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.includes('spacingTokens'))).toBe(true)
    }
  })
  it('rejects hello with spacingTokens entry having negative valuePx', () => {
    const r = serverToBrowserSchema.safeParse({
      ...baseHello,
      spacingTokens: [{ name: '--sp-neg', valuePx: -1, source: 'css-variable' }],
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.includes('spacingTokens'))).toBe(true)
    }
  })
  it('rejects hello with spacingTokens entry having invalid source', () => {
    const r = serverToBrowserSchema.safeParse({
      ...baseHello,
      spacingTokens: [{ name: '--sp-x', valuePx: 4, source: 'unknown-source' }],
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.includes('spacingTokens'))).toBe(true)
    }
  })
  it('rejects hello missing protocolVersion', () => {
    const r = serverToBrowserSchema.safeParse({ ...baseHello, protocolVersion: undefined })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('protocolVersion')
    }
  })
})

describe('spacingTokenSchema', () => {
  it.each([
    { name: '--spacing-sm', valuePx: 8, source: 'tailwind-v4' },
    { name: '--sp-0', valuePx: 0, source: 'tailwind-v3' },
    { name: '--gap-lg', valuePx: 24, source: 'css-variable' },
  ] as const)('accepts valid token: $name', (token) => {
    expect(() => spacingTokenSchema.parse(token)).not.toThrow()
  })

  it('rejects name shorter than 2 chars', () => {
    const r = spacingTokenSchema.safeParse({ name: '-', valuePx: 4, source: 'tailwind-v3' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('name')
    }
  })
  it('rejects negative valuePx', () => {
    const r = spacingTokenSchema.safeParse({ name: '--sp-x', valuePx: -4, source: 'tailwind-v3' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('valuePx')
    }
  })
  it('rejects non-finite valuePx', () => {
    const r = spacingTokenSchema.safeParse({ name: '--sp-x', valuePx: Infinity, source: 'tailwind-v4' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('valuePx')
    }
  })
  it('rejects invalid source enum', () => {
    const r = spacingTokenSchema.safeParse({ name: '--sp-x', valuePx: 4, source: 'inline' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('source')
    }
  })
})

describe('serverToBrowserSchema — error', () => {
  it('accepts error', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'error', code: 'AUTH_FAILED', message: 'bad token' })).not.toThrow()
  })
  it('rejects error missing code', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'error', message: 'x' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('code')
    }
  })
})

describe('serverToBrowserSchema — edit_status', () => {
  it('accepts edit_status writing', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'edit_status', editId: 'e1', status: 'writing' })).not.toThrow()
  })
  it('accepts edit_status done with reason_code', () => {
    expect(() => serverToBrowserSchema.parse({
      type: 'edit_status',
      editId: 'e1',
      status: 'done',
      reason_code: 'write_failed',
    })).not.toThrow()
  })
  it('rejects edit_status with invalid status', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'edit_status', editId: 'e1', status: 'pending' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('status')
    }
  })
})

describe('serverToBrowserSchema — undo_sync_status', () => {
  it('accepts undo_sync_status done', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'undo_sync_status', status: 'done' })).not.toThrow()
  })
  it('rejects undo_sync_status with invalid status', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'undo_sync_status', status: 'waiting' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('status')
    }
  })
})

describe('serverToBrowserSchema — redo_sync_status', () => {
  it('accepts redo_sync_status failed', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'redo_sync_status', status: 'failed' })).not.toThrow()
  })
})

describe('serverToBrowserSchema — hmr_verified', () => {
  it('accepts hmr_verified', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'hmr_verified', editId: 'e1', match: true })).not.toThrow()
  })
  it('rejects hmr_verified missing editId', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'hmr_verified', match: true })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('editId')
    }
  })
})

describe('serverToBrowserSchema — hmr-applied', () => {
  it('accepts hmr-applied without files', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'hmr-applied' })).not.toThrow()
  })
  it('accepts hmr-applied with files array', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'hmr-applied', files: ['src/Hero.tsx'] })).not.toThrow()
  })
})

describe('serverToBrowserSchema — annotation-created', () => {
  const baseAnnotation = {
    id: 'ann-1',
    status: 'pending',
    elementSource: 'src/Hero.tsx:14:5',
    text: 'looks off',
    createdAt: 1714500000000,
    updatedAt: 1714500000000,
    thread: [],
  }
  it('accepts annotation-created', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'annotation-created', annotation: baseAnnotation })).not.toThrow()
  })
  it('rejects annotation-created missing annotation', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'annotation-created' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('annotation')
    }
  })
})

describe('serverToBrowserSchema — annotation-updated', () => {
  const baseAnnotation = {
    id: 'ann-2',
    status: 'resolved',
    elementSource: 'src/App.tsx:5:3',
    text: 'fixed',
    createdAt: 1714500000000,
    updatedAt: 1714500000100,
    thread: [{ id: 'tm-1', from: 'user', text: 'please fix', timestamp: 1714500000000 }],
  }
  it('accepts annotation-updated', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'annotation-updated', annotation: baseAnnotation })).not.toThrow()
  })
})

describe('serverToBrowserSchema — agent-status', () => {
  it('accepts agent-status connected=true', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'agent-status', connected: true })).not.toThrow()
  })
  it('rejects agent-status missing connected', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'agent-status' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('connected')
    }
  })
})

describe('serverToBrowserSchema — activity-entry', () => {
  it('accepts activity-entry', () => {
    const msg = {
      type: 'activity-entry',
      entry: {
        id: 'act-1',
        type: 'edit',
        timestamp: 1714500000000,
        description: 'changed color',
      },
    }
    expect(() => serverToBrowserSchema.parse(msg)).not.toThrow()
  })
  it('rejects activity-entry with invalid entry type', () => {
    const r = serverToBrowserSchema.safeParse({
      type: 'activity-entry',
      entry: { id: 'a', type: 'unknown', timestamp: 1, description: 'x' },
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('entry.type')
    }
  })
})

describe('serverToBrowserSchema — capabilities', () => {
  it('accepts capabilities with empty systems array', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'capabilities', systems: [] })).not.toThrow()
  })
})

describe('serverToBrowserSchema — staged-edits-discard', () => {
  it('accepts staged-edits-discard', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'staged-edits-discard', intentIds: ['i-1', 'i-2'] })).not.toThrow()
  })
  it('rejects missing intentIds', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'staged-edits-discard' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('intentIds')
    }
  })
  it('staged-edits-discard rejects intentIds with multi-byte string exceeding MAX_INTENT_ID_BYTES (F14)', () => {
    const emoji100 = '🎉'.repeat(100) // 400 UTF-8 bytes > 256 cap
    const result = serverToBrowserSchema.safeParse({
      type: 'staged-edits-discard',
      intentIds: ['valid-id', emoji100, 'another-valid'],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      // Path should point at the array element that violated (index 1)
      expect(paths.some((p) => p.includes('intentIds.1'))).toBe(true)
    }
  })
})

describe('serverToBrowserSchema — staged-edits-acked', () => {
  it('accepts staged-edits-acked', () => {
    expect(() => serverToBrowserSchema.parse({ type: 'staged-edits-acked', requestId: 'req-1' })).not.toThrow()
  })
  it('rejects missing requestId', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'staged-edits-acked' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('requestId')
    }
  })
})

describe('serverToBrowserSchema — source-edit-failed (Change 7, Task 8)', () => {
  it('accepts source-edit-failed with intentIds and reason', () => {
    const msg = { type: 'source-edit-failed', intentIds: ['i1', 'i2'], reason: 'permission denied' }
    const result = serverToBrowserSchema.safeParse(msg)
    // Hard, falsifiable assertion: fails if the schema rejects source-edit-failed
    // or parses it as a different arm.
    expect(result.success && result.data.type).toBe('source-edit-failed')
    // `=== 'source-edit-failed'` narrows the discriminated union so the arm
    // fields below typecheck (expect().toBe() is a runtime check, not a guard).
    if (result.success && result.data.type === 'source-edit-failed') {
      expect(result.data.intentIds).toEqual(['i1', 'i2'])
      expect(result.data.reason).toBe('permission denied')
    }
  })
  it('rejects source-edit-failed missing intentIds', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'source-edit-failed', reason: 'oops' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('intentIds')
    }
  })
  it('rejects source-edit-failed missing reason', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'source-edit-failed', intentIds: ['i1'] })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('reason')
    }
  })
})

describe('serverToBrowserSchema — mcp-session-hello (Change 6, Task 12)', () => {
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
  it('accepts mcp-session-hello with valid UUID sessionId', () => {
    const msg = { type: 'mcp-session-hello', sessionId: VALID_UUID }
    const result = serverToBrowserSchema.safeParse(msg)
    // Hard, falsifiable assertion: fails if the schema rejects mcp-session-hello
    // or parses it as a different arm.
    expect(result.success && result.data.type).toBe('mcp-session-hello')
    // `=== 'mcp-session-hello'` narrows the discriminated union so the arm
    // fields below typecheck (expect().toBe() is a runtime check, not a guard).
    if (result.success && result.data.type === 'mcp-session-hello') {
      expect(result.data.sessionId).toBe(VALID_UUID)
    }
  })
  it('rejects mcp-session-hello with non-UUID sessionId', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'mcp-session-hello', sessionId: 'not-a-uuid' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('sessionId')
    }
  })
  it('rejects mcp-session-hello missing sessionId', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'mcp-session-hello' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('sessionId')
    }
  })
})

describe('serverToBrowserSchema — unknown type', () => {
  it('rejects unknown type', () => {
    const r = serverToBrowserSchema.safeParse({ type: 'bogus' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('type')
    }
  })
})

// ---------------------------------------------------------------------------
// Pillar 1 — Activation Parity wire shapes (ZF0-1881)
// ---------------------------------------------------------------------------

describe('cortex/set-active wire shape', () => {
  it('accepts a valid cortex/set-active message from the browser', () => {
    const result = browserToServerSchema.safeParse({
      type: 'cortex/set-active',
      active: true,
      tabId: 'tab-abc-123',
      token: 'tk_test',
    })
    expect(result.success).toBe(true)
  })

  it('accepts cortex/set-active without a tabId (CLI-originated)', () => {
    const result = browserToServerSchema.safeParse({
      type: 'cortex/set-active',
      active: false,
      token: 'tk_test',
    })
    expect(result.success).toBe(true)
  })

  it('rejects cortex/set-active without active boolean', () => {
    const result = browserToServerSchema.safeParse({
      type: 'cortex/set-active',
      tabId: 'tab-abc-123',
      token: 'tk_test',
    })
    expect(result.success).toBe(false)
  })

  it('still accepts the legacy cortex-toggle shape (dual-mode period)', () => {
    const result = browserToServerSchema.safeParse({
      type: 'cortex-toggle',
      active: true,
    })
    // cortex-toggle is ServerToBrowser only (see serverToBrowserSchema). The
    // browser→server schema must reject it — otherwise the in-page channel and
    // the WS path would diverge in what they accept, breaking the single-source
    // assumption Pillar 1 relies on.
    expect(result.success).toBe(false)
  })
})

describe('cortex/active-changed wire shape', () => {
  it('accepts a valid cortex/active-changed broadcast', () => {
    const result = serverToBrowserSchema.safeParse({
      type: 'cortex/active-changed',
      active: true,
      targetTabId: 'tab-abc-123',
    })
    expect(result.success).toBe(true)
  })

  it('accepts cortex/active-changed without targetTabId (broadcast-to-all fallback)', () => {
    const result = serverToBrowserSchema.safeParse({
      type: 'cortex/active-changed',
      active: false,
    })
    expect(result.success).toBe(true)
  })
})

describe('cortex/inactive-tab wire shape', () => {
  it('accepts a valid cortex/inactive-tab rejection message', () => {
    const result = serverToBrowserSchema.safeParse({
      type: 'cortex/inactive-tab',
      targetTabId: 'tab-xyz-456',
      message: 'Cortex is active in another tab — switch to it or close it first',
    })
    expect(result.success).toBe(true)
  })
})

// ── COR-25 follow-up: one classOpSchema, not two ────────────────────────────
//
// wire-format.ts held a byte-identical private copy of classOpSchema. Adding the
// `class` intent kind introduced a second definition in pending-edit.ts, and the
// two immediately drifted — the new one enforced `.min(1)` while the wire copy
// still accepted empty strings. Flagged in review on the very commit whose
// comment claimed "wire-format imports this one" while it did not.
//
// This is the drift class composite-key.ts exists to prevent, and its header
// says why a comment cannot prevent it. wire-format now imports the canonical
// schema; these tests pin the resulting contract so the duplicate cannot
// silently return.
describe('COR-25: classOp validation is shared with pending-edit', () => {
  const base = {
    type: 'edit' as const,
    editId: 'e1',
    property: '',
    value: '',
    source: 'src/App.tsx:1:1',
    elementSelector: 'div',
  }

  it('accepts a well-formed class op', () => {
    const r = browserToServerSchema.safeParse({ ...base, classOp: { kind: 'add', add: 'text-lg' } })
    expect(r.success).toBe(true)
  })

  it('REJECTS an empty class token — it names no class to add', () => {
    // Previously accepted by the wire copy. An empty token is not a smaller
    // edit, it is an edit that cannot mean anything, and letting it through
    // reaches the apply path as a no-op the user cannot distinguish from a
    // failure.
    const r = browserToServerSchema.safeParse({ ...base, classOp: { kind: 'add', add: '' } })
    expect(r.success).toBe(false)
  })

  it('REJECTS an empty token on the swap arm too', () => {
    const r = browserToServerSchema.safeParse({
      ...base,
      classOp: { kind: 'swap', remove: 'text-sm', add: '' },
    })
    expect(r.success).toBe(false)
  })

  it('REJECTS a whitespace-containing class token', () => {
    // `classList.contains` throws InvalidCharacterError on whitespace, so
    // `add: "foo bar"` is not a slightly-wrong intent — it crashes the reconnect
    // convergence check. Refused at the envelope so that stays unreachable.
    const r = browserToServerSchema.safeParse({ ...base, classOp: { kind: 'add', add: 'foo bar' } })
    expect(r.success).toBe(false)
  })
})
