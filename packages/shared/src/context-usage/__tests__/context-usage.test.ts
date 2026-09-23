/**
 * fork(PLAN-055 / SUV-0071): the threshold math moved here from the renderer so
 * the host watcher and the indicator agree. The renderer's own tests still run
 * against its re-export; these cover the shared module directly plus the
 * workspace-defaults lifter the host uses.
 */
import { describe, expect, it } from 'bun:test'
import {
  USAGE_THRESHOLDS,
  computeContextUsage,
  isValidThresholds,
  resolveThresholds,
  thresholdsSettingsFromWorkspaceDefaults,
} from '../index.ts'

describe('thresholdsSettingsFromWorkspaceDefaults', () => {
  it('returns null when a workspace configures neither map', () => {
    expect(thresholdsSettingsFromWorkspaceDefaults(undefined)).toBeNull()
    expect(thresholdsSettingsFromWorkspaceDefaults(null)).toBeNull()
    expect(thresholdsSettingsFromWorkspaceDefaults({})).toBeNull()
  })

  it('lifts the PLAN-003 maps into the resolver shape', () => {
    const settings = thresholdsSettingsFromWorkspaceDefaults({
      tokenUsageThresholds: { anthropic: { warn: 0.5, danger: 0.7 } },
      tokenUsageModelOverrides: { 'model-x': { warn: 0.3, danger: 0.4 } },
    })
    expect(settings).toEqual({
      byProvider: { anthropic: { warn: 0.5, danger: 0.7 } },
      byModel: { 'model-x': { warn: 0.3, danger: 0.4 } },
    })
  })
})

describe('resolveThresholds (shared)', () => {
  it('prefers model over provider over built-in defaults', () => {
    const settings = thresholdsSettingsFromWorkspaceDefaults({
      tokenUsageThresholds: { anthropic: { warn: 0.5, danger: 0.7 } },
      tokenUsageModelOverrides: { 'model-x': { warn: 0.3, danger: 0.4 } },
    })
    expect(resolveThresholds({ providerId: 'anthropic', modelId: 'model-x', settings })).toEqual({ warn: 0.3, danger: 0.4 })
    expect(resolveThresholds({ providerId: 'anthropic', modelId: 'other', settings })).toEqual({ warn: 0.5, danger: 0.7 })
    expect(resolveThresholds({ providerId: 'pi', modelId: 'other', settings })).toEqual({
      warn: USAGE_THRESHOLDS.warn,
      danger: USAGE_THRESHOLDS.danger,
    })
  })

  it('skips invalid pairs at each level', () => {
    expect(isValidThresholds({ warn: 0.8, danger: 0.6 })).toBe(false)
    const settings = { byModel: { m: { warn: 0.9, danger: 0.1 } }, byProvider: { p: { warn: 0.2, danger: 0.3 } } }
    expect(resolveThresholds({ providerId: 'p', modelId: 'm', settings })).toEqual({ warn: 0.2, danger: 0.3 })
  })
})

describe('computeContextUsage (shared)', () => {
  it('buckets by the resolved thresholds with inclusive upper boundaries', () => {
    const t = { warn: 0.5, danger: 0.75 }
    expect(computeContextUsage(49, 100, t).level).toBe('ok')
    expect(computeContextUsage(50, 100, t).level).toBe('warn')
    expect(computeContextUsage(75, 100, t).level).toBe('danger')
  })

  it('reports an unknown denominator instead of inventing one', () => {
    const usage = computeContextUsage(5_000, undefined)
    expect(usage.denominatorKnown).toBe(false)
    expect(usage.level).toBe('unknown')
    expect(usage.limit).toBeNull()
  })
})
