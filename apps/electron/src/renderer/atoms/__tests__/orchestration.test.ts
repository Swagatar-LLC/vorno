/**
 * Tests for the PLAN-007 orchestration roll-up derivation.
 *
 * Covers:
 *  - background tasks: active vs done partitioning + terminal status mapping
 *  - subagent Tasks: parent -> child step counts from messages
 *  - cross-session grouping + focused-session pinning
 *  - retention-until-close: removing a session drops its items from the roll-up
 */

import { describe, it, expect } from 'bun:test'
import { createStore } from 'jotai'
import {
  buildSessionItems,
  orchestrationItemsAtom,
  toggleCollapsedSession,
  resolveToolUseTurnIndex,
} from '../orchestration'
import { groupMessagesByTurn } from '@craft-agent/ui/chat/turn-utils'
import {
  sessionIdsAtom,
  sessionAtomFamily,
  backgroundTasksAtomFamily,
  activeSessionIdAtom,
  type BackgroundTask,
} from '../sessions'
import type { Message, Session } from '../../../shared/types'

function tool(partial: Partial<Message> & { id: string; timestamp: number }): Message {
  return {
    role: 'tool',
    content: '',
    ...partial,
  } as Message
}

function makeSession(id: string, messages: Message[], name?: string): Session {
  return {
    id,
    workspaceId: 'w1',
    workspaceName: 'W',
    name,
    lastMessageAt: 0,
    messages,
    isProcessing: false,
  } as Session
}

describe('buildSessionItems — background tasks', () => {
  it('partitions active vs done and maps terminal status', () => {
    const tasks: BackgroundTask[] = [
      { id: 'a1', type: 'agent', toolUseId: 't1', startTime: 0, elapsedSeconds: 5 }, // running (no status)
      { id: 'a2', type: 'agent', toolUseId: 't2', startTime: 0, elapsedSeconds: 9, status: 'completed', durationMs: 9000 },
      { id: 's1', type: 'shell', toolUseId: 't3', startTime: 0, elapsedSeconds: 3, status: 'stopped' },
      { id: 'a3', type: 'agent', toolUseId: 't4', startTime: 0, elapsedSeconds: 2, status: 'failed' },
    ]

    const items = buildSessionItems('sess', 'Sess', [], tasks)

    expect(items).toHaveLength(4)
    const byId = Object.fromEntries(items.map(i => [i.id, i]))
    expect(byId.a1.status).toBe('running')
    expect(byId.a2.status).toBe('done')
    expect(byId.a2.durationMs).toBe(9000)
    expect(byId.s1.status).toBe('stopped')
    expect(byId.s1.kind).toBe('background-shell')
    expect(byId.a3.status).toBe('failed')
  })

  it('gives intent-less background tasks/shells a dignified label fallback', () => {
    const tasks: BackgroundTask[] = [
      { id: 'a1', type: 'agent', toolUseId: 't1', startTime: 0, elapsedSeconds: 5 },
      { id: 's1', type: 'shell', toolUseId: 't2', startTime: 0, elapsedSeconds: 3 },
      { id: 'a2', type: 'agent', toolUseId: 't3', startTime: 0, elapsedSeconds: 1, intent: 'Index repo' },
    ]

    const items = buildSessionItems('sess', 'Sess', [], tasks)
    const byId = Object.fromEntries(items.map(i => [i.id, i]))
    expect(byId.a1.label).toBe('Background task')
    expect(byId.s1.label).toBe('Background shell')
    expect(byId.a2.label).toBe('Index repo')
  })
})

describe('buildSessionItems — subagent Tasks', () => {
  it('counts child steps under a parent Task', () => {
    // Parent Task tool with two child tools (matched via parentToolUseId).
    const messages: Message[] = [
      tool({ id: 'm-task', timestamp: 1, toolName: 'Task', toolUseId: 'task-1', toolStatus: 'completed', toolResult: 'done', toolIntent: 'Research' }),
      tool({ id: 'm-c1', timestamp: 2, toolName: 'Read', toolUseId: 'c1', parentToolUseId: 'task-1', toolStatus: 'completed', toolResult: 'ok' }),
      tool({ id: 'm-c2', timestamp: 3, toolName: 'Grep', toolUseId: 'c2', parentToolUseId: 'task-1', toolStatus: 'completed', toolResult: 'ok' }),
    ]

    const items = buildSessionItems('sess', 'Sess', messages, [])

    const taskItem = items.find(i => i.kind === 'subagent-task')
    expect(taskItem).toBeDefined()
    expect(taskItem!.childStepCount).toBe(2)
    expect(taskItem!.label).toBe('Research')
    expect(taskItem!.status).toBe('done')
  })

  it('derives the label from the Task description when intent/displayName are absent', () => {
    // No toolIntent/toolDisplayName, but the Task tool input carries a short
    // "description" argument — that should become the label.
    const messages: Message[] = [
      tool({
        id: 'm-task',
        timestamp: 1,
        toolName: 'Task',
        toolUseId: 'task-1',
        toolStatus: 'completed',
        toolResult: 'done',
        toolInput: { description: 'Audit auth flow', prompt: 'long prompt...' },
      }),
    ]

    const items = buildSessionItems('sess', 'Sess', messages, [])
    const taskItem = items.find(i => i.kind === 'subagent-task')
    expect(taskItem!.label).toBe('Audit auth flow')
  })

  it('falls back to "Subagent task" (never "Agent <id8>") when nothing is available', () => {
    const messages: Message[] = [
      tool({ id: 'm-task', timestamp: 1, toolName: 'Task', toolUseId: 'task-1', toolStatus: 'completed', toolResult: 'done' }),
    ]

    const items = buildSessionItems('sess', 'Sess', messages, [])
    const taskItem = items.find(i => i.kind === 'subagent-task')
    expect(taskItem!.label).toBe('Subagent task')
    expect(taskItem!.label).not.toContain('Agent')
  })

  it('marks a running parent Task as running', () => {
    const messages: Message[] = [
      tool({ id: 'm-task', timestamp: 1, toolName: 'Task', toolUseId: 'task-1', toolStatus: 'executing', toolIntent: 'Build' }),
      tool({ id: 'm-c1', timestamp: 2, toolName: 'Bash', toolUseId: 'c1', parentToolUseId: 'task-1', toolStatus: 'executing' }),
    ]

    const items = buildSessionItems('sess', 'Sess', messages, [])
    const taskItem = items.find(i => i.kind === 'subagent-task')
    expect(taskItem!.status).toBe('running')
    expect(taskItem!.childStepCount).toBe(1)
  })
})

describe('toggleCollapsedSession — persisted collapsed-set helper', () => {
  it('adds an id when absent and removes it when present', () => {
    expect(toggleCollapsedSession([], 'A')).toEqual(['A'])
    expect(toggleCollapsedSession(['A'], 'B')).toEqual(['A', 'B'])
    expect(toggleCollapsedSession(['A', 'B'], 'A')).toEqual(['B'])
  })

  it('does not mutate the input array', () => {
    const cur = ['A']
    const next = toggleCollapsedSession(cur, 'B')
    expect(cur).toEqual(['A'])
    expect(next).toEqual(['A', 'B'])
  })
})

describe('resolveToolUseTurnIndex — click-to-jump tool-use → turn (PLAN-009)', () => {
  it('finds the assistant turn that contains the parent Task tool-use', () => {
    // Two assistant turns; the Task tool-use lives in the second turn.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'go', timestamp: 1 } as Message,
      tool({ id: 'm-r', timestamp: 2, toolName: 'Read', toolUseId: 'r1', toolStatus: 'completed', toolResult: 'ok' }),
      { id: 'a1', role: 'assistant', content: 'first response', timestamp: 3 } as Message,
      { id: 'u2', role: 'user', content: 'next', timestamp: 4 } as Message,
      tool({ id: 'm-task', timestamp: 5, toolName: 'Task', toolUseId: 'task-1', toolStatus: 'completed', toolResult: 'done', toolIntent: 'Research' }),
      { id: 'a2', role: 'assistant', content: 'second response', timestamp: 6 } as Message,
    ]
    const turns = groupMessagesByTurn(messages)
    const idx = resolveToolUseTurnIndex(turns, 'task-1')
    expect(idx).toBeGreaterThanOrEqual(0)
    const turn = turns[idx]
    expect(turn.type).toBe('assistant')
    if (turn.type === 'assistant') {
      expect(turn.activities.some((a) => a.toolUseId === 'task-1')).toBe(true)
    }
  })

  it('localizes the turn via a child tool whose parent is the Task', () => {
    const messages: Message[] = [
      tool({ id: 'm-task', timestamp: 1, toolName: 'Task', toolUseId: 'task-1', toolStatus: 'executing', toolIntent: 'Build' }),
      tool({ id: 'm-c1', timestamp: 2, toolName: 'Bash', toolUseId: 'c1', parentToolUseId: 'task-1', toolStatus: 'executing' }),
    ]
    const turns = groupMessagesByTurn(messages)
    // Resolving by the parent Task's tool-use id should still land on the turn.
    expect(resolveToolUseTurnIndex(turns, 'task-1')).toBeGreaterThanOrEqual(0)
  })

  it('returns -1 for an unknown tool-use id or empty input', () => {
    const turns = groupMessagesByTurn([
      tool({ id: 'm-task', timestamp: 1, toolName: 'Task', toolUseId: 'task-1', toolStatus: 'completed' }),
    ])
    expect(resolveToolUseTurnIndex(turns, 'nope')).toBe(-1)
    expect(resolveToolUseTurnIndex(turns, '')).toBe(-1)
    expect(resolveToolUseTurnIndex([], 'task-1')).toBe(-1)
  })
})

describe('orchestrationItemsAtom — cross-session roll-up', () => {
  it('groups by session, pins the focused session, and counts running items', () => {
    const store = createStore()

    const sessA = makeSession('A', [
      tool({ id: 'a-task', timestamp: 1, toolName: 'Task', toolUseId: 'ta', toolStatus: 'executing', toolIntent: 'A work' }),
    ], 'Alpha')
    const sessB = makeSession('B', [], 'Beta')

    store.set(sessionAtomFamily('A'), sessA)
    store.set(sessionAtomFamily('B'), sessB)
    store.set(backgroundTasksAtomFamily('B'), [
      { id: 'b1', type: 'agent', toolUseId: 'tb', startTime: 0, elapsedSeconds: 4 },
      { id: 'b2', type: 'agent', toolUseId: 'tb2', startTime: 0, elapsedSeconds: 8, status: 'completed' },
    ])
    store.set(sessionIdsAtom, ['A', 'B'])
    store.set(activeSessionIdAtom, 'B')

    const data = store.get(orchestrationItemsAtom)

    expect(data.groups).toHaveLength(2)
    // Focused session B is pinned first.
    expect(data.groups[0].sessionId).toBe('B')
    expect(data.groups[0].isFocused).toBe(true)
    expect(data.groups[1].sessionId).toBe('A')

    // Running: A's Task + B's b1 (b2 is done).
    expect(data.runningCount).toBe(2)
    expect(data.totalCount).toBe(3)
  })

  it('retention-until-close: removing a session drops its items', () => {
    const store = createStore()

    store.set(sessionAtomFamily('A'), makeSession('A', [], 'Alpha'))
    store.set(backgroundTasksAtomFamily('A'), [
      { id: 'done1', type: 'agent', toolUseId: 't', startTime: 0, elapsedSeconds: 1, status: 'completed' },
    ])
    store.set(sessionIdsAtom, ['A'])

    let data = store.get(orchestrationItemsAtom)
    expect(data.totalCount).toBe(1)
    // Completed item is retained while the session is open.
    expect(data.groups[0].items[0].status).toBe('done')

    // Session closes -> removed from sessionIdsAtom -> item drops from roll-up.
    store.set(sessionIdsAtom, [])
    data = store.get(orchestrationItemsAtom)
    expect(data.totalCount).toBe(0)
    expect(data.groups).toHaveLength(0)
  })
})
