/**
 * Pure-logic helpers for the persistent context-usage indicator (PLAN-002).
 *
 * Kept React-free so it can be exercised directly by `bun test`.
 */

export const USAGE_THRESHOLDS = {
  /** Below this fraction the bar is green. */
  warn: 0.6,
  /** Below this fraction the bar is yellow; at/above it the bar is burnt-orange. */
  danger: 0.8,
} as const

export const USAGE_COLORS = {
  ok: '#16a34a',
  warn: '#ca8a04',
  danger: '#c2410c',
} as const

export type UsageLevel = 'ok' | 'warn' | 'danger'

export const DEFAULT_CONTEXT_WINDOW = 200_000

export interface ContextUsage {
  /** Tokens used (input tokens for the next prompt). */
  used: number
  /** Tokens available in the model's context window. */
  limit: number
  /** Fraction in [0, ∞). >1 means we exceeded the window. */
  fraction: number
  /** Fraction clamped to [0, 1] for rendering the bar. */
  barFraction: number
  /** Bucketed level used to pick the color. */
  level: UsageLevel
  /** CSS color string for the bar / accent. */
  color: string
}

/**
 * Compute the indicator state from a raw `used / limit` pair.
 *
 * Behavior:
 *   - `used` is clamped to `>= 0`.
 *   - A non-positive or missing `limit` falls back to `DEFAULT_CONTEXT_WINDOW`.
 *   - Color thresholds are inclusive at the upper boundary
 *     (e.g. exactly 60% → warn, exactly 80% → danger).
 *   - `barFraction` is clamped to `[0, 1]` so the bar can't visually overflow,
 *     but `fraction` retains the true ratio so callers can detect overage.
 */
export function computeContextUsage(usedRaw: number | null | undefined, limitRaw: number | null | undefined): ContextUsage {
  const used = typeof usedRaw === 'number' && Number.isFinite(usedRaw) && usedRaw > 0 ? usedRaw : 0
  const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
    ? limitRaw
    : DEFAULT_CONTEXT_WINDOW
  const fraction = used / limit
  const barFraction = Math.max(0, Math.min(1, fraction))
  const level: UsageLevel =
    fraction >= USAGE_THRESHOLDS.danger ? 'danger'
    : fraction >= USAGE_THRESHOLDS.warn ? 'warn'
    : 'ok'
  const color = USAGE_COLORS[level]
  return { used, limit, fraction, barFraction, level, color }
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
