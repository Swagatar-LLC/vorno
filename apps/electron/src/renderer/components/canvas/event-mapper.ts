/**
 * Map a session's Message[] into React Flow nodes and edges.
 *
 * Pure function — no React, no React Flow imports. Tested with bun.
 *
 * Layout strategy for v0.1: vertical time-axis. Each message is a node
 * placed at (X_BASE, index * Y_STEP). The user can drag freely afterward;
 * we don't persist drag positions yet (deferred from v0.1).
 *
 * Edge strategy:
 *   - Sequential edges connect each message to the next (chronological flow).
 *   - For tool messages: a stronger "produced-by" edge links a result node
 *     to its tool-call by toolUseId, distinct from the chronological chain.
 *
 * Unsupported message roles in v0.1 are skipped (status, info, warning,
 * plan, auth-request, error). They render in the chat surface as before;
 * the canvas just omits them.
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

const X_BASE = 0
const Y_STEP = 180

const SUPPORTED_ROLES = new Set(['user', 'assistant', 'tool'])

export function messagesToGraph(messages: Message[]): CanvasGraph {
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []

  // Tool-call → result pairing keyed by toolUseId.
  const toolCallNodeIdByUseId = new Map<string, string>()

  let lastNodeId: string | null = null
  let row = 0

  for (const msg of messages) {
    if (!SUPPORTED_ROLES.has(msg.role)) continue

    const position = { x: X_BASE, y: row * Y_STEP }

    if (msg.role === 'user' || msg.role === 'assistant') {
      const node: CanvasNode = {
        id: msg.id,
        type: 'text',
        position,
        data: {
          kind: 'text',
          role: msg.role,
          text: msg.content ?? '',
          isStreaming: msg.isStreaming,
          isError: msg.isError,
        },
      }
      nodes.push(node)
    } else if (msg.role === 'tool') {
      const hasResult = msg.toolResult !== undefined && msg.toolResult !== null
      const isCompleted = msg.toolStatus === 'completed' || msg.toolStatus === 'error'

      // The lifecycle of a tool message: it starts as a tool-call (no result),
      // gains a toolResult, and toolStatus moves to completed/error.
      // For v0.1, we render *both* a tool-call node and a result node when both
      // pieces are present — that's the spec's "3 node types" requirement.
      const toolUseId = msg.toolUseId ?? msg.id

      // Tool-call node — always present for tool messages.
      const toolCallNode: CanvasNode = {
        id: `${msg.id}::call`,
        type: 'tool-call',
        position,
        data: {
          kind: 'tool-call',
          toolName: msg.toolName ?? 'unknown',
          toolDisplayName: msg.toolDisplayName,
          toolUseId,
          input: msg.toolInput,
          status: msg.toolStatus ?? (hasResult ? 'completed' : 'executing'),
        },
      }
      nodes.push(toolCallNode)
      toolCallNodeIdByUseId.set(toolUseId, toolCallNode.id)

      // Result node — only if a result is present.
      if (hasResult || isCompleted) {
        row += 1
        const resultNode: CanvasNode = {
          id: `${msg.id}::result`,
          type: 'result',
          position: { x: X_BASE, y: row * Y_STEP },
          data: {
            kind: 'result',
            toolName: msg.toolName ?? 'unknown',
            toolUseId,
            result: msg.toolResult ?? '',
            isError: msg.toolStatus === 'error' || msg.isError,
          },
        }
        nodes.push(resultNode)

        // Sequence edge from prior chain → tool-call (chronological link first).
        if (lastNodeId) {
          edges.push({
            id: `${lastNodeId}->${toolCallNode.id}`,
            source: lastNodeId,
            target: toolCallNode.id,
            type: 'smoothstep',
            className: 'sequence',
          })
        }

        // Caused-by edge: tool-call → result.
        edges.push({
          id: `${toolCallNode.id}->${resultNode.id}`,
          source: toolCallNode.id,
          target: resultNode.id,
          type: 'smoothstep',
          className: 'caused-by',
        })

        // Chronological chain continues from result, not call.
        lastNodeId = resultNode.id
        row += 1
        continue
      }
    }

    // Sequential edge from previous node.
    if (lastNodeId) {
      const currentId = nodes[nodes.length - 1]!.id
      edges.push({
        id: `${lastNodeId}->${currentId}`,
        source: lastNodeId,
        target: currentId,
        type: 'smoothstep',
        className: 'sequence',
      })
    }

    lastNodeId = nodes[nodes.length - 1]!.id
    row += 1
  }

  return { nodes, edges }
}
