/**
 * Headroom savings report RPC (fork: PLAN-040 / SUV-0027).
 *
 * One read channel. The handler resolves nothing and computes nothing: it
 * forwards the request to whoever holds the live agents and returns the
 * measurements those agents' adapters produced. `exposeStats` gating, scope
 * selection and aggregation all happen in `buildHeadroomStatsReport`, one layer
 * down, so a second host (headless, PLAN-041's server-homed instance) gets the
 * identical answer without reimplementing any of it here.
 *
 * The companion `STATS_CHANGED` broadcast is emitted by SessionManager when a
 * turn completes; nothing here subscribes to it, because a signal that says
 * "ask again" needs no server-side state.
 */

import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { headroomUnavailable } from '@craft-agent/core/types'
import type { HeadroomStatsReport } from '@craft-agent/core/types'

/**
 * The answer for a host whose session manager cannot report — an older host, or
 * one with no agent layer at all.
 *
 * Absent, with a reason, rather than an empty report full of zeros: the whole
 * point of SUV-0027 is that "we did not measure this" and "this measured zero"
 * never render the same way.
 */
function unreportable(workspaceId: string, sessionId?: string): HeadroomStatsReport {
  const stats = headroomUnavailable<never>('sdk-unavailable')
  return {
    workspace: { kind: 'workspace', id: workspaceId, stats },
    ...(sessionId === undefined
      ? {}
      : { session: { kind: 'session' as const, id: sessionId, stats } }),
  }
}

export function registerHeadroomHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(
    RPC_CHANNELS.headroom.STATS_GET,
    async (_ctx, workspaceId: string, sessionId?: string): Promise<HeadroomStatsReport> => {
      const report = deps.sessionManager.getHeadroomStatsReport
      if (!report) return unreportable(workspaceId, sessionId)
      return report.call(deps.sessionManager, workspaceId, sessionId)
    },
  )
}
