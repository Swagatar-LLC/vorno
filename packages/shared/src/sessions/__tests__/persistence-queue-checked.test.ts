/**
 * SUV-0064 — the checked persistence receipt.
 *
 * `flush` cannot report a failed write: `write` catches its own errors so the
 * queue's many fire-and-forget callers keep working. `flushChecked` is the
 * opt-in way to ask, and a caller that tells a user "delivered and saved"
 * depends on it never answering optimistically.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionPersistenceQueue } from '../persistence-queue.ts';
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
