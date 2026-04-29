/**
 * CanvasSession — Direction 1, v0.1.
 *
 * Renders a session's Message[] as a React Flow node graph.
 * Read-only spectator: no edits propagate back.
 *
 * The component takes a sessionId and reads the session via Jotai. We derive
 * { nodes, edges } from session.messages on every render (memoized). For
 * sessions in the low hundreds of messages this is fine; deferred: virtualization.
 */

import React, { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { Session } from '../../../shared/types'
import { sessionAtomFamily } from '@/atoms/sessions'
import { messagesToGraph } from './event-mapper'
import { TextNode } from './nodes/TextNode'
import { ToolCallNode } from './nodes/ToolCallNode'
import { ResultNode } from './nodes/ResultNode'

const NODE_TYPES: NodeTypes = {
  'text': TextNode as unknown as NodeTypes[string],
  'tool-call': ToolCallNode as unknown as NodeTypes[string],
  'result': ResultNode as unknown as NodeTypes[string],
}

export interface CanvasSessionProps {
  sessionId: string
}

export function CanvasSession({ sessionId }: CanvasSessionProps) {
  // sessionAtomFamily is typed as Atom<unknown> due to a known monorepo issue;
  // we know the value is Session | null. Cast pragmatically here.
  const session = useAtomValue(sessionAtomFamily(sessionId)) as Session | null

  const { nodes, edges } = useMemo(() => {
    if (!session?.messages) return { nodes: [] as Node[], edges: [] as Edge[] }
    const graph = messagesToGraph(session.messages)
    return {
      nodes: graph.nodes as unknown as Node[],
      edges: graph.edges as unknown as Edge[],
    }
  }, [session?.messages])

  if (!session) {
    return <CanvasEmptyState message="No session selected." />
  }

  if (!session.messages || session.messages.length === 0) {
    return <CanvasEmptyState message="No events yet — send a message to begin." />
  }

  return (
    <div style={{ width: '100%', height: '100%', background: '#fafaf9' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={16} size={1} color="#e7e5e4" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          position="bottom-left"
          nodeColor={(n) => {
            if (n.type === 'tool-call') return '#c2410c'
            if (n.type === 'result') return '#16a34a'
            return '#6366f1'
          }}
          pannable
          zoomable
        />
      </ReactFlow>
    </div>
  )
}

function CanvasEmptyState({ message }: { message: string }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#78716c',
        fontSize: 14,
        background: '#fafaf9',
      }}
    >
      {message}
    </div>
  )
}
