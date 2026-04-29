/**
 * ToolCallNode — renders a tool invocation: tool name, status badge,
 * and a collapsed JSON preview of the input.
 */

import React, { useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ToolCallNodeData } from '../types'

const NODE_W = 460

const STATUS_COLORS: Record<string, string> = {
  pending: '#a8a29e',
  executing: '#c2410c',
  completed: '#16a34a',
  error: '#dc2626',
  backgrounded: '#0284c7',
  cancelled: '#6b7280',
}

export function ToolCallNode(props: NodeProps) {
  const { toolName, toolDisplayName, input, status, turnColor } = props.data as unknown as ToolCallNodeData
  const [open, setOpen] = useState(false)

  const statusColor = STATUS_COLORS[status] ?? '#6b7280'
  const inputJson = input !== undefined ? JSON.stringify(input, null, 2) : null

  return (
    <div
      style={{
        width: NODE_W,
        background: '#ffffff',
        border: `2px solid ${statusColor}`,
        borderLeft: `6px solid ${turnColor ?? statusColor}`,
        borderRadius: 8,
        padding: '10px 14px',
        fontSize: 12,
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: statusColor }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span
          style={{
            fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.1em',
            color: statusColor,
            background: `${statusColor}1a`,
            padding: '2px 6px',
            borderRadius: 3,
          }}
        >
          {status.toUpperCase()}
        </span>
        <span
          style={{
            fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
            fontSize: 12,
            fontWeight: 600,
            color: '#1c1917',
          }}
        >
          {toolDisplayName ?? toolName}
        </span>
      </div>
      {inputJson !== null && (
        <div>
          <button
            onClick={() => setOpen(!open)}
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
              fontSize: 10,
              color: '#6b7280',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              marginTop: 4,
            }}
          >
            {open ? '▾ input' : '▸ input'}
          </button>
          {open && (
            <pre
              style={{
                fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
                fontSize: 10,
                background: '#f5f5f4',
                padding: 8,
                borderRadius: 4,
                marginTop: 4,
                overflow: 'auto',
                maxHeight: 200,
                color: '#44403c',
              }}
            >
              {inputJson.length > 2000 ? inputJson.slice(0, 2000) + '\n…' : inputJson}
            </pre>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ background: statusColor }} />
    </div>
  )
}
