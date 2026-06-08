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
} from '../orchestration'
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

describe('orchestrationItemsAtom — cross-session roll-up', () => {
  it('groups by session, pins the focused session, and counts running items', () => {
    const store = createStore()

    const sessA = makeSession('A', [
      tool({ id: 'a-task', timestamp: 1, toolName: 'Task', toolUseId: 'ta', toolStatus: 'executing', intent: 'A work' }),
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
