import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import cortexSourceLoader, { _resetForTesting } from '../../src/adapters/source-loader.js'

afterEach(() => {
  _resetForTesting()
})

// Tests materialize real files; remove the tree so runs do not accumulate temps.
afterAll(() => {
  fs.rmSync(PROJECT_ROOT, { recursive: true, force: true })
})

// Real files on disk (COR-28). The transform verifies that the text it is handed
// IS the file at the given path before stamping any position — a position measured
// against one string and applied against another is how anchors ended up pointing
// at the wrong element. Synthetic '/project/...' paths would take the refusal
// branch and assert nothing about what this loader actually produces.
//
// PROJECT_ROOT mirrors the old virtual layout, so `path.relative` still yields
// 'src/App.tsx' and every existing assertion holds verbatim.
const PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sl-'))

/** Map a virtual '/project/...' path onto the real temp root. */
function realPath(virtualPath: string): string {
  const rel = virtualPath.startsWith('/project/')
    ? virtualPath.slice('/project/'.length)
    : virtualPath.replace(/^\/+/, '')
  return path.join(PROJECT_ROOT, rel)
}

function fakeContext(overrides: {
  resourcePath?: string
  projectRoot?: string
  resolveAlias?: Record<string, string>
  includeNodeModules?: string[]
} = {}) {
  return {
    resourcePath: realPath(overrides.resourcePath ?? '/project/src/App.tsx'),
    getOptions: () => ({
      projectRoot: overrides.projectRoot ? realPath(overrides.projectRoot) : PROJECT_ROOT,
      // Alias TARGETS are virtual '/project/...' paths too — map them onto the
      // real root, or CSS Module resolution lands outside it and the annotation
      // is silently dropped.
      resolveAlias: overrides.resolveAlias
        ? Object.fromEntries(
            Object.entries(overrides.resolveAlias).map(([k, v]) => [k, realPath(v)]),
          )
        : undefined,
      includeNodeModules: overrides.includeNodeModules,
    }),
    callback: vi.fn(),
    cacheable: vi.fn(),
  }
}

/** Write `source` to the context's real resourcePath, then run the loader.
 *  Materializing is what lets the provenance guard succeed. */
function runLoader(ctx: ReturnType<typeof fakeContext>, source: string): void {
  fs.mkdirSync(path.dirname(ctx.resourcePath), { recursive: true })
  fs.writeFileSync(ctx.resourcePath, source, 'utf8')
  cortexSourceLoader.call(ctx, source)
}

describe('shared cortex source loader', () => {
  it('transforms JSX and calls callback with code + map', () => {
    const ctx = fakeContext()
    const source = 'export default function App() { return <div>hello</div> }'

    runLoader(ctx, source)

    expect(ctx.cacheable).toHaveBeenCalled()
    const [err, code, map] = ctx.callback.mock.calls[0]!
    expect(err).toBeNull()
    expect(code).toContain('data-cortex-source="src/App.tsx:')
    expect(map).toBeDefined()
  })

  it('passes alias options through so CSS Module imports are annotated', () => {
    const ctx = fakeContext({
      resourcePath: '/project/src/components/Card.tsx',
      resolveAlias: { '@': '/project/src' },
    })
    const source = [
      "import styles from '@/styles/Card.module.css'",
      'export function Card() { return <div className={styles.root}>hello</div> }',
    ].join('\n')

    runLoader(ctx, source)

    const [, code] = ctx.callback.mock.calls[0]!
    expect(code).toContain('data-cortex-css="src/styles/Card.module.css:.root"')
  })

  it('uses the longest matching alias for overlapping CSS Module aliases', () => {
    const ctx = fakeContext({
      resourcePath: '/project/src/components/Card.tsx',
      resolveAlias: {
        '@': '/project/src',
        '@ui': '/project/src/ui',
      },
    })
    const source = [
      "import styles from '@ui/Card.module.css'",
      'export function Card() { return <div className={styles.root}>hello</div> }',
    ].join('\n')

    runLoader(ctx, source)

    const [, code] = ctx.callback.mock.calls[0]!
    expect(code).toContain('data-cortex-css="src/ui/Card.module.css:.root"')
  })

  it('instruments explicitly included node_modules packages', () => {
    const ctx = fakeContext({
      resourcePath: '/project/node_modules/@acme/ui/Button.tsx',
      includeNodeModules: ['@acme/ui'],
    })
    const source = 'export function Button() { return <button>ok</button> }'

    runLoader(ctx, source)

    const [, code] = ctx.callback.mock.calls[0]!
    expect(code).toContain('data-cortex-source="node_modules/@acme/ui/Button.tsx:')
  })
})
