/**
 * TextNode — renders a user or assistant message as a card on the canvas.
 *
 * v0.2: lane-positioned, turn-colored. Plain text only — markdown / embedded
 * blocks land in v0.3 (re-using the existing chat block renderers).
 */

import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { TextNodeData } from '../types'

const NODE_W = 460
const MAX_LEN = 480

const FORK_ACCENT = '#c2410c'

export function TextNode(props: NodeProps) {
  const { role, text, isStreaming, isError, turnColor } = props.data as unknown as TextNodeData
  const truncated = text.length > MAX_LEN ? text.slice(0, MAX_LEN) + '…' : text

  const palette = role === 'user'
    ? { bg: '#eef2ff', border: '#6366f1', label: 'USER' }
    : { bg: '#fafaf9', border: '#a8a29e', label: 'ASSISTANT' }

  if (isError) {
    palette.bg = '#fef2f2'
    palette.border = '#dc2626'
  }

  return (
    <div
      style={{
        width: NODE_W,
        background: palette.bg,
        border: `2px solid ${isStreaming ? FORK_ACCENT : palette.border}`,
        borderLeft: `6px solid ${turnColor ?? palette.border}`,
        borderRadius: 8,
        padding: '10px 14px',
        fontSize: 13,
        lineHeight: 1.5,
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: palette.border }} />
      <div
        style={{
          fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: palette.border,
          marginBottom: 6,
        }}
      >
        {palette.label}{isStreaming ? ' · STREAMING' : ''}
      </div>
      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#1c1917' }}>
        {truncated || <em style={{ color: '#a8a29e' }}>(empty)</em>}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: palette.border }} />
    </div>
  )
}
