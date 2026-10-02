import { describe, expect, it } from 'bun:test'
import { ClaudeAgent, claudeThinkingKey } from '../claude-agent.ts'
import { createPushableInputStream } from '../backend/claude/persistent-input.ts'
import { AbortReason } from '../core/index.ts'

// Keep-alive: a Stop tears the persistent query down and only ends the turn's channel, so the turn
// learns it was aborted from its state (and takes the interruption path, not the empty-response
// recovery that would clear the SDK session and re-run the message).
describe('ClaudeAgent keep-alive Stop', () => {
  async function agentInPersistentTurn() {
    const agent = Object.create(ClaudeAgent.prototype) as any
    const thinking = { thinking: { type: 'adaptive' as const }, effort: 'high' as const }
    agent.persistentInput = createPushableInputStream()
    agent.fakeQuery = { applyFlagSettings: async () => {}, setMaxThinkingTokens: async () => {} }
    agent.currentQuery = agent.fakeQuery
    agent.persistentThinkingKey = claudeThinkingKey(thinking)
    agent.pendingSteers = { pause: () => {} }
    await agent.beginPersistentTurn({ type: 'user', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null }, {}, thinking)
    return agent
  }

  it('marks the running turn aborted on forceAbort', async () => {
    const agent = await agentInPersistentTurn()
    const turn = agent.activeTurnState
    expect(turn).toEqual({ aborted: false })
    agent.forceAbort(AbortReason.UserStop)
    expect(turn.aborted).toBe(true)
  })

  it('starts every turn unaborted', async () => {
    const agent = await agentInPersistentTurn()
    agent.forceAbort(AbortReason.UserStop)
    // forceAbort drops currentQuery; restore the fake so the next turn reuses the live query
    // (the first-turn branch would call the real SDK query()).
    agent.currentQuery = agent.fakeQuery
    await agent.beginPersistentTurn({ type: 'user', message: { role: 'user', content: 'again' }, parent_tool_use_id: null }, {}, { thinking: { type: 'adaptive' }, effort: 'high' })
    expect(agent.activeTurnState).toEqual({ aborted: false })
  })

  it('ends the stopped turn\'s channel at once', async () => {
    const agent = await agentInPersistentTurn()
    const channel = agent.activeTurnChannel
    agent.forceAbort(AbortReason.UserStop)
    expect(agent.activeTurnChannel).toBeNull()
    expect(channel.isEnded).toBe(true)
  })

  it('does not start a turn when a Stop lands during the live thinking update', async () => {
    const agent = await agentInPersistentTurn()
    let release!: () => void
    agent.fakeQuery.applyFlagSettings = () => new Promise<void>(resolve => { release = resolve })
    agent.currentQuery = agent.fakeQuery
    const starting = agent.beginPersistentTurn({ type: 'user', message: { role: 'user', content: 'next' }, parent_tool_use_id: null }, {}, { thinking: { type: 'adaptive' }, effort: 'low' })
    await new Promise(resolve => setTimeout(resolve, 0))
    agent.forceAbort(AbortReason.UserStop)
    release()
    await expect(starting).rejects.toThrow('Persistent query closed')
  })

  it('never lets an aborted query\'s consumer tear down the next query', async () => {
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.debug = () => {}
    let finishOld!: () => void
    const oldIterator = { next: () => new Promise(resolve => { finishOld = () => resolve({ done: true, value: undefined }) }) }
    agent.persistentIterator = oldIterator
    agent.persistentInput = createPushableInputStream()
    agent.startPersistentConsumer()

    // The next turn starts a new query while the old consumer is still draining.
    const newInput = createPushableInputStream()
    const newIterator = { next: () => new Promise(() => {}) }
    agent.persistentIterator = newIterator
    agent.persistentInput = newInput
    agent.startPersistentConsumer()
    expect(agent.persistentConsumerIterator).toBe(newIterator)

    finishOld()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent.persistentIterator).toBe(newIterator)
    expect(agent.persistentInput).toBe(newInput)
    expect(agent.persistentConsumerIterator).toBe(newIterator)
  })
})

