import { describe, it, expect } from 'bun:test';
import { handleSetSessionStatus } from './set-session-status.ts';
import type { SessionToolContext } from '../context.ts';

type StatusEntry = { id: string; label: string; category: 'open' | 'closed' };

const STATUSES: StatusEntry[] = [
  { id: 'todo', label: 'Todo', category: 'open' },
  { id: 'in-progress', label: 'In Progress', category: 'open' },
  { id: 'needs-review', label: 'Needs Review', category: 'open' },
  { id: 'done', label: 'Done', category: 'closed' },
  { id: 'cancelled', label: 'Cancelled', category: 'closed' },
];

function createCtx(): { ctx: SessionToolContext; sets: Array<{ sessionId?: string; status: string }> } {
  const sets: Array<{ sessionId?: string; status: string }> = [];
  const ctx = {
    setSessionStatus: (sessionId: string | undefined, status: string) => {
      sets.push({ sessionId, status });
    },
    resolveStatus: (input: string) => {
      const available = STATUSES.map((s) => s.id);
      const hit =
        STATUSES.find((s) => s.id === input) ??
        STATUSES.find((s) => s.label.toLowerCase() === input.toLowerCase());
      return hit ? { resolved: hit.id, available, category: hit.category } : { resolved: null, available };
    },
  } as unknown as SessionToolContext;
  return { ctx, sets };
}

describe('handleSetSessionStatus — closed-status guard', () => {
  it('allows an open status (needs-review)', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'needs-review' });
    expect(result.isError).toBeFalsy();
    expect(sets).toEqual([{ sessionId: undefined, status: 'needs-review' }]);
  });

  it('rejects a closed status (done) and does not write it', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'done' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('needs-review');
    expect(sets).toHaveLength(0);
  });

  it('rejects a closed status resolved from a display label (Cancelled)', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'Cancelled' });
    expect(result.isError).toBe(true);
    expect(sets).toHaveLength(0);
  });

  it('still rejects an unknown status', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'banana' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unknown status');
    expect(sets).toHaveLength(0);
  });
});

/**
 * fork(PLAN-030) Phase 1 — the guard above is deliberately UNCHANGED by this phase.
 *
 * Phase 1 makes closure reachable from a `set-status` rule on any event, and it would be
 * an easy misreading to conclude that closure is "unlocked now" and relax this to match.
 * It is a different trust model (ADR-0021 §2): a human writing `allowClosed: true` into
 * `automations.json` and having it reviewed at registration time is declared intent; a
 * model deciding mid-turn is not. These assertions exist so the distinction is pinned
 * rather than assumed.
 */
describe('handleSetSessionStatus — PLAN-030 introduces no bypass', () => {
  it('has no allowClosed escape hatch: an allowClosed-shaped argument is ignored', async () => {
    // `allowClosed` is registration-time only. If it were ever reachable from a tool call,
    // "closing a task is the user's decision" would be a suggestion rather than a rule.
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(
      ctx,
      { status: 'done', allowClosed: true } as unknown as { status: string }
    );
    expect(result.isError).toBe(true);
    expect(sets).toHaveLength(0);
  });

  it('the refusal is unconditional across every closed status', async () => {
    for (const status of STATUSES.filter((s) => s.category === 'closed')) {
      const { ctx, sets } = createCtx();
      const result = await handleSetSessionStatus(ctx, { status: status.id });
      expect(result.isError).toBe(true);
      expect(sets).toHaveLength(0);
    }
  });

  it('the refusal does not depend on which session is targeted', async () => {
    // No "the agent may close a session other than its own" carve-out crept in.
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { sessionId: 'some-other-session', status: 'done' });
    expect(result.isError).toBe(true);
    expect(sets).toHaveLength(0);
  });
});
