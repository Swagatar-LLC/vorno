/**
 * fork(PLAN-031) — drift guards for the built-in status set.
 *
 * Regression coverage for a defect that was invisible for exactly this reason: five places
 * asserted "the built-in statuses" independently, and `getDefaultStatusConfig` silently disagreed
 * with the other four about `in-progress`. Sessions set to it read back as `todo`, so a running
 * task looked like an untouched one.
 *
 * Each guard below is written to fail if a consumer drifts from `BUILT_IN_STATUSES`. Guards that
 * only assert against themselves are worthless — PLAN-030 Phase 0 shipped one such tautology — so
 * the mutation checks at the bottom prove these actually fail when the invariant breaks.
 */

import { describe, it, expect } from 'bun:test';
import { BUILT_IN_STATUSES, BUILT_IN_STATUS_IDS, DEFAULT_STATUS_ID, isBuiltInStatusId } from './built-in.ts';
import { getDefaultStatusConfig, backfillBuiltInStatuses } from './storage.ts';
import { DEFAULT_ICON_SVGS } from './default-icons.ts';
import type { WorkspaceStatusConfig, StatusConfig } from './types.ts';

describe('BUILT_IN_STATUSES', () => {
  it('contains in-progress — the status whose absence started PLAN-031', () => {
    expect(BUILT_IN_STATUS_IDS).toContain('in-progress');
  });

  it('has unique ids', () => {
    expect(new Set(BUILT_IN_STATUS_IDS).size).toBe(BUILT_IN_STATUS_IDS.length);
  });

  it('has order values matching array position', () => {
    // `as const` narrows `order` to literal types, so compare as plain numbers.
    BUILT_IN_STATUSES.forEach((s, i) => expect(s.order as number).toBe(i));
  });

  it('keeps the three statuses validateStatusConfig requires as isFixed', () => {
    // validateStatusConfig (storage.ts) rejects a config lacking these as fixed and falls back to
    // defaults wholesale — so flipping isFixed here would make every real config unloadable.
    for (const id of ['todo', 'done', 'cancelled']) {
      expect(BUILT_IN_STATUSES.find(s => s.id === id)?.isFixed).toBe(true);
    }
  });

  it('marks in-progress undeletable but editable', () => {
    // deleteStatus refuses isFixed OR isDefault; updateStatus allows relabel/recolor unless isFixed.
    // TaskRunner hardcodes the id, so it must not be deletable — but a user may rename it.
    const inProgress = BUILT_IN_STATUSES.find(s => s.id === 'in-progress');
    expect(inProgress?.isDefault).toBe(true);
    expect(inProgress?.isFixed).toBe(false);
  });

  it('names a default status that exists in the set', () => {
    expect(BUILT_IN_STATUS_IDS).toContain(DEFAULT_STATUS_ID);
  });
});

describe('consumer drift guards', () => {
  it('getDefaultStatusConfig emits exactly the built-in set, in order', () => {
    const config = getDefaultStatusConfig();
    expect(config.statuses.map(s => s.id)).toEqual([...BUILT_IN_STATUS_IDS]);
    expect(config.defaultStatusId).toBe(DEFAULT_STATUS_ID);
  });

  it('getDefaultStatusConfig returns copies, not references into BUILT_IN_STATUSES', () => {
    // The default config is handed to callers who may mutate it (backfill renumbers `order` in
    // place). Sharing object identity with the frozen source of truth would corrupt it process-wide.
    const a = getDefaultStatusConfig();
    const b = getDefaultStatusConfig();
    a.statuses[0]!.label = 'MUTATED';
    expect(b.statuses[0]!.label).not.toBe('MUTATED');
    expect(BUILT_IN_STATUSES[0]!.label).not.toBe('MUTATED');
  });

  it('DEFAULT_ICON_SVGS covers every built-in status id', () => {
    const missing = BUILT_IN_STATUS_IDS.filter(id => !(id in DEFAULT_ICON_SVGS));
    expect(missing).toEqual([]);
  });

  it('isBuiltInStatusId accepts built-ins and rejects custom ids', () => {
    expect(isBuiltInStatusId('in-progress')).toBe(true);
    expect(isBuiltInStatusId('my-custom-status')).toBe(false);
  });
});

/**
 * Guard-the-guards. Each check above must FAIL when its invariant is violated; these mutate a
 * local copy and assert the guard's own predicate flips. Without these, a guard that accidentally
 * compares a value to itself passes forever and protects nothing.
 */
describe('drift guards fail on mutation', () => {
  it('the icon-coverage guard fails when an icon is missing', () => {
    const icons: Record<string, string> = { ...DEFAULT_ICON_SVGS };
    delete icons['in-progress'];
    const missing = BUILT_IN_STATUS_IDS.filter(id => !(id in icons));
    expect(missing).toEqual(['in-progress']);
  });

  it('the getDefaultStatusConfig guard fails when the generator drops a status', () => {
    const mutated = getDefaultStatusConfig();
    mutated.statuses = mutated.statuses.filter(s => s.id !== 'in-progress');
    expect(mutated.statuses.map(s => s.id)).not.toEqual([...BUILT_IN_STATUS_IDS]);
  });

  it('the order guard fails when positions drift', () => {
    const mutated: StatusConfig[] = getDefaultStatusConfig().statuses;
    mutated[2]!.order = 99;
    expect(mutated.every((s, i) => s.order === i)).toBe(false);
  });
});

describe('backfillBuiltInStatuses', () => {
  const config = (ids: string[]): WorkspaceStatusConfig => ({
    version: 1,
    statuses: ids.map((id, i) => {
      const builtIn = BUILT_IN_STATUSES.find(s => s.id === id);
      return builtIn
        ? { ...builtIn, order: i }
        : { id, label: id, category: 'open' as const, isFixed: false, isDefault: false, order: i };
    }),
    defaultStatusId: 'todo',
  });

  it('is a no-op on a config that already has every built-in', () => {
    const c = config([...BUILT_IN_STATUS_IDS]);
    const before = JSON.stringify(c);
    expect(backfillBuiltInStatuses(c)).toBe(false);
    expect(JSON.stringify(c)).toBe(before);
  });

  it('adds in-progress to a pre-PLAN-031 config', () => {
    const c = config(['backlog', 'todo', 'needs-review', 'done', 'cancelled']);
    expect(backfillBuiltInStatuses(c)).toBe(true);
    expect(c.statuses.map(s => s.id)).toEqual([
      'backlog',
      'todo',
      'in-progress',
      'needs-review',
      'done',
      'cancelled',
    ]);
  });

  it('inserts at the canonical position, not the end', () => {
    // The whole point: appending would put "In Progress" after "Cancelled" in every status menu.
    const c = config(['backlog', 'todo', 'needs-review', 'done', 'cancelled']);
    backfillBuiltInStatuses(c);
    expect(c.statuses.findIndex(s => s.id === 'in-progress')).toBeLessThan(
      c.statuses.findIndex(s => s.id === 'done')
    );
  });

  it('is idempotent — a second call changes nothing', () => {
    const c = config(['todo', 'done', 'cancelled']);
    expect(backfillBuiltInStatuses(c)).toBe(true);
    const after = JSON.stringify(c);
    expect(backfillBuiltInStatuses(c)).toBe(false);
    expect(JSON.stringify(c)).toBe(after);
  });

  it('never overwrites a user-authored version of a built-in', () => {
    // The common real-world case: someone hand-added `in-progress` to work around the missing
    // default (Jeff's live workspace did exactly this, with different flags). Backfill must leave
    // every field alone — including flags that disagree with ours.
    const c = config(['todo', 'done', 'cancelled']);
    c.statuses.splice(1, 0, {
      id: 'in-progress',
      label: 'Doing',
      category: 'open',
      isFixed: false,
      isDefault: false,
      order: 99,
      color: 'info',
    });
    backfillBuiltInStatuses(c);
    const inProgress = c.statuses.find(s => s.id === 'in-progress')!;
    expect(inProgress.label).toBe('Doing');
    expect(inProgress.color).toBe('info');
    expect(inProgress.isDefault).toBe(false);
  });

  it('preserves custom statuses and their relative order', () => {
    const c = config(['todo', 'blocked-on-review', 'done', 'cancelled']);
    backfillBuiltInStatuses(c);
    const ids = c.statuses.map(s => s.id);
    expect(ids).toContain('blocked-on-review');
    expect(ids.indexOf('todo')).toBeLessThan(ids.indexOf('blocked-on-review'));
    expect(ids.indexOf('blocked-on-review')).toBeLessThan(ids.indexOf('done'));
  });

  it('renumbers order contiguously after inserting', () => {
    const c = config(['todo', 'done', 'cancelled']);
    backfillBuiltInStatuses(c);
    c.statuses.forEach((s, i) => expect(s.order).toBe(i));
  });

  it('backfills an empty status list to the full built-in set', () => {
    const c: WorkspaceStatusConfig = { version: 1, statuses: [], defaultStatusId: 'todo' };
    expect(backfillBuiltInStatuses(c)).toBe(true);
    expect(c.statuses.map(s => s.id)).toEqual([...BUILT_IN_STATUS_IDS]);
  });
});
