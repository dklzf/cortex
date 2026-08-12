import type { JSX } from 'preact'
import { useState, useEffect, useCallback } from 'preact/hooks'
import type { Annotation, CortexChannel } from '../../adapters/types.js'
import { CommentThread } from './CommentThread.js'
import { PANEL_WIDTH } from '../hooks/useSnapToEdge.js'
import {
  getElementEditTarget,
  selectorForEditSource,
  isPreviewSource,
  PREVIEW_SOURCE_ATTR,
  PREVIEW_SOURCE_PREFIX,
  type SourceResolutionHint,
} from '../preview-source.js'

// COR-27: resolves BOTH source formats. It previously matched only
// `data-cortex-source`, which is why a preview-sourced pin could not be located
// at all — the reason comments were retargeted to an annotated ancestor rather
// than refused. `selectorForEditSource` is the shared seam style edits already
// use, so the two paths cannot drift on how a source is turned back into a node.
const sourceSelector = selectorForEditSource

/**
 * Find the element an annotation refers to, surviving a page reload.
 *
 * A `cortex-preview:` source is a page-session id that lives ONLY as an
 * attribute on the node that was clicked. After a reload the server rehydrates
 * the annotation through `annotations-snapshot`, but the freshly-rendered
 * element never receives the old id — so the selector matched nothing and the
 * pin silently disappeared while the annotation was still active. Raised in
 * review; a comment that vanishes is worse than one that is merely misplaced,
 * because the user has no way to tell it still exists.
 *
 * The `sourceResolutionHint` already travels with the annotation for the
 * agent's benefit, and its `domSelector` is exactly the locator needed here.
 * Re-stamping the preview id on the match makes the recovery stick for the rest
 * of the session, so this runs once per annotation rather than on every scroll
 * frame.
 *
 * Deliberately no fallback for a `file:line:col` source: those survive reloads
 * on their own, and inventing a second lookup for them would add a way to
 * resolve the WRONG element to a path that currently cannot.
 */
function locateAnnotated(ann: Annotation): Element | null {
  const direct = document.querySelector(sourceSelector(ann.elementSource))
  if (direct) return direct

  const selector = ann.sourceResolutionHint?.domSelector
  if (!selector || !isPreviewSource(ann.elementSource)) return null
  let recovered: Element | null = null
  try {
    // Page-derived, so it can be malformed — querySelector THROWS on an invalid
    // selector, which would take down every other pin on the page with it.
    recovered = document.querySelector(selector)
  } catch {
    return null
  }
  if (recovered) {
    recovered.setAttribute(
      PREVIEW_SOURCE_ATTR,
      ann.elementSource.slice(PREVIEW_SOURCE_PREFIX.length),
    )
  }
  return recovered
}

export interface CommentPinProps {
  annotations: Annotation[]
  commentMode: boolean
  channel: CortexChannel
  onReply: (annotationId: string, text: string) => void
}

export function CommentPin({ annotations, commentMode, channel, onReply }: CommentPinProps): JSX.Element {
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null)
  const [pinTarget, setPinTarget] = useState<{
    clickX: number
    clickY: number
    elementSource: string
    /** Present when the clicked element carries no `data-cortex-source`, so the
     *  source is a preview id that means nothing outside this page session.
     *  Without it the agent receives a comment about an element it cannot find. */
    sourceResolutionHint?: SourceResolutionHint
  } | null>(null)
  const [pinInputPos, setPinInputPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [pinText, setPinText] = useState('')
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map())

  // Re-compute pin positions on mount, annotation change, scroll, resize
  useEffect(() => {
    if (annotations.length === 0) {
      setPositions(new Map())
      return
    }

    function updatePositions(): void {
      const newPositions = new Map<string, { x: number; y: number }>()
      for (const ann of annotations) {
        if (!ann.pinPosition) continue
        const el = locateAnnotated(ann)
        if (!el) continue
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        newPositions.set(ann.id, {
          x: rect.left + ann.pinPosition.x * rect.width,
          y: rect.top + ann.pinPosition.y * rect.height,
        })
      }
      setPositions(newPositions)
    }

    updatePositions()
    const handleScroll = () => requestAnimationFrame(updatePositions)
    const handleResize = () => requestAnimationFrame(updatePositions)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleResize)
    }
  }, [annotations])

  // Pin input follows element on scroll, clamps to viewport, avoids panel (right 320px)
  useEffect(() => {
    if (!pinTarget) return
    const INPUT_W = 200
    const INPUT_H = 32
    const PANEL_W = PANEL_WIDTH + 20 // panel width + margin
    const GAP = 8

    function reposition(): void {
      const el = document.querySelector(sourceSelector(pinTarget!.elementSource))
      if (!el) return
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight

      // Ideal: centered below element
      let x = rect.left + (rect.width - INPUT_W) / 2
      let y = rect.bottom + GAP

      // If element is above viewport, stick to top
      if (rect.bottom < 0) y = GAP
      // If element is below viewport, stick to bottom
      if (rect.top > vh) y = vh - INPUT_H - GAP

      // Clamp to viewport edges
      x = Math.max(GAP, Math.min(x, vw - INPUT_W - PANEL_W - GAP))
      y = Math.max(GAP, Math.min(y, vh - INPUT_H - GAP))

      setPinInputPos({ x, y })
    }

    reposition()
    const onScroll = () => requestAnimationFrame(reposition)
    const onResize = () => requestAnimationFrame(reposition)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [pinTarget])

  // Comment mode: crosshair cursor + click handler
  useEffect(() => {
    if (!commentMode) {
      setPinTarget(null)
      document.body.style.cursor = ''
      return
    }

    document.body.style.cursor = 'crosshair'

    function handleClick(e: MouseEvent): void {
      const target = e.target as HTMLElement
      if (!target || target.closest('[data-cortex-host]')) return

      // COR-27: the CLICKED element, never `closest('[data-cortex-source]')`.
      //
      // The old lookup walked up to the nearest annotated ancestor and recorded
      // THAT, with nothing telling the user their target had been substituted.
      // On a component-library app the majority of pointable nodes are
      // unannotated (67.8% aggregate on zerofog-web, because source-transform
      // skips node_modules by design), so substitution was the common case — and
      // the gesture whose entire purpose is describing one specific element is
      // the one most damaged by silently pointing somewhere else.
      //
      // Worse than the wrong source: the pin was POSITIONED from the ancestor's
      // rect too, and `querySelector` returns the FIRST element with that source,
      // which for a `.map()`-rendered ancestor need not even contain the click.
      // A comment on a button could render over a different row entirely.
      //
      // `getElementEditTarget` is the seam style edits already use: annotated
      // elements resolve directly, unannotated ones get a preview id stamped and
      // a DOM hint built so the agent can locate the real call site.
      const editTarget = getElementEditTarget(target)
      const rect = target.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      e.preventDefault()
      e.stopPropagation()
      setPinTarget({
        clickX: e.clientX,
        clickY: e.clientY,
        elementSource: editTarget.source,
        ...(editTarget.applyMode === 'agent-resolve'
          ? { sourceResolutionHint: editTarget.sourceResolutionHint }
          : {}),
      })
    }

    window.addEventListener('click', handleClick, true)
    return () => {
      window.removeEventListener('click', handleClick, true)
      document.body.style.cursor = ''
    }
  }, [commentMode])

  const handlePinSubmit = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !pinText.trim() || !pinTarget) return
    const el = document.querySelector(sourceSelector(pinTarget.elementSource))
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    channel.send({
      type: 'comment',
      elementSource: pinTarget.elementSource,
      // Travels with the comment or the agent cannot act on it: a preview source
      // is a page-session id, meaningless once the page reloads.
      ...(pinTarget.sourceResolutionHint
        ? { sourceResolutionHint: pinTarget.sourceResolutionHint }
        : {}),
      text: pinText.trim(),
      pinPosition: {
        x: (pinTarget.clickX - rect.left) / rect.width,
        y: (pinTarget.clickY - rect.top) / rect.height,
      },
    })
    setPinText('')
    setPinTarget(null)
  }, [pinText, pinTarget, channel])

  const pinnedAnnotations = annotations.filter(a => a.pinPosition)
  const selectedAnnotation = selectedPinId ? annotations.find(a => a.id === selectedPinId) : null

  return (
    <>
      {commentMode && <div class="cortex-pin--mode" />}

      {pinnedAnnotations.map(ann => {
        const pos = positions.get(ann.id)
        if (!pos) return null
        return (
          <div
            key={ann.id}
            class="cortex-pin"
            style={{ left: `${pos.x - 6}px`, top: `${pos.y - 6}px` }}
            onClick={() => setSelectedPinId(selectedPinId === ann.id ? null : ann.id)}
          />
        )
      })}

      {selectedAnnotation && (
        <div class="cortex-pin__thread" style={{
          left: `${(positions.get(selectedAnnotation.id)?.x ?? 0) + 16}px`,
          top: `${(positions.get(selectedAnnotation.id)?.y ?? 0) - 6}px`,
        }}>
          <CommentThread annotation={selectedAnnotation} onReply={onReply} />
        </div>
      )}

      {pinTarget && (
        <div class="cortex-pin__input" style={{ left: `${pinInputPos.x}px`, top: `${pinInputPos.y}px` }}>
          <input
            type="text"
            class="cortex-pin__input-field"
            placeholder="Add comment..."
            value={pinText}
            onInput={(e: Event) => setPinText((e.target as HTMLInputElement).value)}
            onKeyDown={handlePinSubmit}
            autoFocus
          />
        </div>
      )}
    </>
  )
}
