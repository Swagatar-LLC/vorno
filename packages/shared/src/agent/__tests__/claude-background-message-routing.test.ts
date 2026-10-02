import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { ClaudeAgent } from '../claude-agent.ts'
import { classifyClaudeTaskNotification } from '../backend/claude/task-notification.ts'

interface BackgroundRouterHarness {
  onBackgroundEvent?: (event: unknown) => void
  debug: (message: string) => void
  routeBackgroundMessage: (message: unknown) => void
}

let warnSpy: ReturnType<typeof spyOn> | undefined

afterEach(() => {
  warnSpy?.mockRestore()
  warnSpy = undefined
})

function createHarness() {
  const agent = Object.create(ClaudeAgent.prototype) as BackgroundRouterHarness
  const onBackgroundEvent = mock(() => {})
  const debug = mock(() => {})
  agent.onBackgroundEvent = onBackgroundEvent
  agent.debug = debug
  return { agent, onBackgroundEvent, debug }
}

describe('Claude between-turn background message routing', () => {
  it('emits a normalized task completion for a valid notification', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const { agent, onBackgroundEvent, debug } = createHarness()

    agent.routeBackgroundMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-123',
      status: 'failed',
      output_file: '/tmp/output.txt',
      summary: 'failed cleanly',
    })

    expect(onBackgroundEvent).toHaveBeenCalledWith({
      type: 'task_completed',
      taskId: 'agent-123',
      launchedHere: false,
      status: 'failed',
      outputFile: '/tmp/output.txt',
      summary: 'failed cleanly',
    })
    expect(warnSpy).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
  })

  it('marks a completion as launchedHere when its tool call was the agent\'s own', () => {
    const { agent, onBackgroundEvent } = createHarness()
    ;(agent as unknown as { eventAdapter: { wasLaunchedByMainAgent: (taskId: string, toolUseId?: string) => boolean } }).eventAdapter = {
      wasLaunchedByMainAgent: (_taskId, toolUseId) => toolUseId === 'toolu_own',
    }

    agent.routeBackgroundMessage({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_own', status: 'completed', output_file: '/tmp/b1' })

    expect(onBackgroundEvent).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'b1', toolUseId: 'toolu_own', launchedHere: true }))
  })

  it('warns only when a task notification is missing its task id', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const { agent, onBackgroundEvent, debug } = createHarness()

    agent.routeBackgroundMessage({
      type: 'system',
      subtype: 'task_notification',
      status: 'completed',
    })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[bg-lifecycle] task_notification missing task_id',
      {
        type: 'system',
        subtype: 'task_notification',
        status: 'completed',
      },
    )
    expect(onBackgroundEvent).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
  })

  it('keeps expected progress traffic at debug level', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const { agent, onBackgroundEvent, debug } = createHarness()

    agent.routeBackgroundMessage({
      type: 'tool_progress',
      tool_use_id: 'tool-1',
      elapsed_time_seconds: 42,
    })

    expect(warnSpy).not.toHaveBeenCalled()
    expect(onBackgroundEvent).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledTimes(1)
  })

  it('defaults unknown terminal statuses to completed', () => {
    const result = classifyClaudeTaskNotification({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-future',
      status: 'future-status',
    })

    expect(result).toEqual({
      kind: 'valid',
      notification: {
        taskId: 'agent-future',
        status: 'completed',
      },
    })
  })
})
