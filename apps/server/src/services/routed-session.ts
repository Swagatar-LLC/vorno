/**
 * fork(PLAN-057): RoutedSession — a desktop-owned session (HostCreatedSession)
 * adopted into the core SessionPool so the REST routes treat it like any other.
 *
 * It applies the key's effective policy to the handle's permission requests:
 * auto-answer what the policy allows, hold the rest as pending and forward the
 * event so a REST client can answer through /pending and /permissions. Nothing
 * outside the policy is ever approved silently.
 */
import type { AgentEvent } from '@craft-agent/core/types';
import type { HostCreatedSession, HostSessionStatus, RestPermissionPolicy } from '../core/host-bridge.ts';
import { SAFE_COMMANDS } from '../orchestrator/agent-session.ts';
import type { PendingPermission, PoolSession } from './session-pool.ts';

export class RoutedSession implements PoolSession {
  private pending = new Map<string, PendingPermission>();
  private released = false;

  constructor(
    private readonly handle: HostCreatedSession,
    private readonly policy: RestPermissionPolicy,
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
      const command = (event.command ?? '').trim();
      if (this.policy === 'allow-all') {
        this.handle.respondToPermission(event.requestId, true);
        continue;
      }
      if (this.policy === 'allow-safe' && SAFE_COMMANDS.has(command.split(/\s+/)[0] ?? '')) {
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
      yield event;
    }
    // Turn over: nothing can still be waiting on an answer.
    this.denyPending();
  }

  /** Returns false when the id is not pending. */
  respondToPermission(requestId: string, allowed: boolean): boolean {
    if (!this.pending.delete(requestId)) return false;
    return this.handle.respondToPermission(requestId, allowed);
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
    for (const id of this.pending.keys()) this.handle.respondToPermission(id, false);
    this.pending.clear();
  }
}
