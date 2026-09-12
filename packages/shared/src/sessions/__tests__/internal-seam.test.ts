/**
 * SUV-0066 — the two deliberately-internal seams, and the contracts that make
 * them safe to have at all.
 *
 * Both exist because a barrel export is the surface code actually uses: what is
 * on it gets used, and what is off it has to be meant. Neither is a capability
 * boundary — this is TypeScript — so each is additionally narrowed by something
 * that holds at RUNTIME.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as sessionsBarrel from '../index.ts';
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
      installSingletonCommitHooksForTesting(later);
      // A second call on the spent disposer must not touch the new owner.
      dispose();
      expect(currentHooks()).toBe(later);
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
      });
    });
  });
});
