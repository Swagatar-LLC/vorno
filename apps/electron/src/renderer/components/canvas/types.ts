/**
 * Canvas Session — node data types.
 *
 * Each Message gets mapped to one custom React Flow node. The `kind` field
 * selects the node component; the rest is the data the node renders.
 *
 * Spec: see roadmap/plans/in-progress/PLAN-001-canvas-session-spectator-v0.md
 */

export type CanvasNodeKind = 'text' | 'tool-call' | 'result'

export interface TextNodeData {
  kind: 'text'
  /** 'user' | 'assistant' from upstream MessageRole */
  role: 'user' | 'assistant'
  text: string
  isStreaming?: boolean
  isError?: boolean
}

export interface ToolCallNodeData {
  kind: 'tool-call'
  toolName: string
  toolDisplayName?: string
  toolUseId: string
  /** JSON-serializable preview of tool input. */
  input?: unknown
  /** 'pending' | 'running' | 'completed' | 'error' | 'cancelled' (mirrors ToolStatus). */
  status: string
}

export interface ResultNodeData {
  kind: 'result'
  toolName: string
  toolUseId: string
  /** Raw result string from the tool. v0.1 renders as truncated text. */
  result: string
  isError?: boolean
}

export type CanvasNodeData = TextNodeData | ToolCallNodeData | ResultNodeData
