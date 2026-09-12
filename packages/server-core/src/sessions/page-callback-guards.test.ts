/**
 * SUV-0064 — the Page callback delivery decision, tested directly.
 *
 * This is the function `SessionManager` runs as `sendMessage`'s `deliveryGuard`,
 * in the same JS turn as the commit. Testing it here rather than only through a
 * fake host is what makes the real host's behavior checkable: the fakes in the
 * executor and RPC suites model this logic, and if they ever drift from it,
 * these are the assertions that stay true.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isSessionFinished, pageCallbackRefusal, type PageCallbackTargetState } from './page-callback-guards.ts';

const WS = 'ws-home';

/** A real workspace root, because the closed-category check reads status config. */
function workspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'page-callback-guard-'));
  mkdirSync(join(root, 'statuses'), { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    id: WS, name: WS, slug: WS, createdAt: 1, updatedAt: 1,
  }));
  return root;
}

const ROOT = workspaceRoot();

function target(over: Partial<PageCallbackTargetState> = {}): PageCallbackTargetState {
  return { workspace: { id: WS, rootPath: ROOT }, isProcessing: false, ...over };
}

describe('pageCallbackRefusal', () => {
  it('delivers to an idle, open, same-workspace session', () => {
    expect(pageCallbackRefusal(target(), WS, false)).toBeNull();
  });

  it('refuses an unknown target', () => {
    expect(pageCallbackRefusal(undefined, WS, false)).toBe('session-not-found');
  });

  it('gives a cross-workspace target the same answer as an unknown one', () => {
    // Distinguishable answers would let a caller enumerate other workspaces'
    // session ids one guess at a time.
    const foreign = target({ workspace: { id: 'ws-other', rootPath: ROOT } });
    expect(pageCallbackRefusal(foreign, WS, false)).toBe(pageCallbackRefusal(undefined, WS, false));
  });

  it('refuses an archived target', () => {
    expect(pageCallbackRefusal(target({ isArchived: true }), WS, false)).toBe('session-closed');
  });

  it('refuses a closed-category status and allows an open one', () => {
    expect(pageCallbackRefusal(target({ sessionStatus: 'done' }), WS, false)).toBe('session-closed');
    expect(pageCallbackRefusal(target({ sessionStatus: 'in-progress' }), WS, false)).toBeNull();
  });

  it('refuses a session mid-turn', () => {
    expect(pageCallbackRefusal(target({ isProcessing: true }), WS, false)).toBe('session-busy');
  });

  it('refuses an aborted delivery before it reports anything about the session', () => {
    // Ordered ahead of the lifecycle checks: a withdrawn action should not
    // report the target's state at all.
    expect(pageCallbackRefusal(target(), WS, true)).toBe('cancelled');
    expect(pageCallbackRefusal(target({ isProcessing: true }), WS, true)).toBe('cancelled');
    expect(pageCallbackRefusal(target({ isArchived: true }), WS, true)).toBe('cancelled');
  });

  it('answers containment before withdrawal', () => {
    // A caller aimed at another workspace learns nothing further, not even
    // whether its own request was still live.
    const foreign = target({ workspace: { id: 'ws-other', rootPath: ROOT } });
    expect(pageCallbackRefusal(foreign, WS, true)).toBe('session-not-found');
  });

});

describe('isSessionFinished', () => {
  it('treats archived and closed-category statuses as finished', () => {
    expect(isSessionFinished(ROOT, { isArchived: true })).toBe(true);
    expect(isSessionFinished(ROOT, { sessionStatus: 'done' })).toBe(true);
    expect(isSessionFinished(ROOT, { sessionStatus: 'cancelled' })).toBe(true);
  });

  it('treats open statuses and an absent status as live', () => {
    expect(isSessionFinished(ROOT, {})).toBe(false);
    expect(isSessionFinished(ROOT, { sessionStatus: 'todo' })).toBe(false);
    expect(isSessionFinished(ROOT, { sessionStatus: 'in-progress' })).toBe(false);
  });

  it('does not consider a busy session finished', () => {
    // The distinction the whole grant/delivery split rests on. Busy is a
    // moment — a session mid-turn now is an ordinary target in a minute — so it
    // refuses at delivery only. Finished is durable, so it refuses at both. If
    // this ever returned true for a processing session, approving a callback
    // would start depending on timing the user cannot see.
    expect(isSessionFinished(ROOT, { sessionStatus: 'in-progress' })).toBe(false);
    expect(pageCallbackRefusal(target({ isProcessing: true }), WS, false)).toBe('session-busy');
  });

  it('is the same predicate delivery uses, so the two cannot disagree', () => {
    for (const state of [{ isArchived: true }, { sessionStatus: 'done' }]) {
      expect(isSessionFinished(ROOT, state)).toBe(true);
      expect(pageCallbackRefusal(target(state), WS, false)).toBe('session-closed');
    }
  });
});

describe('pageCallbackRefusal contract', () => {
  it('is synchronous, which is the property the whole design rests on', () => {
    // An async guard would reintroduce the await window it exists to close, so
    // the contract is asserted rather than left to a comment.
    expect(pageCallbackRefusal(target(), WS, false)).not.toBeInstanceOf(Promise);
    expect(pageCallbackRefusal.constructor.name).toBe('Function');
  });
});
