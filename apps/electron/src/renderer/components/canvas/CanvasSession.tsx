/**
 * CanvasSession — Direction 1, v0.4 (timeline + POIs + scrub).
 *
 * Horizontal timeline. Time flows left → right; lanes stack top → bottom
 * (USER / ASSISTANT / WORK). Layered affordances:
 *
 *   - Turn-boundary guides (canvas-space dashed verticals at each turn).
 *   - Timeline ruler at the top with clickable POI ticks. Click animates
 *     the viewport to center + zoom on the POI (React Flow's setCenter
 *     with `duration` does the easing).
 *   - POI sidebar at the right, collapsible. Each entry click → animated
 *     center + zoom.
 *   - Playhead — a draggable vertical scrub line. Nodes past the playhead
 *     dim to indicate "future" content. Y is clamped so it only moves
 *     horizontally.
 *
 * Wrapped in <ReactFlowProvider> so siblings (TimelineRuler, PoiSidebar)
 * can call useReactFlow() to drive the viewport.
 */

import React, { useCallback, useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { Session } from '../../../shared/types'
import { sessionAtomFamily } from '@/atoms/sessions'
import { messagesToGraph, LANE_Y, LANES_HEIGHT, NODE_W } from './event-mapper'
import type { CanvasGraph } from './event-mapper'
import { TextNode } from './nodes/TextNode'
import { ToolCallNode } from './nodes/ToolCallNode'
import { ResultNode } from './nodes/ResultNode'
import { TurnMarkerNode } from './nodes/TurnMarkerNode'
import { PlayheadNode } from './nodes/PlayheadNode'
import { TimelineRuler } from './TimelineRuler'
import { PoiSidebar } from './PoiSidebar'

const NODE_TYPES: NodeTypes = {
  'text': TextNode as unknown as NodeTypes[string],
  'tool-call': ToolCallNode as unknown as NodeTypes[string],
  'result': ResultNode as unknown as NodeTypes[string],
  'turn-marker': TurnMarkerNode as unknown as NodeTypes[string],
  'playhead': PlayheadNode as unknown as NodeTypes[string],
}

const PLAYHEAD_NODE_ID = '__playhead__'
/** Y where the playhead sits visually — slightly above the first lane. */
const PLAYHEAD_Y = -30

const LANE_LABELS: Array<{ key: 'user' | 'assistant' | 'work'; label: string }> = [
  { key: 'user', label: 'USER' },
  { key: 'assistant', label: 'ASSISTANT' },
  { key: 'work', label: 'WORK · TOOLS · RESULTS' },
]

export interface CanvasSessionProps {
  sessionId: string
}

export function CanvasSession(props: CanvasSessionProps) {
  return (
    <ReactFlowProvider>
      <CanvasSessionInner {...props} />
    </ReactFlowProvider>
  )
}

function CanvasSessionInner({ sessionId }: CanvasSessionProps) {
  const session = useAtomValue(sessionAtomFamily(sessionId)) as Session | null

  const graph = useMemo<CanvasGraph>(() => {
    if (!session?.messages) return { nodes: [], edges: [], pois: [], span: { minX: 0, maxX: 0 } }
    return messagesToGraph(session.messages)
  }, [session?.messages])

  // Playhead state — null means no scrubbing (everything bright). Set on
  // first user drag of the playhead.
  const [playheadX, setPlayheadX] = useState<number | null>(null)

  // Build the React Flow node list: message nodes + decoration nodes.
  const nodes: Node[] = useMemo(() => {
    const messageNodes: Node[] = graph.nodes.map((n) => {
      const dimmed = playheadX !== null && n.position.x > playheadX
      return {
        ...(n as unknown as Node),
        style: dimmed ? { opacity: 0.32, filter: 'saturate(0.4)' } : undefined,
        selectable: true,
        draggable: true,
      }
    })
    const turnMarkers: Node[] = graph.pois
      .filter((p) => p.type === 'turn-start')
      .map((p) => ({
        id: `marker:${p.id}`,
        type: 'turn-marker',
        position: { x: p.x - 4, y: -36 },
        data: { color: p.color, label: p.label },
        selectable: false,
        draggable: false,
        focusable: false,
        zIndex: -1,
      }))
    // Default playhead position: at the start of the timeline if user
    // hasn't scrubbed yet.
    const playheadPos = playheadX ?? graph.span.minX - 12
    const playhead: Node = {
      id: PLAYHEAD_NODE_ID,
      type: 'playhead',
      position: { x: playheadPos, y: PLAYHEAD_Y },
      data: {},
      selectable: false,
      draggable: true,
      zIndex: 1000,
    }
    return [...turnMarkers, ...messageNodes, playhead]
  }, [graph, playheadX])

  const edges = graph.edges as unknown as Edge[]

  // fitView after custom nodes have measured.
  const handleInit = useCallback(
    (instance: ReactFlowInstance) => {
      setTimeout(() => {
        // Limit fit to message nodes so guides/playhead don't expand the box.
        const messageNodeIds = graph.nodes.map((n) => ({ id: n.id }))
        if (messageNodeIds.length > 0) {
          instance.fitView({
            nodes: messageNodeIds,
            padding: 0.2,
            duration: 200,
            includeHiddenNodes: false,
          })
        }
      }, 80)
    },
    [graph.nodes],
  )

  // Custom onNodesChange: clamp playhead Y, track playhead X.
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const c of changes) {
        if (c.type === 'position' && c.id === PLAYHEAD_NODE_ID) {
          if (c.position) c.position.y = PLAYHEAD_Y
          if (c.dragging === false && c.position) {
            setPlayheadX(c.position.x)
          } else if (c.dragging && c.position) {
            // Live update so dimming follows the drag.
            setPlayheadX(c.position.x)
          }
        }
      }
      // We don't actually mutate the nodes array — it's recomputed via useMemo
      // — but applyNodeChanges is harmless and keeps drag interaction smooth.
      void applyNodeChanges
    },
    [],
  )

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
        onNodesChange={handleNodesChange}
        minZoom={0.05}
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
            if (n.type === 'turn-marker' || n.type === 'playhead') return 'transparent'
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
          style={{ width: 240, height: 130 }}
        />
      </ReactFlow>
      <LaneSidebar />
      <TimelineRuler pois={graph.pois} span={graph.span} />
      <PoiSidebar pois={graph.pois} />
    </div>
  )
}

void LANES_HEIGHT
void NODE_W

/**
 * Pinned lane labels at the left edge. Stay in screen space.
 */
function LaneSidebar() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 36, // below the timeline ruler
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

void LANE_Y // re-export shimmed import — keeps reference for external consumers

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
