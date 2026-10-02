import { describe, it, expect } from 'bun:test'
import { validateLabelsContent } from '../../config/validators.ts'

function labelsJson(autoRules: unknown[]): string {
  return JSON.stringify({ version: 1, labels: [{ id: 'billing', name: 'Billing', autoRules }] })
}

describe('labels/config.json accepts semantic auto-rules', () => {
  it('accepts a semantic rule next to a regex rule', () => {
    const result = validateLabelsContent(labelsJson([
      { pattern: 'invoice', valueTemplate: '$0' },
      { semantic: 'Is the user asking about billing?', threshold: 0.85 },
    ]))
    expect(result.valid).toBe(true)
  })

  it('rejects rules with neither pattern nor semantic, hybrids, and bad thresholds — with field-level messages', () => {
    const neither = validateLabelsContent(labelsJson([{ patern: 'typo' }]))
    expect(neither.valid).toBe(false)
    expect(neither.errors.some(e => e.message.includes('"pattern"') && e.message.includes('"semantic"'))).toBe(true)

    const hybrid = validateLabelsContent(labelsJson([{ pattern: 'x', semantic: 'Is it x?' }]))
    expect(hybrid.valid).toBe(false)
    expect(hybrid.errors.some(e => e.message.includes('not both'))).toBe(true)

    const badThreshold = validateLabelsContent(labelsJson([{ semantic: 'Is it urgent?', threshold: 2 }]))
    expect(badThreshold.valid).toBe(false)
    expect(badThreshold.errors.some(e => e.message.includes('at most 1'))).toBe(true)

    const badFlags = validateLabelsContent(labelsJson([{ pattern: 'x', flags: 5 }]))
    expect(badFlags.valid).toBe(false)
    expect(badFlags.errors.some(e => e.path.includes('flags'))).toBe(true)

    expect(validateLabelsContent(labelsJson([{ semantic: '' }])).valid).toBe(false)
    expect(validateLabelsContent(labelsJson([{ semantic: 'Is it x?', valueTemplate: '$1' }])).valid).toBe(false)
  })
})
