/**
 * Follow-up send queue — the state rules that decide *which* follow-up
 * annotations ride along with the next outgoing message.
 *
 * ## Why this module exists
 *
 * Before this module, the renderer derived the pending follow-up list
 * exclusively from `session.messages[].annotations`, which is written by
 * exactly one thing: the server's `message_annotations_updated` event
 * (`event-processor/handlers/session.ts` → `handleMessageAnnotationsUpdated`).
 * `onAddAnnotation` (ChatDisplay) awaited the `addAnnotation` RPC and never
 * touched local state.
 *
 * That leaves a window — RPC round-trip + event delivery + React commit —
 * during which the annotation is **durably saved on the server** but invisible
 * to the composer. Any send issued inside that window composes its message
 * from an empty pending list, so the just-saved follow-up is silently omitted,
 * stays pending, and is injected into the *next* turn instead. On the webui
 * (WS proxy, mobile radio) that window is hundreds of milliseconds to seconds,
 * not the sub-frame it is on the desktop IPC path.
 *
 * The fix is not optimism — we never speculate. We record an entry only after
 * the server has *confirmed* the add, and hold it until the echo catches up
 * ("confirmed, awaiting echo"). A failed add records nothing, so this cannot
 * resurrect the phantom-chip class of bug (LEARNING-035).
 *
 * Pure + framework-free on purpose: this is the CI-gated guard for behavior
 * the webui bundle shares with the desktop renderer, and it must be testable
 * without React.
 */

import type { PendingFollowUpAnnotation } from './ChatDisplay.follow-ups'
import { formatFollowUpSection, normalizeFollowUpsMarkdown } from './ChatDisplay.follow-ups'

/**
 * A follow-up the server accepted but whose `message_annotations_updated`
 * echo has not been applied to `session.messages` yet.
 */
export type EchoPendingFollowUp = PendingFollowUpAnnotation & {
  /** `Date.now()` at the moment the `addAnnotation` RPC resolved successfully. */
  recordedAt: number
}

/**
 * Upper bound on how long a confirmed-but-unechoed follow-up is trusted.
 *
 * The echo normally lands in milliseconds; a minute is generous cover for a
 * mobile radio stall or a WS reconnect. The TTL only matters when the echo is
 * lost *entirely* (dropped event, evicted reconnect buffer), and bounding it
 * means a lost echo costs at most one stale chip for this long — never an
 * immortal one, which is the failure mode LEARNING-035 was written about.
 *
 * Recovering a follow-up whose echo is lost for longer than this is not this
 * module's job: the annotation is durable server-side, and re-hydrating
 * `session.messages[].annotations` is what restores it.
 */
export const ECHO_PENDING_TTL_MS = 60_000

/** Bounded wait for a Save & Send follow-up to become visible to the composer. */
export const SAVE_AND_SEND_MAX_FRAMES = 60

function followUpKey(followUp: { messageId: string; annotationId: string }): string {
  return `${followUp.messageId}:${followUp.annotationId}`
}

function byCreatedAt(a: PendingFollowUpAnnotation, b: PendingFollowUpAnnotation): number {
  return a.createdAt - b.createdAt || a.annotationId.localeCompare(b.annotationId)
}

export type PruneEchoPendingArgs = {
  echoPending: readonly EchoPendingFollowUp[]
  /**
   * Every annotation id currently present on each message, taken from the raw
   * `session.messages[].annotations` — *not* the filtered pending list. The
   * distinction matters: an annotation that has been marked sent disappears
   * from the pending list but is still present here, and must count as echoed.
   */
  serverAnnotationIdsByMessage: ReadonlyMap<string, ReadonlySet<string>>
  now: number
  ttlMs?: number
}

/**
 * Drop entries the server state has caught up on (or that expired).
 *
 * The only positive confirmation available is the id appearing in the message's
 * echoed annotation set — absence proves nothing, because a message routinely
 * carries other annotations whose echo arrived before ours. So absence falls
 * back to the TTL, and a *removal* is handled where removals happen: the
 * remove handler drops the local hold-over copy up front, before the RPC.
 */
export function pruneEchoPendingFollowUps({
  echoPending,
  serverAnnotationIdsByMessage,
  now,
  ttlMs = ECHO_PENDING_TTL_MS,
}: PruneEchoPendingArgs): EchoPendingFollowUp[] {
  return echoPending.filter((entry) => {
    if (now - entry.recordedAt > ttlMs) return false
    return !serverAnnotationIdsByMessage.get(entry.messageId)?.has(entry.annotationId)
  })
}

export type MergePendingFollowUpsArgs = {
  /** Pending follow-ups derived from `session.messages[].annotations`. */
  serverDerived: readonly PendingFollowUpAnnotation[]
  echoPending: readonly EchoPendingFollowUp[]
  serverAnnotationIdsByMessage: ReadonlyMap<string, ReadonlySet<string>>
  now: number
  ttlMs?: number
}

/**
 * The composer's view of pending follow-ups: server state, plus anything the
 * server has confirmed but not yet echoed back.
 *
 * Server state wins on conflict — if an annotation is present in both, the
 * server copy is used, so a note edited after the add is not overwritten by
 * the stale text we captured at add time.
 */
export function mergePendingFollowUps({
  serverDerived,
  echoPending,
  serverAnnotationIdsByMessage,
  now,
  ttlMs,
}: MergePendingFollowUpsArgs): PendingFollowUpAnnotation[] {
  const live = pruneEchoPendingFollowUps({ echoPending, serverAnnotationIdsByMessage, now, ttlMs })
  if (live.length === 0) return [...serverDerived].sort(byCreatedAt)

  const seen = new Set(serverDerived.map(followUpKey))
  const merged: PendingFollowUpAnnotation[] = [...serverDerived]

  for (const entry of live) {
    const key = followUpKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    const { recordedAt: _recordedAt, ...followUp } = entry
    merged.push(followUp)
  }

  return merged.sort(byCreatedAt)
}

export type SaveAndSendDecision =
  | { action: 'send' }
  | { action: 'wait' }
  | { action: 'abort'; reason: 'follow-up-not-visible' }

/**
 * Decide what a Save & Send frame should do.
 *
 * The bounded wait used to fall through to `send` once it ran out of frames,
 * which is the worst possible outcome: the user asked for *this* follow-up to
 * go out now, and instead a message goes out without it while the follow-up
 * stays pending — guaranteeing it is injected into the next turn. Timing out
 * now aborts so the caller can surface the failure and leave the composer
 * untouched.
 */
export function resolveSaveAndSendDecision({
  target,
  pending,
  frames,
  maxFrames = SAVE_AND_SEND_MAX_FRAMES,
}: {
  target: { messageId: string; annotationId: string }
  pending: readonly PendingFollowUpAnnotation[]
  frames: number
  maxFrames?: number
}): SaveAndSendDecision {
  const visible = pending.some(
    (f) => f.annotationId === target.annotationId && f.messageId === target.messageId,
  )
  if (visible) return { action: 'send' }
  if (frames >= maxFrames) return { action: 'abort', reason: 'follow-up-not-visible' }
  return { action: 'wait' }
}

/**
 * Compose the outgoing message body from the user's input plus the pending
 * follow-ups. Extracted from `ChatDisplay.handleSubmit` verbatim so the
 * composition is testable in isolation.
 */
export function composeOutgoingMessage(
  baseMessage: string,
  pending: readonly PendingFollowUpAnnotation[],
): string {
  const hasBaseMessage = baseMessage.trim().length > 0
  const followUpSection = formatFollowUpSection([...pending], {
    includeTopSeparator: hasBaseMessage,
  })
  const messageWithFollowUps = followUpSection.length > 0
    ? (hasBaseMessage ? `${baseMessage}\n\n${followUpSection}` : followUpSection)
    : baseMessage
  return normalizeFollowUpsMarkdown(messageWithFollowUps)
}

/**
 * Build the `messageId → annotation ids` map the prune/merge rules need from
 * the renderer's session messages.
 */
export function buildServerAnnotationIdIndex(
  messages: ReadonlyArray<{ id: string; annotations?: ReadonlyArray<{ id: string }> | null }>,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const message of messages) {
    if (!message.annotations) continue
    index.set(message.id, new Set(message.annotations.map((a) => a.id)))
  }
  return index
}
