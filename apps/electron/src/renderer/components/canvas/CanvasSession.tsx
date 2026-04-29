/**
 * CanvasSession — Direction 1, v0.2.
 *
 * Renders a session's Message[] as a React Flow node graph with three lanes:
 * user (left), assistant (center), work (right). Read-only spectator.
 *
 * Layout improvements over v0.1:
 *   - Lanes by message role; no more vertical stack of overlapping cards.
 *   - Each turn (assistant message + its tool calls + their results) gets
 *     a distinct accent color via the left-border stripe on every node.
 *   - fitView is run *after* custom nodes have measured (via onInit + a
 *     small delay) so the initial zoom isn't a telescope.
 *   - MiniMap node strokes are thicker so nodes show up at the minimap scale.
 */

import React, { useCallback, useMemo } from 'react'
import { useAtomValue } from 'jotai'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { Session } from '../../../shared/types'
import { sessionAtomFamily } from '@/atoms/sessions'
import { messagesToGraph, LANE_X } from './event-mapper'
import { TextNode } from './nodes/TextNode'
import { ToolCallNode } from './nodes/ToolCallNode'
import { ResultNode } from './nodes/ResultNode'

const NODE_TYPES: NodeTypes = {
  'text': TextNode as unknown as NodeTypes[string],
  'tool-call': ToolCallNode as unknown as NodeTypes[string],
  'result': ResultNode as unknown as NodeTypes[string],
}

const LANE_LABELS: Array<{ key: 'user' | 'assistant' | 'work'; label: string; x: number }> = [
  { key: 'user', label: 'USER', x: LANE_X.user },
  { key: 'assistant', label: 'ASSISTANT', x: LANE_X.assistant },
  { key: 'work', label: 'WORK · TOOLS · RESULTS', x: LANE_X.work },
]

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

  // Run fitView once nodes have measured. React Flow's `fitView` prop fires
  // immediately on mount, before custom nodes have rendered, so it ends up
  // fitting to ~zero-sized boxes (the "telescope zoom" problem). Using onInit
  // + a small delay lets the renderer measure first.
  const handleInit = useCallback((instance: ReactFlowInstance) => {
    setTimeout(() => {
      instance.fitView({ padding: 0.25, duration: 200, includeHiddenNodes: false })
    }, 80)
  }, [])

  if (!session) {
    return <CanvasEmptyState message="No session selected." />
  }

  if (!session.messages || session.messages.length === 0) {
    return <CanvasEmptyState message="No events yet — send a message to begin." />
  }

  return (
    <div style={{ width: '100%', height: '100%', background: '#fafaf9', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onInit={handleInit}
        minZoom={0.1}
        maxZoom={2}
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
            const data = n.data as { role?: string } | undefined
            if (data?.role === 'user') return '#6366f1'
            return '#a8a29e'
          }}
          nodeStrokeWidth={6}
          nodeBorderRadius={4}
          pannable
          zoomable
          ariaLabel="Session canvas mini-map"
          style={{ width: 220, height: 160 }}
        />
      </ReactFlow>
      {/* Lane headers — fixed in screen space, not part of the canvas. They
          serve as orientation hints; for v0.2 they're a simple top bar.
          A future iteration can position them in canvas space via a Panel
          so they pan with the nodes — deferred. */}
      <LaneHeaderBar />
    </div>
  )
}

function LaneHeaderBar() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        right: 8,
        display: 'flex',
        gap: 8,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      {LANE_LABELS.map((lane) => (
        <div
          key={lane.key}
          style={{
            flex: 1,
            fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.12em',
            color: '#a8a29e',
            background: 'rgba(255,255,255,0.65)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            padding: '4px 10px',
            border: '1px solid #e7e5e4',
            borderRadius: 4,
            textAlign: 'center',
          }}
        >
          {lane.label}
        </div>
      ))}
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
