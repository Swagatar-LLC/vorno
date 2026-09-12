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
      queue.cancelForDeletion('c0');

      expect(await handle.receipt).toMatchObject({ ok: false });
      expect(existsSync(getSessionFilePath(root, 'c0'))).toBe(false);
    });

    it('abandons a write cancelled during the unlink boundary', async () => {
      // Real writes take measurable time and a cancel genuinely lands
      // mid-commit; an in-memory suite's writes settle far too fast to hit that
      // by timing. The hook makes the window deterministic.
      queue.commitHooks = { beforeUnlink: (id) => { queue.cancelForDeletion(id) } };
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
        beforeRename: (id) => { queue.cancelForDeletion(id) },
        afterRename: () => { renamed = true },
      };
      const handle = write('c2');
      await handle.tail;

      expect(renamed).toBe(false);
      expect(await handle.receipt).toMatchObject({ ok: false });
      expect(existsSync(getSessionFilePath(root, 'c2'))).toBe(false);
      expect(existsSync(getSessionFilePath(root, 'c2') + '.tmp')).toBe(false);
    });

    it('removes the artifact when a DELETION lands AFTER the rename committed', async () => {
      // The case a single pre-commit check misses entirely: the bytes are
      // already on disk for a session the caller has deleted. The receipt must
      // not say "cancelled" while that artifact could survive, so removal
      // happens before the receipt settles and before the tail releases.
      queue.commitHooks = { afterRename: (id) => { queue.cancelForDeletion(id) } };
      const handle = write('c3');
      await handle.tail;

      expect(await handle.receipt).toMatchObject({ ok: false });
      expect(existsSync(getSessionFilePath(root, 'c3'))).toBe(false);
      expect(existsSync(getSessionFilePath(root, 'c3') + '.tmp')).toBe(false);
    });

    it('KEEPS the artifact when a SUPERSEDE lands after the rename committed', async () => {
      // The same instant, the opposite correct answer. A supersede's caller has
      // absorbed an external metadata edit and is about to write merged state
      // over this file; the session is live. Unlinking here would delete a real
      // transcript and leave the session absent from disk until the replacement
      // write lands — and if the process died in that window, it would be gone.
      //
      // The write is still cancelled: its receipt says so, and the bytes it
      // committed are simply left for the next write to replace.
      queue.commitHooks = { afterRename: (id) => { queue.supersedePendingWrites(id) } };
      const handle = write('c8', (r) => { r.name = 'superseded'; });
      await handle.tail;

      expect(await handle.receipt).toMatchObject({ ok: false });
      const file = getSessionFilePath(root, 'c8');
      expect(existsSync(file)).toBe(true);
      // Not merely present — present with real content, so this cannot pass on
      // an empty or truncated file.
      expect(readFileSync(file, 'utf-8')).toContain('"name":"superseded"');
      // The scratch file is this generation's own and goes under either intent.
      expect(existsSync(file + '.tmp')).toBe(false);
    });

    it('a supersede arriving after a deletion cannot un-delete the session', async () => {
      // The two callers do not know about each other, so the intent has to be
      // sticky rather than last-writer-wins: nothing un-deletes a session, and
      // a watcher event landing just after a delete must not rescue its file.
      queue.commitHooks = {
        afterRename: (id) => {
          queue.cancelForDeletion(id);
          queue.supersedePendingWrites(id);
        },
      };
      const handle = write('c10');
      await handle.tail;

      expect(await handle.receipt).toMatchObject({ ok: false });
      expect(existsSync(getSessionFilePath(root, 'c10'))).toBe(false);
    });

    it('a deletion arriving after a supersede still discards the artifact', async () => {
      // The same rule read from the other direction, so the test does not pass
      // merely because one ordering happens to be the one implemented.
      queue.commitHooks = {
        afterRename: (id) => {
          queue.supersedePendingWrites(id);
          queue.cancelForDeletion(id);
        },
      };
      const handle = write('c11');
      await handle.tail;

      expect(await handle.receipt).toMatchObject({ ok: false });
      expect(existsSync(getSessionFilePath(root, 'c11'))).toBe(false);
    });

    it('a supersede leaves the session file present once the write has finished', async () => {
      // The failure this split exists to prevent, stated as the property that
      // matters to a user: a live session's file is still there afterwards.
      write('c9', (r) => { r.name = 'original'; });
      await queue.driveChecked('c9');
      const file = getSessionFilePath(root, 'c9');
      expect(existsSync(file)).toBe(true);

      queue.commitHooks = { beforeUnlink: (id) => { queue.supersedePendingWrites(id) } };
      const handle = write('c9', (r) => { r.name = 'stale'; });
      await handle.tail;

      expect(await handle.receipt).toMatchObject({ ok: false });
      expect(existsSync(file)).toBe(true);
      // The superseded write was cancelled before its rename, so the ORIGINAL
      // content survives intact — the stale state never reached disk.
      expect(readFileSync(file, 'utf-8')).toContain('"name":"original"');
      expect(readFileSync(file, 'utf-8')).not.toContain('"name":"stale"');
    });

    it('settles an outstanding handle instead of leaving it to hang', async () => {
      // The hang regression, with a real 1.5s bound so it fails rather than
      // stalling the suite. `cancelForDeletion` empties `pending`, and `write` returns
      // early with nothing pending WITHOUT settling anything — so a handle held
      // across a cancel would be answered by nobody, ever.
      const handle = queue.enqueueChecked(session('c4'));
      queue.cancelForDeletion('c4');

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
      queue.cancelForDeletion('c5');
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
      queue.cancelForDeletion('c7');

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
        queue.cancelForDeletion(`gone-${i}`);
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

    it('drops the signature baseline on deletion', () => {
      // The session is going away, so the baseline goes with it.
      queue.enqueueChecked(session('sig3'));
      queue.cancelForDeletion('sig3');
      expect(queue.getLastWrittenSignature('sig3')).toBeUndefined();
    });

    it('a stale write that commits after the watcher read cannot eat the edit', async () => {
      // The narrow window the supersede split left open, and the reason the
      // observed header has to travel with the call.
      //
      // Ordering: generation G reads the header, THEN the external edit lands,
      // THEN the watcher sees it and supersedes, THEN G's rename commits its
      // pre-edit snapshot over the edit. Supersede (correctly) keeps that file,
      // so disk no longer holds the edit — and the baseline now equals the
      // stale file's own signature, so the next write detects no divergence.
      // Merging "from disk" cannot recover this; the edit only still exists in
      // what the watcher observed.
      await write('race1').tail;
      const file = getSessionFilePath(root, 'race1');

      const externalEdit = () => {
        const lines = readFileSync(file, 'utf-8').split('\n');
        const header = JSON.parse(lines[0]!) as Record<string, unknown>;
        // `lastReadMessageId` is merge-only: unlike labels/name, nothing copies
        // it into the caller's in-memory session, so the merge is the sole path
        // by which it can survive.
        header.lastReadMessageId = 'external-only';
        writeFileSync(file, [JSON.stringify(header), ...lines.slice(1)].join('\n'));
        return header;
      };

      let observed: Record<string, unknown> | undefined;
      queue.commitHooks = {
        // After G computed its header: the edit lands on disk now, so G's
        // snapshot predates it.
        beforeUnlink: () => { observed = externalEdit(); },
        // The watcher notices and supersedes while G is mid-commit.
        afterRename: (id) => { queue.supersedePendingWrites(id, observed as never); },
      };
      await write('race1').tail;
      queue.commitHooks = undefined;

      // G's stale file is on disk (correctly kept — the session is live). The
      // replacement write must still land the observed edit.
      await write('race1').tail;

      const after = JSON.parse(readFileSync(file, 'utf-8').split('\n')[0]!) as Record<string, unknown>;
      expect(after.lastReadMessageId).toBe('external-only');
    });

    it('KEEPS the signature baseline through a supersede', async () => {
      // The other half of the asymmetry, and the one with teeth. A supersede
      // fires precisely because an external metadata edit was detected, and the
      // baseline is the input to `write`'s external-change detection — which is
      // the only thing that preserves `labels`, `isFlagged`, `permissionMode`,
      // `hasUnread` and `lastReadMessageId`. Drop it here and the very next
      // write concludes nothing external changed and clobbers the edit this
      // call exists to protect.
      await write('sig4').tail;
      expect(queue.getLastWrittenSignature('sig4')).toBeDefined();

      queue.supersedePendingWrites('sig4');
      expect(queue.getLastWrittenSignature('sig4')).toBeDefined();
    });

    it('preserves an external label edit across a supersede-then-write cycle', async () => {
      // End to end, through the real merge rather than through the baseline as
      // a value: `labels` is one of the five fields SessionManager's own
      // reconciliation does not carry, so the merge is the only thing that can
      // save it.
      await write('sig5').tail;
      const file = getSessionFilePath(root, 'sig5');

      // Somebody else edits the header on disk.
      const lines = readFileSync(file, 'utf-8').split('\n');
      const header = JSON.parse(lines[0]!) as Record<string, unknown>;
      header.labels = ['external-only'];
      writeFileSync(file, [JSON.stringify(header), ...lines.slice(1)].join('\n'));

      // The watcher path: stop stale writes, then persist local state that has
      // never heard of that label. Local CONTENT, not local metadata — when an
      // external change is detected the merge takes all seven metadata fields
      // from disk by design ("disk preserved"), so a concurrent local rename
      // would legitimately lose and would say nothing about the baseline.
      queue.supersedePendingWrites('sig5');
      await write('sig5', (r) => {
        (r as unknown as { messages: unknown[] }).messages = [{ role: 'user', content: 'local content' }];
      }).tail;

      const contents = readFileSync(file, 'utf-8');
      const after = JSON.parse(contents.split('\n')[0]!) as Record<string, unknown>;
      expect(after.labels).toEqual(['external-only']);
      expect(contents).toContain('local content');
    });
  });
});
