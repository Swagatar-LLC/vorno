import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { MAX_LIVE_LEASES, savePageContent, setPageShareState } from '@craft-agent/shared/pages'
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

function writeWorkspace(
  rootPath: string,
  id: string,
  enabled: boolean,
  name = id,
  permissionMode: 'safe' | 'ask' | 'allow-all' = 'ask',
): void {
  mkdirSync(rootPath, { recursive: true })
  writeFileSync(join(rootPath, 'config.json'), JSON.stringify({
    id,
    name,
    slug: id,
    defaults: { pages: { enabled }, permissionMode },
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
  /**
   * Mint an activation ticket the way Electron main does. There is deliberately
   * no RPC channel for this, so a test that wants a ticket must come through
   * the host — exactly like the product.
   */
  requestActivationAsHost: (
    webContentsId: number,
    workspaceId: string,
    pageSlug: string,
    request: unknown,
  ) => Promise<{ ticketId: string; expiresAt: number }>
  actionConfirmations: Array<{ pageSlug: string }>
  /** Answer an action confirmation that is currently on screen. */
  resolveActionConfirmation: () => void
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
  let hostActivationRequest: import('../handler-deps').PageActivationHostRequest | undefined
  const actionConfirmations: Array<{ pageSlug: string }> = []
  const actionConfirmationResolvers: Array<(accepted: boolean) => void> = []
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
    registerPageActivationHostRequest: (request: import('../handler-deps').PageActivationHostRequest) => { hostActivationRequest = request },
    // First-use confirmation follows the grant harness's verdict: a host that
    // cannot render grant consent cannot render this either.
    confirmPageAction: confirm === 'unavailable' ? undefined : async (
      _requester: PageGrantRequester,
      spec: import('../handler-deps').PageActionConfirmationSpec,
      signal: AbortSignal,
    ) => {
      actionConfirmations.push({ pageSlug: spec.page.slug })
      // A real sheet stays on the window until it is answered or dismissed, and
      // dismissal arrives as `signal`. Modelling that is the only way to test
      // that a release or a retired render can actually close one.
      if (confirm === 'pending') {
        return await new Promise<boolean>(resolve => {
          actionConfirmationResolvers.push(resolve)
          signal.addEventListener('abort', () => {
            const queued = actionConfirmationResolvers.indexOf(resolve)
            if (queued >= 0) actionConfirmationResolvers.splice(queued, 1)
            resolve(false)
          }, { once: true })
        })
      }
      return confirm === 'approve'
    },
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
    requestActivationAsHost: async (
      webContentsId: number,
      workspaceId: string,
      pageSlug: string,
      request: unknown,
    ) => {
      if (!hostActivationRequest) throw new Error('missing host activation setup')
      trackRenderGeneration(webContentsId)
      return hostActivationRequest(
        { webContentsId, renderGeneration: renderGenerations.get(webContentsId)! },
        workspaceId,
        pageSlug,
        request,
      )
    },
    actionConfirmations,
    resolveActionConfirmation: () => actionConfirmationResolvers.shift()?.(true),
    invokeWithContext,
    invokeTransportWithContext,
  })
}

/**
 * Seed the only state local recovery is for: a retained share pointer whose
 * admin capability is absent from the vault, so the public copy cannot be
 * revoked through the ordinary path.
 *
 * The pointer has to be real. A page with no `share` is refused outright now,
 * and a fixture that skipped this was asserting against a refusal that never
 * reached the behavior under test.
 */
async function seedUnrevocablePublication(
  invoke: GrantHarness,
  name: string,
  publicationId: string,
  cleanupPending = false,
): Promise<{ slug: string; publicationId: string }> {
  const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
    name, content: `<p>${publicationId}</p>`,
  }) as { slug: string; contentDigest: string }
  setPageShareState(ROOT_A, page.slug, {
    publicationId,
    url: `https://pages.vorno.ai/p/${publicationId}`,
    publishedRevision: 'r1',
    publishedContentDigest: page.contentDigest,
    includesData: false,
    publishedAt: 1,
    updatedAt: 1,
    passwordProtected: false,
    ...(cleanupPending ? { cleanupPending: true } : {}),
  })
  return { slug: page.slug, publicationId }
}

/** The share pointer as it survives a fresh disk reload. */
function loadSharedPublicationId(pageSlug: string): string | undefined {
  const file = join(ROOT_A, 'pages', pageSlug, 'page.json')
  if (!existsSync(file)) return undefined
  return (JSON.parse(readFileSync(file, 'utf8')) as { share?: { publicationId?: string } }).share?.publicationId
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
    const { slug } = await seedUnrevocablePublication(invoke, 'Keep pointer', 'publication-seam')
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, slug, { forgetLocal: true }))
      .rejects.toThrow('trusted host confirmation')
    // A host that cannot ask keeps the recovery state it could not be authorized
    // to discard, so the copy stays revocable if the capability comes back.
    expect(loadSharedPublicationId(slug)).toBe('publication-seam')
  })

  test('honors trusted-host decline and calls the approval seam before local forget', async () => {
    let calls = 0
    const invoke = createHarness('unavailable', undefined, async () => { calls++; return false })
    const { slug } = await seedUnrevocablePublication(invoke, 'Decline pointer', 'publication-decline')
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, slug, { forgetLocal: true }))
      .rejects.toThrow('PAGE_FORGET_CONFIRMATION_CANCELLED')
    expect(calls).toBe(1)
    expect(loadSharedPublicationId(slug)).toBe('publication-decline')
  })

  test('refuses local recovery without a prompt for a page that has nothing to forget', async () => {
    let calls = 0
    const invoke = createHarness('unavailable', undefined, async () => { calls++; return true })
    const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, { name: 'Never shared', content: '<p>local</p>' }) as { slug: string }
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, page.slug, { forgetLocal: true }))
      .rejects.toThrow('PAGE_SHARE_NOT_PUBLISHED')
    // The destructive question is never put to the user for a page that was
    // never published — eligibility is settled before any host chrome opens.
    expect(calls).toBe(0)
  })

  test('allows an explicit trusted-host approval to perform local-only recovery and bounds its workspace identity', async () => {
    writeWorkspace(ROOT_A, WORKSPACE_A, true, `Workspace\nForged control\u0000 text${'x'.repeat(5_000)}`)
    let seen = ''
    const invoke = createHarness('unavailable', undefined, async ({ workspaceName }) => { seen = workspaceName; return true })
    const { slug } = await seedUnrevocablePublication(invoke, 'Approved recovery', 'publication-approved')
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, slug, { forgetLocal: true }))
      .resolves.toMatchObject({ warning: undefined })
    expect(loadSharedPublicationId(slug)).toBeUndefined()
    // Server-resolved but still user-authored: controls collapse and the value is
    // bounded, so a name cannot forge a dialog field or bury the real action.
    expect(seen).toStartWith('Workspace Forged control text')
    expect(seen).not.toContain('\n')
    expect(seen).toHaveLength(100)
  })

  test('times out a never-settling forget confirmation, aborts native UI, and releases the host-wide slot', async () => {
    let aborted = false
    const invoke = createHarness('unavailable', undefined, async ({ signal }) => await new Promise<boolean>(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve(false) }, { once: true })
    }), 1)
    const { slug } = await seedUnrevocablePublication(invoke, 'Timed forget', 'publication-timeout')
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, slug, { forgetLocal: true }))
      .rejects.toThrow('confirmation timed out')
    expect(aborted).toBe(true)
    expect(loadSharedPublicationId(slug)).toBe('publication-timeout')
    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, slug, { action: { kind: 'script', script: 'scripts/refresh.ts' } }))
      .rejects.toThrow('PAGE_GRANT_TRUSTED_CONFIRMATION_UNAVAILABLE')
  })

  test('refuses a hostile caller-provided slug before any native forget display', async () => {
    let calls = 0
    const invoke = createHarness('unavailable', undefined, async () => { calls++; return true })
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, `safe\nAction: forged\u0000${'x'.repeat(5_000)}`, { forgetLocal: true }))
      .rejects.toThrow()
    // Resolving the page first is what keeps hostile text off native chrome
    // entirely: an unresolvable slug has no publication, so nothing is asked.
    expect(calls).toBe(0)
  })

  test('tells the host both facts, so a revoked page is not described as possibly public', async () => {
    // The dialog needs WHICH capability is gone and WHETHER the copy is offline.
    // They vary independently, so one value cannot stand in for the other.
    const asked: Array<{ reason: string; alreadyRevoked: boolean }> = []
    const invoke = createHarness('unavailable', undefined, async ({ reason, alreadyRevoked }) => {
      asked.push({ reason, alreadyRevoked })
      return true
    })

    // Never confirmed revoked: the alarming wording is the correct one.
    const unconfirmed = await seedUnrevocablePublication(invoke, 'Unconfirmed', 'publication-unconfirmed')
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, unconfirmed.slug, { forgetLocal: true }))
      .resolves.toMatchObject({ warning: undefined })

    // Already revoked, with only physical cleanup outstanding.
    const revoked = await seedUnrevocablePublication(invoke, 'Revoked', 'publication-revoked', true)
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, revoked.slug, { forgetLocal: true }))
      .resolves.toMatchObject({ warning: undefined })

    expect(asked).toEqual([
      { reason: 'token-missing', alreadyRevoked: false },
      { reason: 'token-missing', alreadyRevoked: true },
    ])
  })

  test('coalesces duplicate local-recovery requests into one host confirmation and one write', async () => {
    let prompts = 0
    let answer!: (accepted: boolean) => void
    const invoke = createHarness('unavailable', undefined, async () => {
      prompts++
      return await new Promise<boolean>(resolve => { answer = resolve })
    })
    const { slug } = await seedUnrevocablePublication(invoke, 'Duplicate forget', 'publication-duplicate')
    const first = invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, slug, { forgetLocal: true })
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, slug, { forgetLocal: true })
    await new Promise(resolve => setTimeout(resolve, 5))
    // Two native sheets asking the same irreversible question is the failure
    // here: the second request joins the first instead of stacking on the window.
    expect(prompts).toBe(1)

    answer(true)
    for (const settled of await Promise.all([first, second])) {
      expect((settled as { config: { share?: unknown } }).config.share).toBeUndefined()
    }
    expect(loadSharedPublicationId(slug)).toBeUndefined()
  })

  test('bounds queued host confirmations across grants and local recovery at one shared limit', async () => {
    let prompts = 0
    let openGate!: () => void
    const gate = new Promise<void>(resolve => { openGate = resolve })
    const invoke = createHarness('unavailable', undefined, async () => { prompts++; await gate; return false })
    // Distinct publications, so nothing coalesces and each really holds a slot.
    const pages: Array<{ slug: string }> = []
    for (let i = 0; i < 32; i++) pages.push(await seedUnrevocablePublication(invoke, `Queue ${i}`, `publication-queue-${i}`))
    const overflow = await seedUnrevocablePublication(invoke, 'Queue overflow', 'publication-overflow')

    const inflight = pages.map(page => invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, page.slug, { forgetLocal: true })
      .then(() => 'approved', (error: unknown) => String(error)))
    await new Promise(resolve => setTimeout(resolve, 10))
    // The budget counts queued work, not open sheets: one prompt is on screen and
    // the other 31 are waiting behind it, and all 32 are charged.
    expect(prompts).toBe(1)
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, overflow.slug, { forgetLocal: true }))
      .rejects.toThrow('PAGE_GRANT_CONFIRMATION_QUEUE_FULL')
    // Refusing the 33rd must not consume a slot either, or the bound would decay.
    expect(prompts).toBe(1)

    openGate()
    const settled = await Promise.all(inflight)
    expect(settled).toHaveLength(32)
    expect(settled.every(outcome => outcome.includes('PAGE_FORGET_CONFIRMATION_CANCELLED'))).toBe(true)
    expect(prompts).toBe(32)
    // Every slot is released once the queue drains, so the 33rd now gets asked.
    await expect(invoke(RPC_CHANNELS.pages.UNPUBLISH, WORKSPACE_A, overflow.slug, { forgetLocal: true }))
      .rejects.toThrow('PAGE_FORGET_CONFIRMATION_CANCELLED')
    expect(prompts).toBe(33)
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

  test('keeps a grant binding when another workspace churns its lease store', async () => {
    // Lease state is per workspace, because there is one broker per workspace.
    // Workspace B filling and evicting its own store must not touch A's lease
    // or the grant binding that lease carries.
    const invoke = createHarness('approve')
    const pageA = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
      name: 'Workspace A leases', content: '<p>content</p>',
    }) as { slug: string }
    const { lease: firstLease } = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, pageA.slug) as { lease: { leaseId: string } }

    writeWorkspace(ROOT_B, WORKSPACE_B, true)
    const pageB = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_B, {
      name: 'Workspace B leases', content: '<p>content</p>',
    }) as { slug: string }
    const workspaceBContext = { clientId: 'trusted-client', workspaceId: WORKSPACE_B, webContentsId: 101 }
    // Past B's store cap, so B evicts repeatedly.
    for (let i = 0; i < MAX_LIVE_LEASES + 10; i++) {
      await invoke.invokeWithContext(workspaceBContext, RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_B, pageB.slug)
    }

    // A is untouched: it still mints, and its earlier lease still binds consent.
    await expect(invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, pageA.slug)).resolves.toBeDefined()
    await expect(invoke(RPC_CHANNELS.pages.REQUEST_GRANT, WORKSPACE_A, pageA.slug, {
      action: { kind: 'api', sourceSlug: 'example', method: 'GET', pathPattern: '/items' },
    }, firstLease.leaseId)).resolves.toBeTruthy()
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


  /**
   * SUV-0065 — runtime authority at the RPC boundary.
   *
   * The broker's own tests prove the checks; these prove the checks are
   * actually reachable through the channels a real caller uses, and that the
   * host — not the caller — supplies the authority they are made against.
   */
  describe('page action runtime authority', () => {
    /** A page with an approved mutating script grant, ready to be invoked. */
    async function seedScriptGrant(invoke: GrantHarness) {
      const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
        name: 'Runtime page', content: '<p>runtime</p>',
      }) as { slug: string }
      writeFileSync(join(ROOT_A, 'runner.ts'), 'console.log("ran")')
      const lease = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as {
        lease: { leaseId: string; nonce: string }
      }
      const grant = await invoke(
        RPC_CHANNELS.pages.REQUEST_GRANT,
        WORKSPACE_A,
        page.slug,
        { action: { kind: 'script', script: 'runner.ts', runtime: 'bun' } },
        lease.lease.leaseId,
      ) as { id: string } | null
      return { page, lease: lease.lease, grant }
    }

    const requestFor = (
      page: { slug: string },
      lease: { leaseId: string; nonce: string },
      grant: { id: string },
      requestId = `req_${Math.random().toString(36).slice(2)}`,
    ) => ({
      requestId,
      pageSlug: page.slug,
      leaseId: lease.leaseId,
      nonce: lease.nonce,
      grantId: grant.id,
      invocation: { kind: 'script' as const },
    })

    test('refuses a mutating action that arrives over transport RPC with no activation', async () => {
      const invoke = createHarness('approve')
      const { page, lease, grant } = await seedScriptGrant(invoke)
      expect(grant).not.toBeNull()

      // This is the bypass ADR-0033 exists for: a token-holding client calling
      // executeAction directly, holding a real lease, nonce, and approved
      // grant. Everything it can assert, it has. It still cannot run, because
      // the one credential it needs is minted somewhere it cannot reach.
      const result = await invoke.invokeTransportWithContext(
        { workspaceId: WORKSPACE_A, clientId: 'hostile-client', webContentsId: undefined } as never,
        RPC_CHANNELS.pages.EXECUTE_ACTION,
        WORKSPACE_A,
        requestFor(page, lease, grant!),
      ) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('activation-required')
    })

    test('shape-guards the wire payload instead of throwing', async () => {
      const invoke = createHarness('approve')
      const { page, lease } = await seedScriptGrant(invoke)

      // An API grant, so a malformed api invocation matches on kind and method
      // and actually reaches the path helpers. Against a script grant the kind
      // mismatch answers first and the reported throw is never provoked — a
      // detail that made an earlier version of this test pass with the defect
      // still in place.
      const { addPageGrant, loadPageConfig } = await import('@craft-agent/shared/pages')
      const apiGrant = addPageGrant(ROOT_A, page.slug, {
        action: { kind: 'api', sourceSlug: 'github', method: 'GET', pathPattern: '/repos/.*' },
        expectedContentDigest: loadPageConfig(ROOT_A, page.slug)!.contentDigest!,
      })
      const apiRequest = (invocation: unknown) => ({
        requestId: `req_${Math.random().toString(36).slice(2)}`,
        pageSlug: page.slug,
        leaseId: lease.leaseId,
        nonce: lease.nonce,
        grantId: apiGrant.id,
        invocation,
      })
      for (const badPath of [42, { toString: 'no' }, ['/x'], null, true]) {
        const result = await invoke(
          RPC_CHANNELS.pages.EXECUTE_ACTION,
          WORKSPACE_A,
          apiRequest({ kind: 'api', method: 'GET', path: badPath }),
        ) as { ok: boolean; error?: string }
        expect(result.ok).toBe(false)
        expect(result.error).toContain('malformed-request')
      }

      // This channel is reachable by any transport client, so its argument is
      // untrusted input regardless of what the handler signature claims. A
      // throw would surface as a transport error the page cannot handle AND
      // leave no audit row, so probing the endpoint's shape would be invisible.
      for (const hostile of [
        undefined, null, 'string', 42, [], {},
        { requestId: 'r' },
        { requestId: 'r', leaseId: 'l', nonce: 'n' },
        { requestId: 'r', leaseId: 'l', nonce: 'n', grantId: 'g' },
        { requestId: 'r', leaseId: 'l', nonce: 'n', grantId: 'g', pageSlug: 'dash' },
        { requestId: 'r', leaseId: 'l', nonce: 'n', grantId: 'g', pageSlug: 'dash', invocation: 'nope' },
        // The discriminant alone is not the shape. Each of these would have
        // reached a string helper inside validation and thrown there, outside
        // this handler's guard.
        { requestId: 'r', leaseId: 'l', nonce: 'n', grantId: 'g', pageSlug: 'dash', invocation: { kind: 'api', method: 'GET', path: 42 } },
        { requestId: 'r', leaseId: 'l', nonce: 'n', grantId: 'g', pageSlug: 'dash', invocation: { kind: 'api', method: 'GET', path: { toString: 'no' } } },
        { requestId: 'r', leaseId: 'l', nonce: 'n', grantId: 'g', pageSlug: 'dash', invocation: { kind: 'api', method: 'TRACE', path: '/x' } },
        { requestId: 'r', leaseId: 'l', nonce: 'n', grantId: 'g', pageSlug: 'dash', invocation: { kind: 'api', method: 'GET', path: '/x', params: 'nope' } },
        { requestId: 'r', leaseId: 'l', nonce: 'n', grantId: 'g', pageSlug: 'dash', invocation: { kind: 'mcp', toolName: 7 } },
        { requestId: 'r', leaseId: 'l', nonce: 'n', grantId: 'g', pageSlug: 'dash', invocation: { kind: 'mcp', toolName: 't', args: [1, 2] } },
        { requestId: 'r', leaseId: 'l', nonce: 'n', grantId: 'g', pageSlug: 'dash', invocation: { kind: 'session' } },
        { requestId: 'x'.repeat(500), leaseId: 'l', nonce: 'n', grantId: 'g', pageSlug: 'dash', invocation: { kind: 'api' } },
      ]) {
        const result = await invoke(RPC_CHANNELS.pages.EXECUTE_ACTION, WORKSPACE_A, hostile) as {
          ok: boolean; error?: string
        }
        expect(result.ok).toBe(false)
        expect(result.error).toContain('malformed-request')
      }

      await new Promise((resolve) => setTimeout(resolve, 20))
      const audit = readFileSync(AUDIT_LOG, 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
      const malformed = audit.filter((entry) => entry.code === 'malformed-request')
      expect(malformed.length).toBeGreaterThan(0)
      // Metadata only — nothing from the payload, which by definition has not
      // been validated and may be anything at all.
      expect(malformed[0]?.origin).toBe('sandboxed-page')
      expect(malformed[0]?.workspaceId).toBe(WORKSPACE_A)
      expect(malformed[0]?.invocation).toBeUndefined()
    })

    test('does not treat a page that no longer exists as a crash', async () => {
      const invoke = createHarness('approve')
      const { page, lease, grant } = await seedScriptGrant(invoke)
      await invoke(RPC_CHANNELS.pages.DELETE, WORKSPACE_A, page.slug)

      const result = await invoke(
        RPC_CHANNELS.pages.EXECUTE_ACTION,
        WORKSPACE_A,
        requestFor(page, lease, grant!),
      ) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('malformed-request')
    })

    test('refuses a forged activation ticket', async () => {
      const invoke = createHarness('approve')
      const { page, lease, grant } = await seedScriptGrant(invoke)
      const result = await invoke(
        RPC_CHANNELS.pages.EXECUTE_ACTION,
        WORKSPACE_A,
        { ...requestFor(page, lease, grant!), activationTicket: 'f'.repeat(48) },
      ) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('activation-invalid')
    })

    test('mints through the host path and executes exactly once', async () => {
      const invoke = createHarness('approve')
      const { page, lease, grant } = await seedScriptGrant(invoke)
      const request = requestFor(page, lease, grant!)

      const ticket = await invoke.requestActivationAsHost(101, WORKSPACE_A, page.slug, request)
      expect(ticket.ticketId).toBeTruthy()
      // First use of a script grant on this render asked the user.
      expect(invoke.actionConfirmations).toHaveLength(1)

      const activated = { ...request, activationTicket: ticket.ticketId }
      const first = await invoke(RPC_CHANNELS.pages.EXECUTE_ACTION, WORKSPACE_A, activated) as { ok: boolean }
      expect(first.ok).toBe(true)

      // Re-sending the identical authorized call is both a replay and a spent
      // ticket, and either one alone is enough to refuse it.
      const replay = await invoke(RPC_CHANNELS.pages.EXECUTE_ACTION, WORKSPACE_A, activated) as { ok: boolean; error?: string }
      expect(replay.ok).toBe(false)
    })

    test('will not mint for a window that is not showing the workspace', async () => {
      const invoke = createHarness('approve')
      const { page, lease, grant } = await seedScriptGrant(invoke)
      // Window 404 exists but shows nothing this host knows about.
      await expect(
        invoke.requestActivationAsHost(404, WORKSPACE_A, page.slug, requestFor(page, lease, grant!)),
      ).rejects.toThrow('PAGE_ACTIVATION_TRUSTED_CONTEXT_REQUIRED')
    })

    test('will not mint from a malformed request', async () => {
      const invoke = createHarness('approve')
      const { page } = await seedScriptGrant(invoke)
      for (const hostile of [null, 'string', 42, {}, { requestId: 'r' }, { requestId: 'r', leaseId: 'l', nonce: 'n', grantId: 'g' }]) {
        await expect(invoke.requestActivationAsHost(101, WORKSPACE_A, page.slug, hostile))
          .rejects.toThrow('PAGE_ACTIVATION_INVALID_REQUEST')
      }
    })

    test('refuses a mutating action while the workspace is in Explore', async () => {
      const invoke = createHarness('approve')
      const { page, lease, grant } = await seedScriptGrant(invoke)

      // The mode is re-read per invocation, so switching it takes effect on the
      // next action rather than the next mount.
      writeWorkspace(ROOT_A, WORKSPACE_A, true, WORKSPACE_A, 'safe')
      await expect(
        invoke.requestActivationAsHost(101, WORKSPACE_A, page.slug, requestFor(page, lease, grant!)),
      ).rejects.toThrow('permission-mode-forbidden')
    })

    test('requires the lease and its nonce to cancel', async () => {
      const invoke = createHarness('approve')
      const { lease } = await seedScriptGrant(invoke)
      // A request id alone is a caller-minted string. Without the lease secret
      // a cancel is refused outright, whatever id it names.
      await expect(invoke(RPC_CHANNELS.pages.CANCEL_ACTION, WORKSPACE_A, 'req_x')).resolves.toBe(false)
      await expect(invoke(RPC_CHANNELS.pages.CANCEL_ACTION, WORKSPACE_A, 'req_x', lease.leaseId, 'wrong-nonce'))
        .resolves.toBe(false)
    })


    /**
     * The first-use sheet is real host chrome on the user's window, and host
     * chrome is drained serially. Refusing to USE a dead render's answer is
     * only half the job: an un-closable sheet stalls every other Page and
     * workspace behind it until the timeout.
     */
    describe('first-use confirmation lifecycle', () => {
      async function pendingConfirmation() {
        const invoke = createHarness('pending')
        const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
          name: 'Sheet page', content: '<p>sheet</p>',
        }) as { slug: string }
        writeFileSync(join(ROOT_A, 'runner.ts'), 'console.log("ran")')
        const lease = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, page.slug) as {
          lease: { leaseId: string; nonce: string }
        }
        // Seed an approved grant without going through the pending sheet.
        const { addPageGrant, loadPageConfig } = await import('@craft-agent/shared/pages')
        const grant = addPageGrant(ROOT_A, page.slug, {
          action: { kind: 'script', script: 'runner.ts', runtime: 'bun' },
          expectedContentDigest: loadPageConfig(ROOT_A, page.slug)!.contentDigest!,
        })
        const request = {
          requestId: 'req_sheet',
          pageSlug: page.slug,
          leaseId: lease.lease.leaseId,
          nonce: lease.lease.nonce,
          grantId: grant.id,
          invocation: { kind: 'script' as const },
        }
        const minting = invoke.requestActivationAsHost(101, WORKSPACE_A, page.slug, request)
          .then(() => 'minted' as const, (error: Error) => error.message)
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(invoke.actionConfirmations).toHaveLength(1)
        return { invoke, page, lease: lease.lease, minting }
      }

      test('releasing the lease closes the open sheet and mints nothing', async () => {
        const { invoke, lease, minting } = await pendingConfirmation()

        await invoke(RPC_CHANNELS.pages.RELEASE_LEASE, WORKSPACE_A, lease.leaseId)

        // Not merely outlived — closed. Without the sheet being registered for
        // abort this would sit until the confirmation timeout instead.
        expect(await minting).toContain('PAGE_ACTIVATION')
      })

      test('replacing the render closes the open sheet and mints nothing', async () => {
        const { invoke, minting } = await pendingConfirmation()

        // A reload keeps the webContents id and the workspace, so only the
        // render generation distinguishes the document that opened this sheet
        // from the one that replaced it.
        invoke.replaceRenderer(101)

        expect(await minting).toContain('PAGE_ACTIVATION')
      })

      test('a closed sheet unblocks the next one instead of holding the queue', async () => {
        const { invoke, lease, minting } = await pendingConfirmation()
        await invoke(RPC_CHANNELS.pages.RELEASE_LEASE, WORKSPACE_A, lease.leaseId)
        await minting

        // The serially-drained queue moved on: a second Page can open its own
        // sheet rather than waiting behind a prompt nobody can answer.
        const second = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
          name: 'Second page', content: '<p>second</p>',
        }) as { slug: string }
        const secondLease = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, WORKSPACE_A, second.slug) as {
          lease: { leaseId: string; nonce: string }
        }
        const { addPageGrant, loadPageConfig } = await import('@craft-agent/shared/pages')
        const grant = addPageGrant(ROOT_A, second.slug, {
          action: { kind: 'script', script: 'runner.ts', runtime: 'bun' },
          expectedContentDigest: loadPageConfig(ROOT_A, second.slug)!.contentDigest!,
        })
        void invoke.requestActivationAsHost(101, WORKSPACE_A, second.slug, {
          requestId: 'req_second',
          pageSlug: second.slug,
          leaseId: secondLease.lease.leaseId,
          nonce: secondLease.lease.nonce,
          grantId: grant.id,
          invocation: { kind: 'script' as const },
        }).catch(() => {})
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(invoke.actionConfirmations).toHaveLength(2)
        expect(invoke.actionConfirmations[1]?.pageSlug).toBe(second.slug)
      })
    })

    test('resolves a workspace alias to the same broker and lease store', async () => {
      // `workspaceId` on these channels is a name-or-id lookup key. Brokers are
      // cached per rootPath, so an alias and an id reach the same instance —
      // this pins that, which is what a caller observes.
      //
      // It does NOT cover the related fix in the same commit: the broker's
      // audit SCOPE is fixed at construction from whoever called first, so
      // passing a raw alias there would scope every later row for that
      // workspace. That is not observable from this layer — the scope appears
      // only as a throttle key, never in a row — and the property it protects
      // (one workspace cannot suppress another's rows) is covered by the
      // cross-workspace test in `action-bridge.test.ts`. Said plainly rather
      // than left to look like coverage this test does not provide.
      //
      // The fixture normally names a workspace after its own id, leaving no
      // distinct alias; give this one a display name. The per-test
      // `registerTestWorkspaces()` restores the default.
      writeWorkspace(ROOT_A, WORKSPACE_A, true, 'Pages Enabled Alias')
      const invoke = createHarness('approve')
      const page = await invoke(RPC_CHANNELS.pages.CREATE, WORKSPACE_A, {
        name: 'Alias page', content: '<p>alias</p>',
      }) as { slug: string }

      // Mint under the NAME.
      const byName = await invoke(RPC_CHANNELS.pages.CREATE_LEASE, 'Pages Enabled Alias', page.slug) as {
        lease: { leaseId: string; nonce: string }
      }

      // Spend it under the ID. Reaching `grant-not-found` proves both calls hit
      // the same broker: a separate one would not know this lease at all and
      // would answer `lease-not-found`.
      const result = await invoke(RPC_CHANNELS.pages.EXECUTE_ACTION, WORKSPACE_A, {
        requestId: 'req_alias',
        pageSlug: page.slug,
        leaseId: byName.lease.leaseId,
        nonce: byName.lease.nonce,
        grantId: 'grant_missing',
        invocation: { kind: 'api', method: 'GET', path: '/items' },
      }) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('grant-not-found')
      expect(result.error).not.toContain('lease-not-found')
    })

    test('refuses a malformed cancel instead of throwing', async () => {
      const invoke = createHarness('approve')
      const { lease } = await seedScriptGrant(invoke)

      // Every argument is caller-supplied and this channel needs no lease to
      // reach. Without a bounded-string check the broker would hand a non-string
      // to `createHash().update()` for the audit row, which throws — turning a
      // malformed cancel into a transport error and an unaudited crash.
      const hostile: unknown[] = [undefined, null, 42, {}, [], true, '', 'x'.repeat(5_000)]
      for (const value of hostile) {
        await expect(invoke(RPC_CHANNELS.pages.CANCEL_ACTION, WORKSPACE_A, value, lease.leaseId, lease.nonce))
          .resolves.toBe(false)
        await expect(invoke(RPC_CHANNELS.pages.CANCEL_ACTION, WORKSPACE_A, 'req_ok', value, lease.nonce))
          .resolves.toBe(false)
        await expect(invoke(RPC_CHANNELS.pages.CANCEL_ACTION, WORKSPACE_A, 'req_ok', lease.leaseId, value))
          .resolves.toBe(false)
      }
    })

    test('audits the execution with its origin, workspace, and permission mode', async () => {
      const invoke = createHarness('approve')
      const { page, lease, grant } = await seedScriptGrant(invoke)
      const request = requestFor(page, lease, grant!)
      const ticket = await invoke.requestActivationAsHost(101, WORKSPACE_A, page.slug, request)
      await invoke(RPC_CHANNELS.pages.EXECUTE_ACTION, WORKSPACE_A, { ...request, activationTicket: ticket.ticketId })

      await new Promise((resolve) => setTimeout(resolve, 20))
      const audit = readFileSync(AUDIT_LOG, 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
      const executed = audit.find((entry) => entry.event === 'page_action_executed')
      expect(executed?.origin).toBe('sandboxed-page')
      expect(executed?.workspaceId).toBe(WORKSPACE_A)
      expect(executed?.permissionMode).toBe('ask')
      expect(executed?.mutating).toBe(true)
      expect(executed?.actionKind).toBe('script')
    })
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
