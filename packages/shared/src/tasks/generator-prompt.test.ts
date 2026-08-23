import { describe, expect, it } from 'bun:test'
import { buildGeneratorPrompt } from './generator-prompt'

describe('buildGeneratorPrompt model routing', () => {
  it('lists executable routes and requires every node to use one', () => {
    const prompt = buildGeneratorPrompt('Do the work', 'Routed task', [
      { model: 'claude-opus-5', llmConnection: 'claude-max' },
      { model: 'pi/gpt-5.4-mini', llmConnection: 'openai-api' },
    ])

    expect(prompt).toContain('Assign `model` and `llmConnection` on EVERY node')
    expect(prompt).toContain('model: claude-opus-5; llmConnection: claude-max')
    expect(prompt).toContain('model: pi/gpt-5.4-mini; llmConnection: openai-api')
    expect(prompt).toContain('model: executable model id')
  })

  it('does not require explicit routing when no catalog is supplied', () => {
    const prompt = buildGeneratorPrompt('Do the work')
    expect(prompt).not.toContain('Assign `model` and `llmConnection` on EVERY node')
  })
})
