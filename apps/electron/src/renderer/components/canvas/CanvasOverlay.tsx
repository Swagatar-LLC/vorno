/**
 * CanvasOverlay — fullscreen overlay that hosts the CanvasSession.
 *
 * Toggled with Cmd/Ctrl+Shift+K. Esc closes. v0.1 spectator: read-only.
 *
 * Mounted globally from App.tsx. When closed, renders nothing — zero impact
 * on the rest of the app.
 */

import React, { useEffect } from 'react'
import { atom, useAtom, useAtomValue } from 'jotai'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { CanvasSession } from './CanvasSession'

const FORK_ACCENT = '#c2410c'

/** Global atom — true when the canvas overlay is visible. */
export const canvasOverlayOpenAtom = atom(false)

export function CanvasOverlay() {
  const [open, setOpen] = useAtom(canvasOverlayOpenAtom)
  const activeSessionId = useAtomValue(activeSessionIdAtom)

  // Global toggle: Cmd/Ctrl+Shift+K. Esc to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (open && e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="Canvas Session view"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        background: 'rgba(28, 25, 23, 0.85)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
          color: 'white',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: 'white',
              background: FORK_ACCENT,
              padding: '3px 8px',
              borderRadius: 3,
            }}
          >
            CANVAS · v0.1 SPECTATOR
          </span>
          <span style={{ fontSize: 13, color: '#d6d3d1' }}>
            Direction 1 — read-only projection of session events.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <kbd
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
              fontSize: 11,
              color: '#a8a29e',
              background: 'rgba(255,255,255,0.08)',
              padding: '3px 6px',
              borderRadius: 3,
              border: '1px solid rgba(255,255,255,0.15)',
            }}
          >
            Esc to close · ⌘⇧K to toggle
          </kbd>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close canvas"
            style={{
              fontFamily: 'system-ui, -apple-system, sans-serif',
              fontSize: 13,
              color: 'white',
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.3)',
              borderRadius: 4,
              padding: '4px 10px',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
      <div
        style={{
          flex: 1,
          background: '#fafaf9',
          borderRadius: 6,
          overflow: 'hidden',
          border: `2px solid ${FORK_ACCENT}`,
        }}
      >
        {activeSessionId ? (
          <CanvasSession sessionId={activeSessionId} />
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              color: '#78716c',
              fontSize: 14,
            }}
          >
            No active session. Open a session and press ⌘⇧K again.
          </div>
        )}
      </div>
    </div>
  )
}
