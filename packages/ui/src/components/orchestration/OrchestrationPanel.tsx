/**
 * OrchestrationPanel — persistent, glanceable cross-session orchestration view.
 *
 * A "mini-Observatory": shows live and recently-completed parallel/background
 * agent work (subagent Tasks, background tasks/shells) grouped by session, with
 * the focused session pinned to the top. Completed items persist here (in a done
 * state) until their session closes — they do not vanish on completion.
 *
 * Framework-pure: takes plain props (the grouped roll-up). No Jotai/electron
 * imports — the same component renders on the Electron shell and the WebUI.
 * Atom/electron wiring (derivation, output-overlay routing) lives in
 * `apps/electron/src/renderer/`.
 *
 * Per-item rendering goes through the renderer registry (the DIR-02 contribution
 * seam) so a future skill-contributed view can plug a custom renderer per kind.
 */

import * as React from 'react'
import { cn } from '../../lib/utils'
import type { OrchestrationData, OrchestrationItem } from './types'
import { getOrchestrationItemRenderer } from './registry'

export interface OrchestrationPanelProps {
  data: OrchestrationData
  /** Open an item's output (terminal overlay). */
  onViewOutput?: (item: OrchestrationItem) => void
  /** Select an item's row (e.g. focus its session and jump to its work). */
  onSelect?: (item: OrchestrationItem) => void
  /** Optional header action (e.g. collapse button on desktop). */
  headerAction?: React.ReactNode
  /** Hide the panel's own header (e.g. when the drawer supplies one). */
  hideHeader?: boolean
  className?: string
}

export function OrchestrationPanel({
  data,
  onViewOutput,
  onSelect,
  headerAction,
  hideHeader,
  className,
}: OrchestrationPanelProps) {
  const { groups, runningCount, totalCount } = data

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      {!hideHeader && (
        <div className="flex items-center justify-between px-3 py-2 shrink-0 border-b border-border/40">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground/90">Activity</span>
            {runningCount > 0 && (
              <span className="text-[11px] tabular-nums px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
                {runningCount} running
              </span>
            )}
          </div>
          {headerAction}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {totalCount === 0 ? (
          <div className="flex items-center justify-center h-full px-4 py-8 text-center">
            <p className="text-xs text-muted-foreground">No active or recent agent work.</p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.sessionId} className="mb-1">
              <div
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1 sticky top-0 z-[1] bg-background/95 backdrop-blur-sm',
                  group.isFocused && 'text-foreground',
                )}
              >
                {group.isFocused && (
                  <span className="w-1 h-1 rounded-full bg-blue-500 shrink-0" />
                )}
                <span className={cn(
                  'text-[11px] font-medium uppercase tracking-wide truncate',
                  group.isFocused ? 'opacity-80' : 'opacity-45',
                )}>
                  {group.sessionTitle}
                </span>
              </div>
              <div className="px-1">
                {group.items.map((item) => {
                  const Renderer = getOrchestrationItemRenderer(item)
                  return <Renderer key={`${item.kind}:${item.id}`} item={item} onViewOutput={onViewOutput} onSelect={onSelect} />
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
