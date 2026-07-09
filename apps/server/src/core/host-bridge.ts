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
 * NOTE: PLAN-014 introduces a shared `webhook-ingest` module. When it lands this
 * local type can be re-pointed at the shared definition without reshaping the
 * seam.
 */
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
   * webhook receiver (VOR-33) emits through this; the embedded host binds it to
   * the desktop AutomationSystem/SessionManager, the standalone host to headless
   * instances. PLAN-012 only guarantees it exists and is injected.
   */
  onWebhookEvent?: (workspaceId: string, payload: WebhookIngestEvent) => void;

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
