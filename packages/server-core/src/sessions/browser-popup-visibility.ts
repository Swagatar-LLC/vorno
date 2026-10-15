/**
 * Which browser windows a session's `browser_tool` may list, focus or close.
 *
 * A pop-up a page opened (`parentInstanceId` set) belongs to the session that
 * owns its opener: no other session sees it. Session ids are only unique
 * within a workspace, so a pop-up stamped with another workspace is hidden
 * even when the session id matches. Top-level windows are returned unchanged;
 * their existing lock rules apply.
 */
export interface BrowserWindowOwnership {
  parentInstanceId?: string | null
  boundSessionId: string | null
  ownerSessionId: string | null
  workspaceId?: string | null
}

export function isBrowserWindowVisibleToSession(
  window: BrowserWindowOwnership,
  sessionId: string,
  workspaceId: string | null,
): boolean {
  if (!window.parentInstanceId) return true
  const owned = window.boundSessionId === sessionId || window.ownerSessionId === sessionId
  const sameWorkspace = window.workspaceId == null || workspaceId == null || window.workspaceId === workspaceId
  return owned && sameWorkspace
}

export interface LifecycleWindow extends BrowserWindowOwnership {
  id: string
  activePopupId?: string | null
}

/**
 * The window an id-less close/hide acts on, chosen from the session-visible
 * list. The session's top-level window (bound first, then owned, so this also
 * works after turn-end unbinding) is the default; when it reports a selected
 * pop-up, that pop-up is the target. A selection missing from the list fails
 * closed so the opener is never closed in the pop-up's place.
 */
export function pickImplicitLifecycleTarget<T extends LifecycleWindow>(
  windows: T[],
  sessionId: string,
): { target?: T; reason?: string } {
  const root = windows.find((w) => !w.parentInstanceId && w.boundSessionId === sessionId)
    ?? windows.find((w) => !w.parentInstanceId && w.ownerSessionId === sessionId)
  if (!root) {
    const any = windows.find((w) => w.boundSessionId === sessionId) ?? windows.find((w) => w.ownerSessionId === sessionId)
    return any ? { target: any } : {}
  }
  if (!root.activePopupId) return { target: root }
  const selected = windows.find((w) => w.id === root.activePopupId && w.parentInstanceId)
  if (!selected) {
    return { reason: `Selected pop-up "${root.activePopupId}" of browser window "${root.id}" is not available. Use "windows", then pass an id.` }
  }
  return { target: selected }
}
