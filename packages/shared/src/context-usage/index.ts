/**
 * Context-usage threshold math (fork: PLAN-003 / PLAN-055, SUV-0071).
 *
 * Browser-safe and dependency-free on purpose: the renderer's context-usage
 * indicator and the host's context-threshold watcher (`SessionManager`) both
 * import from here, so a `(providerType, model, used, limit)` tuple resolves to
 * the same level on both sides. Before SUV-0071 this lived only in the
 * renderer, which meant the host had no way to know a session had crossed the
 * workspace's warning threshold.
 *
 * Nothing here consults Headroom; see the renderer module's header for why the
 * two counts this math consumes have no Headroom equivalent.
 */

import type { WorkspaceConfig } from '../workspaces/types.ts';

export const USAGE_THRESHOLDS = {
  /** Below this fraction the bar is green. */
  warn: 0.6,
  /** Below this fraction the bar is yellow; at/above it the bar is burnt-orange. */
  danger: 0.8,
} as const

export interface UsageThresholds {
  warn: number
  danger: number
}

/**
 * Workspace-configured thresholds, sourced from `WorkspaceConfig.defaults`.
 *
 * Both maps are optional and may be empty. Keys are:
 *   - byProvider:    LlmConnection.providerType (e.g. 'anthropic', 'pi', 'pi_compat')
 *   - byModel:       model ID strings (e.g. 'claude-sonnet-4-5')
 */
export interface UsageThresholdsSettings {
  byProvider?: Record<string, UsageThresholds>
  byModel?: Record<string, UsageThresholds>
}

/**
 * A pair `(warn, danger)` is valid only when:
 *   - both values are finite numbers
 *   - both lie strictly inside the open interval (0, 1)
 *   - warn < danger
 *
 * The 0/1 endpoints are excluded because a bar that turns yellow at 0%
 * or only at 100% conveys no information. Settings UI enforces the same
 * bound so persisted values are always valid; this resolver is the
 * defensive layer for hand-edited configs.
 */
export function isValidThresholds(t: UsageThresholds | null | undefined): t is UsageThresholds {
  if (!t) return false
  const { warn, danger } = t
  if (!Number.isFinite(warn) || !Number.isFinite(danger)) return false
  if (warn <= 0 || warn >= 1) return false
  if (danger <= 0 || danger >= 1) return false
  return warn < danger
}

/**
 * Resolve effective thresholds for a (providerId, modelId) tuple by merging:
 *   1. per-model override (settings.byModel[modelId])
 *   2. per-provider default (settings.byProvider[providerId])
 *   3. built-in fallback (USAGE_THRESHOLDS)
 *
 * Invalid entries (NaN, out-of-bounds, warn >= danger) are skipped at
 * each level — falling through to the next level — rather than failing
 * loudly, so a corrupt single row never breaks the indicator.
 */
export function resolveThresholds(args: {
  providerId?: string | null
  modelId?: string | null
  settings?: UsageThresholdsSettings | null
}): UsageThresholds {
  const { providerId, modelId, settings } = args

  if (settings) {
    if (modelId && settings.byModel) {
      const candidate = settings.byModel[modelId]
      if (isValidThresholds(candidate)) return { warn: candidate.warn, danger: candidate.danger }
    }
    if (providerId && settings.byProvider) {
      const candidate = settings.byProvider[providerId]
      if (isValidThresholds(candidate)) return { warn: candidate.warn, danger: candidate.danger }
    }
  }

  return { warn: USAGE_THRESHOLDS.warn, danger: USAGE_THRESHOLDS.danger }
}

export const USAGE_COLORS = {
  ok: '#16a34a',
  warn: '#ca8a04',
  danger: '#c2410c',
  /**
   * Neutral gray for the unknown-denominator state. Deliberately not one of the
   * three semantic colors: an unknown window is not "safe", it is *unmeasured*,
   * and painting it green would be the same lie in a different form.
   */
  unknown: '#9ca3af',
} as const

export type UsageLevel = 'ok' | 'warn' | 'danger' | 'unknown'

/**
 * Indicator state.
 *
 * A discriminated union rather than one interface with nullable fields, because
 * "we do not know the context window" and "the context window is N" are
 * genuinely different states and the type is what stops a caller reading a
 * fraction that nobody could compute (fork: PLAN-040 / SUV-0028).
 *
 * The unknown arm carries no denominator and no ratio at all — the same shape
 * the Headroom boundary uses for an absent measurement, and for the same
 * reason: a missing number must not be readable as a real one.
 */
export type ContextUsage =
  | {
      /** The model's context window was resolved from a known source. */
      denominatorKnown: true
      /** Tokens used (input tokens for the next prompt). */
      used: number
      /** Tokens available in the model's context window. */
      limit: number
      /** Fraction in [0, ∞). >1 means we exceeded the window. */
      fraction: number
      /** Fraction clamped to [0, 1] for rendering the bar. */
      barFraction: number
      /** Bucketed level used to pick the color. */
      level: 'ok' | 'warn' | 'danger'
      /** CSS color string for the bar / accent. */
      color: string
    }
  | {
      /** No context window could be resolved; nothing is computed against one. */
      denominatorKnown: false
      /** Tokens used. Still a real measurement — only the denominator is missing. */
      used: number
      limit: null
      fraction: null
      /** Always 0: an empty bar, because there is no ratio to fill it with. */
      barFraction: 0
      level: 'unknown'
      color: string
    }

/**
 * Compute the indicator state from a raw `used / limit` pair.
 *
 * Behavior:
 *   - `used` is clamped to `>= 0`.
 *   - A non-positive, non-finite or missing `limit` yields the *unknown* arm.
 *     It used to fall back to a hardcoded 200_000 window, which meant every
 *     provider whose window Vorno cannot resolve rendered a percentage against
 *     a number nobody measured. Thresholds cannot fire in this state, because
 *     "80% full" is not a statement you can make about an unknown window.
 *   - Color thresholds are inclusive at the upper boundary
 *     (e.g. exactly 60% → warn, exactly 80% → danger).
 *   - `barFraction` is clamped to `[0, 1]` so the bar can't visually overflow,
 *     but `fraction` retains the true ratio so callers can detect overage.
 */
export function computeContextUsage(
  usedRaw: number | null | undefined,
  limitRaw: number | null | undefined,
  thresholdsRaw?: UsageThresholds | null,
): ContextUsage {
  const used = typeof usedRaw === 'number' && Number.isFinite(usedRaw) && usedRaw > 0 ? usedRaw : 0
  const limitKnown =
    typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0

  if (!limitKnown) {
    return {
      denominatorKnown: false,
      used,
      limit: null,
      fraction: null,
      barFraction: 0,
      level: 'unknown',
      color: USAGE_COLORS.unknown,
    }
  }

  const limit = limitRaw as number
  const thresholds = isValidThresholds(thresholdsRaw)
    ? thresholdsRaw
    : { warn: USAGE_THRESHOLDS.warn, danger: USAGE_THRESHOLDS.danger }
  const fraction = used / limit
  const barFraction = Math.max(0, Math.min(1, fraction))
  const level: 'ok' | 'warn' | 'danger' =
    fraction >= thresholds.danger ? 'danger'
    : fraction >= thresholds.warn ? 'warn'
    : 'ok'
  const color = USAGE_COLORS[level]
  return { denominatorKnown: true, used, limit, fraction, barFraction, level, color }
}

/**
 * Lift the two PLAN-003 threshold maps off a workspace's `defaults` block into
 * the shape {@link resolveThresholds} consumes. Returns `null` when neither map
 * is present so callers fall through to the built-in defaults.
 */
export function thresholdsSettingsFromWorkspaceDefaults(
  defaults: Pick<NonNullable<WorkspaceConfig['defaults']>, 'tokenUsageThresholds' | 'tokenUsageModelOverrides'> | null | undefined,
): UsageThresholdsSettings | null {
  if (!defaults) return null;
  const byProvider = defaults.tokenUsageThresholds;
  const byModel = defaults.tokenUsageModelOverrides;
  if (!byProvider && !byModel) return null;
  return {
    byProvider: byProvider ?? undefined,
    byModel: byModel ?? undefined,
  };
}

export * from './auto-handoff.ts';
