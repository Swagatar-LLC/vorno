import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager } from './SessionManager.ts'
import type { PendingPrompt } from '@craft-agent/shared/automations'

// fork(PLAN-017): outcome-record + onFailure wiring in the onPromptsReady path.
//
// These tests drive `handleAutomationPromptsReady` directly (the extracted body
// of the AutomationSystem onPromptsReady callback) with a stubbed
// executePromptAutomation, and assert on what lands in automations-history.jsonl.

const HISTORY_FILE = 'automations-history.jsonl'

function readHistory(dir: string): Array<Record<string, unknown>> {
  const path = join(dir, HISTORY_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

/** Invoke the private handler. */
function handle(sm: SessionManager, wsRoot: string, prompts: PendingPrompt[]): Promise<void> {
  return (sm as unknown as {
    handleAutomationPromptsReady: (wid: string, root: string, p: PendingPrompt[]) => Promise<void>
  }).handleAutomationPromptsReady('ws_test', wsRoot, prompts)
}

function basePending(overrides: Partial<PendingPrompt>): PendingPrompt {
  return {
    sessionId: undefined,
    matcherId: 'm1',
    prompt: 'do the thing',
    mentions: [],
    ...overrides,
  }
}

describe('automation outcome records', () => {
  let wsRoot: string
  let sm: SessionManager

  beforeEach(() => {
    wsRoot = mkdtempSync(join(tmpdir(), 'automation-outcome-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(wsRoot, { recursive: true, force: true })
  })

  it('writes an outcome record (ok:false, errorCount>0) right after the dispatch record', async () => {
    ;(sm as unknown as { executePromptAutomation: unknown }).executePromptAutomation = async () =>
      ({ sessionId: 'sess-1', errorCount: 2 })

    await handle(sm, wsRoot, [basePending({ matcherId: 'm1' })])

    const entries = readHistory(wsRoot)
    expect(entries).toHaveLength(2)
    // Order: dispatch → outcome.
    expect(entries[0]!.kind).toBeUndefined()
    expect(entries[0]!.ok).toBe(true) // dispatch succeeded (session created)
    expect(entries[0]!.sessionId).toBe('sess-1')
    expect(entries[1]!.kind).toBe('outcome')
    expect(entries[1]!.ok).toBe(false)
    expect(entries[1]!.errorCount).toBe(2)
    expect(entries[1]!.sessionId).toBe('sess-1')
  })

  it('writes an outcome record (ok:true, errorCount:0) for a clean run', async () => {
    ;(sm as unknown as { executePromptAutomation: unknown }).executePromptAutomation = async () =>
      ({ sessionId: 'sess-2', errorCount: 0 })

    await handle(sm, wsRoot, [basePending({ matcherId: 'm1' })])

    const entries = readHistory(wsRoot)
    expect(entries).toHaveLength(2)
    expect(entries[1]!.kind).toBe('outcome')
    expect(entries[1]!.ok).toBe(true)
    expect(entries[1]!.errorCount).toBe(0)
  })

  it('writes NO outcome record when errorCount is undefined (waitForCompletion:false path)', async () => {
    ;(sm as unknown as { executePromptAutomation: unknown }).executePromptAutomation = async () =>
      ({ sessionId: 'sess-3' }) // no errorCount

    await handle(sm, wsRoot, [basePending({ matcherId: 'm1' })])

    const entries = readHistory(wsRoot)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBeUndefined()
    expect(entries.some(e => e.kind === 'outcome')).toBe(false)
  })

  it('writes NO history at all for a matcher-less (onFailure/test) pending prompt', async () => {
    ;(sm as unknown as { executePromptAutomation: unknown }).executePromptAutomation = async () =>
      ({ sessionId: 'sess-4', errorCount: 5 })

    await handle(sm, wsRoot, [basePending({ matcherId: undefined })])

    expect(readHistory(wsRoot)).toHaveLength(0)
  })

  it('a dispatch failure writes a not-ok dispatch record and no outcome record', async () => {
    ;(sm as unknown as { executePromptAutomation: unknown }).executePromptAutomation = async () => {
      throw new Error('createSession blew up')
    }

    await handle(sm, wsRoot, [basePending({ matcherId: 'm1' })])

    const entries = readHistory(wsRoot)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBeUndefined()
    expect(entries[0]!.ok).toBe(false)
    expect(String(entries[0]!.error)).toContain('createSession blew up')
  })
})

describe('automation onFailure execution', () => {
  let wsRoot: string
  let sm: SessionManager

  beforeEach(() => {
    wsRoot = mkdtempSync(join(tmpdir(), 'automation-onfailure-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(wsRoot, { recursive: true, force: true })
  })

  it('runs an onFailure prompt WITHOUT a matcherId (no recursion, no extra history)', async () => {
    const calls: Array<{ matcherId?: string; automationName?: string; waitForCompletion?: boolean; prompt: string }> = []
    ;(sm as unknown as { executePromptAutomation: unknown }).executePromptAutomation = async (input: {
      prompt: string; automationName?: string; waitForCompletion?: boolean
    }) => {
      calls.push({ prompt: input.prompt, automationName: input.automationName, waitForCompletion: input.waitForCompletion })
      // First (main) call fails its turn; onFailure call succeeds.
      if (input.prompt === 'main') return { sessionId: 'main-sess', errorCount: 1 }
      return { sessionId: 'onfail-sess', errorCount: 0 }
    }

    await handle(sm, wsRoot, [
      basePending({
        matcherId: 'm1',
        prompt: 'main',
        automationName: 'My Automation',
        onFailure: [{ type: 'prompt', prompt: 'the run failed, investigate' }],
      }),
    ])

    // Let the fire-and-forget onFailure prompt run.
    await new Promise(r => setTimeout(r, 100))

    // The onFailure prompt executed exactly once.
    const onFailCalls = calls.filter(c => c.prompt === 'the run failed, investigate')
    expect(onFailCalls).toHaveLength(1)
    // It ran without matcher-derived history (waitForCompletion:false, name suffixed).
    expect(onFailCalls[0]!.waitForCompletion).toBe(false)
    expect(onFailCalls[0]!.automationName).toContain('onFailure')

    // History: exactly the main dispatch + main outcome. No records for the
    // onFailure run (it carried no matcherId) — the recursion guard held.
    const entries = readHistory(wsRoot)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.kind).toBeUndefined()
    expect(entries[1]!.kind).toBe('outcome')
    expect(entries[1]!.ok).toBe(false)
  })
})
