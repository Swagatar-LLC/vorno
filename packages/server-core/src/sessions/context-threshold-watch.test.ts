import { describe, expect, it } from 'bun:test'
import { computeContextUsage } from '@craft-agent/shared/context-usage'
import {
  detectContextThresholdCrossings,
  isContextThresholdEligible,
  isContextThresholdSettled,
  recordContextThresholdCrossings,
} from './context-threshold-watch.ts'

const T = { warn: 0.6, danger: 0.8 }

describe('isContextThresholdEligible', () => {
  it('admits an ordinary interactive session', () => {
    expect(isContextThresholdEligible({})).toBe(true)
  })

  it('excludes hidden, Conductor, and automation-created sessions', () => {
    expect(isContextThresholdEligible({ hidden: true })).toBe(false)
    expect(isContextThresholdEligible({ taskSlug: 'nightly-report' })).toBe(false)
    expect(isContextThresholdEligible({ triggeredBy: { automationName: 'x', timestamp: 1 } })).toBe(false)
  })
})

describe('detectContextThresholdCrossings', () => {
  it('reports nothing below warn or with an unknown window', () => {
    expect(detectContextThresholdCrossings(undefined, computeContextUsage(50, 100, T))).toEqual([])
    expect(detectContextThresholdCrossings(undefined, computeContextUsage(90, undefined, T))).toEqual([])
  })

  it('reports warn once, then danger once', () => {
    let state = undefined as ReturnType<typeof recordContextThresholdCrossings> | undefined
    const first = detectContextThresholdCrossings(state, computeContextUsage(65, 100, T))
    expect(first).toEqual(['warn'])
    state = recordContextThresholdCrossings(state, first, 1_000)
    expect(detectContextThresholdCrossings(state, computeContextUsage(70, 100, T))).toEqual([])
    const second = detectContextThresholdCrossings(state, computeContextUsage(85, 100, T))
    expect(second).toEqual(['danger'])
    state = recordContextThresholdCrossings(state, second, 2_000)
    expect(state).toEqual({ warnReachedAt: 1_000, dangerReachedAt: 2_000 })
    expect(isContextThresholdSettled(state)).toBe(true)
    expect(detectContextThresholdCrossings(state, computeContextUsage(99, 100, T))).toEqual([])
  })

  it('reports both levels when a session lands straight in danger', () => {
    expect(detectContextThresholdCrossings(undefined, computeContextUsage(85, 100, T))).toEqual(['warn', 'danger'])
  })

  it('does not re-fire warn after usage drops and climbs again', () => {
    const state = recordContextThresholdCrossings(undefined, ['warn'], 1)
    expect(detectContextThresholdCrossings(state, computeContextUsage(10, 100, T))).toEqual([])
    expect(detectContextThresholdCrossings(state, computeContextUsage(65, 100, T))).toEqual([])
  })
})
