import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
      // Mirror the real manager: a created session is registered carrying both its slug
      // and its workspace — together those are what make a second pass a no-op.
      const session = { id: `orch-${++n}`, workspace: { id: workspaceId }, ...options }
      created.push({ workspaceId, taskSlug: options.taskSlug, id: session.id })
      ;(sm as any).sessions.set(session.id, session)
      return session
    }
    ;(sm as any).applyTaskLabel = async () => ({ labelId: 'task::1' })
    ;(sm as any).setSessionSources = async () => {}
    const run = (workspaceId = 'ws-1', at = root) =>
      (sm as any).reconcilePublishedTasks(workspaceId, at) as Promise<void>
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
    ;(sm as any).sessions.set('existing', {
      id: 'existing',
      taskSlug: 'already-bound',
      workspace: { id: 'ws-1' },
    })

    await run()

    expect(created).toHaveLength(0)
  })

  // `this.sessions` spans every loaded workspace, but a slug is only unique per workspace
  // root — so an unscoped bound set would let one workspace's card suppress another's forever.
  it("does not let one workspace's bound slug suppress the same slug in another", async () => {
    const other = mkdtempSync(join(tmpdir(), 'reconcile-tasks-other-'))
    try {
      saveTaskSpec(other, spec('shared-slug'))
      const { sm, created, run } = harness()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(sm as any).sessions.set('ws1-session', {
        id: 'ws1-session',
        taskSlug: 'shared-slug',
        workspace: { id: 'ws-1' },
      })

      await run('ws-2', other)

      expect(created).toHaveLength(1)
      expect(created[0]!.workspaceId).toBe('ws-2')
      expect(created[0]!.taskSlug).toBe('shared-slug')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  // Dedupe keys on the directory but createTaskFromSpec binds `spec.id`. If an external
  // producer breaks the dir-is-the-slug invariant, adopting would mint a fresh duplicate
  // on every restart, each bound to an id that resolves to no directory.
  it('skips a definition whose id does not match its directory, on every pass', async () => {
    saveTaskSpec(root, spec('real-id'))
    renameSync(join(root, 'tasks', 'real-id'), join(root, 'tasks', 'wrong-dir'))
    const { created, run } = harness()

    await run()
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
