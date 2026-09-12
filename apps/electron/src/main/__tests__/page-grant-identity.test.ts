import { describe, expect, test } from 'bun:test'
import {
  createRenderGenerationTracker,
  formatPageGrantDescriptor,
  handlePageGrantIpc,
  isRequesterCurrent,
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
     * `(details, ...deprecated)` — the shape Electron 39's own typings declare,
     * where `Event<Params>` is `{ preventDefault, defaultPrevented } & Params`.
     */
    navigate: (details: NavDetails) => navigation.forEach(fn => fn(
      { preventDefault() {}, defaultPrevented: false, url: 'app://x', frame: null, ...details },
      'app://x', details.isSameDocument, details.isMainFrame, 1, 2,
    )),
    /**
     * `(event, details, ...deprecated)` — the shape review asserts is the real
     * runtime order. The parser must be right under both, so both are driven
     * here rather than picking a side.
     */
    navigateEventFirst: (details: NavDetails) => navigation.forEach(fn => fn(
      { preventDefault() {}, defaultPrevented: false },
      { preventDefault() {}, defaultPrevented: false, url: 'app://x', frame: null, ...details },
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

describe('host grant descriptor rendering', () => {
  test('escapes controls, preserves spaced argument boundaries, and fills script defaults', () => {
    const rendered = formatPageGrantDescriptor({
      kind: 'script', script: 'scripts/run.ts', args: ['--label', 'two words', 'line\nbreak', '\u0000control', '\u0085c1', '\u2028line', '\u202ebidi', '\u2066isolate'],
    })
    expect(rendered).toContain('"runtime": "bun"')
    expect(rendered).toContain('"args": [')
    expect(rendered).toContain('"two words"')
    expect(rendered).toContain('"line\\nbreak"')
    expect(rendered).toContain('"\\u0000control"')
    expect(rendered).toContain('\\u0085c1')
    expect(rendered).toContain('\\u2028line')
    expect(rendered).toContain('\\u202ebidi')
    expect(rendered).toContain('\\u2066isolate')
    expect(rendered).not.toContain('line\nbreak')
  })

  test('escapes every invisible or reordering category, not a hand-picked list of them', () => {
    // These are all Cc/Cf/Zl/Zp and every one of them renders as nothing in a
    // native dialog, so an unescaped one lets a descriptor hide or reorder text
    // the user is being asked to approve. The enumerated class this replaced
    // covered the bidi overrides and missed the rest.
    const invisible = {
      '\u200e': '\\u200e', // LEFT-TO-RIGHT MARK
      '\u200f': '\\u200f', // RIGHT-TO-LEFT MARK
      '\u200b': '\\u200b', // ZERO WIDTH SPACE
      '\u00ad': '\\u00ad', // SOFT HYPHEN
      '\ufeff': '\\ufeff', // ZERO WIDTH NO-BREAK SPACE (BOM)
      '\u2029': '\\u2029', // PARAGRAPH SEPARATOR
      '\u061c': '\\u061c', // ARABIC LETTER MARK
      '\u{1d173}': '\\u{1d173}', // MUSICAL SYMBOL BEGIN BEAM — astral, so a
      //                              4-padded escape would corrupt it
    }
    for (const [raw, escaped] of Object.entries(invisible)) {
      const rendered = formatPageGrantDescriptor({
        kind: 'mcp', sourceSlug: 'source', toolName: `before${raw}after`,
      })
      expect(rendered).toContain(`"before${escaped}after"`)
      expect(rendered).not.toContain(raw)
    }
  })

  test('leaves ordinary printable text exactly as JSON wrote it', () => {
    const rendered = formatPageGrantDescriptor({
      kind: 'api', sourceSlug: 'linear', method: 'POST', pathPattern: '/issues/{id}?q=a b&r=\u00e9\u4e2d',
    })
    expect(rendered).toContain('"/issues/{id}?q=a b&r=\u00e9\u4e2d"')
  })
})

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

  test('reads the navigation the same way wherever the details sit in the arguments', () => {
    // Whether Electron emits (details, …), (event, details, …), or the pre-39
    // positional form, an ordinary same-document or subframe navigation must
    // NOT cancel live consent, and a document replacement must retire.
    for (const shape of ['navigate', 'navigateEventFirst', 'navigateLegacy'] as const) {
      const retired: RenderIdentity[] = []
      const tracker = createRenderGenerationTracker(r => retired.push(r))
      const win = fakeWebContents(101)
      tracker.track(win.contents)

      win[shape]({ isMainFrame: true, isSameDocument: true })
      win[shape]({ isMainFrame: false, isSameDocument: false })
      win[shape]({ isMainFrame: false, isSameDocument: true })
      expect(retired).toEqual([])
      expect(tracker.isCurrent({ webContentsId: 101, renderGeneration: 1 })).toBe(true)

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

describe('requester currency predicate', () => {
  const WORKSPACE = 'ws_a'

  function scenario(overrides: { destroyed?: boolean; missingWindow?: boolean; workspace?: string | null } = {}) {
    const tracker = createRenderGenerationTracker()
    const win = fakeWebContents(101)
    tracker.track(win.contents)
    const windows = {
      getWindowByWebContentsId: () => overrides.missingWindow
        ? null
        : { isDestroyed: () => overrides.destroyed === true },
      getWorkspaceForWindow: () => overrides.workspace === undefined ? WORKSPACE : overrides.workspace,
    }
    return { tracker, win, windows, live: { webContentsId: 101, renderGeneration: 1 } }
  }

  test('accepts the live render of a live window showing that workspace', () => {
    const { tracker, windows, live } = scenario()
    expect(isRequesterCurrent(windows, tracker, live, WORKSPACE)).toBe(true)
  })

  test('each condition is independently required', () => {
    // None of these implies another, so each is checked on its own: a live
    // window can hold a replaced document, a current generation can sit in a
    // window that switched workspace, and a destroyed window stays mapped.
    const missing = scenario({ missingWindow: true })
    expect(isRequesterCurrent(missing.windows, missing.tracker, missing.live, WORKSPACE)).toBe(false)

    const destroyed = scenario({ destroyed: true })
    expect(isRequesterCurrent(destroyed.windows, destroyed.tracker, destroyed.live, WORKSPACE)).toBe(false)

    const replaced = scenario()
    replaced.win.navigate(DOCUMENT_REPLACED)
    expect(isRequesterCurrent(replaced.windows, replaced.tracker, replaced.live, WORKSPACE)).toBe(false)
    // ...and the successor is accepted, so this is staleness, not a lockout.
    expect(isRequesterCurrent(replaced.windows, replaced.tracker,
      { webContentsId: 101, renderGeneration: 2 }, WORKSPACE)).toBe(true)

    const moved = scenario({ workspace: 'ws_other' })
    expect(isRequesterCurrent(moved.windows, moved.tracker, moved.live, WORKSPACE)).toBe(false)

    const unmapped = scenario({ workspace: null })
    expect(isRequesterCurrent(unmapped.windows, unmapped.tracker, unmapped.live, WORKSPACE)).toBe(false)
  })

  test('a host with no window manager can never be current', () => {
    // Headless and early-startup both land here; absent must fail closed.
    const { tracker, live } = scenario()
    expect(isRequesterCurrent(undefined, tracker, live, WORKSPACE)).toBe(false)
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

  test('a payload shaped like a requester cannot forge identity', async () => {
    const { host, calls } = ipcHost()
    const win = fakeWebContents(101)

    // The transport-side attack, replayed at this seam: a caller that reaches
    // the IPC path sends values deliberately shaped like the identity it wants
    // to be. Every one of them is opaque payload here — only `sender` and the
    // host's own window map can produce a requester or a workspace.
    await handlePageGrantIpc(host, win.contents, 'dash', {
      webContentsId: 999, renderGeneration: 99, workspaceId: 'ws_attacker',
      requester: { webContentsId: 999, renderGeneration: 99 },
    }, { webContentsId: 999, renderGeneration: 99, workspaceId: 'ws_attacker' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.requester).toEqual({ webContentsId: 101, renderGeneration: 1 })
    expect(calls[0]!.workspaceId).toBe('ws_a')
  })

  test('forwards slug, input, and lease verbatim — this layer validates none of them', async () => {
    const { host, calls } = ipcHost()
    const win = fakeWebContents(101)
    const input = { action: { kind: 'script', script: '../escape.ts' } }

    await handlePageGrantIpc(host, win.contents, 'dash', input, 'lease-1')

    // Deliberate: the grant handler re-parses input against the schema and
    // re-checks the lease. Sanitizing here would create a second, weaker
    // validator that the real one could silently drift away from.
    expect(calls[0]!.input).toBe(input)
    expect(calls[0]!.leaseId).toBe('lease-1')
    expect(calls[0]!.pageSlug).toBe('dash')
  })

  test('refuses once the sender window stops mapping to a workspace', async () => {
    const windows: Record<number, string | null> = { 101: 'ws_a' }
    const { host, calls } = ipcHost({ windows })
    const win = fakeWebContents(101)
    await handlePageGrantIpc(host, win.contents, 'dash', {}, 'lease-1')
    expect(calls).toHaveLength(1)

    // The window closed or stopped being an app window between requests.
    windows[101] = null

    await expect(handlePageGrantIpc(host, win.contents, 'dash', {}, 'lease-2'))
      .rejects.toThrow('PAGE_GRANT_TRUSTED_CONTEXT_REQUIRED')
    expect(calls).toHaveLength(1)
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
