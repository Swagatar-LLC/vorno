/**
 * Main-process user activation for privileged Page actions (ADR-0033 §3).
 *
 * The companion to `page-grant-identity.ts`: that file answers "is this the
 * render we think it is", this one answers "did a human just do something".
 * Both live in the main process for the same reason — a renderer's claim about
 * either is a claim, and a token-holding transport client's is not even that.
 *
 * **What the experiment settled.** `roadmap/evidence/SUV-0065` records a run of
 * the probe ADR-0033 §3 demands. Parent-window `navigator.userActivation`
 * reads `true` after a click over the Page frame AND after a click on
 * unrelated app chrome, so it is freshness and never frame proof; and
 * Electron's `input-event` payload carries no frame identity at all. There is
 * therefore no signal at any trust level that attributes a gesture to the Page,
 * and this module does not pretend otherwise. What it provides is the honest
 * subset: a gesture the MAIN PROCESS saw, in this window, recently, which has
 * not already been spent.
 *
 * That subset is what makes the product claims true:
 *
 *   no hover, no passive   only genuinely activating input types count, so
 *                          moves, wheel, and enter/leave are not gestures
 *   no timer, no on-load   a page with no user input has no gesture to spend
 *   one action per click   a gesture is CONSUMED when it mints a ticket
 *
 * The remaining gap — that a click on app chrome is indistinguishable from a
 * click in the Page — is closed for the dangerous kinds by the broker's
 * host-rendered first-use confirmation, which is chrome the main process
 * renders and whose answer it observes directly.
 */

import type { RenderGenerationTracker, RenderIdentity, TrackableWebContents } from './page-grant-identity'

/**
 * Input types that represent a human deciding something.
 *
 * An allowlist, not a denylist: Electron's type union grows, and a denylist
 * would silently admit whatever gets added next. `mouseDown` and not `mouseUp`
 * because one physical click produces both and a pair would otherwise read as
 * two gestures; `keyDown` and `rawKeyDown` because which one arrives depends on
 * focus and platform.
 *
 * Pointedly absent: `mouseMove`, `mouseEnter`, `mouseLeave`, `mouseWheel`, and
 * the gesture/scroll family. Hovering a button is not asking for it to run.
 */
const ACTIVATING_INPUT_TYPES = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'touchStart'])

/**
 * How recent a gesture must be to still authorize an action.
 *
 * Comfortably under ADR-0033's 10-second ticket ceiling, because this window
 * and that one are additive: the gesture ages here, then the ticket it mints
 * ages again before it is spent. Five seconds is long enough for a click to
 * become an RPC round trip and short enough that a gesture cannot be banked.
 */
export const USER_GESTURE_MAX_AGE_MS = 5_000

/**
 * The subset of Electron's `WebContents` this tracker needs.
 *
 * An intersection rather than an `extends`: TypeScript treats a subinterface's
 * `on` as having to be assignable to the parent's overload set, which a single
 * added signature never is. Intersecting merges the overloads, which is what
 * `WebContents` actually does.
 */
export type GestureTrackableWebContents = TrackableWebContents & {
  on(event: 'input-event', listener: (event: unknown, input: { type?: string }) => void): unknown
}

export interface UserGestureTracker {
  /**
   * Begin observing input for this webContents. Idempotent: re-observing an
   * already-observed contents must not attach a second listener, or one click
   * would record as several.
   */
  observe(contents: GestureTrackableWebContents): void
  /**
   * Spend the render's most recent gesture, if it has one that is fresh, and
   * report whether it did. Consuming is the point: without it a single click
   * would authorize every action that followed it inside the window.
   */
  consume(identity: RenderIdentity, now?: number): boolean
  /** Forget a render's gesture without spending it (diagnostics, teardown). */
  forget(webContentsId: number): void
}

/**
 * Tracks the last unspent activating gesture per webContents.
 *
 * The recorded generation is load-bearing rather than bookkeeping. A gesture
 * belongs to the document that was live when it happened, so a reload or a
 * crash-recover — which keeps the webContents id — must not hand the previous
 * document's click to its replacement. `RenderGenerationTracker` already knows
 * when that happens, so this consults it instead of keeping a second answer.
 */
export function createUserGestureTracker(
  generations: Pick<RenderGenerationTracker, 'track' | 'current' | 'isCurrent'>,
): UserGestureTracker {
  const lastGesture = new Map<number, { at: number; renderGeneration: number }>()
  const observed = new Set<number>()

  return {
    observe(contents) {
      if (observed.has(contents.id)) return
      observed.add(contents.id)
      // Start the generation here rather than relying on something else having
      // done it. A gesture must be bound to the document that made it, so an
      // unbound gesture is silently dropped — and "observation happened to run
      // before tracking" is not a property worth depending on across files.
      generations.track(contents)
      contents.on('input-event', (_event, input) => {
        if (!input || !ACTIVATING_INPUT_TYPES.has(String(input.type))) return
        const renderGeneration = generations.current(contents.id)
        // Undefined means the webContents was destroyed between the listener
        // firing and this read; there is no identity to bind to, and an
        // unbindable gesture would be spendable by whatever asked next.
        if (renderGeneration === undefined) return
        lastGesture.set(contents.id, { at: Date.now(), renderGeneration })
      })
      contents.once('destroyed', () => {
        lastGesture.delete(contents.id)
        observed.delete(contents.id)
      })
    },

    consume(identity, now = Date.now()) {
      const gesture = lastGesture.get(identity.webContentsId)
      if (!gesture) return false
      // Spend it whatever the verdict. A gesture that failed a check is still
      // a gesture the user made and this code has now looked at; leaving it in
      // place would let a caller retry against the same click until one of its
      // attempts happened to line up.
      lastGesture.delete(identity.webContentsId)
      if (gesture.renderGeneration !== identity.renderGeneration) return false
      if (!generations.isCurrent(identity)) return false
      return now - gesture.at <= USER_GESTURE_MAX_AGE_MS
    },

    forget(webContentsId) {
      lastGesture.delete(webContentsId)
    },
  }
}

/** What the activation IPC handler needs from the host, and nothing more. */
export interface PageActivationIpcHost {
  /** Workspace shown by that window, or null/undefined if it is not an app window. */
  getWorkspaceForWindow(webContentsId: number): string | null | undefined
  tracker: RenderGenerationTracker
  gestures: UserGestureTracker
  /** The registered server-side entry point; absent on hosts that cannot mint. */
  request?: (
    requester: RenderIdentity,
    workspaceId: string,
    pageSlug: string,
    request: unknown,
  ) => Promise<{ ticketId: string; expiresAt: number }>
}

/**
 * The body of the `__pages:request-activation` IPC handler.
 *
 * `sender` must come from `event.sender`. The workspace is resolved from the
 * host's own window map, never from the payload, for the same reason grant
 * consent does it: a renderer that could name the workspace could mint a ticket
 * against one its window does not show.
 *
 * The gesture is checked BEFORE the request reaches the server. That ordering
 * is deliberate — a caller with no gesture learns only that it needs one, and
 * never gets far enough to find out whether its lease, grant, or page exist.
 */
export async function handlePageActivationIpc(
  host: PageActivationIpcHost,
  sender: GestureTrackableWebContents,
  pageSlug: unknown,
  request: unknown,
): Promise<{ ticketId: string; expiresAt: number }> {
  const workspaceId = host.getWorkspaceForWindow(sender.id)
  // An unknown window is not a workspace window: browser panes, devtools, and
  // anything else that can reach ipcMain resolve to nothing and stop here.
  if (!workspaceId || !host.request) throw new Error('PAGE_ACTIVATION_TRUSTED_CONTEXT_REQUIRED')
  if (typeof pageSlug !== 'string') throw new Error('PAGE_ACTIVATION_INVALID_REQUEST')

  const renderGeneration = host.tracker.track(sender)
  const requester: RenderIdentity = { webContentsId: sender.id, renderGeneration }
  if (!host.gestures.consume(requester)) throw new Error('PAGE_ACTIVATION_USER_GESTURE_REQUIRED')

  return host.request(requester, workspaceId, pageSlug, request)
}
