/**
 * Renderer-side hook for workspace token-usage threshold settings (PLAN-003).
 *
 * Lazy-loads the active workspace's threshold settings on first use and
 * caches them in `tokenUsageThresholdsByWorkspaceAtom`. Returns the
 * resolved thresholds for a `(providerId, modelId)` tuple.
 *
 * Live updates: the AI settings page mutates the same atom directly when
 * the user edits a threshold, so the indicator re-renders without round
 * tripping through IPC.
 */

import { useEffect, useMemo } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  tokenUsageThresholdsByWorkspaceAtom,
  setTokenUsageThresholdsForWorkspaceAtom,
} from '@/atoms/token-usage-thresholds'
import {
  resolveThresholds,
  USAGE_THRESHOLDS,
  type UsageThresholds,
  type UsageThresholdsSettings,
} from '@/components/chat/context-usage'

/**
 * Pull `(byProvider, byModel)` out of a `WorkspaceSettings`-shaped DTO.
 * Tolerant of missing/null fields; returns `null` if neither is present.
 */
export function extractThresholdsSettings(
  raw: { tokenUsageThresholds?: Record<string, UsageThresholds>; tokenUsageModelOverrides?: Record<string, UsageThresholds> } | null | undefined,
): UsageThresholdsSettings | null {
  if (!raw) return null
  const byProvider = raw.tokenUsageThresholds
  const byModel = raw.tokenUsageModelOverrides
  if (!byProvider && !byModel) return null
  return {
    byProvider: byProvider ?? undefined,
    byModel: byModel ?? undefined,
  }
}

/**
 * Resolve effective thresholds for the given `(providerId, modelId)` tuple
 * from the active workspace's settings. Falls back to `USAGE_THRESHOLDS`
 * (60% / 80%) when no workspace is active or settings haven't loaded yet.
 */
export function useTokenUsageThresholds(args: {
  workspaceId?: string | null
  providerId?: string | null
  modelId?: string | null
}): UsageThresholds {
  const { workspaceId, providerId, modelId } = args
  const [settingsByWorkspace] = useAtom(tokenUsageThresholdsByWorkspaceAtom)
  const setForWorkspace = useSetAtom(setTokenUsageThresholdsForWorkspaceAtom)

  // Lazy-load this workspace's settings the first time we see it.
  useEffect(() => {
    if (!workspaceId) return
    if (workspaceId in settingsByWorkspace) return // already loaded (or loading)
    let cancelled = false

    // Mark as loading immediately so we don't fire duplicate loads.
    setForWorkspace({ workspaceId, settings: null })

    void window.electronAPI?.getWorkspaceSettings(workspaceId).then(ws => {
      if (cancelled) return
      setForWorkspace({ workspaceId, settings: extractThresholdsSettings(ws) })
    }).catch(err => {
      // Swallow — fallback thresholds still work. Don't spam the console.
      console.warn('[useTokenUsageThresholds] load failed:', err)
    })

    return () => {
      cancelled = true
    }
  }, [workspaceId, settingsByWorkspace, setForWorkspace])

  return useMemo(() => {
    if (!workspaceId) {
      return { warn: USAGE_THRESHOLDS.warn, danger: USAGE_THRESHOLDS.danger }
    }
    return resolveThresholds({
      providerId,
      modelId,
      settings: settingsByWorkspace[workspaceId] ?? undefined,
    })
  }, [workspaceId, providerId, modelId, settingsByWorkspace])
}
