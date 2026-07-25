import type { SessionMeta } from '@/atoms/sessions'

/**
 * Sessions whose full message content should be re-hydrated after a recovery
 * reconnect.
 *
 * The currently displayed session is refreshed on **any** recovery-triggered
 * reconnect — including a non-stale one. A non-stale verdict means the server
 * replayed the buffered event stream, but a recovery reconnect (read-idle
 * liveness probe, resume/bfcache/online) can still leave the visible session's
 * in-memory annotations diverged from the server when a single echo was lost
 * outside the replay window. Re-hydrating just that one view is cheap and
 * converges what the user is actually looking at.
 *
 * A `stale` verdict additionally sweeps every still-processing session, since
 * events were missed workspace-wide.
 */
export function getSessionsToRefreshAfterReconnect(
  metaMap: Map<string, SessionMeta>,
  activeSessionId: string | null,
  isStale: boolean
): string[] {
  const refreshIds = new Set<string>()

  if (activeSessionId) {
    refreshIds.add(activeSessionId)
  }

  if (isStale) {
    for (const [sessionId, meta] of metaMap) {
      if (meta.isProcessing) {
        refreshIds.add(sessionId)
      }
    }
  }

  return [...refreshIds]
}
