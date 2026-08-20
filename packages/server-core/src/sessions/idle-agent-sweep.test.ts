import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// PLAN-038 Lane A: idle-TTL agent-runtime eviction + dispose-on-archive.
//
// The sweep may dispose a session's backend runtime ONLY when the session is
// fully quiescent (no in-flight turn, no queued messages, no auth handoff, no
// pending auto-retry, no running background task) AND idle past the resolved
// TTL. Disposal serializes through agentRefreshLocks so it can never overlap
// a runtime refresh or a send-path getOrCreateAgent — and the quiescence
// predicate is re-checked after any in-flight lock resolves, because state
// may have changed while awaiting. Eviction is runtime-only: sdkSessionId
// must survive so the next send resumes the same conversation.

interface AgentStub {
  isProcessing: () => boolean
  dispose: jest.Mock
}

function createAgentStub(opts: { isProcessing?: boolean } = {}): AgentStub {
  return {
    isProcessing: () => opts.isProcessing ?? false,
    dispose: jest.fn(),
  }
}

type SweepablePrivates = {
  sessions: Map<string, unknown>
  idleAgentTtlMinutesForced: number | null
  agentRefreshLocks: Map<string, Promise<void>>
  sweepIdleAgentRuntimes: () => Promise<void>
}

function privates(sm: SessionManager): SweepablePrivates {
  return sm as unknown as SweepablePrivates
}

describe('idle agent-runtime TTL sweep', () => {
  let tmpRoot: string
  let sm: SessionManager

  const MINUTE = 60_000

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-idle-sweep-'))
    sm = new SessionManager()
    // Test seam: bypass workspace/global config resolution with a fixed TTL.
    privates(sm).idleAgentTtlMinutesForced = 30
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function injectSession(
    id: string,
    agent: AgentStub | null,
    opts: {
      idleMinutes?: number
      isProcessing?: boolean
    } = {},
  ) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: id, sdkSessionId: `sdk-${id}` },
      workspace as never,
      { messagesLoaded: true },
    ) as unknown as {
      agent: AgentStub | null
      sdkSessionId?: string
      isProcessing: boolean
      lastMessageAt: number
      lastActivityAt?: number
      messageQueue: Array<{ message: string }>
      pendingAuthRequestId?: string
      autoRetryPending?: { content: string; deadlineMs: number; committed: boolean }
      backgroundTaskRegistry: Map<string, { taskId: string; startTime: number; status: string }>
      isArchived?: boolean
    }
    managed.agent = agent
    managed.isProcessing = opts.isProcessing ?? false
    // Backdate both clocks together — createManagedSession seeds lastActivityAt
    // to "now", which would otherwise mask the idle window under test.
    const idleSince = Date.now() - (opts.idleMinutes ?? 0) * MINUTE
    managed.lastMessageAt = idleSince
    managed.lastActivityAt = idleSince
    privates(sm).sessions.set(id, managed)
    return managed
  }

  async function sweep() {
    await privates(sm).sweepIdleAgentRuntimes()
  }

  it('disposes the runtime of a session idle past the TTL, preserving sdkSessionId', async () => {
    const agent = createAgentStub()
    const managed = injectSession('stale', agent, { idleMinutes: 45 })

    await sweep()

    expect(agent.dispose).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
    // Eviction is runtime-only — the conversation must resume on next send.
    expect(managed.sdkSessionId).toBe('sdk-stale')
  })

  it('does not evict a session still inside the TTL window', async () => {
    const agent = createAgentStub()
    const managed = injectSession('warm', agent, { idleMinutes: 10 })

    await sweep()

    expect(agent.dispose).not.toHaveBeenCalled()
    expect(managed.agent).toBe(agent)
  })

  it('fresh lastActivityAt blocks eviction even when lastMessageAt is ancient', async () => {
    // A long turn stamps lastMessageAt at turn START; lastActivityAt is
    // stamped at turn END. Idle time reads the max of the two.
    const agent = createAgentStub()
    const managed = injectSession('long-turn', agent, { idleMinutes: 500 })
    managed.lastActivityAt = Date.now()

    await sweep()

    expect(agent.dispose).not.toHaveBeenCalled()
    expect(managed.agent).toBe(agent)
  })

  it('TTL 0 disables eviction entirely', async () => {
    privates(sm).idleAgentTtlMinutesForced = 0
    const agent = createAgentStub()
    const managed = injectSession('ttl-off', agent, { idleMinutes: 10_000 })

    await sweep()

    expect(agent.dispose).not.toHaveBeenCalled()
    expect(managed.agent).toBe(agent)
  })

  it('a running background task blocks eviction', async () => {
    const agent = createAgentStub()
    const managed = injectSession('bg-running', agent, { idleMinutes: 45 })
    managed.backgroundTaskRegistry.set('task_1', {
      taskId: 'task_1',
      startTime: Date.now(),
      status: 'running',
    })

    await sweep()

    expect(agent.dispose).not.toHaveBeenCalled()
    expect(managed.agent).toBe(agent)
  })

  it('an in-flight turn (agent.isProcessing) blocks eviction', async () => {
    const agent = createAgentStub({ isProcessing: true })
    const managed = injectSession('mid-turn', agent, { idleMinutes: 45 })

    await sweep()

    expect(agent.dispose).not.toHaveBeenCalled()
    expect(managed.agent).toBe(agent)
  })

  it('a non-empty messageQueue blocks eviction', async () => {
    const agent = createAgentStub()
    const managed = injectSession('queued', agent, { idleMinutes: 45 })
    managed.messageQueue.push({ message: 'still coming' })

    await sweep()

    expect(agent.dispose).not.toHaveBeenCalled()
    expect(managed.agent).toBe(agent)
  })

  it('a pending auth request blocks eviction', async () => {
    const agent = createAgentStub()
    const managed = injectSession('auth-paused', agent, { idleMinutes: 45 })
    managed.pendingAuthRequestId = 'auth_1'

    await sweep()

    expect(agent.dispose).not.toHaveBeenCalled()
    expect(managed.agent).toBe(agent)
  })

  it('a pending source-activation auto-retry blocks eviction', async () => {
    const agent = createAgentStub()
    const managed = injectSession('retry-pending', agent, { idleMinutes: 45 })
    managed.autoRetryPending = { content: 'retry me', deadlineMs: Date.now() + 5000, committed: false }

    await sweep()

    expect(agent.dispose).not.toHaveBeenCalled()
    expect(managed.agent).toBe(agent)
  })

  it('re-checks quiescence after an in-flight agentRefreshLocks entry resolves', async () => {
    // A refresh (or another dispose) may be mid-flight when the sweep fires.
    // The sweep must await the lock and re-evaluate — if a message was queued
    // while waiting, the dispose is skipped, never doubled.
    const agent = createAgentStub()
    const managed = injectSession('locked', agent, { idleMinutes: 45 })

    let release!: () => void
    const pendingLock = new Promise<void>(resolve => { release = resolve })
    privates(sm).agentRefreshLocks.set('locked', pendingLock)

    const sweepPromise = sweep()
    // The sweep is now suspended awaiting the lock. Make the session
    // non-quiescent before releasing it.
    managed.messageQueue.push({ message: 'arrived while locked' })
    release()
    await sweepPromise

    expect(agent.dispose).not.toHaveBeenCalled()
    expect(managed.agent).toBe(agent)
    privates(sm).agentRefreshLocks.delete('locked')

    // Once the queue drains, the next sweep evicts exactly once.
    managed.messageQueue.length = 0
    await sweep()
    expect(agent.dispose).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
  })

  it('archiveSession disposes a quiescent runtime immediately (no TTL clock)', async () => {
    const agent = createAgentStub()
    // Zero idle time — archive must not wait for the TTL.
    const managed = injectSession('archive-me', agent, { idleMinutes: 0 })

    await sm.archiveSession('archive-me')

    expect(managed.isArchived).toBe(true)
    expect(agent.dispose).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
    expect(managed.sdkSessionId).toBe('sdk-archive-me')
  })

  it('archiveSession with a running background task archives but keeps the runtime', async () => {
    const agent = createAgentStub()
    const managed = injectSession('archive-busy', agent, { idleMinutes: 0 })
    managed.backgroundTaskRegistry.set('task_9', {
      taskId: 'task_9',
      startTime: Date.now(),
      status: 'running',
    })

    await sm.archiveSession('archive-busy')

    expect(managed.isArchived).toBe(true)
    expect(agent.dispose).not.toHaveBeenCalled()
    expect(managed.agent).toBe(agent)
  })

  it('sweep catches up an archived session that was busy at archive time, even with TTL 0', async () => {
    const agent = createAgentStub()
    // TTL 0 (never evict) and zero idle time: neither idle gate may apply to
    // an archived session — archive cleanup must be eventually consistent.
    privates(sm).idleAgentTtlMinutesForced = 0
    const managed = injectSession('archive-catchup', agent, { idleMinutes: 0 })
    managed.backgroundTaskRegistry.set('task_10', {
      taskId: 'task_10',
      startTime: Date.now(),
      status: 'running',
    })

    await sm.archiveSession('archive-catchup')
    expect(agent.dispose).not.toHaveBeenCalled()

    // Task still running: the sweep must leave the runtime alone.
    await sweep()
    expect(agent.dispose).not.toHaveBeenCalled()

    // Task finishes; the next sweep reaps the archived runtime despite TTL 0.
    managed.backgroundTaskRegistry.get('task_10')!.status = 'completed'
    await sweep()
    expect(agent.dispose).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
    expect(managed.sdkSessionId).toBe('sdk-archive-catchup')
  })
})
