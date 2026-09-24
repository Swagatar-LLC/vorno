/**
 * fork(PLAN-055 / SUV-0071): SessionManager.observeContextThresholds.
 *
 * Drives token-usage samples through the watcher glue and asserts the
 * ContextThresholdReached emission contract: once per level per interactive
 * session, workspace thresholds honored, latch persisted to the session
 * header, and nothing for ineligible sessions or an unknown window.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession } from './SessionManager.ts'

type Emitted = { event: string; payload: Record<string, unknown> }

describe('SessionManager.observeContextThresholds', () => {
  let tmpRoot: string
  let sm: SessionManager
  let emitted: Emitted[]

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-ctx-threshold-'))
    sm = new SessionManager()
    emitted = []
    ;(sm as unknown as { automationSystems: Map<string, unknown> }).automationSystems.set(tmpRoot, {
      emit: async (event: string, payload: Record<string, unknown>) => {
        emitted.push({ event, payload })
      },
    })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  const workspace = () => ({ id: 'ws_ctx', name: 'Ctx Workspace', rootPath: tmpRoot, createdAt: Date.now() })

  function buildSession(id: string, extra: Record<string, unknown> = {}) {
    const managed = createManagedSession(
      { id, name: 'ctx test', model: 'test-model-ctx', ...extra } as never,
      workspace() as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function sample(managed: ReturnType<typeof buildSession>, inputTokens: number, contextWindow: number | undefined) {
    managed.tokenUsage = { inputTokens, outputTokens: 0, totalTokens: inputTokens, contextTokens: 0, costUsd: 0, contextWindow }
    sm.observeContextThresholds(managed)
  }

  function readHeader(sessionId: string): Record<string, unknown> | null {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8').split('\n')[0]!)
  }

  it('emits warn once, then danger once, and persists the latch', async () => {
    const managed = buildSession('ctx-basic')
    sample(managed, 50_000, 100_000)
    expect(emitted).toHaveLength(0)

    sample(managed, 65_000, 100_000)
    expect(emitted.map(e => e.payload.level)).toEqual(['warn'])
    expect(emitted[0]!.event).toBe('ContextThresholdReached')
    expect(emitted[0]!.payload).toMatchObject({
      sessionId: 'ctx-basic',
      workspaceId: 'ws_ctx',
      usedTokens: 65_000,
      contextWindow: 100_000,
      warnThreshold: 0.6,
      dangerThreshold: 0.8,
      model: 'test-model-ctx',
    })
    expect(emitted[0]!.payload.fraction).toBeCloseTo(0.65)

    sample(managed, 70_000, 100_000)
    expect(emitted).toHaveLength(1)

    sample(managed, 85_000, 100_000)
    expect(emitted.map(e => e.payload.level)).toEqual(['warn', 'danger'])

    sample(managed, 99_000, 100_000)
    expect(emitted).toHaveLength(2)

    await sm.flushSession('ctx-basic')
    const header = readHeader('ctx-basic')
    expect(header?.contextThresholdState).toMatchObject({ warnReachedAt: expect.any(Number), dangerReachedAt: expect.any(Number) })
  })

  it('does not re-emit for a session reloaded with a persisted latch', () => {
    const managed = buildSession('ctx-reloaded', { contextThresholdState: { warnReachedAt: 1 } })
    sample(managed, 65_000, 100_000)
    expect(emitted).toHaveLength(0)
    sample(managed, 85_000, 100_000)
    expect(emitted.map(e => e.payload.level)).toEqual(['danger'])
  })

  it('honors workspace per-model thresholds', () => {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({
      id: 'ws_ctx', name: 'Ctx Workspace', slug: 'ctx', createdAt: 1, updatedAt: 1,
      defaults: { tokenUsageModelOverrides: { 'test-model-ctx': { warn: 0.3, danger: 0.4 } } },
    }))
    const managed = buildSession('ctx-thresholds')
    sample(managed, 29_000, 100_000)
    expect(emitted).toHaveLength(0)
    sample(managed, 31_000, 100_000)
    expect(emitted.map(e => e.payload.level)).toEqual(['warn'])
    expect(emitted[0]!.payload).toMatchObject({ warnThreshold: 0.3, dangerThreshold: 0.4 })
  })

  it('emits nothing for hidden, Conductor, or automation-created sessions', () => {
    sample(buildSession('ctx-hidden', { hidden: true }), 95_000, 100_000)
    sample(buildSession('ctx-task', { taskSlug: 'nightly' }), 95_000, 100_000)
    sample(buildSession('ctx-auto', { triggeredBy: { automationName: 'rule', timestamp: 1 } }), 95_000, 100_000)
    expect(emitted).toHaveLength(0)
  })

  it('emits nothing when the context window cannot be resolved', () => {
    const managed = buildSession('ctx-unknown')
    sample(managed, 950_000, undefined)
    expect(emitted).toHaveLength(0)
    expect(managed.contextThresholdState).toBeUndefined()
  })
})
