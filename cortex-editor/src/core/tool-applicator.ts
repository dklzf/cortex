/**
 * ToolApplicator — deterministic AST-based applicator for structured tool_use JSON actions.
 *
 * Accepts structured actions (set_inline_style, replace_attribute, replace_line_content)
 * and applies them to JSX source code via ts-morph AST manipulation or string operations.
 *
 * Uses in-memory file system (no disk I/O). Thread-safe for different files, not for the same file.
 */
import type { Project, SyntaxKind as SyntaxKindEnum } from 'ts-morph'
import { findJsxElementAt, cssPropertyToCamelCase } from './rewriter/jsx-utils.js'
import { LazyTsMorph } from './rewriter/lazy-ts-morph.js'

// ── Types ─────────────────────────────────────────────────────────

export type ToolAction =
  | { tool: 'set_inline_style'; changes: Array<{ property: string; value: string }> }
  | { tool: 'replace_attribute'; attribute: string; value: string }
  | { tool: 'replace_line_content'; lineNumber: number; oldContent: string; newContent: string }

export type ApplyResult =
  | { success: true; content: string }
  | { success: false; reason: string }

// Maximum distance from target element for replace_line_content.
//
// This was 25, described as "defense-in-depth" and derived from the context
// window half-width — i.e. from what the AI can SEE, not from what a real
// anchor error looks like. COR-28's actual offset was 19: the one
// distance-based guard in the codebase passed the real bug with six lines to
// spare, because the number came from intuition about a different quantity.
//
// A guard whose threshold is set above the observed error distribution is not
// defense-in-depth, it is decoration. 8 is below every offset measured so far
// (19 under Vite's plugin-react head; 0 under Turbopack) while staying wide
// enough for the ordinary case this exists to permit — an edit landing a few
// lines off after an unrelated in-file change.
//
// If a legitimate case beyond 8 shows up, raise it from a MEASUREMENT and say
// which one. Do not raise it to make a failing case pass.
const MAX_PROXIMITY = 8

// Allowlist for replace_attribute: styling-related + semantic attributes only.
// Blocks event handlers (on*), ref, and other behavioral attributes.
const ALLOWED_ATTRIBUTE_RE = /^(className|class|style|id|role|title|alt|htmlFor|tabIndex|hidden|disabled|aria-[a-z-]+|data-[a-z-]+)$/

/** Validate that a string is a single JSX attribute initializer — either a quoted string or a braced expression. */
function isValidJsxInitializer(v: string): boolean {
  if (/^"([^"\\]|\\.)*"$/.test(v) || /^'([^'\\]|\\.)*'$/.test(v)) return true
  if (v.startsWith('{') && v.endsWith('}')) return true
  return false
}

// ── ToolApplicator ────────────────────────────────────────────────

export class ToolApplicator {
  private morph = new LazyTsMorph('ToolApplicator', { useInMemoryFileSystem: true })

  /**
   * Apply a structured tool action to source content.
   *
   * For set_inline_style and replace_attribute, line/col are 1-based positions
   * identifying the target JSX element. For replace_line_content, the action's
   * lineNumber determines which line is modified, and the provided `line` argument
   * is used as the target line for proximity checking (col is ignored).
   */
  async apply(
    content: string,
    filePath: string,
    line: number,
    col: number,
    action: ToolAction,
  ): Promise<ApplyResult> {
    if (this.morph.isDisposed) {
      return { success: false, reason: 'Applicator is disposed' }
    }

    switch (action.tool) {
      case 'set_inline_style':
        return this.applySetInlineStyle(content, filePath, line, col, action.changes)
      case 'replace_attribute':
        return this.applyReplaceAttribute(content, filePath, line, col, action.attribute, action.value)
      case 'replace_line_content':
        return this.applyReplaceLineContent(content, line, action.lineNumber, action.oldContent, action.newContent)
      default: {
        const _exhaustive: never = action
        return { success: false, reason: `Unknown tool: ${(_exhaustive as ToolAction).tool}` }
      }
    }
  }

  // ── set_inline_style ──────────────────────────────────────────

  private async applySetInlineStyle(
    content: string,
    filePath: string,
    line: number,
    col: number,
    changes: Array<{ property: string; value: string }>,
  ): Promise<ApplyResult> {
    let project: Project
    let SK: typeof SyntaxKindEnum
    try {
      const ready = await this.morph.ensureReady()
      project = ready.project
      SK = ready.SK
    } catch (err) {
      return { success: false, reason: `Init failed: ${err instanceof Error ? err.message : err}` }
    }

    const sourceFile = project.createSourceFile(filePath, content, { overwrite: true })
    try {
      const jsxElement = findJsxElementAt(sourceFile, line, col, SK)
      if (!jsxElement) {
        return { success: false, reason: `No JSX element found at ${line}:${col}` }
      }

      // Look for existing style attribute
      const styleAttrRaw = jsxElement.getAttribute('style')
      const styleAttr = styleAttrRaw?.asKind(SK.JsxAttribute)

      if (!styleAttr) {
        // No style prop — add one with all changes
        const props = changes.map(c => {
          const key = this.formatObjectKey(cssPropertyToCamelCase(c.property))
          return `${key}: ${JSON.stringify(c.value)}`
        })
        jsxElement.addAttribute({
          name: 'style',
          initializer: `{{ ${props.join(', ')} }}`,
        })
        return { success: true, content: sourceFile.getFullText() }
      }

      // Has style attribute — inspect the initializer
      const initializer = styleAttr.getInitializer()
      if (!initializer) {
        return { success: false, reason: 'style attribute has no value' }
      }

      if (initializer.getKind() !== SK.JsxExpression) {
        return { success: false, reason: 'style attribute is not a JSX expression' }
      }

      const jsxExpr = initializer.asKind(SK.JsxExpression)
      const expression = jsxExpr?.getExpression()
      if (!expression) {
        return { success: false, reason: 'Empty JSX expression in style' }
      }

      // Non-literal expression: wrap with spread
      if (expression.getKind() !== SK.ObjectLiteralExpression) {
        const originalExprText = expression.getText()
        const props = changes.map(c => {
          const key = this.formatObjectKey(cssPropertyToCamelCase(c.property))
          return `${key}: ${JSON.stringify(c.value)}`
        })
        expression.replaceWithText(`{ ...${originalExprText}, ${props.join(', ')} }`)
        return { success: true, content: sourceFile.getFullText() }
      }

      const objLiteral = expression.asKind(SK.ObjectLiteralExpression)
      if (!objLiteral) {
        return { success: false, reason: 'Expected object literal expression' }
      }

      // Apply each change
      for (const change of changes) {
        const camelProp = cssPropertyToCamelCase(change.property)
        const result = this.applyOneStyleChange(objLiteral, camelProp, change.value, SK)
        if (!result.success) {
          return result
        }
      }

      return { success: true, content: sourceFile.getFullText() }
    } finally {
      project.removeSourceFile(sourceFile)
    }
  }

  /** Apply a single style property change to an ObjectLiteralExpression (mutates AST in place). */
  private applyOneStyleChange(
    objLiteral: import('ts-morph').ObjectLiteralExpression,
    camelProp: string,
    value: string,
    SK: typeof SyntaxKindEnum,
  ): { success: true } | { success: false; reason: string } {
    for (const prop of objLiteral.getProperties()) {
      const propKind = prop.getKind()

      // Shorthand assignment — bail
      if (propKind === SK.ShorthandPropertyAssignment) {
        const shorthand = prop.asKind(SK.ShorthandPropertyAssignment)
        if (!shorthand) continue
        if (shorthand.getName() === camelProp) {
          return { success: false, reason: `Property '${camelProp}' uses shorthand assignment` }
        }
        continue
      }

      if (propKind === SK.SpreadAssignment) continue

      if (propKind === SK.PropertyAssignment) {
        const propAssign = prop.asKind(SK.PropertyAssignment)
        if (!propAssign) continue
        const name = propAssign.getName()
        if (name !== camelProp) continue

        // Found the property — update its value
        const propInit = propAssign.getInitializer()
        if (!propInit) {
          return { success: false, reason: `Property '${camelProp}' has no initializer` }
        }

        const propInitKind = propInit.getKind()
        if (propInitKind !== SK.StringLiteral && propInitKind !== SK.NumericLiteral) {
          return { success: false, reason: `Property '${camelProp}' has non-literal value` }
        }

        propAssign.setInitializer(JSON.stringify(value))
        return { success: true }
      }
    }

    // Property not found — add it
    const propKey = this.formatObjectKey(camelProp)
    objLiteral.addPropertyAssignment({
      name: propKey,
      initializer: JSON.stringify(value),
    })
    return { success: true }
  }

  // ── replace_attribute ─────────────────────────────────────────

  private async applyReplaceAttribute(
    content: string,
    filePath: string,
    line: number,
    col: number,
    attribute: string,
    value: string,
  ): Promise<ApplyResult> {
    let project: Project
    let SK: typeof SyntaxKindEnum
    try {
      const ready = await this.morph.ensureReady()
      project = ready.project
      SK = ready.SK
    } catch (err) {
      return { success: false, reason: `Init failed: ${err instanceof Error ? err.message : err}` }
    }

    const sourceFile = project.createSourceFile(filePath, content, { overwrite: true })
    try {
      const jsxElement = findJsxElementAt(sourceFile, line, col, SK)
      if (!jsxElement) {
        return { success: false, reason: `No JSX element found at ${line}:${col}` }
      }

      // Validate attribute name against allowlist (security: prevent event handler injection)
      if (!ALLOWED_ATTRIBUTE_RE.test(attribute)) {
        return { success: false, reason: `Attribute '${attribute}' is not in the allowed list for AI edits` }
      }

      // Validate value is a single JSX attribute initializer — prevents smuggling
      // extra attributes via values like `"x" onClick={...}`
      const trimmedValue = value.trim()
      if (!isValidJsxInitializer(trimmedValue)) {
        return { success: false, reason: 'Invalid attribute value; must be a string literal or {expression}' }
      }

      // Check if attribute already exists
      const existingAttrRaw = jsxElement.getAttribute(attribute)
      const existingAttr = existingAttrRaw?.asKind(SK.JsxAttribute)

      if (existingAttr) {
        existingAttr.replaceWithText(`${attribute}=${trimmedValue}`)
      } else {
        jsxElement.addAttribute({
          name: attribute,
          initializer: trimmedValue,
        })
      }

      return { success: true, content: sourceFile.getFullText() }
    } finally {
      project.removeSourceFile(sourceFile)
    }
  }

  // ── replace_line_content ──────────────────────────────────────

  private applyReplaceLineContent(
    content: string,
    targetLine: number,
    lineNumber: number,
    oldContent: string,
    newContent: string,
  ): ApplyResult {
    const lines = content.split('\n')

    if (lineNumber < 1 || lineNumber > lines.length) {
      return { success: false, reason: `Line ${lineNumber} is out of bounds (file has ${lines.length} lines)` }
    }

    // Proximity check: reject edits far from the target element (defense-in-depth)
    if (Math.abs(lineNumber - targetLine) > MAX_PROXIMITY) {
      return { success: false, reason: `Line ${lineNumber} is too far from target line ${targetLine} (max distance: ${MAX_PROXIMITY})` }
    }

    const line = lines[lineNumber - 1]!
    if (line.trim() !== oldContent.trim()) {
      return {
        success: false,
        reason: `Line ${lineNumber} does not match expected content. Expected: "${oldContent.trim()}", found: "${line.trim()}"`,
      }
    }

    // Preserve the original line's leading whitespace
    const leadingWhitespace = line.match(/^(\s*)/)?.[1] ?? ''
    lines[lineNumber - 1] = leadingWhitespace + newContent.trimStart()

    return { success: true, content: lines.join('\n') }
  }

  // ── Utilities ─────────────────────────────────────────────────

  /**
   * Format an object key — quote it if it contains special characters
   * (CSS custom properties like --my-var need quoting).
   */
  private formatObjectKey(key: string): string {
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) return key
    return JSON.stringify(key)
  }

  dispose(): void {
    this.morph.dispose()
  }
}
