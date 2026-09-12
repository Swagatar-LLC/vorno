/**
 * SUV-0064 — the checked persistence receipt.
 *
 * `flush` cannot report a failed write: `write` catches its own errors so the
 * queue's many fire-and-forget callers keep working. `flushChecked` is the
 * opt-in way to ask, and a caller that tells a user "delivered and saved"
 * depends on it never answering optimistically.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionPersistenceQueue } from '../persistence-queue.ts';
import { getSessionFilePath } from '../storage.ts';
import type { StoredSession } from '../types.ts';

describe('SessionPersistenceQueue.flushChecked', () => {
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
   * rather than a synthetic bad path, and it exercises the same catch.
   */
  function blockedRoot(): string {
    const blocker = join(root, 'blocker');
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

  it('reports success for a write that really lands', async () => {
    queue.enqueue(session('s1'));
    await expect(queue.flushChecked('s1')).resolves.toEqual({ ok: true });
  });

  it('reports the failure for a write that cannot land', async () => {
    // An unwritable workspace root: the write throws inside the queue, which
    // catches it — so `flush` would resolve as if nothing were wrong.
    const broken = session('s2');
    (broken as unknown as { workspaceRootPath: string }).workspaceRootPath = blockedRoot();
    queue.enqueue(broken);

    const receipt = await queue.flushChecked('s2');
    expect(receipt.ok).toBe(false);
    expect(receipt.ok === false && receipt.error.length > 0).toBe(true);
  });

  it('does not report success while a write is still in flight', async () => {
    // `write` removes its pending entry BEFORE touching the filesystem, so a
    // checked flush arriving mid-I/O saw an empty queue. Returning `ok` there
    // claimed the bytes were on disk while they were still travelling — and if
    // that write then failed, the claim was simply false.
    // The failure must happen at an ASYNC step, or there is no in-flight window
    // to test: an ENOTDIR from `mkdir` is raised synchronously, so the whole
    // write settles before anything else can observe it. A directory sitting
    // where the temp FILE goes makes `writeFile` fail instead — after the
    // pending entry is already gone and the I/O has genuinely begun.
    mkdirSync(join(root, 'sessions', 's3', 'session.jsonl.tmp'), { recursive: true });
    queue.enqueue(session('s3'));

    // Start a write WITHOUT awaiting it. That clears the pending entry and
    // registers the write as in progress, so the checked flush below finds an
    // empty queue and must wait for the work already in flight. Without that
    // wait it reports success before the failure is even known.
    const inFlight = queue.flush('s3');
    const receipt = await queue.flushChecked('s3');
    await inFlight;

    expect(receipt.ok).toBe(false);
  });

  it('serialises writes so the newest enqueued state is what lands', async () => {
    // Every write for a session shares one `.tmp` path, so concurrency there is
    // a correctness problem rather than a fairness one: interleaved writers can
    // rename a half-written temp file over a good session and lose the loser's
    // bytes with no error anywhere. Two writes issued back to back must
    // therefore land in order, with the newest winning.
    const first = session('s5');
    (first as unknown as { name: string }).name = 'older';
    queue.enqueue(first);
    const older = queue.flush('s5');

    const second = session('s5');
    (second as unknown as { name: string }).name = 'newer';
    const receipt = queue.enqueueChecked(second);

    await older;
    expect(await receipt).toEqual({ ok: true });

    const written = readFileSync(getSessionFilePath(root, 's5'), 'utf-8');
    expect(written).toContain('"name":"newer"');
  });

  it('ties a receipt to its own generation, not to somebody else\'s success', async () => {
    // A receipt is satisfied by ITS generation or a later one — a newer
    // snapshot contains this one — but never by an older write completing,
    // which would let a caller borrow an answer it had not earned.
    mkdirSync(join(root, 'sessions', 's6', 'session.jsonl.tmp'), { recursive: true });
    const failing = queue.enqueueChecked(session('s6'));
    expect(await failing).toMatchObject({ ok: false });

    // Clear the blockage; the next generation gets its own, honest answer.
    rmSync(join(root, 'sessions', 's6', 'session.jsonl.tmp'), { recursive: true, force: true });
    expect(await queue.enqueueChecked(session('s6'))).toEqual({ ok: true });
  });

  it('settles waiting receipts when a session is cancelled', async () => {
    // A cancelled session will never write. Anything waiting on it has to be
    // told, or it hangs for the life of the process.
    queue.enqueue(session('s7'));
    const receipt = queue.flushChecked('s7');
    queue.cancel('s7');
    expect(await receipt).toMatchObject({ ok: false });
  });

  it('does not commit a write cancelled after it was queued onto the tail', async () => {
    // `flush` chains onto the tail, so the write begins on a microtask — a
    // cancel arriving first must stop it. This covers the cancel-before-start
    // case.
    //
    // The pre-rename check in `write` covers a DIFFERENT case: a cancel landing
    // mid-I/O, after the temp file is written. That one is deliberately not
    // asserted here, because this suite cannot construct it deterministically —
    // the writes settle far too quickly — and a test that appeared to cover it
    // would be worse than none. It is belt-and-braces for a real filesystem
    // where `writeFile` takes measurable time.
    queue.enqueue(session('s8'));
    const running = queue.flush('s8');
    queue.cancel('s8');
    await running;

    expect(existsSync(getSessionFilePath(root, 's8'))).toBe(false);
    // And no temp file left behind for a later reader to misread.
    expect(existsSync(getSessionFilePath(root, 's8') + '.tmp')).toBe(false);
  });

  it('writes again normally after a cancelled session is re-enqueued', () => {
    // A cancel must not suppress every future write for the life of the
    // process — a fresh enqueue means the session is live again.
    queue.enqueue(session('s9'));
    queue.cancel('s9');
    const cancelledState = (queue as unknown as { cancelled: Set<string> }).cancelled;
    expect(cancelledState.has('s9')).toBe(true);

    queue.enqueue(session('s9'));
    expect(cancelledState.has('s9')).toBe(false);
  });

  it('keeps reporting failure until a later write succeeds', async () => {
    const broken = session('s4');
    (broken as unknown as { workspaceRootPath: string }).workspaceRootPath = blockedRoot();
    queue.enqueue(broken);
    expect((await queue.flushChecked('s4')).ok).toBe(false);

    // Nothing pending now, but the last attempt failed — the session's state is
    // still not durable, and saying otherwise would be the optimistic answer
    // this exists to prevent.
    expect((await queue.flushChecked('s4')).ok).toBe(false);

    queue.enqueue(session('s4'));
    expect((await queue.flushChecked('s4')).ok).toBe(true);
  });
});
