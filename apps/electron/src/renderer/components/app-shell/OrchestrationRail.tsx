/**
 * OrchestrationRail — Electron-side container for the shared OrchestrationPanel
 * (PLAN-007, Phase 1).
 *
 * Wires the read-only `orchestrationItemsAtom` roll-up to the framework-pure
 * `OrchestrationPanel` from `@craft-agent/ui`, and chooses the right surface:
 *   - Desktop (>= 768px): a collapsible right-side rail (collapse state persisted
 *     to localStorage via `orchestrationPanelCollapsedAtom`).
 *   - Mobile/tablet (< 768px): a bottom Vaul drawer opened by a compact summary
 *     pill, sized to not overlap the input zone / mobile menu.
 *
 * "View output" fetches the task output via the existing getTaskOutput IPC and
 * shows it in the same CodePreviewOverlay the app already uses, mirroring the
 * ActiveTasksBar/TaskActionMenu flow (and using task_completed.outputFile when
 * present for the overlay title).
 *
 * The whole rail is gated behind ORCHESTRATION_PANEL_ENABLED (fork flag).
 */

import * as React from 'react'
import { useAtomValue, useAtom, useSetAtom } from 'jotai'
import { PanelRightClose, PanelRightOpen, Activity, X } from 'lucide-react'
import {
  OrchestrationPanel,
  CodePreviewOverlay,
  type OrchestrationItem,
} from '@craft-agent/ui'
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/ThemeContext'
import {
  orchestrationItemsAtom,
  orchestrationPanelCollapsedAtom,
  ORCHESTRATION_PANEL_ENABLED,
} from '@/atoms/orchestration'
import { activeSessionIdAtom } from '@/atoms/sessions'

const RAIL_WIDTH = 260

interface OutputState {
  title: string
  content: string
}

/** Shared "View output" handler — fetches task output and opens the overlay. */
function useViewOutput() {
  const [output, setOutput] = React.useState<OutputState | null>(null)

  const onViewOutput = React.useCallback(async (item: OrchestrationItem) => {
    try {
      const result = await window.electronAPI.getTaskOutput(item.id)
      setOutput({
        title: item.label || item.outputFile?.split('/').pop() || `${item.kind} ${item.id.slice(0, 8)}`,
        content: result || 'No output yet.',
      })
    } catch {
      setOutput({
        title: item.label || item.id,
        content: 'Failed to load task output.',
      })
    }
  }, [])

  return { output, setOutput, onViewOutput }
}

/**
 * Shared row-select handler: focus the item's session.
 *
 * Agent 4 (PLAN-009) will extend: scroll to item.toolUseId (the originating
 * tool-use message) after focusing the session, mirroring scrollToFollowUpTurn.
 */
function useSelectItem() {
  const setActiveSessionId = useSetAtom(activeSessionIdAtom)

  const onSelect = React.useCallback(
    (item: OrchestrationItem) => {
      setActiveSessionId(item.sessionId)
      // Agent 4 (PLAN-009) will extend: scroll to item.toolUseId
    },
    [setActiveSessionId],
  )

  return onSelect
}

/**
 * Desktop right-side rail. Collapses to a thin re-open button. Hidden below the
 * mobile threshold (the drawer handles narrow viewports).
 */
export function OrchestrationDesktopRail({ isCompact }: { isCompact: boolean }) {
  const data = useAtomValue(orchestrationItemsAtom)
  const [collapsed, setCollapsed] = useAtom(orchestrationPanelCollapsedAtom)
  const { resolvedMode } = useTheme()
  const { output, setOutput, onViewOutput } = useViewOutput()
  const onSelect = useSelectItem()

  if (!ORCHESTRATION_PANEL_ENABLED || isCompact) return null

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title="Show activity panel"
        className="shrink-0 self-start mt-1 h-8 w-8 flex items-center justify-center rounded-[8px] bg-background shadow-minimal hover:bg-foreground/5 transition-colors relative"
      >
        <PanelRightOpen className="h-4 w-4 opacity-70" />
        {data.runningCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-blue-500 text-white text-[10px] tabular-nums flex items-center justify-center">
            {data.runningCount}
          </span>
        )}
      </button>
    )
  }

  return (
    <>
      <div
        style={{ width: RAIL_WIDTH }}
        className="shrink-0 h-full bg-background rounded-[10px] shadow-minimal overflow-hidden"
      >
        <OrchestrationPanel
          data={data}
          onViewOutput={onViewOutput}
          onSelect={onSelect}
          headerAction={
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              title="Hide activity panel"
              className="h-6 w-6 flex items-center justify-center rounded-[6px] hover:bg-foreground/5 transition-colors"
            >
              <PanelRightClose className="h-3.5 w-3.5 opacity-60" />
            </button>
          }
        />
      </div>
      {output && (
        <CodePreviewOverlay
          isOpen
          onClose={() => setOutput(null)}
          filePath={output.title}
          content={output.content}
          language="plaintext"
          mode="read"
          theme={resolvedMode === 'dark' ? 'dark' : 'light'}
        />
      )}
    </>
  )
}

/**
 * Mobile/tablet bottom drawer + summary-pill opener. Rendered into the input
 * zone area so it does not float over content. Hidden at >= 768px.
 */
export function OrchestrationMobileDrawer({ isCompact }: { isCompact: boolean }) {
  const data = useAtomValue(orchestrationItemsAtom)
  const { resolvedMode } = useTheme()
  const { output, setOutput, onViewOutput } = useViewOutput()
  const onSelect = useSelectItem()
  const [open, setOpen] = React.useState(false)

  if (!ORCHESTRATION_PANEL_ENABLED || !isCompact) return null
  // Nothing to show — don't render an empty pill.
  if (data.totalCount === 0) return null

  const pillLabel = data.runningCount > 0
    ? `${data.runningCount} running`
    : `${data.totalCount} recent`

  return (
    <>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium',
              'bg-background shadow-minimal hover:bg-foreground/5 transition-colors select-none',
            )}
          >
            <Activity className="h-3.5 w-3.5 opacity-70" />
            <span className="tabular-nums">{pillLabel}</span>
          </button>
        </DrawerTrigger>
        <DrawerContent className="max-h-[80vh]">
          <DrawerHeader className="flex flex-row items-center justify-between py-2">
            <DrawerTitle className="text-sm">Activity</DrawerTitle>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-7 w-7 flex items-center justify-center rounded-[6px] hover:bg-foreground/5"
            >
              <X className="h-4 w-4 opacity-60" />
            </button>
          </DrawerHeader>
          <div className="flex-1 min-h-0 overflow-hidden pb-[env(safe-area-inset-bottom)]">
            <OrchestrationPanel
              data={data}
              onViewOutput={onViewOutput}
              onSelect={(item) => {
                onSelect(item)
                setOpen(false)
              }}
              hideHeader
            />
          </div>
        </DrawerContent>
      </Drawer>
      {output && (
        <CodePreviewOverlay
          isOpen
          onClose={() => setOutput(null)}
          filePath={output.title}
          content={output.content}
          language="plaintext"
          mode="read"
          theme={resolvedMode === 'dark' ? 'dark' : 'light'}
        />
      )}
    </>
  )
}
