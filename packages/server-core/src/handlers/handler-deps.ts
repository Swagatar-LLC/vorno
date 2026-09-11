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
 * Main-process-observed identity of the Electron window requesting consent.
 * Its only member is derived from `ipcMain` `event.sender`; nothing a client
 * can place on the wire belongs in this shape.
 */
export interface PageGrantRequester {
  webContentsId: number
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
