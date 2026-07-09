/**
 * fork(PLAN-014) — embedded webhook E2E (real HTTP → live SessionManager seam).
 *
 * Exercises the ENTIRE embedded stack over a real node:http listener — the
 * supervisor-owned trigger server, the pre-auth /hooks route, the receiver
 * (verify/dedup/rate/queue), the shared dispatcher, and the DESKTOP executor —
 * against a real minted capability token. A fake SessionManager stands in for
 * the live desktop app: `executePromptAutomation` firing is the automated
 * equivalent of "a session appears LIVE in the running app".
 *
 * Verifies the PLAN-014 acceptance curls against the EMBEDDED host (LEARNING-018
 * closed): valid token + matching payload → 202 → spawn; duplicate → 200; wrong
 * token → 404.
 *
 * CRAFT_CONFIG_DIR is frozen at first import — run this file in isolation.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let TriggerServerSupervisor: typeof import('../supervisor').TriggerServerSupervisor;
let createEmbeddedWebhooks: typeof import('../webhooks').createEmbeddedWebhooks;
let generateHookToken: typeof import('@craft-agent/shared/automations').generateHookToken;

let configDir: string;
let wsRoot: string;
const WS_ID = 'ws-e2e-1';
const PORT = 34899;
let token: string;

const spawnCalls: Array<Record<string, unknown>> = [];

const fakeSM = {
  async executePromptAutomation(input: Record<string, unknown>) {
    spawnCalls.push(input);
    return { sessionId: `sess-${spawnCalls.length}` };
  },
  async getSession() { return null; },
  getSessions() { return [] as never; },
  async setSessionStatus() {},
  setSessionLabels() {},
  async sendMessage() {},
};

let sup: InstanceType<typeof TriggerServerSupervisor> | null = null;
let webhooks: import('../webhooks').EmbeddedWebhooks | null = null;

async function postHook(tok: string, body: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${PORT}/hooks/${WS_ID}/e2e-hook/${tok}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  await res.text().catch(() => {});
  return res.status;
}

async function waitForSpawns(n: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (spawnCalls.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'wh-e2e-cfg-'));
  wsRoot = mkdtempSync(join(tmpdir(), 'wh-e2e-ws-'));
  mkdirSync(wsRoot, { recursive: true });
  process.env.CRAFT_CONFIG_DIR = configDir;

  ({ TriggerServerSupervisor } = await import('../supervisor'));
  ({ createEmbeddedWebhooks } = await import('../webhooks'));
  ({ generateHookToken } = await import('@craft-agent/shared/automations'));

  const minted = generateHookToken();
  token = minted.token;

  writeFileSync(
    join(wsRoot, 'automations.json'),
    JSON.stringify({
      automations: {
        WebhookReceived: [
          {
            id: 'e2ehook',
            name: 'E2E hook',
            hook: { slug: 'e2e-hook', tokenHash: minted.tokenHash },
            actions: [{ type: 'prompt', prompt: 'triage $CRAFT_WEBHOOK_EVENT_ID' }],
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      workspaces: [{ id: WS_ID, name: 'E2E WS', slug: 'e2e-ws', rootPath: wsRoot, createdAt: 1 }],
      activeWorkspaceId: WS_ID,
    }),
  );
  writeFileSync(
    join(configDir, 'server-config.json'),
    JSON.stringify({ enabled: true, port: PORT, host: '127.0.0.1', apiKeys: [], rateLimits: { requestsPerMinute: 120, concurrentSessions: 5 } }),
  );

  webhooks = createEmbeddedWebhooks(fakeSM as never);
  sup = new TriggerServerSupervisor({
    hostBridge: { onWebhookEvent: webhooks.dispatch },
    webhooks: webhooks.handle,
  });
  const started = await sup.start();
  expect(started.success).toBe(true);
});

afterAll(async () => {
  if (sup) await sup.dispose();
  if (webhooks) await webhooks.dispose();
});

describe('embedded webhook E2E (real HTTP → SessionManager)', () => {
  test('valid token + matching payload → 202 → live session spawned', async () => {
    const status = await postHook(token, JSON.stringify({ type: 'Issue.created', id: 'A' }));
    expect(status).toBe(202);
    await waitForSpawns(1);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].workspaceId).toBe(WS_ID);
    expect(spawnCalls[0].workspaceRootPath).toBe(wsRoot);
    expect(spawnCalls[0].waitForCompletion).toBe(false);
  });

  test('duplicate delivery (same body) → 200, no second spawn', async () => {
    const before = spawnCalls.length;
    const status = await postHook(token, JSON.stringify({ type: 'Issue.created', id: 'A' }));
    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(spawnCalls.length).toBe(before);
  });

  test('wrong token → 404 (uniform non-disclosure)', async () => {
    const status = await postHook('craft_whk_totally-wrong', JSON.stringify({ type: 'Issue.created', id: 'B' }));
    expect(status).toBe(404);
  });
});
