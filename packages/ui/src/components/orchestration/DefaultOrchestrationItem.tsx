/**
 * DefaultOrchestrationItem — built-in renderer for an orchestration item.
 *
 * Framework-pure: takes plain props, no Jotai/electron imports. Shows a status
 * dot (pulsing while running), label/intent, live elapsed time (running) or
 * duration/summary (done), child-step count, and a "View output" affordance that
 * routes through the host-provided callback (the Electron container wires this to
 * the existing terminal-overlay path + task_completed.outputFile).
 */

import * as React from 'react'
import { cn } from '../../lib/utils'
import { Spinner } from '../ui'
import type { OrchestrationItem } from './types'

/** Props every orchestration item renderer receives. */
export interface OrchestrationItemRendererProps {
  item: OrchestrationItem
  /** Open the item's output (terminal overlay). Omit to hide the affordance. */
  onViewOutput?: (item: OrchestrationItem) => void
  /**
   * Select the item (e.g. focus its session and jump to its work). Omit to
   * leave the row non-interactive. The "Output" button stops propagation so it
   * does not also trigger this.
   */
  onSelect?: (item: OrchestrationItem) => void
}

/** Format elapsed seconds compactly (mirrors ActiveTasksBar/TaskActionMenu). */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

/** Format a final duration in ms compactly. */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  return formatElapsed(Math.round(ms / 1000))
}

/**
 * Base palette for the static status dot (non-running). `done` is intentionally
 * dimmed/desaturated so finished work recedes instead of reading as a loud wall
 * of green — failed/stopped stay saturated and distinct. `running` is handled
 * separately (live spinner), not via this map.
 */
const STATUS_DOT: Record<OrchestrationItem['status'], string> = {
  running: 'bg-blue-500',
  // Calm, recessive: emerald at low opacity reads as "settled / complete".
  done: 'bg-emerald-500/40',
  // Emphasized failure.
  failed: 'bg-red-500',
  // Distinct from done.
  stopped: 'bg-amber-500',
}

const KIND_LABEL: Record<OrchestrationItem['kind'], string> = {
  'subagent-task': 'Agent',
  'background-task': 'Agent',
  'background-shell': 'Shell',
}

export function DefaultOrchestrationItem({ item, onViewOutput, onSelect }: OrchestrationItemRendererProps) {
  const isRunning = item.status === 'running'
  const label = item.label || `${KIND_LABEL[item.kind]} ${item.id.slice(0, 8)}`
  const selectable = !!onSelect

  // Trailing metric: live elapsed while running, else final run duration.
  //
  // Relative-time note: the item carries `durationMs` (how long it ran) and
  // `elapsedSeconds` (live), but NOT an absolute completion timestamp — so a
  // truthful "Xm ago" is not derivable from existing data and we do not
  // fabricate one (no wire change). Instead we make the duration unambiguous:
  // "ran 2m 3s" for finished work, live elapsed for running.
  let metric: string | undefined
  if (isRunning && item.elapsedSeconds !== undefined) {
    metric = formatElapsed(item.elapsedSeconds)
  } else if (item.durationMs !== undefined) {
    const d = formatDurationMs(item.durationMs)
    metric = d ? `ran ${d}` : undefined
  }

  const canViewOutput = !!onViewOutput && (item.kind !== 'subagent-task' || !!item.outputFile || item.status === 'done')

  return (
    <div
      role={selectable ? 'button' : undefined}
      tabIndex={selectable ? 0 : undefined}
      onClick={selectable ? () => onSelect?.(item) : undefined}
      onKeyDown={
        selectable
          ? (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect?.(item)
              }
            }
          : undefined
      }
      className={cn(
        'flex items-start gap-2 rounded-[8px] px-2.5 py-2 hover:bg-foreground/[0.03] transition-colors',
        selectable &&
          'cursor-pointer text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50',
      )}
    >
      {/* Status indicator */}
      <div className="flex items-center justify-center shrink-0 mt-0.5 w-3.5 h-3.5">
        {isRunning ? (
          <Spinner className="text-xs" />
        ) : (
          <span className={cn('w-2 h-2 rounded-full', STATUS_DOT[item.status])} />
        )}
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium truncate text-foreground/90">{label}</span>
          {metric && (
            <span className="text-[11px] tabular-nums opacity-50 shrink-0">{metric}</span>
          )}
        </div>

        {/* Secondary line: kind + child steps + summary */}
        <div className="flex items-center gap-2 mt-0.5 text-[11px] opacity-55">
          <span className="shrink-0">{KIND_LABEL[item.kind]}</span>
          {item.childStepCount !== undefined && item.childStepCount > 0 && (
            <span className="shrink-0">{item.childStepCount} steps</span>
          )}
          {item.summary && !isRunning && (
            <span className="truncate">{item.summary}</span>
          )}
        </div>
      </div>

      {/* View output */}
      {canViewOutput && (
        <button
          type="button"
          onClick={(e) => {
            // Don't let the Output click bubble up to the row's onSelect.
            e.stopPropagation()
            onViewOutput?.(item)
          }}
          className="shrink-0 text-[11px] px-1.5 py-0.5 rounded-[6px] opacity-60 hover:opacity-100 hover:bg-foreground/5 transition-all"
        >
          Output
        </button>
      )}
    </div>
  )
}
