import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG_DIR, CONFIG_DIR_RESOLUTION, DEFAULT_CONFIG_DIR_NAME, resolveConfigDir, resolveConfigDirFromEnv } from '../paths.ts';

// OSS #1062: CRAFT_CONFIG_DIR must be the single switch for where the app keeps
// its state; every module joins onto CONFIG_DIR instead of homedir().
// Fork: the default is ~/.vorno-agent, never upstream's ~/.craft-agent.
describe('resolveConfigDir', () => {
  it('defaults to ~/.vorno-agent', () => {
    expect(DEFAULT_CONFIG_DIR_NAME).toBe('.vorno-agent');
    expect(resolveConfigDir({}, '/Users/me')).toBe(join('/Users/me', '.vorno-agent'));
    expect(resolveConfigDir({ CRAFT_CONFIG_DIR: '' }, '/Users/me')).toBe(join('/Users/me', '.vorno-agent'));
    expect(resolveConfigDir({ CRAFT_CONFIG_DIR: '   ' }, '/Users/me')).toBe(join('/Users/me', '.vorno-agent'));
  });

  it('honors CRAFT_CONFIG_DIR', () => {
    expect(resolveConfigDir({ CRAFT_CONFIG_DIR: '/tmp/craft-dev' }, '/Users/me')).toBe('/tmp/craft-dev');
  });

  it('CONFIG_DIR retains its startup resolution while the dynamic resolver reads current env', () => {
    expect(CONFIG_DIR).toBe(CONFIG_DIR_RESOLUTION.dir);
    expect(resolveConfigDirFromEnv()).toBe(resolveConfigDir(process.env, homedir()));
  });
});
