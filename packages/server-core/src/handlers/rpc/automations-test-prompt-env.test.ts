/**
 * `automations:test` prompt env expansion — regression guard.
 *
 * The real dispatch path (PromptHandler) runs every prompt through
 * `expandEnvVars(prompt, buildEnvFromPayload(event, payload))`. The "Run test"
 * RPC did not, so it handed the model the raw text. A `WebhookReceived` router
 * prompt that says "read the file at $CRAFT_WEBHOOK_PAYLOAD_PATH" therefore
 * arrived with that literal in it, the model had no path to Read, its attempt
 * to resolve the variable through Bash was blocked by `safe` mode, and the run
 * ended with no report. Observed live on 2026-09-18 (session 260918-grand-flow).
 *
 * What this pins: the test path expands, and its history entry says it was a
 * test rather than masquerading as a real delivery.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RpcServer } from '../../transport/types'
import { registerAutomationsHandlers } from './automations'

const WORKSPACE_ID = 'ws_automations_test_env'
const ROOT = join(CONFIG_DIR, 'workspaces', 'automations-test-env')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
let originalConfig: string | null = null

/** Prompts delivered to `executePromptAutomation`, in call order. */
const delivered: string[] = []

function buildHarness(): (channel: string, ...args: unknown[]) => Promise<unknown> {
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle: (channel: string, fn: HandlerFn) => { handlers.set(channel, fn) },
  } as unknown as RpcServer

  const deps = {
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    sessionManager: {
      executePromptAutomation: async (input: { prompt: string }) => {
        delivered.push(input.prompt)
        return { sessionId: 'sess_test' }
      },
    },
  } as unknown as HandlerDeps

  registerAutomationsHandlers(server, deps)
  return async (channel: string, ...args: unknown[]) => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn({} as never, ...(args as never[]))
  }
}

function historyEntries(): Record<string, unknown>[] {
  const path = join(ROOT, 'automations-history.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(join(ROOT, 'config.json'), JSON.stringify({
    id: WORKSPACE_ID, name: WORKSPACE_ID, slug: WORKSPACE_ID, createdAt: 1, updatedAt: 1,
  }))
  originalConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null
  writeFileSync(CONFIG_FILE, JSON.stringify({
    workspaces: [{ id: WORKSPACE_ID, name: WORKSPACE_ID, rootPath: ROOT, createdAt: 1 }],
    activeWorkspaceId: WORKSPACE_ID,
    activeSessionId: null,
  }))
})

afterAll(() => {
  if (originalConfig === null) rmSync(CONFIG_FILE, { force: true })
  else writeFileSync(CONFIG_FILE, originalConfig)
  rmSync(ROOT, { recursive: true, force: true })
})

describe('automations:test — prompt env expansion', () => {
  test('a $CRAFT_* reference never reaches the model as a literal', async () => {
    delivered.length = 0
    const invoke = buildHarness()

    await invoke(RPC_CHANNELS.automations.TEST, {
      workspaceId: WORKSPACE_ID,
      automationId: 'auto1',
      actions: [{ type: 'prompt', prompt: 'Read the file at $CRAFT_WEBHOOK_PAYLOAD_PATH and classify it.' }],
    })

    expect(delivered).toHaveLength(1)
    // The exact defect: the model was told to dereference a name it cannot see.
    expect(delivered[0]).not.toContain('$CRAFT_WEBHOOK_PAYLOAD_PATH')
  })

  test('a variable the synthesized event DOES define expands to its value', async () => {
    delivered.length = 0
    const invoke = buildHarness()

    await invoke(RPC_CHANNELS.automations.TEST, {
      workspaceId: WORKSPACE_ID,
      actions: [{ type: 'prompt', prompt: 'workspace=$CRAFT_WORKSPACE_ID' }],
    })

    expect(delivered[0]).toBe(`workspace=${WORKSPACE_ID}`)
  })

  test('the history entry is marked as a test, not a real dispatch', async () => {
    const before = historyEntries().length
    const invoke = buildHarness()

    await invoke(RPC_CHANNELS.automations.TEST, {
      workspaceId: WORKSPACE_ID,
      automationId: 'auto2',
      actions: [{ type: 'prompt', prompt: 'hello' }],
    })

    const written = historyEntries().slice(before)
    expect(written).toHaveLength(1)
    expect(written[0].test).toBe(true)
    expect(written[0].sessionId).toBe('sess_test')
  })
})
