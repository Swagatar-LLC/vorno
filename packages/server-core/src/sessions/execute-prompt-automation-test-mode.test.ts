import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager } from './SessionManager.ts'

// Regression test for craft-agents-oss#943:
//
//   The automation "Test" action awaited executePromptAutomation → sendMessage
//   to *full* completion. A prompt that used tools or produced >30s of output
//   tripped the 30s RPC client timeout and reported failure even though the
//   session streamed fine.
//
// The fix adds `waitForCompletion` to ExecutePromptAutomationInput. The Test
// handler passes `false` so the method returns once the session is created and
// the prompt is dispatched (fire-and-forget, error-logged). Real automation
// execution omits the flag and keeps awaiting completion.
//
// These tests stub the heavy collaborators (createSession / sendEvent /
// sendMessage) and lock the branch: waitForCompletion:false resolves even when
// sendMessage never settles; the default still awaits (and propagates errors).

describe('executePromptAutomation waitForCompletion', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exec-prompt-automation-'))
    sm = new SessionManager()
    // Stub the collaborators executePromptAutomation touches. With no labels /
    // mentions / llmConnection in the input, everything else is skipped.
    ;(sm as unknown as { createSession: unknown }).createSession = async () => ({ id: 'test-sess' })
    ;(sm as unknown as { sendEvent: unknown }).sendEvent = () => {}
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('waitForCompletion:false returns as soon as the session is created (does not await the turn)', async () => {
    let sendCalled = false
    // Never-resolving send simulates a long tool-using turn.
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = () => {
      sendCalled = true
      return new Promise<never>(() => {})
    }

    const result = await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      prompt: 'do something long',
      waitForCompletion: false,
    })

    expect(result.sessionId).toBe('test-sess')
    expect(sendCalled).toBe(true)
  })

  it('default (waitForCompletion unset) awaits sendMessage and propagates its error', async () => {
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = () =>
      Promise.reject(new Error('send failed'))

    await expect(
      sm.executePromptAutomation({
        workspaceId: 'ws_test',
        workspaceRootPath: tmpRoot,
        prompt: 'do something',
      }),
    ).rejects.toThrow('send failed')
  })

  // fork(PLAN-017): outcome reconciliation — awaited runs count error-role
  // messages and return errorCount; test runs (waitForCompletion:false) don't.
  it('waitForCompletion:false returns no errorCount (test-run path)', async () => {
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = () => Promise.resolve()

    const result = await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      prompt: 'test',
      waitForCompletion: false,
    })
    expect(result.sessionId).toBe('test-sess')
    expect(result.errorCount).toBeUndefined()
  })

  it('awaited run returns errorCount = number of error-role messages in the session', async () => {
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = () => Promise.resolve()
    // Seed the managed-session map with a session whose turn produced 2 errors.
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions = new Map([
      ['test-sess', {
        id: 'test-sess',
        workspace: { rootPath: tmpRoot },
        messagesLoaded: true,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'error', content: 'invalid_api_key' },
          { role: 'assistant', content: 'partial' },
          { role: 'error', content: 'another' },
        ],
      }],
    ])

    const result = await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      prompt: 'do something',
    })
    expect(result.sessionId).toBe('test-sess')
    expect(result.errorCount).toBe(2)
  })

  // fork(PLAN-017) FIX 1: the error count must not be read while an auth retry
  // is pending/in-flight (attemptAuthRetry re-dispatches via a detached
  // setImmediate). waitForAutomationSessionSettled polls until the session is
  // quiet for two consecutive checks.
  describe('waitForAutomationSessionSettled', () => {
    type SettleFn = (sessionId: string, capMs?: number) => Promise<void>
    const settle = (mgr: SessionManager): SettleFn =>
      (sid, cap) => (mgr as unknown as { waitForAutomationSessionSettled: SettleFn }).waitForAutomationSessionSettled(sid, cap)

    it('resolves immediately when the session is gone', async () => {
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions = new Map()
      const start = Date.now()
      await settle(sm)('nope')
      expect(Date.now() - start).toBeLessThan(200)
    })

    it('waits while authRetryInProgress is set, resolves after it clears', async () => {
      const managed = { id: 's1', isProcessing: false, authRetryInProgress: true }
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions = new Map([['s1', managed]])

      let resolved = false
      const p = settle(sm)('s1').then(() => { resolved = true })

      // Still retrying after a few polls.
      await new Promise(r => setTimeout(r, 600))
      expect(resolved).toBe(false)

      // Retry finishes → two quiet polls later the helper resolves.
      managed.authRetryInProgress = false
      await p
      expect(resolved).toBe(true)
    })

    it('waits while isProcessing is set, resolves after it clears', async () => {
      const managed = { id: 's2', isProcessing: true, authRetryInProgress: false }
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions = new Map([['s2', managed]])

      let resolved = false
      const p = settle(sm)('s2').then(() => { resolved = true })

      await new Promise(r => setTimeout(r, 600))
      expect(resolved).toBe(false)

      managed.isProcessing = false
      await p
      expect(resolved).toBe(true)
    })

    it('a single quiet poll between busy states does not count as settled (double-check)', async () => {
      // quiet → busy → quiet-forever-later: the lone quiet sample must not
      // resolve the helper on its own (consecutive counter resets on the busy
      // poll) — simulates the microtask gap where attemptAuthRetry has cleared
      // authRetryInProgress but the retried sendMessage hasn't set isProcessing.
      const managed = { id: 's3', isProcessing: false, authRetryInProgress: false }
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions = new Map([['s3', managed]])

      let resolved = false
      const p = settle(sm)('s3').then(() => { resolved = true })

      // Before the second poll (~250ms), make the session busy.
      await new Promise(r => setTimeout(r, 50))
      managed.isProcessing = true
      await new Promise(r => setTimeout(r, 600))
      expect(resolved).toBe(false)

      managed.isProcessing = false
      await p
      expect(resolved).toBe(true)
    })

    it('gives up at the hard cap even if the session never settles', async () => {
      const managed = { id: 's4', isProcessing: true, authRetryInProgress: false }
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions = new Map([['s4', managed]])

      const start = Date.now()
      await settle(sm)('s4', 800) // short cap for the test
      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(700)
      expect(elapsed).toBeLessThan(3000)
    })
  })

  it('awaited clean run returns errorCount 0', async () => {
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = () => Promise.resolve()
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions = new Map([
      ['test-sess', {
        id: 'test-sess',
        workspace: { rootPath: tmpRoot },
        messagesLoaded: true,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'all good' },
        ],
      }],
    ])

    const result = await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      prompt: 'do something',
    })
    expect(result.errorCount).toBe(0)
  })
})
