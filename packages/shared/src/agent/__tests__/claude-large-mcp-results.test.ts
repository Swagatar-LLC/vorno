import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAgent } from '../claude-agent.ts'

// Large MCP results used to be guarded only in the app's copy of the event, after the model had
// already read the full result; the PostToolUse hook now replaces them before the model sees them.
describe('ClaudeAgent large MCP tool results', () => {
  let root: string
  let summaries: string[]

  function agent() {
    const instance = Object.create(ClaudeAgent.prototype) as any
    instance.config = { session: { id: 'session-1' }, workspace: { rootPath: root } }
    instance.usageTracker = { getContextWindow: () => 200_000 }
    instance.getSummarizeCallback = () => async (prompt: string) => {
      summaries.push(prompt)
      return 'THE SUMMARY'
    }
    return instance
  }

  const postToolUse = (tool_name: string, tool_response: unknown) => ({
    hook_event_name: 'PostToolUse',
    tool_name,
    tool_input: { query: 'open issues', _intent: 'List the open issues' },
    tool_response,
    tool_use_id: 'toolu_1',
  })
  const big = `FIRST LINE\n${'issue #1234 [bug] something is broken in a long way\n'.repeat(4_000)}`

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-large-mcp-'))
    summaries = []
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('replaces a large MCP result with the saved-file summary, keeping the block shape', async () => {
    const image = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
    const output = await agent().guardLargeMcpToolOutput(postToolUse('mcp__github__list_issues', [{ type: 'text', text: big }, image]))

    expect(output.continue).toBe(true)
    const updated = output.hookSpecificOutput?.updatedToolOutput as Array<{ type: string; text?: string }>
    expect(output.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    expect(Array.isArray(updated)).toBe(true)
    expect(updated[0]!.type).toBe('text')
    expect(updated[0]!.text).toContain('THE SUMMARY')
    expect(updated[0]!.text!.length).toBeLessThan(big.length / 10)
    expect(updated[1]).toEqual(image)
    expect(summaries[0]).toContain('List the open issues')
  })

  it('keeps a string result a string', async () => {
    const output = await agent().guardLargeMcpToolOutput(postToolUse('mcp__craft-kb__read_doc', big))
    expect(typeof output.hookSpecificOutput?.updatedToolOutput).toBe('string')
  })

  it('leaves small results (even with embedded media) and non-MCP tools alone', async () => {
    expect(await agent().guardLargeMcpToolOutput(postToolUse('mcp__github__list_issues', [{ type: 'text', text: 'two issues' }]))).toEqual({ continue: true })
    const smallJsonWithImage = JSON.stringify({ title: 'Logo', image: `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='.repeat(8)}` })
    expect(await agent().guardLargeMcpToolOutput(postToolUse('mcp__craft-kb__get_block', [{ type: 'text', text: smallJsonWithImage }]))).toEqual({ continue: true })
    expect(await agent().guardLargeMcpToolOutput(postToolUse('Bash', big))).toEqual({ continue: true })
    expect(summaries).toEqual([])
  })
})
