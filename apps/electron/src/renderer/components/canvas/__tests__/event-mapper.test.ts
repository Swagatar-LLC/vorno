/**
 * Tests for event-mapper.ts (Direction 1, PLAN-001).
 */

import { describe, test, expect } from 'bun:test'
import type { Message } from '@craft-agent/core'
import { messagesToGraph, LANE_Y } from '../event-mapper'

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

describe('messagesToGraph (horizontal)', () => {
  test('empty input → empty graph', () => {
    const g = messagesToGraph([])
    expect(g.nodes).toEqual([])
    expect(g.edges).toEqual([])
    expect(g.pois).toEqual([])
  })

  test('user message → text node in user lane (top)', () => {
    const { nodes } = messagesToGraph([userMsg('m1', 'hello')])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.position.y).toBe(LANE_Y.user)
  })

  test('assistant message → text node in assistant lane (middle)', () => {
    const { nodes } = messagesToGraph([asstMsg('m1', 'hi back')])
    expect(nodes[0]?.position.y).toBe(LANE_Y.assistant)
  })

  test('tool message → tool-call node in work lane (bottom)', () => {
    const { nodes } = messagesToGraph([
      toolMsg('m1', 'Bash', { toolInput: { command: 'ls' }, toolStatus: 'executing' }),
    ])
    expect(nodes[0]?.position.y).toBe(LANE_Y.work)
  })

  test('user + assistant + tool → three different y values', () => {
    const { nodes } = messagesToGraph([
      userMsg('u1', 'help'),
      asstMsg('a1', 'sure'),
      toolMsg('t1', 'Bash', { toolStatus: 'executing' }),
    ])
    const ys = nodes.map((n) => n.position.y)
    expect(new Set(ys).size).toBe(3)
    expect(ys).toContain(LANE_Y.user)
    expect(ys).toContain(LANE_Y.assistant)
    expect(ys).toContain(LANE_Y.work)
  })

  test('x advances monotonically across messages (timeline)', () => {
    const { nodes } = messagesToGraph([
      userMsg('u1', 'a'),
      asstMsg('a1', 'b'),
      asstMsg('a2', 'c'),
    ])
    const xs = nodes.map((n) => n.position.x)
    expect(xs[0]).toBe(0)
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]!).toBeGreaterThan(xs[i - 1]!)
    }
  })

  test('tool with result → both in work lane, result advances X', () => {
    const { nodes, edges } = messagesToGraph([
      toolMsg('m1', 'Bash', {
        toolInput: { command: 'ls' },
        toolResult: 'file1\nfile2',
        toolStatus: 'completed',
      }),
    ])
    expect(nodes).toHaveLength(2)
    const [callNode, resultNode] = nodes
    expect(callNode!.position.y).toBe(LANE_Y.work)
    expect(resultNode!.position.y).toBe(LANE_Y.work)
    expect(resultNode!.position.x).toBeGreaterThan(callNode!.position.x)
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
    expect(nodes).toHaveLength(4)
    expect(nodes.map((n) => n.type)).toEqual(['text', 'tool-call', 'result', 'text'])
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
      toolMsg('t1', 'Bash', { toolResult: 'permission denied', toolStatus: 'error' }),
    ])
    const resultNode = nodes.find((n) => n.type === 'result')
    expect((resultNode!.data as { isError?: boolean }).isError).toBe(true)
  })

  test('messages in same turn share a turn color', () => {
    const { nodes } = messagesToGraph([
      asstMsg('a1', 'one', { turnId: 't1' }),
      asstMsg('a2', 'two', { turnId: 't1' }),
    ])
    const colors = nodes.map((n) => (n.data as { turnColor?: string }).turnColor)
    expect(colors[0]).toBe(colors[1])
  })

  test('different turns get different colors', () => {
    const { nodes } = messagesToGraph([
      asstMsg('a1', 'one', { turnId: 't1' }),
      asstMsg('a2', 'two', { turnId: 't2' }),
    ])
    const colors = nodes.map((n) => (n.data as { turnColor?: string }).turnColor)
    expect(colors[0]).not.toBe(colors[1])
  })

  test('emits a turn-start POI at each turn change', () => {
    const { pois } = messagesToGraph([
      asstMsg('a1', 'one', { turnId: 't1' }),
      asstMsg('a2', 'two', { turnId: 't1' }),
      asstMsg('a3', 'three', { turnId: 't2' }),
    ])
    const turnStarts = pois.filter((p) => p.type === 'turn-start')
    expect(turnStarts.length).toBeGreaterThanOrEqual(2)
    const turnIds = turnStarts.map((p) => p.turnId)
    expect(turnIds).toContain('t1')
    expect(turnIds).toContain('t2')
  })

  test('emits an error POI for a tool error result', () => {
    const { pois } = messagesToGraph([
      asstMsg('a1', 'go', { turnId: 't1' }),
      toolMsg('t1', 'Bash', {
        turnId: 't1',
        toolResult: 'permission denied',
        toolStatus: 'error',
      }),
    ])
    const errors = pois.filter((p) => p.type === 'error')
    expect(errors.length).toBe(1)
    expect(errors[0]?.color).toBe('#dc2626')
    expect(errors[0]?.label).toContain('Bash')
  })

  test('span tracks the timeline extent', () => {
    const { span, nodes } = messagesToGraph([
      userMsg('u1', 'a'),
      asstMsg('a1', 'b'),
      asstMsg('a2', 'c'),
    ])
    expect(span.minX).toBe(0)
    expect(span.maxX).toBeGreaterThanOrEqual(nodes[nodes.length - 1]!.position.x)
  })
})
