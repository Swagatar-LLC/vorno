import { describe, expect, it } from 'bun:test'
import {
  computeContextUsage,
  formatTokensK,
  DEFAULT_CONTEXT_WINDOW,
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

  it('falls back to the default context window when limit missing/zero/negative', () => {
    expect(computeContextUsage(50_000, undefined).limit).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(computeContextUsage(50_000, null).limit).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(computeContextUsage(50_000, 0).limit).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(computeContextUsage(50_000, -1).limit).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('treats missing/invalid used as 0', () => {
    expect(computeContextUsage(undefined, 100_000).used).toBe(0)
    expect(computeContextUsage(null, 100_000).used).toBe(0)
    expect(computeContextUsage(NaN, 100_000).used).toBe(0)
    expect(computeContextUsage(-5, 100_000).used).toBe(0)
  })
})

describe('formatTokensK', () => {
  it('formats sub-1K values as a plain integer', () => {
    expect(formatTokensK(0)).toBe('0')
    expect(formatTokensK(500)).toBe('500')
    expect(formatTokensK(999)).toBe('999')
  })

  it('formats >=1K values with one decimal and a "K" suffix', () => {
    expect(formatTokensK(1_234)).toBe('1.2K')
    expect(formatTokensK(48_312)).toBe('48.3K')
  })

  it('drops a trailing ".0" so round Ks render cleanly', () => {
    expect(formatTokensK(200_000)).toBe('200K')
    expect(formatTokensK(2_000)).toBe('2K')
  })

  it('handles bad input defensively', () => {
    expect(formatTokensK(NaN)).toBe('0')
    expect(formatTokensK(-1)).toBe('0')
  })
})
