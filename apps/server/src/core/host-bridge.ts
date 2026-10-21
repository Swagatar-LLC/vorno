/**
 * HostBridge — the host-adapter seam (ADR-0007).
 *
 * The trigger-server core is constructed by whichever host owns its lifecycle:
 *  - Embedded host: the Electron desktop app (PLAN-012). Binds the callbacks
 *    below to the desktop's own AutomationSystem / SessionManager.
 *  - Standalone host: the Bun entry (apps/server/src/index.ts, PLAN-013).
 *    Binds them to headless instances (or leaves them unset).
 *
 * The core MUST NOT assume an Electron host exists (spec hard rule). Every
 * capability the core cannot provide runtime-neutrally is reached through this
 * bridge, injected at construction time.
 */

/**
 * A webhook ingest event — the receiver-to-automation seam from the approved
 * "Inbound Webhooks & Headless Server" design spec.
 *
 * PLAN-012 only guarantees this seam exists and is host-injected. The webhook
 * receiver (VOR-33) emits through it; until then nothing calls it. Shape mirrors
 * what AutomationSystem's onPromptsReady consumers expect (a workspace id plus a
 * free-form payload the automation matchers inspect).
 *
 * fork(PLAN-014): the shared `webhook-ingest` module has landed. Per this note's
 * own guidance, the canonical payload is now `WebhookReceivedPayload` (imported +
 * re-exported below); `WebhookIngestEvent` is retained as a structural alias so
 * any pre-PLAN-014 reference keeps resolving. The seam shape is unchanged.
 */
import type { WebhookReceivedPayload } from '@craft-agent/shared/automations';
import type { AgentEvent } from '@craft-agent/core/types';
import type { PermissionMode } from '@craft-agent/shared/agent/mode-types';
export type { WebhookReceivedPayload };

export interface WebhookIngestEvent {
  /** Source that produced the event (e.g. a capability-URL slug). */
  source: string;
  /** Arbitrary decoded payload the automation layer matches against. */
  payload: unknown;
  /** When the event was received (epoch ms). */
  receivedAt: number;
  /** Optional opaque headers/metadata captured at ingest. */
  meta?: Record<string, string>;
}

/**
 * The seam between the runtime-neutral trigger-server core and its host.
 *
 * All members are optional so a host can adopt them incrementally. The core
 * feature-detects each callback and no-ops when it is absent.
 */
export interface HostBridge {
  /**
   * Spec seam — same shape/role as AutomationSystem's onPromptsReady. The
   * webhook receiver (VOR-33/PLAN-014) emits through this; the embedded host
   * binds it to the desktop AutomationSystem/SessionManager, the standalone host
   * to headless instances.
   *
   * fork(PLAN-014): the payload is the canonical `WebhookReceivedPayload`, and the
   * return type admits `Promise<void>` so the receiver can await executor work and
   * mark its durable queue entry complete (or retry on rejection). PLAN-012's
   * logging-stub still satisfies the `void` branch.
   */
  onWebhookEvent?: (workspaceId: string, payload: WebhookReceivedPayload) => void | Promise<void>;

  /**
   * fork(PLAN-057): session-creation route-through (PLAN-012 open question 2).
   *
   * When the host provides this AND the persisted server config has
   * `routeSessionsToDesktop: true`, `POST /api/sessions` creates the session
   * through the host (the desktop SessionManager: browser, skills, sources, and
   * the session is visible in the UI) instead of the core's own SessionPool.
   * The core still owns auth, the workspace check, the policy cap, per-key
   * concurrency and ownership: it adopts the returned handle into its pool.
   *
   * The standalone host leaves this unset, so it always uses the core pool.
   */
  createSession?: (opts: HostCreateSessionOptions) => Promise<HostCreatedSession>;
}

/** The REST permission policy, already capped by the API key (getEffectivePolicy). */
export type RestPermissionPolicy = 'deny-all' | 'allow-safe' | 'allow-all';

/** fork(PLAN-057): what the core asks the host to create. */
export interface HostCreateSessionOptions {
  workspaceId: string;
  model?: string;
  /** Effective (capped) policy. The host maps it with {@link policyToPermissionMode}. */
  permissionPolicy: RestPermissionPolicy;
  enabledSources?: string[];
  workingDirectory?: string;
  /** Workspace project id to affiliate the session with; already validated by the core. */
  projectId?: string;
  /** Display name of the API key that created the session, for labelling. Never the key itself. */
  apiKeyName: string;
}

/** Status the REST routes report for a session. */
export type HostSessionStatus = 'idle' | 'processing' | 'disposed';

/**
 * fork(PLAN-057): a live handle on a host-owned session. The core wraps it in a
 * RoutedSession and keeps it in its SessionPool like any other session.
 *
 * Events are wire `AgentEvent`s (same contract as the core pool's sessions).
 * The host emits `permission_request` events and does NOT answer them itself;
 * the core applies the key's policy and routes the rest to the REST
 * pending/permissions endpoints.
 */
export interface HostCreatedSession {
  sessionId: string;
  workspaceId: string;
  /**
   * Send one user message and stream the turn. The iterator ends after it
   * yields `complete` or `error` (an interrupted turn yields `complete`).
   */
  chat(content: string): AsyncIterable<AgentEvent>;
  /** Stop the current turn, if any. */
  abort(): Promise<void>;
  /** Answer a permission request. Returns false when it is no longer pending. */
  respondToPermission(requestId: string, allowed: boolean): boolean;
  getStatus(): HostSessionStatus;
  getSdkSessionId(): string | undefined;
  getLastActivityAt(): number;
  /** Detach from the REST API (idle eviction, server stop). The session stays in the desktop. */
  release(): void;
  /** DELETE /api/sessions/:id — remove the session from the desktop too. */
  delete(): Promise<void>;
}

/**
 * Map the REST policy onto a session permission mode. Same mapping the core
 * pool's AgentSession uses: deny-all → safe (Explore, read-only), allow-safe →
 * ask, allow-all → allow-all.
 */
export function policyToPermissionMode(policy: RestPermissionPolicy | undefined): PermissionMode {
  switch (policy) {
    case 'allow-all':
      return 'allow-all';
    case 'allow-safe':
      return 'ask';
    case 'deny-all':
    default:
      return 'safe';
  }
}
