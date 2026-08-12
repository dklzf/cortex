import { describe, it, expect, afterEach } from 'vitest'
import { ToolApplicator } from '../../src/core/tool-applicator.js'
import type { ToolAction } from '../../src/core/tool-applicator.js'

// ── Helpers ───────────────────────────────────────────────────────

let applicator: ToolApplicator

function fresh(): ToolApplicator {
  applicator = new ToolApplicator()
  return applicator
}

afterEach(() => {
  applicator?.dispose()
})

// ── set_inline_style ──────────────────────────────────────────────

describe('set_inline_style', () => {
  it('adds style prop to element with no style', async () => {
    const source = `export function App() {
  return <div className="hero">Hello</div>
}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'set_inline_style',
      changes: [{ property: 'padding-top', value: '16px' }],
    }
    const result = await ta.apply(source, 'test.tsx', 2, 10, action)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('style={{ paddingTop: "16px" }}')
    }
  })

  it('adds property to existing style={{ color: "red" }}', async () => {
    const source = `export function App() {
  return <div style={{ color: "red" }}>Hello</div>
}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'set_inline_style',
      changes: [{ property: 'padding-top', value: '16px' }],
    }
    const result = await ta.apply(source, 'test.tsx', 2, 10, action)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('color: "red"')
      expect(result.content).toContain('paddingTop: "16px"')
    }
  })

  it('updates existing property value', async () => {
    const source = `export function App() {
  return <div style={{ paddingTop: "8px" }}>Hello</div>
}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'set_inline_style',
      changes: [{ property: 'padding-top', value: '16px' }],
    }
    const result = await ta.apply(source, 'test.tsx', 2, 10, action)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('paddingTop: "16px"')
      expect(result.content).not.toContain('"8px"')
    }
  })

  it('wraps non-literal expression with spread: style={myStyles}', async () => {
    const source = `export function App() {
  return <div style={myStyles}>Hello</div>
}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'set_inline_style',
      changes: [{ property: 'padding-top', value: '16px' }],
    }
    const result = await ta.apply(source, 'test.tsx', 2, 10, action)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('...myStyles')
      expect(result.content).toContain('paddingTop: "16px"')
    }
  })

  it('applies multiple changes in one call', async () => {
    const source = `export function App() {
  return <div>Hello</div>
}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'set_inline_style',
      changes: [
        { property: 'padding-top', value: '16px' },
        { property: 'color', value: 'red' },
        { property: 'font-size', value: '14px' },
      ],
    }
    const result = await ta.apply(source, 'test.tsx', 2, 10, action)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('paddingTop: "16px"')
      expect(result.content).toContain('color: "red"')
      expect(result.content).toContain('fontSize: "14px"')
    }
  })

  it('returns failure when no JSX element at position', async () => {
    const source = `const x = 42\n`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'set_inline_style',
      changes: [{ property: 'padding-top', value: '16px' }],
    }
    const result = await ta.apply(source, 'test.tsx', 1, 1, action)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('No JSX element found')
    }
  })

  it('handles CSS custom property with quoted key', async () => {
    const source = `export function App() {
  return <div>Hello</div>
}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'set_inline_style',
      changes: [{ property: '--my-color', value: 'blue' }],
    }
    const result = await ta.apply(source, 'test.tsx', 2, 10, action)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('"--my-color": "blue"')
    }
  })

  it('converts kebab-case to camelCase', async () => {
    const source = `export function App() {
  return <div>Hello</div>
}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'set_inline_style',
      changes: [{ property: 'padding-top', value: '8px' }],
    }
    const result = await ta.apply(source, 'test.tsx', 2, 10, action)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('paddingTop:')
      expect(result.content).not.toContain('padding-top')
    }
  })

  it('bails on shorthand property assignment', async () => {
    const source = `export function App({ paddingTop }: { paddingTop: string }) {
  return <div style={{ paddingTop }}>Hello</div>
}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'set_inline_style',
      changes: [{ property: 'padding-top', value: '16px' }],
    }
    const result = await ta.apply(source, 'test.tsx', 2, 10, action)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('shorthand')
    }
  })
})

// ── replace_attribute ─────────────────────────────────────────────

describe('replace_attribute', () => {
  it('adds new attribute to element', async () => {
    const source = `export function App() {
  return <div>Hello</div>
}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'replace_attribute',
      attribute: 'className',
      value: '"flex gap-4"',
    }
    const result = await ta.apply(source, 'test.tsx', 2, 10, action)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('className="flex gap-4"')
    }
  })

  it('updates existing attribute', async () => {
    const source = `export function App() {
  return <div className="old-class">Hello</div>
}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'replace_attribute',
      attribute: 'className',
      value: '"flex gap-4"',
    }
    const result = await ta.apply(source, 'test.tsx', 2, 10, action)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('className="flex gap-4"')
      expect(result.content).not.toContain('old-class')
    }
  })

  it('handles expression value', async () => {
    const source = `export function App() {
  return <div className="old">Hello</div>
}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'replace_attribute',
      attribute: 'className',
      value: '{styles.hero}',
    }
    const result = await ta.apply(source, 'test.tsx', 2, 10, action)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('className={styles.hero}')
      expect(result.content).not.toContain('old')
    }
  })

  it('returns failure when element not found', async () => {
    const source = `const x = 42\n`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'replace_attribute',
      attribute: 'className',
      value: '"flex"',
    }
    const result = await ta.apply(source, 'test.tsx', 1, 1, action)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('No JSX element found')
    }
  })
})

// ── replace_line_content ──────────────────────────────────────────

describe('replace_line_content', () => {
  it('replaces exact match', async () => {
    const source = `line one\nline two\nline three`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'replace_line_content',
      lineNumber: 2,
      oldContent: 'line two',
      newContent: 'replaced line',
    }
    const result = await ta.apply(source, 'test.tsx', 0, 0, action)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toBe('line one\nreplaced line\nline three')
    }
  })

  it('REJECTS an edit 19 lines from the target — COR-28\'s real offset (COR-29)', async () => {
    // MAX_PROXIMITY was 25, derived from the AI's context-window half-width —
    // from what the model can SEE, not from what a real anchor error looks
    // like. COR-28's actual offset was 19, so the one distance-based guard in
    // the codebase passed the real bug with six lines to spare. A threshold set
    // above the observed error distribution is decoration, not defense.
    const source = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const ta = fresh()
    const action: ToolAction = {
      tool: 'replace_line_content',
      lineNumber: 21,
      oldContent: 'line 21',
      newContent: 'pwned',
    }
    // Target line 2, edit at 21 — a 19-line reach, exactly COR-28's shape.
    const result = await ta.apply(source, 'test.tsx', 2, 0, action)

    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toContain('too far from target line')
  })

  it('still allows an ordinary few-line reach', async () => {
    // The guard must not become so tight it blocks the legitimate case it
    // exists to permit: an edit landing a little off after an unrelated
    // in-file change.
    const source = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const ta = fresh()
    const action: ToolAction = {
      tool: 'replace_line_content',
      lineNumber: 7,
      oldContent: 'line 7',
      newContent: 'line seven',
    }
    const result = await ta.apply(source, 'test.tsx', 2, 0, action)
    expect(result.success).toBe(true)
  })

  it('matches with trimmed comparison (preserving indentation)', async () => {
    const source = `function App() {\n  return <div>Hello</div>\n}`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'replace_line_content',
      lineNumber: 2,
      oldContent: 'return <div>Hello</div>',
      newContent: 'return <div>World</div>',
    }
    const result = await ta.apply(source, 'test.tsx', 0, 0, action)

    expect(result.success).toBe(true)
    if (result.success) {
      // Preserved original 2-space indent
      expect(result.content).toBe('function App() {\n  return <div>World</div>\n}')
    }
  })

  it('rejects when oldContent does not match', async () => {
    const source = `line one\nline two\nline three`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'replace_line_content',
      lineNumber: 2,
      oldContent: 'wrong content',
      newContent: 'replaced',
    }
    const result = await ta.apply(source, 'test.tsx', 0, 0, action)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('does not match')
    }
  })

  it('rejects out-of-bounds line number', async () => {
    const source = `line one\nline two`
    const ta = fresh()
    const action: ToolAction = {
      tool: 'replace_line_content',
      lineNumber: 5,
      oldContent: 'anything',
      newContent: 'replaced',
    }
    const result = await ta.apply(source, 'test.tsx', 0, 0, action)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('out of bounds')
    }
  })
})

// ── General ───────────────────────────────────────────────────────

describe('general', () => {
  it('disposed applicator returns error', async () => {
    const ta = new ToolApplicator()
    ta.dispose()
    applicator = ta // for afterEach cleanup

    const action: ToolAction = {
      tool: 'set_inline_style',
      changes: [{ property: 'color', value: 'red' }],
    }
    const result = await ta.apply('', 'test.tsx', 1, 1, action)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('disposed')
    }
  })
})
