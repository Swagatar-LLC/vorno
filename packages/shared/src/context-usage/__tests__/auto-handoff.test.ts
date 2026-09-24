/**
 * fork(PLAN-055 / SUV-0072): the auto-handoff config helpers shared by the
 * settings card, the RPC validator, and the SessionManager consumer.
 */
import { describe, expect, it } from 'bun:test'
import {
  AUTO_HANDOFF_PROMPT_MAX_LENGTH,
  DEFAULT_AUTO_HANDOFF_PROMPT,
  autoHandoffHasFollowThrough,
  extractAutoHandoffSkillSlugs,
  normalizeAutoHandoffConfig,
  resolveAutoHandoffPrompt,
  validateAutoHandoffConfigShape,
} from '../auto-handoff.ts'

describe('normalizeAutoHandoffConfig', () => {
  it('returns null for non-objects and drops wrongly typed fields', () => {
    expect(normalizeAutoHandoffConfig(undefined)).toBeNull()
    expect(normalizeAutoHandoffConfig('yes')).toBeNull()
    expect(normalizeAutoHandoffConfig([])).toBeNull()
    expect(normalizeAutoHandoffConfig({ enabled: 'true', prompt: 3, status: '  ', archive: 1, extra: 1 })).toEqual({})
  })

  it('keeps well-typed fields and trims the status', () => {
    expect(normalizeAutoHandoffConfig({ enabled: true, prompt: 'go', status: ' done ', archive: false }))
      .toEqual({ enabled: true, prompt: 'go', status: 'done', archive: false })
  })
})

describe('validateAutoHandoffConfigShape', () => {
  it('accepts absent, empty, and well-typed values', () => {
    expect(validateAutoHandoffConfigShape(undefined)).toBeNull()
    expect(validateAutoHandoffConfigShape({})).toBeNull()
    expect(validateAutoHandoffConfigShape({ enabled: true, prompt: 'x', status: 'done', archive: true })).toBeNull()
  })

  it('names the offending field', () => {
    expect(validateAutoHandoffConfigShape('nope')).toBe('autoHandoff must be an object')
    expect(validateAutoHandoffConfigShape({ enabled: 'true' })).toBe('autoHandoff.enabled must be a boolean')
    expect(validateAutoHandoffConfigShape({ archive: 'no' })).toBe('autoHandoff.archive must be a boolean')
    expect(validateAutoHandoffConfigShape({ prompt: 1 })).toBe('autoHandoff.prompt must be a string')
    expect(validateAutoHandoffConfigShape({ status: 1 })).toBe('autoHandoff.status must be a status id string')
    expect(validateAutoHandoffConfigShape({ prompt: 'x'.repeat(AUTO_HANDOFF_PROMPT_MAX_LENGTH + 1) }))
      .toBe(`autoHandoff.prompt must be at most ${AUTO_HANDOFF_PROMPT_MAX_LENGTH} characters`)
  })
})

describe('resolveAutoHandoffPrompt / autoHandoffHasFollowThrough', () => {
  it('falls back to the default prompt when blank', () => {
    expect(resolveAutoHandoffPrompt(null)).toBe(DEFAULT_AUTO_HANDOFF_PROMPT)
    expect(resolveAutoHandoffPrompt({ prompt: '   ' })).toBe(DEFAULT_AUTO_HANDOFF_PROMPT)
    expect(resolveAutoHandoffPrompt({ prompt: ' hand off ' })).toBe('hand off')
    expect(DEFAULT_AUTO_HANDOFF_PROMPT).toContain('spawn_session')
  })

  it('reports follow-through only when a status or archive is configured', () => {
    expect(autoHandoffHasFollowThrough(null)).toBe(false)
    expect(autoHandoffHasFollowThrough({ enabled: true })).toBe(false)
    expect(autoHandoffHasFollowThrough({ status: 'done' })).toBe(true)
    expect(autoHandoffHasFollowThrough({ archive: true })).toBe(true)
    expect(autoHandoffHasFollowThrough({ status: '  ', archive: false })).toBe(false)
  })
})

describe('extractAutoHandoffSkillSlugs', () => {
  const available = ['handoff', 'summarize-thread', 'v2.skill']

  it('resolves both the composer and the automations mention forms', () => {
    expect(extractAutoHandoffSkillSlugs('Use [skill:handoff] then @summarize-thread.', available))
      .toEqual(['handoff', 'summarize-thread'])
  })

  it('ignores unknown slugs, emails, and duplicates', () => {
    expect(extractAutoHandoffSkillSlugs('@handoff @handoff [skill:nope] mail me@example.com @v2.skill', available))
      .toEqual(['handoff', 'v2.skill'])
  })

  it('returns nothing when the workspace has no skills', () => {
    expect(extractAutoHandoffSkillSlugs('@handoff [skill:handoff]', [])).toEqual([])
  })
})
