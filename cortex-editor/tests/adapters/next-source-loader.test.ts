import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import cortexSourceLoader, { _resetForTesting } from '../../src/adapters/next-source-loader.js'

afterEach(() => {
  _resetForTesting()
})

// Tests materialize real files; remove the tree so runs do not accumulate temps.
afterAll(() => {
  fs.rmSync(PROJECT_ROOT, { recursive: true, force: true })
})

// Real files on disk (COR-28) — see the equivalent note in source-loader.test.ts.
// The transform refuses to stamp a position it cannot prove was measured against
// the file on disk, so synthetic paths would take the refusal branch and assert
// nothing about what this loader produces.
const PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-nsl-'))

/** Map a virtual '/project/...' path onto the real temp root. */
function realPath(virtualPath: string): string {
  const rel = virtualPath.startsWith('/project/')
    ? virtualPath.slice('/project/'.length)
    : virtualPath.replace(/^\/+/, '')
  return path.join(PROJECT_ROOT, rel)
}

// Create a fake webpack LoaderContext
function fakeContext(
  overrides: { resourcePath?: string; projectRoot?: string; includeNodeModules?: string[] } = {}
) {
  const ctx = {
    resourcePath: realPath(overrides.resourcePath ?? '/project/src/App.tsx'),
    getOptions: () => ({
      projectRoot: overrides.projectRoot ? realPath(overrides.projectRoot) : PROJECT_ROOT,
      ...(overrides.includeNodeModules ? { includeNodeModules: overrides.includeNodeModules } : {}),
    }),
    callback: vi.fn(),
    cacheable: vi.fn(),
  }
  return ctx
}

/** Write `source` to the context's real resourcePath, then run the loader. */
function runLoader(ctx: ReturnType<typeof fakeContext>, source: string): void {
  fs.mkdirSync(path.dirname(ctx.resourcePath), { recursive: true })
  fs.writeFileSync(ctx.resourcePath, source, 'utf8')
  cortexSourceLoader.call(ctx, source)
}

describe('cortexSourceLoader', () => {
  it('transforms JSX and calls callback with code + map', () => {
    const ctx = fakeContext()
    const source = 'export default function App() { return <div>hello</div> }'
    runLoader(ctx, source)

    expect(ctx.cacheable).toHaveBeenCalled()
    expect(ctx.callback).toHaveBeenCalledOnce()
    const [err, code, map] = ctx.callback.mock.calls[0]!
    expect(err).toBeNull()
    expect(code).toContain('data-cortex-source="src/App.tsx:')
    expect(map).toBeDefined()
  })

  it('returns original source unchanged for non-JSX files', () => {
    const ctx = fakeContext({ resourcePath: '/project/src/utils.ts' })
    const source = 'const x = 1'
    runLoader(ctx, source)

    expect(ctx.callback).toHaveBeenCalledOnce()
    const [err, code, map] = ctx.callback.mock.calls[0]!
    expect(err).toBeNull()
    expect(code).toBe(source)
    expect(map).toBeUndefined()
  })

  it('caches transform across multiple calls with same projectRoot', () => {
    const ctx1 = fakeContext()
    const ctx2 = fakeContext()
    const source = 'export default function A() { return <div /> }'

    runLoader(ctx1, source)
    runLoader(ctx2, source)

    // Both should produce identical output (same cached transform)
    const code1 = ctx1.callback.mock.calls[0]![1]
    const code2 = ctx2.callback.mock.calls[0]![1]
    expect(code1).toBe(code2)
  })

  it('passes node_modules sources through unchanged', () => {
    // Turbopack rules cannot carry a function-valued `exclude`, so this
    // in-loader check is the only node_modules gate on that path.
    const ctx = fakeContext({ resourcePath: '/project/node_modules/some-lib/Button.tsx' })
    const source = 'export default function B() { return <button /> }'
    runLoader(ctx, source)

    expect(ctx.callback).toHaveBeenCalledOnce()
    const [err, code, map] = ctx.callback.mock.calls[0]!
    expect(err).toBeNull()
    expect(code).toBe(source)
    expect(map).toBeUndefined()
  })

  it('still transforms packages allowlisted via includeNodeModules', () => {
    const ctx = fakeContext({
      resourcePath: '/project/node_modules/@acme/ui/Button.tsx',
      includeNodeModules: ['@acme/ui'],
    })
    const source = 'export default function B() { return <button /> }'
    runLoader(ctx, source)

    const [err, code] = ctx.callback.mock.calls[0]!
    expect(err).toBeNull()
    expect(code).toContain('data-cortex-source=')
  })

  it('re-creates transform when projectRoot changes', () => {
    // Both resources must sit UNDER their own root. ctx1 previously defaulted to
    // '/project/src/App.tsx' while its root was '/project-a', so it fell to the
    // outside-root basename branch — a different path, but for a reason that has
    // nothing to do with re-creating the transform.
    const ctx1 = fakeContext({ projectRoot: '/project-a', resourcePath: '/project-a/src/One.tsx' })
    const ctx2 = fakeContext({ projectRoot: '/project-b', resourcePath: '/project-b/src/Two.tsx' })
    const source = 'export default function A() { return <div /> }'

    runLoader(ctx1, source)
    runLoader(ctx2, source)

    // Assert the DISTINCT relative paths the comment always claimed. Checking only
    // that an attribute exists passes even when the transform is never re-created,
    // which is the one thing this test is named for.
    const code1 = ctx1.callback.mock.calls[0]![1] as string
    const code2 = ctx2.callback.mock.calls[0]![1] as string
    expect(code1).toContain('data-cortex-source="src/One.tsx:')
    expect(code2).toContain('data-cortex-source="src/Two.tsx:')
  })
})
