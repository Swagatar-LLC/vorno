/**
 * ForkBadge — visible indicator that this build is the Swagatar fork, not upstream stable.
 *
 * Rendered top-right, above app shell, as a small pinned pill in rust-orange.
 * The user runs upstream stable side-by-side; this badge prevents confusion.
 *
 * To suppress in dev only: set `VITE_HIDE_FORK_BADGE=1` (intentionally not shipped to prod).
 */

import React from 'react'

export const FORK_LABEL = 'SWAGATAR FORK'
export const FORK_ACCENT = '#c2410c' // rust-orange (Tailwind orange-700)

export function ForkBadge() {
  if (import.meta.env.VITE_HIDE_FORK_BADGE === '1') return null

  return (
    <>
      {/* Top accent stripe — 2px rust line directly under the title bar.
          Positioned below the macOS traffic-light area to avoid clashing. */}
      <div
        aria-hidden
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
      {/* Pill badge — top-right corner, above all app content. */}
      <div
        role="status"
        aria-label="This build is the Swagatar fork of Craft Agents"
        title="Swagatar fork — running ahead of upstream stable"
        style={{
          position: 'fixed',
          top: 10,
          right: 14,
          // eslint-disable-next-line
          zIndex: 9999,
          padding: '3px 9px',
          fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: 'white',
          background: FORK_ACCENT,
          borderRadius: 4,
          // eslint-disable-next-line
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.18)',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        {FORK_LABEL}
      </div>
    </>
  )
}
