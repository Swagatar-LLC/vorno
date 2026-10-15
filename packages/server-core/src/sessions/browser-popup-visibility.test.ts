import { describe, expect, it } from 'bun:test'
import { isBrowserWindowVisibleToSession } from './browser-popup-visibility'

describe('isBrowserWindowVisibleToSession', () => {
  const popup = {
    parentInstanceId: 'browser-1',
    boundSessionId: 'sess-a',
    ownerSessionId: 'sess-a',
    workspaceId: 'ws-1',
  }

  it('shows a pop-up to the session that owns its opener', () => {
    expect(isBrowserWindowVisibleToSession(popup, 'sess-a', 'ws-1')).toBe(true)
    // Still the owner after turn-end unbinding.
    expect(isBrowserWindowVisibleToSession({ ...popup, boundSessionId: null }, 'sess-a', 'ws-1')).toBe(true)
  })

  it('hides a pop-up from every other session', () => {
    expect(isBrowserWindowVisibleToSession(popup, 'sess-b', 'ws-1')).toBe(false)
    expect(isBrowserWindowVisibleToSession({ ...popup, boundSessionId: null, ownerSessionId: null }, 'sess-b', 'ws-1')).toBe(false)
  })

  it('hides a pop-up from a same-id session in another workspace', () => {
    expect(isBrowserWindowVisibleToSession(popup, 'sess-a', 'ws-2')).toBe(false)
  })

  it('leaves top-level windows to the existing lock rules', () => {
    const topLevel = { parentInstanceId: null, boundSessionId: 'sess-a', ownerSessionId: 'sess-a', workspaceId: 'ws-1' }
    expect(isBrowserWindowVisibleToSession(topLevel, 'sess-b', 'ws-1')).toBe(true)
    expect(isBrowserWindowVisibleToSession({ ...topLevel, parentInstanceId: undefined }, 'sess-b', 'ws-2')).toBe(true)
  })
})
