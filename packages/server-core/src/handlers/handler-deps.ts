import type { PlatformServices } from '../runtime/platform'
import type { ISessionManager } from './session-manager-interface'
import type { IOAuthFlowStore } from './oauth-flow-store-interface'
import type { IBrowserPaneManager } from './browser-pane-manager-interface'
import type { IWindowManager } from './window-manager-interface'
import type { IMessagingGatewayRegistry } from './messaging-registry-interface'
import type { PageActionDescriptor, PageActionGrant } from '@craft-agent/core'

/**
 * Server-resolved identity and descriptor rendered by a trusted host surface.
 * This is deliberately not a transport/client dialog spec: remote clients do
 * not participate in Page grant consent.
 */
export interface PageGrantConfirmationSpec {
  workspace: { id: string; name: string }
  page: { slug: string; name: string }
  action: PageActionDescriptor
  /** Sanitized, bounded optional prose supplied by the page author. */
  pageMessage?: string
}

/**
 * Main-process-observed identity of the *document* requesting consent. Every
 * member is derived from `ipcMain` `event.sender` and main-process state;
 * nothing a client can place on the wire belongs in this shape.
 */
export interface PageGrantRequester {
  webContentsId: number
  /**
   * Host-assigned generation of the render inside that webContents, changed on
   * main-frame navigation, reload, and renderer loss. A webContents id outlives
   * its document, and lease release is renderer-owned, so without this a
   * replacement renderer inherits an approval given to its predecessor.
   */
  renderGeneration: number
}

/**
 * The host-only entry point for Page grant consent.
 *
 * `workspaceId` is supplied by the host from its own window→workspace
 * mapping, not by the caller: a renderer that could name the workspace could
 * aim a trusted prompt at a workspace its window does not show.
 */
export type PageGrantHostRequest = (
  requester: PageGrantRequester,
  workspaceId: string,
  pageSlug: string,
  input: unknown,
  leaseId: unknown,
) => Promise<PageActionGrant | null>

/**
 * Generic handler dependency bag.
 * Concrete hosts specialize these generics to their runtime implementations.
 *
 * TSessionManager defaults to ISessionManager, TOAuthFlowStore
 * defaults to IOAuthFlowStore, TWindowManager defaults to IWindowManager,
 * and TBrowserPaneManager defaults to IBrowserPaneManager so core handlers
 * get typed access without specialization.  Electron narrows all to their
 * concrete implementations.
 */
export interface HandlerDeps<
  TSessionManager extends ISessionManager = ISessionManager,
  TOAuthFlowStore extends IOAuthFlowStore = IOAuthFlowStore,
  TWindowManager extends IWindowManager = IWindowManager,
  TBrowserPaneManager extends IBrowserPaneManager = IBrowserPaneManager,
> {
  sessionManager: TSessionManager
  platform: PlatformServices
  windowManager?: TWindowManager
  browserPaneManager?: TBrowserPaneManager
  oauthFlowStore: TOAuthFlowStore
  messagingRegistry?: IMessagingGatewayRegistry
  /**
   * Main-process check that the IPC sender still owns this live workspace
   * window. It must not consult transport-envelope identity.
   */
  isPageGrantRequesterCurrent?: (requester: PageGrantRequester, workspaceId: string) => boolean
  /** Registers the host-only grant entry point; transport RPC must not use it. */
  registerPageGrantHostRequest?: (request: PageGrantHostRequest) => void
  /**
   * Receives a callback the host invokes when a render stops existing, passing
   * the `{ webContentsId, renderGeneration }` it is retiring.
   *
   * Refusing to persist a dead render's approval is not enough on its own: its
   * native surface is still open on the user's window, and consent is drained
   * serially, so an un-closable prompt stalls every other Page and workspace
   * until the timeout. This is how the host says "close it now".
   */
  registerPageGrantInvalidator?: (invalidate: (requester: PageGrantRequester) => void) => void
  /**
   * A host-owned native consent surface. Absent hosts cannot issue Page grants.
   *
   * `signal` aborts when the request's deadline elapses or its render goes
   * away. Racing a timeout alone only abandons the promise — the OS modal
   * stays on screen, still attached to the user's window — so a host that
   * renders real chrome must dismiss it on abort and resolve `false`.
   */
  confirmPageGrant?: (
    requester: PageGrantRequester,
    spec: PageGrantConfirmationSpec,
    signal: AbortSignal,
  ) => Promise<boolean>
  /** Testable bound for a host confirmation that never settles. */
  pageGrantConfirmationTimeoutMs?: number
}
