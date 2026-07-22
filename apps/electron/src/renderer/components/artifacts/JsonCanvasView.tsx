/**
 * JsonCanvasView — read-only projection of a JSON Canvas v1.0 document
 * (jsoncanvas.org; ADR-0016 built-in type `json-canvas`), PLAN-025 C1 Leg 3.
 *
 * Deliberate blandness over jank: parse via `parseJsonCanvas` (browser-safe
 * deep import — the artifacts barrel pulls in fs, so we import the canvas module
 * file directly), compute the bounding box, scale-to-fit with a single CSS
 * transform, and absolutely-position nodes over an SVG edge layer.
 *
 * // ponytail: static projection. No pan/zoom/drag/selection — interactivity is
 * // C2+. Edges are drawn center→center (spec side/endpoint anchoring deferred).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { parseJsonCanvas, type JsonCanvasNode } from '@craft-agent/shared/artifacts/canvas'
import { cn } from '@/lib/utils'

interface JsonCanvasViewProps {
  content: string
  className?: string
}

/** Padding (in canvas units) around the content bounding box. */
const BBOX_PADDING = 40

export function JsonCanvasView({ content, className }: JsonCanvasViewProps) {
  const { t } = useTranslation()
  const parsed = React.useMemo(() => parseJsonCanvas(content), [content])

  if ('error' in parsed) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        <p className="font-medium">{t('artifacts.canvasParseError')}</p>
        <p className="mt-1 text-xs text-destructive/80">{parsed.error}</p>
      </div>
    )
  }

  const { canvas } = parsed
  const nodes = canvas.nodes ?? []
  const edges = canvas.edges ?? []

  if (nodes.length === 0) {
    return (
      <div className="rounded-lg border border-border/40 p-6 text-center text-sm text-muted-foreground">
        {t('artifacts.canvasEmpty')}
      </div>
    )
  }

  // Bounding box over all nodes.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width)
    maxY = Math.max(maxY, n.y + n.height)
  }
  const bboxW = maxX - minX + BBOX_PADDING * 2
  const bboxH = maxY - minY + BBOX_PADDING * 2
  const originX = minX - BBOX_PADDING
  const originY = minY - BBOX_PADDING

  // Node center lookup (canvas coords, relative to origin) for edge drawing.
  const centerOf = (nodeId: string): { cx: number; cy: number } | null => {
    const n = nodes.find((m) => m.id === nodeId)
    if (!n) return null
    return { cx: n.x - originX + n.width / 2, cy: n.y - originY + n.height / 2 }
  }

  // Groups render behind everything else (labeled outline rectangles).
  const groupNodes = nodes.filter((n) => n.type === 'group')
  const contentNodes = nodes.filter((n) => n.type !== 'group')

  return (
    <div
      className={cn('relative w-full overflow-hidden rounded-lg border border-border/40 bg-foreground/[0.015]', className)}
      // Preserve the canvas aspect ratio in a scale-to-fit container.
      style={{ aspectRatio: `${bboxW} / ${bboxH}` }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: bboxW,
          height: bboxH,
          // Single transform: scale the whole canvas to the container width.
          transform: 'scale(var(--canvas-scale, 1))',
        }}
        ref={(el) => {
          if (!el || !el.parentElement) return
          const scale = el.parentElement.clientWidth / bboxW
          el.style.setProperty('--canvas-scale', String(scale))
        }}
      >
        {/* SVG edge layer (center → center). */}
        <svg width={bboxW} height={bboxH} className="absolute left-0 top-0 pointer-events-none">
          {edges.map((edge) => {
            const from = centerOf(edge.fromNode)
            const to = centerOf(edge.toNode)
            if (!from || !to) return null
            const midX = (from.cx + to.cx) / 2
            const midY = (from.cy + to.cy) / 2
            return (
              <g key={edge.id}>
                <line
                  x1={from.cx}
                  y1={from.cy}
                  x2={to.cx}
                  y2={to.cy}
                  className="stroke-foreground/30"
                  strokeWidth={2}
                />
                {edge.label && (
                  <text
                    x={midX}
                    y={midY}
                    className="fill-muted-foreground"
                    fontSize={12}
                    textAnchor="middle"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>

        {/* Group outlines (behind content nodes). */}
        {groupNodes.map((n) => (
          <CanvasNodeBox key={n.id} node={n} originX={originX} originY={originY} isGroup />
        ))}

        {/* Content nodes. */}
        {contentNodes.map((n) => (
          <CanvasNodeBox key={n.id} node={n} originX={originX} originY={originY} />
        ))}
      </div>
    </div>
  )
}

function CanvasNodeBox({
  node,
  originX,
  originY,
  isGroup,
}: {
  node: JsonCanvasNode
  originX: number
  originY: number
  isGroup?: boolean
}) {
  const style: React.CSSProperties = {
    position: 'absolute',
    left: node.x - originX,
    top: node.y - originY,
    width: node.width,
    height: node.height,
  }

  if (isGroup) {
    const label = typeof node.label === 'string' ? node.label : undefined
    return (
      <div
        style={style}
        className="rounded-lg border-2 border-dashed border-foreground/20 bg-foreground/[0.02]"
      >
        {label && (
          <span className="absolute -top-2 left-2 bg-background px-1 text-[11px] font-medium text-muted-foreground">
            {label}
          </span>
        )}
      </div>
    )
  }

  return (
    <div
      style={style}
      className="overflow-hidden rounded-md border border-border/60 bg-background p-2 text-[12px] shadow-sm"
    >
      <CanvasNodeContent node={node} />
    </div>
  )
}

function CanvasNodeContent({ node }: { node: JsonCanvasNode }) {
  // Plain-text projection is fine for C1 (blandness over jank).
  if (node.type === 'text' && typeof node.text === 'string') {
    return <div className="whitespace-pre-wrap break-words">{node.text}</div>
  }
  if (node.type === 'file' && typeof node.file === 'string') {
    return <div className="font-mono text-muted-foreground break-all">{node.file}</div>
  }
  if (node.type === 'link' && typeof node.url === 'string') {
    return <div className="text-muted-foreground break-all">{node.url}</div>
  }
  return null
}
