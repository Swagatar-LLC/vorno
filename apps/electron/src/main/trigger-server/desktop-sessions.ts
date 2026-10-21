/**
 * fork(PLAN-057): HostBridge.createSession for the embedded host.
 *
 * Creates REST API sessions through the desktop SessionManager (the same path
 * as the UI's sessions:create), so browser panes, skills and sources are wired
 * as for a UI session and the session shows in the session list. The returned
 * handle translates SessionManager events (captured by the session event tap)
 * into wire AgentEvents. It forwards permission requests as events and never
 * answers them: the trigger-server core applies the API key's policy.
 *
 * Deps are a narrow interface so this runs under bun test without Electron.
 */

import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@craft-agent/core/types';
import type { PermissionMode } from '@craft-agent/shared/agent/mode-types';
import type { SessionEvent } from '@craft-agent/shared/protocol';
import {
  policyToPermissionMode,
  type HostBridge,
  type HostCreatedSession,
  type HostCreateSessionOptions,
  type HostSessionStatus,
} from '@craft-agent/http-trigger/core';
import type { SessionEventListener } from './session-event-tap';

export interface DesktopSessionDeps {
  createSession(workspaceId: string, options: {
    permissionMode: PermissionMode;
    model?: string;
    enabledSourceSlugs?: string[];
    workingDirectory?: string;
    projectId?: string;
    name: string;
  }): Promise<{ id: string }>;
  /** options.optimisticMessageId comes back on this message's user_message events. */
  sendMessage(sessionId: string, content: string, options?: { optimisticMessageId?: string }): Promise<unknown>;
  cancelProcessing(sessionId: string): Promise<unknown>;
  respondToPermission(sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean): boolean;
  deleteSession(sessionId: string): Promise<unknown>;
  getStatus(sessionId: string): HostSessionStatus;
  subscribe(sessionId: string, listener: SessionEventListener): () => void;
  getSdkSessionId?(sessionId: string): string | undefined;
  now?(): number;
}

/** Label shown in the desktop session list. A persisted name, so not localized. */
export function apiSessionName(apiKeyName: string): string {
  return `API · ${apiKeyName}`;
}

/** SessionEvent -> wire AgentEvent. Null for UI-only events. */
export function toAgentEvent(e: SessionEvent): AgentEvent | null {
  switch (e.type) {
    case 'text_delta': return { type: 'text_delta', text: e.delta, turnId: e.turnId };
    case 'text_complete': return { type: 'text_complete', text: e.text, isIntermediate: e.isIntermediate, turnId: e.turnId, parentToolUseId: e.parentToolUseId };
    case 'tool_start':
      return { type: 'tool_start', toolName: e.toolName, toolUseId: e.toolUseId, input: e.toolInput, intent: e.toolIntent, displayName: e.toolDisplayName, turnId: e.turnId, parentToolUseId: e.parentToolUseId, toolDisplayMeta: e.toolDisplayMeta };
    case 'tool_result':
      return { type: 'tool_result', toolUseId: e.toolUseId, toolName: e.toolName, result: e.result, isError: e.isError ?? false, turnId: e.turnId, parentToolUseId: e.parentToolUseId, headroomHandle: e.headroomHandle, headroomOriginalBytes: e.headroomOriginalBytes, headroomCompressedBytes: e.headroomCompressedBytes };
    case 'permission_request': {
      const r = e.request;
      return { type: 'permission_request', requestId: r.requestId, toolName: r.toolName, command: r.command, description: r.description, permissionType: r.type, appName: r.appName, reason: r.reason, impact: r.impact, requiresSystemPrompt: r.requiresSystemPrompt, rememberForMinutes: r.rememberForMinutes, commandHash: r.commandHash, approvalTtlSeconds: r.approvalTtlSeconds };
    }
    case 'error': return { type: 'error', message: e.error };
    case 'typed_error': return { type: 'typed_error', error: e.error };
    case 'complete': {
      const u = e.tokenUsage;
      return u
        ? { type: 'complete', usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheCreationTokens: u.cacheCreationTokens, costUsd: u.costUsd, contextWindow: u.contextWindow } }
        : { type: 'complete' };
    }
    case 'interrupted': return { type: 'complete' };
    case 'status': return { type: 'status', message: e.message };
    case 'info': return { type: 'info', message: e.message };
    case 'retry': return e.phase === 'backoff' ? { type: 'retry', phase: 'backoff', message: e.message } : { type: 'retry', phase: e.phase };
    case 'text_discard': return { type: 'text_discard', turnId: e.turnId };
    case 'working_directory_changed': return { type: 'working_directory_changed', workingDirectory: e.workingDirectory };
    case 'task_backgrounded': return { type: 'task_backgrounded', toolUseId: e.toolUseId, taskId: e.taskId, intent: e.intent, turnId: e.turnId, kind: e.kind, workflowId: e.workflowId };
    case 'shell_backgrounded': return { type: 'shell_backgrounded', toolUseId: e.toolUseId, shellId: e.shellId, intent: e.intent, command: e.command, turnId: e.turnId };
    case 'task_progress': return { type: 'task_progress', toolUseId: e.toolUseId, elapsedSeconds: e.elapsedSeconds, turnId: e.turnId };
    case 'task_completed': return { type: 'task_completed', taskId: e.taskId, status: e.status, outputFile: e.outputFile, summary: e.summary, turnId: e.turnId, toolUseId: e.toolUseId, launchedHere: e.launchedHere };
    case 'workflow_agent_completed': return { type: 'workflow_agent_completed', workflowId: e.workflowId, agentId: e.agentId, turnId: e.turnId };
    case 'shell_killed': return { type: 'shell_killed', shellId: e.shellId };
    case 'source_activated': return { type: 'source_activated', sourceSlug: e.sourceSlug, originalMessage: e.originalMessage };
    case 'usage_update': return { type: 'usage_update', usage: { inputTokens: e.tokenUsage.inputTokens, contextWindow: e.tokenUsage.contextWindow } };
    default: return null;
  }
}

export function createDesktopSessionRoute(deps: DesktopSessionDeps): NonNullable<HostBridge['createSession']> {
  const now = deps.now ?? Date.now;

  return async (opts: HostCreateSessionOptions): Promise<HostCreatedSession> => {
    const created = await deps.createSession(opts.workspaceId, {
      permissionMode: policyToPermissionMode(opts.permissionPolicy),
      model: opts.model,
      enabledSourceSlugs: opts.enabledSources,
      workingDirectory: opts.workingDirectory,
      projectId: opts.projectId,
      name: apiSessionName(opts.apiKeyName),
    });
    const sessionId = created.id;
    let lastActivityAt = now();
    let released = false;
    const unsubs = new Set<() => void>(); // end-of-chat callbacks of live chats

    const handle: HostCreatedSession = {
      sessionId,
      workspaceId: opts.workspaceId,

      chat(content: string): AsyncIterable<AgentEvent> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
            const buffer: AgentEvent[] = [];
            let wake: (() => void) | null = null;
            let done = false;
            // A send to a busy session is queued by SessionManager; until our message
            // starts its own turn, the running turn's events are not ours.
            let waitingForOwnTurn = false;
            // Set by the first turn event after our message is processing. A queued
            // replay announces each merged message back to back before the turn
            // starts, so another message's `processing` ends ours only after this.
            let ownTurnStarted = false;
            const poke = () => { const w = wake; wake = null; w?.(); };
            const finish = () => { done = true; unsub(); unsubs.delete(finish); poke(); };
            const push = (ev: AgentEvent, terminal: boolean) => {
              if (done) return;
              buffer.push(ev);
              if (terminal) finish(); else poke();
            };

            const messageId = `api-${randomUUID()}`;

            const onEvent: SessionEventListener = (e) => {
              lastActivityAt = now();
              if (e.type === 'session_deleted') {
                push({ type: 'error', message: 'Session was deleted in the desktop app' }, true);
                return;
              }
              if (e.type === 'user_message') {
                if (e.optimisticMessageId === messageId) {
                  if (e.status === 'queued') waitingForOwnTurn = true;
                  else if (e.status === 'processing') waitingForOwnTurn = false;
                } else if (e.status === 'processing' && !waitingForOwnTurn && ownTurnStarted) {
                  // SessionManager skips `complete` when a queued message follows and
                  // starts that message's turn: ours is over.
                  push({ type: 'complete' }, true);
                }
                return;
              }
              if (waitingForOwnTurn) return;
              const ev = toAgentEvent(e);
              if (!ev) return;
              ownTurnStarted = true;
              push(ev, ev.type === 'complete' || ev.type === 'error');
            };

            const unsub = deps.subscribe(sessionId, onEvent);
            unsubs.add(finish);

            deps.sendMessage(sessionId, content, { optimisticMessageId: messageId }).catch((err: unknown) => {
              push({ type: 'error', message: err instanceof Error ? err.message : String(err) }, true);
            });

            return {
              async next(): Promise<IteratorResult<AgentEvent>> {
                for (;;) {
                  const ev = buffer.shift();
                  if (ev) return { value: ev, done: false };
                  if (done) return { value: undefined, done: true };
                  await new Promise<void>((resolve) => { wake = resolve; });
                }
              },
              async return(): Promise<IteratorResult<AgentEvent>> {
                // Consumer stopped early (client disconnect): stop listening, keep the turn running.
                finish();
                return { value: undefined, done: true };
              },
            };
          },
        };
      },

      async abort() { await deps.cancelProcessing(sessionId); },
      respondToPermission(requestId, allowed) { return deps.respondToPermission(sessionId, requestId, allowed, false); },
      getStatus() { return deps.getStatus(sessionId); },
      getSdkSessionId() { return deps.getSdkSessionId?.(sessionId); },
      getLastActivityAt() { return lastActivityAt; },
      release() {
        if (released) return;
        released = true;
        // Ends any chat still streaming; the desktop session keeps running.
        for (const end of [...unsubs]) end();
      },
      async delete() {
        handle.release();
        await deps.deleteSession(sessionId);
      },
    };
    return handle;
  };
}
