/**
 * Main-process user activation for privileged Page actions (SUV-0065).
 *
 * These cover the properties the product claims out loud: no hover, no timer,
 * no passive input, one privileged action per click, and no renderer or
 * transport client able to assert activation it did not earn.
 */

import { describe, it, expect } from 'bun:test'
import { createRenderGenerationTracker } from '../page-grant-identity'
import {
  USER_GESTURE_MAX_AGE_MS,
  createUserGestureTracker,
  handlePageActivationIpc,
  type GestureTrackableWebContents,
} from '../page-activation'

/** A fake WebContents that lets a test deliver input and lifecycle events. */
function fakeContents(id: number) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const contents = {
    id,
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return contents
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return contents
    },
  } as unknown as GestureTrackableWebContents
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  return {
    contents,
    emit,
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
    click: () => emit('input-event', {}, { type: 'mouseDown' }),
  }
}

function setup(id = 7) {
  const generations = createRenderGenerationTracker()
  const gestures = createUserGestureTracker(generations)
  const win = fakeContents(id)
  gestures.observe(win.contents)
  return { generations, gestures, win }
}

describe('page activation — user gestures', () => {
  it('has nothing to spend before the user does anything', () => {
    const { gestures, win } = setup()
    // A page that acts on load, or from a timer, arrives here. There is no
    // gesture, so there is no ticket, so there is no action.
    expect(gestures.consume({ webContentsId: win.contents.id, renderGeneration: 1 })).toBe(false)
  })

  it('spends a real click exactly once', () => {
    const { gestures, win } = setup()
    win.click()
    const identity = { webContentsId: win.contents.id, renderGeneration: 1 }
    expect(gestures.consume(identity)).toBe(true)
    // One privileged action per click: the second attempt on the same gesture
    // finds nothing, so a page cannot fan one click into a burst of writes.
    expect(gestures.consume(identity)).toBe(false)
  })

  it('ignores passive input — hover, movement, wheel, and enter/leave', () => {
    const { gestures, win } = setup()
    for (const type of ['mouseMove', 'mouseEnter', 'mouseLeave', 'mouseWheel', 'mouseUp', 'gestureScrollBegin']) {
      win.emit('input-event', {}, { type })
    }
    expect(gestures.consume({ webContentsId: win.contents.id, renderGeneration: 1 })).toBe(false)

    // …and a keypress does count: keyboard users are users.
    win.emit('input-event', {}, { type: 'keyDown' })
    expect(gestures.consume({ webContentsId: win.contents.id, renderGeneration: 1 })).toBe(true)
  })

  it('lets a gesture go stale', () => {
    const { gestures, win } = setup()
    win.click()
    const identity = { webContentsId: win.contents.id, renderGeneration: 1 }
    // Banking a click and spending it much later is not "fresh interaction".
    expect(gestures.consume(identity, Date.now() + USER_GESTURE_MAX_AGE_MS + 1)).toBe(false)
  })

  it('does not hand a gesture to the document that replaced the one which made it', () => {
    const { generations, gestures, win } = setup()
    win.click()
    // A main-frame navigation replaces the document but keeps the webContents
    // id, so without generation binding the new document inherits the click.
    win.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })

    const replacement = { webContentsId: win.contents.id, renderGeneration: generations.current(win.contents.id)! }
    expect(replacement.renderGeneration).toBe(2)
    expect(gestures.consume(replacement)).toBe(false)
    // The retired generation cannot spend it either — it is no longer current.
    expect(gestures.consume({ webContentsId: win.contents.id, renderGeneration: 1 })).toBe(false)
  })

  it('keeps a gesture across a same-document navigation', () => {
    const { gestures, win } = setup()
    win.click()
    // A fragment or pushState navigation does not replace the document, so the
    // render that was clicked is still the one asking.
    win.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(gestures.consume({ webContentsId: win.contents.id, renderGeneration: 1 })).toBe(true)
  })

  it('spends a gesture even when the attempt fails', () => {
    const { gestures, win } = setup()
    win.click()
    // Wrong generation: refused, and the gesture is gone. Leaving it would let
    // a caller retry against one click until an attempt happened to line up.
    expect(gestures.consume({ webContentsId: win.contents.id, renderGeneration: 99 })).toBe(false)
    expect(gestures.consume({ webContentsId: win.contents.id, renderGeneration: 1 })).toBe(false)
  })

  it('observes a webContents once, however often it is offered', () => {
    const { gestures, win } = setup()
    gestures.observe(win.contents)
    gestures.observe(win.contents)
    // A second listener would record one physical click as several gestures.
    expect(win.listenerCount('input-event')).toBe(1)
  })

  it('forgets a destroyed window', () => {
    const { gestures, win } = setup()
    win.click()
    win.emit('destroyed')
    expect(gestures.consume({ webContentsId: win.contents.id, renderGeneration: 1 })).toBe(false)
  })
})

describe('page activation — IPC boundary', () => {
  function host(overrides: Partial<Parameters<typeof handlePageActivationIpc>[0]> = {}) {
    const generations = createRenderGenerationTracker()
    const gestures = createUserGestureTracker(generations)
    const calls: Array<{ workspaceId: string; pageSlug: string; request: unknown }> = []
    return {
      calls,
      gestures,
      host: {
        getWorkspaceForWindow: () => 'ws_real',
        tracker: generations,
        gestures,
        request: async (_requester: unknown, workspaceId: string, pageSlug: string, request: unknown) => {
          calls.push({ workspaceId, pageSlug, request })
          return { ticketId: 'ticket_1', expiresAt: 1 }
        },
        ...overrides,
      } as Parameters<typeof handlePageActivationIpc>[0],
    }
  }

  it('mints for a real gesture in a real workspace window', async () => {
    const { host: h, gestures, calls } = host()
    const win = fakeContents(4)
    gestures.observe(win.contents)
    win.click()

    const result = await handlePageActivationIpc(h, win.contents, 'dash', { requestId: 'r' })
    expect(result.ticketId).toBe('ticket_1')
    // The workspace comes from the host's own window map, never the payload: a
    // renderer that could name it could aim a ticket at a workspace its window
    // does not show.
    expect(calls[0]?.workspaceId).toBe('ws_real')
  })

  it('refuses a window the host does not recognize as a workspace window', async () => {
    const { host: h, gestures } = host({ getWorkspaceForWindow: () => null })
    const pane = fakeContents(9)
    gestures.observe(pane.contents)
    pane.click()
    // Browser panes, devtools, and anything else that can reach ipcMain stop here.
    await expect(handlePageActivationIpc(h, pane.contents, 'dash', {}))
      .rejects.toThrow('PAGE_ACTIVATION_TRUSTED_CONTEXT_REQUIRED')
  })

  it('refuses when no host entry point is registered', async () => {
    const { host: h, gestures } = host({ request: undefined })
    const win = fakeContents(4)
    gestures.observe(win.contents)
    win.click()
    // Headless is this case: no window, no minting, so every mutating Page
    // action is refused rather than silently allowed.
    await expect(handlePageActivationIpc(h, win.contents, 'dash', {}))
      .rejects.toThrow('PAGE_ACTIVATION_TRUSTED_CONTEXT_REQUIRED')
  })

  it('refuses without a gesture, and never reaches the server to find out why', async () => {
    const { host: h, gestures, calls } = host()
    const win = fakeContents(4)
    gestures.observe(win.contents)

    await expect(handlePageActivationIpc(h, win.contents, 'dash', {}))
      .rejects.toThrow('PAGE_ACTIVATION_USER_GESTURE_REQUIRED')
    // A caller with no gesture learns only that it needs one — not whether its
    // lease, grant, or page exist.
    expect(calls).toHaveLength(0)
  })

  it('rejects a non-string page slug', async () => {
    const { host: h, gestures } = host()
    const win = fakeContents(4)
    gestures.observe(win.contents)
    win.click()
    for (const hostile of [undefined, null, 42, { toString: () => 'dash' }, ['dash']]) {
      await expect(handlePageActivationIpc(h, win.contents, hostile, {}))
        .rejects.toThrow('PAGE_ACTIVATION_INVALID_REQUEST')
    }
  })

  it('will not mint twice for one click', async () => {
    const { host: h, gestures, calls } = host()
    const win = fakeContents(4)
    gestures.observe(win.contents)
    win.click()

    await handlePageActivationIpc(h, win.contents, 'dash', {})
    await expect(handlePageActivationIpc(h, win.contents, 'dash', {}))
      .rejects.toThrow('PAGE_ACTIVATION_USER_GESTURE_REQUIRED')
    expect(calls).toHaveLength(1)
  })
})
