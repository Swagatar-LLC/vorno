/**
 * fork(PLAN-030) Phase 1 / ADR-0021 §1 — the app-event session-action executor.
 *
 * This is the component whose *absence* blocked Phase 1. `onSessionActions` was supplied
 * only by the webhook dispatcher, so deleting the transport restriction on its own would
 * have converted a loud validation error into a rule that validates clean, computes an
 * action, hands it to an undefined callback, and vanishes — the exact defect Phase 0
 * exists to prevent. These tests assert the action actually lands.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionFilePath,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import type { PendingSessionAction, SessionActionSkip } from '@craft-agent/shared/automations'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const WORKSPACE_ID = 'ws_test'

describe('automation session actions (app events)', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-session-actions-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function seedSession(sessionId: string, sessionStatus = 'todo', labels: string[] = []) {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'action test',
      sessionStatus,
      labels,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
    } as unknown as StoredSession)

    const managed = createManagedSession(
      { id: sessionId, name: 'action test', sessionStatus, labels, createdAt: Date.now() },
      { id: WORKSPACE_ID, name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() } as never
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    return managed as unknown as { sessionStatus: string; labels: string[] }
  }

  async function run(...actions: PendingSessionAction[]): Promise<void> {
    await (sm as unknown as {
      handleAutomationSessionActions(w: string, r: string, a: PendingSessionAction[]): Promise<void>
    }).handleAutomationSessionActions(WORKSPACE_ID, tmpRoot, actions)
  }

  function seedLabels(...ids: string[]) {
    mkdirSync(join(tmpRoot, 'labels'), { recursive: true })
    writeFileSync(
      join(tmpRoot, 'labels', 'config.json'),
      JSON.stringify({ labels: ids.map((id) => ({ id, name: id })) }),
      'utf-8'
    )
  }

  function history(): Array<Record<string, unknown>> {
    const path = join(tmpRoot, 'automations-history.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  function outcomes(): string[] {
    return history()
      .map((e) => (e.sessionAction as { outcome?: string } | undefined)?.outcome)
      .filter((o): o is string => typeof o === 'string')
  }

  const setStatus = (status: string, extra: Partial<PendingSessionAction> = {}): PendingSessionAction => ({
    matcherId: 'lifecycle-rule',
    type: 'set-status',
    target: { id: 'sess-1' },
    status,
    event: 'LabelAdd',
    cause: { matcherId: 'lifecycle-rule', depth: 1 },
    ...extra,
  })

  describe('set-status', () => {
    it('applies an open status from a LabelAdd rule', async () => {
      // The whole point of the phase: this rule shape could not run before.
      const managed = seedSession('sess-1')
      await run(setStatus('needs-review'))
      expect(managed.sessionStatus).toBe('needs-review')
      expect(outcomes()).toEqual(['set-status:needs-review'])
    })

    it('closes a session when the rule declared allowClosed: true', async () => {
      const managed = seedSession('sess-1')
      await run(setStatus('done', { allowClosed: true }))
      expect(managed.sessionStatus).toBe('done')
      expect(outcomes()).toEqual(['set-status:done'])
    })

    it('refuses to close without allowClosed — and records the refusal', async () => {
      // ADR-0021 §2 is preserved verbatim by the flip: `allowClosed` is registration-time
      // only, and a rule that did not declare it cannot close a task on ANY event. The
      // record matters as much as the refusal: history is where an operator looks when a
      // rule "didn't work".
      const managed = seedSession('sess-1')
      await run(setStatus('done'))
      expect(managed.sessionStatus).toBe('todo')
      expect(outcomes()).toEqual(['rejected:closed-status:done'])
      expect(history()[0]!.ok).toBe(false)
    })

    it('refuses cancelled too, not just done', async () => {
      const managed = seedSession('sess-1')
      await run(setStatus('cancelled'))
      expect(managed.sessionStatus).toBe('todo')
      expect(outcomes()).toEqual(['rejected:closed-status:cancelled'])
    })

    it('records an unknown status id instead of writing it', async () => {
      const managed = seedSession('sess-1')
      await run(setStatus('not-a-status'))
      expect(managed.sessionStatus).toBe('todo')
      expect(outcomes()).toEqual(['rejected:invalid-status:not-a-status'])
    })

    it('carries the cause through, so the emitted event is not user-originated', async () => {
      // If the cause is dropped here the resulting SessionStatusChange looks like a human
      // did it, the chain resets to depth 0, and the depth cap stops bounding anything.
      const captured: Array<unknown> = []
      ;(sm as unknown as { automationSystems: Map<string, unknown> }).automationSystems.set(tmpRoot, {
        updateSessionMetadata: (_id: string, _next: unknown, cause: unknown) => {
          captured.push(cause)
          return Promise.resolve([])
        },
      })
      seedSession('sess-1')
      await run(setStatus('needs-review'))
      expect(captured).toEqual([{ matcherId: 'lifecycle-rule', depth: 1 }])
    })

    it('records the chain depth in history', async () => {
      seedSession('sess-1')
      await run(setStatus('needs-review', { cause: { matcherId: 'lifecycle-rule', depth: 2 } }))
      expect((history()[0]!.sessionAction as { depth?: number }).depth).toBe(2)
    })
  })

  describe('set-labels', () => {
    it('adds and removes against the session`s current labels', async () => {
      seedLabels('keep', 'drop', 'added')
      const managed = seedSession('sess-1', 'todo', ['keep', 'drop'])
      await run({
        matcherId: 'label-rule',
        type: 'set-labels',
        target: { id: 'sess-1' },
        add: ['added'],
        remove: ['drop'],
      })
      expect(managed.labels.sort()).toEqual(['added', 'keep'])
      expect(outcomes()).toEqual(['set-labels'])
    })

    it('drops labels that do not exist in the workspace', async () => {
      // Mirrors the desktop webhook executor. An automation must not be able to invent a
      // label id that no config knows about.
      const managed = seedSession('sess-1', 'todo', [])
      await run({
        matcherId: 'label-rule',
        type: 'set-labels',
        target: { id: 'sess-1' },
        add: ['definitely-not-a-configured-label'],
      })
      expect(managed.labels).toEqual([])
    })
  })

  describe('target resolution', () => {
    it('records deferred:target-not-found for an unknown session id', async () => {
      await run(setStatus('needs-review', { target: { id: 'ghost' } }))
      expect(outcomes()).toEqual(['deferred:target-not-found'])
      expect(history()[0]!.ok).toBe(false)
    })

    it('resolves a label selector to a session carrying that label', async () => {
      const managed = seedSession('sess-1', 'todo', ['on-call'])
      ;(sm as unknown as { getSessions(w: string): Array<{ id: string; labels: string[] }> }).getSessions =
        () => [{ id: 'sess-1', labels: ['on-call'] }]
      await run(setStatus('needs-review', { target: { label: 'on-call' } }))
      expect(managed.sessionStatus).toBe('needs-review')
    })
  })

  describe('refusal records (Phase 2a)', () => {
    async function runSkips(...skips: SessionActionSkip[]): Promise<void> {
      await (sm as unknown as {
        handleAutomationSessionActionsSkipped(r: string, s: SessionActionSkip[]): Promise<void>
      }).handleAutomationSessionActionsSkipped(tmpRoot, skips)
    }

    const skip = (extra: Partial<SessionActionSkip> = {}): SessionActionSkip => ({
      matcherId: 'lifecycle-rule',
      automationName: 'LabelAdd rule',
      event: 'LabelAdd',
      reason: 'self-trigger',
      detail: 'matcher "lifecycle-rule" would re-enter on an event its own action caused (depth 1)',
      sessionId: 'sess-1',
      actionTypes: ['set-status'],
      ...extra,
    })

    it('writes a skipped:<reason> record instead of only logging', async () => {
      // Phase 1 logged and returned. A refusal an operator cannot see in run history is
      // indistinguishable from a rule that simply never matched.
      await runSkips(skip())
      expect(outcomes()).toEqual(['skipped:self-trigger'])
      expect(history()[0]!.ok).toBe(false)
    })

    it('records every guard reason distinctly', async () => {
      await runSkips(
        skip({ reason: 'self-trigger' }),
        skip({ reason: 'depth-exceeded' }),
        skip({ reason: 'rate-limited' }),
        skip({ reason: 'unknown-action' }),
      )
      expect(outcomes()).toEqual([
        'skipped:self-trigger',
        'skipped:depth-exceeded',
        'skipped:rate-limited',
        'skipped:unknown-action',
      ])
    })

    it('matches the executed-action envelope, so one reader parses both', async () => {
      seedSession('sess-1')
      await run(setStatus('needs-review'))
      await runSkips(skip())
      const [executed, refused] = history()
      expect(Object.keys(refused!).sort()).toEqual(Object.keys(executed!).sort())
      expect(refused!.id).toBe('lifecycle-rule')
      expect(typeof refused!.ts).toBe('number')
    })

    it('carries the reason, the detail, and the target session', async () => {
      await runSkips(skip())
      const sa = history()[0]!.sessionAction as Record<string, unknown>
      expect(sa.reason).toBe('self-trigger')
      expect(sa.detail).toContain('re-enter')
      expect(sa.sessionId).toBe('sess-1')
      expect(sa.event).toBe('LabelAdd')
    })

    it('names the action types the refusal covers', async () => {
      await runSkips(skip({ actionTypes: ['set-status', 'set-labels'] }))
      expect((history()[0]!.sessionAction as { type: string }).type).toBe('set-status, set-labels')
    })

    it('carries no `kind`, so the run-history view cannot filter it out', async () => {
      // The Phase 0 defect, pinned. `useAutomations` drops every record carrying a `kind`
      // except the one it explicitly allows; a refusal must not depend on that allowance.
      await runSkips(skip())
      expect(history()[0]!.kind).toBeUndefined()
    })

    it('omits sessionId when the event had no session', async () => {
      await runSkips(skip({ sessionId: undefined }))
      expect((history()[0]!.sessionAction as Record<string, unknown>).sessionId).toBeUndefined()
    })
  })

  describe('failure isolation', () => {
    it('one failing action does not cost the others', async () => {
      // Same discipline as the handler's per-action isolation: a single bad rule must not
      // silently discard healthy work queued alongside it.
      const managed = seedSession('sess-1')
      await run(
        setStatus('needs-review', { target: { id: 'ghost' } }),
        setStatus('needs-review'),
      )
      expect(managed.sessionStatus).toBe('needs-review')
      expect(outcomes()).toEqual(['deferred:target-not-found', 'set-status:needs-review'])
    })
  })
})
