/**
 * Pages session callback executor (ADR-0033 §4, SUV-0064).
 *
 * Backs `PageActionBroker.executors.executeSession` for session-kind grants:
 * delivers ONE pinned message to ONE pinned session through the existing
 * `SessionManager.sendMessage` choke point. The broker has already proved the
 * lease, nonce, replay cache, grant, digest binding, expiry, permission mode,
 * and a fresh single-use activation ticket before this runs.
 *
 * Structurally the twin of `script-executor-bridge.ts`, and deliberately just
 * as narrow. What this file does NOT reach is the point of it:
 *
 *  - no `setSessionStatus`, so no status can change and no close can happen;
 *  - no `setSessionLabels`, `applyContextProfile`, `archiveSession`,
 *    `deleteSession`, or any lifecycle call;
 *  - no session creation — the target must already exist;
 *  - no tool dispatch of any kind.
 *
 * That is the hard no-close boundary, and it is enforced by absence rather than
 * by a check. A check is something a later edit can weaken; a method that is
 * not on the injected interface cannot be called at all. `SessionCallbackHost`
 * below is the whole surface this executor is given, and it has exactly two
 * members. The declared `page` origin (ADR-0021) covers the same ground from
 * the other side: `mayCloseSession` refuses it unconditionally, so the guard is
 * already in place for anything that later routes a Page through the status
 * choke point.
 *
 * Refusals are structured codes, not thrown strings, because the audit row has
 * to tell "the session is gone" apart from "the session is mid-turn" without
 * quoting anything the far end said.
 */

import { describeOrigin, pageOrigin } from '@craft-agent/shared/statuses'
import { resolveWorkspaceSessionTarget, type WorkspaceSessionLookup } from '@craft-agent/shared/automations'
import { isSessionFinished } from '../sessions/page-callback-guards'
import type { Logger } from '@craft-agent/server-core/runtime'

/**
 * Why a callback did not reach its session. A closed set: each value is
 * host-observed state, so a row carrying one leaks nothing a caller supplied.
 */
export type PageSessionRefusalCode =
  /** No such session in THIS workspace — missing, deleted, or another tenant's. */
  | 'session-not-found'
  /** Archived, or sitting in a `closed`-category status. */
  | 'session-closed'
  /** Mid-turn. A callback must not land inside a running turn — see below. */
  | 'session-busy'
  /** Withdrawn — cancelled, lease released, or the broker deadline — before commit. */
  | 'cancelled'

export type PageSessionOutcome =
  | { ok: true }
  | { ok: false; code: PageSessionRefusalCode; reason: string }

/** One session's facts, as the callback gate reads them. */
export interface SessionCallbackTarget {
  id: string
  isProcessing: boolean
  isArchived?: boolean
  sessionStatus?: string
  labels?: string[]
}

/**
 * The entire `SessionManager` surface a Page callback is given.
 *
 * Two members, both required, neither of them a mutation of session metadata.
 * Widening this interface is the reviewable moment at which a Page would gain a
 * new power — which is precisely why the executor takes this rather than the
 * manager.
 */
export interface SessionCallbackHost extends WorkspaceSessionLookup {
  getSessions(workspaceId: string): SessionCallbackTarget[]
  /**
   * Atomic check-and-commit. NOT `sendMessage`: that one awaits twice before it
   * decides whether a turn is running, so a caller that checked state itself
   * would be checking across those awaits and could land a page's text inside a
   * running turn or in an archived session. This primitive performs the final
   * busy/closed/archived/workspace check in the same JS turn as the commit, and
   * returns at ACCEPTANCE rather than at the end of the turn it starts.
   *
   * `signal` is re-read immediately before the commit, so a cancel, a lease
   * release, or the broker's deadline landing mid-flight refuses instead of
   * delivering — and once the commit happens nothing can relabel it.
   */
  tryDeliverPageCallback(
    sessionId: string,
    message: string,
    options: { workspaceId: string; signal?: AbortSignal },
  ): Promise<{ ok: true } | { ok: false; code: PageSessionRefusalCode }>
}

export interface PagesSessionExecutorDeps {
  sessionManager: SessionCallbackHost
  /** Canonical workspace id, host-resolved — never a caller's spelling. */
  workspaceId: string
  /** Workspace root, for the status-category lookup only. */
  workspaceRootPath: string
  log: Logger
}

/**
 * The provenance line the host prepends to every delivered callback.
 *
 * Without it the message arrives as an ordinary user turn and neither the user
 * reading the transcript nor the model reading the context can tell that a Page
 * put it there. The page slug is `[a-z0-9-]+` by the time it reaches here
 * (`assertValidPageSlug` is the single choke point every page path goes
 * through), so it cannot forge the brackets or add a second line; the grant id
 * is host-minted. The pinned body follows on its own line, exactly as approved
 * — the prefix is added by the host and is not part of what the user consented
 * to, which is why it is built here and not stored in the descriptor.
 */
export function pageCallbackAttribution(pageSlug: string, grantId: string): string {
  return `[Page callback — page "${pageSlug}", grant ${grantId}. This text was sent by a page, not typed by the user.]`
}

export function createPagesSessionExecutor(deps: PagesSessionExecutorDeps) {
  return async (
    invocation: { pageSlug: string; grantId: string; sessionId: string; message: string },
    options: { signal: AbortSignal },
  ): Promise<PageSessionOutcome> => {
    const origin = pageOrigin(invocation.pageSlug, invocation.grantId)

    // Cheapest possible exit. The authoritative abort check is the one inside
    // the atomic commit — this one only avoids doing work for a request that is
    // already withdrawn.
    if (options.signal.aborted) {
      return { ok: false, code: 'cancelled', reason: 'Action was cancelled before delivery' }
    }

    // Containment first, and structurally: the shared resolver matches inside
    // this workspace's own session list, so a pinned id naming another
    // workspace's session simply is not found. A caller learns nothing about
    // which of the two happened.
    const resolvedId = resolveWorkspaceSessionTarget(
      deps.sessionManager,
      deps.workspaceId,
      { id: invocation.sessionId },
    )
    if (!resolvedId) {
      deps.log.debug(`[pages] session callback refused (not found) for ${describeOrigin(origin)}`)
      return {
        ok: false,
        code: 'session-not-found',
        reason: 'The approved session no longer exists in this workspace',
      }
    }

    const target = deps.sessionManager
      .getSessions(deps.workspaceId)
      .find((session) => session.id === resolvedId)
    if (!target) {
      // Only reachable if the list changed between the two reads. Treated as
      // gone rather than retried: a callback is a one-shot, and re-reading
      // until it agrees is how a race becomes a loop.
      return {
        ok: false,
        code: 'session-not-found',
        reason: 'The approved session no longer exists in this workspace',
      }
    }

    // A closed or archived session is finished work. Delivering into one would
    // reopen it in the user's inbox on a page's schedule, and the ADR-0021
    // house rule that closure is the human's decision cuts both ways — a Page
    // may not close a session, and it may not un-finish one either.
    //
    // Checked here as a cheap, well-described early exit ONLY. It is not the
    // guarantee: this read and the delivery below are separated by an await, so
    // by itself it would be a race. The same questions are re-asked inside
    // `tryDeliverPageCallback`, in the same JS turn as the commit, and that is
    // where the answer binds.
    if (isSessionFinished(deps.workspaceRootPath, target)) {
      deps.log.debug(`[pages] session callback refused (closed) for ${describeOrigin(origin)}`)
      return {
        ok: false,
        code: 'session-closed',
        reason: 'The approved session is archived or closed',
      }
    }

    // Refuse rather than queue or steer. `sendMessage` on a processing session
    // takes the mid-stream path — it either interrupts the in-flight turn or
    // queues behind it — and both are wrong for a callback: the page's text
    // would land inside or immediately after a turn the user is watching, with
    // no gesture of theirs between the two. The user's own send deliberately
    // keeps that behavior; a page does not get it. Same caveat as above: the
    // binding check is the one inside the atomic commit.
    if (target.isProcessing) {
      deps.log.debug(`[pages] session callback refused (busy) for ${describeOrigin(origin)}`)
      return {
        ok: false,
        code: 'session-busy',
        reason: 'The approved session is mid-turn; try again when it is idle',
      }
    }

    const body = `${pageCallbackAttribution(invocation.pageSlug, invocation.grantId)}\n\n${invocation.message}`
    // Check-and-commit in one turn, and it returns at acceptance rather than at
    // the end of the turn it starts — so the broker's deadline can never fire
    // over work that is already on disk and audit a delivered message as a
    // timeout.
    const delivery = await deps.sessionManager.tryDeliverPageCallback(resolvedId, body, {
      workspaceId: deps.workspaceId,
      signal: options.signal,
    })
    if (!delivery.ok) {
      deps.log.debug(`[pages] session callback refused (${delivery.code}) for ${describeOrigin(origin)}`)
      return { ok: false, code: delivery.code, reason: REFUSAL_REASONS[delivery.code] }
    }
    deps.log.info(`[pages] session callback delivered by ${describeOrigin(origin)}`)
    return { ok: true }
  }
}

/** Caller-facing prose per code. Never audited — the closed code is. */
const REFUSAL_REASONS: Record<PageSessionRefusalCode, string> = {
  'session-not-found': 'The approved session no longer exists in this workspace',
  'session-closed': 'The approved session is archived or closed',
  'session-busy': 'The approved session is mid-turn; try again when it is idle',
  cancelled: 'Action was cancelled before delivery',
}
