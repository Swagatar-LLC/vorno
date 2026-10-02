import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DECISIONS_LOG_PATH, defaultDecisionsLogPath, DecisionRecorder, buildDecisionRecord, hashDecisionIdentifier, sanitizeDecisionMeta, summarizeDecisionAnswers } from './records.ts';
import { DecisionError, type DecisionQuestion, type DecisionResult } from './types.ts';

const STATE_TEXT = 'The customer asked for a refund and mentioned their card number 4111 1111 1111 1111';

const QUESTIONS: Record<string, DecisionQuestion> = {
  route: { type: 'choice', instructions: 'Where?', criteria: { billing: null, returns: null } },
  angry: { type: 'noul', instructions: 'Angry?' },
};

const RESULT: DecisionResult = {
  model: 'jev-1.13.0',
  modelReported: true,
  requestedModel: 'jev-1.13.0',
  answers: {
    route: { type: 'choice', choice: 'billing', confidence: 0.8, probabilities: { billing: 0.9, returns: 0.1 } },
    angry: { type: 'noul', noul: 0.2 },
  },
  usage: { inputTokens: 100, outputTokens: 10 },
  latencyMs: 210,
  state: { sha256: 'abc', bytes: STATE_TEXT.length, truncated: false },
};

describe('decision records', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'craft-decisions-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes one JSON line per decision with digests, numbers and hashed keys — never the state', async () => {
    const recorder = new DecisionRecorder({ path: join(dir, 'decisions.jsonl') });
    await recorder.record({
      feature: 'decide_tool',
      provider: 'typesafe',
      model: 'jev-1.13.0',
      questions: QUESTIONS,
      result: RESULT,
      sessionId: 'sess-1',
      meta: { items: 3, apiKey: 'should-not-appear', authorization: 'Bearer x' },
    });

    const lines = readFileSync(recorder.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.ok).toBe(true);
    expect(record.feature).toBe('decide_tool');
    expect(record.provider).toBe('typesafe');
    expect(record.model).toBe('jev-1.13.0');
    expect(record.responseModel).toBe('jev-1.13.0');
    const h = hashDecisionIdentifier;
    expect(record.questions).toEqual({ [h('route')]: 'choice', [h('angry')]: 'noul' });
    expect(record.state).toEqual({ sha256: 'abc', bytes: STATE_TEXT.length, truncated: false });
    expect(record.answers[h('route')]).toEqual({ type: 'choice', choice: h('billing'), confidence: 0.8, probabilities: { [h('billing')]: 0.9, [h('returns')]: 0.1 } });
    expect(record.answers[h('angry')]).toEqual({ type: 'noul', noul: 0.2 });
    expect(record.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(record.sessionId).toBe('sess-1');
    // Sensitive-named and non-numeric meta never reaches the log
    expect(record.meta).toEqual({ items: 3 });
    expect(lines[0]).not.toContain('refund');
    expect(lines[0]).not.toContain('4111');
    expect(lines[0]).not.toContain('should-not-appear');
    expect(lines[0]).not.toContain('Bearer');
    for (const plaintext of ['route', 'angry', 'billing', 'returns']) expect(lines[0]).not.toContain(`"${plaintext}"`);
  });

  it('hashes secret-bearing question, choice and probability keys deterministically', () => {
    const SECRET_Q = 'is sk-live-QUESTION-0123 valid?';
    const SECRET_A = 'sk-live-OPTION-4567';
    const SECRET_B = 'acct 9999-8888';
    const questions: Record<string, DecisionQuestion> = {
      [SECRET_Q]: { type: 'choice', instructions: 'pick', criteria: { [SECRET_A]: null, [SECRET_B]: null } },
      sev: { type: 'score', instructions: 'rate', criteria: ['low', 'high'] },
    };
    const result: DecisionResult = {
      ...RESULT,
      answers: {
        [SECRET_Q]: { type: 'choice', choice: SECRET_A, confidence: 0.7, probabilities: { [SECRET_A]: 0.85, [SECRET_B]: 0.15 } },
        sev: { type: 'score', score: 0.4, confidence: 0.5, probabilities: { '0': 0.6, '1': 0.4 } },
      },
    };
    const first = buildDecisionRecord({ feature: 'decide_tool', provider: 'typesafe', model: 'm', questions, result });
    const second = buildDecisionRecord({ feature: 'decide_tool', provider: 'typesafe', model: 'm', questions, result });
    const text = JSON.stringify(first);
    for (const secret of ['sk-live', 'QUESTION-0123', 'OPTION-4567', '9999-8888']) expect(text).not.toContain(secret);
    // Deterministic: the same identifiers give the same ids
    expect(first.questions).toEqual(second.questions);
    expect(first.answers).toEqual(second.answers);
    const choice = first.answers![hashDecisionIdentifier(SECRET_Q)]!;
    expect(choice.choice).toBe(hashDecisionIdentifier(SECRET_A));
    expect(choice.choice).toMatch(/^h_[0-9a-f]{16}$/);
    // Operational numbers are preserved
    expect(choice.confidence).toBe(0.7);
    expect(Object.values(choice.probabilities!)).toEqual([0.85, 0.15]);
    // Score level indices are not free text and stay readable
    expect(first.answers![hashDecisionIdentifier('sev')]!.probabilities).toEqual({ '0': 0.6, '1': 0.4 });
    expect(first.usage).toEqual(RESULT.usage);
    expect(first.latencyMs).toBe(RESULT.latencyMs);
  });

  it('keeps only finite numbers and booleans under plain non-sensitive meta keys', () => {
    expect(sanitizeDecisionMeta({
      batch: true, index: 3, total: 9, threshold: 0.75,
      note: 'free text sk-live-meta', nested: { a: 1 }, list: [1], nan: Number.NaN, inf: Infinity,
      'sk-live-key-name': 1, apiKey: 5, token: 2, customerSecretAsAKey: 42,
    })).toEqual({ batch: true, index: 3, total: 9, threshold: 0.75 });
    const record = buildDecisionRecord({ feature: 'x', provider: 'custom', model: 'm', questions: QUESTIONS, result: RESULT, meta: { note: 'secret' } });
    expect(record.meta).toBeUndefined();
  });

  it('omits responseModel when the server did not name the model', () => {
    const record = buildDecisionRecord({ feature: 'x', provider: 'custom', model: 'm', questions: QUESTIONS, result: { ...RESULT, modelReported: false } });
    expect(record.responseModel).toBeUndefined();
    expect(record.model).toBe('m');
  });

  it('records failures without provider detail (a gateway may echo the state in its error body)', () => {
    const leaky = new DecisionError('invalid_request', 'Decision provider rejected the request (HTTP 422)', {
      status: 422,
      detail: `Invalid value for state: ${STATE_TEXT}`,
    });
    const leakyRecord = buildDecisionRecord({ feature: 'decide_tool', provider: 'openrouter', model: 'typesafe/jev-1.13', questions: QUESTIONS, error: leaky });
    expect(leakyRecord.error).toEqual({ kind: 'invalid_request', message: 'Decision request rejected', status: 422 });
    expect(JSON.stringify(leakyRecord)).not.toContain('refund');
    // ...while agents and users still get the detail
    expect(leaky.toFailure().message).toContain('Invalid value for state');
  });

  it('records failures with the failure kind and the state digest carried by the error', () => {
    const error = new DecisionError('timeout', 'Decision model did not answer within 1500 ms', {
      state: { sha256: 'def', bytes: 42, truncated: false },
    });
    const record = buildDecisionRecord({ feature: 'task_verdict', provider: 'openrouter', model: 'typesafe/jev-1.13', questions: QUESTIONS, error, latencyMs: 1500 });
    expect(record.ok).toBe(false);
    expect(record.error).toEqual({ kind: 'timeout', message: 'Decision call timed out' });
    expect(record.state).toEqual({ sha256: 'def', bytes: 42, truncated: false });
    expect(record.latencyMs).toBe(1500);
    expect(record.answers).toBeUndefined();

    const plain = buildDecisionRecord({ feature: 'x', provider: 'custom', model: 'm', questions: QUESTIONS, error: new Error('boom sk-live-raw') });
    expect(plain.error).toEqual({ kind: 'unavailable', message: 'Decision model unavailable' });
    expect(JSON.stringify(plain)).not.toContain('sk-live-raw');
    expect(plain.state).toBeNull();
  });

  it('records validation failures without the question or option keys their messages name', () => {
    const error = new DecisionError('invalid_request', "Question 'sk-live-KEY-1': option 'sk-live-OPT-2' description must be a string, an object or null");
    const record = buildDecisionRecord({ feature: 'decide_tool', provider: 'typesafe', model: 'm', questions: QUESTIONS, error });
    expect(record.error).toEqual({ kind: 'invalid_request', message: 'Decision request rejected' });
    expect(JSON.stringify(record)).not.toContain('sk-live');
  });

  it('rotates the log once it exceeds the size cap', async () => {
    const path = join(dir, 'decisions.jsonl');
    const recorder = new DecisionRecorder({ path, maxBytes: 200 });
    for (let i = 0; i < 3; i++) {
      await recorder.record({ feature: 'settings_test', provider: 'typesafe', model: 'jev-1.13.0', questions: QUESTIONS, result: RESULT });
    }
    expect(existsSync(join(dir, 'decisions.prev.jsonl'))).toBe(true);
    const current = readFileSync(path, 'utf8').trim().split('\n');
    expect(current.length).toBeGreaterThanOrEqual(1);
    expect(current.length).toBeLessThan(3);
  });

  it('never throws when the log cannot be written', async () => {
    const recorder = new DecisionRecorder({ path: join(dir, 'a-file-not-a-dir', 'x', 'decisions.jsonl') });
    // Make the parent a file so mkdir fails
    await Bun.write(join(dir, 'a-file-not-a-dir'), 'x');
    await expect(recorder.record({ feature: 'x', provider: 'typesafe', model: 'm', questions: QUESTIONS, result: RESULT })).resolves.toBeDefined();
  });

  it('summarizes score answers without the legend text', () => {
    const summary = summarizeDecisionAnswers({
      sev: { type: 'score', score: 1.2, confidence: 0.6, probabilities: { '0': 0.1, '1': 0.6, '2': 0.3 }, legend: { '0': 'Cosmetic' } },
    });
    expect(summary[hashDecisionIdentifier('sev')]).toEqual({ type: 'score', score: 1.2, confidence: 0.6, probabilities: { '0': 0.1, '1': 0.6, '2': 0.3 } });
    expect(JSON.stringify(summary)).not.toContain('Cosmetic');
  });

  it('writes outcome lines keyed to the decision id, hashing identifiers and dropping unknown detail', async () => {
    const recorder = new DecisionRecorder({ path: join(dir, 'decisions.jsonl') });
    const decision = await recorder.record({ feature: 'decide_tool', provider: 'typesafe', model: 'jev-1.13.0', questions: QUESTIONS, result: RESULT, sessionId: 'sess-1' });
    expect(decision.id).toMatch(/^[0-9a-f-]{36}$/);
    await recorder.recordOutcome(decision, { action: 'hint:source:gmail', changed: true, detail: { level: 2, token: 'secret' } });
    await recorder.recordOutcome({ feature: 'decide_tool' }, { action: 'ignored', changed: false }); // no id: nothing to join to

    const lines = readFileSync(recorder.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ kind: 'outcome', decisionId: decision.id, feature: 'decide_tool', sessionId: 'sess-1', action: `hint:${hashDecisionIdentifier('source:gmail')}`, changed: true, detail: { level: 2 } });
  });

  it('never persists free-form outcome or follow-up text under innocent keys', async () => {
    const recorder = new DecisionRecorder({ path: join(dir, 'private-outcomes.jsonl') });
    const decision = await recorder.record({ feature: 'decide_tool', provider: 'typesafe', model: 'jev-1.13.0', questions: QUESTIONS, result: RESULT });
    const secret = 'private-calendar-and-api-key';
    await recorder.recordOutcome(decision, { action: secret, changed: true, detail: { note: secret, confidence: 0.9, reason: secret } });
    await recorder.recordFollowUp(decision, { result: secret, detail: { option: secret, innocent: secret } });
    const text = readFileSync(recorder.path, 'utf8');
    expect(text).not.toContain(secret);
    expect(text).toContain(hashDecisionIdentifier(secret));
    expect(text).toContain('"confidence":0.9');
  });

  it('keeps test runs out of the real log', () => {
    expect(defaultDecisionsLogPath({ NODE_ENV: 'test' })).not.toBe(DEFAULT_DECISIONS_LOG_PATH);
    expect(defaultDecisionsLogPath({ NODE_ENV: 'test' }).startsWith(tmpdir())).toBe(true);
    expect(defaultDecisionsLogPath({ NODE_ENV: 'production' })).toBe(DEFAULT_DECISIONS_LOG_PATH);
  });
});
