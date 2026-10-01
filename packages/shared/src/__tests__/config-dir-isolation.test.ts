import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Fork isolation: upstream v0.13.6 added one-time copies of
// ~/.craft-agent/credentials.enc and ~/.craft-agent/workspaces into any other
// CONFIG_DIR. The fork already owns its migration (config-dir-migration.ts),
// so an explicit, empty CRAFT_CONFIG_DIR must never inherit another
// installation's secrets or workspaces. Runs in a child process because both
// modules capture CONFIG_DIR at module-eval.
const SHARED_SRC = resolve(import.meta.dir, '..');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runIsolated(home: string, configDir: string, script: string) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    cwd: SHARED_SRC,
    env: { ...process.env, HOME: home, USERPROFILE: home, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

describe('explicit CRAFT_CONFIG_DIR isolation', () => {
  it('does not copy legacy ~/.craft-agent credentials or workspaces', () => {
    const home = mkdtempSync(join(tmpdir(), 'vorno-iso-home-'));
    roots.push(home);
    const legacy = join(home, '.craft-agent');
    mkdirSync(join(legacy, 'workspaces', 'leaked-ws'), { recursive: true });
    writeFileSync(join(legacy, 'credentials.enc'), Buffer.alloc(256, 1));
    writeFileSync(join(legacy, 'workspaces', 'leaked-ws', 'config.json'), '{}');
    const configDir = join(home, 'isolated-config');

    runIsolated(home, configDir, `
      const { SecureStorageBackend } = await import(${JSON.stringify(join(SHARED_SRC, 'credentials/backends/secure-storage.ts'))});
      await new SecureStorageBackend().get({ type: 'anthropic_api_key' });
      const { ensureDefaultWorkspacesDir } = await import(${JSON.stringify(join(SHARED_SRC, 'workspaces/storage.ts'))});
      ensureDefaultWorkspacesDir();
    `);

    expect(existsSync(join(configDir, 'credentials.enc'))).toBe(false);
    const workspaces = join(configDir, 'workspaces');
    expect(existsSync(workspaces) ? readdirSync(workspaces) : []).not.toContain('leaked-ws');
    // Upstream's directory stays untouched.
    expect(existsSync(join(legacy, 'credentials.enc'))).toBe(true);
  });
});
