/**
 * Pure-logic helpers for the persistent context-usage indicator (PLAN-002).
 *
 * Kept React-free so it can be exercised directly by `bun test`.
 *
 * ## Where these numbers come from (fork: PLAN-040 / SUV-0028)
 *
 * SUV-0028 asked whether this surface's counts should be sourced through the
 * Headroom boundary adapter's `stats()` "where the data overlaps". Checked
 * against the pinned `headroom-ai` SDK rather than its README, per PLAN-040's
 * standing instruction to verify at integration time. The result is that
 * **neither of the two counts this surface renders has a Headroom equivalent**,
 * so both keep their existing source:
 *
 * - `used` — input tokens for the next prompt. Sourced from the provider's own
 *   `usage_update` event. Headroom never sees an assembled prompt: SUV-0023
 *   compresses individual tool outputs and SUV-0024 compresses inter-node
 *   Conductor context, and neither is a measure of what currently occupies the
 *   window. The provider's count is already post-compression and is the only
 *   authority on live occupancy.
 * - `limit` — the model's context window. Sourced from the session-reported
 *   window, falling back to the model registry. All seven stats types the SDK
 *   declares (`SessionStats`, `MetricsSummary`, `ProxyStats`, `CCRStats`,
 *   `TelemetryStats`, `TOINStats`, `SharedContextStats`) measure compression
 *   throughput only — requests, tokens before/after/saved, ratios, cache hits,
 *   retrieval rates. Not one carries a context window or a live-occupancy
 *   figure.
 *
 *   Stated precisely, because the weaker claim is easy to overstate: the SDK
 *   *does* know about context windows, but only as caller-supplied
 *   configuration — `HeadroomConfig.modelContextLimits?: Record<string, number>`
 *   and `CompressOptions.tokenBudget?: number` are values Vorno would hand
 *   *to* Headroom, never measurements Headroom hands back. Reading `limit`
 *   from them would be Vorno reading its own input, which is not a migration
 *   onto a measured source. Verified against `headroom-ai@0.36.5`'s
 *   `dist/index.d.ts` and `dist/types-BTrX7__W.d.ts`.
 *
 * What did change is the denominator rule. This module used to substitute a
 * hardcoded `DEFAULT_CONTEXT_WINDOW = 200_000` whenever `limit` was missing and
 * then render a percentage against it. That constant is gone: an unresolvable
 * window now produces the unknown arm of {@link ContextUsage}, which carries no
 * denominator, no fraction and no threshold level. This mirrors the boundary's
 * `HeadroomMeasurement` shape deliberately — a value is measured or it is
 * absent, and absence is never readable as a number.
 *
 * Consequence worth stating: because nothing here consults the Headroom
 * adapter, turning Headroom off cannot change what this surface displays.
 */

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

/** The strings the indicator renders, derived from a {@link ContextUsage}. */
export interface ContextUsageLabels {
  /** Compact used-token count, or `'—'` before the first usage event. */
  usedLabel: string
  /** Compact context window, or `'?'` when it is unknown. */
  limitLabel: string
  /** Rounded percentage, or `null` when there is no denominator to divide by. */
  percentLabel: string | null
  /** Full sentence for the tooltip / `aria-label`. */
  tooltip: string
}

/**
 * Derive the indicator's user-visible strings.
 *
 * Split out of the React component so "the display declares the window
 * unknown instead of computing against a default" is a property that can be
 * asserted directly, rather than a claim about JSX that no test reaches
 * (there is no renderer test harness in this app).
 */
export function describeContextUsage(usage: ContextUsage): ContextUsageLabels {
  const hasUsage = usage.used > 0
  const usedLabel = hasUsage ? formatTokensCompact(usage.used) : '—'

  if (!usage.denominatorKnown) {
    return {
      usedLabel,
      limitLabel: '?',
      percentLabel: null,
      tooltip: hasUsage
        ? `${usage.used.toLocaleString()} tokens used — this model's context window is unknown, so no percentage is shown`
        : `This model's context window is unknown, so no percentage is shown — usage will appear after the first response`,
    }
  }

  const percentLabel = `${Math.round(usage.fraction * 100)}%`
  return {
    usedLabel,
    limitLabel: formatTokensCompact(usage.limit),
    percentLabel: hasUsage ? percentLabel : null,
    tooltip: hasUsage
      ? `${usage.used.toLocaleString()} / ${usage.limit.toLocaleString()} tokens (${percentLabel})`
      : `Context window: ${usage.limit.toLocaleString()} tokens — usage will appear after the first response`,
  }
}

/**
 * Compact-format a token count with a K / M / B / T suffix.
 *
 * One decimal place is shown when it carries information; a trailing
 * ".0" is trimmed so round values render cleanly. Sub-1K values are
 * shown as a plain integer with no suffix.
 *
 *   500             → "500"
 *   1_234           → "1.2K"
 *   48_300          → "48.3K"
 *   200_000         → "200K"
 *   1_000_000       → "1M"
 *   1_500_000       → "1.5M"
 *   200_000_000     → "200M"
 *   1_000_000_000   → "1B"
 *   2_500_000_000_000 → "2.5T"
 *
 * Anything beyond the trillions bucket still uses "T" — at the scale
 * of LLM context windows we won't realistically pass that, but it's
 * preferable to falling back to scientific notation.
 */
export function formatTokensCompact(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 1_000) return `${Math.round(value)}`

  // Ordered largest → smallest so the first match wins.
  const units: Array<{ threshold: number; suffix: string }> = [
    { threshold: 1_000_000_000_000, suffix: 'T' },
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' },
  ]

  for (const { threshold, suffix } of units) {
    if (value >= threshold) {
      const scaled = value / threshold
      const rounded = Math.round(scaled * 10) / 10
      const text = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1)
      return `${text}${suffix}`
    }
  }

  // Unreachable given the early-return for < 1_000, but keeps TS happy.
  return `${Math.round(value)}`
}
