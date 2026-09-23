/**
 * fork(PLAN-055 / SUV-0071): `ContextThresholdReached` is a first-class app
 * event. These tests pin the three places a new event has to show up so a
 * rule written against it validates, matches on the level, and reaches
 * prompt/script env with its scalar fields.
 */
import { describe, expect, it } from 'bun:test'
import { APP_EVENTS } from '../types.ts'
import { getMatchValue, matcherMatches, buildEnvFromPayload } from '../utils.ts'
import type { ContextThresholdReachedPayload } from '../event-bus.ts'
import type { AutomationMatcher } from '../types.ts'

function payload(level: 'warn' | 'danger'): ContextThresholdReachedPayload {
  return {
    sessionId: 'sess-1',
    sessionName: 'Long research thread',
    workspaceId: 'ws-1',
    timestamp: 1_700_000_000_000,
    level,
    usedTokens: 130_000,
    contextWindow: 200_000,
    fraction: 0.65,
    warnThreshold: 0.6,
    dangerThreshold: 0.8,
    model: 'model-x',
    providerType: 'anthropic',
  }
}

describe('ContextThresholdReached automation event', () => {
  it('is a known app event so a config block under it validates', () => {
    expect(APP_EVENTS).toContain('ContextThresholdReached')
  })

  it('matches on the crossed level', () => {
    expect(getMatchValue('ContextThresholdReached', payload('warn') as unknown as Record<string, unknown>)).toBe('warn')
    expect(getMatchValue('ContextThresholdReached', payload('danger') as unknown as Record<string, unknown>)).toBe('danger')

    const warnOnly: AutomationMatcher = { matcher: '^warn$', actions: [{ type: 'webhook', url: 'https://example.invalid/hook' }] }
    expect(matcherMatches(warnOnly, 'ContextThresholdReached', payload('warn') as unknown as Record<string, unknown>)).toBe(true)
    expect(matcherMatches(warnOnly, 'ContextThresholdReached', payload('danger') as unknown as Record<string, unknown>)).toBe(false)
  })

  it('exposes its scalar fields as CRAFT_* variables', () => {
    const env = buildEnvFromPayload('ContextThresholdReached', payload('warn'))
    expect(env.CRAFT_LEVEL).toBe('warn')
    expect(env.CRAFT_USED_TOKENS).toBe('130000')
    expect(env.CRAFT_CONTEXT_WINDOW).toBe('200000')
    expect(env.CRAFT_FRACTION).toBe('0.65')
    expect(env.CRAFT_WARN_THRESHOLD).toBe('0.6')
    expect(env.CRAFT_DANGER_THRESHOLD).toBe('0.8')
    expect(env.CRAFT_MODEL).toBe('model-x')
    expect(env.CRAFT_PROVIDER_TYPE).toBe('anthropic')
  })
})
