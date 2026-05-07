import * as React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { computeContextUsage, formatTokensCompact } from './context-usage'

interface ContextUsageIndicatorProps {
  /** Tokens used (input tokens for the next prompt). May be undefined before any usage event arrives. */
  used: number | null | undefined
  /** Model context window in tokens. May be undefined for compat providers. */
  limit: number | null | undefined
  /** Optional className applied to the wrapping element. */
  className?: string
}

/**
 * Persistent context-window usage indicator (PLAN-002).
 *
 * Renders `<used>K / <limit>K` plus a small horizontal progress bar that goes
 * green → yellow → burnt-orange as the session approaches the model's context
 * window. Designed to be mounted next to the model selector in the chat input
 * zone and update live as `usage_update` events arrive.
 *
 * Pure-logic helpers live in `./context-usage.ts` and are unit-tested directly.
 */
export function ContextUsageIndicator({ used, limit, className }: ContextUsageIndicatorProps) {
  const usage = computeContextUsage(used, limit)
  const hasUsage = (used ?? 0) > 0

  // Before any usage event arrives the indicator shows the limit but a "—" used
  // value so it's obviously waiting for data rather than reporting a real zero.
  const usedLabel = hasUsage ? formatTokensCompact(usage.used) : '—'
  const limitLabel = formatTokensCompact(usage.limit)

  const tooltipText = hasUsage
    ? `${usage.used.toLocaleString()} / ${usage.limit.toLocaleString()} tokens (${Math.round(usage.fraction * 100)}%)`
    : `Context window: ${usage.limit.toLocaleString()} tokens — usage will appear after the first response`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="status"
          aria-label={tooltipText}
          className={
            'inline-flex items-center h-7 px-1.5 gap-1.5 text-[12px] text-muted-foreground rounded-[6px] select-none ' +
            (className ?? '')
          }
          data-testid="context-usage-indicator"
        >
          <span className="tabular-nums whitespace-nowrap">
            {usedLabel} / {limitLabel}
          </span>
          <div
            className="relative h-1 w-[64px] rounded-full bg-foreground/10 overflow-hidden"
            aria-hidden="true"
          >
            <div
              className="absolute inset-y-0 left-0 transition-[width,background-color] duration-200"
              style={{
                width: `${usage.barFraction * 100}%`,
                backgroundColor: usage.color,
              }}
            />
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltipText}</TooltipContent>
    </Tooltip>
  )
}
