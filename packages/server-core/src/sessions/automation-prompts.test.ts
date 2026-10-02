import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTOMATIONS_HISTORY_FILE } from '../../../shared/src/automations/constants.ts'
import { SessionManager } from './SessionManager.ts'

// Prompt actions of one automation event: a matcher's semanticCondition is judged once (its prompt
// actions all run or are all skipped), and prompts without a condition never wait for another check.
describe('automation prompt batches', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-automation-prompts-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  const pending = (matcherId: string, prompt: string, conditioned = false) => ({
    sessionId: undefined,
    matcherId,
    automationName: matcherId,
    prompt,
    ...(conditioned ? { semanticCondition: { question: 'Is the user reporting a bug?' }, event: 'LabelAdd', eventPayload: {} } : {}),
  })

  const history = async () => {
    // History writes are fire-and-forget; give them a moment to land.
    await new Promise(resolve => setTimeout(resolve, 20))
    const path = join(tmpRoot, AUTOMATIONS_HISTORY_FILE)
    return existsSync(path) ? readFileSync(path, 'utf-8').trim().split('\n').map(line => JSON.parse(line)) : []
  }

  it('judges a matcher once, so its prompt actions are all skipped together', async () => {
    let checks = 0
    ;(sm as any).shouldRunPromptAutomation = async () => { checks++; return { run: false, reason: 'condition not met' } }
    const started: string[] = []
    ;(sm as any).executePromptAutomation = async (opts: { prompt: string }) => { started.push(opts.prompt); return { sessionId: 's' } }

    await (sm as any).runReadyPrompts('ws', tmpRoot, [pending('m1', 'first', true), pending('m1', 'second', true)])

    expect(checks).toBe(1)
    expect(started).toEqual([])
    expect((await history()).map(entry => [entry.prompt, entry.skipped])).toEqual([
      ['first', 'condition not met'],
      ['second', 'condition not met'],
    ])
  })

  it('starts a prompt without a condition while another matcher is still being judged', async () => {
    let release!: () => void
    const judged = new Promise<void>(resolve => { release = resolve })
    ;(sm as any).shouldRunPromptAutomation = async (p: { semanticCondition?: unknown }) => {
      if (p.semanticCondition) await judged
      return { run: true }
    }
    const started: string[] = []
    ;(sm as any).executePromptAutomation = async (opts: { prompt: string }) => { started.push(opts.prompt); return { sessionId: `s-${opts.prompt}` } }

    const done = (sm as any).runReadyPrompts('ws', tmpRoot, [pending('slow', 'conditioned', true), pending('fast', 'plain')])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(started).toEqual(['plain'])
    release()
    await done
    expect(started).toEqual(['plain', 'conditioned'])
    expect((await history()).map(entry => entry.sessionId).sort()).toEqual(['s-conditioned', 's-plain'])
  })
})
