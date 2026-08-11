import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createSourceTransform } from '../../src/adapters/source-transform.js'

// ── Real files on disk, by design (COR-28) ──────────────────────────────────
//
// These tests used to pass synthetic code with a synthetic id like
// '/project/src/App.tsx' — a path that does not exist. The transform now
// verifies that the text it was handed IS the file at that id before stamping
// any position (the provenance guard), because a position measured against one
// string and applied against another is how COR-28 wrote edits to the wrong
// element. Against nonexistent paths every one of these tests silently took the
// refusal branch and asserted nothing about stamping.
//
// PROJECT_ROOT is therefore a REAL temp directory that MIRRORS the old virtual
// layout: a virtual id '/project/src/App.tsx' maps to '<tmp>/src/App.tsx'. Since
// the transform emits `path.relative(projectRoot, id)`, the relative path is
// still 'src/App.tsx' and every existing assertion holds verbatim — while the
// suite now exercises the real disk path instead of the fail-open branch.
const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-st-'))
const PROJECT_ROOT = path.join(TMP_BASE, 'project')
// Sibling of PROJECT_ROOT, so ids that are meant to be OUTSIDE the project root
// really are — otherwise the path-traversal tests would silently pass by testing
// a path we had quietly relocated inside the root.
const OUTSIDE_ROOT = path.join(TMP_BASE, 'outside')
fs.mkdirSync(PROJECT_ROOT, { recursive: true })
fs.mkdirSync(OUTSIDE_ROOT, { recursive: true })

/** Map a virtual id onto a real file and write `code` there.
 *
 *  '/project/...' maps under PROJECT_ROOT; any other absolute id maps under
 *  OUTSIDE_ROOT, preserving its own directory shape so basename-derivation and
 *  containment tests still exercise what they claim to. */
function materialize(code: string, virtualId: string): string {
  const inProject = virtualId.startsWith('/project/')
  const base = inProject ? PROJECT_ROOT : OUTSIDE_ROOT
  const rel = inProject ? virtualId.slice('/project/'.length) : virtualId.replace(/^\/+/, '')
  // Preserve any query suffix (e.g. '?v=abc') — the transform strips it itself,
  // but the file must be written without it.
  const qIndex = rel.indexOf('?')
  const relPath = qIndex === -1 ? rel : rel.slice(0, qIndex)
  const query = qIndex === -1 ? '' : rel.slice(qIndex)
  const realPath = path.join(base, relPath)
  fs.mkdirSync(path.dirname(realPath), { recursive: true })
  fs.writeFileSync(realPath, code, 'utf8')
  return realPath + query
}

/** Build a transform over the real temp root that materializes each input before
 *  running. Drop-in replacement for a direct `createSourceTransform(root, opts)` —
 *  call sites keep passing virtual '/project/...' ids and this maps them to real
 *  files on disk. */
function mk(options?: Parameters<typeof createSourceTransform>[1]) {
  const inner = createSourceTransform(PROJECT_ROOT, options)
  return (code: string, virtualId = '/project/src/App.tsx') =>
    inner(code, materialize(code, virtualId))
}

/** Transform WITHOUT materializing — for provenance tests that need to control
 *  the on-disk content and the passed-in code independently. Takes a real path. */
const transformSource_raw = createSourceTransform(PROJECT_ROOT)

// Materializes on every call, so direct `transformSource(code, id)` call sites
// throughout this file keep working with virtual ids and no per-site edits.
const transformSource = mk()

function transform(code: string, id = '/project/src/App.tsx'): string {
  const result = transformSource(code, id)
  return result?.code ?? code
}

/** Returns the raw TransformResult | null — use when you need to distinguish null from unchanged. */
function transformRaw(code: string, id = '/project/src/App.tsx') {
  return transformSource(code, id)
}

// Every test materializes real files; remove the tree so repeated runs do not
// accumulate temp directories.
afterAll(() => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true })
})

describe('transformSource', () => {
  describe('basic JSX instrumentation', () => {
    it('instruments a simple HTML tag', () => {
      const result = transform('<div className="foo">x</div>')
      expect(result).toContain('<div data-cortex-source="src/App.tsx:1:1"')
      expect(result).toContain('className="foo"')
    })

    it('instruments multiple tags', () => {
      const result = transform('<div><span>hello</span></div>')
      expect(result).toContain('<div data-cortex-source=')
      expect(result).toContain('<span data-cortex-source=')
    })

    it('instruments self-closing tags', () => {
      const result = transform('<input type="text" />')
      expect(result).toContain('<input data-cortex-source=')
    })

    it('instruments nested elements across lines', () => {
      const code = `<div>
  <span>
    <p>nested</p>
  </span>
</div>`
      const result = transform(code)
      expect(result).toContain('data-cortex-source="src/App.tsx:1:')
      expect(result).toContain('data-cortex-source="src/App.tsx:2:')
      expect(result).toContain('data-cortex-source="src/App.tsx:3:')
    })
  })

  describe('custom elements', () => {
    it('handles kebab-case custom elements', () => {
      const result = transform('<my-card />')
      expect(result).toContain('<my-card data-cortex-source=')
      expect(result).not.toMatch(/<my\s.*-card/)
    })

    it('handles multi-segment kebab-case elements', () => {
      const result = transform('<my-super-card />')
      expect(result).toContain('<my-super-card data-cortex-source=')
    })
  })

  describe('TypeScript generics (must not instrument)', () => {
    it('skips generic type parameters like Array<string>', () => {
      const code = 'const arr: Array<string> = []'
      const result = transform(code)
      expect(result).not.toContain('data-cortex-source')
    })

    it('skips useState<number>()', () => {
      const code = 'const [val, setVal] = useState<number>(0)'
      const result = transform(code)
      expect(result).not.toContain('data-cortex-source')
    })

    it('skips function generics like foo<type>()', () => {
      const code = 'function parse<T>(input: string): T { return input as T }'
      const result = transform(code)
      expect(result).not.toContain('data-cortex-source')
    })

    it('skips Map<string, number>', () => {
      const code = 'const m: Map<string, number> = new Map()'
      const result = transform(code)
      expect(result).not.toContain('data-cortex-source')
    })

    it('instruments real JSX after a generic type', () => {
      const code = 'const arr: Array<string> = []\nconst el = <div>hello</div>'
      const result = transform(code)
      expect(result).not.toMatch(/Array<string data-cortex/)
      expect(result).toContain('<div data-cortex-source=')
    })
  })

  describe('regex literals (must not instrument)', () => {
    it('skips tags inside regex literals', () => {
      const code = 'const re = /<div>/g'
      const result = transform(code)
      expect(result).not.toContain('data-cortex-source')
    })

    it('instruments real JSX after a regex literal', () => {
      const code = 'const re = /<br>/g\nconst el = <span>hi</span>'
      const result = transform(code)
      expect(result).not.toMatch(/<br data-cortex/)
      expect(result).toContain('<span data-cortex-source=')
    })

    it('skips regex in assignment with complex pattern', () => {
      const code = 'const tagRe = /<([a-z]+)\\b/g'
      const result = transform(code)
      expect(result).not.toContain('data-cortex-source')
    })

    it('skips regex after opening paren', () => {
      const code = 'if (/<div>/.test(s)) {}'
      const result = transform(code)
      expect(result).not.toContain('data-cortex-source')
    })

    it('handles regex with escaped bracket', () => {
      const code = 'const re = /\\[/;\nconst el = <div />'
      const result = transform(code)
      expect(result).toContain('<div data-cortex-source=')
    })

    it('handles regex with d and v flags', () => {
      const code = 'const re = /<div>/dv\nconst el = <span />'
      const result = transform(code)
      expect(result).not.toMatch(/<div data-cortex/)
      expect(result).toContain('<span data-cortex-source=')
    })
  })

  describe('template literal expressions', () => {
    it('skips tags in template literal string portions', () => {
      const code = 'const s = `<div class="test">`'
      const result = transform(code)
      expect(result).not.toContain('data-cortex-source')
    })

    it('instruments JSX inside ${}', () => {
      const code = 'const el = `${<div>hello</div>}`'
      const result = transform(code, '/project/src/App.tsx')
      expect(result).toContain('<div data-cortex-source=')
    })

    it('handles nested objects in expressions like style={{}}', () => {
      const code = 'const el = `${<div style={{color: "red"}}>hi</div>}`'
      const result = transform(code, '/project/src/App.tsx')
      expect(result).toContain('<div data-cortex-source=')
    })

    it('handles string with brace inside template expression', () => {
      const code = 'const x = `${fn("}")}`\nconst el = <div />'
      const result = transform(code)
      expect(result).toContain('<div data-cortex-source=')
    })

    it('handles comment inside template expression', () => {
      const code = 'const x = `${/* } */ val}`\nconst el = <div />'
      const result = transform(code)
      expect(result).toContain('<div data-cortex-source=')
    })

    it('skips tags in template string between expressions', () => {
      const code = 'const s = `before <div> ${expr} after <span>`'
      const result = transform(code)
      expect(result).not.toContain('data-cortex-source')
    })
  })

  describe('idempotency', () => {
    it('is idempotent — AST-level check prevents double-instrument', () => {
      const first = transformRaw('<div className="foo">x</div>')
      expect(first).not.toBeNull()
      expect(first!.code).toContain('data-cortex-source')
      // Second pass: AST-level check detects existing attribute, returns null
      const second = transformRaw(first!.code)
      expect(second).toBeNull()
    })

    it('still instruments when data-cortex-source= appears in a string literal', () => {
      const code = `const s = 'data-cortex-source="foo"'\nconst el = <div>real</div>`
      const result = transformRaw(code)
      expect(result).not.toBeNull()
      expect(result!.code).toContain('<div data-cortex-source=')
    })
  })

  describe('skip ranges — strings', () => {
    it('skips tags inside single-quoted strings', () => {
      const result = transform(`const s = '<div class="test">'`)
      expect(result).not.toContain('data-cortex-source')
    })

    it('skips tags inside double-quoted strings', () => {
      const result = transform(`const s = "<div class='test'>"`)
      expect(result).not.toContain('data-cortex-source')
    })

    it('skips tags inside strings with escaped quotes', () => {
      const result = transform(`const s = 'it\\'s a <div>'`)
      expect(result).not.toContain('data-cortex-source')
    })
  })

  describe('skip ranges — comments', () => {
    it('skips tags inside single-line comments', () => {
      const result = transform('// <div className="test">')
      expect(result).not.toContain('data-cortex-source')
    })

    it('skips tags inside block comments', () => {
      const result = transform('/* <div className="test"> */')
      expect(result).not.toContain('data-cortex-source')
    })

    it('skips tags inside multi-line block comments', () => {
      const code = `/*
 * <div>
 *   <span>comment</span>
 * </div>
 */`
      const result = transform(code)
      expect(result).not.toContain('data-cortex-source')
    })
  })

  describe('mixed real JSX and skip ranges', () => {
    it('instruments real JSX next to a string containing tags', () => {
      const code = `const s = '<div>'; const el = <span>hello</span>`
      const result = transform(code)
      expect(result).not.toMatch(/<div data-cortex-source/)
      expect(result).toContain('<span data-cortex-source=')
    })

    it('instruments real JSX after a comment containing tags', () => {
      const code = `// <div> not real\n<span>real</span>`
      const result = transform(code)
      expect(result).not.toMatch(/<div data-cortex-source/)
      expect(result).toContain('<span data-cortex-source=')
    })
  })

  describe('JSX patterns — loops and fragments', () => {
    it('instruments tags inside map callbacks', () => {
      const code = `items.map(item => <li key={item.id}>{item.name}</li>)`
      const result = transform(code)
      expect(result).toContain('<li data-cortex-source=')
    })

    it('does not instrument uppercase components', () => {
      const code = `<MyComponent><div>inside</div></MyComponent>`
      const result = transform(code)
      expect(result).not.toMatch(/<MyComponent data-cortex-source/)
      expect(result).toContain('<div data-cortex-source=')
    })

    it('does not instrument React fragments (<>)', () => {
      const code = `<><div>a</div><span>b</span></>`
      const result = transform(code)
      expect(result).toContain('<div data-cortex-source=')
      expect(result).toContain('<span data-cortex-source=')
      expect(result.startsWith('<>')).toBe(true)
    })
  })

  describe('file filtering', () => {
    it('returns null for .ts files (not JSX)', () => {
      expect(transformSource('<div />', '/project/src/App.ts')).toBeNull()
    })

    it('returns null for .js files (not JSX)', () => {
      expect(transformSource('<div />', '/project/src/App.js')).toBeNull()
    })

    it('transforms .jsx files', () => {
      const result = transformSource('<div />', '/project/src/App.jsx')
      expect(result).not.toBeNull()
      expect(result!.code).toContain('data-cortex-source')
    })

    it('transforms .tsx files', () => {
      const result = transformSource('<div />', '/project/src/App.tsx')
      expect(result).not.toBeNull()
      expect(result!.code).toContain('data-cortex-source')
    })

    it('returns null for node_modules files', () => {
      expect(transformSource('<div />', '/project/node_modules/pkg/App.tsx')).toBeNull()
    })

    it('returns null for cortex-editor package in node_modules', () => {
      expect(transformSource('<div />', '/project/node_modules/cortex-editor/src/App.tsx')).toBeNull()
    })

    it('does NOT filter user files that happen to contain cortex-editor in path', () => {
      const result = transformSource('<div />', '/project/cortex-editor/src/App.tsx')
      // This is a user's own file (not in node_modules), should be transformed
      expect(result).not.toBeNull()
    })

    it('does not skip files in directories containing node_modules substring', () => {
      const result = transformSource('<div />', '/project/not_node_modules/App.tsx')
      expect(result).not.toBeNull()
    })

    it('returns null when no JSX tags are found', () => {
      expect(transformSource('const x = 1', '/project/src/App.tsx')).toBeNull()
    })

    it('transforms files with Vite HMR query params', () => {
      const result = transformSource('<div />', '/project/src/App.tsx?v=abc123')
      expect(result).not.toBeNull()
      expect(result!.code).toContain('data-cortex-source="src/App.tsx:')
    })

    it('transforms files with multiple query params', () => {
      const result = transformSource('<div />', '/project/src/App.tsx?t=123&v=abc')
      expect(result).not.toBeNull()
      expect(result!.code).toContain('data-cortex-source="src/App.tsx:')
    })

    it('still filters non-JSX files with query params', () => {
      expect(transformSource('<div />', '/project/src/App.ts?v=abc')).toBeNull()
    })

    it('still filters node_modules with query params', () => {
      expect(transformSource('<div />', '/project/node_modules/pkg/App.tsx?v=abc')).toBeNull()
    })

    it('transforms included node_modules packages', () => {
      const t = mk({ includeNodeModules: ['@test-lib'] })
      const result = t('<div />', '/project/node_modules/@test-lib/Button.tsx')
      expect(result).not.toBeNull()
      expect(result!.code).toContain('data-cortex-source')
    })

    it('still skips non-included node_modules when includeNodeModules is set', () => {
      const t = mk({ includeNodeModules: ['@test-lib'] })
      expect(t('<div />', '/project/node_modules/other-pkg/App.tsx')).toBeNull()
    })

    it('uses segment matching for includeNodeModules (no substring false positives)', () => {
      const t = mk({ includeNodeModules: ['lib'] })
      // 'my-lib' contains 'lib' as substring but not as a path segment
      expect(t('<div />', '/project/node_modules/my-lib/App.tsx')).toBeNull()
      // 'lib' as exact segment should match
      const result = t('<div />', '/project/node_modules/lib/App.tsx')
      expect(result).not.toBeNull()
    })
  })

  describe('source location accuracy', () => {
    it('tracks correct line numbers across multiple lines', () => {
      const code = `const x = 1
const y = 2
const el = <div>
  <span />
</div>`
      const result = transform(code)
      expect(result).toContain('data-cortex-source="src/App.tsx:3:')
      expect(result).toContain('data-cortex-source="src/App.tsx:4:')
    })

    it('uses forward slashes in file paths on all platforms', () => {
      const result = transformSource(
        '<div />',
        '/project/src/components/Button.tsx',
      )
      expect(result!.code).toContain('src/components/Button.tsx')
      expect(result!.code).not.toContain('\\')
    })
  })

  describe('exact output format', () => {
    it('places attribute immediately after tag name', () => {
      const result = transform('<div className="foo">x</div>')
      expect(result).toMatch(/<div data-cortex-source="src\/App\.tsx:1:1" className="foo">/)
    })

    it('produces correct format for self-closing tag', () => {
      const result = transform('<input />')
      expect(result).toMatch(/<input data-cortex-source="src\/App\.tsx:1:1" \/>/)
    })

    it('produces correct line:col for multi-line input', () => {
      const code = 'const x = 1\nconst el = <div />'
      const result = transform(code)
      expect(result).toContain('data-cortex-source="src/App.tsx:2:12"')
    })
  })

  describe('column number accuracy', () => {
    it('reports column 1 for tag at start of line', () => {
      const result = transform('<div />')
      expect(result).toContain(':1:1"')
    })

    it('reports correct column for indented tag', () => {
      const result = transform('    <div />')
      expect(result).toContain(':1:5"')
    })

    it('reports correct column on second line', () => {
      const code = 'const x = 1\nconst el = <span />'
      const result = transform(code)
      expect(result).toContain(':2:12"')
    })

    it('reports correct column after inline content', () => {
      const code = 'const el = (<div />)'
      const result = transform(code)
      expect(result).toContain(':1:13"')
    })
  })

  describe('JSX member expressions', () => {
    it('instruments motion.div', () => {
      const result = transform('<motion.div />')
      expect(result).toContain('data-cortex-source=')
    })

    it('instruments styled.button with attributes', () => {
      const result = transform('<styled.button className="x" />')
      expect(result).toContain('data-cortex-source=')
    })

    it('skips uppercase terminal like Motion.Header', () => {
      const result = transform('<Motion.Header />')
      expect(result).not.toContain('data-cortex-source')
    })

    it('instruments deeply nested a.b.c (lowercase terminal)', () => {
      const result = transform('<a.b.c />')
      expect(result).toContain('data-cortex-source=')
    })
  })

  describe('JSX namespaced names', () => {
    it('instruments namespaced elements like svg:rect', () => {
      const result = transform('<svg:rect />')
      expect(result).toContain('data-cortex-source=')
    })
  })

  describe('non-ASCII character handling', () => {
    it('correct offset after emoji content', () => {
      const code = 'const x = "🎉"\nconst el = <div />'
      const result = transform(code)
      expect(result).toContain('data-cortex-source="src/App.tsx:2:')
    })

    it('correct offset after CJK characters', () => {
      const code = 'const label = "你好世界"\nconst el = <span>{label}</span>'
      const result = transform(code)
      expect(result).toContain('data-cortex-source="src/App.tsx:2:12"')
    })

    it('preserves emoji in attributes', () => {
      const code = '<div title="🎉🎊">text</div>'
      const result = transform(code)
      expect(result).toContain('<div data-cortex-source=')
      expect(result).toContain('title="🎉🎊"')
    })

    it('correct column after multi-byte chars mid-line', () => {
      const code = 'const a = "café"; const el = <div />'
      const result = transform(code)
      expect(result).toContain('<div data-cortex-source=')
    })
  })

  describe('HTML attribute escaping', () => {
    it('escapes special characters in file paths', () => {
      const result = transformSource(
        '<div />',
        '/project/src/com"po<nent>.tsx',
      )
      expect(result).not.toBeNull()
      expect(result!.code).toContain('&quot;')
      expect(result!.code).toContain('&lt;')
      expect(result!.code).toContain('&gt;')
      expect(result!.code).not.toContain('com"po')
    })
  })

  describe('edge cases', () => {
    it('returns null for files with only uppercase components (no lowercase tags)', () => {
      const result = transformRaw('<Component />')
      expect(result).toBeNull()
    })

    it('returns null for empty string input', () => {
      expect(transformRaw('')).toBeNull()
    })

    it('returns null when file has no lowercase JSX (lazy MagicString)', () => {
      const result = transformRaw('<MyApp><Section><Header /></Section></MyApp>')
      expect(result).toBeNull()
    })

    it('instruments JSX inside decorated class', () => {
      const code = `function dec(target: any) { return target }
@dec class App { render() { return <div>hello</div> } }`
      const result = transformRaw(code)
      expect(result).not.toBeNull()
      expect(result!.code).toContain('<div data-cortex-source=')
    })

    it('instruments JSX alongside explicitResourceManagement syntax', () => {
      const code = `function test() {
  using handle = getResource()
  return <div>{String(handle)}</div>
}`
      const result = transformRaw(code)
      expect(result).not.toBeNull()
      expect(result!.code).toContain('<div data-cortex-source=')
    })
  })

  describe('performance', () => {
    // ZF0-1566: skip under V8 coverage. performance.now() under coverage
    // instrumentation measures the cost of hooked branches/statements, not
    // the transform itself — observed median ballooned to ~214.5ms against
    // a 50ms local budget. Relaxing the budget to fit would lose regression
    // signal entirely. The test still runs in normal `npm test` and CI
    // (without --coverage), where wall-clock timing is meaningful.
    // VITEST_COVERAGE is set by vitest.config.ts when --coverage is detected
    // in argv (NODE_V8_COVERAGE is not set by @vitest/coverage-v8 directly).
    // Compare === '1' explicitly so a stray `VITEST_COVERAGE=0` shell export
    // does not silently skip the assertion. See `tests/COVERAGE.md` for the
    // detection contract.
    it.skipIf(process.env.VITEST_COVERAGE === '1')('transforms a 1000-element file in under 50ms (median of 3)', () => {
      const lines: string[] = []
      for (let i = 0; i < 1000; i++) {
        lines.push(`  <div className="item-${i}">Item ${i}</div>`)
      }
      const code = `function App() {\n  return (\n    <main>\n${lines.join('\n')}\n    </main>\n  )\n}`

      // Warmup JIT
      transformSource(code, '/project/src/Warmup.tsx')

      // Materialize ONCE, outside the timed region. `transformSource` writes the
      // fixture on every call, and timing that would measure filesystem latency
      // rather than transform cost — the budget below is about the parser.
      const perfId = materialize(code, '/project/src/Perf.tsx')

      const times: number[] = []
      for (let run = 0; run < 3; run++) {
        const start = performance.now()
        const result = transformSource_raw(code, perfId)
        times.push(performance.now() - start)
        expect(result).not.toBeNull()
      }

      times.sort((a, b) => a - b)
      const median = times[1]!
      // GitHub Actions ubuntu-latest runners are ~2× slower than dev machines
      // under contention; 50ms is too tight in CI (observed 60-65ms).
      // Keep the dev budget tight so real regressions are caught locally.
      const BUDGET_MS = process.env.CI ? 100 : 50
      expect(median).toBeLessThan(BUDGET_MS)
    })
  })
})

describe('source map generation', () => {
  it('returns a valid source map', () => {
    const result = transformSource('<div />', '/project/src/App.tsx')
    expect(result).not.toBeNull()
    expect(result!.map).not.toBeNull()
    expect(result!.map!.version).toBe(3)
    expect(result!.map!.mappings).toBeTruthy()
  })

  it('source map includes source file and content', () => {
    const code = '<div />'
    const result = transformSource(code, '/project/src/App.tsx')
    const map = result!.map!
    expect(map.version).toBe(3)
    expect(map.sources).toHaveLength(1)
    expect(map.sources![0]).toBe('App.tsx') // relative to file's directory
    expect(map.sourcesContent).toEqual([code])
    expect(map.file).toBe('App.tsx')
    expect(map.mappings).toBeTruthy()
  })

  it('emits NO map for an outside-root file, because it emits no anchor (COR-30)', () => {
    // Previously this asserted `sources[0] === 'App.tsx'` — the basename. That was
    // a test OF the bug: apply resolves stamped paths under projectRoot, so the
    // basename named a different file.
    const t = mk()
    expect(t('<div />', '/etc/secrets/App.tsx')).toBeNull()
  })
})

describe('syntax error handling', () => {
  it('returns null for unparseable code', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = transformSource('const x = {', '/project/src/App.tsx')
    expect(result).toBeNull()
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })
})

describe('production mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null when mode is production', () => {
    const t = mk({ mode: 'production' })
    expect(t('<div />', '/project/src/App.tsx')).toBeNull()
  })

  it('transforms when mode is development', () => {
    const t = mk({ mode: 'development' })
    expect(t('<div />', '/project/src/App.tsx')).not.toBeNull()
  })

  it('transforms by default (no options)', () => {
    expect(transformSource('<div />', '/project/src/App.tsx')).not.toBeNull()
  })

  it('returns null when NODE_ENV=production and no explicit mode', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const t = mk()
    expect(t('<div />', '/project/src/App.tsx')).toBeNull()
  })

  it('explicit mode=development overrides NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const t = mk({ mode: 'development' })
    expect(t('<div />', '/project/src/App.tsx')).not.toBeNull()
  })
})

describe('parse error handling', () => {
  it('calls onParseError when parsing fails (and does not warn)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors: Array<{ id: string; error: unknown }> = []
    const t = mk({
      onParseError: (id, error) => errors.push({ id, error }),
    })
    t('const x = {', '/project/src/App.tsx')
    expect(errors).toHaveLength(1)
    // The callback receives the id it was CALLED with, which is now the real
    // materialized path under the temp root rather than the virtual one. Assert
    // the suffix so the contract (callback gets the id verbatim) is still proved
    // without pinning a per-run temp directory.
    // Normalize separators first: path.join emits backslashes on Windows, so the
    // raw suffix check would fail there. Same treatment as the traversal test
    // below. toMatch rather than endsWith(...).toBe(true) so a failure reports the
    // actual id instead of `false`.
    expect(errors[0].id.replace(/\\/g, '/')).toMatch(/\/project\/src\/App\.tsx$/)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('still returns null on parse error without callback (warns to console)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(transformSource('const x = {', '/project/src/App.tsx')).toBeNull()
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0]![0]).toContain('[cortex]')
    spy.mockRestore()
  })
})

describe('sequential call regression', () => {
  it('produces correct offsets across sequential calls', () => {
    const t = mk()
    const r1 = t('<div />', '/project/src/A.tsx')
    const r2 = t('<span />', '/project/src/B.tsx')
    expect(r1!.code).toContain(':1:1"')
    expect(r2!.code).toContain(':1:1"')
  })
})

describe('path traversal safety', () => {
  it('REFUSES a file outside project root instead of stamping its basename (COR-30)', () => {
    // The old contract was `data-cortex-source="App.tsx:"`. Apply resolves stamped
    // paths under projectRoot, so that named `<projectRoot>/App.tsx` — a different
    // file, which cortex would rewrite if it held JSX at that line:col. A silent
    // wrong-FILE write. The COR-28 provenance guard cannot catch it: that guard
    // verifies `cleanId`, the CORRECT path, and the basename reduction happened
    // afterward — so it made the unmappable stamp look verified.
    // mk() materializes the file, so it EXISTS and reads cleanly — the provenance
    // guard passes and this exercises the path check rather than an earlier
    // refusal. A synthetic '/etc/secrets/App.tsx' takes the 'unreadable' branch
    // and would assert nothing about COR-30, which is the same trap COR-28 found
    // in all 108 of these tests.
    const reasons: string[] = []
    const t = mk({ onProvenanceMismatch: (_id, d) => reasons.push(d.reason) })
    expect(t('<div />', '/etc/secrets/App.tsx')).toBeNull()
    expect(reasons).toEqual(['unmappable'])
  })

  it('names the wrong-file collision concretely: two roots, same basename', () => {
    // The failure the refusal prevents, spelled out. Both files are Button.tsx;
    // only one is inside the root. Stamping the basename for the outside one made
    // it indistinguishable from the inside one, and apply resolves under root.
    const t = mk()

    const insideResult = t('<div />', '/project/Button.tsx')
    expect(insideResult).not.toBeNull()
    expect(insideResult!.code).toContain('data-cortex-source="Button.tsx:')

    // Same basename, different file, outside the root. It must NOT stamp — that
    // stamp would resolve to the inside file above and write there.
    expect(t('<span />', '/pkg/Button.tsx')).toBeNull()
  })

  it('REFUSES an in-root symlink whose target is outside the root', () => {
    // `path.resolve` is lexical, so this reads as contained. Apply's
    // `isWriteTargetInsideRoot` DOES realpath and would refuse the write — so
    // without realpath here the element fails to edit instead of degrading to
    // agent-resolve, which is the opposite of what this refusal is for.
    const target = path.join(OUTSIDE_ROOT, 'linked-pkg')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'Card.tsx'), '<div />', 'utf8')

    const linkDir = path.join(PROJECT_ROOT, 'node_modules/@acme/ui')
    fs.mkdirSync(path.dirname(linkDir), { recursive: true })
    try {
      fs.symlinkSync(target, linkDir, 'dir')
    } catch {
      return // no symlink permission (Windows without dev mode) — nothing to assert
    }

    const reasons: string[] = []
    const t = createSourceTransform(PROJECT_ROOT, {
      includeNodeModules: ['@acme/ui'],
      onProvenanceMismatch: (_id, d) => reasons.push(d.reason),
    })
    expect(t('<div />', path.join(linkDir, 'Card.tsx'))).toBeNull()
    expect(reasons).toEqual(['unmappable'])
  })

  it('REFUSES a POSIX filename containing a backslash, which serializes to a different path', () => {
    // On POSIX `\` is a legal FILENAME character. `src/foo\bar.tsx` is ONE file,
    // but the forward-slash rewrite emits `src/foo/bar.tsx` — a different path
    // that apply would resolve and rewrite. Validating the native relative path
    // misses this entirely: it round-trips by construction. The SERIALIZED value
    // is what must be checked.
    if (process.platform === 'win32') return // `\` is a separator there, not a name

    const dir = path.join(PROJECT_ROOT, 'src')
    fs.mkdirSync(dir, { recursive: true })
    const weird = path.join(dir, 'foo\\bar.tsx')
    fs.writeFileSync(weird, '<div />', 'utf8')

    const reasons: string[] = []
    const t = createSourceTransform(PROJECT_ROOT, {
      onProvenanceMismatch: (_id, d) => reasons.push(d.reason),
    })
    expect(t('<div />', weird)).toBeNull()
    expect(reasons).toEqual(['unmappable'])
  })

  it('does not mistake an in-root directory named "..hidden" for an escape', () => {
    // Segment-aware containment, per this repo's path-matching rule. A bare
    // `startsWith('..')` fires on this legitimate in-root path, which under the
    // old code silently collapsed it to a basename too.
    const result = mk()('<div />', '/project/..hidden/App.tsx')
    expect(result).not.toBeNull()
    expect(result!.code).toContain('data-cortex-source="..hidden/App.tsx:')
  })

  it('uses relative path for files inside project root', () => {
    const t = mk()
    const result = t('<div />', '/project/src/deep/Component.tsx')
    expect(result).not.toBeNull()
    expect(result!.code).toContain('data-cortex-source="src/deep/Component.tsx:')
  })
})

// ---------------------------------------------------------------------------
// CSS Module annotation
// ---------------------------------------------------------------------------

describe('CSS Module annotation', () => {
  it('annotates styles.hero with data-cortex-css', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div className={styles.hero}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).toContain('data-cortex-css="src/Hero.module.css:.hero"')
  })

  it('does not annotate static string classNames', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div className="static">test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).not.toContain('data-cortex-css')
  })

  it('annotates bracket access styles["hero"]', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div className={styles['hero']}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).toContain('data-cortex-css="src/Hero.module.css:.hero"')
  })

  it('annotates dynamic access styles[variant] as wildcard', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div className={styles[variant]}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).toContain('data-cortex-css="src/Hero.module.css:*"')
  })

  it('annotates clsx(styles.a, styles.b) with multiple selectors', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div className={clsx(styles.a, styles.b)}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).toContain('data-cortex-css="src/Hero.module.css:.a,.b"')
  })

  it('annotates clsx with object syntax { [styles.active]: isActive }', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div className={clsx(styles.hero, { [styles.active]: isActive })}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).toContain('data-cortex-css="src/Hero.module.css:.hero,.active"')
  })

  it('does not annotate className={computeClass()} without binding reference', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div className={computeClass()}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).not.toContain('data-cortex-css')
  })

  it('handles named default import { default as s }', () => {
    const result = transform(
      `import { default as s } from './Hero.module.css'\nconst C = () => <div className={s.hero}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).toContain('data-cortex-css="src/Hero.module.css:.hero"')
  })

  it('resolves relative paths from importing file directory', () => {
    const result = transform(
      `import styles from '../styles/Hero.module.css'\nconst C = () => <div className={styles.hero}>test</div>`,
      '/project/src/pages/Hero.tsx',
    )
    expect(result).toContain('data-cortex-css="src/styles/Hero.module.css:.hero"')
  })

  it('skips elements that already have data-cortex-css (idempotency)', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div data-cortex-css="existing" className={styles.hero}>test</div>`,
      '/project/src/Hero.tsx',
    )
    // Should have the existing one, but not a second one
    const matches = result.match(/data-cortex-css/g)
    expect(matches?.length).toBe(1)
  })

  it('does not annotate non-CSS-module imports', () => {
    const result = transform(
      `import styles from './Hero.module.scss'\nconst C = () => <div className={styles.hero}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).not.toContain('data-cortex-css')
  })

  it('handles aliased imports via resolveAlias callback', () => {
    const t = mk({
      resolveAlias: (spec) => {
        if (spec.startsWith('@/')) return spec.replace('@/', 'src/')
        return null
      },
    })
    const result = t(
      `import styles from '@/styles/Hero.module.css'\nconst C = () => <div className={styles.hero}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).not.toBeNull()
    expect(result!.code).toContain('data-cortex-css="src/styles/Hero.module.css:.hero"')
  })

  it('deduplicates selectors from the same binding', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div className={clsx(styles.hero, styles.hero)}>test</div>`,
      '/project/src/Hero.tsx',
    )
    // Should contain just .hero once, not .hero,.hero
    expect(result).toContain('data-cortex-css="src/Hero.module.css:.hero"')
  })

  it('still adds data-cortex-source alongside data-cortex-css', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div className={styles.hero}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).toContain('data-cortex-source="src/Hero.tsx:')
    expect(result).toContain('data-cortex-css="src/Hero.module.css:.hero"')
  })

  it('annotates cn() wrapper the same as clsx()', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div className={cn(styles.hero)}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).toContain('data-cortex-css="src/Hero.module.css:.hero"')
  })

  it('handles template literal with CSS module reference', () => {
    const result = transform(
      `import styles from './Hero.module.css'\nconst C = () => <div className={\`\${styles.hero} extra\`}>test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).toContain('data-cortex-css="src/Hero.module.css:.hero"')
  })

  it('ignores side-effect-only CSS module imports', () => {
    const result = transform(
      `import './Hero.module.css'\nconst C = () => <div className="static">test</div>`,
      '/project/src/Hero.tsx',
    )
    expect(result).not.toContain('data-cortex-css')
  })
})

// ── Provenance guard (COR-28) ───────────────────────────────────────────────
//
// The transform records `node.loc` — a coordinate in THE STRING IT WAS HANDED —
// and the apply side resolves that coordinate against THE FILE ON DISK. Those
// are the same coordinate space only if nothing upstream rewrote the text.
// COR-28 shipped because nothing checked: @vitejs/plugin-react prepended a
// 19-line refresh preamble, every anchor was 19 lines off, and findJsxElementAt
// silently returned whichever JSX node happened to occupy that offset.
//
// Every test here asserts REFUSAL (or non-refusal). They fail without the guard.
describe('provenance guard', () => {
  it('annotates when the input matches the file on disk', () => {
    // The baseline the other branches are measured against.
    const result = transformRaw('<div />')
    expect(result).not.toBeNull()
    expect(result!.code).toContain('data-cortex-source')
  })

  it('REFUSES when the input differs from the file on disk (the COR-28 case)', () => {
    const onDisk = '<div />'
    const realId = materialize(onDisk, '/project/src/Drift.tsx')
    // Simulate an upstream transform: cortex is handed text with a prepended
    // preamble while the file on disk is unchanged. This is exactly what
    // plugin-react does, and every position in `rewritten` is shifted.
    const rewritten = `import RefreshRuntime from "/@react-refresh";\n${onDisk}`
    const mismatches: Array<{ id: string; reason: string }> = []
    const t = createSourceTransform(PROJECT_ROOT, {
      onProvenanceMismatch: (id, d) => mismatches.push({ id, reason: d.reason }),
    })
    expect(t(rewritten, realId)).toBeNull()
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]!.reason).toBe('mismatch')
  })

  it('reports the line delta so a preamble is identifiable from the log', () => {
    const onDisk = '<div />'
    const realId = materialize(onDisk, '/project/src/Delta.tsx')
    const details: Array<{ inputLines: number; diskLines: number }> = []
    const t = createSourceTransform(PROJECT_ROOT, {
      onProvenanceMismatch: (_id, d) => details.push(d),
    })
    t(`${'\n'.repeat(19)}${onDisk}`, realId)
    expect(details).toHaveLength(1)
    expect(details[0]!.inputLines - details[0]!.diskLines).toBe(19)
  })

  it('FAILS CLOSED when the file cannot be read', () => {
    // Nothing was materialized at this path. An unverifiable anchor is not a
    // weaker anchor — its presence alone forces applyMode 'direct', making it a
    // deterministic write target. So: no anchor.
    const reasons: string[] = []
    const t = createSourceTransform(PROJECT_ROOT, {
      onProvenanceMismatch: (_id, d) => reasons.push(d.reason),
    })
    expect(t('<div />', path.join(PROJECT_ROOT, 'src/NeverWritten.tsx'))).toBeNull()
    expect(reasons).toEqual(['unreadable'])
  })

  it('FAILS CLOSED on a virtual module id', () => {
    const reasons: string[] = []
    const t = createSourceTransform(PROJECT_ROOT, {
      onProvenanceMismatch: (_id, d) => reasons.push(d.reason),
    })
    // Rollup/Vite virtual-module convention: there is no file to compare against.
    expect(t('<div />', '\0virtual:cortex-test.tsx')).toBeNull()
    expect(reasons).toEqual(['virtual'])
  })

  it('does NOT refuse when only a source-map comment differs (Vite blanks it)', () => {
    // Vite extracts and blanks a valid sourceMappingURL comment BEFORE any plugin
    // transform, preserving length so no position moves. Refusing here would be a
    // false refusal that reordering plugins cannot fix, because Vite does this
    // before plugins are consulted at all.
    const withComment = '<div />\n//# sourceMappingURL=data:application/json;base64,AAAA\n'
    const realId = materialize(withComment, '/project/src/Mapped.tsx')
    const blanked = withComment.replace(
      /\/\/# sourceMappingURL=[^\n]*/,
      m => ' '.repeat(m.length),
    )
    expect(blanked.length).toBe(withComment.length) // length-preserving, by construction
    const result = transformSource_raw(blanked, realId)
    expect(result).not.toBeNull()
    expect(result!.code).toContain('data-cortex-source')
  })

  it('still refuses when a source-map comment differs AND real text changed', () => {
    // Guards against the blanking normalization being over-broad: neutralizing the
    // comment must not neutralize a genuine rewrite that happens to sit near one.
    const onDisk = '<div />\n//# sourceMappingURL=x.map\n'
    const realId = materialize(onDisk, '/project/src/MappedDrift.tsx')
    const rewritten = `\n<div />\n//# sourceMappingURL=y.map\n`
    expect(transformSource_raw(rewritten, realId)).toBeNull()
  })

  it('REFUSES a one-sided BOM — it shifts every column on line 1', () => {
    // A BOM is a real character at offset 0. Disk without / input with (or the
    // reverse) means line-1 columns differ by one between the coordinate space
    // cortex measures in and the one apply resolves in. An earlier revision
    // stripped it on both sides and called that "position-preserving"; it is
    // only position-preserving when SYMMETRIC.
    const onDisk = '<div />'
    const realId = materialize(onDisk, '/project/src/Bom.tsx')
    expect(transformSource_raw(`﻿${onDisk}`, realId)).toBeNull()

    const withBom = '﻿<div />'
    const bomId = materialize(withBom, '/project/src/BomDisk.tsx')
    expect(transformSource_raw('<div />', bomId)).toBeNull()
  })

  it('accepts a BOM present on BOTH sides, and the coordinates still resolve', () => {
    const withBom = '﻿<div />'
    const realId = materialize(withBom, '/project/src/BomBoth.tsx')
    const result = transformSource_raw(withBom, realId)
    expect(result).not.toBeNull()
    // Assert the emitted COORDINATE, not merely that annotation happened —
    // "it returned non-null" would pass even if the position were wrong.
    expect(result!.code).toContain('data-cortex-source="src/BomBoth.tsx:1:')
  })

  // ── The regressions codex found (round 2, High) ─────────────────────────
  //
  // The first attempt at source-map tolerance blanked matches on BOTH strings
  // with a loose, unanchored regex. That let a REAL rewrite be erased
  // symmetrically: two files whose JSX sat at different columns normalized to
  // equal text, cortex accepted, and the stamped position resolved to a
  // different element on disk — recreating COR-28 through the fix for COR-28.
  //
  // The corrected design compares exactly first, then applies Vite's own
  // EOL-anchored comment regex ONE WAY (disk -> input). Each test below fails
  // against the symmetric version.

  it('REFUSES when sourceMappingURL text differs INSIDE a string literal', () => {
    // codex's exact reproduction. The comment-like text is mid-line inside a
    // string, so it is not a source-map annotation at all; blanking it shifts
    // the JSX that follows.
    const onDisk = 'const s="//# sourceMappingURL=a";const x=[<a/>,<b/>]     '
    const realId = materialize(onDisk, '/project/src/StrLit.tsx')
    const incoming = 'const s="//# sourceMappingURL=abcdef";const x=[<a/>,<b/>]'
    expect(onDisk.length).toBe(incoming.length) // equal length, different columns
    expect(transformSource_raw(incoming, realId)).toBeNull()
  })

  it('REFUSES when sourceMappingURL-like text differs inside JSX text', () => {
    // Two problems with the earlier fixture: `<div/>` followed by `<span/>` at
    // statement position does not parse (so null came from the PARSER, not the
    // guard), and handing in a differently-worded comment differs under a loose
    // regex and a strict one alike. Over-matching only ever causes a FALSE ACCEPT,
    // and only when the incoming text equals the blanked disk text — so hand in
    // exactly that, and assert the refusal REASON.
    const marker = '//# sourceMappingURL=a'
    const onDisk = `<div>${marker}</div>`
    const asIfBlanked = onDisk.replace(marker, ' '.repeat(marker.length))
    expect(asIfBlanked.length).toBe(onDisk.length)

    const realId = materialize(onDisk, '/project/src/JsxText.tsx')
    expect(transformSource_raw(onDisk, realId)).not.toBeNull() // control: it parses

    const reasons: string[] = []
    const t = createSourceTransform(PROJECT_ROOT, {
      onProvenanceMismatch: (_id, d) => reasons.push(d.reason),
    })
    // `$` with /m is what saves this: the comment does not END the line — `</div>`
    // follows — so it is JSX text, not an annotation, and must not be blanked.
    expect(t(asIfBlanked, realId)).toBeNull()
    expect(reasons).toEqual(['mismatch'])
  })

  it('does not let the pattern swallow a newline and merge two lines', () => {
    // `\s*` in the old pattern could cross a line boundary; Vite's uses [ \t].
    const onDisk = '//# sourceMappingURL=a\n<div />'
    const realId = materialize(onDisk, '/project/src/Newline.tsx')
    const result = transformSource_raw(onDisk, realId)
    expect(result).not.toBeNull()
    // <div /> is on line 2 and must still be reported there.
    expect(result!.code).toContain('data-cortex-source="src/Newline.tsx:2:')
  })

  it('REFUSES a BLOCK comment that spans two lines, which blanking would collapse', () => {
    // Sibling of the test above, for the OTHER half of the alternation. The `//`
    // form is bounded by `[ \t]`, but the block form's URL capture is `[^*]+?` and
    // a negated class matches `\n` — so this comment is ONE match spanning two
    // lines. Vite blanks a match to spaces of equal LENGTH, which turns that
    // newline into a space and moves every later line up one. Equal length is not
    // equal shape.
    const comment = '/*# sourceMappingURL=foo.map\n*/'
    const onDisk = `${comment}\nexport default function A() {\n  return <div />\n}`
    const viteStyle = onDisk.replace(comment, ' '.repeat(comment.length))

    // The hazard, stated as an assertion rather than a comment: same bytes, one
    // fewer line. <div /> is on line 4 on disk and line 3 in what Vite hands us.
    expect(viteStyle.length).toBe(onDisk.length)
    expect(viteStyle.split('\n')).toHaveLength(onDisk.split('\n').length - 1)

    const realId = materialize(onDisk, '/project/src/BlockMultiline.tsx')

    // POSITIVE CONTROL FIRST. Without it a parse failure would return null and this
    // test would "pass" while asserting nothing — the exact defect this whole diff
    // exists to fix. Prove the shape annotates when provenance holds.
    const control = transformSource_raw(onDisk, realId)
    expect(control).not.toBeNull()
    expect(control!.code).toContain('data-cortex-source="src/BlockMultiline.tsx:4:')

    // Assert the GUARD refused, not merely that something returned null. The guard
    // runs before the parser, so only a real refusal fires this callback.
    const reasons: string[] = []
    const t = createSourceTransform(PROJECT_ROOT, {
      onProvenanceMismatch: (_id, d) => reasons.push(d.reason),
    })
    expect(t(viteStyle, realId)).toBeNull()
    expect(reasons).toEqual(['mismatch'])
  })

  it('FAILS CLOSED when readSource returns a non-string instead of throwing', () => {
    // `readSource` is user-supplied and only type-checked for TS consumers. A JS
    // adapter returning `undefined` used to slip past the `=== null` test and reach
    // hasBom(), throwing OUTSIDE the try — killing the transform hook rather than
    // failing closed, which contradicts the documented contract.
    const onDisk = '<div />'
    const realId = materialize(onDisk, '/project/src/BadReader.tsx')
    const reasons: string[] = []
    const t = createSourceTransform(PROJECT_ROOT, {
      readSource: () => undefined as unknown as string,
      onProvenanceMismatch: (_id, d) => reasons.push(d.reason),
    })
    expect(() => t(onDisk, realId)).not.toThrow()
    expect(t(onDisk, realId)).toBeNull()
    expect(reasons).toContain('unreadable')
  })

  it('REFUSES an unterminated block comment difference', () => {
    // The old pattern made `*/` optional, so an unterminated `/*#` was treated as a
    // comment and blanked. Vite's requires the terminator.
    //
    // The earlier fixture handed in a DIFFERENT unterminated comment, which differs
    // from disk under a loose regex and a strict one alike — so it returned null
    // either way and could not fail. Over-matching only ever causes a FALSE ACCEPT,
    // and only when the incoming text equals the blanked disk text. So that is what
    // we hand in. Note the incoming variant parses cleanly (it is spaces + a
    // function), so a null here is the guard's doing, not the parser's.
    const marker = '/*# sourceMappingURL=a'
    const onDisk = `${marker}\nexport default function A() { return <div /> }`
    const asIfBlanked = onDisk.replace(marker, ' '.repeat(marker.length))
    expect(asIfBlanked.length).toBe(onDisk.length)

    const realId = materialize(onDisk, '/project/src/Unterminated.tsx')
    const reasons: string[] = []
    const t = createSourceTransform(PROJECT_ROOT, {
      onProvenanceMismatch: (_id, d) => reasons.push(d.reason),
    })
    // A regex that blanked the unterminated `/*#` would make these two equal and
    // annotate. Requiring `*/` keeps them different, so the guard refuses.
    expect(t(asIfBlanked, realId)).toBeNull()
    expect(reasons).toEqual(['mismatch'])
  })

  it('accepts Vite blanking only in the disk -> input direction', () => {
    // Cortex must NOT accept the reverse: an incoming file carrying a comment
    // where disk has blanks is not something Vite produces, and treating it as
    // equivalent would erase a difference present in the incoming text.
    const commented = '<div />\n//# sourceMappingURL=x.map\n'
    const blanked = commented.replace(/\/\/# sourceMappingURL=x\.map/, m => ' '.repeat(m.length))
    expect(blanked.length).toBe(commented.length)

    const diskCommented = materialize(commented, '/project/src/Dir1.tsx')
    expect(transformSource_raw(blanked, diskCommented)).not.toBeNull() // disk -> input: allowed

    const diskBlanked = materialize(blanked, '/project/src/Dir2.tsx')
    expect(transformSource_raw(commented, diskBlanked)).toBeNull() // input -> disk: refused
  })

  it('tolerates CRLF vs LF (position-preserving)', () => {
    const onDisk = '<div>\n</div>'
    const realId = materialize(onDisk, '/project/src/Crlf.tsx')
    const result = transformSource_raw('<div>\r\n</div>', realId)
    expect(result).not.toBeNull()
  })
})
