import { describe, expect, it } from 'bun:test'
import {
  SystemOneClient,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
} from '@craft-agent/shared/decisions'
import { buildLargeResultRequest, buildLargeResultSummaryGate, LARGE_RESULT_SAMPLE_CHARS } from './large-results'

function handling(choice: string, confidence: number): () => Promise<DecisionClientResolution> {
  return async () => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { largeResults: true } })
    const endpoint = resolveDecisionEndpoint(settings)
    const fetchImpl = (async () => new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { handling: { type: 'choice', choice, confidence, probabilities: { summary: 1 - confidence, preview: confidence } } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }), { status: 200 })) as unknown as typeof fetch
    const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
    return { ok: true, value: { client, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
  }
}

const input = { text: 'x'.repeat(10_000), context: { toolName: 'grep', intent: 'find TODOs' }, estimatedTokens: 20_000 }

describe('large result summary gate (decision model)', () => {
  it('sends the tool, intent, size and only the start of the result', () => {
    const state = buildLargeResultRequest({ toolName: 'grep', intent: 'find TODOs', text: input.text, estimatedTokens: 20_000 }).state as Record<string, unknown>
    expect(state).toMatchObject({ tool: 'grep', agent_intent: 'find TODOs', estimated_tokens: 20_000 })
    expect((state.result_start as string).length).toBe(LARGE_RESULT_SAMPLE_CHARS)
  })

  it('skips the summary only on a confident preview', async () => {
    expect(await buildLargeResultSummaryGate({ resolveClient: handling('preview', 0.9) })(input)).toBe(false)
    expect(await buildLargeResultSummaryGate({ resolveClient: handling('preview', 0.6) })(input)).toBeNull()
    expect(await buildLargeResultSummaryGate({ resolveClient: handling('summary', 0.95) })(input)).toBeNull()
    expect(await buildLargeResultSummaryGate({ resolveClient: async () => ({ ok: false, failure: { kind: 'disabled', message: 'off' } }) })(input)).toBeNull()
  })
})
