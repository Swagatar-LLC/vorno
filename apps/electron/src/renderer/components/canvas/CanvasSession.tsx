/**
 * CanvasSession — Direction 1, v0.3 (horizontal timeline).
 *
 * Renders a session's Message[] as a React Flow node graph laid out as a
 * horizontal timeline:
 *   - Time flows left → right (X axis).
 *   - Three lanes by message role, stacked vertically (Y axis):
 *       USER       → top
 *       ASSISTANT  → middle
 *       WORK       → bottom
 *   - Turn boundaries (where Message.turnId changes) emit faint vertical
 *     guide lines as a foundation for points-of-interest markers.
 *
 * This is the substrate for a timeline metaphor: scrubbing, POI markers,
 * and time-range filtering. Those affordances layer on top in v0.4.
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
import { messagesToGraph, LANE_Y } from './event-mapper'
import type { CanvasGraph } from './event-mapper'
import { TextNode } from './nodes/TextNode'
import { ToolCallNode } from './nodes/ToolCallNode'
import { ResultNode } from './nodes/ResultNode'

const NODE_TYPES: NodeTypes = {
  'text': TextNode as unknown as NodeTypes[string],
  'tool-call': ToolCallNode as unknown as NodeTypes[string],
  'result': ResultNode as unknown as NodeTypes[string],
}

const LANE_HEIGHT = 220
const LANE_LABELS: Array<{ key: 'user' | 'assistant' | 'work'; label: string; y: number }> = [
  { key: 'user', label: 'USER', y: LANE_Y.user },
  { key: 'assistant', label: 'ASSISTANT', y: LANE_Y.assistant },
  { key: 'work', label: 'WORK · TOOLS · RESULTS', y: LANE_Y.work },
]

export interface CanvasSessionProps {
  sessionId: string
}

export function CanvasSession({ sessionId }: CanvasSessionProps) {
  // sessionAtomFamily is typed as Atom<unknown> due to a known monorepo issue.
  const session = useAtomValue(sessionAtomFamily(sessionId)) as Session | null

  const graph = useMemo<CanvasGraph>(() => {
    if (!session?.messages) return { nodes: [], edges: [], turnBoundaries: [] }
    return messagesToGraph(session.messages)
  }, [session?.messages])

  const nodes = graph.nodes as unknown as Node[]
  const edges = graph.edges as unknown as Edge[]

  // fitView after custom nodes have measured. Without the delay, fitView fits
  // to 0×0 unmeasured nodes ("telescope zoom").
  const handleInit = useCallback((instance: ReactFlowInstance) => {
    setTimeout(() => {
      instance.fitView({ padding: 0.2, duration: 200, includeHiddenNodes: false })
    }, 80)
  }, [])

  if (!session) return <CanvasEmptyState message="No session selected." />
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
        minZoom={0.05}
        maxZoom={2}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={16} size={1} color="#e7e5e4" />
        <TurnBoundaryMarkers boundaries={graph.turnBoundaries} />
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
          style={{ width: 260, height: 140 }}
        />
      </ReactFlow>
      <LaneSidebar />
    </div>
  )
}

/**
 * Pinned lane labels at the left edge of the overlay. Stay in screen space
 * (do not pan with the canvas) — they label the lane Y bands.
 */
function LaneSidebar() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        width: 88,
        pointerEvents: 'none',
        zIndex: 5,
        display: 'flex',
        flexDirection: 'column',
        background:
          'linear-gradient(to right, rgba(250, 250, 249, 0.95), rgba(250, 250, 249, 0.0))',
      }}
    >
      {LANE_LABELS.map((lane, idx) => (
        <div
          key={lane.key}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            paddingLeft: 12,
            borderTop: idx > 0 ? '1px dashed #d6d3d1' : undefined,
          }}
        >
          <span
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.14em',
              color: '#78716c',
              writingMode: 'vertical-rl',
              transform: 'rotate(180deg)',
              textOrientation: 'mixed',
            }}
          >
            {lane.label}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Faint vertical guide line at each turn boundary — foundation for
 * points-of-interest markers. Rendered as plain divs in the React Flow
 * viewport; React Flow will pan/zoom them along with the nodes.
 *
 * NOTE: To pan with the canvas, these markers need to be in canvas space.
 * For v0.3 we render them as part of the Background layer using SVG-style
 * positioning. This is a deferred refinement — current placement is
 * approximate.
 */
function TurnBoundaryMarkers(_props: { boundaries: CanvasGraph['turnBoundaries'] }) {
  // Deliberately a no-op for v0.3. Turn boundaries are encoded in the data
  // (and surfaced via per-node turn coloring); rendering them as panning
  // canvas guides requires hooking into the React Flow viewport transform.
  // Adding that in v0.4 alongside scrubbing + POI markers.
  return null
}

void LANE_HEIGHT // intentional reservation for v0.4 lane-height tuning

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
