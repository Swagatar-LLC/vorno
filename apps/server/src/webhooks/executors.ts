/**
 * Standalone webhook executors — fork(PLAN-014)
 *
 * The `apps/server` host implementation of the automation execution seam. The
 * handlers in `packages/shared` COMPUTE (`PendingPrompt` / `PendingSessionAction`
 * with `$ENV`/`$.jsonpath` expanded); these executors EXECUTE against the shared
 * on-disk session store — no Electron host, no SessionManager dependency.
 *
 * Result contract (`ExecResult.ok`) drives durable retry:
 *   - ok:false  → transient failure (fs error) → receiver keeps the entry and retries
 *   - ok:true   → terminal outcome (success OR a logged validation rejection /
 *                 deferred no-op) → the delivery is tombstoned, never retried
 */

import {
  createSession,
  loadSession,
  listSessions,
  setSessionStatus,
  setSessionLabels,
} from '@craft-agent/shared/sessions';
import { isValidLabelId } from '@craft-agent/shared/labels/storage';
import { extractLabelId } from '@craft-agent/shared/labels';
import {
  appendAutomationHistoryEntry,
  createPromptHistoryEntry,
  checkStatusAction,
  sessionActionOutcome,
  type PendingPrompt,
  type PendingSessionAction,
  type SessionTargetSelector,
  type ExecResult,
} from '@craft-agent/shared/automations';

export type { ExecResult };

/** Build a session-action history entry (matches the history-store envelope). */
function sessionActionHistoryEntry(action: PendingSessionAction, outcome: string, ok: boolean, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: action.matcherId ?? action.hookId ?? 'webhook',
    ts: Date.now(),
    ok,
    sessionAction: {
      type: action.type,
      outcome,
      ...(action.eventId ? { eventId: action.eventId } : {}),
      ...(extra ?? {}),
    },
  };
}

/**
 * Standalone prompt executor. Persists the session on disk (visible, labeled,
 * correct permission mode) with the payload reachable via
 * `$CRAFT_WEBHOOK_PAYLOAD_PATH`. NOTE: live agent execution of the prompt in
 * standalone mode is a documented follow-up (Risk #1 / PLAN-013 embedded host);
 * the durable, visible artifact — the session — is created here.
 */
export async function executeWebhookPrompt(rootPath: string, prompt: PendingPrompt): Promise<ExecResult> {
  try {
    const session = await createSession(rootPath, {
      name: prompt.automationName,
      labels: prompt.labels,
      permissionMode: prompt.permissionMode,
      model: prompt.model,
      llmConnection: prompt.llmConnection,
      sessionStatus: 'todo',
    });
    await safeAppendHistory(rootPath, createPromptHistoryEntry({
      matcherId: prompt.matcherId ?? 'webhook',
      ok: true,
      sessionId: session.id,
      prompt: prompt.prompt,
    }));
    return { ok: true, sessionId: session.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await safeAppendHistory(rootPath, createPromptHistoryEntry({
      matcherId: prompt.matcherId ?? 'webhook',
      ok: false,
      error: message,
    }));
    return { ok: false, error: message };
  }
}

/**
 * Resolve a target selector to a concrete session id, or null.
 * `id` → verify the session exists. `label` → most recently active session
 * carrying that label (exact entry match; valued `id::value` entries included).
 */
export function resolveTargetSession(rootPath: string, target: SessionTargetSelector): string | null {
  if (target.id) {
    return loadSession(rootPath, target.id) ? target.id : null;
  }
  if (target.label) {
    // listSessions is sorted most-recent-first.
    for (const meta of listSessions(rootPath)) {
      if ((meta.labels ?? []).includes(target.label)) return meta.id;
    }
  }
  return null;
}

/** Standalone session-action executor. */
export async function executeWebhookSessionAction(rootPath: string, action: PendingSessionAction): Promise<ExecResult> {
  const sessionId = resolveTargetSession(rootPath, action.target);
  if (!sessionId) {
    await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, sessionActionOutcome.targetNotFound, false, {
      target: action.target,
    }));
    return { ok: true, note: 'target-not-found' };
  }

  try {
    if (action.type === 'set-status') {
      const status = action.status ?? '';
      // House rule: agents never close tasks unless explicitly allowed at registration.
      // The shared gate rather than a third inline copy — all three hosts must produce
      // identical history outcomes for identical rejections (fork(PLAN-030) Phase 2a).
      const rejection = checkStatusAction(rootPath, status, action.allowClosed);
      if (rejection) {
        await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, rejection.outcome, false, { sessionId }));
        return { ok: true, note: rejection.note };
      }
      await setSessionStatus(rootPath, sessionId, status);
      await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, sessionActionOutcome.setStatus(status), true, { sessionId }));
      return { ok: true, sessionId };
    }

    if (action.type === 'set-labels') {
      const current = loadSession(rootPath, sessionId)?.labels ?? [];
      const removeSet = new Set(action.remove ?? []);
      const merged = [...current.filter((l) => !removeSet.has(l)), ...(action.add ?? [])];
      // Dedup then validate (drops labels not in the workspace config; valued entries preserved).
      const deduped = [...new Set(merged)];
      // Validate: drop labels whose id isn't configured in the workspace
      // (valued `id::value` entries preserved). Mirrors labels/validation.ts.
      const validated = deduped.filter((entry) => isValidLabelId(rootPath, extractLabelId(entry)));
      await setSessionLabels(rootPath, sessionId, validated);
      await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, sessionActionOutcome.setLabels, true, { sessionId, labels: validated }));
      return { ok: true, sessionId };
    }

    if (action.type === 'send-message') {
      // Standalone host cannot inject into a live agent it does not host (Risk #2).
      // Full support arrives with the embedded/headless host (PLAN-013 seam).
      await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, sessionActionOutcome.hostUnreachable, false, { sessionId }));
      return { ok: true, sessionId, note: 'host-unreachable' };
    }

    if (action.type === 'apply-context') {
      // fork(PLAN-030 Phase 3): same limit as `send-message`, for a sharper reason. The
      // three knobs a profile sets are all persisted session-header fields, so this host
      // *could* write them — and that is exactly the trap. Sources and permission mode
      // only take effect by re-plumbing a live agent (`setSourceServers`,
      // `agent.setPermissionMode`), which a disk-only host cannot do. Writing the header
      // would produce a record saying the context was applied while the running session
      // kept the old one. Deferring is the honest outcome.
      await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, sessionActionOutcome.hostUnreachable, false, { sessionId }));
      return { ok: true, sessionId, note: 'host-unreachable' };
    }

    // fork(PLAN-030 Phase 3): was a bare `return { ok: true }` — an unimplemented action
    // type recorded as a clean success with no trace. See the matching note in the desktop
    // executor; recording it is what stops the next action type repeating it.
    await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, sessionActionOutcome.unhandledAction(action.type), false, { sessionId }));
    return { ok: true, sessionId, note: 'unhandled-action' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, sessionActionOutcome.error(message), false, { sessionId }));
    return { ok: false, error: message };
  }
}

async function safeAppendHistory(rootPath: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await appendAutomationHistoryEntry(rootPath, entry);
  } catch {
    // History is best-effort — never fail an action on a logging error.
  }
}
