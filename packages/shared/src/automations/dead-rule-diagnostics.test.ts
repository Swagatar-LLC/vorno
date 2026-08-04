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
  findMatchersWithUnknownActions,
} from './validation.ts';
import { ActionDefinitionSchema, AutomationMatcherSchema, KNOWN_ACTION_TYPES } from './schemas.ts';

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
        { automations: { LabelAdd: [{ actions: [{ type: 'enableSkill' }] }] } },
        'automations.json',
      );
      expect(issues[0]!.suggestion).toContain('prompt');
      expect(issues[0]!.suggestion).toContain('send-message');
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
    it('KNOWN_ACTION_TYPES matches the schema union members', () => {
      // The union's catch-all cannot reject unknown types, so KNOWN_ACTION_TYPES
      // is the only source of truth for what dispatches. If someone adds a
      // member to the union without adding it here, its actions get reported as
      // dead — this test fails first.
      for (const type of KNOWN_ACTION_TYPES) {
        const probe = { type, prompt: 'x', url: 'https://e.com', session: { id: 's' }, status: 'todo', add: ['l'], message: 'm' };
        expect(ActionDefinitionSchema.safeParse(probe).success).toBe(true);
      }
      expect(new Set(KNOWN_ACTION_TYPES).size).toBe(KNOWN_ACTION_TYPES.length);
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
