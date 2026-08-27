/**
 * Denominator discipline for the token-usage surface (fork: PLAN-040 / SUV-0028).
 *
 * The rule under test is PLAN-040's "measured or absent, never interpolated",
 * applied to the one place it was still being broken: the context-usage
 * indicator used to substitute a hardcoded 200_000 window whenever it did not
 * know the real one, and then render a percentage against it. For any provider
 * whose context window Vorno cannot resolve, every number that came out of that
 * path was a confident lie.
 *
 * These tests pin three things:
 *   1. An unresolvable window produces the *unknown* arm — no limit, no
 *      fraction, no level — rather than a fabricated denominator.
 *   2. The rendered labels say so, instead of showing a percentage.
 *   3. A known window still behaves exactly as it did before the change
 *      (the regression lock for "Headroom disabled → today's behavior").
 */

import { describe, expect, it } from 'bun:test'
import {
  computeContextUsage,
  describeContextUsage,
  resolveThresholds,
  USAGE_COLORS,
  USAGE_THRESHOLDS,
} from '../context-usage'

describe('unknown denominator', () => {
  const unresolvable: Array<[string, number | null | undefined]> = [
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -1],
    ['NaN', NaN],
  ]

  for (const [label, limit] of unresolvable) {
    it(`reports unknown rather than a default window for ${label}`, () => {
      const usage = computeContextUsage(50_000, limit)
      expect(usage.denominatorKnown).toBe(false)
      // The whole point: no number is invented to stand in for the window.
      expect(usage.limit).toBeNull()
      expect(usage.fraction).toBeNull()
      expect(usage.level).toBe('unknown')
      // The measured half is still real and still reported.
      expect(usage.used).toBe(50_000)
    })
  }

  it('never computes against the old 200_000 default', () => {
    const usage = computeContextUsage(50_000, undefined)
    // 50_000 / 200_000 = 0.25 — the exact lie this SUV removes.
    expect(usage.fraction).not.toBe(0.25)
    expect(usage.barFraction).toBe(0)
  })

  it('does not colour the bar as if a threshold had been crossed', () => {
    const usage = computeContextUsage(190_000, undefined)
    // Against the old default this was 95% → danger. With no window, there is
    // no fraction to compare, so no threshold can fire.
    expect(usage.level).toBe('unknown')
    expect(usage.color).toBe(USAGE_COLORS.unknown)
  })

  it('renders no percentage and declares the window unknown', () => {
    const labels = describeContextUsage(computeContextUsage(50_000, undefined))
    expect(labels.percentLabel).toBeNull()
    expect(labels.limitLabel).toBe('?')
    expect(labels.tooltip).toContain('context window is unknown')
    // Guards against the label quietly regaining a fabricated denominator.
    expect(labels.tooltip).not.toContain('200,000')
    expect(labels.tooltip).not.toMatch(/\d+%/)
  })
})

describe('known denominator — behaviour unchanged', () => {
  it('keeps the pre-change values for a resolved window', () => {
    const usage = computeContextUsage(59_000, 100_000)
    expect(usage.denominatorKnown).toBe(true)
    expect(usage.limit).toBe(100_000)
    expect(usage.fraction).toBeCloseTo(0.59, 5)
    expect(usage.barFraction).toBeCloseTo(0.59, 5)
    expect(usage.level).toBe('ok')
    expect(usage.color).toBe(USAGE_COLORS.ok)
  })

  it('still renders a percentage when the window is known', () => {
    const labels = describeContextUsage(computeContextUsage(50_000, 100_000))
    expect(labels.percentLabel).toBe('50%')
    expect(labels.limitLabel).toBe('100K')
    expect(labels.tooltip).toContain('50,000 / 100,000 tokens (50%)')
  })

  it('shows an em dash for used before the first usage event, with a known window', () => {
    const labels = describeContextUsage(computeContextUsage(0, 100_000))
    expect(labels.usedLabel).toBe('—')
    expect(labels.tooltip).toContain('usage will appear after the first response')
  })
})

describe('thresholds fire from the migrated counts', () => {
  // Workspace-configured thresholds, resolved through the untouched
  // `resolveThresholds()` precedence chain, then applied to the counts the
  // display actually renders.
  const settings = {
    byProvider: { anthropic: { warn: 0.5, danger: 0.7 } },
    byModel: { 'claude-sonnet-4-5': { warn: 0.3, danger: 0.6 } },
  }

  it('warns and dangers at the per-model override boundaries', () => {
    const thresholds = resolveThresholds({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      settings,
    })
    expect(thresholds).toEqual({ warn: 0.3, danger: 0.6 })

    expect(computeContextUsage(29_000, 100_000, thresholds).level).toBe('ok')
    expect(computeContextUsage(30_000, 100_000, thresholds).level).toBe('warn')
    expect(computeContextUsage(59_000, 100_000, thresholds).level).toBe('warn')
    expect(computeContextUsage(60_000, 100_000, thresholds).level).toBe('danger')
  })

  it('falls through to the per-provider default for an unlisted model', () => {
    const thresholds = resolveThresholds({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-7',
      settings,
    })
    expect(thresholds).toEqual({ warn: 0.5, danger: 0.7 })
    expect(computeContextUsage(50_000, 100_000, thresholds).level).toBe('warn')
    expect(computeContextUsage(70_000, 100_000, thresholds).level).toBe('danger')
  })

  it('cannot fire any threshold while the denominator is unknown', () => {
    const thresholds = resolveThresholds({ providerId: 'anthropic', settings })
    // Far past every configured boundary in absolute terms — still unknown,
    // because "past a threshold" is meaningless without a window.
    expect(computeContextUsage(10_000_000, undefined, thresholds).level).toBe('unknown')
    expect(USAGE_THRESHOLDS.warn).toBe(0.6) // built-in defaults untouched
  })
})
