/**
 * PoiSidebar — collapsible right-edge panel listing all points of interest
 * in chronological order. Each item is clickable; click animates the React
 * Flow viewport to center + zoom on that POI.
 */

import React, { useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { POI } from './event-mapper'
import { LANE_Y, NODE_W, LANES_HEIGHT } from './event-mapper'

const COLLAPSED_W = 44
const EXPANDED_W = 280
const ZOOM_ON_CLICK = 0.85
const ANIM_MS = 450

export interface PoiSidebarProps {
  pois: POI[]
}

export function PoiSidebar({ pois }: PoiSidebarProps) {
  const [expanded, setExpanded] = useState(true)
  const flow = useReactFlow()

  function gotoPoi(poi: POI) {
    const targetX = poi.x + NODE_W / 2
    const targetY = (LANE_Y.user + LANE_Y.work + LANES_HEIGHT / 4) / 2
    flow.setCenter(targetX, targetY, { zoom: ZOOM_ON_CLICK, duration: ANIM_MS })
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 36, // below the timeline ruler
        right: 0,
        bottom: 0,
        width: expanded ? EXPANDED_W : COLLAPSED_W,
        background: 'rgba(255, 255, 255, 0.92)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        borderLeft: '1px solid #e7e5e4',
        zIndex: 5,
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 200ms ease',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-label={expanded ? 'Collapse points of interest' : 'Expand points of interest'}
        style={{
          height: 36,
          border: 'none',
          background: 'transparent',
          fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.14em',
          color: '#78716c',
          cursor: 'pointer',
          textAlign: expanded ? 'left' : 'center',
          paddingInline: expanded ? 12 : 0,
          borderBottom: '1px solid #e7e5e4',
        }}
      >
        {expanded ? `POI · ${pois.length}` : `${pois.length}`}
      </button>
      {expanded && (
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            paddingBlock: 4,
          }}
        >
          {pois.length === 0 ? (
            <div
              style={{
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontSize: 12,
                color: '#a8a29e',
                padding: 16,
                fontStyle: 'italic',
              }}
            >
              No points of interest yet.
            </div>
          ) : (
            pois.map((poi) => (
              <button
                key={poi.id}
                onClick={() => gotoPoi(poi)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  border: 'none',
                  borderTop: '1px solid #f5f5f4',
                  background: 'transparent',
                  padding: '8px 12px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f5f4')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span
                  style={{
                    width: 6,
                    height: 32,
                    background: poi.color,
                    borderRadius: 2,
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: '#1c1917',
                      display: 'flex',
                      gap: 6,
                      alignItems: 'center',
                    }}
                  >
                    {poi.type === 'error' && (
                      <span
                        style={{
                          fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
                          fontSize: 8,
                          fontWeight: 700,
                          letterSpacing: '0.1em',
                          color: '#dc2626',
                          background: '#fef2f2',
                          border: '1px solid #fecaca',
                          padding: '1px 4px',
                          borderRadius: 2,
                        }}
                      >
                        ERR
                      </span>
                    )}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {poi.label}
                    </span>
                  </div>
                  {poi.detail && (
                    <div
                      style={{
                        fontSize: 10,
                        color: '#78716c',
                        marginTop: 2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
                      }}
                    >
                      {poi.detail}
                    </div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
