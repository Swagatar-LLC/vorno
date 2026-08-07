/**
 * SessionActionHandler — fork(PLAN-014)
 *
 * Sibling of PromptHandler/WebhookHandler. Subscribes to the bus, matches
 * WebhookReceived matchers, and delivers resolved `PendingSessionAction[]` via
 * the `onSessionActions` callback. The handler COMPUTES (expands `$ENV` and
 * `$.jsonpath`); the HOST EXECUTES (resolves label→session, validates, writes to
 * disk) — identical to the PromptHandler / `onPromptsReady` division of labor,
 * which keeps `packages/shared` free of SessionManager dependencies.
 *
 * fork(PLAN-030) / ADR-0021 §1: session actions now ride ANY app event, not only
 * WebhookReceived. The `(v1)` transport scoping is gone — it was a scope limitation, never
 * a security property. What replaces it is loop safety (`causation.ts`), because session
 * actions mutate session state and session state changes emit events, so `set-status` on
 * `SessionStatusChange` is self-feeding by construction: self-trigger suppression, a fixed
 * depth cap, and a per-matcher rate gate, evaluated per matcher below.
 */

import { createLogger } from '../../utils/debug.ts';
import type { EventBus, BaseEventPayload } from '../event-bus.ts';
import type { AutomationHandler, AutomationsConfigProvider } from './types.ts';
import type {
  AutomationEvent,
  PendingSessionAction,
  SessionTargetSelector,
} from '../types.ts';
import { matcherMatches, buildEnvFromPayload, expandEnvVars } from '../utils.ts';
import { resolveJsonPathLiteString } from '../webhook-ingest/jsonpath-lite.ts';
import { deriveAutomationName } from '../name-utils.ts';
import { WebhookRateGate } from '../webhook-ingest/rate-gate.ts';
import {
  evaluateChainGuards,
  SESSION_ACTION_RATE_PER_MINUTE,
  type SessionActionSkip,
} from '../causation.ts';

const log = createLogger('session-action-handler');

export interface SessionActionHandlerOptions {
  workspaceId: string;
  workspaceRootPath: string;
  /** Called when session actions are ready for the host to execute. */
  onSessionActions?: (actions: PendingSessionAction[]) => void;
  /**
   * fork(PLAN-030): called when a matcher's session actions were refused by a loop
   * guard. Phase 1 wires this to a log; Phase 2 ("effect-accurate history") wires it to
   * `skipped:<reason>` history records — a refusal that leaves no trace is the same
   * silent-dead-rule failure Phase 0 exists to prevent.
   */
  onSessionActionSkipped?: (skips: SessionActionSkip[]) => void;
  onError?: (event: AutomationEvent, error: Error) => void;
}

const SESSION_ACTION_TYPES = new Set(['set-status', 'set-labels', 'send-message']);

/**
 * Resolve embedded `$.jsonpath` tokens against the webhook body, then expand
 * `$ENV` variables. Order matters: JSONPath first so a resolved value can't be
 * mistaken for an env var.
 */
function expandActionString(value: string, env: Record<string, string>, body: unknown): string {
  const withPaths = value.replace(/\$\.[A-Za-z0-9_.[\]"']+/g, (m) => resolveJsonPathLiteString(body, m));
  return expandEnvVars(withPaths, env);
}

function expandSelector(
  selector: SessionTargetSelector,
  env: Record<string, string>,
  body: unknown,
): SessionTargetSelector {
  const out: SessionTargetSelector = {};
  if (selector.id !== undefined) out.id = expandActionString(selector.id, env, body);
  if (selector.label !== undefined) out.label = expandActionString(selector.label, env, body);
  return out;
}

export class SessionActionHandler implements AutomationHandler {
  private readonly options: SessionActionHandlerOptions;
  private readonly configProvider: AutomationsConfigProvider;
  private bus: EventBus | null = null;
  private boundHandler: ((event: AutomationEvent, payload: BaseEventPayload) => Promise<void>) | null = null;
  /** fork(PLAN-030): per-matcher sliding-window gate. `now` is injectable for tests. */
  private readonly rateGate: WebhookRateGate;

  constructor(
    options: SessionActionHandlerOptions,
    configProvider: AutomationsConfigProvider,
    now: () => number = Date.now,
  ) {
    this.options = options;
    this.configProvider = configProvider;
    this.rateGate = new WebhookRateGate(now);
  }

  subscribe(bus: EventBus): void {
    this.bus = bus;
    this.boundHandler = this.handleEvent.bind(this);
    bus.onAny(this.boundHandler);
    log.debug('[SessionActionHandler] Subscribed to event bus');
  }

  private async handleEvent(event: AutomationEvent, payload: BaseEventPayload): Promise<void> {
    const matchers = this.configProvider.getMatchersForEvent(event);
    if (matchers.length === 0) return;

    const record = payload as unknown as Record<string, unknown>;
    const body = record.body;
    const env = buildEnvFromPayload(event, payload);
    const hookId = typeof record.hookId === 'string' ? record.hookId : undefined;
    const eventId = typeof record.eventId === 'string' ? record.eventId : undefined;

    const pending: PendingSessionAction[] = [];
    const skipped: SessionActionSkip[] = [];

    try {
      for (const matcher of matchers) {
        if (!matcherMatches(matcher, event, record)) continue;
        if (!matcher.actions.some((a) => SESSION_ACTION_TYPES.has(a.type))) continue;

        const automationName = deriveAutomationName(event, matcher);

        // fork(PLAN-030) / ADR-0021 §3: loop safety, evaluated once per matcher rather
        // than per action — a matcher is refused as a unit, so a rule with two actions
        // can't half-fire and leave the session in a state neither branch intended.
        const decision = evaluateChainGuards(matcher.id, payload.causedBy);
        if (!decision.allow) {
          skipped.push({
            matcherId: matcher.id ?? automationName,
            automationName,
            event,
            reason: decision.reason,
            detail: decision.detail,
            sessionId: payload.sessionId,
          });
          continue;
        }

        if (!this.admitUnderRateGate(event, matcher.id ?? automationName)) {
          skipped.push({
            matcherId: matcher.id ?? automationName,
            automationName,
            event,
            reason: 'rate-limited',
            detail: `matcher exceeded ${SESSION_ACTION_RATE_PER_MINUTE} session actions/min`,
            sessionId: payload.sessionId,
          });
          continue;
        }

        for (const action of matcher.actions) {
          if (!SESSION_ACTION_TYPES.has(action.type)) continue;

          // fork(PLAN-030): one malformed action must not cost the others.
          // A `set-status` with no `session` validates clean (the schema union's
          // catch-all swallows it — see ADR-0021 §4) and then throws here on the
          // missing selector. Before this scope, that single throw unwound the
          // whole loop and discarded every action already queued, including
          // healthy ones from unrelated matchers that had nothing to do with the
          // bad rule. Skip the offending action, keep the rest.
          try {
            if (action.type === 'set-status') {
              pending.push({
                matcherId: matcher.id,
                automationName,
                type: 'set-status',
                target: expandSelector(action.session, env, body),
                status: expandActionString(action.status, env, body),
                allowClosed: action.allowClosed,
                hookId,
                eventId,
                event,
                cause: decision.cause,
              });
            } else if (action.type === 'set-labels') {
              pending.push({
                matcherId: matcher.id,
                automationName,
                type: 'set-labels',
                target: expandSelector(action.session, env, body),
                add: action.add?.map((l) => expandActionString(l, env, body)),
                remove: action.remove?.map((l) => expandActionString(l, env, body)),
                hookId,
                eventId,
                event,
                cause: decision.cause,
              });
            } else if (action.type === 'send-message') {
              pending.push({
                matcherId: matcher.id,
                automationName,
                type: 'send-message',
                target: expandSelector(action.session, env, body),
                message: expandActionString(action.message, env, body),
                hookId,
                eventId,
                event,
                cause: decision.cause,
              });
            }
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            log.error(
              `[SessionActionHandler] Skipping malformed "${action.type}" action on matcher `
              + `"${matcher.id ?? deriveAutomationName(event, matcher)}": ${err.message}`,
            );
          }
        }
      }

      for (const skip of skipped) {
        log.warn(
          `[SessionActionHandler] Refused session actions on "${skip.matcherId}" (${event}): `
          + `${skip.reason} — ${skip.detail}`,
        );
      }
      if (skipped.length > 0) this.options.onSessionActionSkipped?.(skipped);

      if (pending.length > 0 && this.options.onSessionActions) {
        log.debug(`[SessionActionHandler] Delivering ${pending.length} session actions`);
        this.options.onSessionActions(pending);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`[SessionActionHandler] Error handling ${event}: ${err.message}`);
      this.options.onError?.(event, err);
    }
  }

  /**
   * fork(PLAN-030): per-matcher rate gate, applied to app events only.
   *
   * `WebhookReceived` deliveries are already rate-limited per hook at the receiver
   * (`webhook-ingest/`), which is the real limiter and is tuned for the bursty arrival
   * pattern webhooks actually have. A second, tighter ceiling here would silently drop
   * deliveries the hook deliberately admitted — a behavior regression on a path that
   * works today, dressed up as loop safety. This is not transport-as-trust-boundary
   * (ADR-0021 rejects that); the gate is *already applied* on that path, upstream.
   */
  private admitUnderRateGate(event: AutomationEvent, matcherId: string): boolean {
    if (event === 'WebhookReceived') return true;
    return this.rateGate.check(matcherId, SESSION_ACTION_RATE_PER_MINUTE).allowed;
  }

  dispose(): void {
    if (this.bus && this.boundHandler) {
      this.bus.offAny(this.boundHandler);
      this.boundHandler = null;
    }
    this.bus = null;
    log.debug('[SessionActionHandler] Disposed');
  }
}
