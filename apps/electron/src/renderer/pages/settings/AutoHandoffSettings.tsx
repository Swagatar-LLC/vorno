/**
 * AutoHandoffSettings (fork: PLAN-055, SUV-0073)
 *
 * Per-workspace card, rendered directly under each workspace's token-threshold
 * card in AI settings, for `defaults.autoHandoff`:
 *
 *   - enabled   — master switch (off by default)
 *   - prompt    — delivered into a session on its first `warn` crossing; may
 *                 mention skills as `[skill:slug]` or `@slug`; blank → default
 *   - status    — applied after the handoff turn completes (or leave unchanged)
 *   - archive   — archive the session after the handoff turn completes
 *
 * Persistence: one `updateWorkspaceSetting('autoHandoff', merged)` write per
 * change (toggles/select immediately, the prompt debounced), so the RPC's
 * validation — including "status must exist in this workspace" — is the only
 * gate. The host consumer (SUV-0072) re-reads the setting at fire time and at
 * completion time, so edits here take effect without a restart.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'
import {
  DEFAULT_AUTO_HANDOFF_PROMPT,
  AUTO_HANDOFF_PROMPT_MAX_LENGTH,
  normalizeAutoHandoffConfig,
  type AutoHandoffConfig,
} from '@craft-agent/shared/context-usage'

import { SettingsCard, SettingsSelect, SettingsTextarea, SettingsToggle } from '@/components/settings'
import { cn } from '@/lib/utils'
import { useWorkspaceIcon } from '@/hooks/useWorkspaceIcon'
import { useStatuses } from '@/hooks/useStatuses'
import type { Workspace } from '../../../shared/types'

interface Props {
  workspace: Workspace
}

/** Sentinel for "leave the status unchanged" — never persisted. */
const STATUS_UNCHANGED = '__unchanged__'
const PROMPT_SAVE_DEBOUNCE_MS = 600

export function WorkspaceAutoHandoffCard({ workspace }: Props) {
  const { t } = useTranslation()
  const iconUrl = useWorkspaceIcon(workspace)
  const { statuses } = useStatuses(workspace.id)

  const [isExpanded, setIsExpanded] = useState(false)
  const [config, setConfig] = useState<AutoHandoffConfig>({})
  const [isLoading, setIsLoading] = useState(true)
  // The textarea edits a local draft so every keystroke does not round-trip
  // the RPC; the draft is flushed on a short debounce.
  const [promptDraft, setPromptDraft] = useState('')
  const promptTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!window.electronAPI) return
    setIsLoading(true)
    void window.electronAPI.getWorkspaceSettings(workspace.id).then(ws => {
      if (cancelled) return
      const loaded = normalizeAutoHandoffConfig(ws?.autoHandoff) ?? {}
      setConfig(loaded)
      setPromptDraft(loaded.prompt ?? '')
    }).catch(err => {
      console.warn('[AutoHandoff] load failed:', err)
    }).finally(() => {
      if (!cancelled) setIsLoading(false)
    })
    return () => { cancelled = true }
  }, [workspace.id])

  const persist = useCallback(async (patch: Partial<AutoHandoffConfig>) => {
    if (!window.electronAPI) return
    const previous = config
    const next: AutoHandoffConfig = { ...previous, ...patch }
    // A blank status means "leave unchanged"; store it as absent.
    if (!next.status || next.status.trim() === '') delete next.status
    setConfig(next)
    try {
      await window.electronAPI.updateWorkspaceSetting(workspace.id, 'autoHandoff', next)
    } catch (err) {
      console.error('[AutoHandoff] save failed:', err)
      setConfig(previous)
      setPromptDraft(previous.prompt ?? '')
      toast.error(t('settings.ai.autoHandoff.saveFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [config, workspace.id, t])

  const onPromptChange = useCallback((value: string) => {
    setPromptDraft(value)
    if (promptTimer.current) clearTimeout(promptTimer.current)
    promptTimer.current = setTimeout(() => {
      promptTimer.current = null
      void persist({ prompt: value })
    }, PROMPT_SAVE_DEBOUNCE_MS)
  }, [persist])

  // Flush a pending prompt edit if the card unmounts mid-debounce.
  useEffect(() => () => {
    if (promptTimer.current) clearTimeout(promptTimer.current)
  }, [])

  const statusOptions = useMemo(() => [
    { value: STATUS_UNCHANGED, label: t('settings.ai.autoHandoff.statusNone') },
    ...statuses.map(s => ({ value: s.id, label: s.label })),
  ], [statuses, t])

  const enabled = config.enabled === true
  const statusLabel = config.status
    ? (statuses.find(s => s.id === config.status)?.label ?? config.status)
    : null

  const summary = isLoading
    ? t('common.loading')
    : !enabled
      ? t('settings.ai.autoHandoff.summaryOff')
      : [
          t('settings.ai.autoHandoff.summaryOn'),
          statusLabel ? t('settings.ai.autoHandoff.summaryStatus', { status: statusLabel }) : null,
          config.archive ? t('settings.ai.autoHandoff.summaryArchive') : null,
        ].filter(Boolean).join(' · ')

  return (
    <SettingsCard>
      <button
        type="button"
        onClick={() => setIsExpanded(v => !v)}
        className="w-full flex items-center justify-between py-3 px-4 hover:bg-foreground/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'w-6 h-6 rounded-full overflow-hidden bg-foreground/5 flex items-center justify-center',
              'ring-1 ring-border/50',
            )}
          >
            {iconUrl ? (
              <img src={iconUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-xs font-medium text-muted-foreground">
                {workspace.name?.charAt(0)?.toUpperCase() || 'W'}
              </span>
            )}
          </div>
          <div className="text-left">
            <div className="text-sm font-medium">
              {t('settings.ai.autoHandoff.cardTitle', { workspace: workspace.name })}
            </div>
            <div className="text-xs text-muted-foreground">{summary}</div>
          </div>
        </div>
        {isExpanded
          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
          : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50 divide-y divide-border/50">
              <SettingsToggle
                inCard
                label={t('settings.ai.autoHandoff.enabledLabel')}
                description={t('settings.ai.autoHandoff.enabledDesc')}
                checked={enabled}
                disabled={isLoading}
                onCheckedChange={(checked) => void persist({ enabled: checked })}
              />
              <div className="px-4 py-3">
                <SettingsTextarea
                  inCard
                  label={t('settings.ai.autoHandoff.promptLabel')}
                  description={t('settings.ai.autoHandoff.promptDesc')}
                  value={promptDraft}
                  onChange={onPromptChange}
                  placeholder={DEFAULT_AUTO_HANDOFF_PROMPT}
                  maxLength={AUTO_HANDOFF_PROMPT_MAX_LENGTH}
                  rows={6}
                  disabled={isLoading || !enabled}
                />
              </div>
              <div className="px-4 py-3">
                <SettingsSelect
                  inCard
                  label={t('settings.ai.autoHandoff.statusLabel')}
                  description={t('settings.ai.autoHandoff.statusDesc')}
                  value={config.status ?? STATUS_UNCHANGED}
                  onValueChange={(value) => void persist({ status: value === STATUS_UNCHANGED ? undefined : value })}
                  options={statusOptions}
                  disabled={isLoading || !enabled}
                />
              </div>
              <SettingsToggle
                inCard
                label={t('settings.ai.autoHandoff.archiveLabel')}
                description={t('settings.ai.autoHandoff.archiveDesc')}
                checked={config.archive === true}
                disabled={isLoading || !enabled}
                onCheckedChange={(checked) => void persist({ archive: checked })}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </SettingsCard>
  )
}
