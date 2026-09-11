/**
 * Main-process identity for Page grant consent.
 *
 * Everything a Page grant is authorized against is observed here, in the main
 * process, and nothing in this file may accept identity from a renderer or a
 * transport client. Two facts drive the design:
 *
 *  1. **Handshake fields are client-asserted.** `clientId`, `workspaceId`, and
 *     `webContentsId` arrive over the RPC transport, so a token-holding client
 *     can name a real workspace window. Consent therefore crosses `ipcMain`,
 *     where the sender is a property of the event rather than of the payload.
 *  2. **A webContents id outlives its document.** A reload, a main-frame
 *     navigation, or a renderer crash-and-recover keeps the same id and the
 *     same workspace mapping, and lease release is renderer-owned, so a
 *     renderer that dies before cleanup leaves its lease active. Window
 *     identity alone cannot distinguish a replacement render from the one that
 *     opened a prompt, so each render carries a generation.
 *
 * This lives outside `index.ts` so both properties are directly testable; the
 * Electron wiring there supplies the real `WebContents` and `WindowManager`.
 */

/** The subset of Electron's `WebContents` this tracker needs. */
export interface TrackableWebContents {
  id: number
  on(event: 'did-start-navigation', listener: (...args: unknown[]) => void): unknown
  on(event: 'render-process-gone', listener: () => void): unknown
  once(event: 'destroyed', listener: () => void): unknown
}

/**
 * Read a navigation's shape from the listener arguments, whichever form they
 * take.
 *
 * Electron 39 passes `(details, ...deprecated positional args)`, where
 * `Event<Params> = { preventDefault, defaultPrevented } & Params` — so
 * `isMainFrame` and `isSameDocument` live on the first argument. Older
 * Electron passed `(event, url, isInPlace, isMainFrame, …)` instead.
 *
 * Reading both, and treating an unrecognized shape as a document replacement,
 * makes the asymmetry here safe: retiring a generation that did not really
 * change only cancels in-flight consent, and the user is asked again. Failing
 * to retire one that did change leaks an approval from a document the user was
 * looking at to whatever replaced it. A misread must not be able to cause the
 * second outcome, so the unknown case bumps.
 */
export function describeNavigation(args: unknown[]): { isMainFrame: boolean; isSameDocument: boolean } {
  const details = args[0]
  if (details !== null && typeof details === 'object') {
    const { isMainFrame, isSameDocument } = details as Record<string, unknown>
    if (typeof isMainFrame === 'boolean' && typeof isSameDocument === 'boolean') {
      return { isMainFrame, isSameDocument }
    }
  }
  // Legacy positional form; `isInPlace` is that era's same-document flag.
  const [, , isInPlace, legacyIsMainFrame] = args
  if (typeof legacyIsMainFrame === 'boolean' && typeof isInPlace === 'boolean') {
    return { isMainFrame: legacyIsMainFrame, isSameDocument: isInPlace }
  }
  return { isMainFrame: true, isSameDocument: false }
}

/** A render, identified the way the grant handler compares it. */
export interface RenderIdentity {
  webContentsId: number
  renderGeneration: number
}

export interface RenderGenerationTracker {
  /**
   * Begin tracking `contents` if it is not already tracked, and return its
   * current generation. Idempotent: a second call returns the live generation
   * rather than resetting it or double-subscribing.
   */
  track(contents: TrackableWebContents): number
  /** The live generation, or `undefined` once the webContents is gone. */
  current(webContentsId: number): number | undefined
  /**
   * Whether this exact render is still the one in that window. An untracked or
   * destroyed id is never current — absent must read as "no", not as a match.
   */
  isCurrent(identity: RenderIdentity): boolean
}

/**
 * Tracks which document is live inside each webContents.
 *
 * `onRetire` is called with the identity being *retired*, before its successor
 * exists. The grant handler uses it to close that render's open consent sheet:
 * refusing to persist a dead render's approval is necessary but not sufficient,
 * because the sheet stays on the user's window and consent is drained serially,
 * so an un-closable prompt stalls every other Page and workspace.
 */
export function createRenderGenerationTracker(
  onRetire?: (retired: RenderIdentity) => void,
): RenderGenerationTracker {
  const generations = new Map<number, number>()

  const retire = (webContentsId: number, next: number | undefined): void => {
    const current = generations.get(webContentsId)
    // Only retire a tracked id. Acting on an unknown one would resurrect a
    // generation for a webContents that no longer exists, and re-announce a
    // retirement that already happened.
    if (current === undefined) return
    if (next === undefined) generations.delete(webContentsId)
    else generations.set(webContentsId, next)
    onRetire?.({ webContentsId, renderGeneration: current })
  }

  return {
    track(contents) {
      const existing = generations.get(contents.id)
      if (existing !== undefined) return existing
      generations.set(contents.id, 1)
      const bump = () => retire(contents.id, (generations.get(contents.id) ?? 0) + 1)
      contents.on('did-start-navigation', (...args: unknown[]) => {
        // A fragment or history.pushState navigation does not replace the
        // document, so the render that opened a prompt is still the one that
        // would receive the grant. Bumping there would cancel live consent
        // every time a Page updated its own URL.
        const { isMainFrame, isSameDocument } = describeNavigation(args)
        if (isMainFrame && !isSameDocument) bump()
      })
      contents.on('render-process-gone', bump)
      contents.once('destroyed', () => retire(contents.id, undefined))
      return 1
    },
    current: (webContentsId) => generations.get(webContentsId),
    isCurrent: ({ webContentsId, renderGeneration }) =>
      generations.get(webContentsId) === renderGeneration,
  }
}

/** What the grant IPC handler needs from the host, and nothing more. */
export interface PageGrantIpcHost {
  /** Workspace shown by that window, or null/undefined if it is not an app window. */
  getWorkspaceForWindow(webContentsId: number): string | null | undefined
  tracker: RenderGenerationTracker
  /** The registered server-side entry point; absent on hosts that cannot consent. */
  request?: (
    requester: RenderIdentity,
    workspaceId: string,
    pageSlug: string,
    input: unknown,
    leaseId: unknown,
  ) => Promise<unknown>
}

/**
 * The body of the `__pages:request-grant` IPC handler.
 *
 * `senderWebContentsId` must come from `event.sender`, never from the payload.
 * The workspace is resolved here from the host's own window map for the same
 * reason: a renderer that could name the workspace could aim a trusted native
 * prompt at one its window does not show.
 */
export async function handlePageGrantIpc(
  host: PageGrantIpcHost,
  sender: TrackableWebContents,
  pageSlug: unknown,
  input: unknown,
  leaseId: unknown,
): Promise<unknown> {
  const workspaceId = host.getWorkspaceForWindow(sender.id)
  // An unknown window is not a workspace window: browser panes, devtools, and
  // anything else that can reach ipcMain resolve to nothing and stop here.
  if (!workspaceId || !host.request) throw new Error('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')
  if (typeof pageSlug !== 'string') throw new Error('PAGE_GRANT_INVALID_REQUEST')
  // Tracking starts here because this is the only place a requester is minted.
  // A reload before any request had no outstanding consent to void, and
  // `track` is idempotent, so this returns the live generation thereafter.
  const renderGeneration = host.tracker.track(sender)
  return host.request(
    { webContentsId: sender.id, renderGeneration },
    workspaceId,
    pageSlug,
    input,
    leaseId,
  )
}
