/**
 * Headroom report handler (fork PLAN-040, SUV-0027).
 *
 * The handler is deliberately almost empty, and its only real decision is the
 * one covered here: what to answer when the host cannot report. The tempting
 * answer — an empty report — would render as a table of zeros in the view,
 * which is precisely the failure the "measured or absent" contract exists to
 * prevent, and it would look identical to a workspace that genuinely compressed
 * nothing.
 */
import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HeadroomStatsReport } from '@craft-agent/core/types'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'
import { registerHeadroomHandlers } from './headroom'

function createHarness(sessionManager: Partial<HandlerDeps['sessionManager']>) {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }

  registerHeadroomHandlers(server, {
    sessionManager,
    platform: { logger: console },
  } as unknown as HandlerDeps)

  return async (workspaceId: string, sessionId?: string): Promise<HeadroomStatsReport> => {
    const handler = handlers.get(RPC_CHANNELS.headroom.STATS_GET)
    if (!handler) throw new Error('handler not registered')
    return (await handler({} as RequestContext, workspaceId, sessionId)) as HeadroomStatsReport
  }
}

describe('headroom:stats:get', () => {
  it('returns the session manager’s report verbatim', async () => {
    const report: HeadroomStatsReport = {
      workspace: {
        kind: 'workspace',
        id: 'ws-1',
        stats: {
          available: true,
          value: {
            totalRequests: 2,
            totalTokensBefore: 100,
            totalTokensAfter: 40,
            totalTokensSaved: 60,
          },
        },
      },
    }
    const invoke = createHarness({
      async getHeadroomStatsReport() {
        return report
      },
    })

    expect(await invoke('ws-1')).toEqual(report)
  })

  it('passes the session slice through to the session manager', async () => {
    let seen: [string, string | undefined] | null = null
    const invoke = createHarness({
      async getHeadroomStatsReport(workspaceId: string, sessionId?: string) {
        seen = [workspaceId, sessionId]
        return {
          workspace: {
            kind: 'workspace' as const,
            id: workspaceId,
            stats: { available: false as const, reason: 'disabled' as const },
          },
        }
      },
    })

    await invoke('ws-1', 's-9')

    expect(seen).toEqual(['ws-1', 's-9'])
  })

  it('answers absent — never an empty report of zeros — when the host cannot report', async () => {
    const invoke = createHarness({})

    const report = await invoke('ws-1', 's-1')

    expect(report.workspace.stats.available).toBe(false)
    expect(report.session?.stats.available).toBe(false)
    // The absent arm carries no numeric fields at all.
    expect(Object.keys(report.workspace.stats)).toEqual(['available', 'reason'])
    // Not one digit in either measurement. (The scope ids are not measurements.)
    expect(
      JSON.stringify([report.workspace.stats, report.session?.stats]),
    ).not.toMatch(/\d/)
  })

  it('omits the session scope entirely when none was asked for', async () => {
    const invoke = createHarness({})

    expect((await invoke('ws-1')).session).toBeUndefined()
  })
})
