import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveTaskSpec, type TaskSpec } from '@craft-agent/shared/tasks'
import { SessionManager } from './SessionManager.ts'

// A board card IS a parentless session; `tasks/<slug>/task.yaml` is only a definition.
// Publishing writes the yaml but does not mint the orchestrator, so a definition written by a
// producer outside the app renders nowhere. reconcilePublishedTasks closes that from the app
// side (SUV-0034). These pin adoption, idempotency, and fail-soft handling of a bad definition.
describe('reconcilePublishedTasks', () => {
  let root: string

  const spec = (id: string): TaskSpec =>
    ({
      id,
      title: `Task ${id}`,
      goal: 'do the thing',
      runner: 'conduct',
      nodes: [{ id: 'only', title: 'Only node', prompt: 'go', kind: 'session' }],
    }) as TaskSpec

  /** Bare manager with the createTaskFromSpec collaborators stubbed; records created sessions. */
  function harness() {
    const sm = new SessionManager()
    const created: { workspaceId: string; taskSlug?: string; id: string }[] = []
    let n = 0
    /* eslint-disable @typescript-eslint/no-explicit-any */
    ;(sm as any).createSession = async (workspaceId: string, options: any) => {
      const session = { id: `orch-${++n}`, ...options }
      created.push({ workspaceId, taskSlug: options.taskSlug, id: session.id })
      // Mirror the real manager: a created session is registered and carries its slug,
      // which is what makes a second reconcile pass a no-op.
      ;(sm as any).sessions.set(session.id, session)
      return session
    }
    ;(sm as any).applyTaskLabel = async () => ({ labelId: 'task::1' })
    ;(sm as any).setSessionSources = async () => {}
    const run = () => (sm as any).reconcilePublishedTasks('ws-1', root) as Promise<void>
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return { sm, created, run }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'reconcile-tasks-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('adopts a published definition that has no bound session', async () => {
    saveTaskSpec(root, spec('published-alpha'))
    const { created, run } = harness()

    await run()

    expect(created).toHaveLength(1)
    expect(created[0]!.taskSlug).toBe('published-alpha')
    expect(created[0]!.workspaceId).toBe('ws-1')
  })

  it('skips a slug that already has a bound session', async () => {
    saveTaskSpec(root, spec('already-bound'))
    const { sm, created, run } = harness()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sm as any).sessions.set('existing', { id: 'existing', taskSlug: 'already-bound' })

    await run()

    expect(created).toHaveLength(0)
  })

  it('is idempotent across consecutive passes', async () => {
    saveTaskSpec(root, spec('published-beta'))
    const { created, run } = harness()

    await run()
    await run()

    expect(created).toHaveLength(1)
  })

  it('skips a malformed definition without blocking its valid siblings', async () => {
    saveTaskSpec(root, spec('valid-one'))
    mkdirSync(join(root, 'tasks', 'broken-one'), { recursive: true })
    writeFileSync(join(root, 'tasks', 'broken-one', 'task.yaml'), 'nodes: [oops\n  not: yaml', 'utf-8')
    const { created, run } = harness()

    // Fail-soft: one bad definition may not throw out of workspace load.
    await run()

    expect(created.map(c => c.taskSlug)).toEqual(['valid-one'])
  })

  it('does nothing when the workspace has no tasks directory', async () => {
    const { created, run } = harness()

    await run()

    expect(created).toHaveLength(0)
  })
})
