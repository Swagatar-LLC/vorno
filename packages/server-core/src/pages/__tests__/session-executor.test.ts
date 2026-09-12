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

function createHost(sessions: Record<string, SessionCallbackTarget[]>): SessionCallbackHost & {
  deliveries: Array<{ sessionId: string; message: string }>
} {
  const deliveries: Array<{ sessionId: string; message: string }> = []
  return {
    getSessions: (workspaceId: string) => sessions[workspaceId] ?? [],
    async sendMessage(sessionId: string, message: string) { deliveries.push({ sessionId, message }) },
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

    await expect(execute(invocation)).resolves.toEqual({ ok: true })
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

  test('refuses a target that belongs to another workspace', async () => {
    // The session is real. It is just not this workspace's.
    const host = createHost({ [OTHER_WORKSPACE]: [{ id: 'sess_target', isProcessing: false }] })
    const execute = createExecutor(host)

    await expect(execute(invocation)).resolves.toMatchObject({ ok: false, code: 'session-not-found' })
    expect(host.deliveries).toHaveLength(0)
  })

  test('does not distinguish "missing" from "another workspace owns it"', async () => {
    // Same code for both, deliberately: a caller that could tell them apart
    // could enumerate other workspaces' session ids one guess at a time.
    const elsewhere = createHost({ [OTHER_WORKSPACE]: [{ id: 'sess_target', isProcessing: false }] })
    const nowhere = createHost({ [WORKSPACE]: [{ id: 'sess_unrelated', isProcessing: false }] })

    const a = await createExecutor(elsewhere)(invocation)
    const b = await createExecutor(nowhere)(invocation)
    expect(a).toEqual(b)
  })

  test('refuses an archived target', async () => {
    const host = createHost({ [WORKSPACE]: [{ id: 'sess_target', isProcessing: false, isArchived: true }] })
    await expect(createExecutor(host)(invocation)).resolves.toMatchObject({ ok: false, code: 'session-closed' })
    expect(host.deliveries).toHaveLength(0)
  })

  test('refuses a target in a closed-category status', async () => {
    // `done` is a built-in closed status; the category comes from the real
    // status config this workspace has on disk.
    const host = createHost({ [WORKSPACE]: [{ id: 'sess_target', isProcessing: false, sessionStatus: 'done' }] })
    await expect(createExecutor(host)(invocation)).resolves.toMatchObject({ ok: false, code: 'session-closed' })
    expect(host.deliveries).toHaveLength(0)
  })

  test('delivers to a target in an open status', async () => {
    const host = createHost({ [WORKSPACE]: [{ id: 'sess_target', isProcessing: false, sessionStatus: 'in-progress' }] })
    await expect(createExecutor(host)(invocation)).resolves.toEqual({ ok: true })
    expect(host.deliveries).toHaveLength(1)
  })

  test('refuses a busy target rather than queueing or steering into its turn', async () => {
    const host = createHost({ [WORKSPACE]: [{ id: 'sess_target', isProcessing: true }] })
    // `sendMessage` on a processing session takes the mid-stream path, which
    // either interrupts the running turn or queues behind it. Both would put a
    // page's text inside a turn the user is watching with no gesture of theirs
    // in between, so the callback refuses instead of inheriting that behavior.
    await expect(createExecutor(host)(invocation)).resolves.toMatchObject({ ok: false, code: 'session-busy' })
    expect(host.deliveries).toHaveLength(0)
  })

  test('refuses when the workspace has no sessions at all — there is no default target', async () => {
    const host = createHost({})
    await expect(createExecutor(host)(invocation)).resolves.toMatchObject({ ok: false, code: 'session-not-found' })
    expect(host.deliveries).toHaveLength(0)
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
      expect(surface).toContain('getSessions')
      expect(surface).toContain('sendMessage')
      for (const forbidden of [
        'setSessionStatus', 'setSessionLabels', 'applyContextProfile',
        'archiveSession', 'deleteSession', 'createSession', 'closeSession',
        'setSessionPermissionMode', 'stopSession',
      ]) {
        expect(source).not.toContain(`${forbidden}(`)
      }
    })
  })
})
