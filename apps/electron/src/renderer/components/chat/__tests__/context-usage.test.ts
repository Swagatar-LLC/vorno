import { describe, expect, it } from 'bun:test'
import {
  computeContextUsage,
  formatTokensCompact,
  resolveThresholds,
  isValidThresholds,
  USAGE_THRESHOLDS,
  USAGE_COLORS,
} from '../context-usage'

describe('computeContextUsage', () => {
  it('returns ok/green below 60%', () => {
    const r = computeContextUsage(59_000, 100_000)
    expect(r.level).toBe('ok')
    expect(r.color).toBe(USAGE_COLORS.ok)
    expect(r.fraction).toBeCloseTo(0.59, 5)
    expect(r.barFraction).toBeCloseTo(0.59, 5)
  })

  it('returns warn/yellow exactly at 60%', () => {
    const r = computeContextUsage(60_000, 100_000)
    expect(r.level).toBe('warn')
    expect(r.color).toBe(USAGE_COLORS.warn)
  })

  it('returns warn/yellow at 79%', () => {
    expect(computeContextUsage(79_000, 100_000).level).toBe('warn')
  })

  it('returns danger/burnt-orange exactly at 80%', () => {
    const r = computeContextUsage(80_000, 100_000)
    expect(r.level).toBe('danger')
    expect(r.color).toBe(USAGE_COLORS.danger)
  })

  it('returns danger at 100%', () => {
    expect(computeContextUsage(100_000, 100_000).level).toBe('danger')
  })

  it('clamps barFraction to 1 when over the window but keeps true fraction', () => {
    const r = computeContextUsage(150_000, 100_000)
    expect(r.fraction).toBe(1.5)
    expect(r.barFraction).toBe(1)
    expect(r.level).toBe('danger')
  })

  // fork(PLAN-040 / SUV-0028): this case used to assert the opposite — that a
  // missing limit fell back to a hardcoded 200_000 window. That fallback was
  // the bug: it made the indicator render a percentage against a denominator
  // nobody measured. The unknown arm is now the contract; the full behaviour is
  // pinned in `context-usage-denominator.test.ts`.
  it('reports an unknown denominator when limit missing/zero/negative', () => {
    for (const limit of [undefined, null, 0, -1]) {
      const usage = computeContextUsage(50_000, limit)
      expect(usage.denominatorKnown).toBe(false)
      expect(usage.limit).toBeNull()
      expect(usage.level).toBe('unknown')
    }
  })

  it('treats missing/invalid used as 0', () => {
    expect(computeContextUsage(undefined, 100_000).used).toBe(0)
    expect(computeContextUsage(null, 100_000).used).toBe(0)
    expect(computeContextUsage(NaN, 100_000).used).toBe(0)
    expect(computeContextUsage(-5, 100_000).used).toBe(0)
  })
})

describe('formatTokensCompact', () => {
  it('formats sub-1K values as a plain integer with no suffix', () => {
    expect(formatTokensCompact(0)).toBe('0')
    expect(formatTokensCompact(500)).toBe('500')
    expect(formatTokensCompact(999)).toBe('999')
  })

  it('formats thousands with a "K" suffix', () => {
    expect(formatTokensCompact(1_234)).toBe('1.2K')
    expect(formatTokensCompact(48_312)).toBe('48.3K')
    expect(formatTokensCompact(200_000)).toBe('200K')
    expect(formatTokensCompact(2_000)).toBe('2K')
  })

  it('formats millions with an "M" suffix (covers 1M+ context windows)', () => {
    expect(formatTokensCompact(1_000_000)).toBe('1M')
    expect(formatTokensCompact(1_500_000)).toBe('1.5M')
    expect(formatTokensCompact(2_000_000)).toBe('2M')
    expect(formatTokensCompact(200_000_000)).toBe('200M')
  })

  it('formats billions with a "B" suffix', () => {
    expect(formatTokensCompact(1_000_000_000)).toBe('1B')
    expect(formatTokensCompact(2_300_000_000)).toBe('2.3B')
  })

  it('formats trillions with a "T" suffix', () => {
    expect(formatTokensCompact(1_000_000_000_000)).toBe('1T')
    expect(formatTokensCompact(2_500_000_000_000)).toBe('2.5T')
  })

  it('drops trailing ".0" so round values render cleanly across all buckets', () => {
    expect(formatTokensCompact(200_000)).toBe('200K')
    expect(formatTokensCompact(5_000_000)).toBe('5M')
    expect(formatTokensCompact(7_000_000_000)).toBe('7B')
  })

  it('rounds half-way cases away from zero', () => {
    expect(formatTokensCompact(1_250_000)).toBe('1.3M')
    expect(formatTokensCompact(1_249_999)).toBe('1.2M')
  })

  it('handles bad input defensively', () => {
    expect(formatTokensCompact(NaN)).toBe('0')
    expect(formatTokensCompact(-1)).toBe('0')
    expect(formatTokensCompact(Infinity)).toBe('0')
  })
})

describe('isValidThresholds', () => {
  it('accepts valid pairs strictly inside (0, 1) with warn < danger', () => {
    expect(isValidThresholds({ warn: 0.6, danger: 0.8 })).toBe(true)
    expect(isValidThresholds({ warn: 0.01, danger: 0.99 })).toBe(true)
  })

  it('rejects out-of-bounds values (0/1 endpoints excluded)', () => {
    expect(isValidThresholds({ warn: 0, danger: 0.5 })).toBe(false)
    expect(isValidThresholds({ warn: 0.5, danger: 1 })).toBe(false)
    expect(isValidThresholds({ warn: -0.1, danger: 0.5 })).toBe(false)
    expect(isValidThresholds({ warn: 0.5, danger: 1.5 })).toBe(false)
  })

  it('rejects warn >= danger', () => {
    expect(isValidThresholds({ warn: 0.8, danger: 0.6 })).toBe(false)
    expect(isValidThresholds({ warn: 0.5, danger: 0.5 })).toBe(false)
  })

  it('rejects non-finite values', () => {
    expect(isValidThresholds({ warn: NaN, danger: 0.8 })).toBe(false)
    expect(isValidThresholds({ warn: 0.6, danger: Infinity })).toBe(false)
  })

  it('rejects null/undefined', () => {
    expect(isValidThresholds(null)).toBe(false)
    expect(isValidThresholds(undefined)).toBe(false)
  })
})

describe('resolveThresholds', () => {
  const FALLBACK = { warn: USAGE_THRESHOLDS.warn, danger: USAGE_THRESHOLDS.danger }

  it('returns built-in fallback when no settings provided', () => {
    expect(resolveThresholds({})).toEqual(FALLBACK)
    expect(resolveThresholds({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5' })).toEqual(FALLBACK)
    expect(resolveThresholds({ settings: null })).toEqual(FALLBACK)
    expect(resolveThresholds({ settings: {} })).toEqual(FALLBACK)
  })

  it('falls through to provider default when no per-model override', () => {
    const settings = { byProvider: { anthropic: { warn: 0.5, danger: 0.7 } } }
    const r = resolveThresholds({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5', settings })
    expect(r).toEqual({ warn: 0.5, danger: 0.7 })
  })

  it('per-model override beats provider default beats fallback', () => {
    const settings = {
      byProvider: { anthropic: { warn: 0.5, danger: 0.7 } },
      byModel: { 'claude-sonnet-4-5': { warn: 0.3, danger: 0.5 } },
    }
    expect(
      resolveThresholds({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5', settings }),
    ).toEqual({ warn: 0.3, danger: 0.5 })
    expect(
      resolveThresholds({ providerId: 'anthropic', modelId: 'claude-opus-4-7', settings }),
    ).toEqual({ warn: 0.5, danger: 0.7 })
    expect(resolveThresholds({ providerId: 'pi', modelId: 'gpt-4o', settings })).toEqual(FALLBACK)
  })

  it('skips invalid entries and falls through to next level', () => {
    const settings = {
      byProvider: { anthropic: { warn: 0.5, danger: 0.7 } },
      byModel: { 'claude-sonnet-4-5': { warn: 0.9, danger: 0.5 } }, // warn >= danger
    }
    const r = resolveThresholds({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5', settings })
    expect(r).toEqual({ warn: 0.5, danger: 0.7 })
  })

  it('skips invalid provider entry and falls through to fallback', () => {
    const settings = {
      byProvider: { anthropic: { warn: 1.5, danger: 2.0 } }, // out of bounds
    }
    expect(
      resolveThresholds({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5', settings }),
    ).toEqual(FALLBACK)
  })

  it('partial settings (provider only) resolves correctly for known and unknown models', () => {
    const settings = { byProvider: { pi: { warn: 0.4, danger: 0.85 } } }
    expect(resolveThresholds({ providerId: 'pi', modelId: 'gpt-4o', settings })).toEqual({
      warn: 0.4,
      danger: 0.85,
    })
    expect(resolveThresholds({ providerId: 'pi', settings })).toEqual({
      warn: 0.4,
      danger: 0.85,
    })
  })

  it('honors model override even when provider id is missing', () => {
    const settings = { byModel: { 'gpt-4o': { warn: 0.2, danger: 0.4 } } }
    expect(resolveThresholds({ modelId: 'gpt-4o', settings })).toEqual({ warn: 0.2, danger: 0.4 })
  })
})

describe('computeContextUsage with custom thresholds', () => {
  it('honors custom thresholds for the level decision', () => {
    const thresholds = { warn: 0.3, danger: 0.5 }
    expect(computeContextUsage(20_000, 100_000, thresholds).level).toBe('ok')
    expect(computeContextUsage(30_000, 100_000, thresholds).level).toBe('warn')
    expect(computeContextUsage(50_000, 100_000, thresholds).level).toBe('danger')
  })

  it('falls back to built-in thresholds when given invalid custom thresholds', () => {
    expect(computeContextUsage(60_000, 100_000, { warn: 0.9, danger: 0.5 }).level).toBe('warn')
    expect(computeContextUsage(60_000, 100_000, null).level).toBe('warn')
    expect(computeContextUsage(60_000, 100_000, undefined).level).toBe('warn')
  })
})
