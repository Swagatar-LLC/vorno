/**
 * Workspace-settings handler tests (fork PLAN-038).
 *
 * Exercises the SETTINGS_UPDATE validation for `idleAgentTtlMinutes` and the
 * SETTINGS_GET round-trip against a real workspace created inside the
 * throwaway config dir provided by the bunfig test preload
 * (../shared/tests/setup/config-fixture.ts — see LEARNING-056).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'
import { registerSettingsHandlers } from './settings'

const WORKSPACE_ID = 'ws_idlettl1'
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

let originalConfig: string | null = null

function createHarness() {
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

  const deps = {
    sessionManager: {},
    oauthFlowStore: {},
    platform: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  } as unknown as HandlerDeps

  registerSettingsHandlers(server, deps)

  const get = handlers.get(RPC_CHANNELS.workspace.SETTINGS_GET)
  const update = handlers.get(RPC_CHANNELS.workspace.SETTINGS_UPDATE)
  if (!get || !update) {
    throw new Error('workspace settings handlers not registered')
  }
  return { get, update }
}

function ctx(): RequestContext {
  return {
    clientId: 'client-1',
    workspaceId: WORKSPACE_ID,
    webContentsId: 1,
  }
}

beforeAll(() => {
  // Register a workspace in the fixture config dir. loadStoredConfig creates
  // the on-disk workspace structure for any registered-but-missing rootPath.
  originalConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null
  writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      workspaces: [
        {
          id: WORKSPACE_ID,
          name: 'Idle TTL Test Workspace',
          rootPath: join(CONFIG_DIR, 'workspaces', 'idle-ttl-test'),
          createdAt: Date.now(),
        },
      ],
      activeWorkspaceId: WORKSPACE_ID,
      activeSessionId: null,
    }, null, 2),
    'utf-8',
  )
})

afterAll(() => {
  // Restore the fixture's config.json so later suites see the pristine state.
  if (originalConfig !== null) {
    writeFileSync(CONFIG_FILE, originalConfig, 'utf-8')
  }
})

// Table-driven over both idle-TTL keys: idleAgentTtlMinutes (PLAN-038) and
// idleBrowserTtlMinutes (PLAN-047, SUV-0044) share semantics and validation.
for (const key of ['idleAgentTtlMinutes', 'idleBrowserTtlMinutes'] as const) {
  describe(`workspace settings: ${key}`, () => {
    it('accepts 0 (disabled), 60 (default), and 10080 (one week) and reads back', async () => {
      const { get, update } = createHarness()

      for (const value of [0, 60, 10080]) {
        await update(ctx(), WORKSPACE_ID, key, value)
        const settings = await get(ctx(), WORKSPACE_ID) as Record<string, number | undefined>
        expect(settings[key]).toBe(value)
      }
    })

    for (const [label, bad] of [
      ['negative values', -1],
      ['non-integer values', 1.5],
      ['values above one week', 10081],
      ['non-numeric values', 'abc'],
    ] as const) {
      it(`rejects ${label}`, async () => {
        const { update } = createHarness()
        await expect(update(ctx(), WORKSPACE_ID, key, bad))
          .rejects.toThrow(`${key} must be an integer between 0 (disabled) and 10080 (one week)`)
      })
    }
  })
}
