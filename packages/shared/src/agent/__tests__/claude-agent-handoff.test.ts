import { describe, expect, it, mock } from 'bun:test'
import { ClaudeAgent } from '../claude-agent.ts'
import { AbortReason } from '../backend/types.ts'

describe('ClaudeAgent handoff interrupts', () => {
  it('uses Query.interrupt() for auth handoff instead of aborting the AbortController', async () => {
    const interrupt = mock(async () => {})
    const abort = mock((_reason?: unknown) => {})
    const debug = mock((_message: string) => {})

    const agent = Object.create(ClaudeAgent.prototype) as any

    agent.currentQuery = { interrupt }
    agent.currentQueryAbortController = { abort }
    agent.pendingSteerMessage = 'queued steer'
    agent.lastAbortReason = null
    agent.debug = debug

    agent.interruptForHandoff(AbortReason.AuthRequest)
    await Promise.resolve()

    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(abort).not.toHaveBeenCalled()
    expect(agent.lastAbortReason).toBe(AbortReason.AuthRequest)
    expect(agent.pendingSteerMessage).toBeNull()
  })

  it('logs interrupt failures instead of falling back to AbortController', async () => {
    const interrupt = mock(async () => {
      throw new Error('interrupt failed')
    })
    const abort = mock((_reason?: unknown) => {})
    const debug = mock((_message: string) => {})

    const agent = Object.create(ClaudeAgent.prototype) as any

    agent.currentQuery = { interrupt }
    agent.currentQueryAbortController = { abort }
    agent.pendingSteerMessage = null
    agent.lastAbortReason = null
    agent.debug = debug

    agent.interruptForHandoff(AbortReason.PlanSubmitted)
    await Promise.resolve()
    await Promise.resolve()

    expect(abort).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith('Claude handoff interrupt failed: interrupt failed')
  })
})

describe('ClaudeAgent undelivered steer', () => {
  it('hands the steer back once and forgets it', () => {
    // The session layer PULLS this at turn end, because it will never be told:
    // `chat()` yields the notice from its `finally`, and the consumer returns on
    // `complete`, which abandons the generator and discards it. Clearing on take
    // is what stops the trailing yield — if anything is still draining — from
    // promoting the same message a second time.
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.pendingSteerMessage = 'never delivered'

    expect(agent.takeUndeliveredSteer()).toBe('never delivered')
    expect(agent.pendingSteerMessage).toBeNull()
    expect(agent.takeUndeliveredSteer()).toBeNull()
  })

  it('answers null when the steer was delivered', () => {
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.pendingSteerMessage = null
    expect(agent.takeUndeliveredSteer()).toBeNull()
  })
})
