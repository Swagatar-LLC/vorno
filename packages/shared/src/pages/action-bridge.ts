/**
 * Page Action Bridge — mediated source actions for Pages
 *
 * Page JS never talks to sources. It posts a request up to the host, and this
 * broker decides whether the host executes it. Mirrors (and extends) the
 * privilegedExecutionBroker pattern:
 *
 *   render lease  — in-memory, per render instance. Issued when the host
 *                   mounts a page; carries a nonce the page must echo on
 *                   every request (frame identity without a trustable
 *                   Origin). Bound to the page's content digest — content
 *                   changes end the lease.
 *   grant         — persisted in page.json, user-approved, content-digest
 *                   bound (like commandHash) AND expiring. Describes a class
 *                   of calls (api method + path regex, or one mcp tool).
 *   authority     — what the HOST asserts about the call: canonical workspace,
 *                   declared origin, permission mode. Never wire data; see
 *                   PageActionAuthority in @craft-agent/core.
 *   activation    — a host-minted, single-use, ≤10s ticket bound to the exact
 *                   request. Every mutating action needs one, so a page cannot
 *                   act on load, on a timer, or from a forged RPC call.
 *   request       — one concrete invocation. Must carry a valid lease
 *                   (id + nonce), a fresh unique requestId (replay check),
 *                   and a grant that matches the invocation.
 *
 * This broker is the AUTHORITATIVE gate, not the first one. The renderer runs
 * its own bounded limiter and its own mutation check, but anything that can
 * reach the executeAction RPC — a token-holding transport client, the WebUI, a
 * direct call — skips all of that. Every check the product depends on is
 * therefore repeated here, per invocation, against state re-read from disk.
 *
 * Execution is delegated to injected executors (built by the host from the
 * shared source machinery), always under an AbortSignal: every action has a
 * timeout and can be cancelled mid-flight. Credentials are resolved inside
 * the executors at call time and never appear in requests, results, or the
 * audit log.
 *
 * Every decision — lease issued, action executed/rejected/cancelled — is
 * appended to a durable JSONL audit log (~/.craft-agent/logs/page-actions.jsonl),
 * with caller-supplied objects redacted by key name.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  PageActionAuthority,
  PageActionGrant,
  PageActionInvocation,
  PageActionOrigin,
  PageActionRequest,
  PageActionResult,
  PageActionHttpMethod,
  PageScriptRuntime,
  PageConfig,
  PageRenderLease,
} from '@craft-agent/core';
import { CONFIG_DIR } from '../config/paths.ts';
import { createLogger } from '../utils/debug.ts';
import { redactSensitiveValues } from '../utils/redaction.ts';
import { evaluateApiEndpointPolicy, evaluateMcpToolPolicy, type SourceActionPolicyDecision } from '../agent/source-policy.ts';
import type { PermissionsContext } from '../agent/permissions-config.ts';
import { proxyToolName } from '../mcp/proxy-tool-name.ts';
import {
  hasPathTraversal,
  isMutatingPageAction,
  pageActionDescriptorSignature,
  pageActionOriginAllowsKind,
  pageActionOriginPolicy,
} from './types.ts';

const log = createLogger('page-action-broker');

/**
 * The single durable append path for Page-action decisions. Keeping redaction
 * beside persistence prevents lifecycle callers from creating a second JSONL
 * writer that can drift from execution auditing.
 */
export async function appendPageActionAudit(
  payload: Record<string, unknown>,
  options: { auditLogPath?: string; onError?: (error: unknown) => void } = {},
): Promise<void> {
  try {
    const auditLogPath = options.auditLogPath ?? join(CONFIG_DIR, 'logs', 'page-actions.jsonl');
    await mkdir(dirname(auditLogPath), { recursive: true });
    await appendFile(
      auditLogPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...redactSensitiveValues(payload) })}\n`,
      'utf8',
    );
  } catch (error) {
    if (options.onError) options.onError(error);
    else log.warn(`[PageActionBroker] Failed to write audit log: ${error}`);
  }
}

/** Default render-lease lifetime; re-mounting a page issues a fresh lease */
export const DEFAULT_PAGE_LEASE_TTL_MS = 12 * 60 * 60 * 1000;
/** Default per-action timeout */
export const DEFAULT_PAGE_ACTION_TIMEOUT_MS = 30_000;
/** Replay-cache cap per lease — beyond this the lease must be re-issued */
const MAX_SEEN_REQUEST_IDS_PER_LEASE = 5_000;
/**
 * Host-side per-lease budget. The renderer runs its own PageActionRateLimiter
 * with the same numbers, but that one is advisory — anything that can reach
 * the executeAction RPC bypasses it, so the broker enforces the real cap.
 * Matching the renderer's budget means a well-behaved page never hits this.
 */
export const PAGE_ACTION_MAX_IN_FLIGHT_PER_LEASE = 5;
export const PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE = 30;
const PAGE_ACTION_RATE_WINDOW_MS = 60_000;
/**
 * Cap on simultaneously live leases. Expiry alone (12h TTL) lets a re-mount
 * loop grow the lease + replay-cache maps unbounded; past the cap the
 * oldest-issued lease is evicted (audited) — old renders lose their lease and
 * recover by re-mounting, new mounts always work.
 */
export const MAX_LIVE_LEASES = 256;

/**
 * ADR-0033 §3 caps activation-ticket lifetime at 10 seconds. The cap is the
 * architecture decision; the exact lifetime below it is implementation policy.
 * Both live here so a future tuning change cannot quietly cross the ceiling —
 * the constructor clamps to it rather than trusting the option it is given.
 */
export const PAGE_ACTIVATION_TICKET_TTL_CEILING_MS = 10_000;
export const DEFAULT_PAGE_ACTIVATION_TICKET_TTL_MS = 10_000;
/**
 * Outstanding tickets per lease. A ticket is proof of one interaction, so more
 * than a handful live at once means tickets are being stockpiled rather than
 * spent — the cap turns that into a refusal instead of a growing map.
 */
export const MAX_OUTSTANDING_TICKETS_PER_LEASE = 4;
/**
 * Concurrency for MUTATING actions on one render, and the queue behind it.
 *
 * Two, not five: a mutating action is a write to a real system, and a page that
 * genuinely needs a third simultaneous write is a page doing something the user
 * did not click for. The queue exists so a burst of legitimate clicks serializes
 * instead of failing, and it is bounded so a burst cannot become a backlog.
 */
export const PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE = 2;
export const PAGE_ACTION_MAX_QUEUED_MUTATING_PER_LEASE = 4;
/**
 * Sliding 60-second start budgets above the lease. The per-lease limit alone is
 * evaded by re-mounting: every fresh render is a fresh lease with a fresh
 * budget, so cost is only actually bounded when the ceiling also exists at the
 * page and the workspace, which re-mounting cannot reset.
 */
export const PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_PAGE = 60;
export const PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_WORKSPACE = 120;

export type PageActionValidationErrorCode =
  | 'origin-unattributed'
  | 'origin-forbidden'
  | 'permission-mode-forbidden'
  | 'workspace-mismatch'
  | 'lease-not-found'
  | 'lease-page-mismatch'
  | 'lease-expired'
  | 'nonce-mismatch'
  | 'replay'
  | 'replay-cache-full'
  | 'content-missing'
  | 'content-changed'
  | 'grant-not-found'
  | 'grant-stale'
  | 'grant-expired'
  | 'grant-mismatch'
  | 'grant-pattern-invalid'
  | 'invocation-path-unsafe'
  | 'activation-required'
  | 'activation-invalid'
  | 'first-use-confirmation-required'
  | 'first-use-confirmation-declined'
  | 'rate-limited'
  | 'queue-overflow'
  | 'timeout'
  | 'cancelled'
  | 'executor-unavailable';

type ValidationOutcome =
  | { ok: true; grant: PageActionGrant; mutating: boolean }
  | { ok: false; code: PageActionValidationErrorCode; reason: string };

/**
 * A host-minted, single-use proof that a trusted interaction authorized one
 * exact request.
 *
 * `requestHash` is the whole point: the ticket is not "this render may act", it
 * is "this render may run THIS call". Without the hash a ticket minted for a
 * harmless granted GET could be spent on a granted script run, because both are
 * the same lease and the same page.
 *
 * The record is held only here. Nothing bound into it ever travels to the page,
 * which is what makes the ticket id safe to hand out: it names a capability the
 * broker holds rather than describing one the caller could rebuild.
 */
interface PageActivationTicket {
  ticketId: string;
  requestHash: string;
  workspaceId: string;
  pageSlug: string;
  leaseId: string;
  contentDigest: string;
  grantId: string;
  requestId: string;
  /**
   * Canonical signature of the descriptor as it stood when this ticket was
   * minted — i.e. the command the user was actually shown and agreed to.
   *
   * A grant id is not the command. `page.json` can be rewritten in place while
   * a confirmation dialog is open, keeping the same grant id and the same
   * content digest (the digest covers index.html, not the grant list), so
   * "the descriptor under this id" is mutable state and the ticket would
   * otherwise authorize whatever it became. Recording the signature makes the
   * ticket name the command rather than the slot it lives in.
   */
  descriptorSignature: string;
  origin: PageActionOrigin;
  issuedAt: number;
  expiresAt: number;
}

/**
 * The canonical identity of one invocation, as a hash.
 *
 * Canonical because key order is not identity: `JSON.stringify` preserves the
 * insertion order of a caller-supplied object, so `{path,method}` and
 * `{method,path}` would hash differently and a re-serialized copy of an
 * authorized request would fail to match its own ticket. Sorting every object
 * key makes the hash a property of the call rather than of how it was typed.
 *
 * Deliberately covers the whole request including `requestId`, so a ticket is
 * spendable exactly once on exactly one request — replay defence and ticket
 * binding agree on what "the same call" means instead of each having a view.
 * `activationTicket` itself is excluded: it is the thing being matched, and
 * including it would require the ticket to know its own hash.
 */
export function canonicalPageActionHash(
  workspaceId: string,
  contentDigest: string,
  request: PageActionRequest,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalizeForHash({
          workspaceId,
          contentDigest,
          requestId: request.requestId,
          pageSlug: request.pageSlug,
          leaseId: request.leaseId,
          nonce: request.nonce,
          grantId: request.grantId,
          invocation: request.invocation,
        }),
      ),
    )
    .digest('hex');
}

/**
 * Marker for the broker's own deadline firing, as opposed to an executor
 * failing. A sentinel class rather than a message check: the two produce
 * different audit outcomes and different user-facing text, and matching on
 * message strings is how that distinction rots.
 */
class PageActionDeadlineError extends Error {
  constructor() {
    super('page action deadline exceeded');
    this.name = 'PageActionDeadlineError';
  }
}

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalizeForHash(source[key])]),
    );
  }
  return value;
}

/**
 * Execution backends, injected by the host process. Implementations resolve
 * credentials lazily (inside the call) and must honor `signal`.
 */
export interface PageActionExecutors {
  /** Execute an api-kind invocation against an API source */
  executeApi?: (
    invocation: { sourceSlug: string; method: PageActionHttpMethod; path: string; params?: Record<string, unknown> },
    options: { signal: AbortSignal },
  ) => Promise<{ status: number; ok: boolean; body: unknown }>;
  /** Execute an mcp-kind invocation against an MCP source */
  executeMcp?: (
    invocation: { sourceSlug: string; toolName: string; args: Record<string, unknown> },
    options: { signal: AbortSignal },
  ) => Promise<unknown>;
  /**
   * Execute a script-kind invocation: run the grant's pinned script on the
   * host. Resolves with the process outcome even on a non-zero exit (the page
   * still wants stdout/stderr); throws only when the script could not run at
   * all (path escape, missing runtime, spawn failure).
   */
  executeScript?: (
    invocation: { pageSlug: string; script: string; runtime?: PageScriptRuntime; args?: string[] },
    options: { signal: AbortSignal },
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

export interface PageActionBrokerOptions {
  executors: PageActionExecutors;
  /**
   * Re-read a page's current config from disk. Injected because the broker does
   * no IO of its own, and required for correctness rather than convenience: an
   * action that waited for a mutating slot was admitted against a snapshot
   * taken before the wait, so a revocation or a content change during the wait
   * would be invisible to it. A host that cannot reload is treated as a host
   * whose state may have changed — the queued action is refused.
   */
  loadCurrentPage?: (pageSlug: string) => Promise<PageConfig | null>;
  /** Audit log path (default: {CONFIG_DIR}/logs/page-actions.jsonl) */
  auditLogPath?: string;
  /** Render-lease lifetime in ms */
  leaseTtlMs?: number;
  /** Per-action timeout in ms */
  actionTimeoutMs?: number;
  /** Activation-ticket lifetime; clamped to ADR-0033's 10-second ceiling */
  activationTicketTtlMs?: number;
  /** Workspace context for policy annotation in the audit trail */
  permissionsContext?: PermissionsContext;
  /** Test hook */
  now?: () => number;
}

export interface CreateLeaseInput {
  pageSlug: string;
  /** Digest of the content actually being rendered */
  contentDigest: string;
}

/**
 * Minting outcome. A failure is a code the host can act on rather than an
 * exception it has to pattern-match, because the two failures it genuinely
 * treats differently — "ask the user" and "refuse" — must not be told apart by
 * reading a message string.
 */
export type MintActivationOutcome =
  | { ok: true; ticketId: string; expiresAt: number }
  | { ok: false; code: PageActionValidationErrorCode; reason: string };

export interface MintActivationOptions {
  /**
   * Host-rendered first-use confirmation for script/session grants, invoked by
   * the broker only when this render has not yet confirmed this grant.
   *
   * Injected rather than called by the host beforehand so that ORDER is
   * authoritative here: validate, then ask, then re-validate, then mint. A host
   * that confirmed first and minted after would be asking about state that can
   * change while the dialog is open.
   */
  confirmFirstUse?: () => Promise<boolean>;
}

export class PageActionBroker {
  private readonly executors: PageActionExecutors;
  private readonly auditLogPath: string;
  private readonly leaseTtlMs: number;
  private readonly actionTimeoutMs: number;
  private readonly activationTicketTtlMs: number;
  private readonly permissionsContext?: PermissionsContext;
  private readonly loadCurrentPage?: (pageSlug: string) => Promise<PageConfig | null>;
  private readonly now: () => number;

  private readonly leases = new Map<string, PageRenderLease>();
  private readonly seenRequestIds = new Map<string, Set<string>>();
  /**
   * In-flight actions, keyed by LEASE AND request id.
   *
   * A bare requestId key made cancellation a cross-tenant capability: request
   * ids are minted by the caller, so any client that learned or guessed one
   * could abort another render's — or another page's — action. Scoping by lease
   * means a cancel must prove the lease it names, and `cancelAction` requires
   * the lease nonce for exactly that reason.
   *
   * Nested rather than a composite string key so `dropLease` can reach every
   * controller a lease owns without parsing keys back apart.
   */
  private readonly inFlight = new Map<string, Map<string, AbortController>>();
  /** leaseId → number of actions currently executing */
  private readonly inFlightByLease = new Map<string, number>();
  /** leaseId → number of MUTATING actions currently executing */
  private readonly mutatingInFlightByLease = new Map<string, number>();
  /** leaseId → waiters queued for a mutating slot, in arrival order */
  private readonly mutatingQueueByLease = new Map<string, Array<() => void>>();
  /** leaseId → start timestamps within the sliding rate window */
  private readonly startTimesByLease = new Map<string, number[]>();
  /** pageSlug → start timestamps; survives re-mounting, unlike the lease budget */
  private readonly startTimesByPage = new Map<string, number[]>();
  /** Workspace-wide start timestamps (this broker serves exactly one workspace) */
  private startTimesByWorkspace: number[] = [];
  /** ticketId → the single-use activation record the broker holds */
  private readonly tickets = new Map<string, PageActivationTicket>();
  /**
   * Grants whose host-rendered first-use confirmation this render has already
   * cleared, keyed by lease AND grant. Scoped to the lease because ADR-0033 §3
   * says per render: new content, or a re-mount, asks again.
   *
   * The parts are kept as values rather than parsed back out of the key. A
   * concatenated key has to be taken apart again by `startsWith`/`endsWith` to
   * answer "which of these belong to this lease", and that is only correct
   * while no id can contain the separator — a property nothing enforces and
   * the next reader cannot see.
   */
  private readonly firstUseConfirmed = new Map<string, { leaseId: string; grantId: string }>();

  constructor(options: PageActionBrokerOptions) {
    this.executors = options.executors;
    this.auditLogPath = options.auditLogPath ?? join(CONFIG_DIR, 'logs', 'page-actions.jsonl');
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_PAGE_LEASE_TTL_MS;
    this.actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_PAGE_ACTION_TIMEOUT_MS;
    // Clamp, never trust: the ceiling is an ADR constant and a caller passing a
    // generous number must not be able to raise it.
    this.activationTicketTtlMs = Math.min(
      Math.max(1, options.activationTicketTtlMs ?? DEFAULT_PAGE_ACTIVATION_TICKET_TTL_MS),
      PAGE_ACTIVATION_TICKET_TTL_CEILING_MS,
    );
    this.permissionsContext = options.permissionsContext;
    this.loadCurrentPage = options.loadCurrentPage;
    this.now = options.now ?? Date.now;
  }

  // ==========================================================
  // Leases
  // ==========================================================

  /**
   * Issue a render lease for one mount of a page. The returned nonce travels
   * into the iframe and must be echoed on every action request.
   */
  createLease(input: CreateLeaseInput): PageRenderLease {
    this.pruneExpiredLeases();

    if (this.leases.size >= MAX_LIVE_LEASES) {
      let oldest: PageRenderLease | undefined;
      for (const lease of this.leases.values()) {
        if (!oldest || lease.issuedAt < oldest.issuedAt) oldest = lease;
      }
      if (oldest) {
        this.dropLease(oldest.leaseId);
        void this.appendAudit({
          event: 'page_lease_evicted',
          pageSlug: oldest.pageSlug,
          leaseId: oldest.leaseId,
          reason: 'lease-store-full',
        });
      }
    }

    const now = this.now();
    const lease: PageRenderLease = {
      leaseId: randomUUID(),
      nonce: randomBytes(16).toString('hex'),
      pageSlug: input.pageSlug,
      contentDigest: input.contentDigest,
      issuedAt: now,
      expiresAt: now + this.leaseTtlMs,
    };

    this.leases.set(lease.leaseId, lease);
    this.seenRequestIds.set(lease.leaseId, new Set());
    void this.appendAudit({
      event: 'page_lease_created',
      pageSlug: lease.pageSlug,
      leaseId: lease.leaseId,
      contentDigest: lease.contentDigest,
      expiresAt: lease.expiresAt,
    });
    return lease;
  }

  /** Whether a render lease still represents this page and exact content. */
  hasActiveLease(leaseId: string, pageSlug: string, contentDigest: string): boolean {
    this.pruneExpiredLeases();
    const lease = this.leases.get(leaseId);
    return lease?.pageSlug === pageSlug && lease.contentDigest === contentDigest;
  }

  /** Drop a lease (page unmounted). Idempotent. */
  releaseLease(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    this.dropLease(leaseId);
    void this.appendAudit({ event: 'page_lease_released', pageSlug: lease.pageSlug, leaseId });
  }

  /**
   * Forget everything a lease authorized.
   *
   * Dropping the lease alone is not enough and the gap is exploitable: an
   * outstanding ticket is a standalone capability keyed by its own id, so a
   * ticket that outlived its lease would still name a valid request, and the
   * digest/lease re-check at redemption is the only thing that would have
   * caught it. Tickets, first-use consent, and queued waiters are all
   * lease-scoped authority and all end here — including on the expiry and
   * eviction paths, which call this rather than deleting the lease themselves.
   */
  private dropLease(leaseId: string): void {
    // Abort FIRST, while the lease still exists.
    //
    // Releasing a lease withdraws the authority its in-flight actions are
    // running under, so leaving them running is the same bug as never having
    // cancelled them: an unmounted Page's write completes against a source
    // minutes after the render it belonged to is gone. Deleting the lease first
    // would also make `cancelAction` unable to find them, because ownership is
    // proven against the lease being deleted.
    for (const controller of this.inFlight.get(leaseId)?.values() ?? []) {
      controller.abort();
    }
    this.inFlight.delete(leaseId);

    this.leases.delete(leaseId);
    this.seenRequestIds.delete(leaseId);
    this.inFlightByLease.delete(leaseId);
    this.mutatingInFlightByLease.delete(leaseId);
    this.startTimesByLease.delete(leaseId);
    this.dropTicketsWhere((ticket) => ticket.leaseId === leaseId);
    for (const [key, confirmed] of this.firstUseConfirmed) {
      if (confirmed.leaseId === leaseId) this.firstUseConfirmed.delete(key);
    }
    // Release queued waiters instead of stranding them: each re-checks its own
    // authority when it wakes and will now find the lease gone.
    const queued = this.mutatingQueueByLease.get(leaseId);
    this.mutatingQueueByLease.delete(leaseId);
    for (const wake of queued ?? []) wake();
  }

  private dropTicketsWhere(predicate: (ticket: PageActivationTicket) => boolean): void {
    for (const [ticketId, ticket] of this.tickets) {
      if (predicate(ticket)) this.tickets.delete(ticketId);
    }
  }

  private pruneExpiredTickets(): void {
    const now = this.now();
    this.dropTicketsWhere((ticket) => now > ticket.expiresAt);
  }

  private trackInFlight(leaseId: string, requestId: string, controller: AbortController): void {
    const forLease = this.inFlight.get(leaseId) ?? new Map<string, AbortController>();
    forLease.set(requestId, controller);
    this.inFlight.set(leaseId, forLease);
  }

  private untrackInFlight(leaseId: string, requestId: string): void {
    const forLease = this.inFlight.get(leaseId);
    if (!forLease) return;
    forLease.delete(requestId);
    if (forLease.size === 0) this.inFlight.delete(leaseId);
  }

  // ==========================================================
  // Per-lease rate limiting (host-side; the renderer limiter is advisory)
  // ==========================================================

  /** Trim a sliding window in place and report what is still inside it. */
  private withinWindow(timestamps: number[]): number[] {
    const now = this.now();
    return timestamps.filter((t) => now - t < PAGE_ACTION_RATE_WINDOW_MS);
  }

  private rateLimitRejection(
    leaseId: string,
    pageSlug: string,
    mutating: boolean,
  ): { code: 'rate-limited' | 'queue-overflow'; reason: string } | null {
    if ((this.inFlightByLease.get(leaseId) ?? 0) >= PAGE_ACTION_MAX_IN_FLIGHT_PER_LEASE) {
      return {
        code: 'rate-limited',
        reason: `Too many actions in flight for this render (max ${PAGE_ACTION_MAX_IN_FLIGHT_PER_LEASE})`,
      };
    }

    // Mutating actions queue rather than fail when the two slots are busy, but
    // the queue is a bounded waiting room: past its depth the answer is a
    // refusal now, not a longer wait. Checked BEFORE the ticket is consumed so
    // an overflow refusal does not burn the user's proof of interaction.
    if (mutating) {
      const queued = this.mutatingQueueByLease.get(leaseId)?.length ?? 0;
      if (queued >= PAGE_ACTION_MAX_QUEUED_MUTATING_PER_LEASE) {
        return {
          code: 'queue-overflow',
          reason: `Too many privileged actions waiting for this render (max ${PAGE_ACTION_MAX_QUEUED_MUTATING_PER_LEASE} queued)`,
        };
      }
    }

    const leaseStarts = this.withinWindow(this.startTimesByLease.get(leaseId) ?? []);
    this.startTimesByLease.set(leaseId, leaseStarts);
    if (leaseStarts.length >= PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE) {
      return {
        code: 'rate-limited',
        reason: `Too many actions this minute for this render (max ${PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE}/minute)`,
      };
    }

    const pageStarts = this.withinWindow(this.startTimesByPage.get(pageSlug) ?? []);
    this.startTimesByPage.set(pageSlug, pageStarts);
    if (pageStarts.length >= PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_PAGE) {
      return {
        code: 'rate-limited',
        reason: `Too many actions this minute for this page (max ${PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_PAGE}/minute)`,
      };
    }

    this.startTimesByWorkspace = this.withinWindow(this.startTimesByWorkspace);
    if (this.startTimesByWorkspace.length >= PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_WORKSPACE) {
      return {
        code: 'rate-limited',
        reason: `Too many page actions this minute for this workspace (max ${PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_WORKSPACE}/minute)`,
      };
    }

    return null;
  }

  private noteActionStart(leaseId: string, pageSlug: string): void {
    // The mutating slot is NOT counted here — `acquireMutatingSlot` already
    // reserved it, before this request was allowed to proceed.
    this.inFlightByLease.set(leaseId, (this.inFlightByLease.get(leaseId) ?? 0) + 1);
    const now = this.now();
    this.startTimesByLease.set(leaseId, [...(this.startTimesByLease.get(leaseId) ?? []), now]);
    this.startTimesByPage.set(pageSlug, [...(this.startTimesByPage.get(pageSlug) ?? []), now]);
    this.startTimesByWorkspace = [...this.startTimesByWorkspace, now];
  }

  private noteActionEnd(leaseId: string): void {
    const current = this.inFlightByLease.get(leaseId) ?? 0;
    if (current <= 1) this.inFlightByLease.delete(leaseId);
    else this.inFlightByLease.set(leaseId, current - 1);
  }

  /**
   * Acquire one of the render's mutating slots, waiting in the bounded queue if
   * both are busy.
   *
   * The reservation is made HERE, synchronously, rather than by the caller
   * after it resumes. Checking the count and incrementing it in two steps
   * separated by an `await` is a check-then-act race: three requests started in
   * the same turn all run the check before any of them resumes to increment, so
   * all three see a free slot and all three execute. Every caller of this
   * method owns a slot the moment it returns, and must release it.
   *
   * A slot is handed directly from a finishing action to the next waiter rather
   * than decremented and re-acquired, so the count never dips and a third
   * request cannot slip into the gap.
   */
  private async acquireMutatingSlot(leaseId: string): Promise<void> {
    const active = this.mutatingInFlightByLease.get(leaseId) ?? 0;
    if (active < PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE) {
      this.mutatingInFlightByLease.set(leaseId, active + 1);
      return;
    }
    await new Promise<void>((resolve) => {
      const queue = this.mutatingQueueByLease.get(leaseId) ?? [];
      queue.push(resolve);
      this.mutatingQueueByLease.set(leaseId, queue);
    });
  }

  /**
   * Release a mutating slot, handing it to the longest waiter if there is one.
   * Called from the execution path's `finally`, so it also runs on timeout and
   * cancellation — a stuck action must not strand what is queued behind it.
   */
  private releaseMutatingSlot(leaseId: string): void {
    const queue = this.mutatingQueueByLease.get(leaseId);
    const next = queue?.shift();
    if (queue && queue.length === 0) this.mutatingQueueByLease.delete(leaseId);
    // Hand the slot over without decrementing: the waiter is resuming into the
    // slot this action is vacating, so the occupancy count is unchanged.
    if (next) { next(); return; }
    const active = this.mutatingInFlightByLease.get(leaseId) ?? 0;
    if (active <= 1) this.mutatingInFlightByLease.delete(leaseId);
    else this.mutatingInFlightByLease.set(leaseId, active - 1);
  }

  private pruneExpiredLeases(): void {
    const now = this.now();
    for (const [leaseId, lease] of this.leases) {
      if (now > lease.expiresAt) this.dropLease(leaseId);
    }
  }

  // ==========================================================
  // Validation
  // ==========================================================

  /**
   * Every per-invocation check except activation, replay, and rate.
   *
   * Shared by minting and execution on purpose: a ticket must not be mintable
   * for a call that execution would refuse, or the host ends up showing a user
   * a confirmation for something that cannot run. The three exclusions are the
   * ones that differ between the two — a mint neither burns a request id nor
   * consumes the ticket it is about to create.
   */
  private validate(
    page: PageConfig,
    request: PageActionRequest,
    authority: PageActionAuthority,
    // Off for the one caller that re-validates AFTER claiming the request id:
    // a request waiting for a mutating slot has already burned its id, so
    // re-checking replay there would reject every queued action as a replay of
    // itself. Every other check still runs, which is the point of re-validating.
    options: { checkReplay?: boolean } = {},
  ): ValidationOutcome {
    const now = this.now();

    // Origin first: an unattributed caller must not learn whether its lease,
    // grant, or page even exist. ADR-0033's "unattributed default that cannot
    // mutate" is this branch — there is no default origin to fall back to.
    const originPolicy = pageActionOriginPolicy(authority?.origin);
    if (!originPolicy) {
      return {
        ok: false,
        code: 'origin-unattributed',
        reason: 'Page actions require a host-declared origin',
      };
    }
    if (!authority.workspaceId) {
      return { ok: false, code: 'workspace-mismatch', reason: 'Page actions require a resolved workspace' };
    }

    if (!originPolicy.requiresRenderLease) {
      // A cron run has no render, so there is no lease, nonce, or request-id
      // stream to check. Everything below that is NOT about the render still
      // applies, and is reached by falling through to the page/grant checks.
      return this.validatePageAndGrant(page, request, authority, originPolicy);
    }

    const lease = this.leases.get(request.leaseId);
    if (!lease) {
      return { ok: false, code: 'lease-not-found', reason: 'No render lease for this request — re-mount the page' };
    }
    if (lease.pageSlug !== request.pageSlug || page.slug !== request.pageSlug) {
      return { ok: false, code: 'lease-page-mismatch', reason: 'Lease belongs to a different page' };
    }
    if (now > lease.expiresAt) {
      this.dropLease(request.leaseId);
      return { ok: false, code: 'lease-expired', reason: 'Render lease expired — re-mount the page' };
    }
    if (lease.nonce !== request.nonce) {
      return { ok: false, code: 'nonce-mismatch', reason: 'Request nonce does not match the render lease' };
    }

    if (!page.contentDigest) {
      return { ok: false, code: 'content-missing', reason: 'Page has no content digest' };
    }
    if (lease.contentDigest !== page.contentDigest) {
      return { ok: false, code: 'content-changed', reason: 'Page content changed since this render — re-mount the page' };
    }

    const seen = this.seenRequestIds.get(request.leaseId);
    if (options.checkReplay !== false && seen?.has(request.requestId)) {
      return { ok: false, code: 'replay', reason: 'Request id was already used on this lease' };
    }
    if (seen && seen.size >= MAX_SEEN_REQUEST_IDS_PER_LEASE) {
      return { ok: false, code: 'replay-cache-full', reason: 'Lease exhausted its request budget — re-mount the page' };
    }

    return this.validatePageAndGrant(page, request, authority, originPolicy);
  }

  /**
   * Everything that is true of an invocation regardless of whether a render
   * made it: the page has content, the grant exists, is bound to that content,
   * has not expired, matches the invocation, and is a kind this origin may run.
   *
   * Split out so the render path and the no-render scheduled path share ONE
   * definition of "this grant authorizes this call". Two copies would be two
   * answers, and the cron path is exactly where a second, laxer answer would go
   * unnoticed.
   */
  private validatePageAndGrant(
    page: PageConfig,
    request: PageActionRequest,
    authority: PageActionAuthority,
    originPolicy: { requiresActivationTicket: boolean },
  ): ValidationOutcome {
    const now = this.now();

    if (!page.contentDigest) {
      return { ok: false, code: 'content-missing', reason: 'Page has no content digest' };
    }

    const grant = page.grants?.find((g) => g.id === request.grantId);
    if (!grant) {
      return { ok: false, code: 'grant-not-found', reason: `No grant ${request.grantId} on this page` };
    }
    if (grant.contentDigest !== page.contentDigest) {
      return { ok: false, code: 'grant-stale', reason: 'Grant was approved for older page content — re-approval required' };
    }
    if (now > grant.expiresAt) {
      return { ok: false, code: 'grant-expired', reason: 'Grant expired — re-approval required' };
    }

    const mismatch = this.invocationMismatch(grant, request.invocation);
    if (mismatch) return mismatch;

    if (!pageActionOriginAllowsKind(authority.origin, grant.action.kind)) {
      return {
        ok: false,
        code: 'origin-forbidden',
        reason: `A ${authority.origin} action may not run a ${grant.action.kind} grant`,
      };
    }

    // Classify from the GRANT, not the invocation. They agree here (the
    // mismatch check above proved the kinds match, and api method equality with
    // it), and reading the approved descriptor means the privileged/unprivileged
    // decision is made against what the user consented to rather than against
    // what the caller sent.
    const mutating = isMutatingPageAction(grant.action);
    // Explore is read-only across the product, and a Page is not an exception:
    // a grant approved in a permissive mode must not keep executing writes
    // after the workspace is switched to safe. Re-read per invocation, so the
    // switch takes effect on the very next action rather than the next mount.
    if (mutating && authority.permissionMode === 'safe') {
      return {
        ok: false,
        code: 'permission-mode-forbidden',
        reason: 'Explore mode does not run mutating page actions',
      };
    }

    return { ok: true, grant, mutating };
  }

  // ==========================================================
  // Activation tickets (ADR-0033 §3)
  // ==========================================================

  /**
   * Mint the single-use proof of trusted interaction for one exact request.
   *
   * The caller is the host path that OBSERVED the interaction — in the desktop
   * app, Electron main, which sees gestures through `input-event` and renders
   * its own confirmation chrome. Nothing about this is reachable from a
   * renderer or a transport client, which is the whole point: the ticket is the
   * one credential a page cannot manufacture, so it is minted where a page
   * cannot reach.
   *
   * The `roadmap/evidence/SUV-0065` experiment is why the signal is main-observed
   * rather than `navigator.userActivation`: parent activation reads `true`
   * whether the click landed in the Page or on unrelated app chrome, so it is
   * freshness and never frame proof.
   */
  async mintActivationTicket(
    page: PageConfig,
    request: PageActionRequest,
    authority: PageActionAuthority,
    options: MintActivationOptions = {},
  ): Promise<MintActivationOutcome> {
    this.pruneExpiredTickets();

    const reject = (code: PageActionValidationErrorCode, reason: string): MintActivationOutcome => {
      void this.appendAudit({
        event: 'page_activation_rejected',
        workspaceId: authority?.workspaceId,
        origin: authority?.origin,
        pageSlug: request.pageSlug,
        requestId: request.requestId,
        leaseId: request.leaseId,
        grantId: request.grantId,
        code,
        reason,
      });
      return { ok: false, code, reason };
    };

    const validation = this.validate(page, request, authority);
    if (!validation.ok) return reject(validation.code, validation.reason);
    if (!validation.mutating) {
      // Not an error the user should see as a failure, but minting one anyway
      // would put a spendable capability in circulation for a call that needs
      // none — and every unnecessary ticket is one more thing to leak.
      return reject('activation-invalid', 'Non-mutating actions do not take an activation ticket');
    }

    const outstanding = [...this.tickets.values()].filter((t) => t.leaseId === request.leaseId).length;
    if (outstanding >= MAX_OUTSTANDING_TICKETS_PER_LEASE) {
      return reject(
        'rate-limited',
        `Too many unspent activations for this render (max ${MAX_OUTSTANDING_TICKETS_PER_LEASE})`,
      );
    }

    const policy = pageActionOriginPolicy(authority.origin)!;
    // The confirmation identity is the lease, the grant, AND the exact command.
    //
    // Keying on the grant id alone made consent survive a change to the thing
    // consented to: `page.json` can be rewritten in place under a stable id and
    // a stable content digest (the digest covers index.html, not the grant
    // list), so the next mint would find a cached "already confirmed", skip the
    // dialog, and issue a perfectly valid ticket for a command the user had
    // never seen. Binding the descriptor into the ticket does not help there,
    // because that ticket is minted against the NEW descriptor consistently —
    // the dialog is what has to be re-shown.
    const firstUseKey = JSON.stringify([
      request.leaseId,
      request.grantId,
      pageActionDescriptorSignature(validation.grant.action),
    ]);
    // Every mutating kind, not just script. A window gesture cannot tell a
    // click on this Page's button from a click on unrelated app chrome (see the
    // policy field's note and the SUV-0065 evidence), so without this a page
    // could fire an approved POST or MCP write from a timer on the back of any
    // stray click. The host-rendered dialog is the one click that is
    // unambiguously about THIS action.
    if (policy.requiresFirstUseConfirmation && !this.firstUseConfirmed.has(firstUseKey)) {
      if (!options.confirmFirstUse) {
        return reject(
          'first-use-confirmation-required',
          'This host cannot render the required first-use confirmation',
        );
      }
      const confirmed = await options.confirmFirstUse();
      if (!confirmed) {
        return reject('first-use-confirmation-declined', 'First use of this grant was not confirmed');
      }
      // Re-validate AFTER the dialog. A confirmation is a human-scale pause —
      // the grant can expire, the content can change, the lease can be released,
      // and the workspace can switch to Explore while it is open. Approving a
      // question is not the same as approving the state that follows it.
      const revalidation = this.validate(page, request, authority);
      if (!revalidation.ok) return reject(revalidation.code, revalidation.reason);
      this.firstUseConfirmed.set(firstUseKey, { leaseId: request.leaseId, grantId: request.grantId });
    }

    const now = this.now();
    const ticket: PageActivationTicket = {
      ticketId: randomBytes(24).toString('hex'),
      requestHash: canonicalPageActionHash(authority.workspaceId, page.contentDigest!, request),
      workspaceId: authority.workspaceId,
      pageSlug: request.pageSlug,
      leaseId: request.leaseId,
      contentDigest: page.contentDigest!,
      grantId: request.grantId,
      requestId: request.requestId,
      descriptorSignature: pageActionDescriptorSignature(validation.grant.action),
      origin: authority.origin,
      issuedAt: now,
      expiresAt: now + this.activationTicketTtlMs,
    };
    this.tickets.set(ticket.ticketId, ticket);
    void this.appendAudit({
      event: 'page_activation_issued',
      workspaceId: authority.workspaceId,
      origin: authority.origin,
      pageSlug: request.pageSlug,
      requestId: request.requestId,
      leaseId: request.leaseId,
      grantId: request.grantId,
      actionKind: validation.grant.action.kind,
      expiresAt: ticket.expiresAt,
    });
    return { ok: true, ticketId: ticket.ticketId, expiresAt: ticket.expiresAt };
  }

  /**
   * Spend a ticket on the request it was minted for.
   *
   * Consumption is unconditional and happens FIRST: the ticket leaves the map
   * before a single field is compared, so two concurrent redemptions of one id
   * cannot both find it present, and a redemption that fails its checks has
   * still burned it. Validating first and deleting after would be a textbook
   * check-then-act race in the one place a race buys a second privileged run.
   */
  private consumeActivationTicket(
    request: PageActionRequest,
    authority: PageActionAuthority,
    contentDigest: string,
    grant: PageActionGrant,
  ): { ok: true; descriptorSignature: string } | { ok: false; code: PageActionValidationErrorCode; reason: string } {
    const ticketId = request.activationTicket;
    if (typeof ticketId !== 'string' || ticketId.length === 0) {
      return {
        ok: false,
        code: 'activation-required',
        reason: 'This action needs a fresh trusted interaction',
      };
    }
    const ticket = this.tickets.get(ticketId);
    this.tickets.delete(ticketId);
    if (!ticket) {
      return { ok: false, code: 'activation-invalid', reason: 'Activation is unknown or already used' };
    }
    if (this.now() > ticket.expiresAt) {
      return { ok: false, code: 'activation-invalid', reason: 'Activation expired' };
    }
    // Cross-page and cross-workspace refusal is stated explicitly rather than
    // left to the hash. The hash covers both, but these are the two boundaries
    // whose breach is a privilege escalation rather than a mismatch, and a
    // reader looking for "can a ticket move between pages" should find the
    // answer as code, not as a property of a digest.
    if (ticket.workspaceId !== authority.workspaceId) {
      return { ok: false, code: 'workspace-mismatch', reason: 'Activation belongs to a different workspace' };
    }
    if (ticket.pageSlug !== request.pageSlug || ticket.leaseId !== request.leaseId) {
      return { ok: false, code: 'activation-invalid', reason: 'Activation belongs to a different render' };
    }
    if (ticket.contentDigest !== contentDigest) {
      return { ok: false, code: 'activation-invalid', reason: 'Page content changed since this activation' };
    }
    if (ticket.origin !== authority.origin) {
      return { ok: false, code: 'activation-invalid', reason: 'Activation belongs to a different origin' };
    }
    // The grant here was re-read from disk for THIS invocation. If its
    // descriptor no longer matches the one the ticket was minted against, the
    // command changed after the user agreed to it, and the ticket authorizes
    // the command they saw — not the id it was filed under.
    if (ticket.descriptorSignature !== pageActionDescriptorSignature(grant.action)) {
      return {
        ok: false,
        code: 'activation-invalid',
        reason: 'The approved action changed since this activation was issued',
      };
    }
    if (ticket.requestHash !== canonicalPageActionHash(authority.workspaceId, contentDigest, request)) {
      return { ok: false, code: 'activation-invalid', reason: 'Activation does not match this request' };
    }
    // Returned, not just checked. The caller re-reads the grant from disk after
    // the queue, and has to be able to prove the reloaded descriptor is still
    // the one this ticket authorized.
    return { ok: true, descriptorSignature: ticket.descriptorSignature };
  }

  /**
   * Invalidate every outstanding ticket for a page — the hook a content change
   * or a grant revocation calls. ADR-0033 §5 requires content changes to
   * invalidate outstanding tickets, and a ticket is the one piece of authority
   * that does not re-read page.json on its own.
   */
  invalidateActivationsForPage(pageSlug: string, grantId?: string): void {
    this.dropTicketsWhere(
      (ticket) => ticket.pageSlug === pageSlug && (grantId === undefined || ticket.grantId === grantId),
    );
    if (grantId !== undefined) {
      for (const [key, confirmed] of this.firstUseConfirmed) {
        if (confirmed.grantId === grantId) this.firstUseConfirmed.delete(key);
      }
    }
  }

  /** Outstanding unspent tickets (diagnostics/tests). */
  get activationTicketCount(): number {
    this.pruneExpiredTickets();
    return this.tickets.size;
  }

  /** Check the concrete invocation against the grant's descriptor. */
  private invocationMismatch(grant: PageActionGrant, invocation: PageActionInvocation): ValidationOutcome | null {
    if (grant.action.kind !== invocation.kind) {
      return { ok: false, code: 'grant-mismatch', reason: `Grant allows ${grant.action.kind} actions, request is ${invocation.kind}` };
    }

    if (grant.action.kind === 'api' && invocation.kind === 'api') {
      if (grant.action.method !== invocation.method) {
        return { ok: false, code: 'grant-mismatch', reason: `Grant allows ${grant.action.method}, request is ${invocation.method}` };
      }
      // Reject traversal BEFORE the pattern match. fetch normalizes `..`, so a
      // raw path that matches the anchored pattern could still resolve to a
      // different endpoint with the real credential. Rejecting here guarantees
      // the (raw) path later forwarded to executeApi is traversal-free — match
      // and execution agree without transforming the forwarded path.
      if (hasPathTraversal(invocation.path)) {
        return { ok: false, code: 'invocation-path-unsafe', reason: 'Request path contains a directory-traversal segment' };
      }
      let pattern: RegExp;
      try {
        // Anchored: the grant's pattern must match the WHOLE path.
        pattern = new RegExp(`^(?:${grant.action.pathPattern})$`);
      } catch {
        return { ok: false, code: 'grant-pattern-invalid', reason: 'Grant path pattern is not a valid regex' };
      }
      const path = invocation.path.startsWith('/') ? invocation.path : `/${invocation.path}`;
      if (!pattern.test(path)) {
        return { ok: false, code: 'grant-mismatch', reason: `Path ${path} does not match the granted pattern` };
      }
      return null;
    }

    if (grant.action.kind === 'mcp' && invocation.kind === 'mcp') {
      if (grant.action.toolName !== invocation.toolName) {
        return { ok: false, code: 'grant-mismatch', reason: `Grant allows tool ${grant.action.toolName}, request is ${invocation.toolName}` };
      }
      return null;
    }

    if (grant.action.kind === 'script' && invocation.kind === 'script') {
      // Nothing to compare: the trigger carries no script/args, so the grant's
      // descriptor is authoritative and any script-for-script pair matches.
      return null;
    }

    return { ok: false, code: 'grant-mismatch', reason: 'Unsupported action kind' };
  }

  // ==========================================================
  // Execution
  // ==========================================================

  /**
   * Validate and execute one page action request against the current
   * page.json state. Never throws — failures come back as { ok: false }.
   */
  async executeAction(
    // Reassigned after a queue wait, when the page is re-read from disk.
    page: PageConfig,
    request: PageActionRequest,
    authority: PageActionAuthority,
  ): Promise<PageActionResult> {


    const startTime = this.now();
    const invocationSummary = this.summarizeInvocation(request.invocation);

    const rejected = (code: PageActionValidationErrorCode, reason: string): PageActionResult => {
      void this.appendAudit({
        event: 'page_action_rejected',
        workspaceId: authority?.workspaceId,
        origin: authority?.origin,
        permissionMode: authority?.permissionMode,
        pageSlug: request.pageSlug,
        requestId: request.requestId,
        leaseId: request.leaseId,
        grantId: request.grantId,
        invocation: invocationSummary,
        code,
        reason,
      });
      return {
        requestId: request.requestId,
        ok: false,
        error: `${code}: ${reason}`,
        durationMs: this.now() - startTime,
      };
    };

    const validation = this.validate(page, request, authority);
    if (!validation.ok) return rejected(validation.code, validation.reason);

    let { grant } = validation;
    const { mutating } = validation;

    // Rate check AFTER validation (a throttled caller learns nothing about
    // lease/grant validity it didn't already prove) and BEFORE burning the
    // requestId or the activation ticket — a throttled request never executed,
    // so neither its id nor the user's proof of interaction is spent.
    const limited = this.rateLimitRejection(request.leaseId, request.pageSlug, mutating);
    if (limited) return rejected(limited.code, limited.reason);

    // Activation last among the gates, and only for mutating actions. It is the
    // single-use one: everything that can refuse this request for a reason that
    // would recur has already run, so a burned ticket means the call really was
    // going to execute.
    let confirmedDescriptor: string | undefined;
    if (mutating && pageActionOriginPolicy(authority.origin)!.requiresActivationTicket) {
      const activation = this.consumeActivationTicket(request, authority, page.contentDigest!, grant);
      if (!activation.ok) return rejected(activation.code, activation.reason);
      confirmedDescriptor = activation.descriptorSignature;
    }

    this.seenRequestIds.get(request.leaseId)?.add(request.requestId);

    // Policy annotation: grants ARE the user approval, so a requires-approval
    // verdict does not block a granted call — but the audit trail records how
    // the same call would classify for an agent.
    //
    // Computed before anything is reserved, because it is the last thing on
    // this path that can throw outside a cleanup handler. Reserving first would
    // leak an in-flight slot and a mutating slot on that throw, and with only
    // two mutating slots per render, two such throws wedge the render.
    const policy: SourceActionPolicyDecision =
      grant.action.kind === 'api'
        ? evaluateApiEndpointPolicy(
            grant.action.method,
            request.invocation.kind === 'api' ? request.invocation.path : undefined,
            this.permissionsContext,
          )
        : grant.action.kind === 'mcp'
          ? evaluateMcpToolPolicy(
              proxyToolName(grant.action.sourceSlug, grant.action.toolName),
              (request.invocation.kind === 'mcp' ? request.invocation.args : undefined) ?? {},
            )
          : // script: host command execution — always approval-worthy for an agent,
            // annotated here purely for the audit trail (the grant is the approval).
            { decision: 'requires-approval', description: `script: ${grant.action.script}` };

    // Registered BEFORE any waiting, not after. A queued request has already
    // spent its activation ticket, so if its controller only appeared once it
    // reached the front of the queue, `cancelAction` would find neither ticket
    // nor controller, report that there was nothing to cancel, and let the
    // withdrawn write run anyway when a slot freed.
    const controller = new AbortController();
    this.trackInFlight(request.leaseId, request.requestId, controller);

    /** Give back everything admission reserved. Safe to call exactly once. */
    const releaseAdmission = () => {
      this.untrackInFlight(request.leaseId, request.requestId);
      if (mutating) this.releaseMutatingSlot(request.leaseId);
    };

    if (mutating) {
      // Reserved inside `acquireMutatingSlot`, synchronously, so two requests
      // cannot both observe the same free slot and both proceed.
      await this.acquireMutatingSlot(request.leaseId);
      // A cancel that arrived while this sat in the queue has to be honoured
      // here: the abort has nothing to interrupt yet, so before the work starts
      // is the only place it can take effect.
      if (controller.signal.aborted) {
        releaseAdmission();
        return rejected('cancelled', 'Action was cancelled before it started');
      }
      // The world moves while a request waits, and it moves ON DISK. The `page`
      // this call was admitted against is a snapshot the host read before the
      // wait, so re-validating it would re-confirm the past: a grant revoked or
      // content changed while this sat in the queue would not appear in it.
      // Reload, then re-check digest, grant, descriptor, and expiry against
      // what is true now — immediately before the executor runs.
      if (!this.loadCurrentPage) {
        releaseAdmission();
        return rejected('content-changed', 'Queued actions require a host that can re-read page state');
      }
      let current: PageConfig | null;
      try {
        current = await this.loadCurrentPage(request.pageSlug);
      } catch {
        current = null;
      }
      if (!current) {
        releaseAdmission();
        return rejected('grant-not-found', 'Page no longer exists');
      }
      const afterQueue = this.validate(current, request, authority, { checkReplay: false });
      if (!afterQueue.ok) {
        releaseAdmission();
        return rejected(afterQueue.code, afterQueue.reason);
      }
      // Adopting the reloaded grant re-opens the swap the ticket exists to
      // prevent unless the binding is re-checked HERE. The ticket was validated
      // against the admission-time descriptor; execution is about to use the
      // reloaded one, and `page.json` can be rewritten under a stable grant id
      // and a stable content digest while this request sits in the queue.
      if (
        confirmedDescriptor !== undefined &&
        confirmedDescriptor !== pageActionDescriptorSignature(afterQueue.grant.action)
      ) {
        releaseAdmission();
        return rejected('activation-invalid', 'The approved action changed while this request was queued');
      }
      // Execute against the reloaded config, not the admission snapshot, so the
      // descriptor that runs is the one just re-validated.
      page = current;
      grant = afterQueue.grant;
      if (controller.signal.aborted) {
        releaseAdmission();
        return rejected('cancelled', 'Action was cancelled before it started');
      }
    }

    this.noteActionStart(request.leaseId, request.pageSlug);

    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.actionTimeoutMs)]);

    /**
     * The broker's own deadline, raced against the executor.
     *
     * `signal` asks an executor to stop; this makes it irrelevant whether it
     * listens. An executor that ignores its AbortSignal and never settles would
     * otherwise hold an in-flight slot, a mutating slot, and everything queued
     * behind it forever — a page could hang its own render permanently by
     * granting a script that never exits. Racing means the slot is always
     * returned on schedule, whatever the executor does with the signal.
     */
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, rejectDeadline) => {
      deadlineTimer = setTimeout(() => {
        controller.abort();
        rejectDeadline(new PageActionDeadlineError());
      }, this.actionTimeoutMs);
    });
    const race = <T>(work: Promise<T>): Promise<T> => {
      // A losing executor may still reject later; without this its rejection is
      // unhandled and can take the process down under Node's default policy.
      work.catch(() => {});
      return Promise.race([work, deadline]);
    };

    let result: PageActionResult;
    try {
      if (grant.action.kind === 'api' && request.invocation.kind === 'api') {
        if (!this.executors.executeApi) {
          result = this.unavailableResult(request, startTime, 'API executor not wired in this host');
        } else {
          const outcome = await race(this.executors.executeApi(
            {
              sourceSlug: grant.action.sourceSlug,
              method: request.invocation.method,
              path: request.invocation.path,
              params: request.invocation.params,
            },
            { signal },
          ));
          result = {
            requestId: request.requestId,
            ok: outcome.ok,
            status: outcome.status,
            body: outcome.body,
            ...(outcome.ok ? {} : { error: `API responded with status ${outcome.status}` }),
            durationMs: this.now() - startTime,
          };
        }
      } else if (grant.action.kind === 'mcp' && request.invocation.kind === 'mcp') {
        if (!this.executors.executeMcp) {
          result = this.unavailableResult(request, startTime, 'MCP executor not wired in this host');
        } else {
          const body = await race(this.executors.executeMcp(
            {
              sourceSlug: grant.action.sourceSlug,
              toolName: request.invocation.toolName,
              args: request.invocation.args ?? {},
            },
            { signal },
          ));
          result = {
            requestId: request.requestId,
            ok: true,
            body,
            durationMs: this.now() - startTime,
          };
        }
      } else if (grant.action.kind === 'script' && request.invocation.kind === 'script') {
        if (!this.executors.executeScript) {
          result = this.unavailableResult(request, startTime, 'Script executor not wired in this host');
        } else {
          const outcome = await race(this.executors.executeScript(
            {
              pageSlug: page.slug,
              script: grant.action.script,
              runtime: grant.action.runtime,
              args: grant.action.args,
            },
            { signal },
          ));
          const ok = outcome.exitCode === 0;
          result = {
            requestId: request.requestId,
            ok,
            // The page sees stdout/stderr/exit even on failure — a script that
            // exits non-zero with a useful message should surface that message.
            body: { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr },
            ...(ok ? {} : { error: `Script exited with code ${outcome.exitCode ?? 'null'}` }),
            durationMs: this.now() - startTime,
          };
        }
      } else {
        // invocationMismatch() makes this unreachable; keep a safe fallback.
        result = this.unavailableResult(request, startTime, 'Invocation kind does not match grant');
      }
    } catch (error) {
      // Timeout and cancellation are different outcomes and the audit trail has
      // to tell them apart: one is the host giving up on a slow action, the
      // other is a user or an unmount withdrawing it.
      const timedOut = error instanceof PageActionDeadlineError;
      const message = timedOut
        ? `timeout: action exceeded ${this.actionTimeoutMs}ms`
        : controller.signal.aborted
          ? 'cancelled: action was cancelled'
          : error instanceof Error ? error.message : 'Unknown error';
      result = {
        requestId: request.requestId,
        ok: false,
        error: message,
        durationMs: this.now() - startTime,
      };
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.noteActionEnd(request.leaseId);
      releaseAdmission();
    }

    void this.appendAudit({
      event: 'page_action_executed',
      workspaceId: authority.workspaceId,
      origin: authority.origin,
      permissionMode: authority.permissionMode,
      mutating,
      pageSlug: request.pageSlug,
      requestId: request.requestId,
      leaseId: request.leaseId,
      grantId: grant.id,
      actionKind: grant.action.kind,
      // From the GRANT, which the host approved — not from the request.
      ...(grant.action.kind !== 'script' ? { sourceSlug: grant.action.sourceSlug } : {}),
      invocation: invocationSummary,
      policyDecision: policy.decision,
      ok: result.ok,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.error ? { error: result.error } : {}),
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Abort an in-flight action, and withdraw any unspent activation for it.
   * Returns false when the request is unknown, unowned, or already settled.
   *
   * Ownership is proven, not claimed. Request ids are minted by the caller, so
   * the previous `cancelAction(requestId)` shape let anything that reached the
   * RPC abort another render's — or another page's — work simply by naming its
   * id. Requiring the lease and its nonce means a canceller must already hold
   * the render's secret, which is the same bar acting on that render requires.
   *
   * Withdrawing tickets is part of cancelling, not cleanup: a request cancelled
   * between minting and executing would otherwise leave a live ticket that
   * still authorizes the call the user just took back.
   */
  cancelAction(leaseId: string, nonce: string, requestId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.nonce !== nonce) return false;

    this.dropTicketsWhere((ticket) => ticket.leaseId === leaseId && ticket.requestId === requestId);

    const controller = this.inFlight.get(leaseId)?.get(requestId);
    // A cancel that only withdrew a ticket is still a real cancellation — the
    // action it authorized can no longer run — so it is audited and reported as
    // one rather than reading as "nothing to cancel".
    if (!controller) {
      void this.appendAudit({
        event: 'page_action_cancelled',
        pageSlug: lease.pageSlug,
        leaseId,
        requestId,
        phase: 'pre-execution',
      });
      return false;
    }
    controller.abort();
    void this.appendAudit({
      event: 'page_action_cancelled',
      pageSlug: lease.pageSlug,
      leaseId,
      requestId,
      phase: 'in-flight',
    });
    return true;
  }

  /** Number of live leases (diagnostics/tests). */
  get leaseCount(): number {
    this.pruneExpiredLeases();
    return this.leases.size;
  }

  private unavailableResult(request: PageActionRequest, startTime: number, reason: string): PageActionResult {
    return {
      requestId: request.requestId,
      ok: false,
      error: `executor-unavailable: ${reason}`,
      durationMs: this.now() - startTime,
    };
  }

  /**
   * Audit-safe summary of an invocation: **metadata only, never payload.**
   *
   * The earlier version recorded the request path and redacted the params by
   * key name, which is the wrong guarantee in an audit log. Redaction can only
   * catch keys it recognizes, so a token in `?access_token=`, an id in a path
   * segment, a customer email in an MCP argument, or any field named something
   * the redactor has never heard of went to disk verbatim — in a file that
   * lives for the life of the install and is read by whoever debugs it.
   *
   * So nothing the caller supplied is recorded at all. What remains answers the
   * questions an audit log exists for — what kind of action, against which
   * source, which tool or method, and how it came out — and answers them from
   * values the host already knows, not from the request body.
   */
  private summarizeInvocation(invocation: PageActionInvocation): Record<string, unknown> {
    if (invocation.kind === 'api') {
      // The method is a closed set and the grant's path PATTERN is recorded
      // alongside this row via grantId, so the concrete path adds nothing an
      // investigator cannot recover — and everything an attacker could hide in.
      return { kind: 'api', method: invocation.method };
    }
    if (invocation.kind === 'mcp') {
      // Tool name only. Arguments are entirely caller-supplied and are exactly
      // where the sensitive values live.
      return { kind: 'mcp', toolName: invocation.toolName };
    }
    // script is a bare trigger — the resolved grantId in the same audit row
    // carries the script path/runtime/args, so there is nothing to summarize.
    return { kind: 'script' };
  }

  /**
   * Append an audit event (fire-and-forget, mirrors privileged-execution-broker:
   * audit failures are logged but never fail the action).
   */
  private async appendAudit(payload: Record<string, unknown>): Promise<void> {
    await appendPageActionAudit(payload, {
      auditLogPath: this.auditLogPath,
      onError: (error) => log.warn(`[PageActionBroker] Failed to write audit log: ${error}`),
    });
  }
}
