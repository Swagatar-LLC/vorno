import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

interface AgentStub {
  backend: 'claude' | 'pi'
  isProcessing: () => boolean
  dispose: jest.Mock
}

function createAgent(backend: AgentStub['backend'], processing = false): AgentStub {
  return {
    backend,
    isProcessing: () => processing,
    dispose: jest.fn(),
  }
}

type ManagerPrivates = {
  sessions: Map<string, unknown>
  pendingPagesRuntimeRefreshes: Set<string>
  refreshWorkspacePagesRuntime: (workspaceRootPath: string) => Promise<void>
  refreshManagedPagesRuntime: (managed: unknown) => Promise<void>
  getOrCreateAgent: jest.Mock
}

function privates(manager: SessionManager): ManagerPrivates {
  return manager as unknown as ManagerPrivates
}

function injectSession(manager: SessionManager, rootPath: string, id: string, agent: AgentStub) {
  const managed = createManagedSession({ id, name: id }, {
    id: 'ws-pages',
    name: 'Pages test',
    rootPath,
    createdAt: Date.now(),
  } as never, { messagesLoaded: true }) as unknown as {
    id: string
    agent: AgentStub | null
    isProcessing: boolean
  }
  managed.agent = agent
  privates(manager).sessions.set(id, managed)
  return managed
}

describe('Pages workspace runtime refresh', () => {
  let rootPath: string
  let manager: SessionManager

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), 'sm-pages-runtime-'))
    manager = new SessionManager()
  })

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true })
  })

  it('disposes and reacquires existing Claude and Pi runtimes after a workspace capability toggle', async () => {
    const oldClaude = createAgent('claude')
    const oldPi = createAgent('pi')
    const claude = injectSession(manager, rootPath, 'claude-session', oldClaude)
    const pi = injectSession(manager, rootPath, 'pi-session', oldPi)
    const recreated: AgentStub[] = []
    privates(manager).getOrCreateAgent = jest.fn(async (managed: { id: string; agent: AgentStub | null }) => {
      const fresh = createAgent(managed.id.startsWith('claude') ? 'claude' : 'pi')
      recreated.push(fresh)
      managed.agent = fresh
      return fresh
    })

    await privates(manager).refreshWorkspacePagesRuntime(rootPath)

    expect(oldClaude.dispose).toHaveBeenCalledTimes(1)
    expect(oldPi.dispose).toHaveBeenCalledTimes(1)
    expect(privates(manager).getOrCreateAgent).toHaveBeenCalledTimes(2)
    expect(claude.agent).toBe(recreated[0])
    expect(pi.agent).toBe(recreated[1])
    expect(recreated.map(agent => agent.backend).sort()).toEqual(['claude', 'pi'])
  })

  it('defers an active runtime without yanking it, then rebuilds it when safe', async () => {
    const busy = createAgent('claude', true)
    const managed = injectSession(manager, rootPath, 'busy-session', busy)
    const acquire = jest.fn(async (target: { agent: AgentStub | null }) => {
      const fresh = createAgent('claude')
      target.agent = fresh
      return fresh
    })
    privates(manager).getOrCreateAgent = acquire

    await privates(manager).refreshWorkspacePagesRuntime(rootPath)

    expect(busy.dispose).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    expect(privates(manager).pendingPagesRuntimeRefreshes.has('busy-session')).toBe(true)

    busy.isProcessing = () => false
    await privates(manager).refreshManagedPagesRuntime(managed)

    expect(busy.dispose).toHaveBeenCalledTimes(1)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(privates(manager).pendingPagesRuntimeRefreshes.has('busy-session')).toBe(false)
  })
})
