/**
 * fork(PLAN-031) — the closed-status gate at the single choke point.
 *
 * Before this, "the human owns closure" was enforced in exactly one place: the agent-facing MCP
 * tool handler. `SessionManager.setSessionStatus` validated nothing, and the renderer's Kanban
 * drag-drop went straight through it — so the protection that stopped a model from closing a task
 * did not exist for any other writer, and a new call site inherited no protection at all.
 *
 * The rule is NOT "closing is hard". A human dragging a card into Done is declaring intent and
 * must not be obstructed. The rule is that the caller has to say who it is, and a caller that
 * doesn't say cannot close.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionFilePath,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { USER_ORIGIN, hostOrigin, mayCloseSession } from '@craft-agent/shared/statuses'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('setSessionStatus closure gate', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-closure-gate-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function seedSession(sessionId: string, sessionStatus = 'todo') {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'gate test',
      sessionStatus,
      labels: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
    } as unknown as StoredSession)

    const managed = createManagedSession(
      { id: sessionId, name: 'gate test', sessionStatus, labels: [], createdAt: Date.now() },
      { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() } as never
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    return managed as unknown as { sessionStatus: string }
  }

  function diskStatus(sessionId: string): string {
    const path = getSessionFilePath(tmpRoot, sessionId)
    return JSON.parse(readFileSync(path, 'utf-8').split('\n')[0]!).sessionStatus
  }

  describe('may close', () => {
    it('a human in the UI closes with no confirmation — this path stays frictionless', async () => {
      // The product decision (PLAN-031): dragging a card into Done IS the declaration of intent.
      const managed = seedSession('by-user')
      await sm.setSessionStatus('by-user', 'done', USER_ORIGIN)
      expect(managed.sessionStatus).toBe('done')
      expect(diskStatus('by-user')).toBe('done')
    })

    it('deterministic host code (the Conductor) closes a finished task', async () => {
      const managed = seedSession('by-host')
      await sm.setSessionStatus('by-host', 'done', hostOrigin('conductor: run completed'))
      expect(managed.sessionStatus).toBe('done')
    })

    it('an automation closes when it declared allowClosed at registration', async () => {
      const managed = seedSession('by-automation-allowed')
      await sm.setSessionStatus('by-automation-allowed', 'done', {
        kind: 'automation',
        matcherId: 'auto-close-set-done',
        allowClosed: true,
      })
      expect(managed.sessionStatus).toBe('done')
    })
  })

  describe('may not close', () => {
    it('a model may never close a task', async () => {
      const managed = seedSession('by-agent')
      await sm.setSessionStatus('by-agent', 'done', { kind: 'agent' })
      expect(managed.sessionStatus).toBe('todo')
      expect(diskStatus('by-agent')).toBe('todo')
    })

    it('an automation without allowClosed is refused (ADR-0021 §2 preserved)', async () => {
      const managed = seedSession('by-automation-denied')
      await sm.setSessionStatus('by-automation-denied', 'done', {
        kind: 'automation',
        matcherId: 'next-step-spawn-followup',
        allowClosed: false,
      })
      expect(managed.sessionStatus).toBe('todo')
    })

    it('a caller that omits the origin fails CLOSED', async () => {
      // The property that makes this a system invariant rather than a convention: code written
      // after this plan, by someone who never read it, cannot accidentally close a session.
      const managed = seedSession('unattributed')
      await sm.setSessionStatus('unattributed', 'done')
      expect(managed.sessionStatus).toBe('todo')
      expect(diskStatus('unattributed')).toBe('todo')
    })

    it('refusal is a silent no-op, not a throw', async () => {
      // UI and host callers are fire-and-forget (`void sm.setSessionStatus(...)`); throwing here
      // would surface as an unhandled rejection rather than a refusal.
      seedSession('no-throw')
      await expect(sm.setSessionStatus('no-throw', 'cancelled')).resolves.toBeUndefined()
    })

    it('cancelled is gated too, not just done', async () => {
      const managed = seedSession('cancel-gated')
      await sm.setSessionStatus('cancel-gated', 'cancelled', { kind: 'agent' })
      expect(managed.sessionStatus).toBe('todo')
    })
  })

  describe('open statuses are never gated', () => {
    it('an agent may set an open status', async () => {
      const managed = seedSession('agent-open')
      await sm.setSessionStatus('agent-open', 'needs-review', { kind: 'agent' })
      expect(managed.sessionStatus).toBe('needs-review')
    })

    it('an unattributed caller may set an open status', async () => {
      const managed = seedSession('unattributed-open')
      await sm.setSessionStatus('unattributed-open', 'needs-review')
      expect(managed.sessionStatus).toBe('needs-review')
    })

    it('in-progress is reachable and persists — the PLAN-031 seam-5 defect', async () => {
      // On a default-seeded workspace this used to read back as `todo`, so a running task looked
      // untouched. `in-progress` is open, so no origin is required to reach it.
      const managed = seedSession('running')
      await sm.setSessionStatus('running', 'in-progress', hostOrigin('conductor: run started'))
      expect(managed.sessionStatus).toBe('in-progress')
      expect(diskStatus('running')).toBe('in-progress')
    })

    it('an unknown status id is not blocked by the gate', async () => {
      // Unknown ids are handled on read by validateSessionStatus; refusing the write here would
      // be a new behavior PLAN-031 does not intend to introduce.
      const managed = seedSession('unknown')
      await sm.setSessionStatus('unknown', 'not-a-real-status')
      expect(managed.sessionStatus).toBe('not-a-real-status')
    })
  })

  describe('mayCloseSession', () => {
    it('classifies every origin kind', () => {
      expect(mayCloseSession({ kind: 'user' })).toBe(true)
      expect(mayCloseSession({ kind: 'host', reason: 'x' })).toBe(true)
      expect(mayCloseSession({ kind: 'automation', matcherId: 'm', allowClosed: true })).toBe(true)
      expect(mayCloseSession({ kind: 'automation', matcherId: 'm', allowClosed: false })).toBe(false)
      expect(mayCloseSession({ kind: 'agent' })).toBe(false)
      expect(mayCloseSession({ kind: 'unattributed' })).toBe(false)
    })
  })
})
