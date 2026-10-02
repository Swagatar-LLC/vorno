import { describe, expect, it } from 'bun:test';
import { AutomationMatcherSchema } from './schemas.ts';
import { createPromptHistoryEntry } from './webhook-utils.ts';

const base = { actions: [{ type: 'prompt', prompt: 'x' }] };

describe('semanticCondition schema', () => {
  it('accepts a question with an optional threshold', () => {
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: 'Is it a bug?' } }).success).toBe(true);
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: 'Is it a bug?', threshold: 0.8 } }).success).toBe(true);
  });

  it('rejects empty questions, thresholds outside (0, 1] and unknown keys', () => {
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: '  ' } }).success).toBe(false);
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: 'q', threshold: 0 } }).success).toBe(false);
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: 'q', threshold: 1.5 } }).success).toBe(false);
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: 'q', pattern: 'x' } }).success).toBe(false);
  });
});

describe('prompt history', () => {
  it('records a skipped run as skipped, not as an error', () => {
    const entry = createPromptHistoryEntry({ matcherId: 'abc123', ok: true, prompt: 'p', skipped: 'condition not met' });
    expect(entry).toMatchObject({ id: 'abc123', ok: true, skipped: 'condition not met' });
    expect(entry.error).toBeUndefined();
  });
});
