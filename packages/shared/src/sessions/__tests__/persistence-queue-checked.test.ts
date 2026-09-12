/**
 * SUV-0064 — checked persistence: handles, serialisation, and cancellation.
 *
 * `flush` cannot report a failed write: `write` catches its own errors so the
 * queue's many fire-and-forget callers keep working. A caller that tells a user
 * "delivered and saved" needs the difference, and it asks for it by holding a
 * HANDLE on the write it made — not by asking "is the latest write done", which
 * has no truthful answer once bookkeeping has been retired.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionPersistenceQueue } from '../persistence-queue.ts';
import { getSessionFilePath } from '../storage.ts';
import type { StoredSession } from '../types.ts';

describe('SessionPersistenceQueue checked writes', () => {
  let root: string;
  let queue: SessionPersistenceQueue;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'persist-checked-'));
    // No debounce: the timer path is exercised directly rather than waited on.
    queue = new SessionPersistenceQueue(0);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * A root that cannot hold a sessions directory: a regular FILE sits where the
   * directory would go, so `mkdir` fails with ENOTDIR. A realistic disk failure
   * rather than a synthetic bad path.
   */
  function blockedRoot(): string {
    const blocker = join(root, `blocker-${Math.random().toString(36).slice(2)}`);
    writeFileSync(blocker, 'not a directory');
    return blocker;
  }

  function session(id: string): StoredSession {
    return {
      id,
      workspaceRootPath: root,
      name: 'checked',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as unknown as StoredSession;
  }

  /** Enqueue, drive the tail, and hand back the claim on that exact write. */
  function write(id: string, mutate?: (s: StoredSession) => void) {
    const record = session(id);
    mutate?.(record);
    const handle = queue.enqueueChecked(record);
    // `tail` is the write FINISHING, which is not the same instant as the
    // receipt: an abandoned write settles its receipt and then finishes tidying
    // up after itself, so filesystem assertions have to wait for the tail.
    const tail = queue.driveChecked(id);
    return { ...handle, tail };
  }

  it('reports success for a write that really lands', async () => {
    await expect(write('s1').receipt).resolves.toEqual({ ok: true });
    expect(existsSync(getSessionFilePath(root, 's1'))).toBe(true);
  });

  it('reports the failure for a write that cannot land', async () => {
    const receipt = await write('s2', (s) => {
      (s as unknown as { workspaceRootPath: string }).workspaceRootPath = blockedRoot();
    }).receipt;

    expect(receipt.ok).toBe(false);
    expect(receipt.ok === false && receipt.error.length > 0).toBe(true);
  });

  it('serialises writes so the newest enqueued state is what lands', async () => {
    // Every write for a session shares one `.tmp` path, so concurrency there is
    // a correctness problem rather than a fairness one: interleaved writers can
    // rename a half-written temp file over a good session and lose the loser's
    // bytes with no error anywhere.
    const older = write('s3', (s) => { (s as unknown as { name: string }).name = 'older' });
    const newer = write('s3', (s) => { (s as unknown as { name: string }).name = 'newer' });

    await older.receipt;
    expect(await newer.receipt).toEqual({ ok: true });
    expect(newer.generation).toBeGreaterThan(older.generation);
    expect(readFileSync(getSessionFilePath(root, 's3'), 'utf-8')).toContain('"name":"newer"');
  });

  it('ties a receipt to its own generation, not to somebody else\'s success', async () => {
    mkdirSync(join(root, 'sessions', 's4', 'session.jsonl.tmp'), { recursive: true });
    expect(await write('s4').receipt).toMatchObject({ ok: false });

    // Clear the blockage; the next generation gets its own, honest answer.
    rmSync(join(root, 'sessions', 's4', 'session.jsonl.tmp'), { recursive: true, force: true });
    expect(await write('s4').receipt).toEqual({ ok: true });
  });

  it('keeps failing while the obstruction lasts, and recovers when it clears', async () => {
    // What this proves: a persistently broken session never gets an optimistic
    // receipt, and a fixed one is not stuck reporting the old failure.
    //
    // What it does NOT prove, despite an earlier comment here claiming it: that
    // retirement preserves failure evidence. Each write below fails on its own
    // merits, so the assertions hold whether or not `retireIfQuiescent` keeps
    // `lastWriteFailure`. That invariant is pinned separately, as state.
    mkdirSync(join(root, 'sessions', 'f1', 'session.jsonl.tmp'), { recursive: true });
    expect((await write('f1').receipt).ok).toBe(false);

    await new Promise((r) => setTimeout(r, 10));
    // A fresh handle on the same broken session still reports the failure.
    expect((await write('f1').receipt).ok).toBe(false);

    rmSync(join(root, 'sessions', 'f1', 'session.jsonl.tmp'), { recursive: true, force: true });
    expect((await write('f1').receipt).ok).toBe(true);
  });

  describe('cancellation', () => {
    it('abandons a write cancelled before it starts', async () => {
      const handle = write('c0');
      queue.cancel('c0');

      expect(await handle.receipt).toMatchObject({ ok: false });
      expect(existsSync(getSessionFilePath(root, 'c0'))).toBe(false);
    });

    it('abandons a write cancelled during the unlink boundary', async () => {
      // Real writes take measurable time and a cancel genuinely lands
      // mid-commit; an in-memory suite's writes settle far too fast to hit that
      // by timing. The hook makes the window deterministic.
      queue.commitHooks = { beforeUnlink: (id) => { queue.cancel(id) } };
      const handle = write('c1');
      await handle.tail;

      expect(await handle.receipt).toMatchObject({ ok: false });
      expect(existsSync(getSessionFilePath(root, 'c1'))).toBe(false);
      expect(existsSync(getSessionFilePath(root, 'c1') + '.tmp')).toBe(false);
    });

    it('abandons a write cancelled between the unlink and the rename', async () => {
      // Asserted by whether the RENAME happened at all, not only by the final
      // state on disk: the post-rename check would clean up after a rename that
      // should never have occurred, so a state-only assertion passes with this
      // boundary removed and proves nothing about it.
      let renamed = false;
      queue.commitHooks = {
        beforeRename: (id) => { queue.cancel(id) },
        afterRename: () => { renamed = true },
      };
      const handle = write('c2');
      await handle.tail;

      expect(renamed).toBe(false);
      expect(await handle.receipt).toMatchObject({ ok: false });
      expect(existsSync(getSessionFilePath(root, 'c2'))).toBe(false);
      expect(existsSync(getSessionFilePath(root, 'c2') + '.tmp')).toBe(false);
    });

    it('removes the artifact when the cancel lands AFTER the rename committed', async () => {
      // The case a single pre-commit check misses entirely: the bytes are
      // already on disk for a session the caller has deleted. The receipt must
      // not say "cancelled" while that artifact could survive, so removal
      // happens before the receipt settles and before the tail releases.
      queue.commitHooks = { afterRename: (id) => { queue.cancel(id) } };
      const handle = write('c3');
      await handle.tail;

      expect(await handle.receipt).toMatchObject({ ok: false });
      expect(existsSync(getSessionFilePath(root, 'c3'))).toBe(false);
      expect(existsSync(getSessionFilePath(root, 'c3') + '.tmp')).toBe(false);
    });

    it('settles an outstanding handle instead of leaving it to hang', async () => {
      // The hang regression, with a real 1.5s bound so it fails rather than
      // stalling the suite. `cancel` empties `pending`, and `write` returns
      // early with nothing pending WITHOUT settling anything — so a handle held
      // across a cancel would be answered by nobody, ever.
      const handle = queue.enqueueChecked(session('c4'));
      queue.cancel('c4');

      const answer = await Promise.race([
        handle.receipt,
        new Promise<'hung'>((r) => setTimeout(() => r('hung'), 1_500)),
      ]);
      expect(answer).not.toBe('hung');
      expect(answer).toMatchObject({ ok: false });

      const waiters = (queue as unknown as { receiptWaiters: Map<string, unknown[]> }).receiptWaiters;
      expect(waiters.has('c4')).toBe(false);
    });

    it('a stale in-flight write cannot commit over a newer one', async () => {
      // The reason cancellation is a watermark rather than a flag. With a flag,
      // `enqueue` cleared it, so the stale write — held open here — reached its
      // pre-commit check, found the flag gone, and committed.
      //
      // Neither the final file nor the receipt can show that. The tail
      // serialises, so the newer write lands last either way; and `cancel`
      // settles waiting receipts eagerly, so the stale receipt reads
      // "cancelled" whether or not the write went on to commit. What has to be
      // observed is whether the stale bytes were EVER on disk.
      const file = getSessionFilePath(root, 'c5');
      const observed: string[] = [];
      let holdFirst = true;
      let held!: () => void;
      const holding = new Promise<void>((resolve) => { held = resolve });

      queue.commitHooks = {
        beforeUnlink: () => { if (existsSync(file)) observed.push(readFileSync(file, 'utf-8')) },
        beforeRename: async () => {
          if (!holdFirst) return;
          holdFirst = false;
          await holding;
        },
      };

      const stale = write('c5', (s) => { (s as unknown as { name: string }).name = 'stale' });
      await new Promise((r) => setTimeout(r, 10));
      queue.cancel('c5');
      const fresh = write('c5', (s) => { (s as unknown as { name: string }).name = 'fresh' });

      held();
      await stale.receipt;
      await fresh.receipt;
      queue.commitHooks = undefined;

      expect(observed.some((snapshot) => snapshot.includes('"name":"stale"'))).toBe(false);
      const written = readFileSync(file, 'utf-8');
      expect(written).toContain('"name":"fresh"');
      expect(written).not.toContain('"name":"stale"');
    });

    it('writes again normally after a cancelled session is re-enqueued', async () => {
      // A cancel bounds itself to the generations that existed when it ran, so
      // a later enqueue is simply a higher generation.
      queue.enqueueChecked(session('c7'));
      queue.cancel('c7');

      expect(await write('c7').receipt).toEqual({ ok: true });
      expect(existsSync(getSessionFilePath(root, 'c7'))).toBe(true);
    });
  });

  describe('bookkeeping', () => {
    it('retires per-session state so cancelled sessions do not leak', async () => {
      const baseline = queue.diagnostics();

      for (let i = 0; i < 25; i++) {
        // The tail, not the receipt: retirement is only allowed to run once
        // nothing is in flight, so a snapshot taken while the last write is
        // still finishing would be measuring the wrong instant rather than a
        // leak.
        await write(`gone-${i}`).tail;
        queue.cancel(`gone-${i}`);
      }

      // Every map is keyed by session id, so without retirement each deleted
      // session leaves an entry in all of them for the life of the process.
      expect(queue.diagnostics()).toEqual(baseline);
    });

    it('retirement-keeps-failure-evidence: a failed write is not retired away', async () => {
      // Scope, stated plainly: this pins STATE, not behaviour. With
      // `flushChecked` removed there is no caller that reads `lastWriteFailure`
      // after quiescence — every receipt now belongs to a generation that
      // leaves a pending entry and settles from `write`'s own failure handling.
      // So no black-box assertion can show a wrong ANSWER if the guard goes;
      // what it can show is that the record of the failure still exists, which
      // is the invariant the guard is there to hold for the next reader.
      mkdirSync(join(root, 'sessions', 'ev1', 'session.jsonl.tmp'), { recursive: true });
      expect((await write('ev1').receipt).ok).toBe(false);
      await write('ev1').tail;

      // Quiescent: nothing pending, tail drained, no waiters. Retirement has
      // run and must have declined to take the failure with it.
      expect(queue.diagnostics().lastWriteFailure).toBe(1);

      // And it is not kept forever: a successful write clears it, after which
      // the session retires like any other.
      rmSync(join(root, 'sessions', 'ev1', 'session.jsonl.tmp'), { recursive: true, force: true });
      expect((await write('ev1').receipt).ok).toBe(true);
      await write('ev1').tail;
      expect(queue.diagnostics().lastWriteFailure).toBe(0);
    });

    it('keeps the header-signature baseline across ordinary quiescence', async () => {
      // This one is NOT generation bookkeeping. It is the live baseline for
      // "did somebody else change this header since we last wrote it", and it
      // has to outlive quiescence because that is exactly when an external edit
      // happens. Retiring it would make the next write conclude nothing changed
      // and clobber the other writer, and would strip `ConfigWatcher` of its
      // self-echo baseline.
      await write('sig1').receipt;
      await new Promise((r) => setTimeout(r, 10));

      expect(queue.getLastWrittenSignature('sig1')).toBeDefined();
    });

    it('preserves an external metadata edit made while the queue was idle', async () => {
      await write('sig2', (s) => { (s as unknown as { name: string }).name = 'ours' }).receipt;
      await new Promise((r) => setTimeout(r, 10));

      // Somebody else edits the header on disk while nothing is in flight.
      const file = getSessionFilePath(root, 'sig2');
      const lines = readFileSync(file, 'utf-8').split('\n');
      const header = JSON.parse(lines[0]!) as Record<string, unknown>;
      header.name = 'renamed externally';
      header.labels = ['triage'];
      lines[0] = JSON.stringify(header);
      writeFileSync(file, lines.join('\n'));

      // A later local write carrying only content changes must not revert it.
      await write('sig2', (s) => { (s as unknown as { name: string }).name = 'ours' }).receipt;

      const after = JSON.parse(readFileSync(file, 'utf-8').split('\n')[0]!) as Record<string, unknown>;
      expect(after.name).toBe('renamed externally');
      expect(after.labels).toEqual(['triage']);
    });

    it('drops the signature baseline on explicit cancellation', () => {
      // The session is going away, so the baseline goes with it.
      queue.enqueueChecked(session('sig3'));
      queue.cancel('sig3');
      expect(queue.getLastWrittenSignature('sig3')).toBeUndefined();
    });
  });
});
