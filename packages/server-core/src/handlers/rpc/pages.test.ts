import { describe, expect, test } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import { registerPagesHandlers } from './pages'

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  registerPagesHandlers(server, {
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    sessionManager: {},
  } as unknown as HandlerDeps)
  return async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`handler not registered: ${channel}`)
    return handler({} as RequestContext, ...args)
  }
}

describe('Pages RPC availability gate', () => {
  test('rejects direct productive RPC calls while Pages is disabled', async () => {
    const invoke = createHarness()

    await expect(invoke(RPC_CHANNELS.pages.CREATE, 'workspace', { name: 'blocked' })).rejects.toThrow('PAGES_DISABLED')
    await expect(invoke(RPC_CHANNELS.pages.SET_CONTENT, 'workspace', 'page', '<p>x</p>')).rejects.toThrow('PAGES_DISABLED')
    await expect(invoke(RPC_CHANNELS.pages.ISSUE_GRANT, 'workspace', 'page', {})).rejects.toThrow('PAGES_DISABLED')
    await expect(invoke(RPC_CHANNELS.pages.CREATE_LEASE, 'workspace', 'page')).rejects.toThrow('PAGES_DISABLED')
    await expect(invoke(RPC_CHANNELS.pages.EXECUTE_ACTION, 'workspace', {})).rejects.toThrow('PAGES_DISABLED')
  })

  test('reports the same disabled state to desktop capability consumers', async () => {
    const invoke = createHarness()

    await expect(invoke(RPC_CHANNELS.pages.GET_SHARE_CAPABILITIES, 'workspace')).resolves.toEqual({
      pagesEnabled: false,
      sharingEnabled: false,
    })
  })
})
