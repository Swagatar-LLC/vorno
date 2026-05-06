/**
 * Map a session's Message[] into React Flow nodes and edges.
 *
 * Pure function — no React, no React Flow imports. Tested with bun.
 *
 * Layout (v0.4 — horizontal timeline):
 *   - Time flows left → right. Each message advances X by NODE_W + GAP_X.
 *   - Three lanes by role, stacked vertically:
 *       USER       → top    (y = 0)
 *       ASSISTANT  → middle (y = 240)
 *       WORK       → bottom (y = 480)
 *   - Tool calls and their results occupy consecutive X slots in the work lane.
 *   - Each turn (group of messages with the same `turnId`) gets a distinct
 *     accent color rendered as a left-border stripe on every node.
 *
 * Points of interest (POIs) are emitted alongside nodes/edges and used by:
 *   - TurnMarkerNode (canvas-space dashed vertical guides at turn starts)
 *   - TimelineRuler (top strip with clickable ticks)
 *   - PoiSidebar (right-edge collapsible list)
 *
 * Edges:
 *   - 'sequence' edges: chronological, left → right.
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

export type POIType = 'turn-start' | 'error'

export interface POI {
  /** Stable id for React keying. */
  id: string
  /** Kind of point of interest. */
  type: POIType
  /** Canvas X to center on when the POI is clicked. */
  x: number
  /** Short label shown in the timeline ruler and sidebar. */
  label: string
  /** Optional secondary description shown in the sidebar. */
  detail?: string
  /** Color associated with the turn this POI belongs to (for ruler ticks). */
  color: string
  /** TurnId, when applicable. */
  turnId?: string
}

export interface CanvasGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  pois: POI[]
  /** Canvas X span — useful for the ruler to compute proportional positions. */
  span: { minX: number; maxX: number }
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

export const LANE_Y = {
  user: 0,
  assistant: 240,
  work: 480,
} as const

/** Total Y extent of the lanes (work lane bottom). */
export const LANES_HEIGHT = 700

export const NODE_W = 460
const GAP_X = 40
const X_STEP = NODE_W + GAP_X

const SUPPORTED_ROLES = new Set(['user', 'assistant', 'tool'])

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
  const pois: POI[] = []

  const turnColors = new Map<string, string>()
  let nextTurnIdx = 1
  let turnCount = 0

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
  let lastTurnId: string | undefined = undefined
  let isFirst = true

  function emitTurnPoiIfChanged(turnId: string | undefined, x: number) {
    if (isFirst || turnId !== lastTurnId) {
      turnCount += 1
      pois.push({
        id: `turn:${turnId ?? 'untagged'}:${x}`,
        type: 'turn-start',
        x,
        label: turnId ? `Turn ${turnCount}` : 'Untagged',
        detail: turnId ? `turn id: ${turnId}` : 'No turn id',
        color: colorFor(turnId),
        turnId,
      })
      lastTurnId = turnId
      isFirst = false
    }
  }

  for (const msg of messages) {
    if (!SUPPORTED_ROLES.has(msg.role)) continue
    const turnColor = colorFor(msg.turnId)
    emitTurnPoiIfChanged(msg.turnId, timeX)

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
      if (msg.isError) {
        pois.push({
          id: `error:${msg.id}`,
          type: 'error',
          x: timeX,
          label: 'Error',
          detail: (msg.content ?? '').slice(0, 80),
          color: '#dc2626',
          turnId: msg.turnId,
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
    const callX = timeX

    const toolCallNode: CanvasNode = {
      id: `${msg.id}::call`,
      type: 'tool-call',
      position: { x: callX, y: LANE_Y.work },
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
      const resultX = timeX
      const isError = msg.toolStatus === 'error' || msg.isError === true
      const resultNode: CanvasNode = {
        id: `${msg.id}::result`,
        type: 'result',
        position: { x: resultX, y: LANE_Y.work },
        data: {
          kind: 'result',
          toolName: msg.toolName ?? 'unknown',
          toolUseId,
          result: msg.toolResult ?? '',
          isError,
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

      if (isError) {
        pois.push({
          id: `error:${msg.id}::result`,
          type: 'error',
          x: resultX,
          label: `${msg.toolName ?? 'tool'} error`,
          detail: (msg.toolResult ?? '').slice(0, 80),
          color: '#dc2626',
          turnId: msg.turnId,
        })
      }

      lastNodeId = resultNode.id
      timeX += X_STEP
    } else {
      lastNodeId = toolCallNode.id
    }
  }

  const minX = 0
  const maxX = Math.max(0, timeX - GAP_X)

  return { nodes, edges, pois, span: { minX, maxX } }
}
