/**
 * Tests for event-mapper.ts (Direction 1, PLAN-001).
 */

import { describe, test, expect } from 'bun:test'
import type { Message } from '@craft-agent/core'
import { messagesToGraph } from '../event-mapper'

function userMsg(id: string, text: string): Message {
  return { id, role: 'user', content: text, timestamp: Date.now() }
}

function asstMsg(id: string, text: string, opts: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content: text, timestamp: Date.now(), ...opts }
}

function toolMsg(id: string, toolName: string, opts: Partial<Message> = {}): Message {
  return {
    id,
    role: 'tool',
    content: '',
    timestamp: Date.now(),
    toolName,
    toolUseId: opts.toolUseId ?? `${id}-use`,
    ...opts,
  }
}

describe('messagesToGraph', () => {
  test('empty input → empty graph', () => {
    expect(messagesToGraph([])).toEqual({ nodes: [], edges: [] })
  })

  test('single user message → one text node, no edges', () => {
    const { nodes, edges } = messagesToGraph([userMsg('m1', 'hello')])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.type).toBe('text')
    expect(nodes[0]?.id).toBe('m1')
    expect(edges).toHaveLength(0)
  })

  test('user + assistant → two text nodes, one sequence edge', () => {
    const { nodes, edges } = messagesToGraph([
      userMsg('m1', 'hi'),
      asstMsg('m2', 'hello back'),
    ])
    expect(nodes).toHaveLength(2)
    expect(nodes.map((n) => n.type)).toEqual(['text', 'text'])
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ source: 'm1', target: 'm2', className: 'sequence' })
  })

  test('tool with result → tool-call + result nodes + caused-by edge', () => {
    const { nodes, edges } = messagesToGraph([
      toolMsg('m1', 'Bash', {
        toolInput: { command: 'ls' },
        toolResult: 'file1\nfile2',
        toolStatus: 'completed',
      }),
    ])
    expect(nodes).toHaveLength(2)
    expect(nodes[0]?.type).toBe('tool-call')
    expect(nodes[1]?.type).toBe('result')
    // No prior message → no inbound sequence edge.
    // One caused-by edge from tool-call to result.
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      source: 'm1::call',
      target: 'm1::result',
      className: 'caused-by',
    })
  })

  test('tool without result → only tool-call node, no result edge', () => {
    const { nodes, edges } = messagesToGraph([
      toolMsg('m1', 'Bash', { toolInput: { command: 'ls' }, toolStatus: 'executing' }),
    ])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.type).toBe('tool-call')
    expect(edges).toHaveLength(0)
  })

  test('full assistant → tool → result chain', () => {
    const { nodes, edges } = messagesToGraph([
      asstMsg('a1', 'I will run ls'),
      toolMsg('t1', 'Bash', {
        toolInput: { command: 'ls' },
        toolResult: 'a\nb',
        toolStatus: 'completed',
      }),
      asstMsg('a2', 'Done'),
    ])
    // a1 (text), t1::call (tool-call), t1::result (result), a2 (text) = 4 nodes
    expect(nodes).toHaveLength(4)
    expect(nodes.map((n) => n.type)).toEqual(['text', 'tool-call', 'result', 'text'])
    // Edges: a1→t1::call, t1::call→t1::result (caused-by), t1::result→a2 = 3 edges
    expect(edges).toHaveLength(3)
    expect(edges[0]).toMatchObject({ source: 'a1', target: 't1::call' })
    expect(edges[1]).toMatchObject({ source: 't1::call', target: 't1::result', className: 'caused-by' })
    expect(edges[2]).toMatchObject({ source: 't1::result', target: 'a2' })
  })

  test('skips unsupported roles (status, info, error, plan)', () => {
    const { nodes } = messagesToGraph([
      userMsg('m1', 'hi'),
      { id: 'm2', role: 'status', content: 'compacting', timestamp: Date.now() },
      { id: 'm3', role: 'info', content: 'info', timestamp: Date.now() },
      asstMsg('m4', 'hello'),
    ])
    expect(nodes).toHaveLength(2)
    expect(nodes.map((n) => n.id)).toEqual(['m1', 'm4'])
  })

  test('positions nodes vertically (y increases monotonically)', () => {
    const { nodes } = messagesToGraph([
      userMsg('m1', 'a'),
      asstMsg('m2', 'b'),
      asstMsg('m3', 'c'),
    ])
    const ys = nodes.map((n) => n.position.y)
    expect(ys[0]).toBe(0)
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]!).toBeGreaterThan(ys[i - 1]!)
    }
  })

  test('error tool result marks isError on result node', () => {
    const { nodes } = messagesToGraph([
      toolMsg('t1', 'Bash', {
        toolResult: 'permission denied',
        toolStatus: 'error',
      }),
    ])
    const resultNode = nodes.find((n) => n.type === 'result')
    expect(resultNode).toBeDefined()
    expect((resultNode!.data as { isError?: boolean }).isError).toBe(true)
  })
})
