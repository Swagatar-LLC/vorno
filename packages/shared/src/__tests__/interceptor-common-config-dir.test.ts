import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG_FILE, LOG_DIR } from '../interceptor-common.ts';
import { resolveConfigDir } from '../config/paths.ts';

// interceptor-common re-derives the config dir without importing config/paths.ts
// (it is preloaded into SDK subprocesses). Guard against the two rules drifting,
// e.g. reintroducing upstream's ~/.craft-agent default.
describe('interceptor-common config dir', () => {
  it('matches the shared resolver for the current environment', () => {
    const dir = resolveConfigDir(process.env, homedir());
    expect(CONFIG_FILE).toBe(join(dir, 'config.json'));
    expect(LOG_DIR).toBe(join(dir, 'logs'));
  });

  it('defaults to ~/.vorno-agent in a subprocess without CRAFT_CONFIG_DIR', () => {
    const env = { ...process.env };
    delete env.CRAFT_CONFIG_DIR;
    const result = Bun.spawnSync({
      cmd: [process.execPath, '-e', `const m = await import(${JSON.stringify(join(import.meta.dir, '..', 'interceptor-common.ts'))}); console.log(m.CONFIG_FILE);`],
      env: { ...env, HOME: '/nonexistent-vorno-home' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe(join('/nonexistent-vorno-home', '.vorno-agent', 'config.json'));
  });
});
