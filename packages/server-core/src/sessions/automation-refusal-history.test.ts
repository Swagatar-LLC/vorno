/**
 * fork(PLAN-030) Phase 2a — refusals reach history through the wiring that actually runs.
 *
 * The sibling suite (`automation-session-actions.test.ts`) calls
 * `handleAutomationSessionActionsSkipped` directly, which proves the record's *shape* but
 * would pass just as happily if nothing ever called it. That is precisely how Phase 1's
 * rate gate shipped unreachable: a green unit test for a code path with no live caller.
 *
 * So this suite starts nowhere near the writer. It puts a real `automations.json` on disk,
 * calls `SessionManager.setupConfigWatcher` (the production path that constructs the
 * `AutomationSystem` and supplies `onSessionActionSkipped`), emits on the real
 * `WorkspaceEventBus`, and then reads the JSONL. Every seam between the guard and the file
 * is the shipping one — remove the callback wiring and these fail while the unit tests stay
 * green.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getSessionFilePath, writeSessionJsonl, type StoredSession } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const WORKSPACE_ID = 'ws_refusal'

/** The self-feeding shape ADR-0021 §3 exists for: set-status on SessionStatusChange. */
const SELF_FEEDING_CONFIG = {
  automations: {
    SessionStatusChange: [
      {
        id: 'auto-close-set-done',
        actions: [{ type: 'set-status', session: { id: 'sess-1' }, status: 'needs-review' }],
      },
    ],
  },
}

describe('automation refusals reach history through the live wiring', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-refusal-history-'))
    sm = new SessionManager()
  })

  afterEach(async () => {
    const systems = (sm as unknown as { automationSystems: Map<string, { dispose(): Promise<void> }> }).automationSystems
    for (const system of systems.values()) await system.dispose()
    systems.clear()
    const watchers = (sm as unknown as { configWatchers: Map<string, { stop(): void }> }).configWatchers
    for (const watcher of watchers.values()) watcher.stop()
    watchers.clear()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function seedSession(sessionId: string) {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'refusal test',
      sessionStatus: 'todo',
      labels: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
    } as unknown as StoredSession)
    const managed = createManagedSession(
      { id: sessionId, name: 'refusal test', sessionStatus: 'todo', labels: [], createdAt: Date.now() },
      { id: WORKSPACE_ID, name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() } as never
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
  }

  /** Write the config, then boot the workspace exactly as the app does. */
  function boot(config: unknown): { emit(payload: Record<string, unknown>): Promise<void> } {
    writeFileSync(join(tmpRoot, 'automations.json'), JSON.stringify(config), 'utf-8')
    sm.setupConfigWatcher(tmpRoot, WORKSPACE_ID)
    const system = (sm as unknown as {
      automationSystems: Map<string, { eventBus: { emit(e: string, p: unknown): Promise<void> } }>
    }).automationSystems.get(tmpRoot)
    if (!system) throw new Error('setupConfigWatcher did not create an AutomationSystem')
    return { emit: (payload) => system.eventBus.emit('SessionStatusChange', payload) }
  }

  function statusChange(newState: string, causedBy?: { matcherId: string; depth: number }) {
    return {
      sessionId: 'sess-1',
      workspaceId: WORKSPACE_ID,
      timestamp: Date.now(),
      labels: [],
      oldState: 'todo',
      newState,
      ...(causedBy ? { causedBy } : {}),
    }
  }

  /** The callback is fire-and-forget, so the write lands a tick or two after emit. */
  async function historyWhenWritten(): Promise<Array<Record<string, unknown>>> {
    const path = join(tmpRoot, 'automations-history.jsonl')
    for (let i = 0; i < 50; i++) {
      if (existsSync(path)) {
        const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean)
        if (lines.length > 0) return lines.map((l) => JSON.parse(l) as Record<string, unknown>)
      }
      await new Promise((r) => setTimeout(r, 10))
    }
    return []
  }

  function refusals(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return entries
      .map((e) => e.sessionAction as Record<string, unknown> | undefined)
      .filter((sa): sa is Record<string, unknown> => typeof sa?.outcome === 'string' && (sa.outcome as string).startsWith('skipped:'))
  }

  it('a self-triggering rule writes skipped:self-trigger to the JSONL', async () => {
    seedSession('sess-1')
    const { emit } = boot(SELF_FEEDING_CONFIG)

    // An event this very matcher caused — the shape the guard exists to refuse.
    await emit(statusChange('todo', { matcherId: 'auto-close-set-done', depth: 1 }))

    const found = refusals(await historyWhenWritten())
    expect(found).toHaveLength(1)
    expect(found[0]!.outcome).toBe('skipped:self-trigger')
    expect(found[0]!.reason).toBe('self-trigger')
    expect(found[0]!.sessionId).toBe('sess-1')
    expect(found[0]!.type).toBe('set-status')
  })

  it('the rate gate — the guard that shipped unreachable — also reaches history', async () => {
    seedSession('sess-1')
    const { emit } = boot(SELF_FEEDING_CONFIG)

    // Well past SESSION_ACTION_RATE_PER_MINUTE (5); the bus's own per-event-type limit is
    // 10/min, which is exactly why the matcher ceiling has to sit below it to be reachable.
    for (let i = 0; i < 9; i++) await emit(statusChange('todo'))

    const found = refusals(await historyWhenWritten())
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((f) => f.outcome === 'skipped:rate-limited')).toBe(true)
  })

  it('a refusal record carries no `kind`, so the run-history view keeps it', async () => {
    // The Phase 0 regression, pinned at the far end of the real pipeline: a record that
    // reaches disk and is then filtered out of the UI is not visibility.
    seedSession('sess-1')
    const { emit } = boot(SELF_FEEDING_CONFIG)
    await emit(statusChange('todo', { matcherId: 'auto-close-set-done', depth: 1 }))

    const entries = await historyWhenWritten()
    const refusal = entries.find((e) => (e.sessionAction as { outcome?: string })?.outcome?.startsWith('skipped:'))
    expect(refusal).toBeDefined()
    expect(refusal!.kind).toBeUndefined()
    expect(refusal!.ok).toBe(false)
  })

  it('an unrecognized action type is refused at dispatch while its siblings run', async () => {
    seedSession('sess-1')
    const { emit } = boot({
      automations: {
        SessionStatusChange: [
          {
            id: 'half-dead',
            actions: [
              { type: 'set-status', session: { id: 'sess-1' }, status: 'needs-review' },
              { type: 'setSessionStatus', session: { id: 'sess-1' }, status: 'done' },
            ],
          },
        ],
      },
    })

    await emit(statusChange('todo'))

    const entries = await historyWhenWritten()
    const outcomes = entries.map((e) => (e.sessionAction as { outcome?: string } | undefined)?.outcome)
    expect(outcomes).toContain('skipped:unknown-action')
    expect(outcomes).toContain('set-status:needs-review')
  })
})
