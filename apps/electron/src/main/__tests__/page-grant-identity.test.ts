import { describe, expect, test } from 'bun:test'
import {
  createRenderGenerationTracker,
  handlePageGrantIpc,
  type RenderIdentity,
  type TrackableWebContents,
} from '../page-grant-identity'

type NavDetails = { isMainFrame: boolean; isSameDocument: boolean }

/** A WebContents stand-in that lets a test fire the lifecycle events Electron does. */
function fakeWebContents(id: number) {
  const navigation: Array<(...args: unknown[]) => void> = []
  const processGone: Array<() => void> = []
  const destroyed: Array<() => void> = []
  const contents: TrackableWebContents = {
    id,
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'did-start-navigation') navigation.push(listener)
      if (event === 'render-process-gone') processGone.push(listener)
      return contents
    },
    once(event: string, listener: () => void) {
      if (event === 'destroyed') destroyed.push(listener)
      return contents
    },
  } as TrackableWebContents
  return {
    contents,
    /**
     * Electron 39's real shape: `Event<Params>` is
     * `{ preventDefault, defaultPrevented } & Params`, so the flags are on the
     * first argument and the positional ones trail it as deprecated.
     */
    navigate: (details: NavDetails) => navigation.forEach(fn => fn(
      { preventDefault() {}, defaultPrevented: false, url: 'app://x', ...details },
      'app://x', details.isSameDocument, details.isMainFrame, 1, 2,
    )),
    /** The pre-39 shape, where only the positional arguments carried the flags. */
    navigateLegacy: (details: NavDetails) => navigation.forEach(fn => fn(
      { preventDefault() {}, defaultPrevented: false },
      'app://x', details.isSameDocument, details.isMainFrame, 1, 2,
    )),
    /** A shape this code does not recognize at all. */
    navigateUnknown: () => navigation.forEach(fn => fn({ preventDefault() {}, defaultPrevented: false })),
    crash: () => processGone.forEach(fn => fn()),
    destroy: () => destroyed.forEach(fn => fn()),
    listenerCounts: () => ({ navigation: navigation.length, processGone: processGone.length, destroyed: destroyed.length }),
  }
}

const DOCUMENT_REPLACED: NavDetails = { isMainFrame: true, isSameDocument: false }

describe('render generation tracking', () => {
  test('a tracked render starts current and stays current until something replaces it', () => {
    const tracker = createRenderGenerationTracker()
    const win = fakeWebContents(101)

    const generation = tracker.track(win.contents)
    expect(tracker.isCurrent({ webContentsId: 101, renderGeneration: generation })).toBe(true)
    // Same-document navigation does not replace the document, so consent the
    // live render opened must survive a Page updating its own URL.
    win.navigate({ isMainFrame: true, isSameDocument: true })
    win.navigate({ isMainFrame: false, isSameDocument: false })
    expect(tracker.current(101)).toBe(generation)
    expect(tracker.isCurrent({ webContentsId: 101, renderGeneration: generation })).toBe(true)
  })

  test('tracking is idempotent — a second request does not reset or re-subscribe', () => {
    const tracker = createRenderGenerationTracker()
    const win = fakeWebContents(101)

    const first = tracker.track(win.contents)
    win.navigate(DOCUMENT_REPLACED)
    const afterReload = first + 1
    expect(tracker.current(101)).toBe(afterReload)

    expect(tracker.track(win.contents)).toBe(afterReload)
    expect(win.listenerCounts()).toEqual({ navigation: 1, processGone: 1, destroyed: 1 })
    // A double subscription would retire two generations for one reload.
    win.navigate(DOCUMENT_REPLACED)
    expect(tracker.current(101)).toBe(afterReload + 1)
  })

  test('a replaced document retires its predecessor and announces exactly that identity', () => {
    const retired: RenderIdentity[] = []
    const tracker = createRenderGenerationTracker(r => retired.push(r))
    const win = fakeWebContents(101)
    const first = tracker.track(win.contents)

    win.navigate(DOCUMENT_REPLACED)

    // The retirement names the OLD generation: the handler aborts the prompt
    // that render opened, never its successor's.
    expect(retired).toEqual([{ webContentsId: 101, renderGeneration: first }])
    expect(tracker.isCurrent({ webContentsId: 101, renderGeneration: first })).toBe(false)
    expect(tracker.isCurrent({ webContentsId: 101, renderGeneration: first + 1 })).toBe(true)
  })

  test('a lost renderer process retires its generation the same way a reload does', () => {
    const retired: RenderIdentity[] = []
    const tracker = createRenderGenerationTracker(r => retired.push(r))
    const win = fakeWebContents(101)
    const first = tracker.track(win.contents)

    win.crash()

    expect(retired).toEqual([{ webContentsId: 101, renderGeneration: first }])
    expect(tracker.isCurrent({ webContentsId: 101, renderGeneration: first })).toBe(false)
  })

  test('a destroyed window retires, then reads as absent rather than as a match', () => {
    const retired: RenderIdentity[] = []
    const tracker = createRenderGenerationTracker(r => retired.push(r))
    const win = fakeWebContents(101)
    const first = tracker.track(win.contents)

    win.destroy()

    expect(retired).toEqual([{ webContentsId: 101, renderGeneration: first }])
    expect(tracker.current(101)).toBeUndefined()
    // Fail closed: absent is not current, and is not equal to any generation.
    expect(tracker.isCurrent({ webContentsId: 101, renderGeneration: first })).toBe(false)
    expect(tracker.isCurrent({ webContentsId: 101, renderGeneration: 0 })).toBe(false)
  })

  test('events after destruction neither resurrect a generation nor re-announce a retirement', () => {
    const retired: RenderIdentity[] = []
    const tracker = createRenderGenerationTracker(r => retired.push(r))
    const win = fakeWebContents(101)
    tracker.track(win.contents)
    win.destroy()

    win.navigate(DOCUMENT_REPLACED)
    win.crash()
    win.destroy()

    expect(retired).toHaveLength(1)
    expect(tracker.current(101)).toBeUndefined()
  })

  test('retires on a document replacement in either Electron argument shape', () => {
    for (const shape of ['navigate', 'navigateLegacy'] as const) {
      const retired: RenderIdentity[] = []
      const tracker = createRenderGenerationTracker(r => retired.push(r))
      const win = fakeWebContents(101)
      tracker.track(win.contents)

      win[shape]({ isMainFrame: true, isSameDocument: true })
      win[shape]({ isMainFrame: false, isSameDocument: false })
      expect(retired).toEqual([])

      win[shape](DOCUMENT_REPLACED)
      expect(retired).toEqual([{ webContentsId: 101, renderGeneration: 1 }])
    }
  })

  test('an unreadable navigation shape retires rather than silently keeping consent alive', () => {
    const retired: RenderIdentity[] = []
    const tracker = createRenderGenerationTracker(r => retired.push(r))
    const win = fakeWebContents(101)
    tracker.track(win.contents)

    win.navigateUnknown()

    // The asymmetry is deliberate. A needless retirement cancels in-flight
    // consent and the user is asked again; a missed one hands the previous
    // document's approval to whatever replaced it.
    expect(retired).toEqual([{ webContentsId: 101, renderGeneration: 1 }])
    expect(tracker.isCurrent({ webContentsId: 101, renderGeneration: 1 })).toBe(false)
  })

  test('an untracked window is never current', () => {
    const tracker = createRenderGenerationTracker()
    expect(tracker.current(999)).toBeUndefined()
    expect(tracker.isCurrent({ webContentsId: 999, renderGeneration: 1 })).toBe(false)
  })

  test('windows are tracked independently — one reload does not disturb another', () => {
    const retired: RenderIdentity[] = []
    const tracker = createRenderGenerationTracker(r => retired.push(r))
    const first = fakeWebContents(101)
    const second = fakeWebContents(202)
    tracker.track(first.contents)
    const secondGeneration = tracker.track(second.contents)

    first.navigate(DOCUMENT_REPLACED)

    expect(retired).toEqual([{ webContentsId: 101, renderGeneration: 1 }])
    expect(tracker.isCurrent({ webContentsId: 202, renderGeneration: secondGeneration })).toBe(true)
  })
})

describe('page grant IPC sender derivation', () => {
  type Call = { requester: RenderIdentity; workspaceId: string; pageSlug: string; input: unknown; leaseId: unknown }

  function ipcHost(options: {
    windows?: Record<number, string | null>
    tracker?: ReturnType<typeof createRenderGenerationTracker>
    withRequest?: boolean
  } = {}) {
    const calls: Call[] = []
    const windows = options.windows ?? { 101: 'ws_a' }
    const tracker = options.tracker ?? createRenderGenerationTracker()
    const host = {
      getWorkspaceForWindow: (wcId: number) => windows[wcId] ?? null,
      tracker,
      request: options.withRequest === false ? undefined : async (
        requester: RenderIdentity, workspaceId: string, pageSlug: string, input: unknown, leaseId: unknown,
      ) => {
        calls.push({ requester, workspaceId, pageSlug, input, leaseId })
        return { id: 'grant_1' }
      },
    }
    return { host, calls, tracker }
  }

  test('derives workspace and render identity from the sender, ignoring anything the caller sends', async () => {
    const { host, calls } = ipcHost()
    const win = fakeWebContents(101)

    // The renderer supplies only slug/input/leaseId. There is no parameter it
    // could use to name a window or a workspace.
    const result = await handlePageGrantIpc(host, win.contents, 'dash', { action: 'x' }, 'lease-1')

    expect(result).toEqual({ id: 'grant_1' })
    expect(calls).toEqual([{
      requester: { webContentsId: 101, renderGeneration: 1 },
      workspaceId: 'ws_a',
      pageSlug: 'dash',
      input: { action: 'x' },
      leaseId: 'lease-1',
    }])
  })

  test('refuses a sender that is not a workspace window', async () => {
    // A browser pane or devtools can reach ipcMain but maps to no workspace.
    const { host, calls } = ipcHost({ windows: { 101: 'ws_a' } })
    const pane = fakeWebContents(777)

    await expect(handlePageGrantIpc(host, pane.contents, 'dash', {}, 'lease-1'))
      .rejects.toThrow('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')
    expect(calls).toEqual([])
  })

  test('refuses when no host grant entry point is registered', async () => {
    const { host, calls } = ipcHost({ withRequest: false })
    const win = fakeWebContents(101)

    await expect(handlePageGrantIpc(host, win.contents, 'dash', {}, 'lease-1'))
      .rejects.toThrow('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')
    expect(calls).toEqual([])
  })

  test('rejects a non-string page slug before reaching the grant path', async () => {
    const { host, calls } = ipcHost()
    const win = fakeWebContents(101)

    for (const hostile of [42, null, undefined, { toString: () => 'dash' }, ['dash']]) {
      await expect(handlePageGrantIpc(host, win.contents, hostile, {}, 'lease-1'))
        .rejects.toThrow('PAGE_GRANT_INVALID_REQUEST')
    }
    expect(calls).toEqual([])
  })

  test('carries the current generation, so a request after a reload is not the old render', async () => {
    const { host, calls } = ipcHost()
    const win = fakeWebContents(101)

    await handlePageGrantIpc(host, win.contents, 'dash', {}, 'lease-1')
    win.navigate(DOCUMENT_REPLACED)
    await handlePageGrantIpc(host, win.contents, 'dash', {}, 'lease-2')

    expect(calls.map(c => c.requester)).toEqual([
      { webContentsId: 101, renderGeneration: 1 },
      { webContentsId: 101, renderGeneration: 2 },
    ])
  })

  test('the workspace follows the window, not the request', async () => {
    const windows: Record<number, string | null> = { 101: 'ws_a' }
    const { host, calls } = ipcHost({ windows })
    const win = fakeWebContents(101)

    await handlePageGrantIpc(host, win.contents, 'dash', {}, 'lease-1')
    // The window switches workspace; the next request follows it with no
    // cooperation from — and no way to be overridden by — the renderer.
    windows[101] = 'ws_b'
    await handlePageGrantIpc(host, win.contents, 'dash', {}, 'lease-2')

    expect(calls.map(c => c.workspaceId)).toEqual(['ws_a', 'ws_b'])
  })
})
