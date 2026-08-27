/**
 * TokenUsageThresholdsSettings (PLAN-003)
 *
 * Per-workspace UI for configuring the green→yellow→burnt-orange thresholds
 * that drive the persistent context-usage indicator in the chat input zone.
 *
 * Structure (per workspace, expandable card):
 *   - One row per *provider* the workspace has at least one connection for,
 *     with `warn %` / `danger %` number inputs, a live preview bar, and a
 *     "Reset to defaults" button.
 *   - An expandable "Per-model overrides" section: same controls, one row
 *     per model the user can pick from any of those connections.
 *
 * Persistence keys: `tokenUsageThresholds` (provider map) and
 * `tokenUsageModelOverrides` (model map). Saved via the existing
 * `updateWorkspaceSetting` IPC; the renderer atom is updated locally so
 * the indicator re-renders live without round-tripping IPC.
 */

import { BACKEND_DISPLAY_NAME } from '@craft-agent/shared/branding'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'

import { SettingsCard } from '@/components/settings'
import { cn } from '@/lib/utils'
import { useWorkspaceIcon } from '@/hooks/useWorkspaceIcon'
import {
  USAGE_THRESHOLDS,
  USAGE_COLORS,
  computeContextUsage,
  type UsageThresholds,
  type UsageThresholdsSettings,
} from '@/components/chat/context-usage'
import { setTokenUsageThresholdsForWorkspaceAtom } from '@/atoms/token-usage-thresholds'
import { extractThresholdsSettings } from '@/hooks/useTokenUsageThresholds'
import { getModelShortName, type ModelDefinition } from '@config/models'
import { getModelsForProviderType } from '@config/llm-connections'
import type { LlmConnectionWithStatus, Workspace } from '../../../shared/types'

interface Props {
  workspace: Workspace
  llmConnections: LlmConnectionWithStatus[]
}

interface FieldErrors {
  warn?: string
  danger?: string
}

const FALLBACK: UsageThresholds = {
  warn: USAGE_THRESHOLDS.warn,
  danger: USAGE_THRESHOLDS.danger,
}

/** Render thresholds (fractions in 0..1) as integer percent strings for inputs. */
function toPercentString(t: UsageThresholds): { warn: string; danger: string } {
  return { warn: String(Math.round(t.warn * 100)), danger: String(Math.round(t.danger * 100)) }
}

/** Validate a percent-string pair. Returns parsed thresholds or per-field errors. */
function parsePercentInputs(
  warnRaw: string,
  dangerRaw: string,
  t: (k: string) => string,
): { ok: true; thresholds: UsageThresholds } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {}
  const warn = Number(warnRaw)
  const danger = Number(dangerRaw)
  if (!Number.isFinite(warn) || warn <= 0 || warn >= 100) {
    errors.warn = t('settings.ai.tokenThresholds.errorRange')
  }
  if (!Number.isFinite(danger) || danger <= 0 || danger >= 100) {
    errors.danger = t('settings.ai.tokenThresholds.errorRange')
  }
  if (Number.isFinite(warn) && Number.isFinite(danger) && warn >= danger) {
    errors.danger = t('settings.ai.tokenThresholds.errorOrder')
  }
  if (errors.warn || errors.danger) return { ok: false, errors }
  return { ok: true, thresholds: { warn: warn / 100, danger: danger / 100 } }
}

/**
 * Tiny preview bar mirroring the chat-input indicator. Shows a stacked
 * green / yellow / red gradient at the user's chosen percent boundaries.
 */
function ThresholdPreview({ thresholds }: { thresholds: UsageThresholds }) {
  const at40 = computeContextUsage(40, 100, thresholds)
  const at65 = computeContextUsage(65, 100, thresholds)
  const at90 = computeContextUsage(90, 100, thresholds)
  return (
    <div className="flex items-center gap-1.5">
      {[at40, at65, at90].map((u, i) => (
        <div
          key={i}
          className="relative h-1.5 w-10 rounded-full bg-foreground/10 overflow-hidden"
          aria-hidden="true"
          // The preview always passes a known window (100), so this is the
          // known arm in practice; the branch is what makes that safe rather
          // than assumed (fork: PLAN-040 / SUV-0028).
          title={
            u.denominatorKnown
              ? `${Math.round(u.fraction * 100)}% → ${u.level}`
              : `unknown → ${u.level}`
          }
        >
          <div
            className="absolute inset-y-0 left-0"
            style={{ width: `${u.barFraction * 100}%`, backgroundColor: u.color }}
          />
        </div>
      ))}
    </div>
  )
}

/**
 * Single editable threshold row. Calls `onSave` with the new pair (or `null`
 * to clear/reset) once the user blurs an input or hits the reset button.
 */
function ThresholdRow({
  label,
  sublabel,
  thresholds,
  isOverride,
  onSave,
  onReset,
}: {
  label: string
  sublabel?: string
  thresholds: UsageThresholds
  /** True when this row represents an explicit user override (so reset is enabled). */
  isOverride: boolean
  onSave: (next: UsageThresholds) => Promise<void> | void
  onReset: () => Promise<void> | void
}) {
  const { t } = useTranslation()
  const initial = toPercentString(thresholds)
  const [warnInput, setWarnInput] = useState(initial.warn)
  const [dangerInput, setDangerInput] = useState(initial.danger)
  const [errors, setErrors] = useState<FieldErrors>({})

  // Keep inputs in sync if the underlying value changes externally (e.g. reset).
  useEffect(() => {
    setWarnInput(initial.warn)
    setDangerInput(initial.danger)
    setErrors({})
    // initial.warn/danger derive from the `thresholds` prop, so this effect
    // intentionally depends on those fields rather than the memoized object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thresholds.warn, thresholds.danger])

  const commit = useCallback(async () => {
    const parsed = parsePercentInputs(warnInput, dangerInput, t)
    if (!parsed.ok) {
      setErrors(parsed.errors)
      return
    }
    setErrors({})
    if (parsed.thresholds.warn === thresholds.warn && parsed.thresholds.danger === thresholds.danger) {
      return // no change
    }
    await onSave(parsed.thresholds)
  }, [warnInput, dangerInput, thresholds.warn, thresholds.danger, onSave, t])

  // Live preview — uses the most recently *valid* thresholds, or the saved
  // value when the input is mid-edit and not yet valid.
  const previewThresholds = useMemo(() => {
    const parsed = parsePercentInputs(warnInput, dangerInput, t)
    return parsed.ok ? parsed.thresholds : thresholds
  }, [warnInput, dangerInput, thresholds, t])

  return (
    <div className="flex items-start justify-between gap-3 py-2.5 px-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{label}</div>
        {sublabel && <div className="text-xs text-muted-foreground truncate">{sublabel}</div>}
        <div className="mt-1.5">
          <ThresholdPreview thresholds={previewThresholds} />
        </div>
      </div>
      <div className="flex items-start gap-2 shrink-0">
        <div className="flex flex-col items-end">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{t('settings.ai.tokenThresholds.warn')}</span>
            <input
              type="number"
              min={1}
              max={99}
              value={warnInput}
              onChange={e => setWarnInput(e.target.value)}
              onBlur={() => { void commit() }}
              className={cn(
                'w-14 h-7 px-1.5 rounded-[4px] bg-background text-sm tabular-nums text-right',
                'border border-border focus:outline-none focus:ring-1 focus:ring-ring',
                errors.warn && 'border-destructive focus:ring-destructive',
              )}
              aria-invalid={!!errors.warn}
              aria-label={t('settings.ai.tokenThresholds.warn')}
            />
            <span aria-hidden="true">%</span>
          </label>
          {errors.warn && <div className="text-[11px] text-destructive mt-0.5">{errors.warn}</div>}
        </div>
        <div className="flex flex-col items-end">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{t('settings.ai.tokenThresholds.danger')}</span>
            <input
              type="number"
              min={1}
              max={99}
              value={dangerInput}
              onChange={e => setDangerInput(e.target.value)}
              onBlur={() => { void commit() }}
              className={cn(
                'w-14 h-7 px-1.5 rounded-[4px] bg-background text-sm tabular-nums text-right',
                'border border-border focus:outline-none focus:ring-1 focus:ring-ring',
                errors.danger && 'border-destructive focus:ring-destructive',
              )}
              aria-invalid={!!errors.danger}
              aria-label={t('settings.ai.tokenThresholds.danger')}
            />
            <span aria-hidden="true">%</span>
          </label>
          {errors.danger && <div className="text-[11px] text-destructive mt-0.5">{errors.danger}</div>}
        </div>
        <button
          type="button"
          onClick={() => { void onReset() }}
          disabled={!isOverride}
          className={cn(
            'h-7 w-7 rounded-[4px] inline-flex items-center justify-center text-muted-foreground',
            'hover:bg-foreground/[0.05] disabled:opacity-30 disabled:cursor-not-allowed',
          )}
          aria-label={t('settings.ai.tokenThresholds.reset')}
          title={t('settings.ai.tokenThresholds.reset')}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

/**
 * Build the unique list of (providerType, modelId) pairs reachable from
 * a workspace's connections. Used to populate the per-model overrides list.
 */
function deriveProviderModelPairs(
  connections: LlmConnectionWithStatus[],
): Array<{ providerId: string; modelId: string; modelLabel: string; connectionName: string }> {
  const seen = new Set<string>()
  const out: Array<{ providerId: string; modelId: string; modelLabel: string; connectionName: string }> = []
  for (const conn of connections) {
    const providerId = conn.providerType
    if (!providerId) continue
    let modelIds: Array<{ id: string; name?: string }> = []
    if (conn.models && conn.models.length > 0) {
      modelIds = conn.models.map((m: string | ModelDefinition) =>
        typeof m === 'string' ? { id: m } : { id: m.id, name: m.name },
      )
    } else {
      const registryModels = getModelsForProviderType(conn.providerType, conn.piAuthProvider)
      modelIds = registryModels.map(m => ({ id: m.id, name: m.name }))
    }
    for (const m of modelIds) {
      const key = `${providerId}::${m.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        providerId,
        modelId: m.id,
        modelLabel: m.name ?? getModelShortName(m.id),
        connectionName: conn.name,
      })
    }
  }
  return out
}

function providerLabel(providerId: string): string {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic'
    case 'pi':
      return BACKEND_DISPLAY_NAME
    case 'pi_compat':
      return `${BACKEND_DISPLAY_NAME} (Compat)`
    default:
      return providerId
  }
}

export function WorkspaceTokenThresholdsCard({ workspace, llmConnections }: Props) {
  const { t } = useTranslation()
  const setTokenSettingsForWorkspace = useSetAtom(setTokenUsageThresholdsForWorkspaceAtom)
  const iconUrl = useWorkspaceIcon(workspace)

  const [isExpanded, setIsExpanded] = useState(false)
  const [showModels, setShowModels] = useState(false)
  const [settings, setSettings] = useState<UsageThresholdsSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Load workspace settings on mount and when workspace changes.
  useEffect(() => {
    let cancelled = false
    if (!window.electronAPI) return
    setIsLoading(true)
    void window.electronAPI.getWorkspaceSettings(workspace.id).then(ws => {
      if (cancelled) return
      const extracted = extractThresholdsSettings(ws)
      setSettings(extracted)
      setTokenSettingsForWorkspace({ workspaceId: workspace.id, settings: extracted })
    }).finally(() => {
      if (!cancelled) setIsLoading(false)
    })
    return () => { cancelled = true }
  }, [workspace.id, setTokenSettingsForWorkspace])

  const workspaceConnections = useMemo(
    () => llmConnections, // workspace-scoped LLM connections aren't a per-workspace concept yet; show all
    [llmConnections],
  )

  // Unique providers represented in this workspace's connections.
  const providers = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const c of workspaceConnections) {
      if (c.providerType && !seen.has(c.providerType)) {
        seen.add(c.providerType)
        out.push(c.providerType)
      }
    }
    return out
  }, [workspaceConnections])

  const modelPairs = useMemo(() => deriveProviderModelPairs(workspaceConnections), [workspaceConnections])

  // Persist a partial change to either the provider map or the model map.
  const persist = useCallback(async (
    field: 'tokenUsageThresholds' | 'tokenUsageModelOverrides',
    nextMap: Record<string, UsageThresholds> | undefined,
  ) => {
    if (!window.electronAPI) return
    try {
      await window.electronAPI.updateWorkspaceSetting(workspace.id, field, nextMap)
      const merged: UsageThresholdsSettings = {
        byProvider: field === 'tokenUsageThresholds'
          ? nextMap
          : settings?.byProvider,
        byModel: field === 'tokenUsageModelOverrides'
          ? nextMap
          : settings?.byModel,
      }
      const cleaned = (merged.byProvider || merged.byModel) ? merged : null
      setSettings(cleaned)
      setTokenSettingsForWorkspace({ workspaceId: workspace.id, settings: cleaned })
    } catch (err) {
      console.error('[TokenThresholds] save failed:', err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      toast.error(t('settings.ai.tokenThresholds.saveFailed'), { description: message })
    }
  }, [workspace.id, settings?.byProvider, settings?.byModel, setTokenSettingsForWorkspace, t])

  const updateProvider = useCallback(async (providerId: string, next: UsageThresholds | null) => {
    const current = settings?.byProvider ?? {}
    const nextMap: Record<string, UsageThresholds> = { ...current }
    if (next) nextMap[providerId] = next
    else delete nextMap[providerId]
    await persist('tokenUsageThresholds', Object.keys(nextMap).length ? nextMap : undefined)
  }, [settings?.byProvider, persist])

  const updateModel = useCallback(async (modelId: string, next: UsageThresholds | null) => {
    const current = settings?.byModel ?? {}
    const nextMap: Record<string, UsageThresholds> = { ...current }
    if (next) nextMap[modelId] = next
    else delete nextMap[modelId]
    await persist('tokenUsageModelOverrides', Object.keys(nextMap).length ? nextMap : undefined)
  }, [settings?.byModel, persist])

  const overrideCount =
    Object.keys(settings?.byProvider ?? {}).length +
    Object.keys(settings?.byModel ?? {}).length

  const summary = isLoading
    ? t('common.loading')
    : overrideCount === 0
      ? t('settings.ai.tokenThresholds.usingDefaults')
      : t('settings.ai.tokenThresholds.overrideCount', { count: overrideCount })

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
            <div className="text-sm font-medium">{workspace.name}</div>
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
            <div className="border-t border-border/50">
              {/* Legend / explanation */}
              <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border/50">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: USAGE_COLORS.ok }} />
                  {t('settings.ai.tokenThresholds.legendOk')}
                </span>
                <span className="mx-2">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: USAGE_COLORS.warn }} />
                  {t('settings.ai.tokenThresholds.legendWarn')}
                </span>
                <span className="mx-2">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: USAGE_COLORS.danger }} />
                  {t('settings.ai.tokenThresholds.legendDanger')}
                </span>
              </div>

              {/* Provider rows */}
              {providers.length === 0 ? (
                <div className="px-4 py-4 text-sm text-muted-foreground">
                  {t('settings.ai.tokenThresholds.noProviders')}
                </div>
              ) : (
                providers.map(providerId => {
                  const override = settings?.byProvider?.[providerId]
                  const effective = override ?? FALLBACK
                  return (
                    <ThresholdRow
                      key={providerId}
                      label={providerLabel(providerId)}
                      sublabel={!override ? t('settings.ai.tokenThresholds.usingDefaultsRow') : undefined}
                      thresholds={effective}
                      isOverride={!!override}
                      onSave={(next) => updateProvider(providerId, next)}
                      onReset={() => updateProvider(providerId, null)}
                    />
                  )
                })
              )}

              {/* Per-model overrides expander */}
              {modelPairs.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowModels(v => !v)}
                    className="w-full flex items-center justify-between py-2 px-4 text-xs text-muted-foreground hover:bg-foreground/[0.02] border-t border-border/50"
                  >
                    <span>{t('settings.ai.tokenThresholds.perModelOverrides')}</span>
                    {showModels
                      ? <ChevronDown className="h-3.5 w-3.5" />
                      : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                  <AnimatePresence initial={false}>
                    {showModels && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                        className="overflow-hidden"
                      >
                        {modelPairs.map(({ providerId, modelId, modelLabel, connectionName }) => {
                          const modelOverride = settings?.byModel?.[modelId]
                          const providerOverride = settings?.byProvider?.[providerId]
                          const effective = modelOverride ?? providerOverride ?? FALLBACK
                          const sublabel = modelOverride
                            ? `${connectionName} · ${providerLabel(providerId)}`
                            : providerOverride
                              ? `${connectionName} · ${t('settings.ai.tokenThresholds.usingProviderDefault')}`
                              : `${connectionName} · ${t('settings.ai.tokenThresholds.usingDefaultsRow')}`
                          return (
                            <ThresholdRow
                              key={`${providerId}::${modelId}`}
                              label={modelLabel}
                              sublabel={sublabel}
                              thresholds={effective}
                              isOverride={!!modelOverride}
                              onSave={(next) => updateModel(modelId, next)}
                              onReset={() => updateModel(modelId, null)}
                            />
                          )
                        })}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </SettingsCard>
  )
}
