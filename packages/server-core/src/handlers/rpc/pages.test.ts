import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { savePageContent } from '@craft-agent/shared/pages'
import type { HandlerDeps, PageGrantConfirmationSpec } from '../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import { registerPagesHandlers } from './pages'

const WORKSPACE_A = 'ws_pages_enabled'
const WORKSPACE_B = 'ws_pages_disabled'
const ROOT_A = join(CONFIG_DIR, 'workspaces', 'pages-rpc-enabled')
const ROOT_B = join(CONFIG_DIR, 'workspaces', 'pages-rpc-disabled')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
let originalConfig: string | null = null

function writeWorkspace(rootPath: string, id: string, enabled: boolean, name = id): void {
  mkdirSync(rootPath, { recursive: true })
  writeFileSync(join(rootPath, 'config.json'), JSON.stringify({
    id,
    name,
    slug: id,
    defaults: { pages: { enabled } },
    createdAt: 1,
    updatedAt: 1,
  }))
}

function registerTestWorkspaces(): void {
  writeWorkspace(ROOT_A, WORKSPACE_A, true)
  writeWorkspace(ROOT_B, WORKSPACE_B, false)
  writeFileSync(CONFIG_FILE, JSON.stringify({
    workspaces: [
      { id: WORKSPACE_A, name: 'Pages enabled', rootPath: ROOT_A, createdAt: 1 },
      { id: WORKSPACE_B, name: 'Pages disabled', rootPath: ROOT_B, createdAt: 1 },
    ],
    activeWorkspaceId: WORKSPACE_A,
    activeSessionId: null,
  }))
}

type GrantConfirmation = 'approve' | 'decline' | 'disconnect' | 'no-answer' | 'pending' | 'unavailable'

type GrantHarness = ((channel: string, ...args: unknown[]) => Promise<unknown>) & {
  confirmations: PageGrantConfirmationSpec[]
  clientConsentCalls: () => number
  resolvePending: () => void
}

function createHarness(confirm: GrantConfirmation = 'unavailable', duringConfirmation?: () => void): GrantHarness {
  const handlers = new Map<string, HandlerFn>()
  const confirmations: PageGrantConfirmationSpec[] = []
  let clientConsentCallCount = 0
  let resolvePendingConfirmation: ((accepted: boolean) => void) | undefined
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { clientConsentCallCount++; return { response: 1 } },
    hasClientCapability() { return true },
    findClientsWithCapability() { return ['hostile-client'] },
  }
  const confirmPageGrant = confirm === 'unavailable' ? undefined : async (spec: PageGrantConfirmationSpec) => {
    confirmations.push(spec)
    duringConfirmation?.()
    if (confirm === 'approve') return true
    if (confirm === 'decline') return false
    if (confirm === 'disconnect') throw new Error('host dialog disconnected')
    if (confirm === 'pending') return await new Promise<boolean>(resolve => { resolvePendingConfirmation = resolve })
    return await new Promise<boolean>(() => {})
  }
  registerPagesHandlers(server, {
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    sessionManager: {
      notifyConfigFileChange() {},
      enqueuePageThumbnail() {},
    },
    confirmPageGrant,
    ...(confirm === 'no-answer' ? { pageGrantConfirmationTimeoutMs: 1 } : {}),
  } as unknown as HandlerDeps)
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`handler not registered: ${channel}`)
    return handler({ workspaceId: WORKSPACE_A, clientId: 'hostile-client' } as RequestContext, ...args)
  }
  return Object.assign(invoke, {
    confirmations,
    clientConsentCalls: () => clientConsentCallCount,
    resolvePending: () => resolvePendingConfirmation?.(true),
  })
}

beforeAll(() => {
  originalConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null
})

beforeEach(() => {
  rmSync(ROOT_A, { recursive: true, force: true })
  rmSync(ROOT_B, { recursive: true, force: true })
  registerTestWorkspaces()
})

afterAll(() => {
  rmSync(ROOT_A, { recursive: true, force: true })
  rmSync(ROOT_B, { recursive: true, force: true })
  if (originalConfig === null) rmSync(CONFIG_FILE, { force: true })
  else writeFileSync(CONFIG_FILE, originalConfig)
})

describe('Pages RPC workspace capability gate', () => {
  test('uses the requested workspace for desktop and WebUI capability reads', async () => {
    const invoke = createHarness()

    await expect(invoke(RPC_CHANNELS.pages.GET_SHARE_CAPABILITIES, WORKSPACE_A))
      .resolves.toMatchObject({ pagesEnabled: true })
    await expect(invoke(RPC_CHANNELS.pages.GET_SHARE_CAPABILITIES, WORKSPACE_B))
      .resolves.toEqual({ pagesEnabled: false, sharingEnabled: false })
  })

  test('allows enabled workspace A through the broker and rejects every productive path in disabled workspace B', async () => {
    const invoke = createHarness()
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Enabled page', content: '<p>enabled</p>',
    }) as { slug: string }
    const lease = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    expect(lease.lease.leaseId).toBeString()

    await expect(invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_B, { name: 'blocked' }))
      .rejects.toThrow('PAGES_DISABLED')
    await expect(invoke(RPC_CHANNELS.pages.SET_CONTENT, WORKSPACE_B, 'missing', '<p>x</p>'))
      .rejects.toThrow('PAGES_DISABLED')
    await expect(invoke(RPC_CHANNELS.pages.ISSUE_GRANT, WORKSPACE_B, 'missing', {}))
      .rejects.toThrow('PAGES_DISABLED')
    await expect(invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_B, 'missing'))
      .rejects.toThrow('PAGES_DISABLED')
    await expect(invoke(RPC_CHANNELS.pages.EXECUTE_ACTION, WORKSPACE_B, { pageSlug: 'missing' }))
      .rejects.toThrow('PAGES_DISABLED')
    await expect(invoke(RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN, WORKSPACE_B, 'missing'))
      .rejects.toThrow('PAGES_DISABLED')
    await expect(invoke(RPC_CHANNELS.pages.PUBLISH, WORKSPACE_B, 'missing', { includeData: false }))
      .rejects.toThrow('PAGES_DISABLED')
  })

  test('refuses direct issuance and persists only a host-confirmed request', async () => {
    const direct = createHarness()
    const page = await direct(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Grant page', content: '<p>content</p>',
    }) as { slug: string }
    const input = { action: { kind: 'script' as const, script: 'scripts/refresh.ts' } }

    await expect(direct(RPC_CHANNELS.pages.ISSUE_GRANT, WORKSPACE_A, page.slug, input))
      .rejects.toThrow('PAGE_GRANT_HOST_CONSENT_REQUIRED')
    await expect(direct(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])

    const approved = createHarness('approve')
    const granted = await approved(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, input) as { id: string; contentDigest: string }
    expect(granted.id).toStartWith('grant_')
    expect(granted.contentDigest).toHaveLength(64)
    await expect(approved(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toHaveLength(1)
  })

  test('passes server-resolved identity, descriptor, and bounded page prose to the trusted host', async () => {
    const invoke = createHarness('approve')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Human readable Page', content: '<p>content</p>',
    }) as { slug: string }
    await invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
      description: `first line\nsecond line ${'x'.repeat(240)}`,
    })

    expect(invoke.confirmations).toHaveLength(1)
    expect(invoke.confirmations[0]).toMatchObject({
      workspace: { id: WORKSPACE_A, name: WORKSPACE_A },
      page: { slug: page.slug, name: 'Human readable Page' },
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    })
    expect(invoke.confirmations[0]?.pageMessage).toStartWith('The page says: first line second line')
    expect(invoke.confirmations[0]?.pageMessage).not.toContain('\n')
    expect(invoke.confirmations[0]?.pageMessage?.length).toBe(200)
  })

  test('sanitizes multiline and oversized server-resolved identities before host display', async () => {
    writeWorkspace(ROOT_A, WORKSPACE_A, true, `Weather\nAction: forged ${'w'.repeat(5_000)}`)
    const invoke = createHarness('approve')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: `Dashboard\nAction: forged ${'p'.repeat(5_000)}`, content: '<p>content</p>',
    }) as { slug: string }
    await invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/actual-action' },
    })

    const [confirmation] = invoke.confirmations
    expect(confirmation?.workspace.name).toStartWith('Weather Action: forged')
    expect(confirmation?.page.name).toStartWith('Dashboard Action: forged')
    expect(confirmation?.workspace.name).not.toContain('\n')
    expect(confirmation?.page.name).not.toContain('\n')
    expect(confirmation?.workspace.name.length).toBe(100)
    expect(confirmation?.page.name.length).toBe(100)
    expect(confirmation?.action).toEqual({
      kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/actual-action',
    })
  })

  test('declined, disconnected, and timed-out confirmations leave no grant', async () => {
    for (const outcome of ['decline', 'disconnect', 'no-answer'] as const) {
      const invoke = createHarness(outcome)
      const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
        name: `Grant ${outcome}`, content: '<p>content</p>',
      }) as { slug: string }
      const result = await invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
        action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
      })
      expect(result).toBeNull()
      await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])
    }
  })

  test('refuses a remote host without a trusted confirmation surface', async () => {
    const invoke = createHarness()
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Untrusted grant', content: '<p>content</p>',
    }) as { slug: string }
    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    })).rejects.toThrow('PAGE_GRANT_TRUSTED_CONFIRMATION_UNAVAILABLE')
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])
    // A hostile remote client advertises and returns approval for the generic
    // dialog capability, but Page grant issuance never asks it.
    expect(invoke.clientConsentCalls()).toBe(0)
  })

  test('rejects malformed descriptors before inspecting action kind or prompting', async () => {
    const invoke = createHarness('approve')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Malformed grant', content: '<p>content</p>',
    }) as { slug: string }
    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'script', script: '../escape.ts' },
    })).rejects.toThrow('PAGE_GRANT_INVALID_REQUEST')
    expect(invoke.confirmations).toEqual([])
  })

  test('coalesces identical pending consent requests into one host prompt', async () => {
    const invoke = createHarness('pending')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Coalesced grant', content: '<p>content</p>',
    }) as { slug: string }
    const input = { action: { kind: 'script' as const, script: 'scripts/refresh.ts' } }
    const first = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, input)
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const second = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      ...input,
      description: 'A changed page-authored message must not create another prompt',
    })
    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'mcp', sourceSlug: 'example', toolName: 'other_action' },
    })).rejects.toThrow('PAGE_GRANT_CONFIRMATION_PENDING')
    // The native host is global: another enabled workspace/page cannot open a
    // second modal while this request is pending.
    writeWorkspace(ROOT_B, WORKSPACE_B, true)
    const otherPage = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_B, {
      name: 'Second page', content: '<p>content</p>',
    }) as { slug: string }
    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_B, otherPage.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/other' },
    })).rejects.toThrow('PAGE_GRANT_CONFIRMATION_PENDING')
    for (let index = 0; index < 50; index++) {
      const blockedPage = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
        name: `Blocked page ${index}`, content: '<p>content</p>',
      }) as { slug: string }
      await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, blockedPage.slug, {
        action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: `/blocked/${index}` },
      })).rejects.toThrow('PAGE_GRANT_CONFIRMATION_PENDING')
    }
    expect(invoke.confirmations).toHaveLength(1)
    invoke.resolvePending()
    const [firstGrant, secondGrant] = await Promise.all([first, second]) as [{ id: string }, { id: string }]
    expect(firstGrant.id).toBe(secondGrant.id)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toHaveLength(1)
  })

  test('refuses a grant when content changes while the host prompt is pending', async () => {
    let pageSlug = ''
    const invoke = createHarness('approve', () => savePageContent(ROOT_A, pageSlug, '<p>changed</p>'))
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'TOCTOU grant', content: '<p>original</p>',
    }) as { slug: string }
    pageSlug = page.slug
    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'script', script: 'scripts/refresh.ts' },
    })).rejects.toThrow('content changed while approval was pending')
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])
  })

  test('resolves unknown workspaces before Pages availability checks', async () => {
    const invoke = createHarness()

    await expect(invoke(RPC_CHANNELS.pages.CREATE, 'unknown-workspace', { name: 'blocked' }))
      .rejects.toThrow('Workspace not found: unknown-workspace')
    await expect(invoke(RPC_CHANNELS.pages.CREATE_LEASE, 'unknown-workspace', 'missing'))
      .rejects.toThrow('Workspace not found: unknown-workspace')
    await expect(invoke(RPC_CHANNELS.pages.EXECUTE_ACTION, 'unknown-workspace', { pageSlug: 'missing' }))
      .rejects.toThrow('Workspace not found: unknown-workspace')
  })

  test('preserves cleanup after a workspace is disabled without creating a broker', async () => {
    const invoke = createHarness()
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Cleanup page', content: '<p>cleanup</p>',
    }) as { slug: string }
    const lease = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    writeWorkspace(ROOT_A, WORKSPACE_A, false)

    await expect(invoke(RPC_CHANNELS.pages.RELEASE_LEASE, WORKSPACE_A, lease.lease.leaseId)).resolves.toBeUndefined()
    await expect(invoke(RPC_CHANNELS.pages.CANCEL_ACTION, WORKSPACE_A, 'unknown-request')).resolves.toBe(false)
    await expect(invoke(RPC_CHANNELS.pages.REVOKE_GRANT, WORKSPACE_A, page.slug, 'unknown-grant')).resolves.toBe(false)
    await expect(invoke(RPC_CHANNELS.pages.DELETE, WORKSPACE_A, page.slug)).resolves.toEqual({ publicCopyMayRemain: false })
  })
})
