/**
 * fork(PLAN-014) Phase 3 — webhook management CRUD tests.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listWebhooks,
  upsertWebhook,
  revokeWebhookToken,
  readWebhookDeliveries,
} from './webhook-management.ts';
import { validateAutomationsConfig } from './validation.ts';
import { hashHookToken } from './webhook-ingest/tokens.ts';

let root: string;
const configPath = () => join(root, 'automations.json');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'whk-mgmt-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readConfig() {
  return JSON.parse(readFileSync(configPath(), 'utf-8'));
}

describe('upsertWebhook — create', () => {
  test('creates a valid, invocable hook and returns the token exactly once', async () => {
    const res = await upsertWebhook(root, 'my-workspace', { name: 'CI', slug: 'ci-events' });

    expect(res.token).toBeDefined();
    expect(res.token!.startsWith('craft_whk_')).toBe(true);
    expect(res.webhook.hasToken).toBe(true);
    expect(res.webhook.slug).toBe('ci-events');
    expect(res.webhook.enabled).toBe(true);
    expect(res.webhook.ingestPath).toBe('/hooks/my-workspace/ci-events');
    expect(res.webhook.id).toMatch(/^[0-9a-f]{6}$/);

    // Persisted config is schema+semantic valid, and the plaintext is NOT stored.
    const config = readConfig();
    expect(validateAutomationsConfig(config).valid).toBe(true);
    const raw = readFileSync(configPath(), 'utf-8');
    expect(raw.includes(res.token!)).toBe(false);

    // Stored hash matches the returned plaintext.
    const stored = config.automations.WebhookReceived[0].hook.tokenHash;
    expect(stored).toBe(hashHookToken(res.token!));
  });

  test('applies a default prompt action referencing the payload path', async () => {
    const res = await upsertWebhook(root, 'ws', { name: 'H', slug: 'h' });
    expect(res.webhook.actionTypes).toEqual(['prompt']);
    const prompt = (res.webhook.actions[0] as { prompt: string }).prompt;
    expect(prompt).toContain('$CRAFT_WEBHOOK_PAYLOAD_PATH');
  });

  test('rejects a duplicate slug without corrupting the file', async () => {
    await upsertWebhook(root, 'ws', { name: 'A', slug: 'dup' });
    await expect(upsertWebhook(root, 'ws', { name: 'B', slug: 'dup' })).rejects.toThrow(/Invalid automations config/);
    // Original still valid, single hook.
    expect(listWebhooks(root, 'ws').length).toBe(1);
  });
});

describe('upsertWebhook — edit', () => {
  test('edits fields, toggles enabled, and preserves the token', async () => {
    const created = await upsertWebhook(root, 'ws', { name: 'A', slug: 'a' });
    const id = created.webhook.id;
    const originalHash = readConfig().automations.WebhookReceived[0].hook.tokenHash;

    const edited = await upsertWebhook(root, 'ws', {
      id,
      name: 'A renamed',
      slug: 'a',
      enabled: false,
      labels: ['webhook', 'ci'],
      matchField: '$.type',
      matcher: '^push$',
    });

    expect(edited.token).toBeUndefined();
    expect(edited.webhook.name).toBe('A renamed');
    expect(edited.webhook.enabled).toBe(false);
    expect(edited.webhook.labels).toEqual(['webhook', 'ci']);
    expect(edited.webhook.matchField).toBe('$.type');
    expect(readConfig().automations.WebhookReceived[0].hook.tokenHash).toBe(originalHash);
    expect(listWebhooks(root, 'ws').length).toBe(1);
  });
});

describe('revokeWebhookToken', () => {
  test('rotate mints a new token and invalidates the old hash', async () => {
    const created = await upsertWebhook(root, 'ws', { name: 'A', slug: 'a' });
    const oldHash = readConfig().automations.WebhookReceived[0].hook.tokenHash;

    const rotated = await revokeWebhookToken(root, 'ws', created.webhook.id, 'rotate');
    expect(rotated.token).toBeDefined();
    expect(rotated.token).not.toBe(created.token);
    const newHash = readConfig().automations.WebhookReceived[0].hook.tokenHash;
    expect(newHash).not.toBe(oldHash);
    expect(newHash).toBe(hashHookToken(rotated.token!));
    expect(rotated.webhook.hasToken).toBe(true);
  });

  test('clear strips the token; hook stays registered but un-invocable', async () => {
    const created = await upsertWebhook(root, 'ws', { name: 'A', slug: 'a' });
    const cleared = await revokeWebhookToken(root, 'ws', created.webhook.id, 'clear');

    expect(cleared.token).toBeUndefined();
    expect(cleared.webhook.hasToken).toBe(false);
    const hook = readConfig().automations.WebhookReceived[0].hook;
    expect(hook.tokenHash).toBeUndefined();
    expect(hook.slug).toBe('a');
    // Still a valid config (tokenHash is optional).
    expect(validateAutomationsConfig(readConfig()).valid).toBe(true);
  });

  test('throws on unknown id', async () => {
    await expect(revokeWebhookToken(root, 'ws', 'nope01', 'rotate')).rejects.toThrow(/not found/);
  });
});

describe('readWebhookDeliveries', () => {
  test('returns hook-scoped records, most-recent-first, mapped by kind', async () => {
    const created = await upsertWebhook(root, 'ws', { name: 'A', slug: 'a' });
    const id = created.webhook.id;
    const lines = [
      { id, ts: 1, ok: true, sessionId: 'sess-1', prompt: 'p' },
      { id, ts: 2, ok: false, sessionAction: { type: 'set-status', outcome: 'rejected:closed-status:done', eventId: 'e2' } },
      { id: 'other', ts: 3, ok: true, sessionId: 'x' },
    ];
    writeFileSync(join(root, 'automations-history.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const deliveries = await readWebhookDeliveries(root, id);
    expect(deliveries.length).toBe(2);
    expect(deliveries[0]!.ts).toBe(2); // most recent first
    expect(deliveries[0]!.kind).toBe('session-action');
    expect(deliveries[0]!.actionType).toBe('set-status');
    expect(deliveries[0]!.outcome).toContain('rejected:closed-status');
    expect(deliveries[1]!.kind).toBe('prompt');
    expect(deliveries[1]!.sessionId).toBe('sess-1');
  });

  test('empty when no history file exists', async () => {
    const created = await upsertWebhook(root, 'ws', { name: 'A', slug: 'a' });
    expect(await readWebhookDeliveries(root, created.webhook.id)).toEqual([]);
  });
});
