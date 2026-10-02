import { beforeEach, describe, expect, it } from 'bun:test'
import { ClaudeEventAdapter } from '../backend/claude/event-adapter.ts'

// Background tasks are attributed with the SDK's structured task events and tool_use ids, not
// tool-result text: only the session's own (top-level) tool calls count.
describe('ClaudeEventAdapter background task attribution', () => {
  let adapter: ClaudeEventAdapter

  beforeEach(() => {
    adapter = new ClaudeEventAdapter({ onDebug: undefined, mapSDKError: async () => ({ type: 'error', message: 'x' }) as never })
    adapter.startTurn()
  })

  const assistantToolUse = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) =>
    adapter.adapt({
      type: 'assistant',
      message: { id: `msg-${id}`, content: [{ type: 'tool_use', id, name, input }] },
      parent_tool_use_id: parent,
      session_id: 's',
    } as never)
  const system = (message: Record<string, unknown>) => adapter.adapt({ type: 'system', session_id: 's', ...message } as never)

  it('announces the agent\'s own background Bash from task_started', async () => {
    await assistantToolUse('toolu_1', 'Bash', { command: 'bun test', description: 'Run tests', run_in_background: true })
    const events = await system({ subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1', task_type: 'local_bash', description: 'Run tests', is_backgrounded: true })
    expect(events).toEqual([expect.objectContaining({ type: 'shell_backgrounded', shellId: 'b1', toolUseId: 'toolu_1', intent: 'Run tests', command: 'bun test' })])
  })

  it('ignores tasks started by a subagent\'s tool calls', async () => {
    await assistantToolUse('toolu_sub', 'Bash', { command: 'ls' }, 'toolu_task')
    const events = await system({ subtype: 'task_started', task_id: 'b2', tool_use_id: 'toolu_sub', task_type: 'local_bash', is_backgrounded: true })
    expect(events).toEqual([])
  })

  it('announces a foreground command once it moves to the background', async () => {
    await assistantToolUse('toolu_3', 'Bash', { command: 'make build' })
    expect(await system({ subtype: 'task_started', task_id: 'b3', tool_use_id: 'toolu_3', task_type: 'local_bash', is_backgrounded: false })).toEqual([])
    const moved = await system({ subtype: 'task_updated', task_id: 'b3', patch: { is_backgrounded: true } })
    expect(moved).toEqual([expect.objectContaining({ type: 'shell_backgrounded', shellId: 'b3', command: 'make build' })])
    expect(await system({ subtype: 'task_updated', task_id: 'b3', patch: { is_backgrounded: true } })).toEqual([])
  })

  it('leaves agents and workflows to tool-result detection, and announces other tasks generically', async () => {
    await assistantToolUse('toolu_a', 'Agent', { description: 'Research' })
    expect(await system({ subtype: 'task_started', task_id: 'a1', tool_use_id: 'toolu_a', task_type: 'local_agent', is_backgrounded: true })).toEqual([])
    await assistantToolUse('toolu_m', 'Monitor', {})
    expect(await system({ subtype: 'task_started', task_id: 'm1', tool_use_id: 'toolu_m', task_type: 'monitor', description: 'Watch logs', is_backgrounded: true }))
      .toEqual([expect.objectContaining({ type: 'task_backgrounded', taskId: 'm1', kind: 'task', intent: 'Watch logs' })])
  })

  it('marks completions of its own tasks as launchedHere, across turns', async () => {
    await assistantToolUse('toolu_5', 'Bash', { command: 'sleep 60' })
    await system({ subtype: 'task_started', task_id: 'b5', tool_use_id: 'toolu_5', task_type: 'local_bash', is_backgrounded: true })
    adapter.startTurn()  // a later turn: the per-turn tool index is reset
    const own = await system({ subtype: 'task_notification', task_id: 'b5', tool_use_id: 'toolu_5', status: 'completed', output_file: '/tmp/b5', summary: '' })
    expect(own[0]).toMatchObject({ type: 'task_completed', taskId: 'b5', toolUseId: 'toolu_5', launchedHere: true })
    const foreign = await system({ subtype: 'task_notification', task_id: 'b9', tool_use_id: 'toolu_unknown', status: 'completed', output_file: '', summary: '' })
    expect(foreign[0]).toMatchObject({ launchedHere: false })
    expect(adapter.wasLaunchedByMainAgent('b5')).toBe(true)
  })
})
