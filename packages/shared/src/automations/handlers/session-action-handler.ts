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
 * v1 scope: only WebhookReceived matchers carry the three session-mutation
 * action types (validator-gated), so this handler is WebhookReceived-only.
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

const log = createLogger('session-action-handler');

export interface SessionActionHandlerOptions {
  workspaceId: string;
  workspaceRootPath: string;
  /** Called when session actions are ready for the host to execute. */
  onSessionActions?: (actions: PendingSessionAction[]) => void;
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

  constructor(options: SessionActionHandlerOptions, configProvider: AutomationsConfigProvider) {
    this.options = options;
    this.configProvider = configProvider;
  }

  subscribe(bus: EventBus): void {
    this.bus = bus;
    this.boundHandler = this.handleEvent.bind(this);
    bus.onAny(this.boundHandler);
    log.debug('[SessionActionHandler] Subscribed to event bus');
  }

  private async handleEvent(event: AutomationEvent, payload: BaseEventPayload): Promise<void> {
    // v1: session actions ride WebhookReceived only.
    if (event !== 'WebhookReceived') return;

    const matchers = this.configProvider.getMatchersForEvent(event);
    if (matchers.length === 0) return;

    const record = payload as unknown as Record<string, unknown>;
    const body = record.body;
    const env = buildEnvFromPayload(event, payload);
    const hookId = typeof record.hookId === 'string' ? record.hookId : undefined;
    const eventId = typeof record.eventId === 'string' ? record.eventId : undefined;

    const pending: PendingSessionAction[] = [];

    try {
      for (const matcher of matchers) {
        if (!matcherMatches(matcher, event, record)) continue;

        for (const action of matcher.actions) {
          if (!SESSION_ACTION_TYPES.has(action.type)) continue;

          const automationName = deriveAutomationName(event, matcher);

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
            });
          }
        }
      }

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

  dispose(): void {
    if (this.bus && this.boundHandler) {
      this.bus.offAny(this.boundHandler);
      this.boundHandler = null;
    }
    this.bus = null;
    log.debug('[SessionActionHandler] Disposed');
  }
}
