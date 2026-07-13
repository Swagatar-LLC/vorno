/**
 * Tests for webhook utility functions (expandWebhookAction, etc.)
 */

import { describe, it, expect } from 'bun:test';
import { expandWebhookAction, createOutcomeHistoryEntry, createMissedHistoryEntry } from './webhook-utils.ts';
import type { WebhookAction } from './types.ts';

const env = {
  CRAFT_WH_SESSION_ID: 'sess-123',
  CRAFT_WH_EVENT: 'LabelAdd',
  API_TOKEN: 'tok-secret',
};

describe('expandWebhookAction', () => {
  it('expands URL templates', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com/hook/${CRAFT_WH_SESSION_ID}',
    };
    const result = expandWebhookAction(action, env);
    expect(result.url).toBe('https://api.example.com/hook/sess-123');
  });

  it('expands header values', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      headers: { 'X-Event': '${CRAFT_WH_EVENT}', 'X-Static': 'unchanged' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.headers).toEqual({ 'X-Event': 'LabelAdd', 'X-Static': 'unchanged' });
  });

  it('expands string body', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      body: 'session=${CRAFT_WH_SESSION_ID}',
      bodyFormat: 'raw',
    };
    const result = expandWebhookAction(action, env);
    expect(result.body).toBe('session=sess-123');
  });

  it('expands object body (JSON)', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      body: { id: '${CRAFT_WH_SESSION_ID}', event: '${CRAFT_WH_EVENT}' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.body).toEqual({ id: 'sess-123', event: 'LabelAdd' });
  });

  it('expands basic auth credentials', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      auth: { type: 'basic', username: '${CRAFT_WH_SESSION_ID}', password: '${API_TOKEN}' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.auth).toEqual({ type: 'basic', username: 'sess-123', password: 'tok-secret' });
  });

  it('expands bearer auth token', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      auth: { type: 'bearer', token: '${API_TOKEN}' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.auth).toEqual({ type: 'bearer', token: 'tok-secret' });
  });

  it('passes through fields without templates unchanged', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com/static',
      method: 'PUT',
      bodyFormat: 'json',
      captureResponse: true,
    };
    const result = expandWebhookAction(action, env);
    expect(result.url).toBe('https://api.example.com/static');
    expect(result.method).toBe('PUT');
    expect(result.bodyFormat).toBe('json');
    expect(result.captureResponse).toBe(true);
  });
});

// fork(PLAN-017)
describe('createOutcomeHistoryEntry', () => {
  it('produces a kind:outcome record with ok=true when errorCount is 0', () => {
    const entry = createOutcomeHistoryEntry({ matcherId: 'abc123', ok: true, sessionId: 's1', errorCount: 0 });
    expect(entry.id).toBe('abc123');
    expect(entry.kind).toBe('outcome');
    expect(entry.ok).toBe(true);
    expect(entry.errorCount).toBe(0);
    expect(entry.sessionId).toBe('s1');
    expect(typeof entry.ts).toBe('number');
  });

  it('produces ok=false with errorCount>0', () => {
    const entry = createOutcomeHistoryEntry({ matcherId: 'abc123', ok: false, sessionId: 's2', errorCount: 3 });
    expect(entry.kind).toBe('outcome');
    expect(entry.ok).toBe(false);
    expect(entry.errorCount).toBe(3);
  });

  it('omits sessionId when not provided', () => {
    const entry = createOutcomeHistoryEntry({ matcherId: 'abc123', ok: true, errorCount: 0 });
    expect('sessionId' in entry).toBe(false);
  });
});

describe('createMissedHistoryEntry', () => {
  it('produces a kind:missed record that is always not-ok', () => {
    const entry = createMissedHistoryEntry({ matcherId: 'def456', expectedTs: 1_700_000_000_000 });
    expect(entry.id).toBe('def456');
    expect(entry.kind).toBe('missed');
    expect(entry.ok).toBe(false);
    expect(entry.expectedTs).toBe(1_700_000_000_000);
    expect(typeof entry.ts).toBe('number');
  });
});
