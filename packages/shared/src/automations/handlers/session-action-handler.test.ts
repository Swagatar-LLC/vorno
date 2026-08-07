/**
 * fork(PLAN-030) / ADR-0021 §1, §3 — session actions on any app event, with loop safety.
 *
 * Two things are being pinned here:
 *
 * 1. The flip. `set-status` / `set-labels` / `send-message` used to be dropped at
 *    `if (event !== 'WebhookReceived') return`. They now run on any app event.
 * 2. The guards that replace the transport scoping. The important test is not "no crash" —
 *    a self-feeding rule that fires forever also never crashes. It is **bounded firing**:
 *    the loop below counts hops and asserts a specific, small number.
 */

import { describe, expect, test } from 'bun:test';
import { SessionActionHandler } from './session-action-handler.ts';
import { WorkspaceEventBus } from '../event-bus.ts';
import type { AutomationCause } from '../causation.ts';
import { MAX_AUTOMATION_CHAIN_DEPTH, SESSION_ACTION_RATE_PER_MINUTE, type SessionActionSkip } from '../causation.ts';
import { KNOWN_ACTION_TYPES } from '../schemas.ts';
import type { AutomationsConfig, AutomationEvent, AutomationMatcher, PendingSessionAction } from '../types.ts';

function configProvider(automations: Record<string, AutomationMatcher[]>) {
  return {
    getConfig: () => ({ automations } as unknown as AutomationsConfig),
    getMatchersForEvent: (event: AutomationEvent) => automations[event] ?? [],
  };
}

interface Harness {
  bus: WorkspaceEventBus;
  actions: PendingSessionAction[];
  skips: SessionActionSkip[];
  now: { value: number };
}

function harness(automations: Record<string, AutomationMatcher[]>): Harness {
  const bus = new WorkspaceEventBus('ws_test');
  const actions: PendingSessionAction[] = [];
  const skips: SessionActionSkip[] = [];
  const now = { value: 1_000_000 };
  const handler = new SessionActionHandler(
    {
      workspaceId: 'ws_test',
      workspaceRootPath: '/tmp/ws',
      onSessionActions: (a) => actions.push(...a),
      onSessionActionSkipped: (s) => skips.push(...s),
    },
    configProvider(automations),
    () => now.value,
  );
  handler.subscribe(bus);
  return { bus, actions, skips, now };
}

function statusChange(newState: string, causedBy?: AutomationCause) {
  return {
    sessionId: 'sess-1',
    workspaceId: 'ws_test',
    timestamp: Date.now(),
    labels: [],
    oldState: 'todo',
    newState,
    ...(causedBy ? { causedBy } : {}),
  };
}

const setStatus = (id: string, status: string, extra: Partial<AutomationMatcher> = {}): AutomationMatcher =>
  ({
    id,
    actions: [{ type: 'set-status', session: { id: 'sess-1' }, status }],
    ...extra,
  }) as unknown as AutomationMatcher;

describe('session actions are no longer scoped to WebhookReceived', () => {
  test('a set-status action fires on LabelAdd', async () => {
    const h = harness({
      LabelAdd: [
        {
          id: 'label-to-review',
          actions: [{ type: 'set-status', session: { id: 'sess-1' }, status: 'needs-review' }],
        } as unknown as AutomationMatcher,
      ],
    });

    await h.bus.emit('LabelAdd', {
      sessionId: 'sess-1',
      workspaceId: 'ws_test',
      timestamp: Date.now(),
      labels: ['review'],
      label: 'review',
    });

    expect(h.actions).toHaveLength(1);
    expect(h.actions[0]!.type).toBe('set-status');
    expect(h.actions[0]!.status).toBe('needs-review');
  });

  test('set-labels and send-message fire on SessionStatusChange too', async () => {
    const h = harness({
      SessionStatusChange: [
        {
          id: 'on-review',
          matcher: '^needs-review$',
          actions: [
            { type: 'set-labels', session: { id: 'sess-1' }, add: ['reviewing'] },
            { type: 'send-message', session: { id: 'sess-1' }, message: 'ping' },
          ],
        } as unknown as AutomationMatcher,
      ],
    });

    await h.bus.emit('SessionStatusChange', statusChange('needs-review'));

    expect(h.actions.map((a) => a.type)).toEqual(['set-labels', 'send-message']);
  });

  test('an action targeting $CRAFT_SESSION_ID resolves to the event`s own session', async () => {
    // The common lifecycle shape: "when this session gets label X, act on this session".
    // Webhook payloads carry no session, so this only became useful with the flip.
    const h = harness({
      LabelAdd: [
        {
          id: 'self-target',
          actions: [{ type: 'set-status', session: { id: '$CRAFT_SESSION_ID' }, status: 'needs-review' }],
        } as unknown as AutomationMatcher,
      ],
    });

    await h.bus.emit('LabelAdd', {
      sessionId: 'sess-42',
      workspaceId: 'ws_test',
      timestamp: Date.now(),
      labels: ['review'],
      label: 'review',
    });

    expect(h.actions[0]!.target.id).toBe('sess-42');
  });

  test('a non-matching matcher still does not fire', async () => {
    const h = harness({ SessionStatusChange: [setStatus('m', 'done', { matcher: '^blocked$' })] });
    await h.bus.emit('SessionStatusChange', statusChange('needs-review'));
    expect(h.actions).toHaveLength(0);
  });
});

describe('provenance', () => {
  test('a user-caused event produces a depth-1 cause', async () => {
    const h = harness({ SessionStatusChange: [setStatus('m1', 'needs-review')] });
    await h.bus.emit('SessionStatusChange', statusChange('todo'));
    expect(h.actions[0]!.cause).toEqual({ matcherId: 'm1', depth: 1 });
  });

  test('an automation-caused event increments the depth', async () => {
    const h = harness({ SessionStatusChange: [setStatus('m2', 'needs-review')] });
    await h.bus.emit('SessionStatusChange', statusChange('todo', { matcherId: 'm1', depth: 1 }));
    expect(h.actions[0]!.cause).toEqual({ matcherId: 'm2', depth: 2 });
  });

  test('every action from one matcher shares the matcher`s cause', async () => {
    const h = harness({
      LabelAdd: [
        {
          id: 'multi',
          actions: [
            { type: 'set-status', session: { id: 'sess-1' }, status: 'needs-review' },
            { type: 'set-labels', session: { id: 'sess-1' }, add: ['x'] },
          ],
        } as unknown as AutomationMatcher,
      ],
    });
    await h.bus.emit('LabelAdd', {
      sessionId: 'sess-1', workspaceId: 'ws_test', timestamp: Date.now(), labels: ['y'], label: 'y',
    });
    expect(h.actions).toHaveLength(2);
    expect(h.actions[0]!.cause).toEqual(h.actions[1]!.cause!);
  });
});

describe('loop safety', () => {
  test('a self-feeding rule terminates — and fires exactly once', async () => {
    // The regression test PLAN-030 asks for. A `set-status` rule on `SessionStatusChange`
    // targeting its own session is self-feeding by construction; the loop below closes the
    // cycle for real (each delivered action is re-emitted as the event it would cause), so
    // "it terminated" is a property of the guards, not of the test stopping early.
    const h = harness({ SessionStatusChange: [setStatus('auto-close-set-done', 'done')] });

    let payload = statusChange('todo');
    let iterations = 0;
    for (let i = 0; i < 20; i++) {
      const before = h.actions.length;
      await h.bus.emit('SessionStatusChange', payload);
      const produced = h.actions.slice(before);
      if (produced.length === 0) break;
      iterations++;
      payload = statusChange(produced[0]!.status!, produced[0]!.cause);
    }

    expect(iterations).toBe(1);
    expect(h.actions).toHaveLength(1);
    expect(h.skips.map((s) => s.reason)).toEqual(['self-trigger']);
  });

  test('two matchers ping-ponging terminate at the depth cap', async () => {
    // Self-trigger suppression cannot see this shape — neither matcher ever re-enters on
    // its own event. Only the depth cap bounds it, which is why all three guards are
    // mandatory rather than alternatives.
    const h = harness({
      SessionStatusChange: [
        setStatus('a', 'beta', { matcher: '^alpha$' }),
        setStatus('b', 'alpha', { matcher: '^beta$' }),
      ],
    });

    let payload = statusChange('alpha');
    let hops = 0;
    for (let i = 0; i < 20; i++) {
      const before = h.actions.length;
      await h.bus.emit('SessionStatusChange', payload);
      const produced = h.actions.slice(before);
      if (produced.length === 0) break;
      hops++;
      payload = statusChange(produced[0]!.status!, produced[0]!.cause);
    }

    expect(hops).toBe(MAX_AUTOMATION_CHAIN_DEPTH);
    expect(h.skips.at(-1)!.reason).toBe('depth-exceeded');
  });

  test('the rate gate bounds many short chains, which depth cannot', async () => {
    // Each event here is user-caused (depth 0), so the depth cap never engages and
    // self-trigger never applies. A chatty event type would otherwise let one rule mutate
    // sessions without limit.
    const h = harness({ SessionStatusChange: [setStatus('chatty', 'needs-review')] });

    for (let i = 0; i < SESSION_ACTION_RATE_PER_MINUTE + 3; i++) {
      await h.bus.emit('SessionStatusChange', statusChange('todo'));
    }

    expect(h.actions).toHaveLength(SESSION_ACTION_RATE_PER_MINUTE);
    expect(h.skips).toHaveLength(3);
    expect(h.skips.every((s) => s.reason === 'rate-limited')).toBe(true);
  });

  test('the rate gate window slides — a refused matcher recovers', async () => {
    const h = harness({ SessionStatusChange: [setStatus('chatty', 'needs-review')] });
    for (let i = 0; i < SESSION_ACTION_RATE_PER_MINUTE + 1; i++) {
      await h.bus.emit('SessionStatusChange', statusChange('todo'));
    }
    expect(h.skips).toHaveLength(1);

    h.now.value += 61_000;
    await h.bus.emit('SessionStatusChange', statusChange('todo'));
    expect(h.actions).toHaveLength(SESSION_ACTION_RATE_PER_MINUTE + 1);
    expect(h.skips).toHaveLength(1);
  });

  test('the rate gate is per matcher, not global', async () => {
    const h = harness({
      SessionStatusChange: [
        setStatus('noisy', 'needs-review', { matcher: '^noisy$' }),
        setStatus('quiet', 'needs-review', { matcher: '^quiet$' }),
      ],
    });
    for (let i = 0; i < SESSION_ACTION_RATE_PER_MINUTE + 1; i++) {
      await h.bus.emit('SessionStatusChange', statusChange('noisy'));
    }
    const before = h.actions.length;
    await h.bus.emit('SessionStatusChange', statusChange('quiet'));
    expect(h.actions.length).toBe(before + 1);
  });

  test('a refused matcher does not suppress an unrelated healthy one', async () => {
    const h = harness({
      SessionStatusChange: [
        setStatus('looping', 'done'),
        setStatus('healthy', 'needs-review'),
      ],
    });

    await h.bus.emit('SessionStatusChange', statusChange('todo', { matcherId: 'looping', depth: 1 }));

    expect(h.actions).toHaveLength(1);
    expect(h.actions[0]!.matcherId).toBe('healthy');
    expect(h.skips.map((s) => s.matcherId)).toEqual(['looping']);
  });

  test('a refusal is reported, never silent', async () => {
    // A guard that drops actions without a trace is the same failure class Phase 0 closed:
    // a rule that presents as healthy and does nothing.
    const h = harness({ SessionStatusChange: [setStatus('self', 'done')] });
    await h.bus.emit('SessionStatusChange', statusChange('todo', { matcherId: 'self', depth: 1 }));
    expect(h.skips).toHaveLength(1);
    expect(h.skips[0]).toMatchObject({
      matcherId: 'self',
      event: 'SessionStatusChange',
      reason: 'self-trigger',
      sessionId: 'sess-1',
    });
    expect(h.skips[0]!.detail.length).toBeGreaterThan(0);
  });

  test('every refusal names the action types it covers', async () => {
    // Phase 2a writes the history record's `sessionAction.type` from this. A refusal that
    // cannot say what it refused is a record an operator cannot act on.
    const h = harness({ SessionStatusChange: [setStatus('self', 'done')] });
    await h.bus.emit('SessionStatusChange', statusChange('todo', { matcherId: 'self', depth: 1 }));
    expect(h.skips[0]!.actionTypes).toEqual(['set-status']);
  });

  test('a refusal covers every session action the matcher declared', async () => {
    // The guards run per matcher, so all of its session actions are refused together.
    const h = harness({
      SessionStatusChange: [
        {
          id: 'both',
          actions: [
            { type: 'set-status', session: { id: 'sess-1' }, status: 'done' },
            { type: 'set-labels', session: { id: 'sess-1' }, add: ['x'] },
            { type: 'prompt', prompt: 'not a session action' },
          ],
        } as unknown as AutomationMatcher,
      ],
    });
    await h.bus.emit('SessionStatusChange', statusChange('todo', { matcherId: 'both', depth: 1 }));
    expect(h.skips[0]!.actionTypes).toEqual(['set-status', 'set-labels']);
  });

  test('a matcher with no session actions is not charged to the rate gate', async () => {
    // Prompt-only matchers match the same events. Counting them here would let an
    // unrelated rule exhaust a session-action budget it never uses.
    const h = harness({
      SessionStatusChange: [
        { id: 'prompt-only', actions: [{ type: 'prompt', prompt: 'hi' }] } as unknown as AutomationMatcher,
        setStatus('acts', 'needs-review'),
      ],
    });
    for (let i = 0; i < SESSION_ACTION_RATE_PER_MINUTE; i++) {
      await h.bus.emit('SessionStatusChange', statusChange('todo'));
    }
    expect(h.actions).toHaveLength(SESSION_ACTION_RATE_PER_MINUTE);
    expect(h.skips).toHaveLength(0);
  });
});

describe('unknown action types (Phase 0 class, caught at dispatch)', () => {
  const withUnknown = (id: string, unknownType: string): AutomationMatcher =>
    ({
      id,
      actions: [
        { type: 'set-status', session: { id: 'sess-1' }, status: 'needs-review' },
        { type: unknownType, session: { id: 'sess-1' } },
      ],
    }) as unknown as AutomationMatcher;

  test('an unrecognized action type on a firing matcher is refused and reported', async () => {
    const h = harness({ SessionStatusChange: [withUnknown('half-dead', 'setSessionStatus')] });
    await h.bus.emit('SessionStatusChange', statusChange('todo'));

    expect(h.skips).toHaveLength(1);
    expect(h.skips[0]).toMatchObject({
      matcherId: 'half-dead',
      reason: 'unknown-action',
      actionTypes: ['setSessionStatus'],
    });
    expect(h.skips[0]!.detail).toContain('setSessionStatus');
  });

  test('the healthy actions on the same matcher still run', async () => {
    // The distinction Phase 2a exists to record: this rule is not dead, it is partly dead.
    // Refusing the whole matcher would be a behavior regression dressed up as strictness.
    const h = harness({ SessionStatusChange: [withUnknown('half-dead', 'enableSkill')] });
    await h.bus.emit('SessionStatusChange', statusChange('todo'));
    expect(h.actions).toHaveLength(1);
    expect(h.actions[0]!.type).toBe('set-status');
  });

  test('the predicate flips on the type — every known type is admitted silently', async () => {
    // Mutation check for the guard itself. Phase 0 shipped a drift guard that compared a
    // value to itself and passed unconditionally; this asserts the predicate actually
    // discriminates, by driving both sides of it through the same matcher shape.
    for (const known of KNOWN_ACTION_TYPES) {
      const h = harness({ SessionStatusChange: [withUnknown(`known-${known}`, known)] });
      await h.bus.emit('SessionStatusChange', statusChange('todo'));
      expect(h.skips.map((s) => s.reason)).not.toContain('unknown-action');
    }

    // ...and that the same shape with a name one character off is refused.
    for (const mutated of ['set-statuss', 'Set-Status', 'setstatus', 'send_message']) {
      const h = harness({ SessionStatusChange: [withUnknown(`bad-${mutated}`, mutated)] });
      await h.bus.emit('SessionStatusChange', statusChange('todo'));
      expect(h.skips.map((s) => s.reason)).toContain('unknown-action');
    }
  });

  test('a matcher whose actions are ALL unknown does not flood history', async () => {
    // It never reaches the session-action path at all — the Phase 0 load-time
    // `config-diagnostic` owns that case, once per load rather than once per event.
    const h = harness({
      SessionStatusChange: [
        { id: 'fully-dead', actions: [{ type: 'setSessionStatus' }] } as unknown as AutomationMatcher,
      ],
    });
    for (let i = 0; i < 5; i++) await h.bus.emit('SessionStatusChange', statusChange('todo'));
    expect(h.skips).toHaveLength(0);
    expect(h.actions).toHaveLength(0);
  });

  test('a matcher refused by a loop guard reports the guard, not the unknown action', async () => {
    // Order matters: the loop guard is the reason nothing ran. Reporting `unknown-action`
    // here would name a secondary defect and hide the actual refusal.
    const h = harness({ SessionStatusChange: [withUnknown('self', 'setSessionStatus')] });
    await h.bus.emit('SessionStatusChange', statusChange('todo', { matcherId: 'self', depth: 1 }));
    expect(h.skips.map((s) => s.reason)).toEqual(['self-trigger']);
  });
});

describe('the webhook path is unchanged', () => {
  test('webhook deliveries are not subject to the per-matcher rate gate', async () => {
    // Webhooks already pass the receiver's per-hook gate, which is tuned for their bursty
    // arrival pattern. A second, tighter ceiling here would silently drop deliveries the
    // hook deliberately admitted — a regression on a path that works today.
    const h = harness({
      WebhookReceived: [
        {
          id: 'ci',
          hook: { slug: 'ci', tokenHash: 'x' },
          actions: [{ type: 'set-status', session: { id: 'sess-1' }, status: 'needs-review' }],
        } as unknown as AutomationMatcher,
      ],
    });

    for (let i = 0; i < SESSION_ACTION_RATE_PER_MINUTE + 10; i++) {
      await h.bus.emit('WebhookReceived', {
        workspaceId: 'ws_test',
        timestamp: Date.now(),
        hookId: 'ci',
        hookSlug: 'ci',
        eventId: `ci:${i}`,
        headers: {},
        body: { ok: true },
      });
    }

    expect(h.actions).toHaveLength(SESSION_ACTION_RATE_PER_MINUTE + 10);
    expect(h.skips).toHaveLength(0);
  });

  test('webhook $.jsonpath expansion still works', async () => {
    const h = harness({
      WebhookReceived: [
        {
          id: 'ci',
          hook: { slug: 'ci', tokenHash: 'x' },
          actions: [{ type: 'set-status', session: { id: '$.session' }, status: '$.status' }],
        } as unknown as AutomationMatcher,
      ],
    });

    await h.bus.emit('WebhookReceived', {
      workspaceId: 'ws_test',
      timestamp: Date.now(),
      hookId: 'ci',
      hookSlug: 'ci',
      eventId: 'ci:1',
      headers: {},
      body: { session: 'sess-9', status: 'needs-review' },
    });

    expect(h.actions[0]!.target.id).toBe('sess-9');
    expect(h.actions[0]!.status).toBe('needs-review');
  });
});
