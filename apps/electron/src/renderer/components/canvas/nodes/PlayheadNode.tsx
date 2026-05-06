/**
 * PlayheadNode — a draggable vertical scrub line that defines the "current
 * time" on the canvas. Nodes past the playhead are dimmed to indicate
 * future / not-yet-scrubbed content (the dimming is applied externally,
 * in CanvasSession, via per-node style.opacity).
 *
 * Y is clamped in CanvasSession's onNodesChange handler so the playhead
 * only moves horizontally.
 */

import React from 'react'
import { type NodeProps } from '@xyflow/react'
import { LANES_HEIGHT } from '../event-mapper'

const ACCENT = '#c2410c'

export function PlayheadNode(_props: NodeProps) {
  return (
    <div
      style={{
        position: 'relative',
        width: 2,
        height: LANES_HEIGHT,
        background: ACCENT,
        cursor: 'ew-resize',
        boxShadow: `0 0 6px ${ACCENT}`,
      }}
      title="Drag to scrub timeline"
    >
      {/* Triangular handle at top so the playhead is easy to grab */}
      <div
        style={{
          position: 'absolute',
          top: -10,
          left: -8,
          width: 0,
          height: 0,
          borderLeft: '9px solid transparent',
          borderRight: '9px solid transparent',
          borderTop: `12px solid ${ACCENT}`,
          filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))',
        }}
      />
      {/* Tick label "PLAY" */}
      <div
        style={{
          position: 'absolute',
          top: -32,
          left: -22,
          width: 44,
          textAlign: 'center',
          fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: '0.14em',
          color: ACCENT,
          textTransform: 'uppercase',
          pointerEvents: 'none',
        }}
      >
        Now
      </div>
    </div>
  )
}
