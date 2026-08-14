import { childDiscriminators } from './child-discriminator.js'
import { getAgentResolveTarget, getElementEditTarget } from './preview-source.js'
import { pendingEditSchema, MAX_INTENT_INSTANCE_SOURCES } from '../schemas/pending-edit.js'
import { generateId } from './uuid.js'
import type { PendingEdit } from '../adapters/types.js'

/**
 * Build the structural intent a drag-to-reorder gesture emits (COR-7, M1).
 *
 * Deliberately a pure function over a container and two indices, with no
 * pointer handling in it. The gesture — drag threshold, drop indicator, Shadow
 * DOM hit-testing — is the other half of M1 and is where the interaction risk
 * lives. Splitting them means the part that decides WHAT gets written to source
 * can be tested exhaustively without simulating a single pointer event, which
 * is how B2/B3/B4 were built for this same consumer.
 *
 * ## What the caller gets back
 *
 * A discriminated result, never a thrown error and never a silently-degraded
 * intent. A reorder that cannot be verified must be REFUSED with a reason the
 * UI can show, because the alternative — staging it anyway — is a write to a
 * list cortex cannot prove it understands. See `refuseReorder`.
 */
export type ReorderIntentResult =
  | { ok: true; intent: PendingEdit }
  | { ok: false; reason: string }

/**
 * Turn "the child at `fromIndex` should end up at `toIndex`" into the absolute
 * order `structuralIntentSchema` carries.
 *
 * `order[i] === j` means "the child at baseline position j ends up at position
 * i" — the intended RESULT, not a sequence of moves, which is what makes the
 * intent idempotent and independent of any other intent being applied or
 * dropped. Splice on the identity permutation produces exactly that.
 */
export function reorderPermutation(length: number, fromIndex: number, toIndex: number): number[] {
  const order = Array.from({ length }, (_, i) => i)
  const [moved] = order.splice(fromIndex, 1)
  order.splice(toIndex, 0, moved!)
  return order
}

/**
 * A stable per-instance identifier for a container, as `parentKey` requires.
 *
 * `parentSource` names a source LOCATION, and one location can render many
 * times — `<Column/>` twice, each with identical rows, gives both containers
 * the same `parentSource` and every row the same `source`. Without this, the
 * two reorders are byte-identical and the agent cannot tell which backing array
 * to touch.
 *
 * An nth-child path rather than the container's preview id: the id is minted by
 * cortex and does not survive the HMR cycle that replaces the node, while the
 * path is recomputed from the live tree each time and describes the same slot.
 */
export function containerInstanceKey(container: Element): string {
  const segments: string[] = []
  let node: Element | null = container
  while (node && node.parentElement) {
    const index = Array.from(node.parentElement.children).indexOf(node) + 1
    segments.unshift(`${node.localName}:nth-child(${index})`)
    node = node.parentElement
  }
  // The root itself carries no nth-child — it has no parent to be nth of.
  if (node) segments.unshift(node.localName)
  return segments.join('>')
}

/**
 * Why this reorder cannot be staged, or `null` when it can.
 *
 * Every branch here is a REFUSAL, not a degradation: cortex would rather tell
 * the user it cannot do this than write a reorder to a list it cannot verify
 * afterwards. The drift guard's whole correctness argument (COR-35) rests on
 * the childKeys being pairwise distinct, so a list that cannot produce distinct
 * keys has no safe reorder available at all.
 */
function refuseReorder(
  children: readonly Element[],
  childKeys: readonly string[],
  fromIndex: number,
  toIndex: number,
): string | null {
  // Cheap structural checks first — they need no DOM reads and they rule out
  // the cases where inspecting keys would be meaningless anyway.
  if (children.length < 2) {
    return 'This container has nothing to reorder — a move needs at least two children.'
  }
  if (children.length > MAX_INTENT_INSTANCE_SOURCES) {
    // Refused HERE rather than left to the schema: the schema's message is a
    // field-level array-length complaint, and the user needs to know the limit
    // is cortex's and the list is otherwise fine.
    return `This list has ${children.length} items, more than the ${MAX_INTENT_INSTANCE_SOURCES} cortex can describe in one reorder.`
  }
  const inRange = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < children.length
  if (!inRange(fromIndex) || !inRange(toIndex)) {
    // Not a user-facing situation — a caller passed indices the DOM does not
    // have — but it still reaches the UI, so it says what happened rather than
    // naming variables the user has never heard of.
    return `Cannot move item ${fromIndex} to ${toIndex}: this container has ${children.length} items.`
  }
  if (fromIndex === toIndex) {
    // `structuralIntentSchema` rejects the identity permutation too, so this
    // branch buys a legible message rather than a missing check. Worth the
    // duplication: the schema's version reads "reorder is a no-op: order is the
    // identity permutation", which describes the encoding, not the gesture.
    return 'That item is already in this position.'
  }

  // The one that carries COR-35's invariant. The drift guard proves a reorder
  // is still valid by comparing these keys position-by-position, and that proof
  // holds ONLY while they are pairwise distinct — two identical keys mean
  // swapping the children they name compares clean. So a list that cannot
  // produce distinct keys has no verifiable reorder available at all, and
  // staging one anyway is the silent-wrong write this whole path exists to
  // prevent.
  const seen = new Map<string, number>()
  for (let i = 0; i < childKeys.length; i += 1) {
    const key = childKeys[i]!
    const first = seen.get(key)
    if (first !== undefined) {
      // Name the positions in the terms the user is looking at — they see two
      // rows that appear identical, and "items 2 and 4" is checkable against
      // the screen in a way an internal key string is not.
      return (
        `Items ${first + 1} and ${i + 1} look identical to cortex — same text, and no id, ` +
        `name or test id to tell them apart. Reordering would risk moving the wrong one, ` +
        `so it is refused. Give those elements distinguishing content or an id, and the ` +
        `move will work.`
      )
    }
    seen.set(key, i)
  }

  return null
}

/**
 * Build a validated reorder intent, or refuse with a reason.
 *
 * Mutates the DOM: an UNANNOTATED child gets a `data-cortex-preview-id`, and the
 * dragged child always does. That is allowed HERE and forbidden in the guard —
 * this runs on a user gesture, while the guard runs inside a read-only
 * reconcile on a page cortex is only supposed to be observing.
 *
 * Minting at capture is what makes the baseline readable later: a child with
 * neither anchor reads back as the empty string, so two of them would be
 * indistinguishable to the very comparison that has to tell them apart.
 */
export function buildReorderIntent(
  container: Element,
  fromIndex: number,
  toIndex: number,
): ReorderIntentResult {
  const children = Array.from(container.children)
  const childKeys = childDiscriminators(container)

  const refusal = refuseReorder(children, childKeys, fromIndex, toIndex)
  if (refusal !== null) return { ok: false, reason: refusal }

  // Minted AFTER the refusal check, so a refused gesture leaves no attributes
  // behind on a tree the user never successfully edited.
  // Three different addressing needs, and using one function for all of them
  // was a bug the tests caught immediately:
  //
  //  - `baseline` MUST use `getElementEditTarget`, whose rule is the minting
  //    twin of the guard's `readChildSource`: source first, preview id only as
  //    a fallback. Minting a preview id on an ALREADY-ANNOTATED child and
  //    writing that into the baseline makes the guard — which reads the
  //    `data-cortex-source` beside it — report drift on a tree nobody touched.
  //  - `source` MUST be agent-resolve. The schema forces the mode for
  //    structural intents, and the guard resolves this string through a
  //    first-seen-wins document index, so a shared anchor would resolve to some
  //    OTHER container's row.
  //  - `parentSource` takes the BEST address available rather than a forced
  //    preview id: the agent has to find this container in source, and a file
  //    position beats a locator. `parentKey` is what separates two instances.
  const dragged = getAgentResolveTarget(children[fromIndex]!)
  const parentSource = getElementEditTarget(container).source
  const baseline = children.map(child => getElementEditTarget(child).source)

  const intent: PendingEdit = {
    kind: 'structural',
    intentId: generateId(),
    // The DRAGGED CHILD, not the container: the guard resolves this source and
    // then reads `el.parentElement`. Pointing it at the container would compare
    // the container's own SIBLINGS against a baseline of its children.
    source: dragged.source,
    applyMode: 'agent-resolve',
    sourceResolutionHint: dragged.sourceResolutionHint,
    structural: {
      op: 'reorder',
      parentSource,
      parentKey: containerInstanceKey(container),
      baseline,
      childKeys,
      order: reorderPermutation(children.length, fromIndex, toIndex),
    },
    timestamp: Date.now(),
  } as PendingEdit

  // Validate against the SAME schema the server enforces rather than trusting
  // this function to have got it right. A malformed intent rejected here is a
  // refusal the user sees; the same intent rejected at the wire boundary is a
  // gesture that vanishes with no explanation.
  const parsed = pendingEditSchema.safeParse(intent)
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Cannot stage this reorder: ${parsed.error.issues[0]?.message ?? 'the intent failed validation'}.`,
    }
  }
  return { ok: true, intent }
}

export { MAX_INTENT_INSTANCE_SOURCES }
