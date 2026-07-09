/**
 * Regression guard for VOR-47 — "piServerPath not configured. Cannot spawn Pi
 * subprocess."
 *
 * Root cause: the prod/packaged Electron build (`electron:build`, used by
 * electron:start / electron:prod / build-dmg.sh / electron:dist:mac) never built
 * or staged the pi-agent-server (and session-mcp-server) subprocess bundles.
 * `resolveServerPath` (runtime-resolver.ts) therefore returned undefined and
 * `PiAgent.spawnSubprocess` threw. Only `electron:dev` built them, so the bug
 * was invisible in dev and only surfaced with a Pi (pi/pi_compat) connection in
 * a prod/packaged build.
 *
 * The staging helpers (`buildMcpServers` / `copyPiAgentServer` /
 * `copySessionServer`) existed in scripts/build/common.ts but had NO caller on
 * the electron path — dead code. The fix wires them in via
 * `scripts/electron-build-subprocess.ts`, invoked by `electron:build`.
 *
 * This test asserts the wiring stays in place — both the pipeline step and the
 * three helper invocations — so the staging step cannot silently go dead again.
 * It reads source/config only (no build side effects).
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..', '..');

describe('VOR-47: electron:build stages subprocess servers', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };

  it('electron:build runs the subprocess staging step', () => {
    expect(pkg.scripts['electron:build']).toContain('electron:build:subprocess');
  });

  it('electron:build:subprocess script exists and points at the orchestration script', () => {
    expect(pkg.scripts['electron:build:subprocess']).toBeDefined();
    expect(pkg.scripts['electron:build:subprocess']).toContain(
      'scripts/electron-build-subprocess.ts',
    );
  });

  it('the orchestration script builds AND stages both subprocess servers', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'scripts', 'electron-build-subprocess.ts'),
      'utf-8',
    );
    // Builds pi-agent-server + session-mcp-server into packages/*/dist
    // (covers non-packaged prod-mode walk-up).
    expect(src).toContain('buildMcpServers(');
    // Stages into apps/electron/resources/* (covers packaged .app/.dmg builds).
    expect(src).toContain('copyPiAgentServer(');
    expect(src).toContain('copySessionServer(');
  });
});
