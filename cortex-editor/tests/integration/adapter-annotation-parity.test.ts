import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Both adapters must build an annotation from the SAME fields.
 *
 * This asymmetry has now bitten twice. In 0.3.1 the webpack adapter never sent
 * `annotation-updated` or `activity-entry`, so Next apps had a dead pin list and
 * a dead activity feed. In COR-27 review, codex found the same shape again: only
 * the Vite handler forwarded the new `sourceResolutionHint`, so an unannotated
 * click on webpack/Next stored a session-local `cortex-preview:` id and dropped
 * the only thing that could resolve it.
 *
 * Both times the fix was "add the missing field to the other adapter", and both
 * times that left the NEXT field free to go missing. This test asserts the
 * property instead of the instance: whatever set of keys one handler passes to
 * `annotations.create`, the other passes too.
 *
 * Deliberately source-text based. A behavioural test would need both adapters
 * booted against a real bundler, which is exactly why the gap survived — no
 * cheap test covered it, so no test covered it.
 */
const KEYS = /annotations\.create\(\{([\s\S]*?)\}\)/

function createKeys(relPath: string): Set<string> {
  const text = readFileSync(fileURLToPath(new URL(`../../src/adapters/${relPath}`, import.meta.url)), 'utf8')
  const match = KEYS.exec(text)
  if (!match?.[1]) throw new Error(`[parity] no annotations.create({...}) call found in ${relPath}`)
  return new Set(
    match[1]
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, '').trim())
      .map(line => /^([A-Za-z_$][\w$]*)\s*:/.exec(line)?.[1])
      .filter((k): k is string => !!k),
  )
}

describe('adapter parity: annotation creation', () => {
  it('vite and webpack forward the same fields to annotations.create', () => {
    const vite = createKeys('vite.ts')
    const webpack = createKeys('webpack.ts')

    // Non-empty, or a regex that silently matched nothing would make this pass
    // while asserting about two empty sets — the failure mode this whole file
    // exists to prevent.
    expect(vite.size).toBeGreaterThan(4)
    expect([...webpack].sort()).toEqual([...vite].sort())
  })

  it('both forward sourceResolutionHint specifically (COR-27)', () => {
    // The parity check above would also pass if BOTH adapters dropped the field.
    // This pins the one that motivated the test, so a symmetric regression is
    // still caught.
    expect(createKeys('vite.ts').has('sourceResolutionHint')).toBe(true)
    expect(createKeys('webpack.ts').has('sourceResolutionHint')).toBe(true)
  })
})
