import { describe, expect, it } from 'bun:test'
import {
  SystemOneClient,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
} from '@craft-agent/shared/decisions'
import { pickTurnThinkingLevel } from './adaptive-thinking'

function rated(score: number, confidence: number): () => Promise<DecisionClientResolution> {
  return async () => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { adaptiveThinking: true } })
    const endpoint = resolveDecisionEndpoint(settings)
    const probabilities = { '0': 0.25, '1': 0.25, '2': 0.25, '3': 0.25 }
    const fetchImpl = (async () => new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { demand: { type: 'score', score, confidence, probabilities } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }), { status: 200 })) as unknown as typeof fetch
    const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
    return { ok: true, value: { client, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
  }
}

describe('pickTurnThinkingLevel', () => {
  it('lowers the level for simple turns, never above the session level', async () => {
    expect(await pickTurnThinkingLevel('thanks!', 'high', { resolveClient: rated(0, 0.9) })).toBe('low')
    expect(await pickTurnThinkingLevel('rename this variable', 'xhigh', { resolveClient: rated(1, 0.9) })).toBe('medium')
    expect(await pickTurnThinkingLevel('refactor the module', 'max', { resolveClient: rated(2.2, 0.9) })).toBe('high')
  })

  it('keeps the session level for hard turns, unsure answers and low session levels', async () => {
    expect(await pickTurnThinkingLevel('design the architecture', 'high', { resolveClient: rated(3, 0.95) })).toBeNull()
    expect(await pickTurnThinkingLevel('thanks!', 'high', { resolveClient: rated(0, 0.4) })).toBeNull()
    expect(await pickTurnThinkingLevel('thanks!', 'low', { resolveClient: rated(0, 0.9) })).toBeNull()
    expect(await pickTurnThinkingLevel('refactor', 'medium', { resolveClient: rated(2, 0.9) })).toBeNull()
  })

  it('never asks when thinking is off or the feature is disabled', async () => {
    let asked = 0
    const counting = async () => { asked++; return { ok: false as const, failure: { kind: 'disabled' as const, message: 'off' } } }
    expect(await pickTurnThinkingLevel('thanks!', 'off', { resolveClient: counting })).toBeNull()
    expect(asked).toBe(0)
    expect(await pickTurnThinkingLevel('thanks!', 'high', { resolveClient: counting })).toBeNull()
  })
})
