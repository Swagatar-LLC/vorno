/**
 * Workspace-settings handler: Headroom (fork PLAN-040, SUV-0017).
 *
 * This is the exact path the settings UI uses — `workspace:settings:update`
 * with key `headroom` to write, `workspace:settings:get` to read back the
 * resolved view. Two properties matter and neither is visible from the
 * renderer:
 *
 *   1. A write lands in the workspace's own `config.json` under
 *      `defaults.headroom` and is still there when a *fresh* handler instance
 *      reads it — the closest a unit test gets to "survives an app restart",
 *      since nothing about the value is held in memory between calls.
 *   2. Two workspaces resolve independently.
 *
 * Runs against real workspaces inside the throwaway config dir provided by the
 * bunfig test preload (../../../shared/tests/setup/config-fixture.ts —
 * LEARNING-056).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'
import { registerSettingsHandlers } from './settings'

const WS_A = 'ws_headroom_a'
const WS_B = 'ws_headroom_b'
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const ROOT_A = join(CONFIG_DIR, 'workspaces', 'headroom-a')
const ROOT_B = join(CONFIG_DIR, 'workspaces', 'headroom-b')

let originalConfig: string | null = null

/**
 * A fresh handler registration. Called per interaction on purpose: nothing may
 * be cached between a write and the read that proves it stuck.
 */
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
  if (!get || !update) throw new Error('workspace settings handlers not registered')
  return { get, update }
}

function ctx(workspaceId: string): RequestContext {
  return { clientId: 'client-1', workspaceId, webContentsId: 1 }
}

interface HeadroomView {
  effective: Record<string, unknown>
  instanceEffective: Record<string, unknown>
  overrides?: Record<string, unknown>
  sources: Record<string, string>
}

/** Read the Headroom view through a brand-new handler instance. */
async function readView(workspaceId: string): Promise<HeadroomView> {
  const { get } = createHarness()
  const settings = await get(ctx(workspaceId), workspaceId) as { headroomView?: HeadroomView }
  if (!settings.headroomView) throw new Error('settings payload carried no headroom view')
  return settings.headroomView
}

/**
 * Read the *writable* half. `headroom` is what a client may write back, so it
 * must round-trip byte-for-byte with what it reads — the derived `headroomView`
 * beside it is read-only.
 */
async function readWritableLayer(workspaceId: string): Promise<unknown> {
  const { get } = createHarness()
  const settings = await get(ctx(workspaceId), workspaceId) as { headroom?: unknown }
  return settings.headroom
}

async function write(workspaceId: string, value: unknown): Promise<void> {
  const { update } = createHarness()
  await update(ctx(workspaceId), workspaceId, 'headroom', value)
}

/** Rewrite the config root, optionally with an instance-level Headroom base. */
function writeRootConfig(instance?: unknown): void {
  const config: Record<string, unknown> = {
    workspaces: [
      { id: WS_A, name: 'Headroom A', rootPath: ROOT_A, createdAt: Date.now() },
      { id: WS_B, name: 'Headroom B', rootPath: ROOT_B, createdAt: Date.now() },
    ],
    activeWorkspaceId: WS_A,
    activeSessionId: null,
  }
  if (instance !== undefined) config.headroom = instance
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
}

const DISABLED = {
  enabled: false,
  compressionEngines: [],
  verbosity: 'balanced',
  exposeStats: false,
}

beforeAll(() => {
  originalConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null
  writeRootConfig()
})

afterAll(() => {
  if (originalConfig !== null) writeFileSync(CONFIG_FILE, originalConfig, 'utf-8')
})

beforeEach(async () => {
  // Back to "no Headroom config anywhere" before each case.
  writeRootConfig()
  await write(WS_A, undefined)
  await write(WS_B, undefined)
})

describe('workspace settings: headroom read view (SUV-0017)', () => {
  it('serves a disabled view on the fresh-install path', async () => {
    const view = await readView(WS_A)

    expect(view.effective).toEqual(DISABLED)
    expect(view.effective.enabled).toBe(false)
    expect(view.sources).toEqual({
      enabled: 'default',
      compressionEngines: 'default',
      verbosity: 'default',
      exposeStats: 'default',
    })
    expect(view.overrides).toBeUndefined()
  })

  it('saves from that fresh state and writes a valid config', async () => {
    await write(WS_A, { enabled: true })

    const view = await readView(WS_A)
    expect(view.effective.enabled).toBe(true)
    expect(view.sources.enabled).toBe('workspace')

    // And it really is on disk, in the workspace's own file.
    const onDisk = JSON.parse(readFileSync(join(ROOT_A, 'config.json'), 'utf-8'))
    expect(onDisk.defaults.headroom).toEqual({ enabled: true })
    // The key a client reads is the key a client may write.
    expect(await readWritableLayer(WS_A)).toEqual({ enabled: true })
  })
})

describe('workspace settings: headroom persistence (SUV-0017)', () => {
  it('round-trips every option field through a fresh handler', async () => {
    const overrides = {
      enabled: true,
      compressionEngines: ['summarize', 'trim'],
      verbosity: 'terse',
      exposeStats: true,
    }
    await write(WS_A, overrides)

    const view = await readView(WS_A)
    expect(view.effective).toEqual(overrides)
    expect(view.overrides).toEqual(overrides)
    expect(view.sources).toEqual({
      enabled: 'workspace',
      compressionEngines: 'workspace',
      verbosity: 'workspace',
      exposeStats: 'workspace',
    })
  })

  it('clearing one field reverts it to the instance value, keeping the rest', async () => {
    writeRootConfig({ verbosity: 'verbose' })
    await write(WS_A, { enabled: true, verbosity: 'terse' })

    expect((await readView(WS_A)).sources.verbosity).toBe('workspace')

    // The UI clears a field by writing the layer without it.
    await write(WS_A, { enabled: true })

    const view = await readView(WS_A)
    expect(view.effective.verbosity).toBe('verbose')
    expect(view.sources.verbosity).toBe('instance')
    expect(view.sources.enabled).toBe('workspace')
    expect(view.instanceEffective.verbosity).toBe('verbose')
  })

  it('clearing the whole layer drops the key rather than storing an empty object', async () => {
    await write(WS_A, { enabled: true })
    await write(WS_A, undefined)

    const onDisk = JSON.parse(readFileSync(join(ROOT_A, 'config.json'), 'utf-8'))
    expect(onDisk.defaults).not.toHaveProperty('headroom')
    expect((await readView(WS_A)).sources.enabled).toBe('default')
  })

  it('preserves an unknown key written by a newer build', async () => {
    await write(WS_A, { enabled: true, futureKnob: 'x' })

    const view = await readView(WS_A)
    expect(view.overrides).toEqual({ enabled: true, futureKnob: 'x' })
    expect(view.effective.enabled).toBe(true)
  })
})

describe('workspace settings: headroom validation (SUV-0017)', () => {
  const MESSAGE = 'headroom must be an object whose known fields are well-typed'

  it.each([
    ['a non-object', 'nope'],
    ['a wrongly-typed enabled', { enabled: 'yes' }],
    ['a wrongly-typed engine list', { compressionEngines: 'summarize' }],
    ['a non-string engine id', { compressionEngines: ['ok', 7] }],
    ['an unknown verbosity', { verbosity: 'shouty' }],
  ])('rejects %s', async (_label, value) => {
    const { update } = createHarness()
    await expect(update(ctx(WS_A), WS_A, 'headroom', value)).rejects.toThrow(MESSAGE)
  })

  it('leaves the stored config untouched when a write is rejected', async () => {
    await write(WS_A, { enabled: true })
    const { update } = createHarness()
    await expect(update(ctx(WS_A), WS_A, 'headroom', { verbosity: 'shouty' })).rejects.toThrow()

    expect((await readView(WS_A)).overrides).toEqual({ enabled: true })
  })
})

describe('workspace settings: headroom per-workspace isolation (SUV-0017)', () => {
  it('enabling Headroom in one workspace leaves the other resolving to disabled', async () => {
    await write(WS_A, { enabled: true, verbosity: 'terse' })

    const a = await readView(WS_A)
    const b = await readView(WS_B)

    expect(a.effective.enabled).toBe(true)
    expect(a.effective.verbosity).toBe('terse')

    expect(b.effective).toEqual(DISABLED)
    expect(b.sources.enabled).toBe('default')
    expect(b.overrides).toBeUndefined()
  })

  it('each workspace overrides a shared instance base on its own', async () => {
    writeRootConfig({ enabled: true })
    await write(WS_A, { enabled: false })

    expect((await readView(WS_A)).effective.enabled).toBe(false)
    expect((await readView(WS_A)).sources.enabled).toBe('workspace')
    expect((await readView(WS_B)).effective.enabled).toBe(true)
    expect((await readView(WS_B)).sources.enabled).toBe('instance')
  })
})
