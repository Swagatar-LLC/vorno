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

// fork(PLAN-055 / SUV-0071): the threshold math moved to
// `@craft-agent/shared/context-usage` so the host-side watcher resolves the same
// level this indicator shows. Re-exported here so renderer imports and the
// existing tests are unchanged; only the display helpers below stay local.
export {
  USAGE_THRESHOLDS,
  USAGE_COLORS,
  isValidThresholds,
  resolveThresholds,
  computeContextUsage,
  thresholdsSettingsFromWorkspaceDefaults,
  type UsageThresholds,
  type UsageThresholdsSettings,
  type UsageLevel,
  type ContextUsage,
} from '@craft-agent/shared/context-usage'
import type { ContextUsage } from '@craft-agent/shared/context-usage'

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
