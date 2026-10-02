/**
 * VOR-47: prod/packaged Electron must build and stage the Pi subprocess.
 * v0.14.0 retires the old session-MCP helper. Check both the caller and current
 * helper exports so an upstream rename cannot leave a green stale-name test.
 * The full electron:build gate executes these helpers separately.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..', '..');

describe('VOR-47: electron:build stages subprocess servers', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };

  it('copies the retained session-MCP workspace manifest before the frozen Docker install', () => {
    const docker = readFileSync(join(REPO_ROOT, 'Dockerfile.server'), 'utf-8');
    expect(docker.split('RUN bun install --frozen-lockfile')[0])
      .toContain('COPY packages/session-mcp-server/package.json packages/session-mcp-server/');
  });

  it('electron:build runs the subprocess staging step', () => {
    expect(pkg.scripts['electron:build']).toContain('electron:build:subprocess');
  });

  it('electron:build:subprocess script exists and points at the orchestration script', () => {
    expect(pkg.scripts['electron:build:subprocess']).toBeDefined();
    expect(pkg.scripts['electron:build:subprocess']).toContain(
      'scripts/electron-build-subprocess.ts',
    );
  });

  it('the orchestration script builds and stages the Pi subprocess using live exports', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'scripts', 'electron-build-subprocess.ts'),
      'utf-8',
    );
    // Builds pi-agent-server into packages/pi-agent-server/dist
    // (covers non-packaged prod-mode walk-up).
    expect(src).toContain('buildSubprocessServers(');
    // Stages into apps/electron/resources/* (covers packaged .app/.dmg builds).
    expect(src).toContain('copyPiAgentServer(');
    expect(src).not.toContain('copySessionServer');
    const common = readFileSync(join(REPO_ROOT, 'scripts/build/common.ts'), 'utf-8');
    expect(common).toContain('export function buildSubprocessServers(');
    expect(common).toContain('export function copyPiAgentServer(');
  });
});
