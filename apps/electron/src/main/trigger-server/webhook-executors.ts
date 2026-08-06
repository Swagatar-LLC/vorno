/**
 * Embedded (desktop) webhook executors — fork(PLAN-014)
 *
 * The Electron-host implementation of the automation execution seam. The shared
 * handlers COMPUTE (`PendingPrompt` / `PendingSessionAction`, with `$ENV` /
 * `$.jsonpath` already expanded); these executors EXECUTE against the LIVE
 * desktop `SessionManager` — full UI parity:
 *
 *  - prompt      → `executePromptAutomation`: the session appears LIVE in the
 *                  running app, exactly like a cron-spawned automation (same
 *                  labels / permission mode / model / telegram binding).
 *  - set-status  → `setSessionStatus`: status change reflects in the UI (the
 *                  updateSessionMetadata diff path fires chain automations).
 *  - set-labels  → `setSessionLabels`: labels reflect in the UI.
 *  - send-message→ `sendMessage`: injects into the live desktop session — the
 *                  case the standalone host cannot serve (PLAN-014 Risk #2).
 *
 * Contrast with the standalone disk-only executors (apps/server/src/webhooks/
 * executors.ts), which write session JSONL headers a running app doesn't watch.
 *
 * Result contract (`ExecResult.ok`) drives durable retry:
 *   - ok:false → transient failure (IPC / fs error) → receiver keeps + retries.
 *   - ok:true  → terminal (success OR logged validation rejection) → tombstoned.
 */

import { isValidStatusId, getStatusCategory } from '@craft-agent/shared/statuses/storage'
import { isValidLabelId } from '@craft-agent/shared/labels/storage'
import { extractLabelId } from '@craft-agent/shared/labels'
import {
  appendAutomationHistoryEntry,
  createPromptHistoryEntry,
  type PendingPrompt,
  type PendingSessionAction,
  type SessionTargetSelector,
  type ResolvedWorkspace,
  type ExecResult,
  type WebhookDispatcherExecutors,
} from '@craft-agent/shared/automations'
import type { Session, SessionStatus } from '@craft-agent/shared/protocol'
import type { PermissionMode, ThinkingLevel } from '@craft-agent/shared/agent'

/**
 * The narrow slice of `SessionManager` the desktop executors depend on. Kept
 * structural (not the full `ISessionManager`) so the composition is unit-testable
 * with a lightweight fake and doesn't couple to the whole surface.
 */
export interface WebhookSessionManager {
  executePromptAutomation(input: {
    workspaceId: string
    workspaceRootPath: string
    prompt: string
    labels?: string[]
    permissionMode?: PermissionMode
    mentions?: string[]
    llmConnection?: string
    model?: string
    thinkingLevel?: ThinkingLevel
    fastMode?: boolean
    automationName?: string
    telegramTopic?: string
    waitForCompletion?: boolean
  }): Promise<{ sessionId: string }>
  getSession(sessionId: string): Promise<Session | null>
  getSessions(workspaceId?: string): Session[]
  setSessionStatus(sessionId: string, status: SessionStatus): Promise<void>
  setSessionLabels(sessionId: string, labels: string[]): void
  sendMessage(sessionId: string, message: string): Promise<void>
}

/** Build a session-action history entry (matches the history-store envelope). */
function sessionActionHistoryEntry(
  action: PendingSessionAction,
  outcome: string,
  ok: boolean,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
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
  }
}

async function safeAppendHistory(rootPath: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await appendAutomationHistoryEntry(rootPath, entry)
  } catch {
    // History is best-effort — never fail an action on a logging error.
  }
}

/**
 * Desktop prompt executor. Creates a LIVE session through the desktop
 * `SessionManager` (visible in the running app, labeled, correct permission
 * mode) and dispatches the prompt. `waitForCompletion: false` returns once the
 * session is created + the prompt dispatched — so the durable ingest entry is
 * marked complete promptly (the session then streams live), rather than the
 * receiver holding the entry open for the whole agent turn.
 */
export function createDesktopWebhookExecutors(sm: WebhookSessionManager): WebhookDispatcherExecutors {
  async function executePrompt(ws: ResolvedWorkspace, prompt: PendingPrompt): Promise<ExecResult> {
    try {
      const { sessionId } = await sm.executePromptAutomation({
        workspaceId: ws.workspaceId,
        workspaceRootPath: ws.rootPath,
        prompt: prompt.prompt,
        labels: prompt.labels,
        permissionMode: prompt.permissionMode,
        mentions: prompt.mentions,
        llmConnection: prompt.llmConnection,
        model: prompt.model,
        thinkingLevel: prompt.thinkingLevel,
        fastMode: prompt.fastMode,
        automationName: prompt.automationName,
        telegramTopic: prompt.telegramTopic,
        waitForCompletion: false,
      })
      await safeAppendHistory(ws.rootPath, createPromptHistoryEntry({
        matcherId: prompt.matcherId ?? 'webhook',
        ok: true,
        sessionId,
        prompt: prompt.prompt,
      }))
      return { ok: true, sessionId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await safeAppendHistory(ws.rootPath, createPromptHistoryEntry({
        matcherId: prompt.matcherId ?? 'webhook',
        ok: false,
        error: message,
      }))
      return { ok: false, error: message }
    }
  }

  /**
   * Resolve a target selector to a concrete session id, or null.
   * `id` → verify the session exists. `label` → most recently active session in
   * the workspace carrying that label (exact entry match; valued `id::value`
   * entries included). `getSessions` is sorted most-recent-first.
   */
  async function resolveTargetSession(ws: ResolvedWorkspace, target: SessionTargetSelector): Promise<string | null> {
    if (target.id) {
      return (await sm.getSession(target.id)) ? target.id : null
    }
    if (target.label) {
      for (const meta of sm.getSessions(ws.workspaceId)) {
        if ((meta.labels ?? []).includes(target.label)) return meta.id
      }
    }
    return null
  }

  async function executeSessionAction(ws: ResolvedWorkspace, action: PendingSessionAction): Promise<ExecResult> {
    const rootPath = ws.rootPath
    const sessionId = await resolveTargetSession(ws, action.target)
    if (!sessionId) {
      await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, 'deferred:target-not-found', false, {
        target: action.target,
      }))
      return { ok: true, note: 'target-not-found' }
    }

    try {
      if (action.type === 'set-status') {
        const status = action.status ?? ''
        if (!isValidStatusId(rootPath, status)) {
          await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, `rejected:invalid-status:${status}`, false, { sessionId }))
          return { ok: true, note: 'invalid-status' }
        }
        if (getStatusCategory(rootPath, status) === 'closed' && !action.allowClosed) {
          // House rule: agents never close tasks unless explicitly allowed at registration.
          await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, `rejected:closed-status:${status}`, false, { sessionId }))
          return { ok: true, note: 'closed-status-rejected' }
        }
        // The executor's own closed-status check above is the primary, message-producing gate;
        // this origin carries the same declared intent down to the choke point so the two cannot
        // disagree (PLAN-031). `allowClosed` is registration-time only — there is no runtime path
        // that sets it (ADR-0021 §2).
        await sm.setSessionStatus(sessionId, status, {
          kind: 'automation',
          matcherId: action.matcherId ?? 'webhook',
          allowClosed: action.allowClosed === true,
        })
        await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, `set-status:${status}`, true, { sessionId }))
        return { ok: true, sessionId }
      }

      if (action.type === 'set-labels') {
        const current = (await sm.getSession(sessionId))?.labels ?? []
        const removeSet = new Set(action.remove ?? [])
        const merged = [...current.filter((l) => !removeSet.has(l)), ...(action.add ?? [])]
        const deduped = [...new Set(merged)]
        // Validate: drop labels whose id isn't configured in the workspace
        // (valued `id::value` entries preserved). Mirrors labels/validation.ts.
        const validated = deduped.filter((entry) => isValidLabelId(rootPath, extractLabelId(entry)))
        sm.setSessionLabels(sessionId, validated)
        await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, 'set-labels', true, { sessionId, labels: validated }))
        return { ok: true, sessionId }
      }

      if (action.type === 'send-message') {
        // Embedded host CAN inject into the live desktop session (unlike standalone).
        const message = action.message ?? ''
        await sm.sendMessage(sessionId, message)
        await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, 'send-message', true, { sessionId }))
        return { ok: true, sessionId }
      }

      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await safeAppendHistory(rootPath, sessionActionHistoryEntry(action, `error:${message}`, false, { sessionId }))
      return { ok: false, error: message }
    }
  }

  return { executePrompt, executeSessionAction }
}
