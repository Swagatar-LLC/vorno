import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { assertPagesEnabled, isPagesEnabled } from '@craft-agent/shared/pages/capability'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps, PageGrantRequester } from '../handler-deps'
import { MAX_LIVE_LEASES, isBoundedPageActionId, pageActionDescriptorSignature, parsePageActionInvocation, type PageActionAuthority, type PageActionOrigin, type PageActionRequest, type PageActionBroker, type PageActionExecutors } from '@craft-agent/shared/pages'
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

/**
 * Parse the request an activation is being asked for.
 *
 * It crossed IPC from a renderer, so it is untrusted input that happens to
 * describe a privileged call. Only the fields the ticket binds are read, and
 * `pageSlug` is taken from the host's own argument rather than from the
 * payload: a renderer that could name the page in the body could ask for a
 * ticket against a page other than the one it is rendering.
 *
 * The invocation is passed through structurally and re-validated by the broker
 * against the grant. Duplicating the descriptor schema here would create a
 * second definition of a valid invocation, and the two would drift.
 */
function parsePageActionRequest(value: unknown, pageSlug?: string): PageActionRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  const bounded = isBoundedPageActionId
  if (!bounded(candidate.requestId) || !bounded(candidate.leaseId) || !bounded(candidate.nonce) || !bounded(candidate.grantId)) {
    return null
  }
  // The activation path is handed the page by the host and ignores the payload's
  // claim; the execute path has no such argument, so it reads the field and the
  // broker proves it against the lease. Both go through this one parser.
  const slug = pageSlug ?? (bounded(candidate.pageSlug) ? (candidate.pageSlug as string) : undefined)
  if (slug === undefined) return null
  // The WHOLE kind-specific shape, not just the discriminant. Casting after a
  // `kind` check admits an api invocation whose `path` is a number, and the
  // first `path.startsWith(...)` inside validation throws — outside this
  // handler's guard, so the caller would get an unaudited transport error
  // instead of the refusal this function exists to produce.
  const invocation = parsePageActionInvocation(candidate.invocation)
  if (!invocation) return null
  // Carried through, never minted here: a ticket is only ever valid if the
  // broker issued it, so an unparseable one simply fails redemption.
  const activationTicket = bounded(candidate.activationTicket) ? (candidate.activationTicket as string) : undefined
  return {
    requestId: candidate.requestId as string,
    pageSlug: slug,
    leaseId: candidate.leaseId as string,
    nonce: candidate.nonce as string,
    grantId: candidate.grantId as string,
    invocation,
    ...(activationTicket !== undefined ? { activationTicket } : {}),
  }
}

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

/**
 * Raised when a `session` descriptor's pinned target is not a live session of
 * the workspace that owns the page.
 *
 * Thrown before any host chrome opens. Two reasons, and both matter: a user
 * must never be asked to approve a capability aimed at something that does not
 * exist, and a page must not get to learn whether an id it guessed is real
 * somewhere else by watching whether a dialog appears at all.
 */
const PAGE_GRANT_SESSION_TARGET_ERROR = 'PAGE_GRANT_SESSION_TARGET_UNAVAILABLE'

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
  const leaseRequesters = new Map<string, Map<string, {
    webContentsId: number
    renderGeneration: number
    workspaceId: string
    pageSlug: string
    contentDigest: string
  }>>()
  const grantConfirmationQueue: Array<() => Promise<void>> = []
  let drainingGrantConfirmationQueue = false
  // Counts every queued or open native host confirmation, across grants and forget recovery.
  let pendingHostConfirmationCount = 0
  /**
   * Confirmations whose host surface is open right now, keyed by lease.
   *
   * Revoking a request's authority — releasing its lease, replacing its render
   * — makes its answer unusable, but refusing to persist that answer is only
   * half the job: the sheet is still on the user's window, and the queue is
   * drained serially, so every other Page and workspace waits behind a prompt
   * that can no longer produce a grant. Holding the controller here is what
   * lets a revocation close the surface instead of merely outliving it.
   *
   * Queued-but-unopened requests need no entry: they re-check lease, digest,
   * and requester when they reach the head, and with the head unblocked that
   * is immediate.
   */
  const activeConfirmations = new Map<string, {
    deadline: AbortController
    requester: PageGrantRequester
  }>()

  /**
   * The one lease-key format. JSON encoding keeps the two parts unambiguous
   * whatever a workspace path contains, and a single builder is what keeps the
   * pending-consent map and the abort lookup addressing the same entry — two
   * hand-written template literals silently stop matching.
   */
  const leaseKeyFor = (workspaceRootPath: string, leaseId: string) =>
    JSON.stringify([workspaceRootPath, leaseId])

  /** Close an open host surface whose authority has just been revoked. */
  function abortActiveConfirmation(leaseKey: string): void {
    activeConfirmations.get(leaseKey)?.deadline.abort()
  }

  /**
   * Close any open surface belonging to a render that no longer exists. The
   * host calls this on the generation it is retiring, so the abort lands on
   * the prompt that render opened and not on its successor's.
   */
  function invalidatePageGrantRequester(requester: PageGrantRequester): void {
    for (const active of activeConfirmations.values()) {
      if (
        active.requester.webContentsId === requester.webContentsId &&
        active.requester.renderGeneration === requester.renderGeneration
      ) active.deadline.abort()
    }
  }
  deps.registerPageGrantInvalidator?.(invalidatePageGrantRequester)

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

  function deleteLeaseRequester(workspaceRootPath: string, leaseId: string): void {
    const requesters = leaseRequesters.get(workspaceRootPath)
    if (!requesters) return
    requesters.delete(leaseId)
    if (requesters.size === 0) leaseRequesters.delete(workspaceRootPath)
  }

  function isLeaseRequesterCurrent(
    workspaceRootPath: string,
    leaseId: string,
    workspaceId: string,
    pageSlug: string,
    contentDigest: string,
    requester: PageGrantRequester,
  ): boolean {
    const bound = leaseRequesters.get(workspaceRootPath)?.get(leaseId)
    return deps.isPageGrantRequesterCurrent?.(requester, workspaceId) === true &&
      bound?.webContentsId === requester.webContentsId &&
      // The binding belongs to one render, not one window. A reload keeps the
      // webContents id and can leave this lease active, so an exact generation
      // match is what stops a replacement renderer inheriting the approval.
      bound.renderGeneration === requester.renderGeneration &&
      bound.workspaceId === workspaceId &&
      bound.pageSlug === pageSlug &&
      bound.contentDigest === contentDigest
  }

  function bindLeaseRequester(
    workspaceRootPath: string,
    leaseId: string,
    workspaceId: string,
    pageSlug: string,
    contentDigest: string,
    requester: PageGrantRequester,
  ): boolean {
    if (deps.isPageGrantRequesterCurrent?.(requester, workspaceId) !== true) return false
    const workspaceRequesters = leaseRequesters.get(workspaceRootPath) ?? new Map()
    const existing = workspaceRequesters.get(leaseId)
    // A lease a previous render bound is not re-bindable. The replacement
    // renderer takes a fresh lease; silently rebinding this one would hand it
    // whatever consent state its predecessor left behind.
    if (existing) return existing.webContentsId === requester.webContentsId &&
      existing.renderGeneration === requester.renderGeneration &&
      existing.workspaceId === workspaceId && existing.pageSlug === pageSlug &&
      existing.contentDigest === contentDigest
    if (workspaceRequesters.size >= MAX_LIVE_LEASES) {
      workspaceRequesters.delete(workspaceRequesters.keys().next().value!)
    }
    workspaceRequesters.set(leaseId, {
      webContentsId: requester.webContentsId,
      renderGeneration: requester.renderGeneration,
      workspaceId,
      pageSlug,
      contentDigest,
    })
    leaseRequesters.set(workspaceRootPath, workspaceRequesters)
    return true
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

  /** Queue a destructive local-recovery prompt behind the same host surface as grants. */
  async function confirmForgetPublication(
    workspaceName: string,
    pageSlug: string,
    reason: import('@craft-agent/shared/pages').LocalPublicationRecoveryReason,
    alreadyRevoked: boolean,
  ): Promise<boolean> {
    if (!deps.confirmForgetPagePublication) throw new Error('Local publication recovery requires trusted host confirmation')
    if (pendingHostConfirmationCount >= MAX_PENDING_PAGE_GRANT_CONFIRMATIONS) throw new Error('PAGE_GRANT_CONFIRMATION_QUEUE_FULL')
    pendingHostConfirmationCount++
    return await new Promise<boolean>((resolve, reject) => {
      grantConfirmationQueue.push(async () => {
        const deadline = new AbortController()
        try {
          const confirmation = deps.confirmForgetPagePublication!({ workspaceName, pageSlug, reason, alreadyRevoked, signal: deadline.signal })
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const timeout = new Promise<never>((_resolve, rejectTimeout) => {
              timer = setTimeout(() => { deadline.abort(); rejectTimeout(new Error('confirmation timed out')) }, deps.pageGrantConfirmationTimeoutMs ?? PAGE_GRANT_CONFIRM_TIMEOUT_MS)
            })
            resolve(await Promise.race([confirmation, timeout]))
          } finally {
            if (timer) clearTimeout(timer)
          }
        } catch (error) {
          reject(error)
        } finally {
          deadline.abort()
          pendingHostConfirmationCount--
        }
      })
      drainGrantConfirmationQueue()
    })
  }

  /**
   * One outstanding local-recovery operation per publication.
   *
   * Two clicks, or a click and an agent call, must not put two native sheets on
   * the window asking the same question — and must not each run the destructive
   * write, where the second would fail the staleness check the first created.
   * The publication id is in the key because a different publication is a
   * genuinely different question, and it is snapshotted before the prompt so the
   * approval and the write that follows name the same thing.
   */
  const pendingForgetRecoveries = new Map<string, Promise<import('@craft-agent/core').PageConfig>>()

  /**
   * Trusted-host-confirmed local recovery for a publication that can no longer
   * be revoked remotely.
   *
   * Eligibility is settled BEFORE any host chrome. That ordering is doing real
   * work: an unpublished or still-manageable page is refused without asking a
   * human anything, and a page that does not exist never reaches native display
   * at all, so the prompt is only ever shown for the one state recovery is for.
   */
  async function forgetLocalPublicationWithConfirmation(
    workspace: { id: string; name: string; rootPath: string },
    pageSlug: string,
  ): Promise<import('@craft-agent/core').PageConfig> {
    const publisher = await buildPublisher()
    const { publicationId, reason, alreadyRevoked } = await publisher.describeLocalPublicationRecovery(workspace.rootPath, workspace.id, pageSlug)
    const key = JSON.stringify([workspace.id, pageSlug, publicationId])
    const inFlight = pendingForgetRecoveries.get(key)
    if (inFlight) return inFlight
    const recovery = (async () => {
      const confirmed = await confirmForgetPublication(
        sanitizePageGrantIdentity(workspace.name, 'Unnamed workspace'),
        sanitizePageGrantIdentity(pageSlug, 'Unnamed page'),
        reason,
        alreadyRevoked,
      )
      if (!confirmed) throw new Error('PAGE_FORGET_CONFIRMATION_CANCELLED')
      return publisher.forgetLocalPublication(workspace.rootPath, workspace.id, pageSlug, publicationId)
    })()
    pendingForgetRecoveries.set(key, recovery)
    try {
      return await recovery
    } finally {
      if (pendingForgetRecoveries.get(key) === recovery) pendingForgetRecoveries.delete(key)
    }
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

  /**
   * Build the host's assertion about one invocation (ADR-0033 §2).
   *
   * Re-resolved per call rather than cached on the broker: a workspace's
   * permission mode can change between two actions on the same render, and the
   * second one has to see it. Reading it from disk here is what makes
   * "revalidates permission mode on every invocation" true instead of aspirational.
   *
   * **Absent and corrupt are different.** Absent (`undefined`) is a legacy
   * workspace that never set the field, and the product contract resolves that
   * to `ask` (`config/storage.ts`); reading it as Explore would refuse a
   * capability the user never restricted, in every workspace that left the
   * setting alone. A value that is PRESENT but unrecognized is corruption or a
   * downgrade from a future version — something was stored and cannot be
   * honoured — and the only safe reading of an unhonourable restriction is the
   * most restrictive one. An unreadable config is the same class.
   *
   * The security boundary is the approved, digest-bound grant plus the
   * activation ticket; permission mode is an additional restriction layered
   * over those, which is why absence may default permissively and corruption
   * may not.
   */
  async function resolveAuthority(
    workspace: { id: string; rootPath: string },
    origin: PageActionOrigin,
  ): Promise<PageActionAuthority> {
    const permissionMode = await resolveWorkspacePermissionMode(workspace.rootPath)
    return { workspaceId: workspace.id, origin, permissionMode }
  }

  /**
   * Resolve a `session` descriptor's pinned target inside the workspace that
   * owns the page, for display in host chrome.
   *
   * Returns `undefined` for every other descriptor kind — that is the "nothing
   * to show" answer, not a failure. For a session descriptor it either returns
   * the resolved identity or throws, because an unresolvable target must stop
   * the request rather than open a sheet with a blank where the session should
   * be. Containment comes from the shared resolver, which matches inside this
   * workspace's own session list rather than comparing after a global lookup.
   *
   * This is display resolution only. It does NOT authorize the callback: the
   * executor re-resolves the same target immediately before delivery, because a
   * session can be archived, closed, or deleted between approving a grant and
   * using it, and a name shown days ago proves nothing about now.
   */
  async function describeSessionTarget(
    workspaceRootPath: string,
    workspaceId: string,
    action: import('@craft-agent/core').PageActionDescriptor,
  ): Promise<{ id: string; name: string } | undefined> {
    if (action.kind !== 'session') return undefined
    const { resolveWorkspaceSessionTarget } = await import('@craft-agent/shared/automations')
    const resolved = resolveWorkspaceSessionTarget(deps.sessionManager, workspaceId, { id: action.sessionId })
    if (!resolved) throw new Error(PAGE_GRANT_SESSION_TARGET_ERROR)
    const session = deps.sessionManager.getSessions(workspaceId).find((candidate) => candidate.id === resolved)
    if (!session) throw new Error(PAGE_GRANT_SESSION_TARGET_ERROR)
    // Existence and containment are not enough to make a target GRANTABLE. A
    // session archived or moved to a closed status while the consent sheet was
    // open would still resolve here, and the grant persisted against it could
    // never fire — the executor refuses every finished target — so the user
    // would have approved a capability that only looks like it works. The same
    // `isSessionFinished` predicate delivery uses answers it, so the two cannot
    // drift about what "finished" means.
    //
    // `isProcessing` is deliberately NOT consulted here. Busy is a moment, not
    // a state: refusing to grant on a session that happens to be mid-turn would
    // make approval depend on timing the user cannot see. It refuses at
    // delivery instead, where it is recoverable by clicking again.
    const { isSessionFinished } = await import('../../sessions/page-callback-guards')
    if (isSessionFinished(workspaceRootPath, session)) throw new Error(PAGE_GRANT_SESSION_TARGET_ERROR)
    return {
      id: resolved,
      // A session name is user- or model-authored text going into native
      // chrome, so it takes the same sanitizer workspace and page names take.
      name: sanitizePageGrantIdentity(session.name ?? '', 'Untitled session'),
    }
  }

  async function resolveWorkspacePermissionMode(
    workspaceRootPath: string,
  ): Promise<PageActionAuthority['permissionMode']> {
    // Read BEFORE normalization: `loadWorkspaceConfig` drops an unparseable
    // value to `undefined`, which would make a corrupted `safe` read as "never
    // set" and default permissively.
    const { readStoredPermissionMode } = await import('@craft-agent/shared/workspaces')
    const stored = readStoredPermissionMode(workspaceRootPath)
    if (stored.state === 'valid') return stored.mode
    if (stored.state === 'absent') return 'ask'
    return 'safe'
  }

  /**
   * Mint an activation ticket. Registered for the host only, exactly like grant
   * consent, and for the same reason: `requester` originates in Electron's
   * `ipcMain` `event.sender`, and the gesture that justifies the ticket was
   * observed by the main process. Neither fact can be asserted over the wire,
   * so there is deliberately no RPC channel that reaches this.
   */
  const requestPageActivationFromHost = async (
    requester: PageGrantRequester,
    workspaceId: string,
    pageSlug: string,
    rawRequest: unknown,
  ): Promise<{ ticketId: string; expiresAt: number }> => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const canonicalWorkspaceId = workspace.id
    if (deps.isPageGrantRequesterCurrent?.(requester, canonicalWorkspaceId) !== true) {
      throw new Error('PAGE_ACTIVATION_TRUSTED_CONTEXT_REQUIRED')
    }

    const request = parsePageActionRequest(rawRequest, pageSlug)
    if (!request) throw new Error('PAGE_ACTIVATION_INVALID_REQUEST')

    const { loadPageConfig } = await import('@craft-agent/shared/pages')
    const page = loadPageConfig(workspace.rootPath, pageSlug)
    if (!page) throw new Error(`Page not found: ${pageSlug}`)

    const expectedContentDigest = page.contentDigest
    if (!expectedContentDigest) throw new Error(`Page "${pageSlug}" has no content yet`)

    const broker = await getBroker(canonicalWorkspaceId, workspace.rootPath)
    // Bind this lease to the observed requester, exactly as grant consent does.
    // A render that inherited an existing grant has never been through the
    // grant path, so without this its lease has no owner recorded and the
    // window re-checks around the confirmation sheet would have nothing to
    // compare against — refusing every legitimate first use.
    if (!bindLeaseRequester(
      workspace.rootPath, request.leaseId, canonicalWorkspaceId, pageSlug, expectedContentDigest, requester,
    )) throw new Error('PAGE_ACTIVATION_TRUSTED_CONTEXT_REQUIRED')

    const authority = await resolveAuthority(workspace, 'sandboxed-page')
    const outcome = await broker.mintActivationTicket(page, request, authority, {
      // Queued behind the same serialized host surface as grant consent, so a
      // Page cannot stack native chrome by asking for many first uses at once.
      confirmFirstUse: () => confirmPageActionFirstUse(
        requester, workspace, page, request.grantId, request.leaseId, expectedContentDigest,
      ),
    })
    if (!outcome.ok) throw new Error(`PAGE_ACTIVATION_REFUSED: ${outcome.code}`)
    return { ticketId: outcome.ticketId, expiresAt: outcome.expiresAt }
  }
  deps.registerPageActivationHostRequest?.(requestPageActivationFromHost)

  /** Host-rendered "run this now", on the shared confirmation queue. */
  async function confirmPageActionFirstUse(
    requester: PageGrantRequester,
    workspace: { id: string; name: string; rootPath: string },
    page: import('@craft-agent/core').PageConfig,
    grantId: string,
    leaseId: string,
    expectedContentDigest: string,
  ): Promise<boolean> {
    const leaseKey = leaseKeyFor(workspace.rootPath, leaseId)
    const confirm = deps.confirmPageAction
    if (!confirm) return false
    if (pendingHostConfirmationCount >= MAX_PENDING_PAGE_GRANT_CONFIRMATIONS) {
      throw new Error('PAGE_GRANT_CONFIRMATION_QUEUE_FULL')
    }
    // Show the descriptor as it stands on disk right now. The broker re-reads
    // and re-validates it after this resolves, so the dialog and the execution
    // cannot end up describing different commands.
    const grant = page.grants?.find((candidate) => candidate.id === grantId)
    if (!grant) return false
    pendingHostConfirmationCount++
    return await new Promise<boolean>((resolve, reject) => {
      grantConfirmationQueue.push(async () => {
        const deadline = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          // Re-check before opening. This request may have waited behind other
          // native chrome, and a render that has since reloaded or died must
          // not be shown a sheet whose answer can no longer be used.
          if (!isLeaseRequesterCurrent(
            workspace.rootPath, leaseId, workspace.id, page.slug, expectedContentDigest, requester,
          )) throw new Error('PAGE_ACTIVATION_TRUSTED_CONTEXT_REQUIRED')

          // Resolved HERE, inside the queued callback and immediately before
          // the sheet opens — not before the queue. This request may have
          // waited behind other native chrome for the full timeout, and a
          // session renamed, archived, closed, or deleted in that window must
          // not be described by the identity it had when the request was made.
          // An unresolvable or finished target refuses the first use outright
          // rather than asking the user to run something aimed at nothing.
          let targetSession: { id: string; name: string } | undefined
          try {
            targetSession = await describeSessionTarget(workspace.rootPath, workspace.id, grant.action)
          } catch {
            resolve(false)
            return
          }

          const confirmation = confirm(requester, {
            workspace: { id: workspace.id, name: sanitizePageGrantIdentity(workspace.name, 'Unnamed workspace') },
            page: { slug: page.slug, name: sanitizePageGrantIdentity(page.name, 'Unnamed page') },
            action: grant.action,
            ...(targetSession ? { targetSession } : {}),
          }, deadline.signal)
          // Published for exactly as long as the sheet is open, keyed the same
          // way grant consent is. Without this, releasing the lease or retiring
          // the render made the ANSWER unusable but left the sheet on the
          // user's window — and because host chrome is drained serially, every
          // other Page and workspace queued behind a prompt nobody can answer.
          activeConfirmations.set(leaseKey, { deadline, requester })
          const timeout = new Promise<never>((_resolve, rejectTimeout) => {
            timer = setTimeout(() => { deadline.abort(); rejectTimeout(new Error('confirmation timed out')) },
              deps.pageGrantConfirmationTimeoutMs ?? PAGE_GRANT_CONFIRM_TIMEOUT_MS)
          })
          const accepted = await Promise.race([confirmation, timeout])
          // An answer given after the render stopped existing belongs to
          // nothing. The broker re-validates page state after this resolves;
          // this re-validates the WINDOW, which the broker cannot see.
          if (accepted && !isLeaseRequesterCurrent(
            workspace.rootPath, leaseId, workspace.id, page.slug, expectedContentDigest, requester,
          )) { resolve(false); return }
          // And once more after the answer, before the broker mints a ticket on
          // the strength of it. A sheet can sit open for the whole confirmation
          // timeout; approving a run against a session archived or deleted while
          // the user was reading would mint an activation for work that cannot
          // happen, and the refusal the executor would then produce is a worse
          // answer than never minting.
          if (accepted) {
            try {
              await describeSessionTarget(workspace.rootPath, workspace.id, grant.action)
            } catch {
              resolve(false)
              return
            }
          }
          resolve(accepted)
        } catch (error) {
          reject(error)
        } finally {
          if (timer) clearTimeout(timer)
          if (activeConfirmations.get(leaseKey)?.deadline === deadline) {
            activeConfirmations.delete(leaseKey)
          }
          deadline.abort()
          pendingHostConfirmationCount--
        }
      })
      drainGrantConfirmationQueue()
    })
  }

  /**
   * @param workspaceId MUST be the resolved `workspace.id`, never a caller's
   * name-or-id spelling: it becomes the broker's audit scope, and the broker is
   * cached per rootPath, so an alias supplied by whoever happened to call first
   * would scope every later row for that workspace.
   */
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
    const { createPagesSessionExecutor } = await import('../../pages/session-executor')
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
        // Deliberately handed `deps.sessionManager` through the narrow
        // `SessionCallbackHost` shape rather than as itself: the executor's
        // whole no-close guarantee is that it was never given a method that
        // could close anything, and widening that interface is the reviewable
        // moment at which a Page would gain a new power.
        executeSession: createPagesSessionExecutor({
          sessionManager: deps.sessionManager,
          // Canonical, host-resolved — the same id the audit scope uses. A
          // callback's containment check is only as good as this argument.
          workspaceId,
          workspaceRootPath,
          log,
        }),
      },
      permissionsContext: { workspaceRootPath, activeSourceSlugs },
      // Host-resolved, never client-supplied: it scopes the audit write budget,
      // so one workspace cannot flood another's lifecycle rows out of the log.
      workspaceId,
      // The broker invalidates leases on its own schedule — eviction, expiry,
      // release — and host state outlives them: a native first-use sheet stays
      // on the window and the lease→requester binding stays in its map. Closing
      // the sheet is the part that matters, because host chrome drains serially
      // and an un-closable prompt stalls every other Page and workspace.
      onLeaseDropped: (leaseId: string) => {
        abortActiveConfirmation(leaseKeyFor(workspaceRootPath, leaseId))
        deleteLeaseRequester(workspaceRootPath, leaseId)
      },
      // The broker does no IO, but it must not act on a stale view either: an
      // action that waited for a slot was admitted against state read before
      // the wait. This re-reads grants, digest, and expiry from disk AND
      // re-resolves the workspace permission mode, immediately before the
      // executor runs — so a switch to Explore during the wait refuses rather
      // than executing, which reloading only the page would have missed.
      loadCurrentAdmission: async (pageSlug: string) => {
        const { loadPageConfig } = await import('@craft-agent/shared/pages')
        const page = loadPageConfig(workspaceRootPath, pageSlug)
        if (!page) return null
        // Pages can be disabled mid-flight too; a queued action must not
        // outlive the capability that allowed it.
        if (!isPagesEnabled(workspaceRootPath)) return null
        return {
          page,
          authority: {
            workspaceId,
            origin: 'sandboxed-page' as const,
            permissionMode: await resolveWorkspacePermissionMode(workspaceRootPath),
          },
        }
      },
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
  // page is unpublished first and deletion blocks on any unconfirmed revocation,
  // so a public copy never silently outlives the local page — deletePageWithUnpublish is shared
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
    // New content invalidates grants by digest, but an already-minted ticket
    // holds its own copy of the old digest, so it has to be withdrawn here.
    brokers.get(workspace.rootPath)?.invalidateActivationsForPage(pageSlug)
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

  // Only this host-registered entry point may request consent. Its requester
  // originates in Electron's ipcMain event.sender, never a transport envelope.
  const requestPageGrantFromHost = async (
    requester: PageGrantRequester,
    workspaceId: string,
    pageSlug: string,
    input: unknown,
    leaseId: unknown,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    // `workspaceId` is a name-or-id lookup key. Everything downstream that
    // compares, coalesces, or records a workspace uses the resolved id, so two
    // aliases for one workspace cannot mint two identities — and so an audit
    // line never records a caller's spelling in place of the real workspace.
    const canonicalWorkspaceId = workspace.id
    if (deps.isPageGrantRequesterCurrent?.(requester, canonicalWorkspaceId) !== true) {
      throw new Error('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')
    }
    if (typeof leaseId !== 'string' || leaseId.length === 0) throw new Error('PAGE_GRANT_RENDER_LEASE_REQUIRED')

    // Treat every transport request as hostile. In particular, do not inspect
    // `kind` until the existing discriminated-union schema has accepted it.
    const { AddPageGrantInputSchema, loadPageConfig, addPageGrant } = await import('@craft-agent/shared/pages')
    const parsed = AddPageGrantInputSchema.safeParse(input)
    if (!parsed.success) {
      await auditGrantDecision('page_grant_rejected', canonicalWorkspaceId, pageSlug, 'invalid')
      throw new Error('PAGE_GRANT_INVALID_REQUEST')
    }
    const request = parsed.data
    const pageAtRequest = loadPageConfig(workspace.rootPath, pageSlug)
    const expectedContentDigest = pageAtRequest?.contentDigest
    if (!pageAtRequest || !expectedContentDigest) {
      throw new Error(`Page "${pageSlug}" has no content yet, so access can't be approved.`)
    }
    const broker = await getBroker(canonicalWorkspaceId, workspace.rootPath)
    const leaseKey = leaseKeyFor(workspace.rootPath, leaseId)
    // A Page may unmount between bridge dispatch and this async handler. It
    // owns no surviving consent work, so quietly decline without host chrome.
    if (!broker.hasActiveLease(leaseId, pageSlug, expectedContentDigest)) {
      deleteLeaseRequester(workspace.rootPath, leaseId)
      return null
    }

    // A `session` descriptor's target is settled here — after the lease proves
    // this is a live render, and well before any host chrome. A page that pins
    // a session belonging to another workspace, or to no session at all, is
    // refused without a human ever being asked, which is also what stops the
    // dialog becoming an oracle for which session ids exist elsewhere. Placed
    // AFTER the lease check for the same reason: an unmounted caller owns no
    // consent work and must not get to probe session existence either.
    //
    // This resolution decides whether to PROCEED. It is deliberately not the
    // one the sheet renders — see the re-resolve inside the queued callback.
    try {
      await describeSessionTarget(workspace.rootPath, canonicalWorkspaceId, request.action)
    } catch {
      await auditGrantDecision('page_grant_rejected', canonicalWorkspaceId, pageSlug, request.action.kind)
      throw new Error(PAGE_GRANT_SESSION_TARGET_ERROR)
    }

    // Identity of an outstanding request. The digest belongs here so changed
    // content starts a new request instead of coalescing behind a stale
    // confirmation, and the descriptor enters through the one canonical
    // signature the renderer also dedupes on — otherwise a reordered or
    // under-specified copy of an approved capability reads as a new request
    // and earns its own native prompt and its own persisted grant.
    const pendingKey = JSON.stringify([
      canonicalWorkspaceId,
      pageSlug,
      leaseId,
      expectedContentDigest,
      pageActionDescriptorSignature(request.action),
    ])
    const pending = pendingGrantRequests.get(pendingKey)
    if (pending) return pending
    const pendingLeaseKey = leaseKey
    // A grant-capable lease belongs to the exact requester that created it.
    // Re-resolving the original ctx alone is insufficient: a window can
    // disconnect, crash, or be rebound while native chrome is awaiting input.
    if (!bindLeaseRequester(
      workspace.rootPath, leaseId, canonicalWorkspaceId, pageSlug, expectedContentDigest, requester,
    )) throw new Error('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')
    if (pendingGrantLeases.has(pendingLeaseKey)) throw new Error('PAGE_GRANT_CONFIRMATION_ALREADY_PENDING')
    if (pendingHostConfirmationCount >= MAX_PENDING_PAGE_GRANT_CONFIRMATIONS) {
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
    pendingHostConfirmationCount++
    grantConfirmationQueue.push(async () => {
      try {
        // Do not show an obsolete request that waited behind another native
        // prompt. A request from the new digest is separately queued above.
        const page = loadPageConfig(workspace.rootPath, pageSlug)
        if (!page || page.contentDigest !== expectedContentDigest) {
          await auditGrantDecision('page_grant_rejected', canonicalWorkspaceId, pageSlug, request.action.kind)
          throw new Error('PAGE_GRANT_CONTENT_CHANGED')
        }
        if (!broker.hasActiveLease(leaseId, pageSlug, expectedContentDigest)) {
          await auditGrantDecision('page_grant_rejected', canonicalWorkspaceId, pageSlug, request.action.kind)
          resolveIssue(null)
          return
        }
        if (!deps.confirmPageGrant) {
          await auditGrantDecision('page_grant_rejected', canonicalWorkspaceId, pageSlug, request.action.kind)
          throw new Error('PAGE_GRANT_TRUSTED_CONFIRMATION_UNAVAILABLE')
        }
        // The request may have waited behind another native prompt; re-check
        // the main-process-observed sender/window/workspace binding first.
        if (!isLeaseRequesterCurrent(
          workspace.rootPath, leaseId, canonicalWorkspaceId, pageSlug, expectedContentDigest, requester,
        )) throw new Error('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')

        // Re-resolved HERE, immediately before the sheet opens, not carried in
        // from the pre-queue check. This request may have waited behind other
        // native chrome for the full confirmation timeout, and a session can be
        // renamed, archived, or deleted in that window — a sheet describing a
        // session by a name it no longer has, or one that no longer exists, is
        // asking for consent to the wrong thing.
        let targetSession: { id: string; name: string } | undefined
        try {
          targetSession = await describeSessionTarget(workspace.rootPath, canonicalWorkspaceId, request.action)
        } catch {
          await auditGrantDecision('page_grant_rejected', canonicalWorkspaceId, pageSlug, request.action.kind)
          throw new Error(PAGE_GRANT_SESSION_TARGET_ERROR)
        }

        let accepted = false
        // The deadline must reach the host, not just this promise: abandoning
        // the race would leave a real OS modal on the user's window forever,
        // and the next queued request would wait behind a prompt nobody can
        // answer. The host dismisses on abort; the race is the backstop for a
        // host that cannot.
        const deadline = new AbortController()
        // Published for exactly as long as the surface is open, so a lease
        // release or a retired render can close it instead of waiting out the
        // full timeout with the whole queue stalled behind it.
        activeConfirmations.set(pendingLeaseKey, { deadline, requester })
        try {
          const confirmation = deps.confirmPageGrant(requester, {
            workspace: {
              id: canonicalWorkspaceId,
              name: sanitizePageGrantIdentity(workspace.name, 'Unnamed workspace'),
            },
            page: {
              slug: page.slug,
              name: sanitizePageGrantIdentity(page.name, 'Unnamed page'),
            },
            action: request.action,
            pageMessage: sanitizePageGrantMessage(request.description),
            ...(targetSession ? { targetSession } : {}),
          }, deadline.signal)
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const timeout = new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                deadline.abort()
                reject(new Error('confirmation timed out'))
              }, deps.pageGrantConfirmationTimeoutMs ?? PAGE_GRANT_CONFIRM_TIMEOUT_MS)
            })
            accepted = await Promise.race([confirmation, timeout])
          } finally {
            if (timer) clearTimeout(timer)
          }
        } catch (error) {
          log.info(`Page grant confirmation unavailable for ${pageSlug}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          // A settled or failed confirmation releases the host surface too:
          // an un-aborted controller would strand a sheet on an error path.
          if (activeConfirmations.get(pendingLeaseKey)?.deadline === deadline) {
            activeConfirmations.delete(pendingLeaseKey)
          }
          deadline.abort()
        }

        if (!accepted) {
          await auditGrantDecision('page_grant_rejected', canonicalWorkspaceId, pageSlug, request.action.kind)
          resolveIssue(null)
          return
        }

        // The host surface may have closed on its own schedule, so re-check
        // after its response: an unmounted Page must never receive a grant.
        if (!broker.hasActiveLease(leaseId, pageSlug, expectedContentDigest)) {
          await auditGrantDecision('page_grant_rejected', canonicalWorkspaceId, pageSlug, request.action.kind)
          resolveIssue(null)
          return
        }
        // The user may have approved after the Electron renderer disconnected,
        // crashed, or rebound. Persist only if its original server-held
        // window/workspace/lease/digest binding remains live.
        if (!isLeaseRequesterCurrent(
          workspace.rootPath, leaseId, canonicalWorkspaceId, pageSlug, expectedContentDigest, requester,
        )) {
          await auditGrantDecision('page_grant_rejected', canonicalWorkspaceId, pageSlug, request.action.kind)
          resolveIssue(null)
          return
        }
        // And once more after the answer. A sheet can sit open for the whole
        // confirmation timeout, so the user may have approved a callback aimed
        // at a session that was archived or deleted while they were reading —
        // persisting that grant would mint a capability that can never fire.
        try {
          await describeSessionTarget(workspace.rootPath, canonicalWorkspaceId, request.action)
        } catch {
          await auditGrantDecision('page_grant_rejected', canonicalWorkspaceId, pageSlug, request.action.kind)
          resolveIssue(null)
          return
        }
        const grant = addPageGrant(workspace.rootPath, pageSlug, { ...request, expectedContentDigest })
        deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `pages/${pageSlug}/page.json`)
        await broadcastChanged(canonicalWorkspaceId, workspace.rootPath)
        await auditGrantDecision('page_grant_approved', canonicalWorkspaceId, pageSlug, grant.action.kind)
        log.info(`Approved page grant ${grant.id} on ${pageSlug} (${grant.action.kind})`)
        resolveIssue(grant)
      } catch (error) {
        rejectIssue(error)
      } finally {
        if (pendingGrantRequests.get(pendingKey) === issue) pendingGrantRequests.delete(pendingKey)
        if (pendingGrantLeases.get(pendingLeaseKey) === issue) pendingGrantLeases.delete(pendingLeaseKey)
        pendingHostConfirmationCount--
      }
    })
    drainGrantConfirmationQueue()
    return issue
  }
  deps.registerPageGrantHostRequest?.(requestPageGrantFromHost)

  // Direct transport RPC is deliberately refused: handshake fields are
  // client-asserted and must never authorize native consent.
  server.handle(RPC_CHANNELS.pages.REQUEST_GRANT, async () => {
    throw new Error('PAGE_GRANT_IPC_REQUIRED')
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
      // Revocation is immediate by contract, which means it also has to reach
      // any unspent ticket already issued against this grant.
      brokers.get(workspace.rootPath)?.invalidateActivationsForPage(pageSlug, grantId)
      deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `pages/${pageSlug}/page.json`)
      await broadcastChanged(workspaceId, workspace.rootPath)
      log.info(`Revoked page grant ${grantId} on ${pageSlug}`)
    }
    return removed
  })

  // Issue a render lease. Returns the lease AND the exact content it is bound
  // to — the renderer must render THIS content string (not a separately
  // fetched copy), closing the read/lease race.
  server.handle(RPC_CHANNELS.pages.CREATE_LEASE, async (_ctx, workspaceId: string, pageSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const { loadPageContent, computePageContentDigest } = await import('@craft-agent/shared/pages')

    const content = loadPageContent(workspace.rootPath, pageSlug)
    if (content === null) throw new Error(`Page has no content: ${pageSlug}`)

    // Canonical id, never the caller's spelling. `workspaceId` here is a
    // name-or-id lookup key, and the broker is cached per rootPath — so the
    // first caller's alias would become this workspace's audit scope for the
    // life of the process, and two aliases would look like two tenants.
    const broker = await getBroker(workspace.id, workspace.rootPath)
    const contentDigest = computePageContentDigest(content)
    const lease = broker.createLease({ pageSlug, contentDigest })
    // Transport clients may create leases, but only the sender-derived IPC
    // grant entry point can bind one to consent authority.
    return { lease, content }
  })

  // Release is privilege reduction and remains available after disabling
  // Pages. Never instantiate a broker just to release an absent lease.
  server.handle(RPC_CHANNELS.pages.RELEASE_LEASE, async (_ctx, workspaceId: string, leaseId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return
    brokers.get(workspace.rootPath)?.releaseLease(leaseId)
    deleteLeaseRequester(workspace.rootPath, leaseId)
    // Closing this lease's open prompt grants nothing and reveals nothing: the
    // release already made any answer unusable, so an untrusted caller reaches
    // the same denial it could always reach — it just stops holding the queue
    // hostage while it does.
    abortActiveConfirmation(leaseKeyFor(workspace.rootPath, leaseId))
  })

  // Execute a granted source action. Page config is re-read from disk per
  // request so revocations and content changes apply immediately.
  server.handle(RPC_CHANNELS.pages.EXECUTE_ACTION, async (_ctx, workspaceId: string, rawRequest: unknown) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    assertAvailable(workspace.rootPath)
    const { appendPageActionAudit, loadPageConfig } = await import('@craft-agent/shared/pages')

    /**
     * Refusals a malformed payload produces, shaped like every other action
     * result rather than thrown.
     *
     * This channel is reachable by any transport client, so its argument is
     * untrusted input — not a `PageActionRequest` because the signature says
     * so. Throwing would surface as a transport error the page cannot handle
     * and, worse, would leave no audit row: an attacker probing the shape of
     * this endpoint would do so invisibly. Every refusal is recorded, with
     * metadata only, since by definition nothing here has been validated.
     */
    const malformed = async (reason: string) => {
      // Code only. `reason` is returned to the caller and logged for debugging;
      // it must not reach the durable file, which by definition has seen no
      // validated input at this point.
      // Throttled: this row is reachable by any transport client with no lease,
      // so an unthrottled append turns the audit file into a disk-filling
      // primitive. The broker's rate limits cannot help — they need a valid
      // lease, which a malformed payload does not have.
      await appendPageActionAudit({
        event: 'page_action_rejected',
        workspaceId: workspace.id,
        origin: 'sandboxed-page',
        code: 'malformed-request',
      }, {
        throttleKey: `malformed:${workspace.id}`,
        onError: (error) => log.warn(`Failed to audit malformed page action: ${error}`),
      })
      log.debug(`Malformed page action on ${workspace.id}: ${reason}`)
      return { requestId: 'unknown', ok: false, error: `malformed-request: ${reason}`, durationMs: 0 }
    }

    const request = parsePageActionRequest(rawRequest)
    if (!request) return malformed('Request does not match the page action shape')

    const page = loadPageConfig(workspace.rootPath, request.pageSlug)
    if (!page) return malformed('Page not found')

    const broker = await getBroker(workspace.id, workspace.rootPath)
    // Authority is built HERE, from the resolved workspace and the transport
    // this call arrived on — never read off `request`. Everything reaching this
    // channel is a relay for page JS, including the WebUI and any direct
    // client, so the origin is `sandboxed-page` for all of them. A mutating one
    // still needs a ticket it cannot mint, which is what makes the bypass
    // attempt fail rather than merely look different.
    return broker.executeAction(page, request, await resolveAuthority(workspace, 'sandboxed-page'))
  })

  // Cancellation is cleanup: it remains available after Pages is disabled and
  // never creates a broker when no productive action is in flight. The lease
  // and its nonce are required — a request id alone is a caller-minted string,
  // so accepting it as authority let anyone abort anyone's action.
  server.handle(RPC_CHANNELS.pages.CANCEL_ACTION, async (
    _ctx,
    workspaceId: string,
    requestId: unknown,
    leaseId?: unknown,
    nonce?: unknown,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return false
    // Every argument is caller-supplied and this channel needs no lease to
    // reach. Bounded-string checks happen HERE, before the broker hashes the
    // request id for the audit row: `createHash().update(x)` on a non-string
    // throws, which would turn a malformed cancel into a transport error and an
    // unaudited crash instead of a refusal — and an unbounded one would hand
    // the hasher a payload.
    if (!isBoundedPageActionId(requestId)) return false
    if (!isBoundedPageActionId(leaseId) || !isBoundedPageActionId(nonce)) return false
    return brokers.get(workspace.rootPath)?.cancelAction(leaseId, nonce, requestId) ?? false
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

  // Unpublish, or trusted-host-confirmed local-only recovery for an irretrievable admin capability.
  server.handle(RPC_CHANNELS.pages.UNPUBLISH, async (_ctx, workspaceId: string, pageSlug: string, options?: { forgetLocal?: boolean }) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const result = options?.forgetLocal
      ? { config: await forgetLocalPublicationWithConfirmation(workspace, pageSlug), warning: undefined }
      : await (await buildPublisher()).unpublish(workspace.rootPath, workspace.id, pageSlug)
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
