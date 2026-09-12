/**
 * SUV-0064 — the pinned session callback executor.
 *
 * These are the gate's own tests: containment, lifecycle state, and the hard
 * no-close boundary. The RPC suite proves the same gate is reachable through
 * the channels a real caller uses; this one proves the gate is right.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { describeOrigin, mayCloseSession, pageOrigin } from '@craft-agent/shared/statuses'
import {
  createPagesSessionExecutor,
  pageCallbackAttribution,
  type SessionCallbackHost,
  type SessionCallbackTarget,
} from '../session-executor'

const ROOT = join(CONFIG_DIR, 'workspaces', 'pages-session-executor')
const WORKSPACE = 'ws_session_executor'
const OTHER_WORKSPACE = 'ws_session_executor_other'

const log = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * A workspace with real status config on disk, because `session-closed` is
 * decided by `getStatusCategory` reading it — a fake that skipped this would
 * be asserting against a lookup that always returned null.
 */
function seedWorkspace(): void {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'statuses'), { recursive: true })
  writeFileSync(join(ROOT, 'config.json'), JSON.stringify({
    id: WORKSPACE, name: WORKSPACE, slug: WORKSPACE, createdAt: 1, updatedAt: 1,
  }))
}

/**
 * A host whose atomic primitive behaves like the real one: it re-reads session
 * state at the commit point rather than trusting what the executor saw, and it
 * re-reads the abort signal there too. `onCommit` lets a test change the world
 * in exactly the window the real race lives in — between the executor's read
 * and the commit — which is the only way to prove the re-check binds.
 */
function createHost(
  sessions: Record<string, SessionCallbackTarget[]>,
  onCommit?: () => void,
): SessionCallbackHost & { deliveries: Array<{ sessionId: string; message: string }> } {
  const deliveries: Array<{ sessionId: string; message: string }> = []
  return {
    getSessions: (workspaceId: string) => sessions[workspaceId] ?? [],
    async tryDeliverPageCallback(sessionId, message, options) {
      // The await the real primitive performs before its decision — the window
      // the world can move in.
      await Promise.resolve()
      onCommit?.()
      const live = (sessions[options.workspaceId] ?? []).find((s) => s.id === sessionId)
      if (!live) return { ok: false as const, code: 'session-not-found' as const }
      if (options.signal?.aborted) return { ok: false as const, code: 'cancelled' as const }
      if (live.isArchived) return { ok: false as const, code: 'session-closed' as const }
      if (live.isProcessing) return { ok: false as const, code: 'session-busy' as const }
      deliveries.push({ sessionId, message })
      options.onCommitted?.()
      return { ok: true as const, durable: true }
    },
    deliveries,
  }
}

function createExecutor(host: SessionCallbackHost) {
  seedWorkspace()
  return createPagesSessionExecutor({
    sessionManager: host,
    workspaceId: WORKSPACE,
    workspaceRootPath: ROOT,
    log,
  })
}

const invocation = {
  pageSlug: 'dashboard',
  grantId: 'grant_abc123',
  sessionId: 'sess_target',
  message: 'Refresh the quarterly numbers.',
}

describe('page session callback executor', () => {
  test('delivers the pinned body verbatim behind a host provenance line', async () => {
    const host = createHost({ [WORKSPACE]: [{ id: 'sess_target', isProcessing: false }] })
    const execute = createExecutor(host)

    await expect(execute(invocation, { signal: new AbortController().signal })).resolves.toEqual({ ok: true, durable: true })
    expect(host.deliveries).toHaveLength(1)

    const delivered = host.deliveries[0]!.message
    // The user approved this exact sentence, so it arrives unaltered...
    expect(delivered.endsWith(invocation.message)).toBe(true)
    // ...prefixed by attribution the page cannot forge (its slug is
    // `[a-z0-9-]+` by the time it reaches here, so it cannot add a line or a
    // bracket) and cannot suppress.
    expect(delivered.startsWith(pageCallbackAttribution('dashboard', 'grant_abc123'))).toBe(true)
    expect(delivered).toContain('not typed by the user')
  })

  test('always produces an attribution line, even with i18n unavailable', () => {
    // The provenance line is a security property: without it a callback reads
    // as a user turn, which is the injection shape the feature exists to stop.
    // This host never boots i18n, so the fallback is what runs here — and that
    // is the case worth pinning, because a missing translation must degrade to
    // English rather than to nothing.
    const line = pageCallbackAttribution('dashboard', 'grant_abc123')
    expect(line).toContain('dashboard')
    expect(line).toContain('grant_abc123')
    expect(line).not.toContain('undefined')
    expect(line.startsWith('[')).toBe(true)
    // A slug is `[a-z0-9-]+` by the time it reaches here, so it cannot close
    // the bracket early or open a second line in any locale.
    expect(line.split('\n')).toHaveLength(1)
  })

  test('falls back to English when a locale drops EITHER placeholder', async () => {
    // Both halves of the provenance are load-bearing: the page says who sent
    // it, the grant says which approval authorized it — and the grant is what
    // an operator revokes. A locale that kept only the slug would still pass a
    // page-only check and silently ship a half-useless warning, so a
    // translation that loses either value is treated as no translation.
    const { i18n } = await import('@craft-agent/shared/i18n')
    const original = i18n.t.bind(i18n)
    try {
      for (const partial of [
        // Grant dropped.
        (_k: string, v: Record<string, string>) => `[Page callback — page "${v.page}".]`,
        // Page dropped.
        (_k: string, v: Record<string, string>) => `[Page callback — grant ${v.grant}.]`,
        // Neither interpolated at all.
        () => '[Page callback.]',
      ]) {
        ;(i18n as unknown as { t: unknown }).t = partial
        const line = pageCallbackAttribution('dashboard', 'grant_abc123')
        expect(line).toContain('dashboard')
        expect(line).toContain('grant_abc123')
        expect(line).toContain('not typed by the user')
      }
    } finally {
      ;(i18n as unknown as { t: unknown }).t = original
    }
  })

  test('refuses a target that belongs to another workspace', async () => {
    // The session is real. It is just not this workspace's.
    const host = createHost({ [OTHER_WORKSPACE]: [{ id: 'sess_target', isProcessing: false }] })
    const execute = createExecutor(host)

    await expect(execute(invocation, { signal: new AbortController().signal })).resolves.toMatchObject({ ok: false, code: 'session-not-found' })
    expect(host.deliveries).toHaveLength(0)
  })

  test('does not distinguish "missing" from "another workspace owns it"', async () => {
    // Same code for both, deliberately: a caller that could tell them apart
    // could enumerate other workspaces' session ids one guess at a time.
    const elsewhere = createHost({ [OTHER_WORKSPACE]: [{ id: 'sess_target', isProcessing: false }] })
    const nowhere = createHost({ [WORKSPACE]: [{ id: 'sess_unrelated', isProcessing: false }] })

    const a = await createExecutor(elsewhere)(invocation, { signal: new AbortController().signal })
    const b = await createExecutor(nowhere)(invocation, { signal: new AbortController().signal })
    expect(a).toEqual(b)
  })

  test('refuses an archived target', async () => {
    const host = createHost({ [WORKSPACE]: [{ id: 'sess_target', isProcessing: false, isArchived: true }] })
    await expect(createExecutor(host)(invocation, { signal: new AbortController().signal })).resolves.toMatchObject({ ok: false, code: 'session-closed' })
    expect(host.deliveries).toHaveLength(0)
  })

  test('refuses a target in a closed-category status', async () => {
    // `done` is a built-in closed status; the category comes from the real
    // status config this workspace has on disk.
    const host = createHost({ [WORKSPACE]: [{ id: 'sess_target', isProcessing: false, sessionStatus: 'done' }] })
    await expect(createExecutor(host)(invocation, { signal: new AbortController().signal })).resolves.toMatchObject({ ok: false, code: 'session-closed' })
    expect(host.deliveries).toHaveLength(0)
  })

  test('delivers to a target in an open status', async () => {
    const host = createHost({ [WORKSPACE]: [{ id: 'sess_target', isProcessing: false, sessionStatus: 'in-progress' }] })
    await expect(createExecutor(host)(invocation, { signal: new AbortController().signal })).resolves.toEqual({ ok: true, durable: true })
    expect(host.deliveries).toHaveLength(1)
  })

  test('refuses a busy target rather than queueing or steering into its turn', async () => {
    const host = createHost({ [WORKSPACE]: [{ id: 'sess_target', isProcessing: true }] })
    // `sendMessage` on a processing session takes the mid-stream path, which
    // either interrupts the running turn or queues behind it. Both would put a
    // page's text inside a turn the user is watching with no gesture of theirs
    // in between, so the callback refuses instead of inheriting that behavior.
    await expect(createExecutor(host)(invocation, { signal: new AbortController().signal })).resolves.toMatchObject({ ok: false, code: 'session-busy' })
    expect(host.deliveries).toHaveLength(0)
  })

  test('refuses when the workspace has no sessions at all — there is no default target', async () => {
    const host = createHost({})
    await expect(createExecutor(host)(invocation, { signal: new AbortController().signal })).resolves.toMatchObject({ ok: false, code: 'session-not-found' })
    expect(host.deliveries).toHaveLength(0)
  })

  /**
   * The race Greptile found on PR #205, and the reason the atomic primitive
   * exists. The executor's own read of busy/closed/archived is a cheap early
   * exit; the binding answer is the one taken in the same JS turn as the
   * commit. These tests move the world in exactly that window.
   */
  describe('state that changes between the check and the commit', () => {
    test('a turn that starts during the commit window refuses instead of steering', async () => {
      const sessions: Record<string, SessionCallbackTarget[]> = {
        [WORKSPACE]: [{ id: 'sess_target', isProcessing: false }],
      }
      // The executor reads an idle session; a turn begins before the commit.
      const host = createHost(sessions, () => { sessions[WORKSPACE]![0]!.isProcessing = true })

      await expect(createExecutor(host)(invocation, { signal: new AbortController().signal }))
        .resolves.toMatchObject({ ok: false, code: 'session-busy' })
      expect(host.deliveries).toHaveLength(0)
    })

    test('a session archived during the commit window refuses instead of delivering', async () => {
      const sessions: Record<string, SessionCallbackTarget[]> = {
        [WORKSPACE]: [{ id: 'sess_target', isProcessing: false }],
      }
      const host = createHost(sessions, () => { sessions[WORKSPACE]![0]!.isArchived = true })

      await expect(createExecutor(host)(invocation, { signal: new AbortController().signal }))
        .resolves.toMatchObject({ ok: false, code: 'session-closed' })
      expect(host.deliveries).toHaveLength(0)
    })

    test('a session deleted during the commit window refuses instead of delivering', async () => {
      const sessions: Record<string, SessionCallbackTarget[]> = {
        [WORKSPACE]: [{ id: 'sess_target', isProcessing: false }],
      }
      const host = createHost(sessions, () => { sessions[WORKSPACE] = [] })

      await expect(createExecutor(host)(invocation, { signal: new AbortController().signal }))
        .resolves.toMatchObject({ ok: false, code: 'session-not-found' })
      expect(host.deliveries).toHaveLength(0)
    })
  })

  describe('cancellation', () => {
    test('refuses without delivering when already aborted', async () => {
      const host = createHost({ [WORKSPACE]: [{ id: 'sess_target', isProcessing: false }] })
      const controller = new AbortController()
      controller.abort()

      await expect(createExecutor(host)(invocation, { signal: controller.signal }))
        .resolves.toMatchObject({ ok: false, code: 'cancelled' })
      expect(host.deliveries).toHaveLength(0)
    })

    test('an abort landing DURING the commit window still stops delivery', async () => {
      // This is the case a pre-entry check alone cannot cover, and the one that
      // made the old code audit a delivered message as cancelled: `race` does
      // not stop its losing promise, so without the signal reaching the commit
      // point the send ran anyway.
      const controller = new AbortController()
      const host = createHost(
        { [WORKSPACE]: [{ id: 'sess_target', isProcessing: false }] },
        () => controller.abort(),
      )

      await expect(createExecutor(host)(invocation, { signal: controller.signal }))
        .resolves.toMatchObject({ ok: false, code: 'cancelled' })
      expect(host.deliveries).toHaveLength(0)
    })

    test('an abort landing AFTER the commit does not unsay a delivered message', async () => {
      // Once the message is on disk the action succeeded. Relabelling it
      // cancelled would be the same false audit in the opposite direction.
      const controller = new AbortController()
      const host = createHost({ [WORKSPACE]: [{ id: 'sess_target', isProcessing: false }] })

      const outcome = await createExecutor(host)(invocation, { signal: controller.signal })
      controller.abort()

      expect(outcome).toEqual({ ok: true, durable: true })
      expect(host.deliveries).toHaveLength(1)
    })
  })

  /**
   * The hard no-close boundary, stated two ways because each catches what the
   * other cannot: the interface catches a call that does not exist yet, and the
   * origin catches one routed through the shared status choke point later.
   */
  describe('no-close boundary', () => {
    test('a page origin may never close a session, unconditionally', () => {
      expect(mayCloseSession(pageOrigin('dashboard', 'grant_abc123'))).toBe(false)
      // No `allowClosed` counterpart exists to flip, unlike `automation`. That
      // asymmetry is the decision: an automation was reviewed by a human at
      // registration, and a Page's content is agent-authored and rewritable.
      expect(Object.keys(pageOrigin('dashboard', 'grant_abc123'))).toEqual(['kind', 'pageSlug', 'grantId'])
    })

    test('a refusal log names the page and the grant', () => {
      expect(describeOrigin(pageOrigin('dashboard', 'grant_abc123')))
        .toBe('page (dashboard, grant grant_abc123)')
    })

    test('the executor is given no method that could close, archive, or delete', async () => {
      // Enforcement by absence, not by a check: a check is something a later
      // edit can weaken, while a method that is not on the injected interface
      // cannot be called at all. This reads the real source so that widening
      // `SessionCallbackHost` — the reviewable moment at which a Page would
      // gain a new power — cannot happen quietly.
      const source = readFileSync(join(import.meta.dir, '..', 'session-executor.ts'), 'utf-8')
      const surface = source.slice(
        source.indexOf('export interface SessionCallbackHost'),
        source.indexOf('export interface PagesSessionExecutorDeps'),
      )

      // Declared members only, read off the interface body rather than matched
      // as substrings. An earlier version asserted `surface` contained
      // 'sendMessage' — which kept passing after the member was replaced by
      // `tryDeliverPageCallback`, because the word survived in a comment
      // explaining why `sendMessage` is NOT the member. A test that a prose
      // change can satisfy is not testing the interface.
      const declared = [...surface.matchAll(/^\s{2}(\w+)\s*[(<]/gm)].map((m) => m[1]!)
      expect(declared.sort()).toEqual(['getSessions', 'tryDeliverPageCallback'])

      // Exactly two powers, and no lifecycle call anywhere in the file — the
      // no-close boundary is enforced by absence, so absence is what is
      // asserted.
      for (const forbidden of [
        'setSessionStatus', 'setSessionLabels', 'applyContextProfile',
        'archiveSession', 'deleteSession', 'createSession', 'closeSession',
        'setSessionPermissionMode', 'stopSession', 'sendMessage',
      ]) {
        expect(declared).not.toContain(forbidden)
        expect(source).not.toContain(`${forbidden}(`)
      }
    })
  })
})
