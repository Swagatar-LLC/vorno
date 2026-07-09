/**
 * Desktop webhook executors (PLAN-014) — the embedded-host EXECUTE seam.
 *
 * Verifies the desktop parity contract: prompt → executePromptAutomation (live
 * session), set-status/set-labels/send-message → the corresponding live
 * SessionManager mutations (UI-reflecting), plus target resolution and the
 * closed-status guard. A lightweight fake SessionManager records calls; the
 * status/label validators read a temp workspace's DEFAULT config (no fixtures).
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopWebhookExecutors, type WebhookSessionManager } from '../webhook-executors';
import type { ResolvedWorkspace, PendingPrompt, PendingSessionAction } from '@craft-agent/shared/automations';

type Call = { fn: string; args: unknown[] };

function makeFakeSM(overrides: Partial<WebhookSessionManager> = {}): {
  sm: WebhookSessionManager;
  calls: Call[];
  sessions: Map<string, { id: string; labels?: string[] }>;
} {
  const calls: Call[] = [];
  const sessions = new Map<string, { id: string; labels?: string[] }>();
  const sm: WebhookSessionManager = {
    async executePromptAutomation(input) {
      calls.push({ fn: 'executePromptAutomation', args: [input] });
      return { sessionId: 'sess-new' };
    },
    async getSession(id) {
      calls.push({ fn: 'getSession', args: [id] });
      const s = sessions.get(id);
      return (s ? { ...s } : null) as never;
    },
    getSessions() {
      calls.push({ fn: 'getSessions', args: [] });
      return [...sessions.values()] as never;
    },
    async setSessionStatus(id, status) {
      calls.push({ fn: 'setSessionStatus', args: [id, status] });
    },
    setSessionLabels(id, labels) {
      calls.push({ fn: 'setSessionLabels', args: [id, labels] });
    },
    async sendMessage(id, message) {
      calls.push({ fn: 'sendMessage', args: [id, message] });
    },
    ...overrides,
  };
  return { sm, calls, sessions };
}

let ws: ResolvedWorkspace;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'wh-exec-'));
  ws = { workspaceId: 'ws1', rootPath: root };
});

function prompt(over: Partial<PendingPrompt> = {}): PendingPrompt {
  return { prompt: 'do it', matcherId: 'm1', automationName: 'Hook', labels: ['webhook'], ...over } as PendingPrompt;
}
function action(over: Partial<PendingSessionAction>): PendingSessionAction {
  return { type: 'set-status', target: { id: 'sess-1' }, matcherId: 'm1', ...over } as PendingSessionAction;
}

describe('createDesktopWebhookExecutors', () => {
  test('prompt → executePromptAutomation (live), waitForCompletion:false', async () => {
    const { sm, calls } = makeFakeSM();
    const ex = createDesktopWebhookExecutors(sm);
    const res = await ex.executePrompt(ws, prompt({ model: 'claude-opus-4-8', permissionMode: 'safe' }));
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe('sess-new');
    const call = calls.find((c) => c.fn === 'executePromptAutomation')!;
    const input = call.args[0] as Record<string, unknown>;
    expect(input.workspaceId).toBe('ws1');
    expect(input.workspaceRootPath).toBe(ws.rootPath);
    expect(input.prompt).toBe('do it');
    expect(input.waitForCompletion).toBe(false);
    expect(input.model).toBe('claude-opus-4-8');
  });

  test('prompt executor failure → ok:false (transient, retried)', async () => {
    const { sm } = makeFakeSM({
      async executePromptAutomation() { throw new Error('boom'); },
    });
    const ex = createDesktopWebhookExecutors(sm);
    const res = await ex.executePrompt(ws, prompt());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
  });

  test('set-status → setSessionStatus for a resolved session', async () => {
    const { sm, calls, sessions } = makeFakeSM();
    sessions.set('sess-1', { id: 'sess-1' });
    const ex = createDesktopWebhookExecutors(sm);
    const res = await ex.executeSessionAction(ws, action({ type: 'set-status', status: 'needs-review', target: { id: 'sess-1' } }));
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.fn === 'setSessionStatus' && c.args[1] === 'needs-review')).toBe(true);
  });

  test('set-status closed status without allowClosed → rejected, not applied', async () => {
    const { sm, calls, sessions } = makeFakeSM();
    sessions.set('sess-1', { id: 'sess-1' });
    const ex = createDesktopWebhookExecutors(sm);
    const res = await ex.executeSessionAction(ws, action({ type: 'set-status', status: 'done', target: { id: 'sess-1' } }));
    expect(res.ok).toBe(true); // terminal (logged rejection), not retried
    expect(res.note).toBe('closed-status-rejected');
    expect(calls.some((c) => c.fn === 'setSessionStatus')).toBe(false);
  });

  test('set-status closed status WITH allowClosed → applied', async () => {
    const { sm, calls, sessions } = makeFakeSM();
    sessions.set('sess-1', { id: 'sess-1' });
    const ex = createDesktopWebhookExecutors(sm);
    const res = await ex.executeSessionAction(ws, action({ type: 'set-status', status: 'done', allowClosed: true, target: { id: 'sess-1' } }));
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.fn === 'setSessionStatus' && c.args[1] === 'done')).toBe(true);
  });

  test('send-message → sendMessage into the live session (embedded-only)', async () => {
    const { sm, calls, sessions } = makeFakeSM();
    sessions.set('sess-1', { id: 'sess-1' });
    const ex = createDesktopWebhookExecutors(sm);
    const res = await ex.executeSessionAction(ws, action({ type: 'send-message', message: 'hello live', target: { id: 'sess-1' } }));
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.fn === 'sendMessage' && c.args[1] === 'hello live')).toBe(true);
  });

  test('unresolvable target → deferred:target-not-found (terminal, no mutation)', async () => {
    const { sm, calls } = makeFakeSM();
    const ex = createDesktopWebhookExecutors(sm);
    const res = await ex.executeSessionAction(ws, action({ type: 'set-status', status: 'needs-review', target: { id: 'missing' } }));
    expect(res.ok).toBe(true);
    expect(res.note).toBe('target-not-found');
    expect(calls.some((c) => c.fn === 'setSessionStatus')).toBe(false);
  });

  test('label target resolves to the most-recent session carrying the label', async () => {
    const { sm, calls, sessions } = makeFakeSM();
    // getSessions returns insertion order; the executor takes the first match.
    sessions.set('sess-a', { id: 'sess-a', labels: ['ci'] });
    sessions.set('sess-b', { id: 'sess-b', labels: ['ci', 'other'] });
    const ex = createDesktopWebhookExecutors(sm);
    const res = await ex.executeSessionAction(ws, action({ type: 'send-message', message: 'x', target: { label: 'ci' } }));
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.fn === 'sendMessage' && c.args[0] === 'sess-a')).toBe(true);
  });
});
