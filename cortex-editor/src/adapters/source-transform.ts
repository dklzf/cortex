import fs from 'fs'
import path from 'path'
import { parse } from '@babel/parser'
import MagicString from 'magic-string'
import type { SourceTransformOptions, TransformResult } from './types.js'
import { shouldExcludeCortexSource } from './source-loader-utils.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a string for safe use inside an HTML attribute value. */
const ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' }
function escapeAttr(s: string): string {
  return s.replace(/[&"'<>]/g, c => ESCAPE_MAP[c]!)
}

/** `convert-source-map`'s `mapFileCommentRegex`, exactly as Vite vendors it
 *  (vite/dist/node/chunks/dep-*.js). Copied rather than approximated, because an
 *  approximation is what broke the first attempt at this.
 *
 *  The load-bearing properties, each of which a looser pattern gets wrong:
 *   - `$` with the `m` flag — the comment must END A LINE. An unanchored pattern
 *     matches `sourceMappingURL=` inside a string literal or JSX text, mid-line.
 *   - `[ \t]` rather than `\s` — cannot swallow newlines and merge two lines.
 *   - `[^\s'"\`]+?` on the `//` form — stops at a quote, so a quoted URL in
 *     source code is not treated as an annotation.
 *   - the block form REQUIRES a closing `*​/` — an unterminated `/*#` is not a
 *     comment and must not be blanked.
 *
 *  Only ever used with `String.replace`, which resets `lastIndex`; never `.test()`
 *  on this shared `/g` object. */
const VITE_MAP_FILE_COMMENT_RE =
  /(?:\/\/[@#][ \t]+?sourceMappingURL=([^\s'"`]+?)[ \t]*?$)|(?:\/\*[@#][ \t]+sourceMappingURL=([^*]+?)[ \t]*?(?:\*\/){1}[ \t]*?$)/gm

function hasBom(s: string): boolean {
  return s.charCodeAt(0) === 0xfeff
}

/** `fs.realpathSync` with a lexical fallback. Used to make containment agree with
 *  the apply side, which realpaths its own root — a purely lexical check accepts
 *  an in-root symlink whose target is outside, and apply then refuses the write. */
function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** Model Vite's own pre-plugin preprocessing, ONE WAY: disk text -> the text Vite
 *  would hand a plugin.
 *
 *  Vite extracts a valid `sourceMappingURL` comment and blanks it to spaces of the
 *  same length before any plugin transform runs. That is coordinate-safe, but a
 *  plain equality test still sees a difference and refuses a file cortex could have
 *  annotated correctly — and reordering plugins cannot help, because Vite does this
 *  before plugins are consulted at all.
 *
 *  DIRECTION IS THE WHOLE POINT. An earlier revision blanked matches on BOTH
 *  strings, which let a genuine rewrite be erased symmetrically: given
 *  `const s="//# sourceMappingURL=a"` on disk and `...=abcdef` incoming, both
 *  collapsed to equal text while the real JSX after them sat at different columns.
 *  Cortex accepted and stamped a position that resolved to a DIFFERENT element on
 *  disk — recreating exactly the wrong-element write this guard exists to stop.
 *
 *  Transforming only the disk side cannot erase anything present in the incoming
 *  text, so a real upstream rewrite still shows up as a difference.
 *
 *  NEWLINES SURVIVE THE BLANKING. The block form's URL capture is `[^*]+?`, and a
 *  negated class matches `\n` — so `/*# sourceMappingURL=foo.map\n*​/` is one match
 *  spanning two lines. A flat `' '.repeat(m.length)` is the same LENGTH but not the
 *  same SHAPE: it turns that newline into a space and every following line moves up
 *  one. Vite's own blank replacer does exactly that, so the two sides would agree,
 *  the guard would accept, and cortex would stamp JSX a line high — the wrong-element
 *  write, one more time. Preserving `\n` keeps this position-preserving BY
 *  CONSTRUCTION: single-line comments (the real-world case) blank identically to
 *  before, and a multiline one no longer matches Vite's collapsed text, so the guard
 *  refuses. Fail closed beats a clever match. */
function asViteInput(diskText: string): string {
  return diskText.replace(VITE_MAP_FILE_COMMENT_RE, m => m.replace(/[^\n]/g, ' '))
}

/** Collapse CRLF to LF. Symmetric and position-preserving: line and column
 *  numbering is identical either way. Deliberately NOT trimmed — trailing
 *  whitespace is a real rewrite signal and leading whitespace shifts every
 *  position in the file. */
function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

/** Line count, for the provenance-mismatch diagnostic. Reports the shape of the
 *  divergence (e.g. "109 lines in, 90 on disk" identifies a 19-line preamble)
 *  without logging file contents, which may be proprietary. */
function countLines(s: string): number {
  let n = 1
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/**
 * Extract the tag name and its end position from a JSXOpeningElement's name node.
 * Handles JSXIdentifier, JSXMemberExpression, and JSXNamespacedName.
 * Returns null for unrecognized name types.
 */
function resolveJSXName(
  name: Record<string, unknown>,
): { tagName: string; endPos: number } | null {
  if (name.type === 'JSXIdentifier') {
    const endPos = name.end
    if (typeof endPos !== 'number') return null
    const tagName = name.name
    /* v8 ignore next */
    if (typeof tagName !== 'string') return null
    return { tagName, endPos }
  }
  if (name.type === 'JSXMemberExpression') {
    const prop = name.property as Record<string, unknown>
    const endPos = prop.end
    if (typeof endPos !== 'number') return null
    const tagName = prop.name
    /* v8 ignore next */
    if (typeof tagName !== 'string') return null
    return { tagName, endPos }
  }
  if (name.type === 'JSXNamespacedName') {
    const n = name.name as Record<string, unknown>
    const endPos = n.end
    if (typeof endPos !== 'number') return null
    const tagName = n.name
    /* v8 ignore next */
    if (typeof tagName !== 'string') return null
    return { tagName, endPos }
  }
  /* v8 ignore next */
  return null
}

// ---------------------------------------------------------------------------
// AST walker
// ---------------------------------------------------------------------------

/** Keys that are never AST children — skip to avoid recursing into metadata. */
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments'])

/**
 * Shared parse options — hoisted to module scope to avoid per-call allocation.
 * `@babel/parser` reads but doesn't mutate the options, so sharing is safe.
 *
 * Note: the decorator `version` field is accepted at runtime but missing from
 * `@babel/parser`'s type definitions, hence the `Record<string, string>` cast.
 */
const PARSE_OPTIONS = {
  sourceType: 'module' as const,
  plugins: [
    'typescript',
    'jsx',
    ['decorators', { version: '2023-07' } as Record<string, string>],
    'importAttributes',
    'explicitResourceManagement',
  ],
  ranges: false,
}

/**
 * Iterative DFS walk of a Babel AST, calling visitor on every JSXOpeningElement.
 * Uses Record<string, unknown> rather than Babel's full type hierarchy
 * to avoid coupling to 100+ node types that change between versions.
 */
function walkJSX(root: Record<string, unknown>, visitor: (el: Record<string, unknown>) => void): void {
  const stack: Record<string, unknown>[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (!node || typeof node !== 'object') continue
    if (node.type === 'JSXOpeningElement') visitor(node)
    const keys = Object.keys(node)
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!
      if (SKIP_KEYS.has(key)) continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (let j = value.length - 1; j >= 0; j--) {
          const item = value[j]
          if (item && typeof item === 'object') {
            stack.push(item as Record<string, unknown>)
          }
        }
      } else if (value && typeof value === 'object') {
        stack.push(value as Record<string, unknown>)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CSS Module annotation helpers
// ---------------------------------------------------------------------------

interface CSSModuleBinding {
  localName: string
  cssPath: string  // Relative to project root, forward slashes
}

/**
 * Collect CSS module import bindings from the AST.
 * Walks ImportDeclaration nodes and collects default imports of .module.css files.
 */
function collectCSSModuleImports(
  ast: Record<string, unknown>,
  cleanId: string,
  projectRoot: string,
  resolveAlias?: (specifier: string) => string | null,
): CSSModuleBinding[] {
  const program = ast.program as Record<string, unknown> | undefined
  const body = program?.body as Array<Record<string, unknown>> | undefined
  if (!body) return []

  const bindings: CSSModuleBinding[] = []
  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue
    const source = node.source as Record<string, unknown> | undefined
    const specifier = source?.value as string | undefined
    if (!specifier || !specifier.endsWith('.module.css')) continue

    let resolvedPath: string | null = null
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      // Relative import — resolve relative to importing file's directory
      resolvedPath = path.resolve(path.dirname(cleanId), specifier)
    } else if (resolveAlias) {
      // Aliased import — resolve via bundler alias map
      const aliasResolved = resolveAlias(specifier)
      if (aliasResolved) {
        if (path.isAbsolute(aliasResolved)) {
          resolvedPath = aliasResolved
        } else {
          resolvedPath = path.resolve(projectRoot, aliasResolved)
        }
      }
    }
    if (!resolvedPath) continue

    // Make relative to project root with forward slashes
    const cssPath = path.relative(projectRoot, resolvedPath).replace(/\\/g, '/')

    const specifiers = node.specifiers as Array<Record<string, unknown>> | undefined
    if (!specifiers) continue
    for (const spec of specifiers) {
      if (spec.type === 'ImportDefaultSpecifier') {
        const local = spec.local as Record<string, unknown> | undefined
        const name = local?.name as string | undefined
        if (name) bindings.push({ localName: name, cssPath })
      } else if (spec.type === 'ImportSpecifier') {
        // import { default as s } from './X.module.css'
        const imported = spec.imported as Record<string, unknown> | undefined
        const importedName = imported?.type === 'Identifier'
          ? (imported.name as string)
          : imported?.type === 'StringLiteral' ? (imported.value as string) : null
        if (importedName === 'default') {
          const local = spec.local as Record<string, unknown> | undefined
          const name = local?.name as string | undefined
          if (name) bindings.push({ localName: name, cssPath })
        }
      }
    }
  }
  return bindings
}

/**
 * Extract CSS module selectors from a className expression by walking for
 * MemberExpression nodes whose object matches a CSS module binding.
 */
function extractCSSSelectors(
  expr: Record<string, unknown>,
  bindingMap: Map<string, string>,
): { cssPath: string; selector: string }[] {
  const results: { cssPath: string; selector: string }[] = []
  walkExprForBindings(expr, bindingMap, results)
  return results
}

function walkExprForBindings(
  node: Record<string, unknown>,
  bindingMap: Map<string, string>,
  results: { cssPath: string; selector: string }[],
): void {
  if (!node || typeof node !== 'object' || !node.type) return

  if (node.type === 'MemberExpression') {
    const obj = node.object as Record<string, unknown> | undefined
    if (obj?.type === 'Identifier') {
      const cssPath = bindingMap.get(obj.name as string)
      if (cssPath) {
        const computed = node.computed as boolean | undefined
        const prop = node.property as Record<string, unknown> | undefined
        if (computed) {
          if (prop?.type === 'StringLiteral') {
            results.push({ cssPath, selector: `.${prop.value as string}` })
          } else {
            // Dynamic access: styles[variant] → wildcard
            results.push({ cssPath, selector: '*' })
          }
        } else if (prop?.type === 'Identifier') {
          results.push({ cssPath, selector: `.${prop.name as string}` })
        }
        return  // Don't recurse into already-matched MemberExpression
      }
    }
  }

  // Recurse into child nodes (covers CallExpression args, ObjectExpression keys, etc.)
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key) || key === 'type') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object') {
          walkExprForBindings(item as Record<string, unknown>, bindingMap, results)
        }
      }
    } else if (val && typeof val === 'object') {
      walkExprForBindings(val as Record<string, unknown>, bindingMap, results)
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a source transform function bound to a project root.
 * The returned function adds `data-cortex-source="relativePath:line:col"`
 * attributes to lowercase JSX elements (including member expressions like
 * motion.div). Returns null if no changes were made.
 *
 * Format: `data-cortex-source="relativePath:line:col"` where line and col
 * are the last two colon-separated segments. Paths are always relative
 * (no drive letters) with forward slashes.
 *
 * Note: Only `.jsx` and `.tsx` files are processed. Projects using JSX in
 * `.js`/`.ts` files should rename them or configure the framework adapter.
 *
 * When wrapping in a Vite plugin, use `enforce: 'pre'` so this runs
 * before React's JSX compilation removes JSX syntax.
 */
export function createSourceTransform(
  projectRoot: string,
  options?: SourceTransformOptions,
): (code: string, id: string) => TransformResult | null {
  const isProd = options?.mode === 'production' ||
    (options?.mode == null && process.env.NODE_ENV === 'production')

  // One unreadable-source warning per transform instance — see the guard below.
  let warnedUnreadable = false
  let warnedUnmappable = false

  return function transformSource(code: string, id: string): TransformResult | null {
    if (isProd) return null
    // Strip Vite HMR query params (e.g. ?v=abc123) before extension check
    const cleanId = id.split('?')[0]!
    if (!/\.[jt]sx$/.test(cleanId)) return null
    if (shouldExcludeCortexSource(cleanId, options?.includeNodeModules)) return null

    // ── Provenance guard ────────────────────────────────────────────────
    // Babel's `node.loc` is a coordinate in THE STRING WE HAND THE PARSER.
    // We write that coordinate into `data-cortex-source`, and the apply side
    // later resolves it against THE FILE ON DISK (edit-pipeline parseSource →
    // findJsxElementAt). Those are the same coordinate space only if nothing
    // upstream rewrote the text.
    //
    // When they diverge, every stamp is silently wrong and nothing downstream
    // can tell: findJsxElementAt does a zero-tolerance position lookup and
    // returns whatever JSX node occupies that offset. COR-28 shipped exactly
    // this — @vitejs/plugin-react prepends a 16-line refresh head plus a 3-line
    // shared head, so every anchor was +19 lines and pointed at an unrelated
    // element.
    //
    // A confirmed mismatch means we cannot produce a trustworthy anchor, so we
    // produce none. Loudly absent beats silently wrong: a missing anchor routes
    // the element to `agent-resolve`, while a wrong one rewrites the user's
    // source at a position they never selected.
    //
    // FAIL CLOSED. An earlier revision proceeded when the file could not be read
    // ("unknown is not violated"). That was wrong, and it is the exact hole this
    // guard exists to close: the attribute we emit is not advisory. Its presence
    // alone forces `applyMode: 'direct'` in getElementEditTarget, which makes the
    // recorded line:col a deterministic WRITE TARGET. An anchor we cannot verify
    // is therefore indistinguishable downstream from one we can, and unverifiable
    // provenance is not a weaker version of correct provenance — it is the
    // absence of the precondition the whole mechanism rests on.
    //
    // So: virtual ids and unreadable files get NO anchor. The element degrades to
    // `agent-resolve` with a DOM hint, which is a designed, safe path — Claude
    // resolves the source instead of cortex asserting it.
    {
      let onDisk: string | null = null
      let reason: 'virtual' | 'unreadable' | 'mismatch' | null = null

      if (id.includes('\0')) {
        // Rollup/Vite virtual module convention. There is no file to compare to.
        reason = 'virtual'
      } else {
        try {
          // `readSource` lets an adapter whose modules are not on the native
          // filesystem supply the authoritative text instead. It is compared
          // identically — a seam for proving provenance, never for skipping it.
          const read = options?.readSource
            ? options.readSource(cleanId)
            : fs.readFileSync(cleanId, 'utf8')
          // `readSource` is user-supplied and only type-checked for TS consumers.
          // A JS adapter returning `undefined` would slip past the `=== null` test
          // below and reach `hasBom`, throwing OUTSIDE this try — killing the
          // transform hook instead of failing closed. Anything that is not text is
          // not provenance.
          onDisk = typeof read === 'string' ? read : null
        } catch {
          onDisk = null
        }
        if (onDisk === null) {
          // Missing, EACCES, memory-fs with no reader, generated route — all the
          // same to us: the precondition cannot be established, so no anchor.
          reason = 'unreadable'
        }
        if (onDisk !== null) {
          // A BOM is a real character at offset 0, so a ONE-SIDED BOM shifts every
          // column on line 1 by one. Stripping it asymmetrically would silently
          // accept a file whose line-1 coordinates do not line up. Treat the
          // asymmetry as what it is — a coordinate difference.
          if (hasBom(onDisk) !== hasBom(code)) {
            reason = 'mismatch'
          } else {
            const disk = normalizeEol(onDisk)
            const input = normalizeEol(code)
            // Exact first. Only if that fails do we allow the ONE narrow, known
            // upstream rewrite: Vite blanking its own source-map comment before
            // plugins run. Modelled one-way (disk -> input) so nothing present in
            // the incoming text can be erased to force a match.
            if (disk !== input && asViteInput(disk) !== input) {
              reason = 'mismatch'
            }
          }
        }
      }

      if (reason !== null) {
        const detail = {
          reason,
          inputLines: countLines(code),
          diskLines: onDisk === null ? -1 : countLines(onDisk),
        }
        if (options?.onProvenanceMismatch) {
          options.onProvenanceMismatch(id, detail)
        } else if (reason === 'unreadable' && !warnedUnreadable) {
          // Deduplicated to ONCE per transform instance. Unreadable ids are
          // routine in some setups, so warning per file would be log spam — but
          // warning never at all makes "annotation silently stopped working"
          // undiagnosable, which is how a whole adapter can go dark unnoticed.
          // One line naming the first case, and how to fix it, is the balance.
          warnedUnreadable = true
          console.warn(
            `[cortex] Could not read ${cleanId} to verify it matches what cortex was handed, ` +
            `so it was left unannotated (elements there fall back to agent resolution).\n` +
            `[cortex] If this project's modules are not on the native filesystem, supply ` +
            `\`readSource\` so cortex can verify them. Further occurrences are not logged.`,
          )
        } else if (reason === 'mismatch') {
          // Only the mismatch case is worth a loud warning: it means a real,
          // fixable misconfiguration. Virtual and unreadable ids are routine in
          // many setups and would make this a log-spam machine.
          console.warn(
            `[cortex] Refusing to annotate ${cleanId}: the code handed to cortex is not the file on disk ` +
            `(${detail.inputLines} lines in, ${detail.diskLines} on disk). Another plugin transformed it ` +
            `first, so any line:col cortex records would point at the wrong element.\n` +
            `[cortex] Fix: move cortexEditor() earlier in your plugins array than the plugin that ` +
            `transformed this file.`,
          )
        }
        return null
      }
    }

    // The stamped path is not decoration: the apply side resolves it UNDER
    // projectRoot (`resolve(this.projectRoot, filePath)` in edit-pipeline.ts), so
    // it is a write target. Collapsing an outside-root file to its basename made
    // `/workspace/pkg/Button.tsx` stamp `Button.tsx`, which apply then resolved to
    // `<projectRoot>/Button.tsx` — an unrelated file that cortex would happily
    // rewrite if it held JSX at that line:col. A silent wrong-FILE write, strictly
    // worse than the wrong-ELEMENT write COR-28 fixed, and the provenance guard
    // above cannot see it: that guard verifies `cleanId`, the correct path, and
    // the basename reduction happened afterward — so it made an unmappable stamp
    // look verified.
    // Canonical means REALPATH, not just `resolve`. `path.resolve` is purely
    // lexical, so an in-root symlink pointing outside (`node_modules/@acme/ui ->
    // ../../packages/ui` with includeNodeModules) reads as contained and gets an
    // anchor — and then apply's `isWriteTargetInsideRoot`, which DOES realpath,
    // refuses the write. The element fails to edit instead of degrading to
    // agent-resolve, which is the opposite of the intent here. Match what apply
    // computes. Best-effort: fall back to `resolve` if realpath throws (the file
    // was read successfully just above, but projectRoot may not exist).
    const canonicalRoot = realpathOr(projectRoot)
    const canonicalId = realpathOr(cleanId)
    const relNative = path.relative(canonicalRoot, canonicalId)
    const relativePath = relNative.replace(/\\/g, '/')

    // Segment-aware containment, per this repo's path-matching rule. A bare
    // `startsWith('..')` is wrong in BOTH directions: it misses nothing here, but
    // it also fires on a legitimate in-root directory literally named `..hidden`,
    // which was then silently collapsed to a basename too.
    const escapesRoot =
      relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relNative)

    // Validate the SERIALIZED path — the one actually stamped — not the native
    // one it was derived from. Round-tripping `relNative` is a tautology: it came
    // from `path.relative` of these same two values. The forward-slash rewrite is
    // where meaning can change, and on POSIX `\` is a legal FILENAME character:
    // `/repo/src/foo\bar.tsx` serializes to `src/foo/bar.tsx`, a different file
    // that apply would resolve and rewrite. That is COR-30 again, one layer down.
    //
    // Equality via `path.relative(a, b) === ''` rather than `===` so the compare
    // matches the platform's own rules — Windows treats drive letters and
    // components case-insensitively, so a root of `C:\Repo` reached as `C:\repo`
    // would otherwise be a false refusal that silently disables all annotations.
    const stampResolvesBack =
      path.relative(path.resolve(canonicalRoot, relativePath), canonicalId) === ''

    if (escapesRoot || !stampResolvesBack) {
      const detail = {
        reason: 'unmappable' as const,
        inputLines: countLines(code),
        diskLines: -1,
      }
      if (options?.onProvenanceMismatch) {
        options.onProvenanceMismatch(id, detail)
      } else if (!warnedUnmappable) {
        // Deduplicated like the unreadable warning: a monorepo can hit this for
        // every file in a linked package, and per-file output would be spam. But
        // silence would make a whole package quietly lose deterministic edits.
        warnedUnmappable = true
        // The two causes need DIFFERENT advice. Widening projectRoot fixes
        // containment and does nothing for a filename whose forward-slash
        // serialization names another path — sending someone to edit their config
        // for that is worse than saying nothing, because they will change it, see
        // no improvement, and conclude cortex is broken.
        console.warn(
          escapesRoot
            ? `[cortex] Refusing to annotate ${cleanId}: it resolves outside projectRoot ` +
              `(${canonicalRoot}), so the position cortex records could not be mapped back ` +
              `to this file. Apply resolves stamped paths under projectRoot, so a stamp ` +
              `here would name a DIFFERENT file.\n` +
              `[cortex] Elements there fall back to agent resolution. If these files should ` +
              `be editable, point projectRoot at a directory that contains them (following ` +
              `symlinks — containment is checked against real paths). Further occurrences ` +
              `are not logged.`
            : `[cortex] Refusing to annotate ${cleanId}: its path cannot be written as a ` +
              `forward-slash path that resolves back to it. A literal backslash in a POSIX ` +
              `filename is the usual cause — cortex would stamp a path naming a DIFFERENT ` +
              `file, which apply would then resolve and edit.\n` +
              `[cortex] Elements there fall back to agent resolution. Widening projectRoot ` +
              `will NOT help; rename the file if you need deterministic edits on it. ` +
              `Further occurrences are not logged.`,
        )
      }
      return null
    }

    const safePath = relativePath
    const escapedPath = escapeAttr(safePath)

    let ast: Record<string, unknown>
    try {
      ast = parse(code, PARSE_OPTIONS as Parameters<typeof parse>[1]) as unknown as Record<string, unknown>
    } catch (e) {
      if (options?.onParseError) {
        options.onParseError(id, e)
      } else {
        console.warn(`[cortex] Failed to parse ${cleanId}:`, e instanceof Error ? e.message : e)
      }
      return null
    }

    // Pre-pass: collect CSS module import bindings
    const cssBindings = collectCSSModuleImports(ast, cleanId, projectRoot, options?.resolveAlias)
    const bindingMap = new Map<string, string>()
    for (const b of cssBindings) bindingMap.set(b.localName, b.cssPath)

    let s = null as MagicString | null

    walkJSX(ast, (el) => {
      const name = el.name as Record<string, unknown> | undefined
      if (!name) return

      const resolved = resolveJSXName(name)
      if (!resolved || !/^[a-z]/.test(resolved.tagName)) return

      const start = el.start as number | null | undefined
      if (start == null || start < 0 || start >= code.length) return

      if (resolved.endPos < 0 || resolved.endPos > code.length) return
      if (resolved.endPos < start) return

      // Skip elements that already have the attribute (AST-level idempotency)
      const attrs = el.attributes as Array<Record<string, unknown>> | undefined
      if (attrs?.some(a => a.type === 'JSXAttribute' &&
        (a.name as Record<string, unknown>)?.name === 'data-cortex-source')) return

      const loc = el.loc as { start: { line: number; column: number } } | undefined
      if (!loc) return

      const line = loc.start.line
      const col = loc.start.column + 1  // Babel is 0-based column, we want 1-based

      if (!s) s = new MagicString(code)
      s.appendLeft(resolved.endPos, ` data-cortex-source="${escapedPath}:${line}:${col}"`)

      // CSS Module annotation: check className for CSS module binding references
      if (bindingMap.size > 0 && attrs) {
        // Skip if element already has data-cortex-css
        if (attrs.some(a => a.type === 'JSXAttribute' &&
          (a.name as Record<string, unknown>)?.name === 'data-cortex-css')) return

        for (const attr of attrs) {
          if (attr.type !== 'JSXAttribute') continue
          const attrName = attr.name as Record<string, unknown> | undefined
          if (attrName?.name !== 'className') continue

          const attrValue = attr.value as Record<string, unknown> | undefined
          if (!attrValue) continue

          // className="static" → no annotation (StringLiteral, not CSS Modules)
          if (attrValue.type === 'StringLiteral') continue

          // className={expression} → walk expression for CSS module bindings
          let expr: Record<string, unknown> | undefined
          if (attrValue.type === 'JSXExpressionContainer') {
            expr = attrValue.expression as Record<string, unknown> | undefined
          }
          if (!expr || expr.type === 'JSXEmptyExpression') continue

          const selectors = extractCSSSelectors(expr, bindingMap)
          if (selectors.length === 0) continue

          // Group selectors by CSS file path
          const grouped = new Map<string, string[]>()
          for (const sel of selectors) {
            const existing = grouped.get(sel.cssPath) ?? []
            existing.push(sel.selector)
            grouped.set(sel.cssPath, existing)
          }

          // Build annotation: "cssPath:selector1,selector2"
          // Use first CSS file path (most common case: one CSS module per element)
          const [cssPath, sels] = grouped.entries().next().value!
          const uniqueSels = [...new Set(sels)]
          const annotation = `${cssPath}:${uniqueSels.join(',')}`

          if (!s) s = new MagicString(code)
          s.appendLeft(resolved.endPos, ` data-cortex-css="${escapeAttr(annotation)}"`)
          break  // Only one className attribute per element
        }
      }
    })

    if (s == null || !s.hasChanged()) return null
    return {
      code: s.toString(),
      map: s.generateMap({
        hires: 'boundary',
        source: safePath,
        file: safePath,
        includeContent: true,
      }) as TransformResult['map'],
    }
  }
}
