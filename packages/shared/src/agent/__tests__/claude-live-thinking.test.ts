import { describe, expect, it } from 'bun:test'
import { ClaudeAgent, claudeThinkingKey } from '../claude-agent.ts'

// Keep-alive: the persistent query reads its options only when created, so each later turn's
// thinking (session level or a per-turn override) is applied to the live query.
function agentWithLiveQuery(opts: { failEffort?: boolean } = {}) {
  const calls: string[] = []
  const agent = Object.create(ClaudeAgent.prototype) as any
  agent.currentQuery = {
    applyFlagSettings: async (settings: { effortLevel?: string }) => {
      if (opts.failEffort) throw new Error('not supported')
      calls.push(`effort:${settings.effortLevel}`)
    },
    setMaxThinkingTokens: async (tokens: number | null) => { calls.push(`tokens:${tokens}`) },
  }
  agent.persistentThinkingKey = claudeThinkingKey({ thinking: { type: 'adaptive' }, effort: 'high' })
  const sync = (thinking: object) => agent.syncPersistentThinking(thinking) as Promise<void>
  return { agent, calls, sync }
}

describe('ClaudeAgent live thinking (keep-alive)', () => {
  it('applies a different effort once, and restores the session level on the next turn', async () => {
    const { calls, sync } = agentWithLiveQuery()
    await sync({ thinking: { type: 'adaptive' }, effort: 'low' })
    await sync({ thinking: { type: 'adaptive' }, effort: 'low' })
    await sync({ thinking: { type: 'adaptive' }, effort: 'high' })
    expect(calls).toEqual(['effort:low', 'effort:high'])
  })

  it('disables and re-enables thinking, and sets token budgets for non-adaptive models', async () => {
    const { calls, sync } = agentWithLiveQuery()
    await sync({ thinking: { type: 'disabled' } })
    await sync({ thinking: { type: 'adaptive' }, effort: 'medium' })
    await sync({ maxThinkingTokens: 4096 })
    expect(calls).toEqual(['tokens:0', 'tokens:null', 'effort:medium', 'tokens:4096'])
  })

  it('treats a failed update as unknown and re-applies on the next turn, even the old level', async () => {
    let failing = true
    const calls: string[] = []
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.currentQuery = {
      applyFlagSettings: async (settings: { effortLevel?: string }) => {
        if (failing) throw new Error('not now')
        calls.push(`effort:${settings.effortLevel}`)
      },
      setMaxThinkingTokens: async (tokens: number | null) => { calls.push(`tokens:${tokens}`) },
    }
    agent.persistentThinkingKey = claudeThinkingKey({ thinking: { type: 'adaptive' }, effort: 'high' })
    await agent.syncPersistentThinking({ thinking: { type: 'adaptive' }, effort: 'low' })
    expect(agent.persistentThinkingKey).toBeNull()

    // The failed "low" may still have landed: back at the session's "high", apply it again.
    failing = false
    await agent.syncPersistentThinking({ thinking: { type: 'adaptive' }, effort: 'high' })
    expect(calls).toEqual(['tokens:null', 'effort:high'])
    expect(agent.persistentThinkingKey).toBe(claudeThinkingKey({ thinking: { type: 'adaptive' }, effort: 'high' }))
  })
})
