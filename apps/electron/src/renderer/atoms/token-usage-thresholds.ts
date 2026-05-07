/**
 * Workspace token-usage threshold settings (PLAN-003).
 *
 * Holds the workspace's `tokenUsageThresholds` and `tokenUsageModelOverrides`
 * (as a unified `UsageThresholdsSettings`) so the chat-input indicator can
 * resolve `(providerId, modelId)` → effective thresholds without a full
 * settings round-trip on every render.
 *
 * The settings page mutates these atoms when the user edits a threshold so
 * the indicator updates live without depending on an IPC echo path.
 */

import { atom } from 'jotai'
import type { UsageThresholdsSettings } from '@/components/chat/context-usage'

/**
 * Map of workspaceId → loaded settings (or `null` while loading).
 * `undefined` means "never loaded for this workspace yet".
 */
export const tokenUsageThresholdsByWorkspaceAtom = atom<
  Record<string, UsageThresholdsSettings | null>
>({})

/**
 * Replace settings for a single workspace. Used by:
 *   - the loader hook (after IPC `getWorkspaceSettings`)
 *   - the settings page (after a successful `updateWorkspaceSetting` save)
 */
export const setTokenUsageThresholdsForWorkspaceAtom = atom(
  null,
  (
    get,
    set,
    payload: { workspaceId: string; settings: UsageThresholdsSettings | null },
  ) => {
    const current = get(tokenUsageThresholdsByWorkspaceAtom)
    set(tokenUsageThresholdsByWorkspaceAtom, {
      ...current,
      [payload.workspaceId]: payload.settings,
    })
  },
)
