/**
 * Client/server convergence for message annotations.
 *
 * Kept separate from `ChatDisplay.tsx` so it can be unit-tested without React.
 * The renderer (desktop) and the webui share this code — `apps/webui` builds
 * the same renderer bundle through the web-api adapter, so these helpers cover
 * both clients.
 *
 * ## Why this exists
 *
 * The renderer's annotation state (`session.messages[].annotations`) is a local
 * mirror updated **only** by the `message_annotations_updated` event
 * (`event-processor/handlers/session.ts`). Mutations (`addAnnotation` /
 * `removeAnnotation` / `updateAnnotation`) are RPC commands whose *result* was
 * previously used only to raise a toast on failure — on success the client
 * changed nothing and waited for the event.
 *
 * That makes the event the single point of failure for deletes: if it is not
 * delivered or not applied (WS reconnect outside the replay window, a
 * background-suspended mobile Safari tab, a dropped sequence — detected at
 * `transport/client.ts` but only `console.warn`ed), the annotation stays in the
 * local mirror forever. The pending follow-up chip derived from it becomes
 * immortal, and every retry of the delete walks the same dead path:
 *
 *   remove → server: already absent → success + re-sync event → event dropped
 *   → local mirror unchanged → chip still there → user clicks delete again …
 *
 * LEARNING-035 made the server side idempotent (remove-of-absent is success and
 * **re-broadcasts** the current annotations). That fix shipped and fires in
 * production — but it reconciles over the very channel that is failing, so a
 * client that is missing events cannot be rescued by it. Verified in the
 * 260724-light-delta incident (2026-07-25): the server logged the no-op re-sync
 * at 05:16:43 UTC and the same client still held the annotation at 05:16:52.
 *
 * ## The rule
 *
 * A mutation's **command result is authoritative** for the thing it mutated.
 * When the server tells us the annotation is gone, remove it from the local
 * mirror right there — do not wait for the event. The event remains the sync
 * path for *other* clients; it is no longer the only path for the one that
 * asked. Deletes then converge in one round trip regardless of event delivery.
 */

import type { AnnotationMutationFailureReason } from '@craft-agent/core/types'
import type { Message } from '../../../shared/types'

/** Shape of a `sessionCommand` reply for an annotation mutation. */
export type AnnotationMutationResultLike =
  | { success: true }
  | { success: false; reason: AnnotationMutationFailureReason }
  | undefined
  | null
  | unknown

function asMutationResult(
  result: AnnotationMutationResultLike,
): { success: boolean; reason?: AnnotationMutationFailureReason } | null {
  if (!result || typeof result !== 'object') return null
  if (!('success' in result)) return null
  const success = (result as { success: unknown }).success
  if (typeof success !== 'boolean') return null
  const reason = 'reason' in result
    ? (result as { reason?: AnnotationMutationFailureReason }).reason
    : undefined
  return { success, reason }
}

/**
 * Should a `removeAnnotation` reply cause the client to drop the annotation
 * from its local mirror?
 *
 * Yes whenever the server has told us the annotation is not there any more:
 *   - `success: true` — the normal delete, and (post-LEARNING-035) also the
 *     idempotent no-op where it was already absent.
 *   - `annotation-not-found` — an older server, or a racing second delete.
 *     Either way the desired end state holds; keeping it locally is the
 *     phantom-chip bug.
 *
 * No for `session-not-found` / `message-not-found` / anything else: the server
 * could not even look, so its answer says nothing about the annotation. Those
 * keep their toast + reload advice.
 *
 * A malformed/absent reply (e.g. an old server that resolved `void`) is treated
 * as non-converging — we only act on an answer we understood.
 */
export function shouldConvergeRemoveLocally(result: AnnotationMutationResultLike): boolean {
  const parsed = asMutationResult(result)
  if (!parsed) return false
  if (parsed.success) return true
  return parsed.reason === 'annotation-not-found'
}

/**
 * Remove an annotation from the local message mirror.
 *
 * Returns a new `messages` array, or `null` when nothing changed — callers use
 * the null to skip a pointless state write (and therefore a re-render). Pure:
 * only the one message is rebuilt, every other message keeps its identity so
 * memoized turn cards do not re-render.
 */
export function removeAnnotationFromMessages(
  messages: Message[] | undefined,
  messageId: string,
  annotationId: string,
): Message[] | null {
  if (!messages?.length) return null

  let changed = false
  const next = messages.map((message) => {
    if (message.id !== messageId) return message
    const annotations = message.annotations
    if (!annotations?.length) return message
    const remaining = annotations.filter(a => a.id !== annotationId)
    if (remaining.length === annotations.length) return message
    changed = true
    return { ...message, annotations: remaining }
  })

  return changed ? next : null
}
