/**
 * TimelineRuler — a horizontal strip pinned to the top of the canvas
 * overlay (in screen space, not canvas space). Renders one tick per POI.
 *
 * Clicking a tick animates the React Flow viewport to center on that POI's
 * X coordinate and zoom in. Uses `useReactFlow().setCenter(x, y, { zoom,
 * duration })` — duration triggers the library's built-in animation.
 */

import React from 'react'
import { useReactFlow } from '@xyflow/react'
import type { POI } from './event-mapper'
import { LANE_Y, NODE_W, LANES_HEIGHT } from './event-mapper'

const RULER_HEIGHT = 36
const ZOOM_ON_CLICK = 0.85
const ANIM_MS = 450

export interface TimelineRulerProps {
  pois: POI[]
  span: { minX: number; maxX: number }
}

export function TimelineRuler({ pois, span }: TimelineRulerProps) {
  const flow = useReactFlow()

  const range = Math.max(1, span.maxX - span.minX + NODE_W)

  function gotoPoi(poi: POI) {
    // Center on the POI's X and the vertical mid-point of all lanes.
    const targetX = poi.x + NODE_W / 2
    const targetY = (LANE_Y.user + LANE_Y.work + LANES_HEIGHT / 4) / 2
    flow.setCenter(targetX, targetY, { zoom: ZOOM_ON_CLICK, duration: ANIM_MS })
  }

  if (pois.length === 0) return null

  return (
    <div
      role="toolbar"
      aria-label="Timeline points of interest"
      style={{
        position: 'absolute',
        top: 0,
        left: 88, // sit right of the lane sidebar
        right: 0,
        height: RULER_HEIGHT,
        background: 'rgba(255, 255, 255, 0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        borderBottom: '1px solid #e7e5e4',
        zIndex: 6,
        display: 'flex',
        alignItems: 'center',
        paddingInline: 12,
        gap: 0,
      }}
    >
      <span
        style={{
          fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.14em',
          color: '#78716c',
          marginRight: 12,
          flexShrink: 0,
        }}
      >
        TIMELINE
      </span>
      <div style={{ position: 'relative', flex: 1, height: '100%' }}>
        {/* baseline rule */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            height: 1,
            background: '#d6d3d1',
            transform: 'translateY(-0.5px)',
          }}
        />
        {pois.map((poi) => {
          const pct = ((poi.x - span.minX) / range) * 100
          return (
            <button
              key={poi.id}
              onClick={() => gotoPoi(poi)}
              title={`${poi.label}${poi.detail ? ` — ${poi.detail}` : ''}`}
              style={{
                position: 'absolute',
                top: '50%',
                left: `${pct}%`,
                transform: 'translate(-50%, -50%)',
                width: poi.type === 'error' ? 10 : 8,
                height: poi.type === 'error' ? 18 : 14,
                background: poi.color,
                border: 'none',
                borderRadius: 2,
                cursor: 'pointer',
                padding: 0,
                opacity: poi.type === 'error' ? 0.95 : 0.85,
                outline: 'none',
              }}
              aria-label={`Jump to ${poi.label}`}
            />
          )
        })}
      </div>
    </div>
  )
}

export const TIMELINE_RULER_HEIGHT = RULER_HEIGHT
