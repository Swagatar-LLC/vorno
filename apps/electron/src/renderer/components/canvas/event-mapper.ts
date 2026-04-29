/**
 * Map a session's Message[] into React Flow nodes and edges.
 *
 * Pure function — no React, no React Flow imports. Tested with bun.
 *
 * Layout strategy (v0.2):
 *   - Three lanes by role: user (left), assistant (center), work (right).
 *   - Y advances chronologically across all lanes; each message claims its
 *     own row. No overlap.
 *   - Tool calls and their results both live in the work lane, with the
 *     result placed directly below the call (a tool "claims two rows").
 *   - Each turn (group of messages with the same `turnId`) gets a distinct
 *     accent color. Cross-turn structure is visible at a glance.
 *
 * Edges:
 *   - 'sequence' edges connect each message to the next chronologically.
 *   - 'caused-by' edges connect tool-calls to their results by toolUseId.
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
  /** Used to style edges differently — 'sequence' = chronological, 'caused-by' = tool result link. */
  className?: string
}

export interface CanvasGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** X coordinate per lane. Lanes are 540 px apart; node width is ~460 px. */
export const LANE_X = {
  user: 0,
  assistant: 540,
  work: 1080,
} as const

/** Approximate node heights (used to advance the chronological Y cursor). */
const ROW_H_TEXT = 200
const ROW_H_TOOL_CALL = 140
const ROW_H_RESULT = 260
const ROW_GAP = 30

const SUPPORTED_ROLES = new Set(['user', 'assistant', 'tool'])

/**
 * Color palette for turn grouping. Cycled in encounter order — each new
 * turnId picks the next color. Default for messages without a turnId is the
 * neutral gray at index 0.
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

  const turnColors = new Map<string, string>()
  let nextTurnIdx = 1 // 0 reserved for neutral / undefined turnId

  function colorFor(turnId: string | undefined): string {
    if (!turnId) return TURN_PALETTE[0]!
    const cached = turnColors.get(turnId)
    if (cached) return cached
    const c = TURN_PALETTE[nextTurnIdx % (TURN_PALETTE.length - 1) + 1]!
    turnColors.set(turnId, c)
    nextTurnIdx += 1
    return c
  }

  let currentY = 0
  let lastNodeId: string | null = null

  for (const msg of messages) {
    if (!SUPPORTED_ROLES.has(msg.role)) continue
    const turnColor = colorFor(msg.turnId)

    if (msg.role === 'user' || msg.role === 'assistant') {
      const lane = msg.role === 'user' ? 'user' : 'assistant'
      const node: CanvasNode = {
        id: msg.id,
        type: 'text',
        position: { x: LANE_X[lane], y: currentY },
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
      currentY += ROW_H_TEXT + ROW_GAP
      continue
    }

    // tool message
    const hasResult = msg.toolResult !== undefined && msg.toolResult !== null
    const isCompleted = msg.toolStatus === 'completed' || msg.toolStatus === 'error'
    const toolUseId = msg.toolUseId ?? msg.id

    const toolCallNode: CanvasNode = {
      id: `${msg.id}::call`,
      type: 'tool-call',
      position: { x: LANE_X.work, y: currentY },
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

    currentY += ROW_H_TOOL_CALL + ROW_GAP

    if (hasResult || isCompleted) {
      const resultNode: CanvasNode = {
        id: `${msg.id}::result`,
        type: 'result',
        position: { x: LANE_X.work, y: currentY },
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
      currentY += ROW_H_RESULT + ROW_GAP
    } else {
      lastNodeId = toolCallNode.id
    }
  }

  return { nodes, edges }
}
