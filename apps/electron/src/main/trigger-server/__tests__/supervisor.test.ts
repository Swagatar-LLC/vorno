/**
 * TriggerServerSupervisor state-machine tests (PLAN-012).
 *
 * Uses injected test seams (hostFactory + healthProbe) so no real listener or
 * network is stood up — the state machine (start/stop/error/port-conflict) and
 * desired-state persistence are exercised against an in-memory fake host and a
 * temp CRAFT_CONFIG_DIR.
 *
 * CRAFT_CONFIG_DIR is set before the first (dynamic) import of the config module,
 * whose CONFIG_DIR is frozen at import time.
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let TriggerServerSupervisor: typeof import('../supervisor').TriggerServerSupervisor;
let loadServerConfig: typeof import('@craft-agent/http-trigger/core').loadServerConfig;
let saveServerConfig: typeof import('@craft-agent/http-trigger/core').saveServerConfig;
let configDir: string;

function writeConfig(enabled: boolean, port = 3999) {
  writeFileSync(
    join(configDir, 'server-config.json'),
    JSON.stringify({ enabled, port, host: '127.0.0.1', apiKeys: [], rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 } }),
  );
}

/** In-memory fake embedded host. */
function makeFakeHost(listenError?: unknown) {
  const calls = { listen: [] as Array<[string, number]>, closed: 0 };
  const host = {
    async listen(h: string, p: number) {
      calls.listen.push([h, p]);
      if (listenError) throw listenError;
    },
    async close() { calls.closed++; },
  };
  return { host, calls };
}

const okProbe = async () => ({ status: 'ok', fork: 'trigger-server' });

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'trigsrv-'));
  process.env.CRAFT_CONFIG_DIR = configDir;
  ({ TriggerServerSupervisor } = await import('../supervisor'));
  ({ loadServerConfig, saveServerConfig } = await import('@craft-agent/http-trigger/core'));
  void loadServerConfig; void saveServerConfig;
});

let active: InstanceType<typeof TriggerServerSupervisor> | null = null;
afterEach(async () => {
  if (active) { await active.dispose(); active = null; }
});

describe('TriggerServerSupervisor state machine', () => {
  test('start → running, persists enabled=true (desired state)', async () => {
    writeConfig(false);
    const { host } = makeFakeHost();
    const sup = new TriggerServerSupervisor({ hostFactory: () => host, healthProbe: okProbe });
    active = sup;

    const result = await sup.start();
    expect(result.success).toBe(true);
    const status = sup.getStatus();
    expect(status.state).toBe('running');
    expect(status.running).toBe(true);
    expect(status.port).toBe(3999);
    expect(loadServerConfig().enabled).toBe(true);
  });

  test('stop → stopped, persists enabled=false', async () => {
    writeConfig(true);
    const { host, calls } = makeFakeHost();
    const sup = new TriggerServerSupervisor({ hostFactory: () => host, healthProbe: okProbe });
    active = sup;

    await sup.start();
    await sup.stop();
    expect(sup.getStatus().state).toBe('stopped');
    expect(calls.closed).toBeGreaterThanOrEqual(1);
    expect(loadServerConfig().enabled).toBe(false);
  });

  test('EADDRINUSE by another trigger server → error with instance message', async () => {
    writeConfig(false);
    const { host } = makeFakeHost(Object.assign(new Error('bind'), { code: 'EADDRINUSE' }));
    // health probe returns fork fingerprint → "another instance"
    const sup = new TriggerServerSupervisor({ hostFactory: () => host, healthProbe: okProbe });
    active = sup;

    const result = await sup.start();
    expect(result.success).toBe(false);
    expect(sup.getStatus().state).toBe('error');
    expect(result.error).toContain('Another trigger server');
  });

  test('EADDRINUSE by unrelated app → generic port-in-use message', async () => {
    writeConfig(false);
    const { host } = makeFakeHost(Object.assign(new Error('bind'), { code: 'EADDRINUSE' }));
    const sup = new TriggerServerSupervisor({ hostFactory: () => host, healthProbe: async () => null });
    active = sup;

    const result = await sup.start();
    expect(result.success).toBe(false);
    expect(result.error).toContain('in use by another application');
  });

  test('reconcile autostarts iff enabled=true', async () => {
    writeConfig(true);
    const { host } = makeFakeHost();
    const sup = new TriggerServerSupervisor({ hostFactory: () => host, healthProbe: okProbe });
    active = sup;

    await sup.reconcile();
    expect(sup.getStatus().state).toBe('running');
  });

  test('reconcile is a no-op when enabled=false', async () => {
    writeConfig(false);
    const { host, calls } = makeFakeHost();
    const sup = new TriggerServerSupervisor({ hostFactory: () => host, healthProbe: okProbe });
    active = sup;

    await sup.reconcile();
    expect(sup.getStatus().state).toBe('stopped');
    expect(calls.listen.length).toBe(0);
  });

  test('createApiKey returns plaintext once + persists metadata', async () => {
    writeConfig(false);
    const sup = new TriggerServerSupervisor({ hostFactory: () => makeFakeHost().host, healthProbe: okProbe });
    active = sup;

    const created = sup.createApiKey('CI', { workspaceIds: [], permissionPolicy: 'allow-safe', maxConcurrentSessions: 3 });
    expect(created.fullKey).toStartWith('craft_sk_');
    expect(created.info.keyPrefix).toContain('craft_sk_');
    // Persisted config carries metadata but never the plaintext/hash to the DTO.
    const cfg = sup.getConfig();
    expect(cfg.apiKeys.some((k) => k.id === created.info.id)).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain(created.fullKey);
    // Revoke round-trips.
    expect(sup.revokeApiKey(created.info.id)).toBe(true);
  });
});
