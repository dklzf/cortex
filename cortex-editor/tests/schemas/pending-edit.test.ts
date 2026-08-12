import { describe, it, expect } from 'vitest'
import { pendingEditSchema } from '../../src/schemas/pending-edit.js'

// Valid baseline fixture
const validEdit = {
  intentId: 'intent-abc',
  source: 'src/Hero.tsx:14:5',
  property: 'color',
  value: 'red',
  previousValue: '',
  timestamp: 1714500000000,
}

describe('pendingEditSchema — valid inputs', () => {
  it('accepts a minimal valid edit', () => {
    expect(() => pendingEditSchema.parse(validEdit)).not.toThrow()
  })

  it('accepts optional pseudo field ::before', () => {
    expect(() => pendingEditSchema.parse({ ...validEdit, pseudo: '::before' })).not.toThrow()
  })

  it('accepts optional pseudo field ::after', () => {
    expect(() => pendingEditSchema.parse({ ...validEdit, pseudo: '::after' })).not.toThrow()
  })

  it('accepts optional scope: instance', () => {
    expect(() => pendingEditSchema.parse({ ...validEdit, scope: 'instance' })).not.toThrow()
  })

  it('accepts optional scope: all', () => {
    expect(() => pendingEditSchema.parse({ ...validEdit, scope: 'all' })).not.toThrow()
  })

  it('accepts agent-resolve preview metadata for unannotated visual elements', () => {
    expect(() => pendingEditSchema.parse({
      ...validEdit,
      source: 'cortex-preview:p123',
      applyMode: 'agent-resolve',
      sourceResolutionHint: {
        tagName: 'div',
        className: 'hero-card',
        textPreview: 'Unannotated hero',
        domSelector: 'div.hero-card',
      },
    })).not.toThrow()
  })

  it('accepts instanceSources array up to 100 entries', () => {
    const sources = Array.from({ length: 100 }, (_, i) => `src/Comp.tsx:${i}:5`)
    expect(() => pendingEditSchema.parse({ ...validEdit, instanceSources: sources })).not.toThrow()
  })

  it('returns data with correct shape', () => {
    const parsed = pendingEditSchema.parse(validEdit)
    expect(parsed.intentId).toBe('intent-abc')
    expect(parsed.source).toBe('src/Hero.tsx:14:5')
    expect(parsed.timestamp).toBe(1714500000000)
  })
})

describe('pendingEditSchema — invalid inputs', () => {
  it('rejects missing intentId', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, intentId: undefined })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('intentId')
    }
  })

  it('rejects intentId that is empty string', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, intentId: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('intentId')
    }
  })

  it('rejects intentId exceeding MAX_INTENT_ID_BYTES (256)', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, intentId: 'x'.repeat(257) })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('intentId')
    }
  })

  it('rejects source exceeding MAX_INTENT_SOURCE_BYTES (1024)', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, source: 'x'.repeat(1025) })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('source')
    }
  })

  it('rejects empty source', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, source: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('source')
    }
  })

  it('rejects property exceeding MAX_INTENT_PROPERTY_BYTES (256)', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, property: 'x'.repeat(257) })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('property')
    }
  })

  it('rejects empty property', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, property: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('property')
    }
  })

  it('rejects value exceeding MAX_INTENT_VALUE_BYTES (4096)', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, value: 'x'.repeat(4097) })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('value')
    }
  })

  it('rejects previousValue exceeding MAX_INTENT_VALUE_BYTES (4096)', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, previousValue: 'x'.repeat(4097) })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('previousValue')
    }
  })

  it('rejects pseudo with invalid value (null)', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, pseudo: null })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('pseudo')
    }
  })

  it('rejects pseudo with arbitrary string', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, pseudo: ':focus' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('pseudo')
    }
  })

  it('rejects invalid applyMode', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, applyMode: 'maybe-agent' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('applyMode')
    }
  })

  it('rejects incomplete sourceResolutionHint', () => {
    const result = pendingEditSchema.safeParse({
      ...validEdit,
      applyMode: 'agent-resolve',
      sourceResolutionHint: { tagName: 'div', textPreview: 'Hero' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('sourceResolutionHint.domSelector')
    }
  })

  it('rejects agent-resolve edits without sourceResolutionHint', () => {
    const result = pendingEditSchema.safeParse({
      ...validEdit,
      source: 'cortex-preview:p123',
      applyMode: 'agent-resolve',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('sourceResolutionHint')
    }
  })

  it('rejects preview-source edits without sourceResolutionHint even when applyMode is omitted', () => {
    const result = pendingEditSchema.safeParse({
      ...validEdit,
      source: 'cortex-preview:p123',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('sourceResolutionHint')
    }
  })

  it('rejects instanceSources exceeding 100 entries', () => {
    const sources = Array.from({ length: 101 }, (_, i) => `src/Comp.tsx:${i}:5`)
    const result = pendingEditSchema.safeParse({ ...validEdit, instanceSources: sources })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.startsWith('instanceSources'))).toBe(true)
    }
  })

  it('rejects instanceSources entry exceeding MAX_INTENT_SOURCE_BYTES', () => {
    const sources = ['x'.repeat(1025)]
    const result = pendingEditSchema.safeParse({ ...validEdit, instanceSources: sources })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.startsWith('instanceSources'))).toBe(true)
    }
  })

  it('rejects non-finite timestamp', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, timestamp: NaN })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('timestamp')
    }
  })

  it('rejects non-number timestamp', () => {
    const result = pendingEditSchema.safeParse({ ...validEdit, timestamp: 'now' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('timestamp')
    }
  })

  it('rejects completely missing required fields', () => {
    const result = pendingEditSchema.safeParse({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// PR #94 F2: UTF-8 byte length enforcement
//
// z.string().max(N) counts UTF-16 code units (JS string.length), not UTF-8 bytes.
// These tests verify the schema enforces UTF-8 byte limits as the constants imply.
// ---------------------------------------------------------------------------

describe('pendingEditSchema — UTF-8 byte limits (F2)', () => {
  it('accepts a 200-char ASCII intentId (200 bytes < 256-byte cap)', () => {
    // ASCII chars are 1 byte each — byte count equals char count.
    const result = pendingEditSchema.safeParse({ ...validEdit, intentId: 'x'.repeat(200) })
    expect(result.success).toBe(true)
  })

  it('rejects a 100-char emoji intentId (400 UTF-8 bytes > 256-byte cap)', () => {
    // 🎉 is U+1F389, which encodes as 4 UTF-8 bytes. 100 × 4 = 400 bytes > 256.
    // JS string.length would count this as 200 (2 UTF-16 code units per emoji),
    // which would pass a naive .max(256) check — proving we need TextEncoder.
    const emoji100 = '🎉'.repeat(100)
    const result = pendingEditSchema.safeParse({ ...validEdit, intentId: emoji100 })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('intentId')
    }
  })

  it('accepts a 100-char emoji value (400 bytes < 4096-byte cap)', () => {
    // 100 × 4 = 400 bytes; well within the 4096-byte value cap.
    const emoji100 = '🎉'.repeat(100)
    const result = pendingEditSchema.safeParse({ ...validEdit, value: emoji100 })
    expect(result.success).toBe(true)
  })

  it('rejects a 100-char emoji property (400 bytes > 256-byte cap)', () => {
    const emoji100 = '🎉'.repeat(100)
    const result = pendingEditSchema.safeParse({ ...validEdit, property: emoji100 })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('property')
    }
  })

  it('accepts a 100-char emoji source (400 bytes > the default 256; well within source 1024-byte cap, but tests byte counting)', () => {
    // source cap is 1024 bytes; 100 × 4 = 400 bytes passes.
    const emojiSource = '🎉'.repeat(100) + ':1:1'  // still a "source" string
    const result = pendingEditSchema.safeParse({ ...validEdit, source: emojiSource })
    // 100 × 4 = 400 bytes < 1024 → should pass
    expect(result.success).toBe(true)
  })

  it('accepts a 256-char emoji source (1024 UTF-8 bytes = source cap — boundary)', () => {
    // 256 × 4 = 1024 bytes = MAX_INTENT_SOURCE_BYTES → should pass (equal = within limit).
    const emojiSource = '🎉'.repeat(256)
    const result = pendingEditSchema.safeParse({ ...validEdit, source: emojiSource })
    // Exactly at the limit — valid
    expect(result.success).toBe(true)
  })

  it('rejects a 257-char emoji source (1028 UTF-8 bytes > 1024-byte cap)', () => {
    const emojiSource = '🎉'.repeat(257)
    const result = pendingEditSchema.safeParse({ ...validEdit, source: emojiSource })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('source')
    }
  })
})

describe('COR-25: class intents must be agent-resolve', () => {
  const base = {
    kind: 'class' as const,
    intentId: 'c1',
    source: 'cortex-preview:p1',
    classOp: { kind: 'add' as const, add: 'text-lg' },
    timestamp: 1,
  }

  it('REJECTS a forged direct-mode class intent', () => {
    // The direct path writes className at a file position and never stages, so
    // a `direct` class intent can only come from a forged `staged-edit-add`.
    // Accepting it meant no hint was required, and serializeForAgent fences only
    // payloads carrying a sourceResolutionHint — so an attacker-chosen `source`
    // reached the agent UNFENCED.
    const r = pendingEditSchema.safeParse({ ...base, applyMode: 'direct' })
    expect(r.success).toBe(false)
  })

  it('REJECTS a class intent with no applyMode at all', () => {
    const r = pendingEditSchema.safeParse(base)
    expect(r.success).toBe(false)
  })

  it('accepts the agent-resolve shape with a hint', () => {
    const r = pendingEditSchema.safeParse({
      ...base,
      applyMode: 'agent-resolve',
      sourceResolutionHint: { tagName: 'div', textPreview: '', domSelector: 'div' },
    })
    expect(r.success).toBe(true)
  })
})
