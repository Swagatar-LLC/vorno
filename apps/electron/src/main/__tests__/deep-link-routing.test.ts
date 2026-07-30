import { describe, expect, it } from 'bun:test'
import { handleDeepLink, parseDeepLink } from '../deep-link'
import { RPC_CHANNELS } from '../../shared/types'
import type { EventSink } from '@craft-agent/server-core/transport'
import type { WindowManager } from '../window-manager'

function createMockWindow(webContentsId: number) {
  return {
    isMinimized: () => false,
    restore: () => {},
    focus: () => {},
    isDestroyed: () => false,
    webContents: {
      id: webContentsId,
      isLoading: () => false,
      isDestroyed: () => false,
      once: () => {},
    },
  }
}

// fork(ADR-0020): vorno:// is an additive second scheme, byte-for-byte
// equivalent to frozen craftagents:// in route grammar.
describe('parseDeepLink dual schemes', () => {
  it.each(['craftagents', 'vorno'])('parses %s:// compound routes', (scheme) => {
    expect(parseDeepLink(`${scheme}://allSessions/session/abc123`)).toEqual({
      workspaceId: undefined,
      view: 'allSessions/session/abc123',
      windowMode: undefined,
      rightSidebar: undefined,
    })
  })

  it.each(['craftagents', 'vorno'])('parses %s:// action routes with params', (scheme) => {
    const target = parseDeepLink(`${scheme}://action/new-chat?input=hi&send=true`)
    expect(target?.action).toBe('new-chat')
    expect(target?.actionParams).toEqual({ input: 'hi', send: 'true' })
  })

  it('parses both schemes identically for workspace-targeted routes', () => {
    expect(parseDeepLink('vorno://workspace/ws123/allSessions/session/abc123'))
      .toEqual(parseDeepLink('craftagents://workspace/ws123/allSessions/session/abc123'))
  })

  it('rejects unknown schemes', () => {
    expect(parseDeepLink('craftdocs://allSessions')).toBeNull()
    expect(parseDeepLink('https://example.com/allSessions')).toBeNull()
  })
})

describe('handleDeepLink routing', () => {
  it('prefers resolved target client over preferred caller client', async () => {
    const targetWindow = createMockWindow(22)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: (webContentsId: number) => webContentsId === 22 ? 'ws-target' : 'ws-other',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'craftagents://workspace/ws-target/allSessions',
      windowManager,
      sink,
      (wcId) => wcId === 22 ? 'client-target' : undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.channel).toBe(RPC_CHANNELS.deeplink.NAVIGATE)
    expect(sent[0]?.target).toEqual({ to: 'client', clientId: 'client-target' })
  })

  it('routes vorno:// links identically to craftagents:// (ADR-0020)', async () => {
    const targetWindow = createMockWindow(22)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: (webContentsId: number) => webContentsId === 22 ? 'ws-target' : 'ws-other',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'vorno://workspace/ws-target/allSessions',
      windowManager,
      sink,
      (wcId) => wcId === 22 ? 'client-target' : undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.channel).toBe(RPC_CHANNELS.deeplink.NAVIGATE)
    expect(sent[0]?.target).toEqual({ to: 'client', clientId: 'client-target' })
  })

  it('uses preferred client only when no resolver is provided', async () => {
    const targetWindow = createMockWindow(31)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: () => 'ws-target',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'craftagents://workspace/ws-target/allSessions',
      windowManager,
      sink,
      undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.target).toEqual({ to: 'client', clientId: 'client-caller' })
  })

  it('falls back to workspace routing when resolver exists but target client is unresolved', async () => {
    const targetWindow = createMockWindow(44)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: () => 'ws-target',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'craftagents://workspace/ws-target/allSessions',
      windowManager,
      sink,
      () => undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.target).toEqual({ to: 'workspace', workspaceId: 'ws-target' })
  })
})
