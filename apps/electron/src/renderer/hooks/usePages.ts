/**
 * usePages
 *
 * Loads workspace-scoped pages into `pagesAtom` and keeps them in sync via the
 * `pages:changed` broadcast (pushed whenever any page.json changes — create,
 * update, delete, content save, or a refresh-script run completing).
 *
 * Unlike `useProjects`, the atom is the ONLY state: consumers read
 * `pagesAtom` (or this hook's passthrough) and there is no duplicate local
 * list to drift.
 */

import { useCallback, useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { pagesAtom } from '@/atoms/pages'
import type { LoadedPage } from '@craft-agent/shared/pages/types'

export interface UsePagesResult {
  pages: LoadedPage[]
  pagesEnabled: boolean
  /**
   * False until the host has actually answered. `pagesEnabled` starts false and
   * the capability lookup is async, so "not enabled" and "not asked yet" are
   * the same value — a consumer that renders a disabled state on the former
   * flashes it at every workspace where Pages IS enabled. Gate on this first.
   */
  pagesCapabilityResolved: boolean
  refresh: () => Promise<void>
}

export function usePages(activeWorkspaceId: string | null | undefined): UsePagesResult {
  const pages = useAtomValue(pagesAtom)
  const setPages = useSetAtom(pagesAtom)
  const [pagesEnabled, setPagesEnabled] = useState(false)
  const [pagesCapabilityResolved, setPagesCapabilityResolved] = useState(false)

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId) {
      setPagesEnabled(false)
      // No workspace is a settled answer, not a pending one.
      setPagesCapabilityResolved(true)
      setPages([])
      return
    }
    try {
      const capabilities = await window.electronAPI.getPageShareCapabilities(activeWorkspaceId)
      setPagesEnabled(capabilities.pagesEnabled)
      setPagesCapabilityResolved(true)
      if (!capabilities.pagesEnabled) {
        setPages([])
        return
      }
      const result = await window.electronAPI.getPages(activeWorkspaceId)
      setPages(Array.isArray(result) ? result : [])
    } catch (err) {
      console.error('[usePages] Failed to load Pages capability:', err)
      setPagesEnabled(false)
      // A failed lookup is resolved-and-unavailable: the host is the authority
      // and it did not say yes, so never fall back to showing the feature.
      setPagesCapabilityResolved(true)
      setPages([])
    }
  }, [activeWorkspaceId, setPages])

  useEffect(() => {
    refresh()
  }, [refresh])

  // The Settings toggle is persisted by the host; this event merely prompts
  // presentation consumers to re-read that authority immediately.
  useEffect(() => {
    const onFlagChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail
      if (detail?.workspaceId === activeWorkspaceId) void refresh()
    }
    window.addEventListener('pages:flag-changed', onFlagChanged)
    return () => window.removeEventListener('pages:flag-changed', onFlagChanged)
  }, [activeWorkspaceId, refresh])

  useEffect(() => {
    if (!activeWorkspaceId) return
    const off = window.electronAPI.onPagesChanged((_wsId, _list) => {
      // Root config changes use this same push so every client re-resolves the
      // persisted workspace capability. Never trust a stale renderer flag.
      void refresh()
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [activeWorkspaceId, setPages, refresh])

  return { pages, pagesEnabled, pagesCapabilityResolved, refresh }
}
