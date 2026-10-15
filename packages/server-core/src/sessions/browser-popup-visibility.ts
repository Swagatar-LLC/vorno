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
