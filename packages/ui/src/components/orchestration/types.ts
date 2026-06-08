/**
 * Orchestration panel types — shared, framework-pure.
 *
 * These describe a single glanceable "orchestration item" (a subagent Task or a
 * background task/shell) and the grouped, cross-session roll-up the panel renders.
 *
 * The shapes are intentionally plain data so both the Electron shell and the
 * mobile/tablet WebUI (same React tree) can render them. All atom/electron wiring
 * lives in `apps/electron/src/renderer/`; nothing here imports Jotai or electron.
 */

/** Lifecycle status of an orchestration item. */
export type OrchestrationItemStatus = 'running' | 'done' | 'failed' | 'stopped'

/**
 * Kind of orchestration item. Drives which renderer is used (see the renderer
 * registry). New kinds can be contributed by skills via a custom renderer — this
 * is the DIR-02 contribution seam (see registry.tsx).
 */
export type OrchestrationItemKind = 'subagent-task' | 'background-task' | 'background-shell'

/** A single orchestration item — live or completed parallel/background work. */
export interface OrchestrationItem {
  /** Session this item belongs to. */
  sessionId: string
  /** Human title of the session (for grouping headers). */
  sessionTitle: string
  /** Item kind (selects the renderer). */
  kind: OrchestrationItemKind
  /** Stable item id (taskId / shellId / parent toolUseId). */
  id: string
  /** Tool-use id correlating to the originating tool message, when known. */
  toolUseId?: string
  /** Short human label / intent for the item. */
  label?: string
  /** Lifecycle status. */
  status: OrchestrationItemStatus
  /** Live elapsed seconds (running items). */
  elapsedSeconds?: number
  /** Number of child activity steps (subagent Tasks). */
  childStepCount?: number
  /** Final duration in ms (completed items, when available). */
  durationMs?: number
  /** Output file path for "View output" (completed background tasks). */
  outputFile?: string
  /** One-line completion summary. */
  summary?: string
}

/** Items for a single session (a group in the panel). */
export interface OrchestrationSessionGroup {
  sessionId: string
  sessionTitle: string
  /** True when this is the currently focused session (pinned/highlighted). */
  isFocused: boolean
  items: OrchestrationItem[]
}

/** Cross-session roll-up rendered by the panel. */
export interface OrchestrationData {
  groups: OrchestrationSessionGroup[]
  /** Count of running items across all sessions (for the summary pill). */
  runningCount: number
  /** Total item count across all sessions. */
  totalCount: number
}
