/**
 * fork(PLAN-014) — standalone session-action + prompt executor tests.
 * Exercises the disk-mutating paths (no LLM key needed): set-status with the
 * closed-status guard, target resolution, set-labels, send-message deferral, and
 * prompt-session persistence.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, loadSession, setSessionLabels } from '@craft-agent/shared/sessions';
import type { PendingSessionAction, PendingPrompt } from '@craft-agent/shared/automations';
import {
  executeWebhookSessionAction,
  executeWebhookPrompt,
  resolveTargetSession,
} from '../../src/webhooks/executors';

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'p14-ws-'));
}

function action(over: Partial<PendingSessionAction> & { type: PendingSessionAction['type'] }): PendingSessionAction {
  return { target: {}, matcherId: 'm1', ...over };
}

describe('executeWebhookSessionAction: set-status', () => {
  test('valid open status is applied', async () => {
    const root = tmpWorkspace();
    try {
      const session = await createSession(root, { name: 'w' });
      const res = await executeWebhookSessionAction(root, action({
        type: 'set-status', target: { id: session.id }, status: 'needs-review',
      }));
      expect(res.ok).toBe(true);
      expect(loadSession(root, session.id)?.sessionStatus).toBe('needs-review');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('closed status rejected without allowClosed (house rule)', async () => {
    const root = tmpWorkspace();
    try {
      const session = await createSession(root, { name: 'w', sessionStatus: 'todo' });
      const res = await executeWebhookSessionAction(root, action({
        type: 'set-status', target: { id: session.id }, status: 'done',
      }));
      expect(res.ok).toBe(true); // terminal, not retried
      expect(res.note).toBe('closed-status-rejected');
      expect(loadSession(root, session.id)?.sessionStatus).toBe('todo'); // unchanged
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('closed status applied when allowClosed:true', async () => {
    const root = tmpWorkspace();
    try {
      const session = await createSession(root, { name: 'w', sessionStatus: 'todo' });
      const res = await executeWebhookSessionAction(root, action({
        type: 'set-status', target: { id: session.id }, status: 'done', allowClosed: true,
      }));
      expect(res.ok).toBe(true);
      expect(loadSession(root, session.id)?.sessionStatus).toBe('done');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('executeWebhookSessionAction: targeting + other kinds', () => {
  test('target-not-found is a terminal deferral', async () => {
    const root = tmpWorkspace();
    try {
      const res = await executeWebhookSessionAction(root, action({
        type: 'set-status', target: { id: 'no-such-session' }, status: 'needs-review',
      }));
      expect(res.ok).toBe(true);
      expect(res.note).toBe('target-not-found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolveTargetSession by label picks the labeled session', async () => {
    const root = tmpWorkspace();
    try {
      const session = await createSession(root, { name: 'w' });
      await setSessionLabels(root, session.id, ['ci-target']);
      expect(resolveTargetSession(root, { label: 'ci-target' })).toBe(session.id);
      expect(resolveTargetSession(root, { label: 'nope' })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('send-message is deferred (host cannot inject live)', async () => {
    const root = tmpWorkspace();
    try {
      const session = await createSession(root, { name: 'w' });
      const res = await executeWebhookSessionAction(root, action({
        type: 'send-message', target: { id: session.id }, message: 'hi',
      }));
      expect(res.ok).toBe(true);
      expect(res.note).toBe('host-unreachable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('executeWebhookPrompt', () => {
  test('persists a session with labels + permission mode', async () => {
    const root = tmpWorkspace();
    try {
      const prompt: PendingPrompt = {
        sessionId: undefined,
        matcherId: 'm1',
        automationName: 'Linear triage',
        prompt: 'triage this',
        mentions: [],
        labels: ['webhook', 'linear'],
        permissionMode: 'safe',
      };
      const res = await executeWebhookPrompt(root, prompt);
      expect(res.ok).toBe(true);
      const stored = loadSession(root, res.sessionId!);
      expect(stored).not.toBeNull();
      expect(stored?.labels).toEqual(['webhook', 'linear']);
      expect(stored?.permissionMode).toBe('safe');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
