/**
 * ForkBadge — visible indicator that this build is the Swagatar fork, not upstream stable.
 *
 * Renders only a 2px rust-orange accent stripe under the title-bar area. The window title is
 * now the bare product name ("Vorno"), so this stripe carries the fork distinction — enough
 * to tell apart at-a-glance from upstream stable without occluding the top-right window
 * controls (the earlier pill badge sat on top of the close button on some layouts).
 *
 * To suppress in dev only: set `VITE_HIDE_FORK_BADGE=1` (intentionally not shipped to prod).
 */

import React from 'react'

export const FORK_ACCENT = '#c2410c' // rust-orange (Tailwind orange-700)

export function ForkBadge() {
  if (import.meta.env.VITE_HIDE_FORK_BADGE === '1') return null

  return (
    <div
      aria-hidden
      title="Swagatar fork — running ahead of upstream stable"
      style={{
        position: 'fixed',
        top: 38,
        left: 0,
        right: 0,
        height: 2,
        background: FORK_ACCENT,
        opacity: 0.8,
        pointerEvents: 'none',
        // eslint-disable-next-line
        zIndex: 9998,
      }}
    />
  )
}
