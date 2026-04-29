/**
 * Tests for event-mapper.ts (Direction 1, PLAN-001).
 */

import { describe, test, expect } from 'bun:test'
import type { Message } from '@craft-agent/core'
import { messagesToGraph, LANE_X } from '../event-mapper'

function userMsg(id: string, text: string, opts: Partial<Message> = {}): Message {
  return { id, role: 'user', content: text, timestamp: Date.now(), ...opts }
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

  test('user message → text node in user lane', () => {
    const { nodes, edges } = messagesToGraph([userMsg('m1', 'hello')])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.type).toBe('text')
    expect(nodes[0]?.position.x).toBe(LANE_X.user)
    expect(edges).toHaveLength(0)
  })

  test('assistant message → text node in assistant lane', () => {
    const { nodes } = messagesToGraph([asstMsg('m1', 'hi back')])
    expect(nodes[0]?.position.x).toBe(LANE_X.assistant)
  })

  test('tool message → tool-call node in work lane', () => {
    const { nodes } = messagesToGraph([
      toolMsg('m1', 'Bash', { toolInput: { command: 'ls' }, toolStatus: 'executing' }),
    ])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.type).toBe('tool-call')
    expect(nodes[0]?.position.x).toBe(LANE_X.work)
  })

  test('user + assistant + tool → three lanes', () => {
    const { nodes } = messagesToGraph([
      userMsg('u1', 'help'),
      asstMsg('a1', 'sure', { turnId: 't1' }),
      toolMsg('t1m1', 'Bash', {
        turnId: 't1',
        toolInput: { command: 'ls' },
        toolResult: 'ok',
        toolStatus: 'completed',
      }),
    ])
    const xCoords = nodes.map((n) => n.position.x)
    expect(xCoords).toContain(LANE_X.user)
    expect(xCoords).toContain(LANE_X.assistant)
    expect(xCoords).toContain(LANE_X.work)
  })

  test('y advances monotonically across lanes', () => {
    const { nodes } = messagesToGraph([
      userMsg('u1', 'a'),
      asstMsg('a1', 'b'),
      asstMsg('a2', 'c'),
    ])
    const ys = nodes.map((n) => n.position.y)
    expect(ys[0]).toBe(0)
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]!).toBeGreaterThan(ys[i - 1]!)
    }
  })

  test('tool with result → tool-call + result, both in work lane, vertically stacked', () => {
    const { nodes, edges } = messagesToGraph([
      toolMsg('m1', 'Bash', {
        toolInput: { command: 'ls' },
        toolResult: 'file1\nfile2',
        toolStatus: 'completed',
      }),
    ])
    expect(nodes).toHaveLength(2)
    const [callNode, resultNode] = nodes
    expect(callNode!.type).toBe('tool-call')
    expect(resultNode!.type).toBe('result')
    expect(callNode!.position.x).toBe(LANE_X.work)
    expect(resultNode!.position.x).toBe(LANE_X.work)
    expect(resultNode!.position.y).toBeGreaterThan(callNode!.position.y)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      source: 'm1::call',
      target: 'm1::result',
      className: 'caused-by',
    })
  })

  test('full assistant → tool → result → assistant chain', () => {
    const { nodes, edges } = messagesToGraph([
      asstMsg('a1', 'I will run ls', { turnId: 't1' }),
      toolMsg('t1', 'Bash', {
        turnId: 't1',
        toolInput: { command: 'ls' },
        toolResult: 'a\nb',
        toolStatus: 'completed',
      }),
      asstMsg('a2', 'Done', { turnId: 't1' }),
    ])
    // a1 (text), t1::call (tool-call), t1::result (result), a2 (text)
    expect(nodes).toHaveLength(4)
    expect(nodes.map((n) => n.type)).toEqual(['text', 'tool-call', 'result', 'text'])
    // 3 edges: a1→call (sequence), call→result (caused-by), result→a2 (sequence)
    expect(edges).toHaveLength(3)
    expect(edges[0]).toMatchObject({ source: 'a1', target: 't1::call' })
    expect(edges[1]).toMatchObject({ source: 't1::call', target: 't1::result', className: 'caused-by' })
    expect(edges[2]).toMatchObject({ source: 't1::result', target: 'a2' })
  })

  test('skips unsupported roles', () => {
    const { nodes } = messagesToGraph([
      userMsg('m1', 'hi'),
      { id: 'm2', role: 'status', content: 'compacting', timestamp: Date.now() },
      { id: 'm3', role: 'info', content: 'info', timestamp: Date.now() },
      asstMsg('m4', 'hello'),
    ])
    expect(nodes).toHaveLength(2)
    expect(nodes.map((n) => n.id)).toEqual(['m1', 'm4'])
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

  test('messages in same turn share a turn color', () => {
    const { nodes } = messagesToGraph([
      asstMsg('a1', 'one', { turnId: 't1' }),
      asstMsg('a2', 'two', { turnId: 't1' }),
    ])
    const colors = nodes.map((n) => (n.data as { turnColor?: string }).turnColor)
    expect(colors[0]).toBe(colors[1])
    expect(colors[0]).toBeTruthy()
  })

  test('different turns get different colors', () => {
    const { nodes } = messagesToGraph([
      asstMsg('a1', 'one', { turnId: 't1' }),
      asstMsg('a2', 'two', { turnId: 't2' }),
    ])
    const colors = nodes.map((n) => (n.data as { turnColor?: string }).turnColor)
    expect(colors[0]).not.toBe(colors[1])
  })
})
