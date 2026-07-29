import { classAttr } from './class-attr.js'

export interface SourceInfo {
  componentName: string | null
  fileName: string
  line: string
  filePath: string
}

/** Parse a data-cortex-source attribute into structured parts.
 *  Splits from the right so Windows drive letters (C:\...) don't break parsing. */
export function parseCortexSource(el: Element): SourceInfo | null {
  const source = el.getAttribute('data-cortex-source')
  if (!source) return null

  // Split from the right: last two colon segments are line:col.
  // Validate segments are numeric to avoid misinterpreting Windows drive letters.
  const lastColon = source.lastIndexOf(':')
  const secondLastColon = source.lastIndexOf(':', lastColon - 1)

  let filePath: string
  let line: string
  if (secondLastColon > 0) {
    const candidateLine = source.slice(secondLastColon + 1, lastColon)
    const candidateCol = source.slice(lastColon + 1)
    if (/^\d+$/.test(candidateLine) && /^\d+$/.test(candidateCol)) {
      filePath = source.slice(0, secondLastColon)
      line = candidateLine
    } else if (lastColon > 0 && /^\d+$/.test(source.slice(lastColon + 1))) {
      filePath = source.slice(0, lastColon)
      line = source.slice(lastColon + 1)
    } else {
      filePath = source
      line = ''
    }
  } else if (lastColon > 0 && /^\d+$/.test(source.slice(lastColon + 1))) {
    filePath = source.slice(0, lastColon)
    line = source.slice(lastColon + 1)
  } else {
    filePath = source
    line = ''
  }

  const fileName = filePath.split(/[/\\]/).pop() ?? filePath
  const baseName = fileName.replace(/\.\w+$/, '')
  const componentName = /^[A-Z]/.test(baseName) ? baseName : null

  return { componentName, fileName, line, filePath }
}

/** Encode a file path for use in vscode:// URIs.
 *  encodeURIComponent per segment preserves slashes but encodes #, ?, & etc. */
export function encodeFilePath(filePath: string): string {
  return filePath.split(/([/\\])/).map((seg, i) =>
    seg === '/' || seg === '\\'
      ? seg
      : i === 0 && /^[A-Za-z]:$/.test(seg)
        ? seg
        : encodeURIComponent(seg),
  ).join('')
}

/** Check if a file path refers to a node_modules package (handles relative paths). */
function isNodeModulesPath(filePath: string): boolean {
  return filePath.includes('/node_modules/') || filePath.startsWith('node_modules/')
}

/** Check if an element comes from a third-party library (node_modules). */
export function isLibraryComponent(el: Element): boolean {
  const info = parseCortexSource(el)
  if (!info) return false
  return isNodeModulesPath(info.filePath)
}

/** Walk up the DOM to find the closest ancestor with a user-space source. */
export function findUserAncestor(
  el: Element,
): { source: SourceInfo; element: Element } | null {
  // `parentElement` is typed `HTMLElement | null` by lib.dom, which is a lie for
  // namespaced trees — an <svg>'s parent chain is SVGElement. Annotate honestly.
  let current: Element | null = el.parentElement
  while (current) {
    const source = parseCortexSource(current)
    if (source && !isNodeModulesPath(source.filePath)) {
      return { source, element: current }
    }
    current = current.parentElement
  }
  return null
}

/** Get a Chrome DevTools-style label for the layer tree: tag.firstClass or just tag.
 *  Always shows the HTML element, never the component name — "section.hero" not "Features". */
export function getTreeLabel(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const cls = classAttr(el)
  if (cls.trim()) {
    return `${tag}.${cls.trim().split(/\s+/)[0]}`
  }
  return tag
}

/** Get a compact label (hover overlay) */
export function getLabel(el: Element): string {
  const info = parseCortexSource(el)
  if (info?.componentName) return info.componentName

  const tag = el.tagName.toLowerCase()
  const cls = classAttr(el)
  if (cls.trim()) {
    return `${tag}.${cls.trim().split(/\s+/)[0]}`
  }
  return tag
}

/** Get a detailed label (selection overlay) */
export function getSelectionLabel(el: Element): string {
  const info = parseCortexSource(el)
  if (!info) {
    const tag = el.tagName.toLowerCase()
    const cls = classAttr(el)
    if (cls.trim()) {
      return `${tag}.${cls.trim().split(/\s+/)[0]}`
    }
    return tag
  }

  const { componentName, fileName, line } = info
  if (componentName && line) return `${componentName} — ${fileName}:${line}`
  if (componentName) return `${componentName} — ${fileName}`
  if (line) return `${fileName}:${line}`
  return fileName
}
