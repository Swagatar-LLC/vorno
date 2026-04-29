/**
 * Map a session's Message[] into React Flow nodes and edges.
 *
 * Pure function — no React, no React Flow imports. Tested with bun.
 *
 * Layout (v0.3 — horizontal timeline):
 *   - Time flows left → right. Each message advances X by NODE_W + GAP_X.
 *   - Three lanes by role, stacked vertically:
 *       USER       → top    (y = 0)
 *       ASSISTANT  → middle (y = 240)
 *       WORK       → bottom (y = 480)
 *   - Tool calls and their results live in the work lane and occupy
 *     consecutive X slots (call at T, result at T+1).
 *   - Each turn (group of messages with the same `turnId`) gets a distinct
 *     accent color rendered as a left-border stripe on every node.
 *
 * The horizontal layout is the foundation for a timeline metaphor: scrubbing
 * a playhead, points-of-interest markers at turn boundaries, and panning
 * along time. Those affordances layer on top in subsequent iterations.
 *
 * Edges:
 *   - 'sequence' edges: chronological, source on right, target on left.
 *   - 'caused-by' edges: tool-call → result by toolUseId.
 *
 * Unsupported roles (status, info, warning, plan, auth-request, error) are
 * skipped — they still render in the chat surface; the canvas omits them.
 */

import type { Message } from '@craft-agent/core'
import type { CanvasNodeData } from './types'

export interface CanvasNode {
  id: string
  type: 'text' | 'tool-call' | 'result'
  position: { x: number; y: number }
  data: CanvasNodeData
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
  type?: 'smoothstep' | 'straight'
  animated?: boolean
  className?: string
}

export interface CanvasGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  /** Vertical guides at X positions where the turnId changed. Useful for POI markers. */
  turnBoundaries: Array<{ x: number; turnId: string | undefined; color: string }>
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Y coordinate per lane. Lanes are 240 px apart; node height is ~200 px. */
export const LANE_Y = {
  user: 0,
  assistant: 240,
  work: 480,
} as const

/** Width of every node card and the X gap between consecutive nodes. */
export const NODE_W = 460
const GAP_X = 40
/** Step from one chronological slot to the next. */
const X_STEP = NODE_W + GAP_X

const SUPPORTED_ROLES = new Set(['user', 'assistant', 'tool'])

/**
 * Color palette for turn grouping. Cycled in encounter order — each new
 * turnId picks the next color. Index 0 is the neutral default.
 */
const TURN_PALETTE = [
  '#94a3b8', // slate-400 (neutral / no turn)
  '#6366f1', // indigo-500
  '#16a34a', // green-600
  '#c2410c', // orange-700 (matches our fork accent)
  '#0284c7', // sky-600
  '#9333ea', // purple-600
  '#ca8a04', // yellow-600
  '#db2777', // pink-600
] as const

// ---------------------------------------------------------------------------
// messagesToGraph
// ---------------------------------------------------------------------------

export function messagesToGraph(messages: Message[]): CanvasGraph {
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  const turnBoundaries: CanvasGraph['turnBoundaries'] = []

  const turnColors = new Map<string, string>()
  let nextTurnIdx = 1

  function colorFor(turnId: string | undefined): string {
    if (!turnId) return TURN_PALETTE[0]!
    const cached = turnColors.get(turnId)
    if (cached) return cached
    const c = TURN_PALETTE[nextTurnIdx % (TURN_PALETTE.length - 1) + 1]!
    turnColors.set(turnId, c)
    nextTurnIdx += 1
    return c
  }

  let timeX = 0
  let lastNodeId: string | null = null
  let lastTurnId: string | undefined

  function emitTurnBoundaryIfChanged(turnId: string | undefined, x: number) {
    if (turnId !== lastTurnId) {
      turnBoundaries.push({ x: x - GAP_X / 2, turnId, color: colorFor(turnId) })
      lastTurnId = turnId
    }
  }

  for (const msg of messages) {
    if (!SUPPORTED_ROLES.has(msg.role)) continue
    const turnColor = colorFor(msg.turnId)
    emitTurnBoundaryIfChanged(msg.turnId, timeX)

    if (msg.role === 'user' || msg.role === 'assistant') {
      const lane = msg.role === 'user' ? 'user' : 'assistant'
      const node: CanvasNode = {
        id: msg.id,
        type: 'text',
        position: { x: timeX, y: LANE_Y[lane] },
        data: {
          kind: 'text',
          role: msg.role,
          text: msg.content ?? '',
          isStreaming: msg.isStreaming,
          isError: msg.isError,
          turnColor,
          lane,
        },
      }
      nodes.push(node)
      if (lastNodeId) {
        edges.push({
          id: `${lastNodeId}->${node.id}`,
          source: lastNodeId,
          target: node.id,
          type: 'smoothstep',
          className: 'sequence',
        })
      }
      lastNodeId = node.id
      timeX += X_STEP
      continue
    }

    // tool message
    const hasResult = msg.toolResult !== undefined && msg.toolResult !== null
    const isCompleted = msg.toolStatus === 'completed' || msg.toolStatus === 'error'
    const toolUseId = msg.toolUseId ?? msg.id

    const toolCallNode: CanvasNode = {
      id: `${msg.id}::call`,
      type: 'tool-call',
      position: { x: timeX, y: LANE_Y.work },
      data: {
        kind: 'tool-call',
        toolName: msg.toolName ?? 'unknown',
        toolDisplayName: msg.toolDisplayName,
        toolUseId,
        input: msg.toolInput,
        status: msg.toolStatus ?? (hasResult ? 'completed' : 'executing'),
        turnColor,
        lane: 'work',
      },
    }
    nodes.push(toolCallNode)

    if (lastNodeId) {
      edges.push({
        id: `${lastNodeId}->${toolCallNode.id}`,
        source: lastNodeId,
        target: toolCallNode.id,
        type: 'smoothstep',
        className: 'sequence',
      })
    }

    timeX += X_STEP

    if (hasResult || isCompleted) {
      const resultNode: CanvasNode = {
        id: `${msg.id}::result`,
        type: 'result',
        position: { x: timeX, y: LANE_Y.work },
        data: {
          kind: 'result',
          toolName: msg.toolName ?? 'unknown',
          toolUseId,
          result: msg.toolResult ?? '',
          isError: msg.toolStatus === 'error' || msg.isError,
          turnColor,
          lane: 'work',
        },
      }
      nodes.push(resultNode)

      edges.push({
        id: `${toolCallNode.id}->${resultNode.id}`,
        source: toolCallNode.id,
        target: resultNode.id,
        type: 'smoothstep',
        className: 'caused-by',
      })

      lastNodeId = resultNode.id
      timeX += X_STEP
    } else {
      lastNodeId = toolCallNode.id
    }
  }

  return { nodes, edges, turnBoundaries }
}
