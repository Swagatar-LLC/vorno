import { describe, it, expect } from 'bun:test'
import { getSessionsToRefreshAfterReconnect } from '../reconnect-recovery'
import type { SessionMeta } from '@/atoms/sessions'

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: overrides.id ?? 'session',
    workspaceId: overrides.workspaceId ?? 'workspace',
    isProcessing: overrides.isProcessing ?? false,
    ...overrides,
  }
}

describe('getSessionsToRefreshAfterReconnect', () => {
  it('includes the active session and all processing sessions on a stale reconnect', () => {
    const metaMap = new Map<string, SessionMeta>([
      ['active', meta({ id: 'active' })],
      ['processing', meta({ id: 'processing', isProcessing: true })],
      ['other', meta({ id: 'other' })],
    ])

    expect(getSessionsToRefreshAfterReconnect(metaMap, 'active', true)).toEqual([
      'active',
      'processing',
    ])
  })

  it('deduplicates the active session when it is already processing (stale)', () => {
    const metaMap = new Map<string, SessionMeta>([
      ['active', meta({ id: 'active', isProcessing: true })],
    ])

    expect(getSessionsToRefreshAfterReconnect(metaMap, 'active', true)).toEqual(['active'])
  })

  it('re-hydrates only the displayed session on a non-stale recovery reconnect', () => {
    // A read-idle liveness probe reconnects and the server replays the event
    // stream (non-stale), but the displayed session must still re-hydrate to
    // catch a lost annotation echo. Processing sessions are NOT swept — that is
    // reserved for the stale verdict.
    const metaMap = new Map<string, SessionMeta>([
      ['active', meta({ id: 'active' })],
      ['processing', meta({ id: 'processing', isProcessing: true })],
      ['other', meta({ id: 'other' })],
    ])

    expect(getSessionsToRefreshAfterReconnect(metaMap, 'active', false)).toEqual(['active'])
  })

  it('refreshes nothing on a non-stale reconnect with no displayed session', () => {
    const metaMap = new Map<string, SessionMeta>([
      ['processing', meta({ id: 'processing', isProcessing: true })],
    ])

    expect(getSessionsToRefreshAfterReconnect(metaMap, null, false)).toEqual([])
  })
})
