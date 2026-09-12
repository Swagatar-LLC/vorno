/**
 * SUV-0066 — the two deliberately-internal seams, and the contracts that make
 * them safe to have at all.
 *
 * Both exist because a barrel export is the surface code actually uses: what is
 * on it gets used, and what is off it has to be meant. Neither is a capability
 * boundary — this is TypeScript — so each is additionally narrowed by something
 * that holds at RUNTIME.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sessionsBarrel from '../index.ts';
import { getSessionFilePath, saveSession } from '../storage.ts';
import {
  currentSingletonCommitHooksForTesting as currentHooks,
  installSingletonCommitHooksForTesting,
  listSessionsWithPendingPlan,
} from '../internal.ts';
import { sessionPersistenceQueue } from '../persistence-queue.ts';

describe('internal session seams', () => {
  afterEach(() => {
    sessionPersistenceQueue.reopenAfterFlushAll();
  });

  describe('what the barrel does and does not offer', () => {
    it('keeps the pending-plan reader and the hook seam OFF the barrel', () => {
      // The point of the split. If either of these ever appears here, the
      // narrowing is gone and the next caller will find it by autocomplete.
      expect('listSessionsWithPendingPlan' in sessionsBarrel).toBe(false);
      expect('installSingletonCommitHooksForTesting' in sessionsBarrel).toBe(false);
      expect('setSingletonCommitHooksForTesting' in sessionsBarrel).toBe(false);
    });

    it('still offers the safe list readers', () => {
      // The strip is only useful if the stripped path is the convenient one.
      expect(typeof sessionsBarrel.listSessions).toBe('function');
      expect(typeof sessionsBarrel.listActiveSessions).toBe('function');
      expect(typeof sessionsBarrel.listArchivedSessions).toBe('function');
      expect(typeof listSessionsWithPendingPlan).toBe('function');
    });
  });

  describe('commit hook ownership', () => {
    it('a disposer restores the owner it displaced, not whatever is current', () => {
      // The failure this prevents: one suite's `afterEach` running late and
      // clearing a LATER suite's hooks, which silently removes the seam the
      // second suite depends on and makes its assertions vacuous.
      const first = { beforeUnlink: () => {} };
      const second = { beforeRename: () => {} };

      const disposeFirst = installSingletonCommitHooksForTesting(first);
      const disposeSecond = installSingletonCommitHooksForTesting(second);

      // The stale disposer fires while a newer owner holds the seam.
      disposeFirst();
      expect(currentHooks()).toBe(second);

      // The newer owner's disposer unwinds to what IT displaced — which is the
      // first owner, still in the chain but no longer restorable by itself.
      disposeSecond();
      expect(currentHooks()).toBeUndefined();
    });

    it('is idempotent, so a double teardown cannot strip a successor', () => {
      const mine = { afterRename: () => {} };
      const dispose = installSingletonCommitHooksForTesting(mine);
      dispose();
      expect(currentHooks()).toBeUndefined();

      const later = { afterRename: () => {} };
      const disposeLater = installSingletonCommitHooksForTesting(later);
      // A second call on the spent disposer must not touch the new owner.
      dispose();
      expect(currentHooks()).toBe(later);

      // Leave the seam as we found it — a leaked owner is precisely what this
      // contract exists to prevent, so the test must not create one.
      disposeLater();
      expect(currentHooks()).toBeUndefined();
    });
  });

  describe('the test-runner guard', () => {
    it('admits only NODE_ENV=test, because Bun.jest is present in plain bun too', () => {
      // Probed rather than assumed: `typeof Bun.jest` is 'function' under plain
      // `bun run` as well as `bun test`, so an earlier version of this guard
      // admitted every plain-bun process — which is the production case for the
      // headless server and pi-agent-server. `BUN_TEST` is unset in both.
      expect(typeof (globalThis as { Bun?: { jest?: unknown } }).Bun?.jest).toBe('function');
      expect(process.env.NODE_ENV).toBe('test');

      // With the only accepted signal removed, the seam refuses — the guard is
      // positive (admit a known test env) rather than negative (block a known
      // production one), so an unset environment must refuse.
      const saved = process.env.NODE_ENV;
      const before = currentHooks();
      try {
        delete process.env.NODE_ENV;
        expect(() => installSingletonCommitHooksForTesting({ afterRename: () => {} })).toThrow(
          /test-only/,
        );
        // Hooks UNCHANGED, which is the requirement: a refused install must not
        // half-apply. Asserted against what was there rather than against
        // undefined, so the claim holds whatever the suite left installed.
        expect(currentHooks()).toBe(before);
      } finally {
        process.env.NODE_ENV = saved;
      }
    });
  });

  describe('saveSession keeps its promise', () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'save-session-'));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const record = (id: string) => ({
      id,
      workspaceRootPath: root,
      name: 'saved',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }) as never;

    it('resolves only when the bytes are actually on disk', async () => {
      await saveSession(record('ok1'));
      expect(existsSync(getSessionFilePath(root, 'ok1'))).toBe(true);
      expect(readFileSync(getSessionFilePath(root, 'ok1'), 'utf-8')).toContain('"name":"saved"');
    });

    it('REJECTS during a shutdown drain instead of reporting a save it did not make', async () => {
      // The defect this closes. `enqueue` is refused once closing, which leaves
      // nothing queued — and `flush` returns immediately for a key with no
      // queued work and no tail. So the old fire-and-forget pair resolved
      // happily having written nothing, and every awaiting caller (a pending
      // plan write, a status or label mutation, an in-flight RPC or tool call)
      // was told it had succeeded.
      await sessionPersistenceQueue.flushAll();
      expect(sessionPersistenceQueue.isClosing).toBe(true);

      await expect(saveSession(record('refused1'))).rejects.toThrow(/queue is closing/);
      // And the claim matches the disk: no file was written.
      expect(existsSync(getSessionFilePath(root, 'refused1'))).toBe(false);
    });

    it('rejects when the write genuinely fails', async () => {
      // Not only the closing case: any bad receipt has to surface. A directory
      // where the temp file goes makes the write throw.
      mkdirSync(join(root, 'sessions', 'fail1'), { recursive: true });
      mkdirSync(join(root, 'sessions', 'fail1', 'session.jsonl.tmp'), { recursive: true });

      await expect(saveSession(record('fail1'))).rejects.toThrow(/Failed to save session fail1/);
    });
  });

  describe('shutdown honesty', () => {
    it('refuses a checked write once closing, with a receipt that says so', async () => {
      await sessionPersistenceQueue.flushAll();
      expect(sessionPersistenceQueue.isClosing).toBe(true);

      const handle = sessionPersistenceQueue.enqueueChecked({
        id: 'refused-after-close',
        workspaceRootPath: '/nonexistent-on-purpose',
        messages: [],
      } as never);

      // Refused and TOLD, rather than silently dropped — a caller that believes
      // it saved something is worse off than one that is told it did not.
      await expect(handle.receipt).resolves.toEqual({
        ok: false,
        error: 'session write refused: queue is closing',
        reason: 'refused',
      });
    });
  });
});
