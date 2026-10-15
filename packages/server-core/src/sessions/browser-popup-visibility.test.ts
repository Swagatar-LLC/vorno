import { describe, expect, it } from 'bun:test'
import { isBrowserWindowVisibleToSession, pickImplicitLifecycleTarget } from './browser-popup-visibility'

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

describe('pickImplicitLifecycleTarget', () => {
  const root = { id: 'browser-1', parentInstanceId: null, boundSessionId: 'sess-a', ownerSessionId: 'sess-a', workspaceId: 'ws-1', activePopupId: null as string | null }
  const popup = { id: 'browser-2', parentInstanceId: 'browser-1', boundSessionId: 'sess-a', ownerSessionId: 'sess-a', workspaceId: 'ws-1' }

  it('defaults to the session root window when nothing is selected', () => {
    expect(pickImplicitLifecycleTarget([popup, root], 'sess-a').target?.id).toBe('browser-1')
  })

  it('targets the selected pop-up of a bound root', () => {
    expect(pickImplicitLifecycleTarget([{ ...root, activePopupId: 'browser-2' }, popup], 'sess-a').target?.id).toBe('browser-2')
  })

  it('targets the selected pop-up of an owned-but-unbound root after turn end', () => {
    const windows = [{ ...root, boundSessionId: null, activePopupId: 'browser-2' }, { ...popup, boundSessionId: null }]
    expect(pickImplicitLifecycleTarget(windows, 'sess-a').target?.id).toBe('browser-2')
  })

  it('fails closed when the selected pop-up is missing or not visible to the session', () => {
    const missing = pickImplicitLifecycleTarget([{ ...root, activePopupId: 'browser-9' }], 'sess-a')
    expect(missing.target).toBeUndefined()
    expect(missing.reason).toContain('browser-9')
    // A foreign/top-level id that happens to match is not a pop-up selection.
    const foreign = { ...root, id: 'browser-3', boundSessionId: 'sess-b', ownerSessionId: 'sess-b' }
    expect(pickImplicitLifecycleTarget([{ ...root, activePopupId: 'browser-3' }, foreign], 'sess-a').target).toBeUndefined()
  })

  it('ignores other sessions\' windows and reports no target', () => {
    const other = { ...root, boundSessionId: 'sess-b', ownerSessionId: 'sess-b', activePopupId: 'browser-2' }
    expect(pickImplicitLifecycleTarget([other], 'sess-a')).toEqual({})
  })
})
