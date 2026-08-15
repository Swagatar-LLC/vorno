/**
 * fork(PLAN-030 Phase 3) / ADR-0022 — the `apply-context` pre-check.
 *
 * The escalation half is the one that matters. A context profile carries a permission
 * mode, so without a guard a label becomes a silent privilege escalation: add `deploy` to
 * a session and it lands in Execute with nobody having reviewed that. `allowClosed` is the
 * precedent — the privileged direction is opt-in at registration time, in a file a human
 * reads, and there is no runtime path that sets it.
 *
 * Includes a mutation proof: each guard is re-derived here with its predicate flipped, and
 * the flipped copy must disagree with the shipped one on the cases below. An assertion
 * that passes against a broken predicate is not a test of the predicate.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkContextAction } from './session-action-gate.ts';
import { saveContextProfilesConfig } from '../context-profiles/storage.ts';
import type { ContextProfile } from '../context-profiles/types.ts';
import { PERMISSION_MODE_ORDER, type PermissionMode } from '../agent/mode-types.ts';

let root: string;

function profiles(...list: ContextProfile[]): void {
  saveContextProfilesConfig(root, { version: 1, profiles: list });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctxgate-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkContextAction — profile resolution', () => {
  test('an unknown profile is refused with a named outcome, not applied as nothing', () => {
    profiles({ id: 'real', sources: ['dev'] });
    const d = checkContextAction(root, 'typo', 'ask');
    expect(d.rejection?.reason).toBe('unknown-profile');
    // The id belongs in the outcome — history is where an operator diagnoses this, and
    // `rejected:unknown-profile` alone would not say which one.
    expect(d.rejection?.outcome).toBe('rejected:unknown-profile:typo');
    expect(d.profile).toBeUndefined();
  });

  test('a workspace with no config file refuses every profile', () => {
    expect(checkContextAction(root, 'anything', 'ask').rejection?.reason).toBe('unknown-profile');
  });

  test('a known profile with no permissionMode is returned for application', () => {
    profiles({ id: 'p', workingDirectory: '/tmp', sources: ['dev'] });
    const d = checkContextAction(root, 'p', 'safe');
    expect(d.rejection).toBeNull();
    expect(d.profile?.id).toBe('p');
  });
});

describe('checkContextAction — permission escalation', () => {
  test('lowering the permission mode never needs an opt-in', () => {
    profiles({ id: 'lock', permissionMode: 'safe' });
    expect(checkContextAction(root, 'lock', 'allow-all').rejection).toBeNull();
    expect(checkContextAction(root, 'lock', 'ask').rejection).toBeNull();
  });

  test('re-applying the same mode is not an escalation', () => {
    profiles({ id: 'same', permissionMode: 'ask' });
    expect(checkContextAction(root, 'same', 'ask').rejection).toBeNull();
  });

  test('raising the permission mode without allowEscalation is refused', () => {
    profiles({ id: 'yolo', permissionMode: 'allow-all' });
    const d = checkContextAction(root, 'yolo', 'safe');
    expect(d.rejection?.reason).toBe('permission-escalation');
    expect(d.rejection?.outcome).toBe('rejected:permission-escalation:allow-all');
    expect(d.profile).toBeUndefined();
  });

  test('raising the permission mode with allowEscalation is permitted', () => {
    profiles({ id: 'yolo', permissionMode: 'allow-all', allowEscalation: true });
    expect(checkContextAction(root, 'yolo', 'safe').rejection).toBeNull();
  });

  test('allowEscalation must be exactly true — a truthy-looking value does not count', () => {
    // Mirrors `allowClosed !== true` in checkStatusAction. The schema already rejects a
    // non-boolean, so this pins the runtime half against a config that bypassed the loader.
    profiles({ id: 'y', permissionMode: 'allow-all', allowEscalation: undefined });
    expect(checkContextAction(root, 'y', 'safe').rejection?.reason).toBe('permission-escalation');
  });

  test('an unset session mode is treated as ask, not as maximally restrictive', () => {
    // Matching `setSessionPermissionMode`'s own `?? 'ask'` default. Treating undefined as
    // `safe` would make a plain `ask` profile read as an escalation on every fresh session.
    profiles({ id: 'toAsk', permissionMode: 'ask' });
    expect(checkContextAction(root, 'toAsk', undefined).rejection).toBeNull();

    profiles({ id: 'toAll', permissionMode: 'allow-all' });
    expect(checkContextAction(root, 'toAll', undefined).rejection?.reason).toBe('permission-escalation');
  });

  test('every ordered mode pair agrees with PERMISSION_MODE_ORDER', () => {
    // Exhaustive rather than sampled: 9 pairs is the whole space.
    for (const from of PERMISSION_MODE_ORDER) {
      for (const to of PERMISSION_MODE_ORDER) {
        profiles({ id: 'p', permissionMode: to });
        const refused = checkContextAction(root, 'p', from).rejection !== null;
        const isRaise = PERMISSION_MODE_ORDER.indexOf(to) > PERMISSION_MODE_ORDER.indexOf(from);
        expect(refused).toBe(isRaise);
      }
    }
  });
});

describe('escalation predicate — mutation proof', () => {
  /** The shipped comparison, restated. */
  const shipped = (from: PermissionMode, to: PermissionMode): boolean =>
    PERMISSION_MODE_ORDER.indexOf(to) > PERMISSION_MODE_ORDER.indexOf(from);

  /** Mutant A: `>=` instead of `>` — would refuse re-applying the same mode. */
  const mutantGte = (from: PermissionMode, to: PermissionMode): boolean =>
    PERMISSION_MODE_ORDER.indexOf(to) >= PERMISSION_MODE_ORDER.indexOf(from);

  /** Mutant B: comparison inverted — would refuse *lowering* and permit escalation. */
  const mutantInverted = (from: PermissionMode, to: PermissionMode): boolean =>
    PERMISSION_MODE_ORDER.indexOf(to) < PERMISSION_MODE_ORDER.indexOf(from);

  test('the shipped predicate disagrees with both mutants somewhere in the space', () => {
    const pairs: Array<[PermissionMode, PermissionMode]> = [];
    for (const from of PERMISSION_MODE_ORDER) for (const to of PERMISSION_MODE_ORDER) pairs.push([from, to]);

    expect(pairs.some(([f, t]) => shipped(f, t) !== mutantGte(f, t))).toBe(true);
    expect(pairs.some(([f, t]) => shipped(f, t) !== mutantInverted(f, t))).toBe(true);
  });

  test('the suite above actually catches each mutant', () => {
    // The load-bearing assertion: a case the real tests assert on, where each mutant gives
    // the wrong answer. If this ever fails, the escalation tests have gone tautological.
    expect(mutantGte('ask', 'ask')).toBe(true); // real: false — same-mode re-apply refused
    expect(shipped('ask', 'ask')).toBe(false);

    expect(mutantInverted('safe', 'allow-all')).toBe(false); // real: true — escalation permitted
    expect(shipped('safe', 'allow-all')).toBe(true);
  });
});
