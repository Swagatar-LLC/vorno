import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { assertPagesEnabled, isPagesEnabled } from '@craft-agent/shared/pages/capability'
import { pushTyped, type RequestContext, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps, PageGrantRequester } from '../handler-deps'
import { MAX_LIVE_LEASES, type PageActionRequest, type PageActionBroker, type PageActionExecutors } from '@craft-agent/shared/pages'
import { assertPageSourceUsable } from '../../pages/source-gate'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.pages.GET,
  RPC_CHANNELS.pages.GET_ONE,
  RPC_CHANNELS.pages.CREATE,
  RPC_CHANNELS.pages.UPDATE,
  RPC_CHANNELS.pages.DELETE,
  RPC_CHANNELS.pages.GET_CONTENT,
  RPC_CHANNELS.pages.SET_CONTENT,
  RPC_CHANNELS.pages.GET_DATA,
  RPC_CHANNELS.pages.LIST_GRANTS,
  RPC_CHANNELS.pages.REQUEST_GRANT,
  RPC_CHANNELS.pages.ISSUE_GRANT,
  RPC_CHANNELS.pages.REVOKE_GRANT,
  RPC_CHANNELS.pages.CREATE_LEASE,
  RPC_CHANNELS.pages.RELEASE_LEASE,
  RPC_CHANNELS.pages.EXECUTE_ACTION,
  RPC_CHANNELS.pages.CANCEL_ACTION,
  RPC_CHANNELS.pages.GET_SHARE_CAPABILITIES,
  RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN,
  RPC_CHANNELS.pages.PUBLISH,
  RPC_CHANNELS.pages.SET_PUBLICATION_PASSWORD,
  RPC_CHANNELS.pages.UNPUBLISH,
  RPC_CHANNELS.pages.GET_THUMBNAIL,
  RPC_CHANNELS.pages.REGENERATE_THUMBNAIL,
] as const

/** Cap on action response bodies returned to the renderer */
const ACTION_BODY_MAX_CHARS = 512 * 1024
/** An unanswered prompt must not leave a request hanging or mint a grant later. */
const PAGE_GRANT_CONFIRM_TIMEOUT_MS = 30_000
const PAGE_GRANT_MESSAGE_MAX_CHARS = 200
const PAGE_GRANT_IDENTITY_MAX_CHARS = 100
/** Bound queued consent work while an OS-native modal serializes requests. */
const MAX_PENDING_PAGE_GRANT_CONFIRMATIONS = 32

/** Keep page-authored prose visibly distinct from host-rendered identity/action. */
function sanitizePageGrantMessage(description: string | undefined): string | undefined {
  if (!description) return undefined
  return description.replace(/[\r\n]+/g, ' ').trim().slice(0, PAGE_GRANT_MESSAGE_MAX_CHARS)
}

/**
 * Names are server-resolved but still user-authored configuration. Collapse
 * controls/whitespace and bound them before handing text to native chrome so a
 * name cannot forge a second dialog field or bury the actual action.
 */
function sanitizePageGrantIdentity(value: string, fallback: string): string {
  const normalized = value.replace(/[\s\u0000-\u001F\u007F-\u009F]+/g, ' ').trim()
  return normalized.slice(0, PAGE_GRANT_IDENTITY_MAX_CHARS) || fallback
}

export function registerPagesHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger
  const assertAvailable = (workspaceRootPath: string | undefined) => assertPagesEnabled(workspaceRootPath)

  // One broker per workspace: render leases and in-flight actions are
  // in-memory state scoped to the hosting process.
  const brokers = new Map<string, PageActionBroker>()

  // One MCP client pool per workspace, shared by all of its pages and
  // independent of session pools. Clients live until the process exits
  // (same lifetime as the brokers above).
  const mcpPools = new Map<string, import('@craft-agent/shared/mcp').McpClientPool>()
  // Coalesce exact outstanding consent requests. The content digest belongs in
  // the key: a changed page must receive a fresh confirmation, never stale work.
  const pendingGrantRequests = new Map<string, Promise<import('@craft-agent/shared/pages').PageActionGrant | null>>()
  // A rendered Page may own one host confirmation at a time. The renderer
  // serializes its descriptors; this remains authoritative for direct RPC.
  const pendingGrantLeases = new Map<string, Promise<import('@craft-agent/shared/pages').PageActionGrant | null>>()
  // Server-only binding for grant-capable render leases. Do not put this in
  // PageRenderLease: the iframe receives that object and must never choose or
  // forge the Electron client/window authority behind its render.
  const leaseRequesters = new Map<string, {
    clientId: string
    webContentsId: number
    connectionId: string
    workspaceId: string
    pageSlug: string
    contentDigest: string
  }>()
  const grantConfirmationQueue: Array<() => Promise<void>> = []
  let drainingGrantConfirmationQueue = false

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { loadWorkspacePages } = await import('@craft-agent/shared/pages')
    const pages = loadWorkspacePages(workspaceRootPath)
    pushTyped(server, RPC_CHANNELS.pages.CHANGED, { to: 'workspace', workspaceId }, workspaceId, pages)
  }

  // Lifecycle audit is deliberately metadata-only: never record the descriptor,
  // source values, or user-supplied description alongside an approval decision.
  async function auditGrantDecision(event: 'page_grant_approved' | 'page_grant_rejected', workspaceId: string, pageSlug: string, actionKind: string): Promise<void> {
    const { appendPageActionAudit } = await import('@craft-agent/shared/pages')
    await appendPageActionAudit({ event, workspaceId, pageSlug, actionKind }, {
      onError: (error) => log.warn(`Failed to audit page grant decision: ${error}`),
    })
  }

  function isLeaseRequesterCurrent(
    leaseKey: string,
    ctx: RequestContext,
    workspaceId: string,
    pageSlug: string,
    contentDigest: string,
    requester: PageGrantRequester | undefined,
  ): requester is PageGrantRequester {
    const bound = leaseRequesters.get(leaseKey)
    return requester !== undefined &&
      bound?.clientId === ctx.clientId &&
      bound.webContentsId === requester.webContentsId &&
      bound.connectionId === requester.connectionId &&
      bound.workspaceId === workspaceId &&
      bound.pageSlug === pageSlug &&
      bound.contentDigest === contentDigest
  }

  function drainGrantConfirmationQueue(): void {
    if (drainingGrantConfirmationQueue) return
    drainingGrantConfirmationQueue = true
    void (async () => {
      try {
        while (grantConfirmationQueue.length > 0) {
          await grantConfirmationQueue.shift()!()
        }
      } finally {
        drainingGrantConfirmationQueue = false
      }
    })()
  }

  /**
   * API executor for the action bridge. Resolves the source + credential
   * lazily per call (same seams sessions use), so tokens refresh correctly
   * and never leave the host process.
   */
  function buildApiExecutor(workspaceRootPath: string): NonNullable<PageActionExecutors['executeApi']> {
    // One refresh manager per workspace executor so failed-refresh cooldowns
    // survive across calls instead of resetting on every action.
    let refreshManager: import('@craft-agent/shared/sources').TokenRefreshManager | undefined
    return async (invocation, { signal }) => {
      const {
        loadSource,
        getSourceCredentialManager,
        getSourceServerBuilder,
        isApiOAuthProvider,
        hasRenewEndpoint,
        TokenRefreshManager,
        createTokenGetter,
        executeApiRequest,
      } = await import('@craft-agent/shared/sources')

      const source = loadSource(workspaceRootPath, invocation.sourceSlug)
      if (!source || source.config.type !== 'api') {
        throw new Error(`API source not found: ${invocation.sourceSlug}`)
      }
      // Fail fast with the stable source-auth-required error instead of
      // letting the request die on a 401 or a refresh timeout downstream.
      assertPageSourceUsable(source)

      const credManager = getSourceCredentialManager()
      const apiConfig = getSourceServerBuilder().buildApiConfig(source)

      // Credential resolution mirrors SessionManager.buildServersFromSources:
      // refreshable sources get a TokenRefreshManager-backed getter, plain
      // API sources read the vault per request, 'none' uses no credential.
      let credentialSource: import('@craft-agent/shared/sources').ApiCredentialSource
      if (isApiOAuthProvider(source.config.provider) || source.config.api?.authType === 'oauth' || hasRenewEndpoint(source)) {
        refreshManager ??= new TokenRefreshManager(credManager, { log: (msg: string) => log.info(msg) })
        credentialSource = createTokenGetter(refreshManager, source)
      } else if (source.config.api?.authType === 'none' || !source.config.api?.authType) {
        credentialSource = ''
      } else {
        credentialSource = async () => credManager.getApiCredential(source)
      }

      let outcome: Awaited<ReturnType<typeof executeApiRequest>>
      try {
        outcome = await executeApiRequest(
          apiConfig,
          credentialSource,
          { path: invocation.path, method: invocation.method, params: invocation.params },
          { signal },
        )
      } catch (err) {
        // A failed token refresh inside the request marks the source
        // needs_auth — reload and surface the stable auth error so this
        // very call already tells the page (and matches the banner).
        const fresh = loadSource(workspaceRootPath, invocation.sourceSlug)
        if (fresh) assertPageSourceUsable(fresh)
        throw err
      }

      // Shape the body for the renderer: parse JSON when it is JSON, cap size.
      let text = outcome.buffer.toString('utf-8')
      const truncated = text.length > ACTION_BODY_MAX_CHARS
      if (truncated) {
        text = `${text.slice(0, ACTION_BODY_MAX_CHARS)}…[truncated]`
      }
      let body: unknown = text
      if (!truncated && outcome.contentType?.toLowerCase().includes('json')) {
        try { body = JSON.parse(text) } catch { /* leave as text */ }
      }
      return { status: outcome.status, ok: outcome.ok, body }
    }
  }

  async function getBroker(workspaceId: string, workspaceRootPath: string): Promise<PageActionBroker> {
    assertAvailable(workspaceRootPath)
    const existing = brokers.get(workspaceRootPath)
    if (existing) return existing

    const { PageActionBroker } = await import('@craft-agent/shared/pages')
    const { loadWorkspaceSources } = await import('@craft-agent/shared/sources')

    let activeSourceSlugs: string[] = []
    try {
      activeSourceSlugs = loadWorkspaceSources(workspaceRootPath).map((source) => source.config.slug)
    } catch {
      // Policy annotation degrades gracefully without per-source permissions
    }

    const { McpClientPool } = await import('@craft-agent/shared/mcp')
    const { createPagesMcpExecutor } = await import('../../pages/mcp-executor')
    const { createPagesScriptExecutor } = await import('../../pages/script-executor-bridge')
    let mcpPool = mcpPools.get(workspaceRootPath)
    if (!mcpPool) {
      mcpPool = new McpClientPool({
        debug: (msg) => log.debug(`[pages] ${msg}`),
        workspaceRootPath,
      })
      mcpPools.set(workspaceRootPath, mcpPool)
    }

    const broker = new PageActionBroker({
      executors: {
        executeApi: buildApiExecutor(workspaceRootPath),
        executeMcp: createPagesMcpExecutor({ workspaceRootPath, pool: mcpPool, log }),
        executeScript: createPagesScriptExecutor({ workspaceRootPath, log }),
      },
      permissionsContext: { workspaceRootPath, activeSourceSlugs },
    })
    brokers.set(workspaceRootPath, broker)
    log.info(`Created page action broker for workspace ${workspaceId}`)
    return broker
  }

  // List all pages for a workspace
  server.handle(RPC_CHANNELS.pages.GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`PAGES_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    assertAvailable(workspace.rootPath)
    const { loadWorkspacePages } = await import('@craft-agent/shared/pages')
    return loadWorkspacePages(workspace.rootPath)
  })

  // Get one page (by slug or id)
  server.handle(RPC_CHANNELS.pages.GET_ONE, async (_ctx, workspaceId: string, pageIdOrSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    assertAvailable(workspace.rootPath)
    const { loadPage, loadPageById } = await import('@craft-agent/shared/pages')
    return loadPage(workspace.rootPath, pageIdOrSlug)
      ?? loadPageById(workspace.rootPath, pageIdOrSlug)
  })

  // Create a new page
  server.handle(RPC_CHANNELS.pages.CREATE, async (_ctx, workspaceId: string, input: import('@craft-agent/shared/pages').CreatePageInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const { createPage } = await import('@craft-agent/shared/pages')
    const page = createPage(workspace.rootPath, {
      name: input.name?.trim() || 'New Page',
      description: input.description,
      kind: input.kind,
      projectId: input.projectId,
      content: input.content,
    })
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `pages/${page.slug}/page.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    // A page created with inline content gets a poster; empty pages wait for content.
    if (input.content !== undefined) {
      deps.sessionManager.enqueuePageThumbnail(workspaceId, workspace.rootPath, page.slug)
    }
    log.info(`Created page: ${page.slug}`)
    return page
  })

  // Update page metadata/refresh spec (managed fields excluded). Slug stays stable.
  server.handle(RPC_CHANNELS.pages.UPDATE, async (
    _ctx,
    workspaceId: string,
    pageSlug: string,
    patch: import('@craft-agent/shared/pages').UpdatePagePatch,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const { updatePage } = await import('@craft-agent/shared/pages')
    const updated = updatePage(workspace.rootPath, pageSlug, patch)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `pages/${pageSlug}/page.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Delete a page (content, data, and grants go with the folder). A published
  // page is unpublished first (best effort) so the public copy does not
  // silently outlive the local page — deletePageWithUnpublish is shared
  // verbatim with the delete_page session tool.
  server.handle(RPC_CHANNELS.pages.DELETE, async (_ctx, workspaceId: string, pageSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { deletePageWithUnpublish } = await import('@craft-agent/shared/pages')
    const { publicCopyMayRemain } = await deletePageWithUnpublish(workspace.rootPath, workspace.id, pageSlug, {
      log: (message: string) => log.warn(message),
    })
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `pages/${pageSlug}/page.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Deleted page ${pageSlug}`)
    return { publicCopyMayRemain }
  })

  // Read page content (for editing/inspection — rendering should use CREATE_LEASE)
  server.handle(RPC_CHANNELS.pages.GET_CONTENT, async (_ctx, workspaceId: string, pageSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return { content: null }
    assertAvailable(workspace.rootPath)
    const { loadPageContent, loadPageConfig } = await import('@craft-agent/shared/pages')
    return {
      content: loadPageContent(workspace.rootPath, pageSlug),
      contentDigest: loadPageConfig(workspace.rootPath, pageSlug)?.contentDigest,
    }
  })

  // Write page content (updates contentDigest; existing grants go stale by design)
  server.handle(RPC_CHANNELS.pages.SET_CONTENT, async (_ctx, workspaceId: string, pageSlug: string, content: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const { savePageContent } = await import('@craft-agent/shared/pages')
    const updated = savePageContent(workspace.rootPath, pageSlug, content)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `pages/${pageSlug}/page.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    deps.sessionManager.enqueuePageThumbnail(workspaceId, workspace.rootPath, pageSlug)
    return updated
  })

  // Read the page's data snapshot (cross-process contract written by refresh scripts)
  server.handle(RPC_CHANNELS.pages.GET_DATA, async (_ctx, workspaceId: string, pageSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    assertAvailable(workspace.rootPath)
    const { readPageDataSnapshot } = await import('@craft-agent/shared/pages')
    return readPageDataSnapshot(workspace.rootPath, pageSlug)
  })

  // List persisted grants (validity — digest/expiry — is enforced at execution time)
  server.handle(RPC_CHANNELS.pages.LIST_GRANTS, async (_ctx, workspaceId: string, pageSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    assertAvailable(workspace.rootPath)
    const { loadPageConfig } = await import('@craft-agent/shared/pages')
    return loadPageConfig(workspace.rootPath, pageSlug)?.grants ?? []
  })

  // Additive, host-authoritative grant issuance. Only a server-verified local
  // Electron window may request native consent; token and remote clients cannot
  // select a workspace or surface a trusted approval prompt.
  server.handle(RPC_CHANNELS.pages.REQUEST_GRANT, async (
    ctx,
    workspaceId: string,
    pageSlug: string,
    input: unknown,
    leaseId: unknown,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const requester = deps.getPageGrantRequester?.(ctx, workspace.id)
    if (!requester) throw new Error('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')
    if (typeof leaseId !== 'string' || leaseId.length === 0) throw new Error('PAGE_GRANT_RENDER_LEASE_REQUIRED')

    // Treat every transport request as hostile. In particular, do not inspect
    // `kind` until the existing discriminated-union schema has accepted it.
    const { AddPageGrantInputSchema, loadPageConfig, addPageGrant } = await import('@craft-agent/shared/pages')
    const parsed = AddPageGrantInputSchema.safeParse(input)
    if (!parsed.success) {
      await auditGrantDecision('page_grant_rejected', workspaceId, pageSlug, 'invalid')
      throw new Error('PAGE_GRANT_INVALID_REQUEST')
    }
    const request = parsed.data
    const pageAtRequest = loadPageConfig(workspace.rootPath, pageSlug)
    const expectedContentDigest = pageAtRequest?.contentDigest
    if (!pageAtRequest || !expectedContentDigest) {
      throw new Error(`Page "${pageSlug}" has no content yet, so access can't be approved.`)
    }
    const broker = await getBroker(workspaceId, workspace.rootPath)
    const leaseKey = `${workspace.rootPath}\u0000${leaseId}`
    // A Page may unmount between bridge dispatch and this async handler. It
    // owns no surviving consent work, so quietly decline without host chrome.
    if (!broker.hasActiveLease(leaseId, pageSlug, expectedContentDigest)) {
      leaseRequesters.delete(leaseKey)
      return null
    }

    // The digest is part of identity: changed content starts a new request
    // instead of coalescing behind a stale confirmation.
    const pendingKey = JSON.stringify({ workspaceId, pageSlug, leaseId, contentDigest: expectedContentDigest, action: request.action })
    const pending = pendingGrantRequests.get(pendingKey)
    if (pending) return pending
    const pendingLeaseKey = leaseKey
    // A grant-capable lease belongs to the exact requester that created it.
    // Re-resolving the original ctx alone is insufficient: a window can
    // disconnect, crash, or be rebound while native chrome is awaiting input.
    if (!isLeaseRequesterCurrent(
      pendingLeaseKey, ctx, workspace.id, pageSlug, expectedContentDigest, requester,
    )) throw new Error('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')
    if (pendingGrantLeases.has(pendingLeaseKey)) throw new Error('PAGE_GRANT_CONFIRMATION_ALREADY_PENDING')
    if (pendingGrantRequests.size >= MAX_PENDING_PAGE_GRANT_CONFIRMATIONS) {
      throw new Error('PAGE_GRANT_CONFIRMATION_QUEUE_FULL')
    }

    let resolveIssue!: (value: import('@craft-agent/shared/pages').PageActionGrant | null) => void
    let rejectIssue!: (reason?: unknown) => void
    const issue = new Promise<import('@craft-agent/shared/pages').PageActionGrant | null>((resolve, reject) => {
      resolveIssue = resolve
      rejectIssue = reject
    })
    pendingGrantRequests.set(pendingKey, issue)
    pendingGrantLeases.set(pendingLeaseKey, issue)
    grantConfirmationQueue.push(async () => {
      try {
        // Do not show an obsolete request that waited behind another native
        // prompt. A request from the new digest is separately queued above.
        const page = loadPageConfig(workspace.rootPath, pageSlug)
        if (!page || page.contentDigest !== expectedContentDigest) {
          await auditGrantDecision('page_grant_rejected', workspaceId, pageSlug, request.action.kind)
          throw new Error('PAGE_GRANT_CONTENT_CHANGED')
        }
        if (!broker.hasActiveLease(leaseId, pageSlug, expectedContentDigest)) {
          await auditGrantDecision('page_grant_rejected', workspaceId, pageSlug, request.action.kind)
          resolveIssue(null)
          return
        }
        if (!deps.confirmPageGrant) {
          await auditGrantDecision('page_grant_rejected', workspaceId, pageSlug, request.action.kind)
          throw new Error('PAGE_GRANT_TRUSTED_CONFIRMATION_UNAVAILABLE')
        }
        // The request may have waited behind another native prompt; re-check
        // the server-held window/workspace binding before showing this one.
        const currentRequester = deps.getPageGrantRequester?.(ctx, workspace.id)
        if (!isLeaseRequesterCurrent(
          pendingLeaseKey, ctx, workspace.id, pageSlug, expectedContentDigest, currentRequester,
        )) throw new Error('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')

        let accepted = false
        try {
          const confirmation = deps.confirmPageGrant(currentRequester, {
            workspace: {
              id: workspace.id,
              name: sanitizePageGrantIdentity(workspace.name, 'Unnamed workspace'),
            },
            page: {
              slug: page.slug,
              name: sanitizePageGrantIdentity(page.name, 'Unnamed page'),
            },
            action: request.action,
            pageMessage: sanitizePageGrantMessage(request.description),
          })
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const timeout = new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('confirmation timed out')), deps.pageGrantConfirmationTimeoutMs ?? PAGE_GRANT_CONFIRM_TIMEOUT_MS)
            })
            accepted = await Promise.race([confirmation, timeout])
          } finally {
            if (timer) clearTimeout(timer)
          }
        } catch (error) {
          log.info(`Page grant confirmation unavailable for ${pageSlug}: ${error instanceof Error ? error.message : String(error)}`)
        }

        if (!accepted) {
          await auditGrantDecision('page_grant_rejected', workspaceId, pageSlug, request.action.kind)
          resolveIssue(null)
          return
        }

        // A native dialog cannot be dismissed programmatically, so re-check
        // after its response: an unmounted Page must never receive a grant.
        if (!broker.hasActiveLease(leaseId, pageSlug, expectedContentDigest)) {
          await auditGrantDecision('page_grant_rejected', workspaceId, pageSlug, request.action.kind)
          resolveIssue(null)
          return
        }
        // The user may have approved after the Electron renderer disconnected,
        // crashed, or rebound. Persist only if its original server-held
        // client/window/workspace/lease/digest binding remains live.
        const requesterAfterConfirmation = deps.getPageGrantRequester?.(ctx, workspace.id)
        if (!isLeaseRequesterCurrent(
          pendingLeaseKey, ctx, workspace.id, pageSlug, expectedContentDigest, requesterAfterConfirmation,
        )) {
          await auditGrantDecision('page_grant_rejected', workspaceId, pageSlug, request.action.kind)
          resolveIssue(null)
          return
        }
        const grant = addPageGrant(workspace.rootPath, pageSlug, { ...request, expectedContentDigest })
        deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `pages/${pageSlug}/page.json`)
        await broadcastChanged(workspaceId, workspace.rootPath)
        await auditGrantDecision('page_grant_approved', workspaceId, pageSlug, grant.action.kind)
        log.info(`Approved page grant ${grant.id} on ${pageSlug} (${grant.action.kind})`)
        resolveIssue(grant)
      } catch (error) {
        rejectIssue(error)
      } finally {
        if (pendingGrantRequests.get(pendingKey) === issue) pendingGrantRequests.delete(pendingKey)
        if (pendingGrantLeases.get(pendingLeaseKey) === issue) pendingGrantLeases.delete(pendingLeaseKey)
      }
    })
    drainGrantConfirmationQueue()
    return issue
  })

  // ADR-0033's intentional wire divergence: direct RPC cannot mint grants.
  // It remains registered so old clients get a stable actionable refusal.
  server.handle(RPC_CHANNELS.pages.ISSUE_GRANT, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    throw new Error('PAGE_GRANT_HOST_CONSENT_REQUIRED: use pages:requestGrant')
  })

  // Revoke a grant
  server.handle(RPC_CHANNELS.pages.REVOKE_GRANT, async (_ctx, workspaceId: string, pageSlug: string, grantId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { revokePageGrant } = await import('@craft-agent/shared/pages')
    const removed = revokePageGrant(workspace.rootPath, pageSlug, grantId)
    if (removed) {
      deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `pages/${pageSlug}/page.json`)
      await broadcastChanged(workspaceId, workspace.rootPath)
      log.info(`Revoked page grant ${grantId} on ${pageSlug}`)
    }
    return removed
  })

  // Issue a render lease. Returns the lease AND the exact content it is bound
  // to — the renderer must render THIS content string (not a separately
  // fetched copy), closing the read/lease race.
  server.handle(RPC_CHANNELS.pages.CREATE_LEASE, async (ctx, workspaceId: string, pageSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const { loadPageContent, computePageContentDigest } = await import('@craft-agent/shared/pages')

    const content = loadPageContent(workspace.rootPath, pageSlug)
    if (content === null) throw new Error(`Page has no content: ${pageSlug}`)

    const broker = await getBroker(workspaceId, workspace.rootPath)
    const contentDigest = computePageContentDigest(content)
    const lease = broker.createLease({ pageSlug, contentDigest })
    const requester = deps.getPageGrantRequester?.(ctx, workspace.id)
    if (requester) {
      if (leaseRequesters.size >= MAX_LIVE_LEASES) {
        leaseRequesters.delete(leaseRequesters.keys().next().value!)
      }
      leaseRequesters.set(`${workspace.rootPath}\u0000${lease.leaseId}`, {
        clientId: ctx.clientId,
        webContentsId: requester.webContentsId,
        connectionId: requester.connectionId,
        workspaceId: workspace.id,
        pageSlug,
        contentDigest,
      })
    }
    return { lease, content }
  })

  // Release is privilege reduction and remains available after disabling
  // Pages. Never instantiate a broker just to release an absent lease.
  server.handle(RPC_CHANNELS.pages.RELEASE_LEASE, async (_ctx, workspaceId: string, leaseId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return
    brokers.get(workspace.rootPath)?.releaseLease(leaseId)
    leaseRequesters.delete(`${workspace.rootPath}\u0000${leaseId}`)
  })

  // Execute a granted source action. Page config is re-read from disk per
  // request so revocations and content changes apply immediately.
  server.handle(RPC_CHANNELS.pages.EXECUTE_ACTION, async (_ctx, workspaceId: string, request: PageActionRequest) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const { loadPageConfig } = await import('@craft-agent/shared/pages')

    const page = loadPageConfig(workspace.rootPath, request.pageSlug)
    if (!page) throw new Error(`Page not found: ${request.pageSlug}`)

    const broker = await getBroker(workspaceId, workspace.rootPath)
    return broker.executeAction(page, request)
  })

  // Cancellation is cleanup: it remains available after Pages is disabled and
  // never creates a broker when no productive action is in flight.
  server.handle(RPC_CHANNELS.pages.CANCEL_ACTION, async (_ctx, workspaceId: string, requestId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return false
    return brokers.get(workspace.rootPath)?.cancelAction(requestId) ?? false
  })

  // ------------------------------------------------------------------
  // Sharing (Cloudflare publication) — server-evaluated feature flag.
  // Publish/password are gated; unpublish never is, so disabling the flag
  // cannot strand a published page.
  // ------------------------------------------------------------------

  async function buildPublisher() {
    const { PagePublisher, createCredentialPagePublishTokenStore } = await import('@craft-agent/shared/pages')
    return new PagePublisher({
      tokenStore: createCredentialPagePublishTokenStore(),
      log: (msg: string) => log.info(msg),
    })
  }

  // Whether the renderer may offer publish/update UI (unpublish is always allowed)
  server.handle(RPC_CHANNELS.pages.GET_SHARE_CAPABILITIES, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    const { isPagesSharingAvailable } = await import('@craft-agent/shared/pages')
    const pagesEnabled = isPagesEnabled(workspace?.rootPath)
    return {
      pagesEnabled,
      sharingEnabled: pagesEnabled && workspace !== null && isPagesSharingAvailable(workspace.rootPath),
    }
  })

  // What would `includeData` publish, and does any of it look like a secret?
  // Best-effort warning input for the Share dialog — never blocks publishing.
  server.handle(RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN, async (_ctx, workspaceId: string, pageSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const { scanPageShareData } = await import('@craft-agent/shared/pages')
    return scanPageShareData(workspace.rootPath, pageSlug)
  })

  // Publish (create) or republish (upload a new revision) a page
  server.handle(RPC_CHANNELS.pages.PUBLISH, async (
    _ctx,
    workspaceId: string,
    pageSlug: string,
    options: { includeData: boolean; password?: string; viewOnlyAcknowledged?: boolean },
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const publisher = await buildPublisher()
    const updated = await publisher.publish(workspace.rootPath, workspace.id, pageSlug, {
      includeData: options.includeData === true,
      password: options.password,
      viewOnlyAcknowledged: options.viewOnlyAcknowledged,
    })
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `pages/${pageSlug}/page.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Set or clear the viewer password on an existing publication
  server.handle(RPC_CHANNELS.pages.SET_PUBLICATION_PASSWORD, async (
    _ctx,
    workspaceId: string,
    pageSlug: string,
    password: string | null,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const publisher = await buildPublisher()
    const updated = await publisher.setPassword(workspace.rootPath, workspace.id, pageSlug, password)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `pages/${pageSlug}/page.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Unpublish (revoke the public copy, clear the local pointer + vault token)
  server.handle(RPC_CHANNELS.pages.UNPUBLISH, async (_ctx, workspaceId: string, pageSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const publisher = await buildPublisher()
    const result = await publisher.unpublish(workspace.rootPath, workspace.id, pageSlug)
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `pages/${pageSlug}/page.json`)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return { config: result.config, warning: result.warning }
  })

  // ------------------------------------------------------------------
  // Thumbnails (cached poster). Generation is Electron-main-only; these
  // handlers serve the stored file and enqueue regeneration (a no-op on hosts
  // without an injected capturer).
  // ------------------------------------------------------------------

  // Read a page's poster as a data URL, but ONLY when it is fresh (the stored
  // digest matches the current content). Stale/missing → null → tile falls back.
  server.handle(RPC_CHANNELS.pages.GET_THUMBNAIL, async (_ctx, workspaceId: string, pageSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    assertAvailable(workspace.rootPath)
    const { loadPageConfig, getPageThumbnailPath, isThumbnailFresh } = await import('@craft-agent/shared/pages')
    const config = loadPageConfig(workspace.rootPath, pageSlug)
    if (!config || !isThumbnailFresh(config)) return null
    const path = getPageThumbnailPath(workspace.rootPath, pageSlug)
    const { readFileSync, existsSync } = await import('node:fs')
    if (!existsSync(path)) return null
    try {
      const b64 = readFileSync(path).toString('base64')
      return { dataUrl: `data:image/jpeg;base64,${b64}`, digest: config.contentDigest! }
    } catch {
      return null
    }
  })

  // Manually request a (re)capture (e.g. an agent/user "refresh preview").
  server.handle(RPC_CHANNELS.pages.REGENERATE_THUMBNAIL, async (_ctx, workspaceId: string, pageSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return false
    assertAvailable(workspace.rootPath)
    deps.sessionManager.enqueuePageThumbnail(workspaceId, workspace.rootPath, pageSlug)
    return true
  })
}
