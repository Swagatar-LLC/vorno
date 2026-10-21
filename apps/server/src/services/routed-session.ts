/**
 * fork(PLAN-057): RoutedSession — a desktop-owned session (HostCreatedSession)
 * adopted into the core SessionPool so the REST routes treat it like any other.
 *
 * It applies the key's effective policy to the handle's permission requests:
 * auto-answer what the policy allows, hold the rest as pending and forward the
 * event so a REST client can see them through /pending. The REST client may only
 * DENY a held request: approving it would exceed the key's policy. The desktop
 * user can still answer it in the app (the desktop owner's authority, not the
 * key's). A request left pending is denied after pendingTimeoutMs.
 */
import type { AgentEvent } from '@craft-agent/core/types';
import type { HostCreatedSession, HostSessionStatus, RestPermissionPolicy } from '../core/host-bridge.ts';
import { SAFE_COMMANDS } from '../orchestrator/agent-session.ts';
import type { PendingPermission, PoolSession } from './session-pool.ts';

export const DEFAULT_PENDING_TIMEOUT_MS = 5 * 60_000;

const UNSAFE_SHELL_CHARS = /[;|&$()`<>\n\r]/;

/**
 * Auto-approve test for allow-safe: no shell metacharacters or newline, and the
 * first token is a SAFE_COMMANDS entry. The pool's AgentSession still uses the
 * plain first-word check; only routed sessions use this stricter one.
 */
export function isSafeCommand(command: string): boolean {
  const c = command.trim();
  if (!c || UNSAFE_SHELL_CHARS.test(c)) return false;
  return SAFE_COMMANDS.has(c.split(/\s+/)[0] ?? '');
}

export class RoutedSession implements PoolSession {
  readonly hostOwned = true;
  private pending = new Map<string, PendingPermission>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private released = false;

  constructor(
    private readonly handle: HostCreatedSession,
    private readonly policy: RestPermissionPolicy,
    private readonly pendingTimeoutMs: number = DEFAULT_PENDING_TIMEOUT_MS,
  ) {}

  get sessionId(): string {
    return this.handle.sessionId;
  }

  getStatus(): HostSessionStatus {
    return this.released ? 'disposed' : this.handle.getStatus();
  }
  getSdkSessionId(): string | undefined {
    return this.handle.getSdkSessionId();
  }
  getLastActivityAt(): number {
    return this.handle.getLastActivityAt();
  }

  getPending(): PendingPermission[] {
    return [...this.pending.values()];
  }

  async *chat(content: string): AsyncGenerator<AgentEvent> {
    for await (const event of this.handle.chat(content)) {
      if (event.type !== 'permission_request') {
        yield event;
        continue;
      }
      const command = event.command ?? '';
      if (this.policy === 'allow-all') {
        this.handle.respondToPermission(event.requestId, true);
        continue;
      }
      if (this.policy === 'allow-safe' && isSafeCommand(command)) {
        this.handle.respondToPermission(event.requestId, true);
        continue;
      }
      this.pending.set(event.requestId, {
        requestId: event.requestId,
        toolName: event.toolName,
        command: event.command,
        description: event.description,
        permissionType: event.permissionType,
      });
      this.armTimeout(event.requestId);
      yield event;
    }
    // Turn over: nothing can still be waiting on an answer.
    this.denyPending();
  }

  /**
   * Returns false when the id is not pending, and 'forbidden' (request stays
   * pending) when a REST client tries to approve above the key's policy.
   */
  respondToPermission(requestId: string, allowed: boolean): boolean | 'forbidden' {
    if (!this.pending.has(requestId)) return false;
    if (allowed && this.policy !== 'allow-all') return 'forbidden';
    this.clear(requestId);
    return this.safeRespond(requestId, allowed);
  }

  async abort(): Promise<void> {
    this.denyPending();
    await this.handle.abort();
  }

  /** Eviction / drain: detach from the REST API; the desktop session stays. */
  dispose(): void {
    if (this.released) return;
    this.denyPending();
    this.released = true;
    this.handle.release();
  }

  /** DELETE route: remove the session from the desktop too. */
  async destroy(): Promise<void> {
    this.denyPending();
    this.released = true;
    await this.handle.delete();
  }

  private denyPending(): void {
    for (const id of [...this.pending.keys()]) {
      this.clear(id);
      this.safeRespond(id, false);
    }
  }

  private armTimeout(requestId: string): void {
    const t = setTimeout(() => {
      if (!this.pending.has(requestId)) return;
      this.clear(requestId);
      this.safeRespond(requestId, false);
    }, this.pendingTimeoutMs);
    (t as { unref?: () => void }).unref?.();
    this.timers.set(requestId, t);
  }

  private clear(requestId: string): void {
    this.pending.delete(requestId);
    const t = this.timers.get(requestId);
    if (t) clearTimeout(t);
    this.timers.delete(requestId);
  }

  /** The desktop user may have answered first; a late answer must not throw. */
  private safeRespond(requestId: string, allowed: boolean): boolean {
    try { return this.handle.respondToPermission(requestId, allowed); } catch { return false; }
  }
}
