import type { PlatformServices } from '../runtime/platform'
import type { ISessionManager } from './session-manager-interface'
import type { IOAuthFlowStore } from './oauth-flow-store-interface'
import type { IBrowserPaneManager } from './browser-pane-manager-interface'
import type { IWindowManager } from './window-manager-interface'
import type { IMessagingGatewayRegistry } from './messaging-registry-interface'
import type { PageActionDescriptor } from '@craft-agent/core'
import type { RequestContext } from '../transport/types'

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

/** Server-held identity of the Electron window that requested a Page grant. */
export interface PageGrantRequester {
  webContentsId: number
}

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
   * Resolves a trusted Electron requester from server-held connection/window
   * state. Remote and token clients must never receive one.
   */
  getPageGrantRequester?: (ctx: RequestContext, workspaceId: string) => PageGrantRequester | undefined
  /** A host-owned native consent surface. Absent hosts cannot issue Page grants. */
  confirmPageGrant?: (requester: PageGrantRequester, spec: PageGrantConfirmationSpec) => Promise<boolean>
  /** Testable bound for a host confirmation that never settles. */
  pageGrantConfirmationTimeoutMs?: number
}
