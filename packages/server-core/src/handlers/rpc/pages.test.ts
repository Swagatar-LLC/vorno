import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { MAX_LIVE_LEASES, savePageContent } from '@craft-agent/shared/pages'
import type { HandlerDeps, PageGrantConfirmationSpec, PageGrantRequester } from '../handler-deps'
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
  requesters: PageGrantRequester[]
  clientConsentCalls: () => number
  resolvePending: () => void
  setTrustedRequester: (requester: Pick<RequestContext, 'clientId' | 'workspaceId' | 'webContentsId'> | undefined) => void
  invokeWithContext: (ctx: RequestContext, channel: string, ...args: unknown[]) => Promise<unknown>
}

function createHarness(confirm: GrantConfirmation = 'unavailable', duringConfirmation?: () => void): GrantHarness {
  const handlers = new Map<string, HandlerFn>()
  const confirmations: PageGrantConfirmationSpec[] = []
  const requesters: PageGrantRequester[] = []
  let clientConsentCallCount = 0
  let requesterEpoch = 1
  let trustedRequester: (Pick<RequestContext, 'clientId' | 'workspaceId' | 'webContentsId'> & { connectionId: string }) | undefined = {
    clientId: 'trusted-client', workspaceId: WORKSPACE_A, webContentsId: 101, connectionId: `epoch-${requesterEpoch}`,
  }
  const pendingResolvers: Array<(accepted: boolean) => void> = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { clientConsentCallCount++; return { response: 1 } },
    hasClientCapability() { return true },
    findClientsWithCapability() { return ['hostile-client'] },
  }
  const confirmPageGrant = confirm === 'unavailable' ? undefined : async (requester: PageGrantRequester, spec: PageGrantConfirmationSpec) => {
    requesters.push(requester)
    confirmations.push(spec)
    duringConfirmation?.()
    if (confirm === 'approve') return true
    if (confirm === 'decline') return false
    if (confirm === 'disconnect') throw new Error('host dialog disconnected')
    if (confirm === 'pending') return await new Promise<boolean>(resolve => { pendingResolvers.push(resolve) })
    return await new Promise<boolean>(() => {})
  }
  registerPagesHandlers(server, {
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    sessionManager: {
      notifyConfigFileChange() {},
      enqueuePageThumbnail() {},
    },
    getPageGrantRequester: (ctx: RequestContext, workspaceId: string) => (
      trustedRequester &&
      ctx.clientId === trustedRequester.clientId &&
      ctx.workspaceId === workspaceId &&
      ctx.webContentsId === trustedRequester.webContentsId &&
      typeof trustedRequester.webContentsId === 'number'
        ? { webContentsId: trustedRequester.webContentsId, connectionId: trustedRequester.connectionId }
        : undefined
    ),
    confirmPageGrant,
    ...(confirm === 'no-answer' ? { pageGrantConfirmationTimeoutMs: 1 } : {}),
  } as unknown as HandlerDeps)
  const invokeWithContext = async (ctx: RequestContext, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`handler not registered: ${channel}`)
    if (channel === RPC_CHANNELS.pages.REQUEST_GRANT && args.length === 3) {
      const [workspaceId, pageSlug] = args as [string, string, unknown]
      const createLease = handlers.get(RPC_CHANNELS.pages.CREATE_LEASE)
      if (!createLease) throw new Error('missing create-lease handler')
      const { lease } = await createLease(ctx, workspaceId, pageSlug) as { lease: { leaseId: string } }
      return handler(ctx, ...args, lease.leaseId)
    }
    return handler(ctx, ...args)
  }
  const invoke = async (channel: string, ...args: unknown[]) => invokeWithContext({
    workspaceId: WORKSPACE_A,
    clientId: 'trusted-client',
    webContentsId: 101,
  }, channel, ...args)
  return Object.assign(invoke, {
    confirmations,
    requesters,
    clientConsentCalls: () => clientConsentCallCount,
    resolvePending: () => pendingResolvers.shift()?.(true),
    setTrustedRequester: (requester: Pick<RequestContext, 'clientId' | 'workspaceId' | 'webContentsId'> | undefined) => {
      trustedRequester = requester && { ...requester, connectionId: `epoch-${++requesterEpoch}` }
    },
    invokeWithContext,
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
    expect(invoke.confirmations[0]?.pageMessage).toStartWith('first line second line')
    expect(invoke.confirmations[0]?.pageMessage).not.toContain('\n')
    expect(invoke.confirmations[0]?.pageMessage?.length).toBe(200)
    expect(invoke.requesters).toEqual([{ webContentsId: 101, connectionId: 'epoch-1' }])
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

  test('requires a matching trusted Electron request context before opening native consent', async () => {
    const invoke = createHarness('approve')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Trusted context', content: '<p>content</p>',
    }) as { slug: string }
    const input = { action: { kind: 'api' as const, sourceSlug: 'example', method: 'GET' as const, pathPattern: '/items' } }

    await expect(invoke.invokeWithContext({
      clientId: 'token-client', workspaceId: WORKSPACE_A, webContentsId: null,
    }, RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, input)).rejects.toThrow('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')

    writeWorkspace(ROOT_B, WORKSPACE_B, true)
    const otherPage = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_B, {
      name: 'Wrong workspace', content: '<p>content</p>',
    }) as { slug: string }
    await expect(invoke.invokeWithContext({
      clientId: 'trusted-client', workspaceId: WORKSPACE_A, webContentsId: 101,
    }, RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_B, otherPage.slug, input)).rejects.toThrow('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')

    expect(invoke.confirmations).toEqual([])
  })

  test('does not persist a grant when the requester reconnects with the same client and window during confirmation', async () => {
    let invoke!: GrantHarness
    invoke = createHarness('approve', () => {
      // A valid transport reconnect retains these identifiers, but receives a
      // new server-held connection epoch. That must still invalidate consent.
      invoke.setTrustedRequester({ clientId: 'trusted-client', workspaceId: WORKSPACE_A, webContentsId: 101 })
    })
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Rebound requester', content: '<p>content</p>',
    }) as { slug: string }
    const { lease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }

    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    }, lease.leaseId)).resolves.toBeNull()

    expect(invoke.confirmations).toHaveLength(1)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])
  })

  test('refuses a stale requester-bound lease before prompting a replacement Electron window', async () => {
    const invoke = createHarness('approve')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Stale requester lease', content: '<p>content</p>',
    }) as { slug: string }
    const { lease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    const replacement = { clientId: 'replacement-client', workspaceId: WORKSPACE_A, webContentsId: 202 }
    invoke.setTrustedRequester(replacement)

    await expect(invoke.invokeWithContext(replacement, RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    }, lease.leaseId)).rejects.toThrow('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')

    expect(invoke.confirmations).toEqual([])
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])
  })

  test('keeps a grant binding when other workspaces reach their independent lease caps', async () => {
    const invoke = createHarness('approve')
    const pageA = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Workspace A leases', content: '<p>content</p>',
    }) as { slug: string }
    const { lease: firstLease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, pageA.slug) as { lease: { leaseId: string } }
    for (let i = 1; i < MAX_LIVE_LEASES; i++) {
      await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, pageA.slug)
    }

    writeWorkspace(ROOT_B, WORKSPACE_B, true)
    const pageB = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_B, {
      name: 'Workspace B leases', content: '<p>content</p>',
    }) as { slug: string }
    const workspaceBContext = { clientId: 'trusted-client', workspaceId: WORKSPACE_B, webContentsId: 101 }
    for (let i = 0; i < MAX_LIVE_LEASES; i++) {
      await invoke.invokeWithContext(workspaceBContext, RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_B, pageB.slug)
    }

    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, pageA.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    }, firstLease.leaseId)).resolves.toMatchObject({ id: expect.any(String) })
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

  test('coalesces duplicate consent, limits a render to one prompt, and queues another page', async () => {
    const invoke = createHarness('pending')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Coalesced grant', content: '<p>content</p>',
    }) as { slug: string }
    const { lease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    const input = { action: { kind: 'script' as const, script: 'scripts/refresh.ts' } }
    const first = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, input, lease.leaseId)
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const duplicate = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      ...input,
      description: 'A changed page-authored message must not create another prompt',
    }, lease.leaseId)
    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'mcp', sourceSlug: 'example', toolName: 'other_action' },
    }, lease.leaseId)).rejects.toThrow('PAGE_GRANT_CONFIRMATION_ALREADY_PENDING')

    writeWorkspace(ROOT_B, WORKSPACE_B, true)
    const otherPage = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_B, {
      name: 'Second page', content: '<p>content</p>',
    }) as { slug: string }
    const otherContext = { clientId: 'trusted-client', workspaceId: WORKSPACE_B, webContentsId: 101 }
    const { lease: otherLease } = await invoke.invokeWithContext(otherContext, RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_B, otherPage.slug) as { lease: { leaseId: string } }
    const secondPage = invoke.invokeWithContext(otherContext, RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_B, otherPage.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/other' },
    }, otherLease.leaseId)

    for (let prompt = 0; prompt < 2; prompt++) {
      for (let attempt = 0; attempt < 10 && invoke.confirmations.length <= prompt; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      expect(invoke.confirmations).toHaveLength(prompt + 1)
      invoke.resolvePending()
    }
    const [firstGrant, duplicateGrant, secondPageGrant] = await Promise.all([
      first, duplicate, secondPage,
    ]) as [{ id: string }, { id: string }, { id: string }]
    expect(firstGrant.id).toBe(duplicateGrant.id)
    expect(secondPageGrant.id).not.toBe(firstGrant.id)
    expect(invoke.confirmations).toHaveLength(2)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toHaveLength(1)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_B, otherPage.slug)).resolves.toHaveLength(1)
  })

  test('cancels queued consent when its Page render lease is released', async () => {
    const invoke = createHarness('pending')
    const firstPage = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Active prompt', content: '<p>content</p>',
    }) as { slug: string }
    const { lease: firstLease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, firstPage.slug) as { lease: { leaseId: string } }
    const first = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, firstPage.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/first' },
    }, firstLease.leaseId)
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    const cancelledPage = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Cancelled prompt', content: '<p>content</p>',
    }) as { slug: string }
    const { lease: cancelledLease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, cancelledPage.slug) as { lease: { leaseId: string } }
    const cancelled = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, cancelledPage.slug, {
      action: { kind: 'mcp', sourceSlug: 'example', toolName: 'cancelled_action' },
    }, cancelledLease.leaseId)
    await invoke(RPC_CHANNELS.pages.RELEASE_LEASE, WORKSPACE_A, cancelledLease.leaseId)
    invoke.resolvePending()

    await expect(first).resolves.toMatchObject({ id: expect.any(String) })
    await expect(cancelled).resolves.toBeNull()
    expect(invoke.confirmations).toHaveLength(1)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, cancelledPage.slug)).resolves.toEqual([])
  })

  test('does not coalesce a changed digest with stale pending consent', async () => {
    const invoke = createHarness('pending')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Digest queue', content: '<p>original</p>',
    }) as { slug: string }
    const input = { action: { kind: 'script' as const, script: 'scripts/refresh.ts' } }
    const stale = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, input)
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    savePageContent(ROOT_A, page.slug, '<p>changed</p>')
    const current = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, input)
    invoke.resolvePending()
    await expect(stale).rejects.toThrow('content changed while approval was pending')
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    invoke.resolvePending()
    await expect(current).resolves.toMatchObject({ contentDigest: expect.any(String) })
    expect(invoke.confirmations).toHaveLength(2)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toHaveLength(1)
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
