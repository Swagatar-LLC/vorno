/**
 * fork(PLAN-030) Phase 0 — diagnostics for automations that load but can never run.
 *
 * Regression coverage for a class of failure that was previously invisible: a
 * matcher using an invented action type or an invented filter key validated
 * clean, loaded, appeared healthy, and did nothing forever.
 */

import { describe, it, expect } from 'bun:test';
import {
  validateAutomationsContent,
  validateAutomationsConfig,
  scanUnknownActionTypes,
  scanUnknownMatcherKeys,
  scanMalformedKnownActions,
  scanUnknownEventNames,
  findMatchersWithUnknownActions,
  collectConfigDiagnostics,
} from './validation.ts';
import { ActionDefinitionSchema, AutomationMatcherSchema, KNOWN_ACTION_TYPES, KNOWN_ACTION_SCHEMAS, VALID_EVENTS } from './schemas.ts';

/** The exact shape that shipped broken in a real workspace. */
const DEAD_CONFIG = {
  version: 2,
  automations: {
    LabelAdd: [
      {
        name: 'Auto Close — Set Status Done',
        labelId: 'auto-close',
        permissionMode: 'allow-all',
        actions: [{ type: 'setSessionStatus', status: 'done' }],
        id: 'auto-close-set-done',
      },
    ],
  },
};

const HEALTHY_CONFIG = {
  version: 2,
  automations: {
    LabelAdd: [
      {
        name: 'Ping',
        matcher: '^auto-close$',
        actions: [{ type: 'prompt', prompt: 'hello' }],
        id: 'ping',
      },
    ],
  },
};

describe('PLAN-030 Phase 0 — dead-rule diagnostics', () => {
  describe('unknown action types', () => {
    it('reports an invented action type as an error naming the type', () => {
      const issues = scanUnknownActionTypes(DEAD_CONFIG, 'automations.json');
      expect(issues).toHaveLength(1);
      expect(issues[0]!.severity).toBe('error');
      expect(issues[0]!.message).toContain('setSessionStatus');
      expect(issues[0]!.path).toBe('automations.LabelAdd[0].actions[0].type');
    });

    it('suggests the real type for a near-miss', () => {
      const issues = scanUnknownActionTypes(DEAD_CONFIG, 'automations.json');
      expect(issues[0]!.suggestion).toContain('set-status');
    });

    it('lists valid types when no confident suggestion exists', () => {
      const issues = scanUnknownActionTypes(
        { automations: { LabelAdd: [{ actions: [{ type: 'launchRocket' }] }] } },
        'automations.json',
      );
      expect(issues[0]!.suggestion).toContain('prompt');
      expect(issues[0]!.suggestion).toContain('send-message');
    });

    // fork(PLAN-030 Phase 3): these five aliases used to map to `null` — "no equivalent
    // today" — and they are the reason Phase 3 exists. They now all point at
    // `apply-context`, which is the payoff of the profile indirection: someone reaching
    // for a per-knob action type is sent to the one action that covers every knob, rather
    // than to a list of five types that does not contain what they were looking for.
    // `enableSkill` is included deliberately even though a profile cannot carry skills —
    // `apply-context` is still the right destination, and the profile schema explains the
    // skills limitation precisely when they arrive.
    it.each([
      'addWorkingDirectory',
      'setWorkingDirectory',
      'enableSkill',
      'enableSource',
      'applyContext',
    ])('%s suggests apply-context', (type) => {
      const issues = scanUnknownActionTypes(
        { automations: { LabelAdd: [{ actions: [{ type }] }] } },
        'automations.json',
      );
      expect(issues[0]!.suggestion).toBe('Did you mean "apply-context"?');
    });

    it('accepts every known action type', () => {
      const config = {
        automations: {
          WebhookReceived: KNOWN_ACTION_TYPES.map((type) => ({ actions: [{ type }] })),
        },
      };
      expect(scanUnknownActionTypes(config, 'automations.json')).toHaveLength(0);
    });

    it('surfaces through validateAutomationsContent as invalid', () => {
      const result = validateAutomationsContent(JSON.stringify(DEAD_CONFIG));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('setSessionStatus'))).toBe(true);
    });
  });

  describe('unknown matcher keys', () => {
    it('warns that the key is stripped, and that the rule is therefore unfiltered', () => {
      const issues = scanUnknownMatcherKeys(DEAD_CONFIG, 'automations.json');
      const labelId = issues.find((i) => i.path.endsWith('.labelId'));
      expect(labelId).toBeDefined();
      expect(labelId!.severity).toBe('warning');
      expect(labelId!.suggestion).toContain('matcher');
      // The dangerous half: no `matcher` means match everything, not nothing.
      expect(labelId!.suggestion).toContain('EVERY');
    });

    it('never suggests the matcher id for a mis-keyed filter', () => {
      // `labelId` tokenizes to {label, id} which contains the real key `id`;
      // suggesting it would move a broken filter to a worse place.
      const issues = scanUnknownMatcherKeys(DEAD_CONFIG, 'automations.json');
      const labelId = issues.find((i) => i.path.endsWith('.labelId'))!;
      expect(labelId.suggestion).not.toContain('Did you mean "id"');
    });

    it('does not warn on deliberate inline annotations', () => {
      const config = {
        automations: {
          SchedulerTick: [{ comment: 'why this exists', reason: 'ops', cron: '0 7 * * *', actions: [{ type: 'prompt', prompt: 'x' }] }],
        },
      };
      expect(scanUnknownMatcherKeys(config, 'automations.json')).toHaveLength(0);
    });

    it('is silent on a healthy config', () => {
      expect(scanUnknownMatcherKeys(HEALTHY_CONFIG, 'automations.json')).toHaveLength(0);
    });
  });

  describe('malformed known action types', () => {
    // The second dead-rule class: the type name is real, the shape is not. The
    // union's catch-all swallows it exactly the way it swallows an invented
    // type, so the type-name scan is blind to it.
    const MALFORMED = {
      automations: {
        WebhookReceived: [
          { id: 'no-target', hook: { slug: 'h' }, actions: [{ type: 'set-status', status: 'done' }] },
        ],
      },
    };

    it('is invisible to the type-name scan', () => {
      expect(scanUnknownActionTypes(MALFORMED, 'f')).toHaveLength(0);
      expect(findMatchersWithUnknownActions(MALFORMED)).toHaveLength(0);
    });

    it('is reported as an error naming the type and the offending field', () => {
      const issues = scanMalformedKnownActions(MALFORMED, 'automations.json');
      expect(issues).toHaveLength(1);
      expect(issues[0]!.severity).toBe('error');
      expect(issues[0]!.message).toContain('set-status');
      expect(issues[0]!.path).toBe('automations.WebhookReceived[0].actions[0]');
    });

    it('catches every known type, not just set-status', () => {
      const config = {
        automations: {
          WebhookReceived: [
            { actions: [{ type: 'prompt' }] },                                   // no prompt text
            { actions: [{ type: 'webhook' }] },                                  // no url
            { actions: [{ type: 'set-labels', session: { id: 's' } }] },         // neither add nor remove
            { actions: [{ type: 'send-message', session: { id: 's' } }] },       // no message
            { actions: [{ type: 'set-status', session: { id: 's', label: 'l' }, status: 'x' }] }, // both selectors
          ],
        },
      };
      expect(scanMalformedKnownActions(config, 'f')).toHaveLength(5);
    });

    it('is silent on well-formed actions, including $ENV and $.jsonpath templates', () => {
      const config = {
        automations: {
          WebhookReceived: [{
            actions: [
              { type: 'set-status', session: { label: '$.body.label' }, status: '$TARGET_STATUS' },
              { type: 'webhook', url: '$CRAFT_WH_ENDPOINT' },
            ],
          }],
        },
      };
      expect(scanMalformedKnownActions(config, 'f')).toHaveLength(0);
    });

    it('is silent on a healthy config and skips disabled rules', () => {
      expect(scanMalformedKnownActions(HEALTHY_CONFIG, 'f')).toHaveLength(0);
      const disabled = { automations: { WebhookReceived: [{ ...MALFORMED.automations.WebhookReceived[0], enabled: false }] } };
      expect(scanMalformedKnownActions(disabled, 'f')).toHaveLength(0);
    });

    it('surfaces through validateAutomationsContent as invalid', () => {
      const result = validateAutomationsContent(JSON.stringify(MALFORMED));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('set-status'))).toBe(true);
    });

    it('never throws on malformed input', () => {
      for (const input of [null, undefined, 42, [], {}, { automations: { X: [{ actions: [null, 7, 'x'] }] } }]) {
        expect(() => scanMalformedKnownActions(input, 'f')).not.toThrow();
      }
    });
  });

  describe('unknown event names', () => {
    // The third class, one level up: the transform drops the whole block and
    // emits a single lumped console.warn. Every matcher under it is gone.
    const TYPO_EVENT = {
      automations: {
        LabelAdded: [{ id: 'never-runs', matcher: '^x$', actions: [{ type: 'prompt', prompt: 'hi' }] }],
      },
    };

    it('reports the block as discarded, counting the matchers lost with it', () => {
      const issues = scanUnknownEventNames(TYPO_EVENT, 'automations.json');
      expect(issues).toHaveLength(1);
      expect(issues[0]!.severity).toBe('error');
      expect(issues[0]!.path).toBe('automations.LabelAdded');
      expect(issues[0]!.message).toContain('1 matcher');
    });

    it('suggests the real event for a near-miss the token matcher would miss', () => {
      // `LabelAdded` → tokens {label, added}, which does not contain `add` —
      // only the prefix pass finds this one.
      expect(scanUnknownEventNames(TYPO_EVENT, 'f')[0]!.suggestion).toContain('LabelAdd');
    });

    it('corrects casing', () => {
      const issues = scanUnknownEventNames({ automations: { labeladd: [] } }, 'f');
      expect(issues[0]!.suggestion).toContain('LabelAdd');
    });

    it('lists valid events when nothing is close', () => {
      const issues = scanUnknownEventNames({ automations: { Bananas: [] } }, 'f');
      expect(issues[0]!.suggestion).toContain('SessionStatusChange');
    });

    it('accepts every canonical and deprecated event name', () => {
      const config = { automations: Object.fromEntries(VALID_EVENTS.map((e) => [e, []])) };
      expect(scanUnknownEventNames(config, 'f')).toHaveLength(0);
    });

    it('exempts a block whose matchers are all disabled', () => {
      const parked = { automations: { LabelAdded: [{ enabled: false, actions: [] }] } };
      expect(scanUnknownEventNames(parked, 'f')).toHaveLength(0);
    });

    it('replaces the misleading "no automations configured" warning', () => {
      // Every rule lives under the typo, so the post-transform count is zero and
      // the old warning claimed the file was empty — the opposite of the truth.
      const result = validateAutomationsContent(JSON.stringify(TYPO_EVENT));
      expect(result.valid).toBe(false);
      expect(result.warnings.some((w) => w.message.includes('No automations configured'))).toBe(false);
      expect(result.errors.some((e) => e.message.includes('LabelAdded'))).toBe(true);
    });

    it('never throws on malformed input', () => {
      for (const input of [null, undefined, 42, 'x', [], { automations: null }, { automations: [] }]) {
        expect(() => scanUnknownEventNames(input, 'f')).not.toThrow();
      }
    });
  });

  describe('"disabled" suggestion does not invert intent', () => {
    // Following `Did you mean "enabled"?` literally turns `"disabled": true`
    // into `"enabled": true` — the opposite of what the author wanted, on a rule
    // that is still firing (an invented `disabled` key is inert).
    const config = {
      automations: { LabelAdd: [{ disabled: true, matcher: '^x$', actions: [{ type: 'prompt', prompt: 'p' }] }] },
    };

    it('tells the user the value flips, not just the key', () => {
      const issue = scanUnknownMatcherKeys(config, 'f').find((i) => i.path.endsWith('.disabled'))!;
      expect(issue.suggestion).toContain('"enabled": false');
      expect(issue.suggestion).not.toBe('Did you mean "enabled"?');
    });

    it('says the rule is still running', () => {
      const issue = scanUnknownMatcherKeys(config, 'f').find((i) => i.path.endsWith('.disabled'))!;
      expect(issue.suggestion).toContain('still running');
    });

    it('confirms the premise — an invented `disabled` key does not park the rule', () => {
      // If it did, the scans would (correctly) skip it and this warning would
      // never be reachable.
      expect(scanUnknownMatcherKeys(config, 'f').length).toBeGreaterThan(0);
    });
  });

  describe('collectConfigDiagnostics', () => {
    it('reports every dead-rule class from one call', () => {
      const config = {
        automations: {
          LabelAdd: [
            { id: 'invented', actions: [{ type: 'setSessionStatus' }] },
            { id: 'malformed', actions: [{ type: 'set-status', status: 'done' }] },
          ],
          LabelAdded: [{ id: 'typo-event', actions: [{ type: 'prompt', prompt: 'x' }] }],
        },
      };
      const reasons = collectConfigDiagnostics(config).map((d) => d.reason).sort();
      expect(reasons).toEqual(['invalid-action-shape', 'unknown-action-type', 'unknown-event']);
    });

    it('keys a diagnostic to the matcher id so history can group it', () => {
      const diagnostics = collectConfigDiagnostics(DEAD_CONFIG);
      expect(diagnostics).toEqual([
        { id: 'auto-close-set-done', event: 'LabelAdd', reason: 'unknown-action-type', detail: 'setSessionStatus' },
      ]);
    });

    it('returns nothing for a healthy config', () => {
      expect(collectConfigDiagnostics(HEALTHY_CONFIG)).toHaveLength(0);
    });

    it('is stable across calls, so reload dedupe can compare signatures', () => {
      expect(JSON.stringify(collectConfigDiagnostics(DEAD_CONFIG)))
        .toBe(JSON.stringify(collectConfigDiagnostics(DEAD_CONFIG)));
    });

    it('never throws on malformed input', () => {
      for (const input of [null, undefined, 42, 'x', [], {}, { automations: { X: 'nope' } }]) {
        expect(() => collectConfigDiagnostics(input)).not.toThrow();
      }
    });
  });

  describe('load path stays lenient (ADR-0021 §4)', () => {
    // loadConfig() zeroes the entire automations map on any validation error,
    // so a single dead rule must not be reported as a load-blocking error —
    // that would silently disable every working automation in the workspace.
    it('loads a config containing a dead rule without erroring', () => {
      const result = validateAutomationsConfig(DEAD_CONFIG);
      expect(result.valid).toBe(true);
      expect(result.config).not.toBeNull();
    });

    it('preserves sibling automations alongside a dead rule', () => {
      const mixed = {
        version: 2,
        automations: {
          LabelAdd: DEAD_CONFIG.automations.LabelAdd,
          SchedulerTick: [{ cron: '0 7 * * *', actions: [{ type: 'prompt', prompt: 'daily' }], id: 'daily' }],
        },
      };
      const result = validateAutomationsConfig(mixed);
      expect(result.valid).toBe(true);
      expect(result.config!.automations.SchedulerTick).toHaveLength(1);
    });

    it('loads a config containing a malformed known action', () => {
      // Same rule as unknown types: the new scan is an inspection-path error
      // only. Blocking the load would zero every working automation in the file.
      const result = validateAutomationsConfig({
        automations: { WebhookReceived: [{ hook: { slug: 'h' }, actions: [{ type: 'set-status', status: 'done' }] }] },
      });
      expect(result.valid).toBe(true);
    });

    it('loads a config containing a typo\'d event name', () => {
      const result = validateAutomationsConfig({
        automations: {
          LabelAdded: [{ actions: [{ type: 'prompt', prompt: 'x' }] }],
          SchedulerTick: [{ cron: '0 7 * * *', actions: [{ type: 'prompt', prompt: 'daily' }] }],
        },
      });
      expect(result.valid).toBe(true);
      // The healthy sibling survives; only the typo'd block is dropped.
      expect(result.config!.automations.SchedulerTick).toHaveLength(1);
    });

    it('still parses an unknown action type rather than rejecting it', () => {
      // Forward compatibility: a config from a newer build must open here.
      expect(ActionDefinitionSchema.safeParse({ type: 'some-future-action', x: 1 }).success).toBe(true);
    });
  });

  describe('findMatchersWithUnknownActions', () => {
    it('identifies dead matchers by id with their offending types', () => {
      expect(findMatchersWithUnknownActions(DEAD_CONFIG)).toEqual([
        { id: 'auto-close-set-done', event: 'LabelAdd', types: ['setSessionStatus'] },
      ]);
    });

    it('collects every unknown type on a matcher', () => {
      const config = {
        automations: {
          LabelAdd: [{ id: 'multi', actions: [{ type: 'setSessionStatus' }, { type: 'prompt', prompt: 'x' }, { type: 'enableSkill' }] }],
        },
      };
      expect(findMatchersWithUnknownActions(config)[0]!.types).toEqual(['setSessionStatus', 'enableSkill']);
    });

    it('falls back to an event-indexed label when the matcher has no id', () => {
      const config = { automations: { LabelAdd: [{ actions: [{ type: 'bogus' }] }] } };
      expect(findMatchersWithUnknownActions(config)[0]!.id).toBe('LabelAdd[0]');
    });

    it('returns nothing for a healthy config', () => {
      expect(findMatchersWithUnknownActions(HEALTHY_CONFIG)).toHaveLength(0);
    });
  });

  describe('disabled matchers are not reported', () => {
    // A parked rule isn't claiming to work. Reporting it would make the config
    // permanently invalid and re-log a diagnostic on every load.
    const disabled = {
      automations: {
        LabelAdd: [{ ...DEAD_CONFIG.automations.LabelAdd[0], enabled: false }],
      },
    };

    it('skips a disabled rule in every scan', () => {
      expect(scanUnknownActionTypes(disabled, 'f')).toHaveLength(0);
      expect(scanUnknownMatcherKeys(disabled, 'f')).toHaveLength(0);
      expect(findMatchersWithUnknownActions(disabled)).toHaveLength(0);
    });

    it('reports again as soon as the rule is re-enabled', () => {
      const reenabled = {
        automations: {
          LabelAdd: [{ ...DEAD_CONFIG.automations.LabelAdd[0], enabled: true }],
        },
      };
      expect(scanUnknownActionTypes(reenabled, 'f')).toHaveLength(1);
    });

    it('treats a rule with no `enabled` key as enabled', () => {
      expect(scanUnknownActionTypes(DEAD_CONFIG, 'f')).toHaveLength(1);
    });
  });

  describe('defensive against malformed input', () => {
    const junk: unknown[] = [null, undefined, 42, 'string', [], {}, { automations: null }, { automations: [] }, { automations: { LabelAdd: 'nope' } }, { automations: { LabelAdd: [null, 7] } }];
    it('never throws on malformed content', () => {
      for (const input of junk) {
        expect(() => scanUnknownActionTypes(input, 'f')).not.toThrow();
        expect(() => scanUnknownMatcherKeys(input, 'f')).not.toThrow();
        expect(() => findMatchersWithUnknownActions(input)).not.toThrow();
      }
    });
  });

  describe('drift guards', () => {
    // Reads the union's literal `type` members back out of the schema.
    // Deliberately does NOT go through safeParse: the union's `.passthrough()`
    // catch-all accepts any `{type: string}`, so a parse-based check passes for
    // every input and guards nothing at all.
    function unionLiteralTypes(): { literals: string[]; catchAlls: number } {
      const options = (ActionDefinitionSchema as unknown as { _def: { options: unknown[] } })._def.options;
      const literals: string[] = [];
      let catchAlls = 0;
      for (const option of options) {
        // `.refine()`-wrapped members (set-labels) keep their object shape in
        // Zod 4, but unwrap defensively so a wrapper change fails loudly in the
        // guard-the-guard test rather than silently dropping a member.
        const def = (option as { _def: { schema?: unknown } })._def;
        const inner = (def.schema ?? option) as {
          shape?: Record<string, { _def?: { type?: string; values?: unknown[] } }>;
        };
        const typeField = inner.shape?.type?._def;
        const value = typeField?.type === 'literal' ? typeField.values?.[0] : undefined;
        if (typeof value === 'string') literals.push(value);
        else catchAlls++;
      }
      return { literals, catchAlls };
    }

    it('extracts union members structurally (guards the guard)', () => {
      // If a Zod upgrade changes the internals this reads, the assertions below
      // would silently degrade to comparing two empty sets. Fail here instead.
      const { literals, catchAlls } = unionLiteralTypes();
      expect(literals.length).toBeGreaterThan(0);
      expect(catchAlls).toBe(1); // exactly one `{type: string}.passthrough()` member
    });

    it('KNOWN_ACTION_TYPES matches the schema union members exactly', () => {
      // The union's catch-all cannot reject unknown types, so KNOWN_ACTION_TYPES
      // is the only source of truth for what dispatches. Adding a member to the
      // union without adding it here would silently report every rule using it
      // as dead; adding it here without a union member would let a malformed
      // action of that type through. Set equality catches both directions.
      const { literals } = unionLiteralTypes();
      expect([...literals].sort()).toEqual([...KNOWN_ACTION_TYPES].sort());
      expect(new Set(KNOWN_ACTION_TYPES).size).toBe(KNOWN_ACTION_TYPES.length);
    });

    it('every known type has a strict schema for shape checking', () => {
      // scanMalformedKnownActions is a no-op for any type missing from this map,
      // so a gap here is a silent hole in the shape check.
      expect(Object.keys(KNOWN_ACTION_SCHEMAS).sort()).toEqual([...KNOWN_ACTION_TYPES].sort());
    });

    it('a well-formed action of every known type passes both the union and its own schema', () => {
      for (const type of KNOWN_ACTION_TYPES) {
        const probe = { type, prompt: 'x', url: 'https://e.com', session: { id: 's' }, status: 'todo', add: ['l'], message: 'm', profile: 'p' };
        expect(ActionDefinitionSchema.safeParse(probe).success).toBe(true);
        expect(KNOWN_ACTION_SCHEMAS[type].safeParse(probe).success).toBe(true);
      }
    });

    it('matcher key list is derived from the schema, not hardcoded', () => {
      // Adding an optional field to AutomationMatcherSchema must not start
      // warning about that field.
      const key = Object.keys(AutomationMatcherSchema.shape)[0]!;
      const config = { automations: { LabelAdd: [{ [key]: 'x', actions: [] }] } };
      expect(scanUnknownMatcherKeys(config, 'f').some((i) => i.path.endsWith(`.${key}`))).toBe(false);
    });
  });
});
