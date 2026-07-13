/**
 * fork(PLAN-017): onFailure action execution.
 *
 * When a not-ok history record is appended for a matcher (dispatch failure,
 * outcome `ok:false`, or a missed cron fire), the matcher's `onFailure` actions
 * run. Two callers:
 *   - `AutomationSystem` (missed-fire path) — routes prompt actions through the
 *     existing `onPromptsReady` callback with a `PendingPrompt` that has no
 *     `matcherId` (the host's `!pending.matcherId` skip is the recursion guard),
 *     and executes webhook actions via the shared executor.
 *   - `SessionManager` (dispatch/outcome path) — supplies its own `runPrompt`
 *     that calls `executePromptAutomation` directly without a matcherId.
 *
 * onFailure runs write **no** history records (keeps fire-count semantics clean)
 * and are never themselves outcome-reconciled or onFailure-triggered. All
 * failures of onFailure actions are logged and swallowed.
 */

import { createLogger } from '../utils/debug.ts';
import { parsePromptReferences } from './utils.ts';
import { executeWithRetry } from './webhook-utils.ts';
import type { PromptAction, WebhookAction, PendingPrompt } from './types.ts';

const log = createLogger('on-failure');

/** Context describing why onFailure fired — used as the default webhook body. */
export interface OnFailureContext {
  automationId: string;
  failureKind: 'dispatch' | 'outcome' | 'missed';
  sessionId?: string;
  errorCount?: number;
  expectedTs?: number;
  error?: string;
}

export interface RunOnFailureOptions {
  onFailure: (PromptAction | WebhookAction)[];
  automationName?: string;
  workspaceRootPath: string;
  context: OnFailureContext;
  /**
   * How to run a prompt action. When omitted, prompt actions are routed through
   * `onPromptsReady` with a matcher-less `PendingPrompt`.
   */
  runPrompt?: (action: PromptAction) => Promise<void>;
  /** The AutomationSystem callback used when `runPrompt` is not supplied. */
  onPromptsReady?: (prompts: PendingPrompt[]) => void;
}

/**
 * Build the default JSON body sent for an onFailure webhook that has no explicit
 * `body`. Carries the failure context so the receiver knows what failed.
 */
function buildFailureBody(context: OnFailureContext): Record<string, unknown> {
  return {
    automationId: context.automationId,
    failureKind: context.failureKind,
    ok: false,
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context.errorCount !== undefined ? { errorCount: context.errorCount } : {}),
    ...(context.expectedTs !== undefined ? { expectedTs: context.expectedTs } : {}),
    ...(context.error !== undefined ? { error: context.error } : {}),
  };
}

/**
 * Run a matcher's onFailure actions. Never throws — each action's failure is
 * logged and swallowed so a broken onFailure can't cascade.
 */
export async function runOnFailureActions(opts: RunOnFailureOptions): Promise<void> {
  const { onFailure, automationName, context } = opts;

  for (const action of onFailure) {
    try {
      if (action.type === 'webhook') {
        // No explicit body → send the failure context as JSON.
        const withBody: WebhookAction =
          action.body === undefined
            ? { ...action, body: buildFailureBody(context), bodyFormat: action.bodyFormat ?? 'json' }
            : action;
        // No history writes for onFailure — log only.
        const result = await executeWithRetry(withBody, { env: process.env as Record<string, string>, retry: { maxAttempts: 2 } });
        if (!result.success) {
          log.debug(`[onFailure] webhook ${context.automationId} → ${result.error ?? 'failed'}`);
        }
      } else if (action.type === 'prompt') {
        if (opts.runPrompt) {
          await opts.runPrompt(action);
        } else if (opts.onPromptsReady) {
          const references = parsePromptReferences(action.prompt);
          // matcherId undefined ⇒ host writes no history ⇒ no outcome/onFailure recursion.
          const pending: PendingPrompt = {
            sessionId: undefined,
            matcherId: undefined,
            automationName: automationName ? `${automationName} (onFailure)` : 'Automation onFailure',
            prompt: action.prompt,
            mentions: references.mentions,
            permissionMode: undefined,
            llmConnection: action.llmConnection,
            model: action.model,
            thinkingLevel: action.thinkingLevel,
            fastMode: action.fastMode,
          };
          opts.onPromptsReady([pending]);
        }
      }
    } catch (e) {
      log.debug(`[onFailure] action failed (${context.automationId}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
