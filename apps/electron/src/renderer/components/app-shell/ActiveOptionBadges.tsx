import * as React from 'react'
import { useTranslation } from "react-i18next"
import { useAtomValue } from 'jotai'
import { Command as CommandPrimitive } from 'cmdk'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SlashCommandMenu, DEFAULT_SLASH_COMMAND_GROUPS, type SlashCommandId } from '@/components/ui/slash-command-menu'
import { ChevronDown, Info, FolderKanban, Ban } from 'lucide-react'
import { projectsAtom } from '@/atoms/projects'
import { sessionMetaMapAtom, activeSessionIdAtom } from '@/atoms/sessions'
import { useAction } from '@/actions/useAction'
import { PERMISSION_MODE_CONFIG, type PermissionMode } from '@craft-agent/shared/agent/modes'
import { ActiveTasksBar, type BackgroundTask } from './ActiveTasksBar'
import type { TerminalOverlayData } from './TaskActionMenu'
import { LabelIcon, LabelValueTypeIcon } from '@/components/ui/label-icon'
import { LabelValuePopover } from '@/components/ui/label-value-popover'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { flattenLabels, parseLabelEntry, formatLabelEntry, formatDisplayValue } from '@craft-agent/shared/labels'
import { resolveEntityColor } from '@craft-agent/shared/colors'
import { useTheme } from '@/context/ThemeContext'
import { useDynamicStack } from '@/hooks/useDynamicStack'
import type { SessionStatus } from '@/config/session-status-config'
import { getState } from '@/config/session-status-config'
import { SessionStatusMenu } from '@/components/ui/session-status-menu'
import { MetadataBadge } from '@/components/ui/metadata-badge'
import { openLabelLink } from '@/lib/open-label-link'
import { SessionInfoPopover } from './SessionInfoPopover'

// ============================================================================
// Permission Mode Icon Component
// ============================================================================

function PermissionModeIcon({ mode, className }: { mode: PermissionMode; className?: string }) {
  const config = PERMISSION_MODE_CONFIG[mode]
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={config.svgPath} />
    </svg>
  )
}

export interface ActiveOptionBadgesProps {
  /** Current permission mode */
  permissionMode?: PermissionMode
  /** Callback when permission mode changes */
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Background tasks to display */
  tasks?: BackgroundTask[]
  /** Session ID for opening preview windows */
  sessionId?: string
  /** Absolute path to the session folder (for Files header actions) */
  sessionFolderPath?: string
  /** Callback when kill button is clicked on a task */
  onKillTask?: (taskId: string) => void
  /** Callback to insert message into input field */
  onInsertMessage?: (text: string) => void
  /** Callback to show a task's output in a terminal overlay (optional) */
  onShowTerminalOverlay?: (data: TerminalOverlayData) => void
  /** Label entries applied to this session (e.g., ["bug", "priority::3"]) */
  sessionLabels?: string[]
  /** Available label configs (tree structure) for resolving label display */
  labels?: LabelConfig[]
  /** Callback when a label is removed (legacy — prefer onLabelsChange) */
  onRemoveLabel?: (labelId: string) => void
  /** Callback when session labels array changes (value edits or removals) */
  onLabelsChange?: (updatedLabels: string[]) => void
  /** Label ID whose value popover should auto-open (set when a valued label is added via # menu) */
  autoOpenLabelId?: string | null
  /** Called after the auto-open has been consumed, so the parent can clear the signal */
  onAutoOpenConsumed?: () => void
  // ── State/status badge (in dynamic stack) ──
  /** Available workflow states */
  sessionStatuses?: SessionStatus[]
  /** Current session state ID */
  currentSessionStatus?: string
  /** Callback when state changes */
  onSessionStatusChange?: (stateId: string) => void
  /** Additional CSS classes */
  className?: string
}

/** Resolved label entry: config + parsed value + original index in sessionLabels */
interface ResolvedLabelEntry {
  config: LabelConfig
  rawValue?: string
  index: number
}

export function ActiveOptionBadges({
  permissionMode = 'ask',
  onPermissionModeChange,
  tasks = [],
  sessionId,
  sessionFolderPath,
  onKillTask,
  onInsertMessage,
  onShowTerminalOverlay,
  sessionLabels = [],
  labels = [],
  onRemoveLabel,
  onLabelsChange,
  autoOpenLabelId,
  onAutoOpenConsumed,
  sessionStatuses = [],
  currentSessionStatus,
  onSessionStatusChange,
  className,
}: ActiveOptionBadgesProps) {
  // Resolve session label entries to their config objects + parsed values.
  // Entries may be bare IDs ("bug") or valued ("priority::3").
  // Preserves the raw value and original index for editing/removal.
  const resolvedLabels = React.useMemo((): ResolvedLabelEntry[] => {
    if (sessionLabels.length === 0 || labels.length === 0) return []
    const flat = flattenLabels(labels)
    const result: ResolvedLabelEntry[] = []
    for (let i = 0; i < sessionLabels.length; i++) {
      const parsed = parseLabelEntry(sessionLabels[i])
      const config = flat.find(l => l.id === parsed.id)
      if (config) {
        result.push({ config, rawValue: parsed.rawValue, index: i })
      }
    }
    return result
  }, [sessionLabels, labels])

  const hasLabels = resolvedLabels.length > 0

  // Resolve the current state from sessionStatuses for the badge display.
  // Every session always has a state — fall back to the default state (or 'todo')
  // when currentSessionStatus isn't explicitly set, matching SessionList's behavior.
  const effectiveStateId = currentSessionStatus || 'todo'
  const resolvedState = sessionStatuses.length > 0 ? getState(effectiveStateId, sessionStatuses) : undefined
  const hasState = !!resolvedState

  // Show the stacking container when there are labels (state badge is now rendered standalone on the left)
  const hasStackContent = hasLabels

  // Dynamic stacking with equal visible strips: ResizeObserver computes per-badge
  // margins directly on children. Wider badges get more negative margins so each
  // shows the same visible strip when stacked. No React re-renders needed.
  const stackRef = useDynamicStack({ gap: 8, minVisible: 20, reservedStart: 0 })

  // Only render if badges or tasks are active
  if (!permissionMode && tasks.length === 0 && !hasState && !hasStackContent) {
    return null
  }

  return (
    <>
      {/* Background tasks row — running / done / orphaned chips. Rendered above the
       * options row so a growing number of tasks wraps without disturbing the
       * mode/label badges. Only present when there are active/recent tasks. */}
      {tasks.length > 0 && sessionId && (
        <div className="flex items-center flex-wrap gap-2 mb-2 px-px">
          <ActiveTasksBar
            tasks={tasks}
            sessionId={sessionId}
            onKillTask={onKillTask}
            onInsertMessage={onInsertMessage}
            onShowTerminalOverlay={onShowTerminalOverlay}
          />
        </div>
      )}

    <div className={cn("flex items-start gap-2 mb-2 px-px pt-px pb-0.5", className)}>
      {/* Left side: mode → state → labels stack */}
      <div className="flex items-start gap-2 min-w-0 flex-1">
        {/* Permission Mode Badge */}
        {permissionMode && (
          <div className="shrink-0">
            <PermissionModeDropdown
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              sessionId={sessionId}
            />
          </div>
        )}

        {/* State Badge — standalone on the left, after Mode */}
        {hasState && resolvedState && (
          <div className="shrink-0">
            <StateBadge
              state={resolvedState}
              sessionStatuses={sessionStatuses}
              onSessionStatusChange={onSessionStatusChange}
              sessionId={sessionId}
            />
          </div>
        )}

        {/* Project Badge (PLAN-021) — add/move/remove the session's project, after State */}
        {sessionId && (
          <div className="shrink-0">
            <ProjectBadge sessionId={sessionId} />
          </div>
        )}

        {/* Stacking container for label badges (left side).
         * useDynamicStack sets per-child marginLeft directly via ResizeObserver.
         * overflow: clip prevents scroll container while py/-my gives shadow room. */}
        {hasStackContent && (
          <div
            className="flex-1 min-w-0 max-w-full py-0.5 -my-0.5"
            style={{
              // shadow-minimal replicated as drop-shadow (traces masked alpha, no clipping).
              // Ring uses higher blur+opacity for visible border feel (hard 1px ring can't be replicated exactly).
              // Blur shadows use reduced blur+opacity to stay tight (accounting for no negative spread in drop-shadow).
              filter: 'drop-shadow(0px 0px 0.5px rgba(var(--foreground-rgb), 0.3)) drop-shadow(0px 1px 0.1px rgba(0,0,0,0.04)) drop-shadow(0px 3px 0.2px rgba(0,0,0,0.03))',
            }}
          >
            <div
              ref={stackRef}
              className="flex items-center min-w-0 py-1 -my-1"
              style={{ overflow: 'clip' }}
            >
              {/* Label badges */}
              {resolvedLabels.map(({ config, rawValue, index }) => (
                <LabelBadge
                  key={`${config.id}-${index}`}
                  label={config}
                  value={rawValue}
                  autoOpen={config.id === autoOpenLabelId}
                  onAutoOpenConsumed={onAutoOpenConsumed}
                  sessionId={sessionId}
                  onValueChange={(newValue) => {
                    // Rebuild the sessionLabels array with the updated entry
                    const updated = [...sessionLabels]
                    updated[index] = formatLabelEntry(config.id, newValue)
                    onLabelsChange?.(updated)
                  }}
                  onRemove={() => {
                    if (onLabelsChange) {
                      onLabelsChange(sessionLabels.filter((_, i) => i !== index))
                    } else {
                      onRemoveLabel?.(config.id)
                    }
                  }}
                />
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Right side: Files popover button */}
      <div className="shrink-0">
        <FilesPopoverButton sessionId={sessionId} sessionFolderPath={sessionFolderPath} />
      </div>
    </div>
    </>
  )
}

// ============================================================================
// Label Badge Component
// ============================================================================

/**
 * Renders a single label badge with LabelValuePopover for editing/removal.
 * No box-shadow on the badge itself — all shadows come from the parent
 * wrapper's drop-shadow filter (traces masked alpha without clipping).
 * Shows: [color circle] [name] [· value in mono] [chevron]
 */
function LabelBadge({
  label,
  value,
  autoOpen,
  onAutoOpenConsumed,
  onValueChange,
  onRemove,
  sessionId,
}: {
  label: LabelConfig
  value?: string
  /** When true, auto-open the value popover on mount (for newly added valued labels) */
  autoOpen?: boolean
  onAutoOpenConsumed?: () => void
  onValueChange?: (newValue: string | undefined) => void
  onRemove: () => void
  sessionId?: string
}) {
  const { isDark } = useTheme()
  const [open, setOpen] = React.useState(false)

  // Auto-open the value popover when this label was just added via # menu
  // and has a valueType. Opens exactly once, then clears the signal.
  React.useEffect(() => {
    if (autoOpen && label.valueType) {
      setOpen(true)
      onAutoOpenConsumed?.()
    }
  }, [autoOpen, label.valueType, onAutoOpenConsumed])

  // Resolve label color for tinting background and text via CSS color-mix
  const resolvedColor = label.color
    ? resolveEntityColor(label.color, isDark)
    : 'var(--foreground)'

  const displayValue = value ? formatDisplayValue(value, label.valueType) : undefined

  return (
    <LabelValuePopover
      label={label}
      value={value}
      open={open}
      onOpenChange={setOpen}
      onValueChange={onValueChange}
      onRemove={onRemove}
      sessionId={sessionId}
    >
      <MetadataBadge
        label={label.name}
        value={displayValue}
        onValueClick={label.valueType === 'link' && value ? () => openLabelLink(value) : undefined}
        icon={<LabelIcon label={label} size="lg" />}
        valueHintIcon={label.valueType ? <LabelValueTypeIcon valueType={label.valueType} /> : undefined}
        badgeColor={resolvedColor}
        interactive
        isActive={open}
        showChevron
        shadow="none"
        className="relative"
      />
    </LabelValuePopover>
  )
}

// ============================================================================
// State Badge Component
// ============================================================================

/**
 * Renders the current workflow state as a badge in the dynamic stacking container.
 * Click opens a SessionStatusMenu popover for changing the state.
 * Styled consistently with label badges (h-[30px], rounded-[8px], color-mix tinting).
 */
function StateBadge({
  state,
  sessionStatuses,
  onSessionStatusChange,
  sessionId,
}: {
  state: SessionStatus
  sessionStatuses: SessionStatus[]
  onSessionStatusChange?: (stateId: string) => void
  sessionId?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  const handleSelect = React.useCallback((stateId: string) => {
    setOpen(false)
    onSessionStatusChange?.(stateId)
  }, [onSessionStatusChange])

  // Use the state's resolved color for tinting (same color-mix pattern as labels)
  const badgeColor = state.resolvedColor || 'var(--foreground)'
  const applyColor = state.iconColorable

  const DEFAULT_STATUS_IDS = new Set(['backlog', 'todo', 'needs-review', 'done', 'cancelled'])
  const stateLabel = DEFAULT_STATUS_IDS.has(state.id) ? t(`status.${state.id}`, state.label) : state.label

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <MetadataBadge
          label={stateLabel}
          badgeColor={badgeColor}
          interactive
          isActive={open}
          showChevron
          icon={(
            <span
              className="shrink-0 flex items-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full [&>img]:w-full [&>img]:h-full [&>span]:text-xs"
              style={applyColor ? { color: state.resolvedColor } : undefined}
            >
              {state.icon}
            </span>
          )}
          className="pl-2.5"
        />
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 border-0 shadow-none bg-transparent"
        side="top"
        align="end"
        sideOffset={4}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('craft:focus-input', {
            detail: { sessionId }
          }))
        }}
      >
        <SessionStatusMenu
          activeState={state.id}
          onSelect={handleSelect}
          states={sessionStatuses}
        />
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// Project Badge Component (PLAN-021)
// ============================================================================

const PROJECT_MENU_CONTAINER = 'min-w-[180px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const PROJECT_MENU_LIST = 'max-h-[240px] overflow-y-auto p-1 [&_[cmdk-list-sizer]]:space-y-px'
const PROJECT_MENU_ITEM = 'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-1.5 text-[13px] outline-none'

/**
 * Renders the session's project as a badge alongside the mode/state badges.
 * Click (or the `chat.assignProject` action, default mod+shift+p) opens a
 * filterable menu of workspace projects plus "No project" — add, move, or
 * remove the session's project binding in one place. Reads `projectsAtom` and
 * `sessionMetaMapAtom` directly (same pattern as ToolbarStatusSlot) instead of
 * threading props through ChatDisplay → ChatInputZone.
 */
function ProjectBadge({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const [open, setOpen] = React.useState(false)
  const projects = useAtomValue(projectsAtom)
  const metaMap = useAtomValue(sessionMetaMapAtom)
  const activeSessionId = useAtomValue(activeSessionIdAtom)

  const boundProjectId = metaMap.get(sessionId)?.projectId
  // Optimistic override so the badge updates before the meta refresh lands.
  const [optimisticId, setOptimisticId] = React.useState<string | null | undefined>(undefined)
  React.useEffect(() => {
    setOptimisticId(undefined) // reset optimism whenever backend meta changes
  }, [boundProjectId])
  const effectiveId = optimisticId !== undefined ? optimisticId : (boundProjectId ?? null)
  const currentProject = effectiveId ? projects.find(p => p.config.id === effectiveId) : undefined

  // Keyboard shortcut: only the active session's badge responds.
  useAction(
    'chat.assignProject',
    () => setOpen(true),
    { enabled: () => activeSessionId === sessionId },
    [activeSessionId, sessionId],
  )

  const handleSelect = React.useCallback(async (projectId: string | null) => {
    setOpen(false)
    setOptimisticId(projectId)
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setProjectId', projectId })
    } catch (err) {
      console.error('[ProjectBadge] Failed to update session project:', err)
      setOptimisticId(undefined)
    }
  }, [sessionId])

  // Hide entirely when the workspace has no projects and the session isn't bound
  // to one (nothing actionable) — keeps the toolbar clean for project-less users.
  if (projects.length === 0 && !currentProject) return null

  const badgeColor = currentProject?.config.color
    ? resolveEntityColor(currentProject.config.color, isDark)
    : 'var(--foreground)'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <MetadataBadge
          label={currentProject?.config.name ?? t('sessionMenu.noProject')}
          badgeColor={badgeColor}
          interactive
          isActive={open}
          showChevron
          icon={<FolderKanban className="h-3.5 w-3.5" style={currentProject ? { color: badgeColor } : undefined} />}
          className={cn('pl-2.5', !currentProject && 'opacity-70')}
        />
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 border-0 shadow-none bg-transparent"
        side="top"
        align="end"
        sideOffset={4}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('craft:focus-input', { detail: { sessionId } }))
        }}
      >
        <ProjectMenu
          projects={projects.map(p => ({ id: p.config.id, name: p.config.name, color: p.config.color }))}
          activeProjectId={effectiveId}
          onSelect={handleSelect}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Filterable project list menu (cmdk) — visual twin of SessionStatusMenu.
 */
function ProjectMenu({
  projects,
  activeProjectId,
  onSelect,
}: {
  projects: { id: string; name: string; color?: string }[]
  activeProjectId: string | null
  onSelect: (projectId: string | null) => void
}) {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const [filter, setFilter] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [])

  return (
    <CommandPrimitive className={PROJECT_MENU_CONTAINER} defaultValue={activeProjectId ?? projects[0]?.id}>
      <div className="border-b border-border/50 px-3 py-2">
        <CommandPrimitive.Input
          ref={inputRef}
          value={filter}
          onValueChange={setFilter}
          placeholder={t('sessionMenu.projects')}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
        />
      </div>
      <CommandPrimitive.List className={PROJECT_MENU_LIST}>
        <CommandPrimitive.Empty className="py-3 text-center text-sm text-muted-foreground">
          {t('projectInfo.notFound')}
        </CommandPrimitive.Empty>
        {projects.map((p) => {
          const isActive = activeProjectId === p.id
          const color = p.color ? resolveEntityColor(p.color, isDark) : undefined
          return (
            <CommandPrimitive.Item
              key={p.id}
              value={p.name}
              onSelect={() => onSelect(p.id)}
              className={cn(PROJECT_MENU_ITEM, isActive ? 'bg-foreground/7' : 'data-[selected=true]:bg-foreground/3')}
            >
              <span className="shrink-0 flex items-center" style={color ? { color } : undefined}>
                <FolderKanban className="w-3.5 h-3.5" />
              </span>
              <div className="flex-1 min-w-0">{p.name}</div>
            </CommandPrimitive.Item>
          )
        })}
        {!filter && (
          <>
            <div className="border-t border-border/50 mx-2 my-1" />
            <CommandPrimitive.Item
              value="no-project"
              onSelect={() => onSelect(null)}
              className={cn(PROJECT_MENU_ITEM, activeProjectId === null ? 'bg-foreground/7' : 'data-[selected=true]:bg-foreground/3')}
            >
              <span className="shrink-0 flex items-center opacity-60">
                <Ban className="w-3.5 h-3.5" />
              </span>
              <div className="flex-1 min-w-0">{t('sessionMenu.noProject')}</div>
            </CommandPrimitive.Item>
          </>
        )}
      </CommandPrimitive.List>
    </CommandPrimitive>
  )
}

function FilesPopoverButton({ sessionId, sessionFolderPath }: { sessionId?: string; sessionFolderPath?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  if (!sessionId) return null

  return (
    <SessionInfoPopover
      sessionId={sessionId}
      sessionFolderPath={sessionFolderPath}
      trigger={(
        <button
          type="button"
          className={cn(
            "h-[30px] pl-[12px] pr-[14px] text-xs font-medium rounded-[8px] flex items-center gap-1.5 shrink-0",
            "outline-none select-none transition-colors shadow-minimal",
            "hover:bg-foreground/5 data-[state=open]:bg-foreground/5",
            "bg-[color-mix(in_srgb,var(--background)_97%,var(--foreground)_3%)]",
            "text-foreground/80",
          )}
        >
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-nowrap">{t("common.info")}</span>
        </button>
      )}
    />
  )
}

interface PermissionModeDropdownProps {
  permissionMode: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  sessionId?: string
}

function PermissionModeDropdown({ permissionMode, onPermissionModeChange, sessionId }: PermissionModeDropdownProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  // Optimistic local state - updates immediately, syncs with prop
  const [optimisticMode, setOptimisticMode] = React.useState(permissionMode)

  // Sync optimistic state when prop changes (confirmation from backend)
  React.useEffect(() => {
    setOptimisticMode(permissionMode)
  }, [permissionMode])

  const activeCommands = React.useMemo((): SlashCommandId[] => {
    return [optimisticMode as SlashCommandId]
  }, [optimisticMode])

  // Handle command selection from dropdown
  const handleSelect = React.useCallback((commandId: SlashCommandId) => {
    if (commandId === 'safe' || commandId === 'ask' || commandId === 'allow-all') {
      setOptimisticMode(commandId)
      onPermissionModeChange?.(commandId)
    }
    setOpen(false)
  }, [onPermissionModeChange])

  // Get config for current mode (use optimistic state for instant UI update)
  const config = PERMISSION_MODE_CONFIG[optimisticMode]

  // Mode-specific styling using CSS variables (theme-aware)
  // - safe (Explore): foreground at 60% opacity - subtle, read-only feel
  // - ask (Ask to Edit): info color - amber, prompts for edits
  // - allow-all (Auto): accent color - purple, full autonomy
  const modeStyles: Record<PermissionMode, { className: string; shadowVar: string }> = {
    'safe': {
      className: 'bg-foreground/5 text-foreground/60',
      shadowVar: 'var(--foreground-rgb)',
    },
    'ask': {
      className: 'bg-info/10 text-info',
      shadowVar: 'var(--info-rgb)',
    },
    'allow-all': {
      className: 'bg-accent/5 text-accent',
      shadowVar: 'var(--accent-rgb)',
    },
  }
  const currentStyle = modeStyles[optimisticMode]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-tutorial="permission-mode-dropdown"
          className={cn(
            "h-[30px] pl-2.5 pr-2 text-xs font-medium rounded-[8px] flex items-center gap-1.5 shadow-tinted outline-none select-none",
            currentStyle.className
          )}
          style={{ '--shadow-color': currentStyle.shadowVar } as React.CSSProperties}
        >
          <PermissionModeIcon mode={optimisticMode} className="h-3.5 w-3.5" />
          <span>{t(`mode.${optimisticMode}`)}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 rounded-[8px] bg-background text-foreground shadow-modal-small"
        side="top"
        align="start"
        sideOffset={4}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          // Don't auto-focus the text input on touch devices — it pulls up the virtual keyboard
          const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
          if (!isTouchDevice) {
            window.dispatchEvent(new CustomEvent('craft:focus-input', {
              detail: { sessionId }
            }))
          }
        }}
      >
        <SlashCommandMenu
          commandGroups={DEFAULT_SLASH_COMMAND_GROUPS}
          activeCommands={activeCommands}
          onSelect={handleSelect}
          showFilter
        />
      </PopoverContent>
    </Popover>
  )
}

