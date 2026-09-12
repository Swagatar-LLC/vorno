/**
 * Admission for the scheduled-refresh origin.
 *
 * The point of these is that they exercise the path a user's machine actually
 * runs on a cron tick. The broker's own scheduled-origin tests prove the policy
 * table; these prove the scheduler consults it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PageConfig, PageRefreshSpec } from '@craft-agent/core';
import { admitScheduledPageRefresh } from './scheduled-admission.ts';

const DIGEST = 'a'.repeat(64);

describe('pages/scheduled-admission', () => {
  let workspaceRootPath: string;
  let auditLogPath: string;

  beforeEach(() => {
    workspaceRootPath = mkdtempSync(join(tmpdir(), 'pages-scheduled-'));
    auditLogPath = join(workspaceRootPath, 'page-actions.jsonl');
    writeWorkspace('ask');
  });

  afterEach(() => {
    rmSync(workspaceRootPath, { recursive: true, force: true });
  });

  function writeWorkspace(permissionMode?: string, pagesEnabled = true) {
    mkdirSync(workspaceRootPath, { recursive: true });
    writeFileSync(join(workspaceRootPath, 'config.json'), JSON.stringify({
      id: 'ws_sched',
      name: 'Scheduled',
      slug: 'ws_sched',
      defaults: { pages: { enabled: pagesEnabled }, ...(permissionMode !== undefined ? { permissionMode } : {}) },
      createdAt: 1,
      updatedAt: 1,
    }));
  }

  const refresh: PageRefreshSpec = {
    cron: '*/10 * * * *',
    script: 'pages/dash/refresh.ts',
    runtime: 'bun',
    grantId: 'grant_refresh01',
  };

  function makePage(overrides: Partial<PageConfig> = {}): PageConfig {
    return {
      schemaVersion: 1,
      id: 'page_1',
      slug: 'dash',
      name: 'Dash',
      kind: 'interactive',
      createdAt: 1,
      updatedAt: 1,
      contentDigest: DIGEST,
      refresh,
      grants: [{
        id: 'grant_refresh01',
        action: { kind: 'script', script: 'pages/dash/refresh.ts', runtime: 'bun' },
        contentDigest: DIGEST,
        createdAt: 1,
        expiresAt: Date.now() + 3_600_000,
      }],
      ...overrides,
    };
  }

  /**
   * Narrowed to the refusal arm where a test is asserting a code. A bare
   * `result.code` would not compile against the success arm, and widening the
   * return type to carry an optional code would let a success silently claim
   * one.
   */
  const admit = (page: PageConfig, grantId = 'grant_refresh01') =>
    admitScheduledPageRefresh({ workspaceRootPath, page, refresh: page.refresh ?? refresh, grantId, auditLogPath });

  async function refusal(page: PageConfig, grantId = 'grant_refresh01') {
    const result = await admit(page, grantId);
    expect(result.ok).toBe(false);
    return result as Extract<Awaited<ReturnType<typeof admit>>, { ok: false }>;
  }

  function audit(): Array<Record<string, unknown>> {
    if (!existsSync(auditLogPath)) return [];
    return readFileSync(auditLogPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('admits an approved, current refresh grant and audits it as render-free', async () => {
    expect((await admit(makePage())).ok).toBe(true);
    const admitted = audit().find((e) => e.event === 'page_action_admitted');
    expect(admitted?.origin).toBe('scheduled-refresh');
    expect(admitted?.workspaceId).toBe('ws_sched');
    // Stated rather than implied: no lease was invented for a run that has no
    // render, so the log does not claim one was checked.
    expect(admitted?.renderBound).toBe(false);
  });

  it('refuses a revoked grant', async () => {
    const result = await refusal(makePage({ grants: [] }));
    expect(result.code).toBe('grant-not-found');
    expect(audit().some((e) => e.event === 'page_action_rejected')).toBe(true);
  });

  it('refuses a grant bound to older content', async () => {
    expect((await refusal(makePage({ contentDigest: 'b'.repeat(64) }))).code).toBe('grant-stale');
  });

  it('refuses an expired grant', async () => {
    const page = makePage();
    page.grants![0]!.expiresAt = Date.now() - 1;
    expect((await refusal(page)).code).toBe('grant-expired');
  });

  it('refuses when the matcher names a grant the page no longer declares', async () => {
    expect((await refusal(makePage(), 'grant_someone_else')).code).toBe('grant-not-found');
  });

  it('refuses a descriptor that no longer matches the approved command', async () => {
    const page = makePage();
    page.grants![0]!.action = { kind: 'script', script: 'pages/dash/evil.ts', runtime: 'bun' };
    expect((await refusal(page)).code).toBe('grant-stale');
  });

  it('refuses a non-script grant, so the activation exemption cannot be borrowed', async () => {
    const page = makePage();
    page.grants![0]!.action = { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '.*' };
    // The scheduled origin skips activation because a cron tick has no click;
    // that exemption must never become a route for api or mcp writes. The
    // trigger is a script invocation, so an api grant mismatches outright.
    expect((await refusal(page)).code).toBe('grant-mismatch');
  });

  it('refuses in Explore, and re-reads the mode per run', async () => {
    expect((await admit(makePage())).ok).toBe(true);
    writeWorkspace('safe');
    expect((await refusal(makePage())).code).toBe('permission-mode-forbidden');
  });

  it('treats an unset permission mode as the product default, not as Explore', async () => {
    // Most workspaces never set this. Reading absence as Explore would stop
    // every scheduled refresh in all of them, which is a silent outage, not
    // caution.
    writeWorkspace(undefined);
    expect((await admit(makePage())).ok).toBe(true);
  });

  it('refuses once Pages is turned off, even from a stale matcher', async () => {
    // Matchers are rebuilt from disk on config change, but a tick already in
    // flight — or a rebuild that has not happened yet — must not get one more
    // run out of the old schedule. The capability is re-read per run.
    expect((await admit(makePage())).ok).toBe(true);
    writeWorkspace('ask', false);
    const result = await refusal(makePage());
    expect(result.code).toBe('pages-disabled');
  });

  it('refuses a corrupted permission mode, while still allowing an absent one', async () => {
    // Absent is a legacy workspace that never set the field; the product
    // contract says `ask`. A value that is PRESENT but unrecognized is
    // corruption or a downgrade — something was stored and cannot be honoured,
    // and an unhonourable restriction has to read as the most restrictive one.
    writeWorkspace(undefined);
    expect((await admit(makePage())).ok).toBe(true);

    for (const corrupt of ['SAFE', 'explore', 'read-only', '']) {
      writeWorkspace(corrupt);
      expect((await refusal(makePage())).code).toBe('permission-mode-forbidden');
    }
  });

  it('audits no script path or arguments', async () => {
    const page = makePage();
    page.grants![0]!.action = {
      kind: 'script',
      script: 'pages/dash/refresh.ts',
      runtime: 'bun',
      args: ['--token', 'sk-super-secret'],
    };
    page.refresh = { ...refresh, args: ['--token', 'sk-super-secret'] };
    await admit(page);
    expect(JSON.stringify(audit())).not.toContain('sk-super-secret');
  });
});
