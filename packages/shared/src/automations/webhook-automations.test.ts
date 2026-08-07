/**
 * fork(PLAN-014) — schema/validation + matching + SessionActionHandler tests.
 */

import { describe, test, expect } from 'bun:test';
import { validateAutomationsConfig } from './validation.ts';
import { matcherMatches } from './utils.ts';
import { WorkspaceEventBus } from './event-bus.ts';
import { SessionActionHandler } from './handlers/session-action-handler.ts';
import type { AutomationMatcher, AutomationsConfig, PendingSessionAction } from './types.ts';
import type { AutomationsConfigProvider } from './handlers/types.ts';

const VALID_HASH = 'sha256:' + 'a'.repeat(64);

function cfg(automations: Record<string, unknown[]>): unknown {
  return { automations };
}

describe('hook validation', () => {
  test('WebhookReceived requires a hook', () => {
    const r = validateAutomationsConfig(cfg({
      WebhookReceived: [{ actions: [{ type: 'prompt', prompt: 'x' }] }],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('require a "hook"');
  });

  test('hook rejected on non-WebhookReceived events', () => {
    const r = validateAutomationsConfig(cfg({
      LabelAdd: [{ hook: { slug: 'x', tokenHash: VALID_HASH }, actions: [{ type: 'prompt', prompt: 'x' }] }],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('only valid on WebhookReceived');
  });

  test('duplicate slugs rejected', () => {
    const r = validateAutomationsConfig(cfg({
      WebhookReceived: [
        { hook: { slug: 'dup', tokenHash: VALID_HASH }, actions: [{ type: 'prompt', prompt: 'a' }] },
        { hook: { slug: 'dup', tokenHash: VALID_HASH }, actions: [{ type: 'prompt', prompt: 'b' }] },
      ],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('Duplicate hook slug');
  });

  test('invalid matchField rejected', () => {
    const r = validateAutomationsConfig(cfg({
      WebhookReceived: [{ hook: { slug: 'h', tokenHash: VALID_HASH }, matchField: 'not-a-path', actions: [{ type: 'prompt', prompt: 'a' }] }],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('Invalid matchField');
  });

  // fork(PLAN-030) / ADR-0021 §1: this used to assert the inverse — that a session action
  // on a non-webhook matcher was a validation error. The scoping was a `(v1)` limitation,
  // not a security property, and it is gone. Loop safety replaced it (`causation.ts`).
  test('session-mutation actions are valid on any event, not just WebhookReceived', () => {
    const onLabelAdd = validateAutomationsConfig(cfg({
      LabelAdd: [{ actions: [{ type: 'set-status', session: { id: 's' }, status: 'done' }] }],
    }));
    expect(onLabelAdd.valid).toBe(true);

    const good = validateAutomationsConfig(cfg({
      WebhookReceived: [{
        hook: { slug: 'ci', tokenHash: VALID_HASH },
        actions: [{ type: 'set-status', session: { id: '$.sessionId' }, status: 'needs-review' }],
      }],
    }));
    expect(good.valid).toBe(true);
  });

  test('valid full hook config passes', () => {
    const r = validateAutomationsConfig(cfg({
      WebhookReceived: [{
        hook: {
          slug: 'linear-issues',
          tokenHash: VALID_HASH,
          idempotencyKey: { source: 'header', name: 'linear-delivery' },
          rateLimit: { perMinute: 30, burst: 10 },
        },
        matcher: '^Issue\\.(created|updated)$',
        matchField: '$.type',
        actions: [{ type: 'prompt', prompt: 'triage' }],
      }],
    }));
    expect(r.valid).toBe(true);
  });
});

describe('WebhookReceived matching', () => {
  const matcher: AutomationMatcher = {
    id: 'm',
    matcher: '^Issue\\.',
    matchField: '$.type',
    hook: { slug: 'h', tokenHash: VALID_HASH },
    actions: [{ type: 'prompt', prompt: 'x' }],
  };

  test('regex tested against matchField extraction', () => {
    expect(matcherMatches(matcher, 'WebhookReceived', { body: { type: 'Issue.created' } })).toBe(true);
    expect(matcherMatches(matcher, 'WebhookReceived', { body: { type: 'Comment.created' } })).toBe(false);
  });

  test('no matchField → matches whole body JSON', () => {
    const m: AutomationMatcher = { id: 'm', matcher: 'created', hook: matcher.hook, actions: matcher.actions };
    expect(matcherMatches(m, 'WebhookReceived', { body: { type: 'Issue.created' } })).toBe(true);
  });
});

describe('SessionActionHandler', () => {
  function provider(matchers: AutomationMatcher[]): AutomationsConfigProvider {
    const config: AutomationsConfig = { automations: { WebhookReceived: matchers } };
    return {
      getConfig: () => config,
      getMatchersForEvent: (e) => config.automations[e] ?? [],
    };
  }

  test('expands $.jsonpath + delivers PendingSessionAction[]', async () => {
    const matcher: AutomationMatcher = {
      id: 'm1',
      hook: { slug: 'ci', tokenHash: VALID_HASH },
      actions: [
        { type: 'set-status', session: { id: '$.sessionId' }, status: 'needs-review' },
        { type: 'set-labels', session: { label: 'task::$.issue.id' }, add: ['ci-failed'], remove: ['ci-green'] },
      ],
    };
    const captured: PendingSessionAction[] = [];
    const bus = new WorkspaceEventBus('ws1');
    const handler = new SessionActionHandler(
      { workspaceId: 'ws1', workspaceRootPath: '/tmp', onSessionActions: (a) => captured.push(...a) },
      provider([matcher]),
    );
    handler.subscribe(bus);

    await bus.emit('WebhookReceived', {
      workspaceId: 'ws1',
      timestamp: 1,
      hookId: 'm1',
      hookSlug: 'ci',
      eventId: 'm1:d1',
      headers: {},
      body: { sessionId: '260101-a-b', issue: { id: 'LIN-9' } },
    });

    expect(captured).toHaveLength(2);
    const setStatus = captured.find((a) => a.type === 'set-status')!;
    expect(setStatus.target.id).toBe('260101-a-b');
    expect(setStatus.status).toBe('needs-review');
    const setLabels = captured.find((a) => a.type === 'set-labels')!;
    expect(setLabels.target.label).toBe('task::LIN-9');
    expect(setLabels.add).toEqual(['ci-failed']);
    expect(setLabels.eventId).toBe('m1:d1');
    handler.dispose();
  });

  test('ignores non-WebhookReceived events', async () => {
    const captured: PendingSessionAction[] = [];
    const bus = new WorkspaceEventBus('ws1');
    const handler = new SessionActionHandler(
      { workspaceId: 'ws1', workspaceRootPath: '/tmp', onSessionActions: (a) => captured.push(...a) },
      provider([]),
    );
    handler.subscribe(bus);
    await bus.emit('LabelAdd', { workspaceId: 'ws1', timestamp: 1, label: 'x' });
    expect(captured).toHaveLength(0);
    handler.dispose();
  });
});
