import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import { cleanupModeState, initializeModeState, setGuardedModeActiveResolver } from '../mode-manager.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { GuardedModeCheck } from '../core/guarded-mode.ts'

const SESSION = 'pi-guard-session'

function createAgent() {
  const config = {
    provider: 'pi',
    workspace: { id: 'ws-test', name: 'Test Workspace', rootPath: '/tmp/pi-guard-ws' },
    session: { id: SESSION, workspaceRootPath: '/tmp/pi-guard-ws', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: '/tmp/pi-guard-project' },
    isHeadless: true,
  } as unknown as BackendConfig
  const agent = new PiAgent(config)
  const sent: Array<Record<string, unknown>> = []
  ;(agent as any).send = (message: Record<string, unknown>) => { sent.push(message) }
  ;(agent as any).emitAutomationEvent = async () => {}
  return { agent, sent }
}

const pushRequest = { requestId: 'req-1', toolName: 'Bash', input: { command: 'git push --force origin main' } }

describe('PiAgent Guarded mode', () => {
  beforeEach(() => {
    initializeModeState(SESSION, 'guarded')
    setGuardedModeActiveResolver(() => true)
  })
  afterEach(() => {
    cleanupModeState(SESSION)
    setGuardedModeActiveResolver(null)
  })

  it('turns a flagged call into a prompt without "Always Allow"', async () => {
    const { agent, sent } = createAgent()
    agent.guardedModeCheck = { isActive: () => true, check: async () => ({ risks: ['external'] }) } satisfies GuardedModeCheck
    const prompts: Array<{ requestId: string; canRemember?: boolean; description: string }> = []
    agent.onPermissionRequest = (request) => {
      prompts.push(request)
      agent.respondToPermission(request.requestId, false, false)
    }
    await (agent as any).handlePreToolUseRequest(pushRequest)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.canRemember).toBe(false)
    expect(prompts[0]!.description).toContain('Guarded mode (reaches other people or services)')
    expect(sent.at(-1)).toMatchObject({ type: 'pre_tool_use_response', requestId: 'req-1', action: 'block' })
  })

  it('blocks without prompting when the turn stops while the check thinks', async () => {
    const { agent, sent } = createAgent()
    let release!: () => void
    const thinking = new Promise<void>(resolve => { release = resolve })
    agent.guardedModeCheck = { isActive: () => true, check: async () => { await thinking; return { risks: ['external'] } } } satisfies GuardedModeCheck
    let prompted = 0
    agent.onPermissionRequest = () => { prompted++ }
    const handled = (agent as any).handlePreToolUseRequest(pushRequest)
    await new Promise(resolve => setTimeout(resolve, 5))
    await agent.abort('user stop')
    release()
    await handled
    expect(prompted).toBe(0)
    expect(sent.find(m => m.type === 'pre_tool_use_response')).toMatchObject({ action: 'block', reason: 'The turn was stopped.' })
  })

  it('never asks in Execute mode', async () => {
    initializeModeState(SESSION, 'allow-all')
    const { agent, sent } = createAgent()
    let checks = 0
    agent.guardedModeCheck = { isActive: () => true, check: async () => { checks++; return { risks: ['external'] } } } satisfies GuardedModeCheck
    await (agent as any).handlePreToolUseRequest(pushRequest)
    expect(checks).toBe(0)
    expect(['allow', 'modify']).toContain(sent.at(-1)!.action as string)
  })

  it('does no check work while it is inactive', async () => {
    const { agent, sent } = createAgent()
    let checks = 0
    agent.guardedModeCheck = { isActive: () => false, check: async () => { checks++; return { risks: ['external'] } } } satisfies GuardedModeCheck
    await (agent as any).handlePreToolUseRequest(pushRequest)
    expect(checks).toBe(0)
    expect(sent.at(-1)).toMatchObject({ type: 'pre_tool_use_response', requestId: 'req-1' })
    expect(['allow', 'modify']).toContain(sent.at(-1)!.action as string)
  })
})
