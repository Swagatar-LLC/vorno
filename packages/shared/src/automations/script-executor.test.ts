/**
 * Tests for the script action executor.
 *
 * Successor to the pre-rename command-executor tests (recovered from
 * 9f013b3f^): the security model changed from shell + allowlist to
 * argv spawn + workspace containment + CRAFT_*-only env, so the cases
 * here assert the new invariants.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { executeScriptAction, clampScriptTimeout, createScriptHistoryEntry, DEFAULT_SCRIPT_TIMEOUT_MS, MAX_SCRIPT_TIMEOUT_MS } from './script-executor.ts';
import { buildScriptEnv } from './utils.ts';
import { addPageGrant, createPage, loadPageConfig, savePageConfig, updatePage } from '../pages/storage.ts';
import type { ScriptAction } from './types.ts';

const IS_WINDOWS = process.platform === 'win32';

describe('script-executor', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'script-executor-test-'));
  });

  /**
   * A workspace with Pages actually enabled. Scheduled refresh now re-reads the
   * per-workspace capability on every run, so a fixture with no config models a
   * workspace that never enabled Pages — and is correctly refused.
   */
  function enablePages(permissionMode: string | undefined = 'ask') {
    writeFileSync(join(workspaceDir, 'config.json'), JSON.stringify({
      id: 'ws_script_exec',
      name: 'Script executor test',
      slug: 'ws_script_exec',
      defaults: { pages: { enabled: true }, ...(permissionMode !== undefined ? { permissionMode } : {}) },
      createdAt: 1,
      updatedAt: 1,
    }));
  }

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function action(overrides: Partial<ScriptAction> & Pick<ScriptAction, 'script'>): ScriptAction {
    return { type: 'script', runtime: 'bun', ...overrides };
  }

  function ctx(env: Record<string, string> = {}) {
    return { workspaceRootPath: workspaceDir, env };
  }

  function configureRefresh(script: string, args?: string[]): string {
    enablePages();
    const page = createPage(workspaceDir, { name: 'Dash', content: '<p>dash</p>' });
    const grant = addPageGrant(workspaceDir, page.slug, {
      action: { kind: 'script', script, ...(args ? { args } : {}) },
    });
    updatePage(workspaceDir, page.slug, {
      refresh: { cron: '*/5 * * * *', script, ...(args ? { args } : {}), grantId: grant.id },
    });
    return grant.id;
  }

  describe('path containment', () => {
    it('blocks absolute script paths', async () => {
      const abs = IS_WINDOWS ? 'C:\\evil.ts' : '/tmp/evil.ts';
      const result = await executeScriptAction(action({ script: abs }), ctx());
      expect(result.blocked).toBe(true);
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('relative');
    });

    it('blocks paths escaping the workspace via ..', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'script-executor-escape-'));
      try {
        writeFileSync(join(outsideDir, 'outside.ts'), 'console.log("outside")');
        const escapePath = join('..', relative(tmpdir(), outsideDir), 'outside.ts');
        const result = await executeScriptAction(action({ script: escapePath }), ctx());
        expect(result.blocked).toBe(true);
        expect(result.stderr).toContain('escapes the workspace');
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it.skipIf(IS_WINDOWS)('blocks symlinks pointing outside the workspace', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'script-executor-outside-'));
      try {
        writeFileSync(join(outsideDir, 'target.ts'), 'console.log("outside")');
        symlinkSync(join(outsideDir, 'target.ts'), join(workspaceDir, 'link.ts'));
        const result = await executeScriptAction(action({ script: 'link.ts' }), ctx());
        expect(result.blocked).toBe(true);
        expect(result.stderr).toContain('escapes the workspace');
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('blocks missing scripts', async () => {
      const result = await executeScriptAction(action({ script: 'nope.ts' }), ctx());
      expect(result.blocked).toBe(true);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('execution', () => {
    it('runs a script and captures stdout/exit code', async () => {
      writeFileSync(join(workspaceDir, 'ok.ts'), 'console.log("hello from script")');
      const result = await executeScriptAction(action({ script: 'ok.ts' }), ctx());
      expect(result.blocked).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello from script');
    });

    it('reports non-zero exits as failure with stderr', async () => {
      writeFileSync(join(workspaceDir, 'fail.ts'), 'console.error("boom"); process.exit(3)');
      const result = await executeScriptAction(action({ script: 'fail.ts' }), ctx());
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain('boom');
    });

    it('passes argv and the provided env (and nothing else CRAFT-relevant)', async () => {
      writeFileSync(
        join(workspaceDir, 'env.ts'),
        'console.log(JSON.stringify({ argv: process.argv.slice(2), craft: process.env.CRAFT_EVENT, leak: process.env.SCRIPT_EXECUTOR_LEAK_PROBE ?? null }))',
      );
      process.env.SCRIPT_EXECUTOR_LEAK_PROBE = 'should-not-leak';
      try {
        const result = await executeScriptAction(
          action({ script: 'env.ts', args: ['--flag', 'value'] }),
          ctx({ CRAFT_EVENT: 'SchedulerTick' }),
        );
        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.stdout) as { argv: string[]; craft: string; leak: string | null };
        expect(parsed.argv).toEqual(['--flag', 'value']);
        expect(parsed.craft).toBe('SchedulerTick');
        expect(parsed.leak).toBeNull();
      } finally {
        delete process.env.SCRIPT_EXECUTOR_LEAK_PROBE;
      }
    });

    it('kills scripts that exceed their timeout', async () => {
      writeFileSync(join(workspaceDir, 'hang.ts'), 'await new Promise(() => {})');
      const result = await executeScriptAction(
        action({ script: 'hang.ts', timeoutMs: 1_000 }),
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain('Timed out');
    }, 15_000);

    it('kills a running script when the abort signal fires', async () => {
      writeFileSync(join(workspaceDir, 'hang.ts'), 'await new Promise(() => {})');
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const result = await executeScriptAction(
        // Long timeout so the abort — not the timeout — is what ends the run.
        action({ script: 'hang.ts', timeoutMs: 30_000 }),
        { workspaceRootPath: workspaceDir, env: {}, signal: controller.signal },
      );
      expect(result.success).toBe(false);
      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBeUndefined();
      expect(result.stderr).toContain('Aborted');
    }, 15_000);

    it('aborts immediately when handed an already-aborted signal', async () => {
      writeFileSync(join(workspaceDir, 'hang.ts'), 'await new Promise(() => {})');
      const result = await executeScriptAction(
        action({ script: 'hang.ts', timeoutMs: 30_000 }),
        { workspaceRootPath: workspaceDir, env: {}, signal: AbortSignal.abort() },
      );
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('Aborted');
    }, 15_000);
  });

  describe('page refresh recording', () => {
    it('records the outcome on page.json after the run', async () => {
      writeFileSync(join(workspaceDir, 'refresh.ts'), 'console.log("refreshed")');
      const grantId = configureRefresh('refresh.ts');

      const result = await executeScriptAction(
        action({ script: 'refresh.ts', page: 'dash', grantId }),
        ctx(),
      );
      expect(result.success).toBe(true);

      const config = loadPageConfig(workspaceDir, 'dash');
      expect(config?.lastRefresh?.ok).toBe(true);
      expect(config?.lastRefresh?.durationMs).toBeGreaterThanOrEqual(0);
      expect(config?.lastRefresh?.error).toBeUndefined();
    });

    it('records failures with the captured stderr', async () => {
      writeFileSync(join(workspaceDir, 'bad.ts'), 'console.error("kaput"); process.exit(1)');
      const grantId = configureRefresh('bad.ts');

      const result = await executeScriptAction(
        action({ script: 'bad.ts', page: 'dash', grantId }),
        ctx(),
      );
      expect(result.success).toBe(false);

      const config = loadPageConfig(workspaceDir, 'dash');
      expect(config?.lastRefresh?.ok).toBe(false);
      expect(config?.lastRefresh?.error).toContain('kaput');
    });

    it('rechecks a cached refresh grant immediately before spawning', async () => {
      writeFileSync(join(workspaceDir, 'refresh.ts'), 'console.log("must not run")');
      const grantId = configureRefresh('refresh.ts');
      const config = loadPageConfig(workspaceDir, 'dash')!;
      savePageConfig(workspaceDir, {
        ...config,
        grants: config.grants!.map(grant => grant.id === grantId ? { ...grant, expiresAt: Date.now() - 1 } : grant),
      });

      const result = await executeScriptAction(action({ script: 'refresh.ts', page: 'dash', grantId }), ctx());
      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.stderr).toContain('expired');
    });
  });

  describe('page refresh admission (SUV-0065)', () => {
    it('refuses to spawn once Pages is disabled for the workspace', async () => {
      // This is the production scheduler path. A matcher built while Pages was
      // on must not get one more run out of a stale schedule after it is off.
      writeFileSync(join(workspaceDir, 'run.ts'), 'console.log("ran")');
      const grantId = configureRefresh('run.ts');

      const enabled = await executeScriptAction(action({ script: 'run.ts', page: 'dash', grantId }), ctx());
      expect(enabled.success).toBe(true);

      writeFileSync(join(workspaceDir, 'config.json'), JSON.stringify({
        id: 'ws_script_exec', name: 'Script executor test', slug: 'ws_script_exec',
        defaults: { pages: { enabled: false }, permissionMode: 'ask' }, createdAt: 1, updatedAt: 1,
      }));
      const disabled = await executeScriptAction(action({ script: 'run.ts', page: 'dash', grantId }), ctx());
      expect(disabled.blocked).toBe(true);
      expect(disabled.stderr).toContain('pages-disabled');
    });

    it('refuses to spawn while the workspace is in Explore', async () => {
      writeFileSync(join(workspaceDir, 'run.ts'), 'console.log("ran")');
      const grantId = configureRefresh('run.ts');

      writeFileSync(join(workspaceDir, 'config.json'), JSON.stringify({
        id: 'ws_script_exec', name: 'Script executor test', slug: 'ws_script_exec',
        defaults: { pages: { enabled: true }, permissionMode: 'safe' }, createdAt: 1, updatedAt: 1,
      }));
      const result = await executeScriptAction(action({ script: 'run.ts', page: 'dash', grantId }), ctx());
      expect(result.blocked).toBe(true);
      expect(result.stderr).toContain('permission-mode-forbidden');
    });
  });

  describe('clampScriptTimeout', () => {
    it('defaults and clamps', () => {
      expect(clampScriptTimeout(undefined)).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
      expect(clampScriptTimeout(1)).toBe(1_000);
      expect(clampScriptTimeout(999_999_999)).toBe(MAX_SCRIPT_TIMEOUT_MS);
      expect(clampScriptTimeout(5_000)).toBe(5_000);
    });
  });

  describe('createScriptHistoryEntry', () => {
    it('builds the automations-history shape with error capping', () => {
      const entry = createScriptHistoryEntry({
        matcherId: 'abc123',
        result: {
          type: 'script',
          script: 'x.ts',
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: 'e'.repeat(5000),
          durationMs: 42,
          page: 'dash',
        },
      });
      expect(entry.id).toBe('abc123');
      expect(entry.ok).toBe(false);
      const script = entry.script as Record<string, unknown>;
      expect(script.script).toBe('x.ts');
      expect(script.page).toBe('dash');
      expect((script.error as string).length).toBeLessThanOrEqual(2000);
    });
  });

  describe('buildScriptEnv', () => {
    it('is CRAFT_*-only plus documented platform essentials', () => {
      process.env.CRAFT_TEST_PASSTHROUGH = 'yes';
      process.env.NOT_CRAFT_SECRET = 'no';
      try {
        const env = buildScriptEnv(
          'SchedulerTick',
          { workspaceId: 'ws', timestamp: 123, localTime: '10:00', utcTime: 't' } as never,
          { workspaceRootPath: workspaceDir, page: 'dash' },
        );
        expect(env.CRAFT_TEST_PASSTHROUGH).toBe('yes');
        expect(env.NOT_CRAFT_SECRET).toBeUndefined();
        expect(env.CRAFT_EVENT).toBe('SchedulerTick');
        expect(env.CRAFT_WORKSPACE_PATH).toBe(workspaceDir);
        expect(env.CRAFT_PAGE_SLUG).toBe('dash');
        expect(env.CRAFT_PAGE_DIR).toBe(join(workspaceDir, 'pages', 'dash'));
        expect(env.CRAFT_PAGE_DATA_DIR).toBe(join(workspaceDir, 'pages', 'dash', 'data'));
        expect(env.PATH).toBeUndefined();
        // Every key is CRAFT_* or a documented essential
        const essentials = new Set(IS_WINDOWS
          ? ['USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']
          : ['HOME']);
        for (const key of Object.keys(env)) {
          expect(key.startsWith('CRAFT_') || essentials.has(key)).toBe(true);
        }
      } finally {
        delete process.env.CRAFT_TEST_PASSTHROUGH;
        delete process.env.NOT_CRAFT_SECRET;
      }
    });
  });
});
