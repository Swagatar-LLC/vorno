/**
 * ResultNode — renders a tool result. v0.1 shows truncated text only.
 *
 * v0.2 will route to the existing block renderers (html-preview, datatable,
 * pdf-preview, image-preview, mermaid) based on result content sniffing —
 * deferred from v0.1 to keep this PR small.
 */

import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ResultNodeData } from '../types'

const MAX_LEN = 1200

export function ResultNode(props: NodeProps) {
  const { toolName, result, isError } = props.data as unknown as ResultNodeData
  const truncated = result.length > MAX_LEN ? result.slice(0, MAX_LEN) + '\n…' : result

  const accent = isError ? '#dc2626' : '#16a34a'

  return (
    <div
      style={{
        background: isError ? '#fef2f2' : '#f0fdf4',
        border: `2px solid ${accent}`,
        borderRadius: 8,
        padding: '10px 14px',
        minWidth: 280,
        maxWidth: 540,
        fontSize: 12,
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: accent }} />
      <div
        style={{
          fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: accent,
          marginBottom: 6,
        }}
      >
        {isError ? 'ERROR' : 'RESULT'} · {toolName}
      </div>
      <pre
        style={{
          fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
          fontSize: 11,
          color: '#1c1917',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          margin: 0,
          maxHeight: 240,
          overflow: 'auto',
        }}
      >
        {truncated || <em style={{ color: '#a8a29e' }}>(empty)</em>}
      </pre>
      <Handle type="source" position={Position.Bottom} style={{ background: accent }} />
    </div>
  )
}
