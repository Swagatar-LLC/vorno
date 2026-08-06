/**
 * fork(PLAN-030) / ADR-0021 §3 — the two provenance-derived loop guards.
 *
 * These are pure, so they can be tested exhaustively rather than sampled. The guards
 * matter because session actions mutate session state and session state changes emit
 * events: `set-status` on `SessionStatusChange` is an unbounded loop on first use without
 * them, which is why "lift the restriction without loop guards" was rejected outright.
 */

import { describe, expect, test } from 'bun:test';
import {
  evaluateChainGuards,
  MAX_AUTOMATION_CHAIN_DEPTH,
  SESSION_ACTION_RATE_PER_MINUTE,
  type AutomationCause,
} from './causation.ts';
import { DEFAULT_RATE_LIMIT } from './event-bus.ts';

describe('evaluateChainGuards', () => {
  describe('no automation ancestor', () => {
    test('an event with no causedBy is depth 0 and always allowed', () => {
      const d = evaluateChainGuards('m1', undefined);
      expect(d.allow).toBe(true);
      expect(d.allow && d.cause).toEqual({ matcherId: 'm1', depth: 1 });
    });

    test('the first hop is depth 1, not depth 0', () => {
      // Off-by-one here is the difference between a cap of 3 and a cap of 4.
      const d = evaluateChainGuards('m1', undefined);
      expect(d.allow && d.cause.depth).toBe(1);
    });
  });

  describe('self-trigger suppression', () => {
    test('a matcher never re-enters on an event its own action caused', () => {
      const d = evaluateChainGuards('auto-close', { matcherId: 'auto-close', depth: 1 });
      expect(d.allow).toBe(false);
      expect(!d.allow && d.reason).toBe('self-trigger');
    });

    test('suppression is unconditional — it does not wait for the depth cap', () => {
      // ADR-0021 §3: "regardless of depth". A rule pointed at itself must be refused with
      // the honest reason on every pass, not degrade into `depth-exceeded` on the third.
      for (let depth = 1; depth <= MAX_AUTOMATION_CHAIN_DEPTH; depth++) {
        const d = evaluateChainGuards('self', { matcherId: 'self', depth });
        expect(!d.allow && d.reason).toBe('self-trigger');
      }
    });

    test('a different matcher on the same chain is not self-triggering', () => {
      const d = evaluateChainGuards('m2', { matcherId: 'm1', depth: 1 });
      expect(d.allow).toBe(true);
      expect(d.allow && d.cause).toEqual({ matcherId: 'm2', depth: 2 });
    });

    test('an id-less matcher is not treated as self-triggering against every cause', () => {
      // Guarding on `matcherId !== undefined` matters: without it an anonymous matcher
      // would compare undefined against a real id and could never fire on any chain.
      const d = evaluateChainGuards(undefined, { matcherId: 'm1', depth: 1 });
      expect(d.allow).toBe(true);
    });

    test('an id-less matcher still stamps a cause, so it cannot reset the chain', () => {
      const d = evaluateChainGuards(undefined, { matcherId: 'm1', depth: 1 });
      expect(d.allow && d.cause.depth).toBe(2);
    });
  });

  describe('depth cap', () => {
    test('allows every depth below the cap and refuses at it', () => {
      for (let depth = 0; depth < MAX_AUTOMATION_CHAIN_DEPTH; depth++) {
        const cause: AutomationCause = { matcherId: 'other', depth };
        expect(evaluateChainGuards('m', cause).allow).toBe(true);
      }
      const at = evaluateChainGuards('m', { matcherId: 'other', depth: MAX_AUTOMATION_CHAIN_DEPTH });
      expect(at.allow).toBe(false);
      expect(!at.allow && at.reason).toBe('depth-exceeded');
    });

    test('refuses beyond the cap too (a chain cannot step over the boundary)', () => {
      const d = evaluateChainGuards('m', { matcherId: 'other', depth: MAX_AUTOMATION_CHAIN_DEPTH + 5 });
      expect(!d.allow && d.reason).toBe('depth-exceeded');
    });

    test('the cap is 3 and is a constant, not a config value', () => {
      // ADR-0021 §3: "fixed depth (3)", deliberately not configurable — a loop limit
      // someone can raise is a loop limit that gets raised while debugging a runaway chain.
      expect(MAX_AUTOMATION_CHAIN_DEPTH).toBe(3);
    });
  });

  describe('refusal detail is diagnosable', () => {
    test('self-trigger names the offending matcher', () => {
      const d = evaluateChainGuards('loop-rule', { matcherId: 'loop-rule', depth: 2 });
      expect(!d.allow && d.detail).toContain('loop-rule');
    });

    test('depth-exceeded names the depth reached and the cap', () => {
      const d = evaluateChainGuards('m', { matcherId: 'upstream', depth: 4 });
      expect(!d.allow && d.detail).toContain('4');
      expect(!d.allow && d.detail).toContain(String(MAX_AUTOMATION_CHAIN_DEPTH));
      expect(!d.allow && d.detail).toContain('upstream');
    });
  });

  describe('rate-gate ceiling ordering', () => {
    test('the per-matcher gate sits below the bus ceiling, or it is dead code', () => {
      // The bus drops app events at DEFAULT_RATE_LIMIT per event type, workspace-wide,
      // before any matcher sees them. A per-matcher ceiling at or above that number can
      // never engage — the guard would look present and do nothing, which is precisely the
      // failure mode PLAN-030 exists to eliminate. Raising either constant without the
      // other breaks this.
      expect(SESSION_ACTION_RATE_PER_MINUTE).toBeLessThan(DEFAULT_RATE_LIMIT);
    });
  });

  describe('guard the guard (proved by mutation, not assertion)', () => {
    // PLAN-030's Phase 0 shipped a drift guard that compared a value to itself and passed
    // unconditionally. The lesson: a guard test that only ever sees the passing input has
    // not shown the predicate can fail. Each case below feeds a mutated input and asserts
    // the verdict actually flips.

    test('self-trigger detection flips when the matcher id is changed', () => {
      const cause: AutomationCause = { matcherId: 'a', depth: 1 };
      expect(evaluateChainGuards('a', cause).allow).toBe(false);
      expect(evaluateChainGuards('a-prime', cause).allow).toBe(true);
    });

    test('depth detection flips across the boundary', () => {
      const below = evaluateChainGuards('m', { matcherId: 'x', depth: MAX_AUTOMATION_CHAIN_DEPTH - 1 });
      const at = evaluateChainGuards('m', { matcherId: 'x', depth: MAX_AUTOMATION_CHAIN_DEPTH });
      expect(below.allow).toBe(true);
      expect(at.allow).toBe(false);
    });

    test('a chain terminates: repeatedly re-feeding the emitted cause hits the cap', () => {
      // The property the depth cap exists for, exercised as a loop rather than asserted:
      // two matchers ping-ponging never self-trigger, so only depth stops them.
      let cause: AutomationCause | undefined;
      let hops = 0;
      for (let i = 0; i < 50; i++) {
        const matcherId = i % 2 === 0 ? 'a' : 'b';
        const d = evaluateChainGuards(matcherId, cause);
        if (!d.allow) break;
        cause = d.cause;
        hops++;
      }
      expect(hops).toBe(MAX_AUTOMATION_CHAIN_DEPTH);
    });
  });
});
