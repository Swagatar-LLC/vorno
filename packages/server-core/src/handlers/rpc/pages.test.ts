import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
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
/** Where `appendPageActionAudit` lands under the hermetic test config dir. */
const AUDIT_LOG = join(CONFIG_DIR, 'logs', 'page-actions.jsonl')
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
  confirmationSignals: AbortSignal[]
  clientConsentCalls: () => number
  resolvePending: () => void
  /** Replace the live window→workspace map WindowManager would report. */
  setLiveWindows: (windows: Record<number, string>) => void
  /**
   * Replace the document inside a live window, as a reload, a main-frame
   * navigation, or a renderer crash-and-recover does: same webContents id,
   * same workspace, new render generation.
   */
  replaceRenderer: (webContentsId: number) => void
  /** The host entry point itself, for states the IPC hop cannot reproduce. */
  requestGrantAsHost: import('../handler-deps').PageGrantHostRequest
  invokeWithContext: (ctx: RequestContext, channel: string, ...args: unknown[]) => Promise<unknown>
  invokeTransportWithContext: (ctx: RequestContext, channel: string, ...args: unknown[]) => Promise<unknown>
}

function createHarness(
  confirm: GrantConfirmation = 'unavailable',
  duringConfirmation?: () => void,
  confirmForgetPagePublication?: HandlerDeps['confirmForgetPagePublication'],
  confirmationTimeoutMs?: number,
): GrantHarness {
  const handlers = new Map<string, HandlerFn>()
  const confirmations: PageGrantConfirmationSpec[] = []
  const requesters: PageGrantRequester[] = []
  const confirmationSignals: AbortSignal[] = []
  let clientConsentCallCount = 0
  // Exactly what Electron's WindowManager knows: which live app window shows
  // which workspace. Nothing here is transport-supplied.
  let liveWindows = new Map<number, string>([[101, WORKSPACE_A]])
  // The main process's render generation per webContents. A window id survives
  // a reload; the generation does not.
  const renderGenerations = new Map<number, number>()
  const trackRenderGeneration = (webContentsId: number) => {
    const existing = renderGenerations.get(webContentsId)
    if (existing !== undefined) return existing
    renderGenerations.set(webContentsId, 1)
    return 1
  }
  let hostRequest: import('../handler-deps').PageGrantHostRequest | undefined
  let invalidateRequester: ((requester: PageGrantRequester) => void) | undefined
  const pendingResolvers: Array<(accepted: boolean) => void> = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { clientConsentCallCount++; return { response: 1 } },
    hasClientCapability() { return true },
    findClientsWithCapability() { return ['hostile-client'] },
  }
  const confirmPageGrant = confirm === 'unavailable' ? undefined : async (
    requester: PageGrantRequester,
    spec: PageGrantConfirmationSpec,
    signal: AbortSignal,
  ) => {
    requesters.push(requester)
    confirmations.push(spec)
    confirmationSignals.push(signal)
    duringConfirmation?.()
    if (confirm === 'approve') return true
    if (confirm === 'decline') return false
    if (confirm === 'disconnect') throw new Error('host dialog disconnected')
    // A real native dialog closes on `signal` whether or not the user answers:
    // aborting resolves it as a denial rather than leaving it on screen. A
    // closed dialog also leaves the answerable queue — the user cannot click a
    // sheet that is no longer there, so `resolvePending` must not reach it.
    if (confirm === 'pending') {
      return await new Promise<boolean>(resolve => {
        pendingResolvers.push(resolve)
        signal.addEventListener('abort', () => {
          const queued = pendingResolvers.indexOf(resolve)
          if (queued >= 0) pendingResolvers.splice(queued, 1)
          resolve(false)
        }, { once: true })
      })
    }
    return await new Promise<boolean>(resolve => {
      signal.addEventListener('abort', () => resolve(false), { once: true })
    })
  }
  registerPagesHandlers(server, {
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    sessionManager: {
      notifyConfigFileChange() {},
      enqueuePageThumbnail() {},
    },
    // A host answers about its own window's workspace. It receives the
    // resolved id and is free to hold that workspace under any name it knows
    // it by, so it resolves before comparing — exactly as Electron's
    // WindowManager compares the id it stored.
    isPageGrantRequesterCurrent: (requester: PageGrantRequester, workspaceId: string) => {
      const shown = liveWindows.get(requester.webContentsId)
      return shown !== undefined && getWorkspaceByNameOrId(shown)?.id === workspaceId &&
        renderGenerations.get(requester.webContentsId) === requester.renderGeneration
    },
    registerPageGrantHostRequest: (request: import('../handler-deps').PageGrantHostRequest) => { hostRequest = request },
    registerPageGrantInvalidator: (invalidate: (requester: PageGrantRequester) => void) => { invalidateRequester = invalidate },
    confirmPageGrant,
    ...((confirm === 'no-answer' || confirmationTimeoutMs !== undefined) ? { pageGrantConfirmationTimeoutMs: confirmationTimeoutMs ?? 1 } : {}),
    confirmForgetPagePublication,
  } as unknown as HandlerDeps)
  const invokeTransportWithContext = async (ctx: RequestContext, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`handler not registered: ${channel}`)
    return handler(ctx, ...args)
  }
  /**
   * The Electron main-process `__pages:request-grant` handler, modelled
   * faithfully: the sender's WebContents id is observed (never received) and
   * the workspace is resolved from the live window map, so a caller cannot
   * name either one.
   */
  const requestGrantOverHostIpc = async (senderWebContentsId: number, pageSlug: string, input: unknown, leaseId: unknown) => {
    const workspaceId = liveWindows.get(senderWebContentsId)
    if (!workspaceId || !hostRequest) throw new Error('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')
    const renderGeneration = trackRenderGeneration(senderWebContentsId)
    return hostRequest({ webContentsId: senderWebContentsId, renderGeneration }, workspaceId, pageSlug, input, leaseId)
  }
  const invokeWithContext = async (ctx: RequestContext, channel: string, ...args: unknown[]) => {
    if (channel !== RPC_CHANNELS.pages.REQUEST_GRANT) return invokeTransportWithContext(ctx, channel, ...args)
    const [workspaceId, pageSlug, input, suppliedLeaseId] = args as [string, string, unknown, string | undefined]
    const createLease = handlers.get(RPC_CHANNELS.pages.CREATE_LEASE)
    if (!createLease || ctx.webContentsId == null) throw new Error('missing host grant setup')
    const leaseId = suppliedLeaseId ?? (await createLease(ctx, workspaceId, pageSlug) as { lease: { leaseId: string } }).lease.leaseId
    return requestGrantOverHostIpc(ctx.webContentsId, pageSlug, input, leaseId)
  }
  const invoke = async (channel: string, ...args: unknown[]) => invokeWithContext({
    workspaceId: WORKSPACE_A,
    clientId: 'trusted-client',
    webContentsId: 101,
  }, channel, ...args)
  return Object.assign(invoke, {
    confirmations,
    requesters,
    confirmationSignals,
    clientConsentCalls: () => clientConsentCallCount,
    resolvePending: () => pendingResolvers.shift()?.(true),
    setLiveWindows: (windows: Record<number, string>) => {
      liveWindows = new Map(Object.entries(windows).map(([id, ws]) => [Number(id), ws]))
    },
    replaceRenderer: (webContentsId: number) => {
      const retired = renderGenerations.get(webContentsId) ?? 0
      renderGenerations.set(webContentsId, retired + 1)
      // The host tells the handler which generation it just retired, exactly
      // as Electron main does on navigation, reload, and renderer loss.
      invalidateRequester?.({ webContentsId, renderGeneration: retired })
    },
    requestGrantAsHost: ((requester, workspaceId, pageSlug, input, leaseId) => {
      if (!hostRequest) throw new Error('missing host grant setup')
      trackRenderGeneration(requester.webContentsId)
      return hostRequest(requester, workspaceId, pageSlug, input, leaseId)
    }) as import('../handler-deps').PageGrantHostRequest,
    invokeWithContext,
    invokeTransportWithContext,
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

  test('refuses direct local-forget RPC without a trusted host confirmation seam', async () => {
    const invoke = createHarness()
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, { name: 'Keep pointer', content: '<p>keep</p>' }) as { slug: string }
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, page.slug, { forgetLocal: true }))
      .rejects.toThrow('trusted host confirmation')
  })

  test('honors trusted-host decline and calls the approval seam before local forget', async () => {
    let calls = 0
    const invoke = createHarness('unavailable', undefined, async () => { calls++; return false })
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, { name: 'Decline pointer', content: '<p>keep</p>' }) as { slug: string }
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, page.slug, { forgetLocal: true }))
      .rejects.toThrow('PAGE_FORGET_CONFIRMATION_CANCELLED')
    expect(calls).toBe(1)
  })

  test('allows an explicit trusted-host approval to perform local-only recovery and sanitizes its workspace identity', async () => {
    writeWorkspace(ROOT_A, WORKSPACE_A, true, 'Workspace\nForged control\u0000 text')
    let seen = ''
    const invoke = createHarness('unavailable', undefined, async ({ workspaceName }) => { seen = workspaceName; return true })
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, { name: 'Approved recovery', content: '<p>keep</p>' }) as { slug: string }
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, page.slug, { forgetLocal: true })).resolves.toMatchObject({ warning: undefined })
    expect(seen).toBe('Workspace Forged control text')
  })

  test('times out a never-settling forget confirmation and releases the host-wide slot', async () => {
    const invoke = createHarness('unavailable', undefined, async () => await new Promise<boolean>(() => {}), 1)
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, { name: 'Timed forget', content: '<p>keep</p>' }) as { slug: string }
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, page.slug, { forgetLocal: true }))
      .rejects.toThrow('confirmation timed out or failed')
    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, { action: { kind: 'script', script: 'scripts/refresh.ts' } }))
      .rejects.toThrow('PAGE_GRANT_TRUSTED_CONFIRMATION_UNAVAILABLE')
  })

  test('sanitizes a hostile caller-provided slug before native forget display', async () => {
    let seen = ''
    const invoke = createHarness('unavailable', undefined, async ({ pageSlug }) => { seen = pageSlug; return true })
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, `safe\nAction: forged\u0000${'x'.repeat(5_000)}`, { forgetLocal: true }))
      .rejects.toThrow()
    expect(seen).toStartWith('safe Action: forged')
    expect(seen).not.toContain('\n')
    expect(seen).toHaveLength(100)
  })

  test('serializes grant and forget confirmation dialogs in one host-wide slot', async () => {
    const grant = createHarness('pending', undefined, async () => true)
    const page = await grant(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, { name: 'Grant first', content: '<p>keep</p>' }) as { slug: string }
    const pendingGrant = grant(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, { action: { kind: 'script', script: 'scripts/refresh.ts' } })
    for (let attempt = 0; attempt < 10 && grant.confirmations.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 0))
    await expect(grant(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, page.slug, { forgetLocal: true })).rejects.toThrow('PAGE_FORGET_CONFIRMATION_PENDING')
    grant.resolvePending()
    await pendingGrant

    let resolveForget!: (value: boolean) => void
    const forget = createHarness('unavailable', undefined, async () => await new Promise<boolean>(resolve => { resolveForget = resolve }))
    const forgetPage = await forget(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, { name: 'Forget first', content: '<p>keep</p>' }) as { slug: string }
    const pendingForget = forget(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, forgetPage.slug, { forgetLocal: true })
    for (let attempt = 0; attempt < 10 && !resolveForget; attempt++) await new Promise(resolve => setTimeout(resolve, 0))
    await expect(forget(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, forgetPage.slug, { action: { kind: 'script', script: 'scripts/refresh.ts' } })).rejects.toThrow('PAGE_GRANT_CONFIRMATION_PENDING')
    resolveForget(true)
    await pendingForget
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
    expect(invoke.requesters).toEqual([{ webContentsId: 101, renderGeneration: 1 }])
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

  test('refuses hostile transport assertions even when they claim the real Electron window and workspace', async () => {
    const invoke = createHarness('approve')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'IPC-only context', content: '<p>content</p>',
    }) as { slug: string }
    const { lease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    // Every field a WebSocket client controls is set to the truth: the real
    // live window id, its real workspace, a real active lease for a real page.
    const hostileTransport = { clientId: 'attacker', workspaceId: WORKSPACE_A, webContentsId: 101 }

    await expect(invoke.invokeTransportWithContext(hostileTransport, RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    }, lease.leaseId)).rejects.toThrow('PAGE_GRANT_IPC_REQUIRED')

    expect(invoke.confirmations).toEqual([])
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])
  })

  test('issues a grant for a legitimate Electron host IPC request on the same lease the transport refused', async () => {
    const invoke = createHarness('approve')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Host IPC grant', content: '<p>content</p>',
    }) as { slug: string }
    const { lease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    const input = { action: { kind: 'api' as const, sourceSlug: 'example', method: 'GET' as const, pathPattern: '/items' } }

    await expect(invoke.invokeTransportWithContext({
      clientId: 'attacker', workspaceId: WORKSPACE_A, webContentsId: 101,
    }, RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, input, lease.leaseId))
      .rejects.toThrow('PAGE_GRANT_IPC_REQUIRED')

    // Same window, same workspace, same lease — but arriving through the host
    // IPC entry point, which observes the sender rather than being told it.
    const grant = await invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, input, lease.leaseId) as { id: string }
    expect(grant.id).toStartWith('grant_')
    expect(invoke.confirmations).toHaveLength(1)
    expect(invoke.requesters).toEqual([{ webContentsId: 101, renderGeneration: 1 }])
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toHaveLength(1)
  })

  test('does not persist consent a reload replaced, and lets the new document ask again', async () => {
    const invoke = createHarness('pending')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Reloaded render', content: '<p>content</p>',
    }) as { slug: string }
    const { lease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    const input = { action: { kind: 'api' as const, sourceSlug: 'example', method: 'GET' as const, pathPattern: '/items' } }
    const pending = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, input, lease.leaseId)
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    // The document is replaced while its prompt is open. The window id, the
    // workspace mapping, and — because release is renderer-owned — the lease
    // all survive, so nothing but the render generation distinguishes the
    // replacement from the document the user was answering for.
    invoke.replaceRenderer(101)
    invoke.resolvePending()

    await expect(pending).resolves.toBeNull()
    expect(invoke.confirmations).toHaveLength(1)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])

    // The predecessor's lease is not inheritable either.
    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, input, lease.leaseId))
      .rejects.toThrow('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')

    // On its own fresh lease the replacement consents normally: the generation
    // voids stale approvals, it does not lock the window out.
    const { lease: reloaded } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    const granted = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, input, reloaded.leaseId)
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    invoke.resolvePending()
    await expect(granted).resolves.toMatchObject({ id: expect.any(String) })
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toHaveLength(1)
  })

  test('does not persist consent a lost renderer process replaced', async () => {
    let invoke!: GrantHarness
    // A crash-and-recover keeps the webContents id, so it reaches the final
    // persistence checks exactly as a reload does.
    invoke = createHarness('approve', () => { invoke.replaceRenderer(101) })
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Lost renderer', content: '<p>content</p>',
    }) as { slug: string }
    const { lease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }

    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    }, lease.leaseId)).resolves.toBeNull()

    expect(invoke.confirmations).toHaveLength(1)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])
  })

  test('refuses a request whose window went away between the host IPC hop and the handler', async () => {
    const invoke = createHarness('approve')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Vanished sender', content: '<p>content</p>',
    }) as { slug: string }
    const { lease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    // The host resolved a live window and dispatched; the window closed before
    // the async handler ran. The handler re-checks rather than trusting the
    // resolution it was handed.
    invoke.setLiveWindows({})

    await expect(invoke.requestGrantAsHost({ webContentsId: 101, renderGeneration: 1 }, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    }, lease.leaseId)).rejects.toThrow('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')

    expect(invoke.confirmations).toEqual([])
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])
  })

  test('aborts the host confirmation surface when the request deadline elapses', async () => {
    const invoke = createHarness('no-answer')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Unanswered prompt', content: '<p>content</p>',
    }) as { slug: string }

    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    })).resolves.toBeNull()

    // Abandoning the race is not enough: without a delivered abort the OS
    // modal stays on the user's window and blocks every later request.
    expect(invoke.confirmationSignals).toHaveLength(1)
    expect(invoke.confirmationSignals[0]?.aborted).toBe(true)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])
  })

  test('releases the host confirmation surface after an answered prompt', async () => {
    const invoke = createHarness('approve')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Answered prompt', content: '<p>content</p>',
    }) as { slug: string }
    await invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    })

    expect(invoke.confirmationSignals[0]?.aborted).toBe(true)
  })

  test('does not persist a grant when the requesting Electron window disappears during confirmation', async () => {
    let invoke!: GrantHarness
    invoke = createHarness('approve', () => {
      invoke.setLiveWindows({})
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
    await invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/first' },
    }, lease.leaseId)
    const replacement = { clientId: 'replacement-client', workspaceId: WORKSPACE_A, webContentsId: 202 }
    invoke.setLiveWindows({ 202: WORKSPACE_A })

    await expect(invoke.invokeWithContext(replacement, RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    }, lease.leaseId)).rejects.toThrow('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')

    expect(invoke.confirmations).toHaveLength(1)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toHaveLength(1)
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

    expect(invoke.confirmations).toHaveLength(1)
    invoke.resolvePending()
    const [firstGrant, duplicateGrant] = await Promise.all([first, duplicate]) as [{ id: string }, { id: string }]
    expect(firstGrant.id).toBe(duplicateGrant.id)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toHaveLength(1)
  })

  test('coalesces an equivalent descriptor spelled differently into one prompt and one grant', async () => {
    const invoke = createHarness('pending')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Descriptor identity', content: '<p>content</p>',
    }) as { slug: string }
    const { lease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    const first = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'script', script: 'scripts/refresh.ts' },
    }, lease.leaseId)
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    // Same capability, three ways a page can restate it: reordered keys, the
    // runtime written out as the default it already had, and `args` written
    // out as the empty list it already was. None of these is a new request.
    const restated = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { args: [], script: 'scripts/refresh.ts', runtime: 'bun', kind: 'script' },
    }, lease.leaseId)

    expect(invoke.confirmations).toHaveLength(1)
    invoke.resolvePending()
    const [firstGrant, restatedGrant] = await Promise.all([first, restated]) as [{ id: string }, { id: string }]
    expect(restatedGrant.id).toBe(firstGrant.id)
    expect(invoke.confirmations).toHaveLength(1)
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toHaveLength(1)
  })

  test('records the resolved workspace id when the request arrives under a workspace name alias', async () => {
    // `getWorkspaceByNameOrId` resolves an id, a name, or a differently-cased
    // name. Only the id is an identity: audit lines and consent coalescing
    // must not fork just because a caller spelled the workspace another way.
    writeWorkspace(ROOT_A, WORKSPACE_A, true, 'Canonical Display')
    const invoke = createHarness('approve')
    invoke.setLiveWindows({ 101: 'canonical display' })
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Canonical workspace', content: '<p>content</p>',
    }) as { slug: string }
    rmSync(AUDIT_LOG, { force: true })

    const grant = await invoke.requestGrantAsHost({ webContentsId: 101, renderGeneration: 1 }, 'Canonical Display', page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    }, ((await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug)) as { lease: { leaseId: string } }).lease.leaseId) as { id: string }

    expect(grant.id).toStartWith('grant_')
    expect(invoke.confirmations[0]?.workspace.id).toBe(WORKSPACE_A)
    const audited = readFileSync(AUDIT_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; workspaceId: string })
    const decisions = audited.filter(entry => entry.event.startsWith('page_grant_'))
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ event: 'page_grant_approved', workspaceId: WORKSPACE_A })
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

  test('closes an open prompt when its render lease is released, unblocking the queue', async () => {
    const invoke = createHarness('pending')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Released prompt', content: '<p>content</p>',
    }) as { slug: string }
    const { lease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    const open = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/first' },
    }, lease.leaseId)
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(invoke.confirmationSignals[0]?.aborted).toBe(false)

    await invoke(RPC_CHANNELS.pages.RELEASE_LEASE, WORKSPACE_A, lease.leaseId)

    // Refusing to persist the answer is not enough — the surface itself has to
    // close, or the serial queue waits behind a prompt that can no longer
    // produce a grant.
    expect(invoke.confirmationSignals[0]?.aborted).toBe(true)
    await expect(open).resolves.toBeNull()
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])

    // The next request reaches the host immediately rather than after the
    // abandoned prompt's full timeout.
    const { lease: next } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    const second = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/second' },
    }, next.leaseId)
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(invoke.confirmations).toHaveLength(2)
    invoke.resolvePending()
    await expect(second).resolves.toMatchObject({ id: expect.any(String) })
  })

  test('closes a stale prompt when the renderer generation is replaced, unblocking the queue', async () => {
    const invoke = createHarness('pending')
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Replaced prompt', content: '<p>content</p>',
    }) as { slug: string }
    const { lease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    const open = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/first' },
    }, lease.leaseId)
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(invoke.confirmationSignals[0]?.aborted).toBe(false)

    // Same window, same workspace, still-active lease: only the generation
    // changed, and the lease outlives the render because release is
    // renderer-owned.
    invoke.replaceRenderer(101)

    expect(invoke.confirmationSignals[0]?.aborted).toBe(true)
    await expect(open).resolves.toBeNull()
    await expect(invoke(RPC_CHANNELS.pages.LIST_GRANTS, WORKSPACE_A, page.slug)).resolves.toEqual([])

    // The replacement render is not stuck behind its predecessor's sheet.
    const { lease: reloaded } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as { lease: { leaseId: string } }
    const second = invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, page.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/second' },
    }, reloaded.leaseId)
    for (let attempt = 0; attempt < 10 && invoke.confirmations.length < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(invoke.confirmations).toHaveLength(2)
    invoke.resolvePending()
    await expect(second).resolves.toMatchObject({ id: expect.any(String) })
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
