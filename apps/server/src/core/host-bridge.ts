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
   * Optional session-creation route-through (open question 2 in PLAN-012).
   *
   * v1 embedded + standalone both keep the core's own SessionPool for REST/WS
   * session creation (behavior parity). This member is the reserved seam so a
   * future version can route REST session creation through the desktop
   * SessionManager (sessions visible in the live UI) WITHOUT reshaping the
   * bridge — the core does not call it yet.
   */
  createSession?: (opts: HostCreateSessionOptions) => Promise<HostCreatedSession>;
}

/** Reserved shape for the optional createSession route-through (unused in v1). */
export interface HostCreateSessionOptions {
  workspaceId: string;
  model?: string;
  permissionPolicy?: 'deny-all' | 'allow-safe' | 'allow-all';
  enabledSources?: string[];
  workingDirectory?: string;
}

/** Reserved return shape for the optional createSession route-through (unused in v1). */
export interface HostCreatedSession {
  sessionId: string;
  workspaceId: string;
}
