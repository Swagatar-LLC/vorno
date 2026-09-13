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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { pagesAtom } from '@/atoms/pages'
import type { LoadedPage } from '@craft-agent/shared/pages/types'

export interface UsePagesResult {
  pages: LoadedPage[]
  pagesEnabled: boolean
  /**
   * False until the host has answered **for the workspace being rendered**.
   * `pagesEnabled` starts false and the capability lookup is async, so "not
   * enabled" and "not asked yet" are the same value — a consumer that renders a
   * disabled state on the former flashes it at every workspace where Pages IS
   * enabled. It goes false again on a workspace switch, because the previous
   * workspace's answer says nothing about the new one. Gate on this first.
   */
  pagesCapabilityResolved: boolean
  refresh: () => Promise<void>
}

export function usePages(activeWorkspaceId: string | null | undefined): UsePagesResult {
  const pages = useAtomValue(pagesAtom)
  const setPages = useSetAtom(pagesAtom)
  const [pagesEnabled, setPagesEnabled] = useState(false)
  // WHICH workspace the held answer is for, not merely whether one was ever
  // received. A plain boolean stays true across a workspace switch, so the
  // stale answer would be shown as settled for the new workspace — the exact
  // flash this state exists to prevent, just moved. `undefined` = nothing yet;
  // `null` = "no workspace", which is itself a settled answer.
  const [capabilityResolvedFor, setCapabilityResolvedFor] = useState<string | null | undefined>(undefined)
  // Monotonic request id: a workspace switch (or a `pages:changed` push racing
  // one) leaves two lookups in flight, and the slower one must not win.
  const requestSeq = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current
    const requestedFor = activeWorkspaceId ?? null
    const isCurrent = () => requestSeq.current === seq

    if (!requestedFor) {
      setPagesEnabled(false)
      setCapabilityResolvedFor(requestedFor)
      setPages([])
      return
    }
    try {
      const capabilities = await window.electronAPI.getPageShareCapabilities(requestedFor)
      if (!isCurrent()) return
      setPagesEnabled(capabilities.pagesEnabled)
      setCapabilityResolvedFor(requestedFor)
      if (!capabilities.pagesEnabled) {
        setPages([])
        return
      }
      const result = await window.electronAPI.getPages(requestedFor)
      if (!isCurrent()) return
      setPages(Array.isArray(result) ? result : [])
    } catch (err) {
      if (!isCurrent()) return
      console.error('[usePages] Failed to load Pages capability:', err)
      setPagesEnabled(false)
      // A failed lookup is resolved-and-unavailable: the host is the authority
      // and it did not say yes, so never fall back to showing the feature.
      setCapabilityResolvedFor(requestedFor)
      setPages([])
    }
  }, [activeWorkspaceId, setPages])

  // Settled only when the held answer belongs to the workspace being rendered.
  const pagesCapabilityResolved = capabilityResolvedFor === (activeWorkspaceId ?? null)

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
