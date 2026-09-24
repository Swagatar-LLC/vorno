import { describe, expect, it, mock } from 'bun:test'
import { ClaudeAgent } from '../claude-agent.ts'
import { PendingSteers } from '../backend/claude/pending-steers.ts'
import { AbortReason } from '../backend/types.ts'

describe('ClaudeAgent handoff interrupts', () => {
  it('uses Query.interrupt() for auth handoff instead of aborting the AbortController', async () => {
    const interrupt = mock(async () => {})
    const abort = mock((_reason?: unknown) => {})
    const debug = mock((_message: string) => {})

    const agent = Object.create(ClaudeAgent.prototype) as any

    agent.currentQuery = { interrupt }
    agent.currentQueryAbortController = { abort }
    agent.pendingSteers = new PendingSteers()
    agent.pendingSteers.begin()
    agent.pendingSteers.enqueue({ message: 'queued steer', messageId: 'a' })
    agent.lastAbortReason = null
    agent.debug = debug

    agent.interruptForHandoff(AbortReason.AuthRequest)
    await Promise.resolve()

    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(abort).not.toHaveBeenCalled()
    expect(agent.lastAbortReason).toBe(AbortReason.AuthRequest)
    expect(agent.takePendingSteers()).toEqual([{ message: 'queued steer', messageId: 'a' }])
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
    agent.pendingSteers = new PendingSteers()
    agent.lastAbortReason = null
    agent.debug = debug

    agent.interruptForHandoff(AbortReason.PlanSubmitted)
    await Promise.resolve()
    await Promise.resolve()

    expect(abort).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith('Claude handoff interrupt failed: interrupt failed')
  })
})

// The fork's single-slot undelivered-steer tests were retired with the
// machinery they covered: the v0.13.4 merge adopted upstream's turn-scoped
// `PendingSteers` queue, so `takeUndeliveredSteer`/`pendingSteerMessage` no
// longer exist. `takePendingSteers` (pause + drain) is the replacement, and its
// behavior — including recovery before `complete` and across handoffs — is
// covered by `claude-steering.test.ts`.
