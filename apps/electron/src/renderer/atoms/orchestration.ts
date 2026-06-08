/**
 * Orchestration roll-up state (PLAN-007, Phase 1).
 *
 * Read-only derived Jotai state that aggregates live + recently-completed
 * orchestration items across ALL open sessions, with zero new wire traffic.
 * Everything here is derived from existing atoms:
 *   - sessionIdsAtom        — the set of open sessions (source of truth)
 *   - backgroundTasksAtomFamily(id) — background tasks/shells (now persisted on
 *     completion; see App.tsx + useBackgroundTasks)
 *   - sessionAtomFamily(id) — messages → subagent Task activity groups via the
 *     existing groupActivitiesByParent/ActivityGroup machinery
 *
 * Retention is "until session close": completed items stay until their session
 * is removed from sessionIdsAtom (which also clears backgroundTasksAtomFamily).
 *
 * Collapse state (desktop) is a separate persisted atom below. The panel itself
 * lives in packages/ui and is framework-pure; this file is the electron wiring.
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
// Import the pure derivation helpers from the turn-utils subpath (not the full
// @craft-agent/ui barrel) so this atom stays free of heavy React/pdf deps and is
// unit-testable under bun.
import {
  groupActivitiesByParent,
  groupMessagesByTurn,
  isActivityGroup,
  type ActivityItem,
  type ActivityGroup,
} from '@craft-agent/ui/chat/turn-utils'
import type {
  OrchestrationData,
  OrchestrationItem,
  OrchestrationSessionGroup,
} from '@craft-agent/ui/orchestration/types'
import {
  sessionIdsAtom,
  sessionAtomFamily,
  backgroundTasksAtomFamily,
  activeSessionIdAtom,
  type BackgroundTask,
} from './sessions'
import type { Session } from '../../shared/types'

/**
 * Feature flag: gate the whole panel behind a fork setting. Default ON for the
 * fork build, overridable via VITE_DISABLE_ORCHESTRATION_PANEL=1 for parity
 * testing (mirrors the fork-badge VITE_HIDE_FORK_BADGE escape hatch). There is
 * no per-feature settings mechanism yet, so this is a build-time constant.
 */
export const ORCHESTRATION_PANEL_ENABLED =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_DISABLE_ORCHESTRATION_PANEL !== '1'

/** Desktop collapse state, persisted to localStorage (matches other persisted UI atoms). */
export const orchestrationPanelCollapsedAtom = atomWithStorage<boolean>(
  'craft-orchestration-panel-collapsed',
  false,
)

/** Map a BackgroundTask's status to the panel's item status. */
function backgroundTaskStatus(task: BackgroundTask): OrchestrationItem['status'] {
  switch (task.status) {
    case 'completed': return 'done'
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
    default: return 'running'
  }
}

/** Best-effort session title from a session object. */
function sessionTitleOf(sessionId: string, name?: string, preview?: string): string {
  return name?.trim() || preview?.trim() || `Session ${sessionId.slice(0, 8)}`
}

/**
 * Build orchestration items for a single session from its messages (subagent
 * Tasks) and its background tasks. Exported for unit testing.
 */
export function buildSessionItems(
  sessionId: string,
  sessionTitle: string,
  messages: Parameters<typeof groupMessagesByTurn>[0],
  backgroundTasks: BackgroundTask[],
): OrchestrationItem[] {
  const items: OrchestrationItem[] = []

  // --- Subagent Task activity (parent Task tools + child counts) ---
  // Flatten all turn activities, then group by parent Task to get child counts.
  const turns = groupMessagesByTurn(messages)
  const allActivities: ActivityItem[] = []
  for (const turn of turns) {
    if (turn.type === 'assistant') {
      for (const activity of turn.activities) allActivities.push(activity)
    }
  }
  const grouped = groupActivitiesByParent(allActivities)
  for (const entry of grouped) {
    if (!isActivityGroup(entry)) continue
    const group: ActivityGroup = entry
    const parent = group.parent
    // Skip background-launched Tasks here — they are represented by the
    // backgroundTasks list below (which carries live elapsed + terminal status).
    if (parent.isBackground || parent.status === 'backgrounded') continue

    const status: OrchestrationItem['status'] =
      parent.status === 'error' ? 'failed'
      : parent.status === 'running' || parent.status === 'pending' ? 'running'
      : 'done'

    items.push({
      sessionId,
      sessionTitle,
      kind: 'subagent-task',
      id: parent.toolUseId || parent.id,
      toolUseId: parent.toolUseId,
      label: parent.intent || parent.displayName || parent.toolName,
      status,
      elapsedSeconds: parent.elapsedSeconds,
      childStepCount: group.children.length,
      durationMs: group.taskOutputData?.durationMs,
    })
  }

  // --- Background tasks / shells (persisted through completion) ---
  for (const task of backgroundTasks) {
    items.push({
      sessionId,
      sessionTitle,
      kind: task.type === 'shell' ? 'background-shell' : 'background-task',
      id: task.id,
      toolUseId: task.toolUseId,
      label: task.intent,
      status: backgroundTaskStatus(task),
      elapsedSeconds: task.elapsedSeconds,
      durationMs: task.durationMs,
      outputFile: task.outputFile,
      summary: task.summary,
    })
  }

  return items
}

/** Sort items: running first, then by recency (best-effort). */
function sortItems(items: OrchestrationItem[]): OrchestrationItem[] {
  return [...items].sort((a, b) => {
    const aRunning = a.status === 'running' ? 0 : 1
    const bRunning = b.status === 'running' ? 0 : 1
    if (aRunning !== bRunning) return aRunning - bRunning
    return 0
  })
}

/**
 * Read-only derived atom: the cross-session orchestration roll-up.
 *
 * Reads sessionIdsAtom and, per id, the session + its background tasks. Groups
 * items by session, pins the focused session to the top, and computes summary
 * counts for the mobile pill.
 */
export const orchestrationItemsAtom = atom<OrchestrationData>((get) => {
  const sessionIds = get(sessionIdsAtom)
  const focusedId = get(activeSessionIdAtom)

  const groups: OrchestrationSessionGroup[] = []
  let runningCount = 0
  let totalCount = 0

  for (const sessionId of sessionIds) {
    // sessionAtomFamily/backgroundTasksAtomFamily are typed as Atom<unknown> by
    // jotai-family in this repo (pre-existing), so cast to the known shapes.
    const session = get(sessionAtomFamily(sessionId)) as Session | null
    const backgroundTasks = get(backgroundTasksAtomFamily(sessionId)) as BackgroundTask[]
    const messages = session?.messages ?? []

    const title = sessionTitleOf(sessionId, session?.name, session?.preview)
    const items = sortItems(buildSessionItems(sessionId, title, messages, backgroundTasks))
    if (items.length === 0) continue

    for (const item of items) {
      totalCount++
      if (item.status === 'running') runningCount++
    }

    groups.push({
      sessionId,
      sessionTitle: title,
      isFocused: sessionId === focusedId,
      items,
    })
  }

  // Pin the focused session group to the top.
  groups.sort((a, b) => {
    if (a.isFocused !== b.isFocused) return a.isFocused ? -1 : 1
    return 0
  })

  return { groups, runningCount, totalCount }
})
