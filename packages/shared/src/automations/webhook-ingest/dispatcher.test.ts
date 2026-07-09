/**
 * fork(PLAN-014) — shared webhook dispatcher composition test.
 *
 * The dispatcher is the host-agnostic seam BOTH hosts compose on (standalone =
 * disk executors, embedded = desktop SessionManager executors). This drives the
 * full path — dispatch → per-workspace AutomationSystem (scheduler off) →
 * matcher → PendingPrompt → the INJECTED executor — proving the wiring and the
 * failure-propagation contract independent of either host's concrete executors.
 *
 * Workspace resolution is injected (the production default is
 * `getWorkspaceByNameOrId`) so the test is independent of the global config-dir
 * registry and its import-time CONFIG_DIR freeze.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebhookDispatcher } from './dispatcher.ts';
import type { ResolvedWorkspace } from './receiver.ts';

let wsRoot: string;
const WS_ID = 'ws-dispatch-1';
const TOKEN_HASH = 'sha256:' + 'a'.repeat(64);

function resolver(id: string): ResolvedWorkspace | null {
  return id === WS_ID ? { workspaceId: WS_ID, rootPath: wsRoot } : null;
}

function payload() {
  return {
    workspaceId: WS_ID,
    timestamp: 1,
    hookId: 'w1',
    hookSlug: 'test-hook',
    eventId: 'w1:evt-1',
    payloadCount: 1,
    headers: {},
    body: { type: 'Issue.created' },
  };
}

beforeAll(() => {
  wsRoot = mkdtempSync(join(tmpdir(), 'wh-disp-ws-'));
  writeFileSync(
    join(wsRoot, 'automations.json'),
    JSON.stringify({
      automations: {
        WebhookReceived: [
          {
            id: 'w1',
            name: 'Dispatch test hook',
            hook: { slug: 'test-hook', tokenHash: TOKEN_HASH },
            actions: [{ type: 'prompt', prompt: 'handle $CRAFT_WEBHOOK_EVENT_ID' }],
          },
        ],
      },
    }),
  );
});

describe('createWebhookDispatcher (shared composition)', () => {
  test('routes a delivery through the AutomationSystem to the injected prompt executor', async () => {
    const seen: Array<{ workspaceId: string; rootPath: string; prompt: string }> = [];
    const dispatcher = createWebhookDispatcher(
      {
        executePrompt: async (ws, prompt) => {
          seen.push({ workspaceId: ws.workspaceId, rootPath: ws.rootPath, prompt: prompt.prompt });
          return { ok: true, sessionId: 's1' };
        },
        executeSessionAction: async () => ({ ok: true }),
      },
      { resolveWorkspace: resolver },
    );
    try {
      await dispatcher.dispatch(WS_ID, payload());
      expect(seen.length).toBe(1);
      expect(seen[0].workspaceId).toBe(WS_ID);
      expect(seen[0].rootPath).toBe(wsRoot);
    } finally {
      await dispatcher.dispose();
    }
  });

  test('executor failure propagates (dispatch rejects → receiver retries)', async () => {
    const dispatcher = createWebhookDispatcher(
      {
        executePrompt: async () => ({ ok: false, error: 'exec-boom' }),
        executeSessionAction: async () => ({ ok: true }),
      },
      { resolveWorkspace: resolver },
    );
    try {
      await expect(dispatcher.dispatch(WS_ID, payload())).rejects.toThrow(/exec-boom/);
    } finally {
      await dispatcher.dispose();
    }
  });

  test('unknown workspace → dispatch rejects', async () => {
    const dispatcher = createWebhookDispatcher(
      {
        executePrompt: async () => ({ ok: true }),
        executeSessionAction: async () => ({ ok: true }),
      },
      { resolveWorkspace: resolver },
    );
    try {
      await expect(dispatcher.dispatch('no-such-ws', payload())).rejects.toThrow(/not found/);
    } finally {
      await dispatcher.dispose();
    }
  });
});
