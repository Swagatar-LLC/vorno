/**
 * Pages script executor: builds a ScriptAction from the grant invocation,
 * injects CRAFT_* env, never sets `page` (so it can't clobber the refresh
 * marker), returns process outcome on run, and throws on a blocked run.
 * The runner itself is injected — spawn behavior is covered by the automations
 * script-executor tests.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPagesScriptExecutor } from '../script-executor-bridge'
import type { ScriptAction, ScriptActionResult } from '@craft-agent/shared/automations'
import type { Logger } from '@craft-agent/server-core/runtime'

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger
const signal = new AbortController().signal

function makeExecutor(result: Partial<ScriptActionResult>) {
  const seen: Array<{ action: ScriptAction; ctx: { workspaceRootPath: string; env: Record<string, string> } }> = []
  const executor = createPagesScriptExecutor({
    workspaceRootPath: '/tmp/ws',
    log,
    runScript: async (action, ctx) => {
      seen.push({ action, ctx })
      return {
        type: 'script',
        script: action.script,
        success: (result.exitCode ?? 0) === 0,
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        ...result,
      }
    },
  })
  return { executor, seen }
}

describe('createPagesScriptExecutor', () => {
  test('runs the pinned script and returns exit/stdout/stderr', async () => {
    const { executor, seen } = makeExecutor({ exitCode: 0, stdout: 'done', stderr: '' })
    const out = await executor(
      { pageSlug: 'dash', script: 'pages/dash/run.sh', runtime: 'bun', args: ['--once'] },
      { signal },
    )
    expect(out).toEqual({ exitCode: 0, stdout: 'done', stderr: '' })
    expect(seen[0].action).toEqual({ type: 'script', script: 'pages/dash/run.sh', runtime: 'bun', args: ['--once'] })
  })

  test('never sets ScriptAction.page (must not clobber the refresh marker)', async () => {
    const { executor, seen } = makeExecutor({ exitCode: 0 })
    await executor({ pageSlug: 'dash', script: 'pages/dash/run.sh' }, { signal })
    expect(seen[0].action.page).toBeUndefined()
  })

  test('injects CRAFT_ workspace + page env for the triggering page', async () => {
    const { executor, seen } = makeExecutor({ exitCode: 0 })
    await executor({ pageSlug: 'dash', script: 'pages/dash/run.sh' }, { signal })
    const env = seen[0].ctx.env
    expect(env.CRAFT_WORKSPACE_PATH).toBe('/tmp/ws')
    expect(env.CRAFT_PAGE_SLUG).toBe('dash')
    expect(env.CRAFT_PAGE_DIR).toBe('/tmp/ws/pages/dash')
    expect(env.CRAFT_PAGE_DATA_DIR).toBe('/tmp/ws/pages/dash/data')
    // never leaks non-CRAFT secrets
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('omits runtime/args when not pinned', async () => {
    const { executor, seen } = makeExecutor({ exitCode: 0 })
    await executor({ pageSlug: 'dash', script: 'pages/dash/run.ts' }, { signal })
    expect(seen[0].action).toEqual({ type: 'script', script: 'pages/dash/run.ts' })
  })

  test('surfaces a non-zero exit as a resolved outcome (not a throw)', async () => {
    const { executor } = makeExecutor({ exitCode: 3, stdout: '', stderr: 'nope' })
    const out = await executor({ pageSlug: 'dash', script: 'pages/dash/run.sh' }, { signal })
    expect(out).toEqual({ exitCode: 3, stdout: '', stderr: 'nope' })
  })

  test('throws when the run is blocked (path escape / missing runtime)', async () => {
    const { executor } = makeExecutor({ blocked: true, exitCode: null, stderr: 'Script path escapes the workspace' })
    await expect(
      executor({ pageSlug: 'dash', script: '../evil.sh' }, { signal }),
    ).rejects.toThrow(/escapes the workspace/)
  })
})

/**
 * The same executor against the REAL runner, with no `runScript` seam.
 *
 * Every test above injects the runner, which proves the bridge builds the right
 * ScriptAction and proves nothing about what actually happens when a Page runs
 * a script. These four properties are the ones a grant is trusted on — argv and
 * not a shell, confined to the workspace, a minimal environment, and killable —
 * and a seam cannot demonstrate any of them. SUV-0065 requires this to be
 * checked directly, so it is.
 */
describe('createPagesScriptExecutor — direct runner', () => {
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'pages-script-runner-'))
    mkdirSync(join(workspaceDir, 'pages', 'dash'), { recursive: true })
  })

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  const direct = () => createPagesScriptExecutor({ workspaceRootPath: workspaceDir, log })

  test('spawns argv with no shell, so metacharacters are inert data', async () => {
    // A shell would expand `$(…)` and act on `;` and `&&`. Passed as argv they
    // are just strings, which is why a pinned arg list is safe to approve once.
    writeFileSync(
      join(workspaceDir, 'pages', 'dash', 'echo.ts'),
      'console.log(JSON.stringify(process.argv.slice(2)))',
    )
    const hostile = ['$(touch /tmp/pwned)', '; rm -rf /', '&& whoami', '`id`']
    const out = await direct()(
      { pageSlug: 'dash', script: 'pages/dash/echo.ts', runtime: 'bun', args: hostile },
      { signal: new AbortController().signal },
    )
    expect(out.exitCode).toBe(0)
    expect(JSON.parse(out.stdout)).toEqual(hostile)
  })

  test('refuses to run anything outside the workspace', async () => {
    const outside = join(tmpdir(), `pages-outside-${Date.now()}.ts`)
    writeFileSync(outside, 'console.log("should never run")')
    try {
      for (const script of ['../escape.ts', outside]) {
        await expect(
          direct()({ pageSlug: 'dash', script }, { signal: new AbortController().signal }),
        ).rejects.toThrow()
      }
    } finally {
      rmSync(outside, { force: true })
    }
  })

  test('hands the script a minimal CRAFT-only environment', async () => {
    writeFileSync(
      join(workspaceDir, 'pages', 'dash', 'env.ts'),
      'console.log(JSON.stringify(Object.keys(process.env)))',
    )
    process.env.PAGES_RUNNER_CANARY = 'must-not-leak'
    try {
      const out = await direct()(
        { pageSlug: 'dash', script: 'pages/dash/env.ts', runtime: 'bun' },
        { signal: new AbortController().signal },
      )
      const keys = JSON.parse(out.stdout) as string[]
      expect(keys).toContain('CRAFT_PAGE_SLUG')
      // The host's own environment is where API keys and tokens live. A page
      // script gets the workspace's CRAFT_* facts and not the host's secrets.
      expect(keys).not.toContain('PAGES_RUNNER_CANARY')
      expect(keys.filter((k) => k === 'ANTHROPIC_API_KEY')).toHaveLength(0)
    } finally {
      delete process.env.PAGES_RUNNER_CANARY
    }
  })

  test('dies when the broker aborts it', async () => {
    // The broker's timeout and its cancellation both arrive as this signal, so
    // a script that ignores it would hold a slot for as long as it liked.
    writeFileSync(
      join(workspaceDir, 'pages', 'dash', 'sleep.ts'),
      'setTimeout(() => {}, 60_000)',
    )
    const controller = new AbortController()
    const running = direct()(
      { pageSlug: 'dash', script: 'pages/dash/sleep.ts', runtime: 'bun' },
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 50)
    const out = await running
    expect(out.exitCode).not.toBe(0)
  }, 15_000)
})
