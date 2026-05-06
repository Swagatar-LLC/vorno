/**
 * TurnMarkerNode — canvas-space dashed vertical guide at a turn boundary.
 *
 * Decorative only (non-selectable, non-draggable). Spans all three lanes
 * vertically. Pans/zooms with the canvas content because it's a
 * regular React Flow node.
 */

import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { LANES_HEIGHT } from '../event-mapper'

export interface TurnMarkerData {
  color: string
  label: string
}

export function TurnMarkerNode(props: NodeProps) {
  const { color, label } = props.data as unknown as TurnMarkerData

  return (
    <div
      style={{
        position: 'relative',
        width: 0,
        height: LANES_HEIGHT,
        pointerEvents: 'none',
      }}
    >
      {/* The vertical dashed line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 0,
          height: LANES_HEIGHT,
          borderLeft: `1px dashed ${color}`,
          opacity: 0.45,
        }}
      />
      {/* Floating label at top of guide */}
      <div
        style={{
          position: 'absolute',
          top: -22,
          left: -32,
          width: 64,
          textAlign: 'center',
          fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color,
          opacity: 0.85,
          whiteSpace: 'nowrap',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
    </div>
  )
}
