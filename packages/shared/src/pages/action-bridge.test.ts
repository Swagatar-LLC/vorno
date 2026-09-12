/**
 * Tests for the PageActionBroker — lease/nonce/replay checks, grant
 * validation (digest + expiry + descriptor matching), execution via
 * injected executors, cancellation, and the audit trail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  PageActionAuthority,
  PageActionGrant,
  PageActionRequest,
  PageActionResult,
  PageConfig,
  PageRenderLease,
} from '@craft-agent/core';
import {
  MAX_AUDITED_IDENTIFIER_CHARS,
  MAX_LIVE_LEASES,
  MAX_OUTSTANDING_TICKETS_PER_LEASE,
  PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE,
  PAGE_ACTION_MAX_IN_FLIGHT_PER_LEASE,
  PAGE_ACTION_MAX_QUEUED_MUTATING_PER_LEASE,
  PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE,
  PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_PAGE,
  PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_WORKSPACE,
  PAGE_ACTIVATION_TICKET_TTL_CEILING_MS,
  PageActionBroker,
  appendPageActionAudit,
  pageAuditIdHash,
  resetPageAuditThrottleForTests,
  canonicalPageActionHash,
  type PageActionExecutors,
} from './action-bridge.ts';
import { PAGE_ACTION_KINDS, PAGE_ACTION_ORIGINS, isMutatingPageAction, pageActionOriginPolicy } from './types.ts';

const DIGEST_V1 = 'a'.repeat(64);
const DIGEST_V2 = 'b'.repeat(64);

describe('pages/action-bridge', () => {
  let tempDir: string;
  let auditPath: string;
  let clock: { now: number };
  /**
   * What `page.json` says right now. The broker re-reads it before running a
   * request that waited for a slot, so a test can revoke a grant or change
   * content mid-queue simply by assigning here — which is the whole point of
   * the reload, and cannot be expressed by passing a snapshot in.
   */
  let disk: { page: PageConfig | null; permissionMode: 'safe' | 'ask' | 'allow-all' };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'page-action-bridge-test-'));
    auditPath = join(tempDir, 'page-actions.jsonl');
    clock = { now: 1_000_000 };
    disk = { page: null, permissionMode: 'ask' };
    // The audit throttle is process-scoped (one audit file per process), so a
    // suite that did not reset it would leak budget between tests.
    resetPageAuditThrottleForTests();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Explicit, because the option is required with no default — a shared
   * fallback bucket would let one workspace's churn suppress another's rows.
   */
  const TEST_AUDIT_SCOPE = 'ws_test0001';

  function makeBroker(executors: PageActionExecutors = {}) {
    return new PageActionBroker({
      executors,
      workspaceId: TEST_AUDIT_SCOPE,
      auditLogPath: auditPath,
      now: () => clock.now,
      // The host re-reads BOTH the page and the authority. Modelling only the
      // page would leave the Explore-during-queue transition untestable, which
      // is how it went unnoticed.
      loadCurrentAdmission: async () => disk.page
        ? { page: disk.page, authority: { ...AUTHORITY, permissionMode: disk.permissionMode } }
        : null,
    });
  }

  function makeGrant(overrides: Partial<PageActionGrant> = {}): PageActionGrant {
    return {
      id: 'grant_test0001',
      action: { kind: 'api', sourceSlug: 'github', method: 'GET', pathPattern: '/repos/.*' },
      contentDigest: DIGEST_V1,
      createdAt: clock.now,
      expiresAt: clock.now + 60_000,
      ...overrides,
    };
  }

  function makePage(overrides: Partial<PageConfig> = {}): PageConfig {
    return {
      schemaVersion: 1,
      id: 'page_test0001',
      slug: 'dash',
      name: 'Dash',
      kind: 'interactive',
      createdAt: 1,
      updatedAt: 1,
      contentDigest: DIGEST_V1,
      grants: [makeGrant()],
      ...overrides,
    };
  }

  /**
   * A host that can render first-use confirmation and whose user says yes.
   * Every mutating kind needs one now, so a mint without this models a host
   * with no confirmation surface — which is a distinct test, not the default.
   */
  const CONFIRMING = { confirmFirstUse: async () => true };

  /** What the host asserts. Never wire data — see PageActionAuthority. */
  const AUTHORITY: PageActionAuthority = {
    workspaceId: 'ws_test0001',
    origin: 'sandboxed-page',
    permissionMode: 'ask',
  };

  /**
   * Execute the way the real host does: classify, mint only if the action
   * mutates, then spend.
   *
   * Tests go through this rather than calling executeAction directly so every
   * existing assertion also exercises the activation path. The mutation check
   * is the same shared classifier PageFrame uses, because a helper that minted
   * unconditionally would be testing a host that does not exist — and would
   * mask which of the two calls a rejection actually came from.
   */
  async function run(
    broker: PageActionBroker,
    page: PageConfig,
    request: PageActionRequest,
    authority: PageActionAuthority = AUTHORITY,
  ) {
    if (!isMutatingPageAction(request.invocation)) {
      return broker.executeAction(page, request, authority);
    }
    const mint = await broker.mintActivationTicket(page, request, authority, {
      confirmFirstUse: async () => true,
    });
    return broker.executeAction(
      page,
      mint.ok ? { ...request, activationTicket: mint.ticketId } : request,
      authority,
    );
  }

  function makeRequest(lease: PageRenderLease, overrides: Partial<PageActionRequest> = {}): PageActionRequest {
    return {
      requestId: `req_${Math.random().toString(36).slice(2)}`,
      pageSlug: 'dash',
      leaseId: lease.leaseId,
      nonce: lease.nonce,
      grantId: 'grant_test0001',
      invocation: { kind: 'api', method: 'GET', path: '/repos/craft/agents' },
      ...overrides,
    };
  }

  async function readAudit(): Promise<Array<Record<string, unknown>>> {
    // Audit writes are fire-and-forget; give the microtask queue a tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!existsSync(auditPath)) return [];
    return readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  describe('shared audit append path', () => {
    it('redacts lifecycle metadata before appending it to the Page action log', async () => {
      await appendPageActionAudit({
        event: 'page_grant_rejected',
        workspaceId: 'workspace',
        pageSlug: 'dash',
        actionKind: 'api',
        metadata: { apiKey: 'secret-value' },
      }, { auditLogPath: auditPath });

      const audit = await readAudit();
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0])).not.toContain('secret-value');
      expect((audit[0]?.metadata as { apiKey: string }).apiKey).toBe('[REDACTED]');
    });
  });

  describe('happy path', () => {
    it('executes a granted api action through the injected executor', async () => {
      const calls: unknown[] = [];
      const broker = makeBroker({
        executeApi: async (invocation, { signal }) => {
          calls.push({ invocation, aborted: signal.aborted });
          return { status: 200, ok: true, body: { repos: 3 } };
        },
      });

      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await run(broker, makePage(), makeRequest(lease));

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ repos: 3 });
      expect(calls).toHaveLength(1);
      expect((calls[0] as { invocation: { sourceSlug: string } }).invocation.sourceSlug).toBe('github');

      const audit = await readAudit();
      const executed = audit.find((e) => e.event === 'page_action_executed');
      expect(executed?.ok).toBe(true);
      expect(executed?.policyDecision).toBe('allow');
      // Descriptor details come off the APPROVED grant, not the request.
      expect(executed?.actionKind).toBe('api');
      expect(executed?.method).toBe('GET');
      expect(executed?.sourceSlug).toBe('github');
      expect(executed?.invocation).toBeUndefined();
    });
  });

  describe('api path traversal (grant path canonicalization)', () => {
    it('rejects a `..` path before the match and never runs the executor', async () => {
      const calls: unknown[] = [];
      const broker = makeBroker({
        executeApi: async (invocation) => { calls.push(invocation); return { status: 200, ok: true, body: null }; },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      // Grant is GET /repos/.* — this matches the anchored pattern raw, but fetch
      // would normalize it to /admin with the real credential.
      const literal = await run(broker, makePage(), makeRequest(lease, {
        invocation: { kind: 'api', method: 'GET', path: '/repos/../../admin' },
      }));
      expect(literal.ok).toBe(false);
      expect(literal.error).toContain('invocation-path-unsafe');

      // Percent-encoded form (%2e%2e) is decoded and caught too.
      const encoded = await run(broker, makePage(), makeRequest(lease, {
        invocation: { kind: 'api', method: 'GET', path: '/repos/%2e%2e/admin' },
      }));
      expect(encoded.ok).toBe(false);
      expect(encoded.error).toContain('invocation-path-unsafe');

      expect(calls).toHaveLength(0);
    });

    it('still allows a legitimate nested path under the grant', async () => {
      const calls: Array<{ path: string }> = [];
      const broker = makeBroker({
        executeApi: async (invocation) => { calls.push(invocation as { path: string }); return { status: 200, ok: true, body: null }; },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const ok = await run(broker, makePage(), makeRequest(lease, {
        invocation: { kind: 'api', method: 'GET', path: '/repos/craft/agents' },
      }));
      expect(ok.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.path).toBe('/repos/craft/agents');
    });
  });

  describe('lease + replay validation', () => {
    it('rejects unknown leases, wrong nonces, and cross-page leases', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      const noLease = await run(broker, makePage(), makeRequest(lease, { leaseId: 'nope' }));
      expect(noLease.ok).toBe(false);
      expect(noLease.error).toContain('lease-not-found');

      const badNonce = await run(broker, makePage(), makeRequest(lease, { nonce: 'wrong' }));
      expect(badNonce.ok).toBe(false);
      expect(badNonce.error).toContain('nonce-mismatch');

      const otherPage = await run(broker, 
        makePage({ slug: 'other' }),
        makeRequest(lease, { pageSlug: 'other' }),
      );
      expect(otherPage.ok).toBe(false);
      expect(otherPage.error).toContain('lease-page-mismatch');
    });

    it('rejects expired leases', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      clock.now += 13 * 60 * 60 * 1000; // past the 12h default TTL
      const result = await run(broker, makePage(), makeRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('lease-expired');
    });

    it('rejects replayed request ids on the same lease', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const request = makeRequest(lease);

      const first = await run(broker, makePage(), request);
      expect(first.ok).toBe(true);

      const replay = await run(broker, makePage(), request);
      expect(replay.ok).toBe(false);
      expect(replay.error).toContain('replay');
    });

    it('rejects actions after the page content changed under the lease', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      const result = await run(broker, 
        makePage({ contentDigest: DIGEST_V2 }),
        makeRequest(lease),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('content-changed');
    });

    it('releasing a lease invalidates it', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      broker.releaseLease(lease.leaseId);

      const result = await run(broker, makePage(), makeRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('lease-not-found');
    });
  });

  describe('grant validation', () => {
    async function expectRejection(page: PageConfig, requestPatch: Partial<PageActionRequest>, code: string) {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: page.contentDigest! });
      const result = await run(broker, page, makeRequest(lease, requestPatch));
      expect(result.ok).toBe(false);
      expect(result.error).toContain(code);
    }

    it('rejects unknown grants', async () => {
      await expectRejection(makePage(), { grantId: 'grant_missing' }, 'grant-not-found');
    });

    it('rejects grants bound to older content (stale)', async () => {
      const page = makePage({
        contentDigest: DIGEST_V2,
        grants: [makeGrant()], // grant still bound to v1
      });
      disk.page = page;
      await expectRejection(page, {}, 'grant-stale');
    });

    it('rejects expired grants', async () => {
      const page = makePage({ grants: [makeGrant({ expiresAt: clock.now - 1 })] });
      disk.page = page;
      await expectRejection(page, {}, 'grant-expired');
    });

    it('rejects method and kind mismatches', async () => {
      await expectRejection(
        makePage(),
        { invocation: { kind: 'api', method: 'POST', path: '/repos/x' } },
        'grant-mismatch',
      );
      await expectRejection(
        makePage(),
        { invocation: { kind: 'mcp', toolName: 'create_issue' } },
        'grant-mismatch',
      );
    });

    it('anchors the path pattern (no substring matches)', async () => {
      await expectRejection(
        makePage(),
        { invocation: { kind: 'api', method: 'GET', path: '/evil/prefix/repos/x' } },
        'grant-mismatch',
      );
      // Normalization: leading slash optional in requests
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const ok = await run(broker, 
        makePage(),
        makeRequest(lease, { invocation: { kind: 'api', method: 'GET', path: 'repos/x' } }),
      );
      expect(ok.ok).toBe(true);
    });

    it('rejects mcp tool-name mismatches and honors mcp grants', async () => {
      const mcpGrant = makeGrant({
        id: 'grant_mcp00001',
        action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' },
      });
      const page = makePage({ grants: [mcpGrant] });
      disk.page = page;

      const broker = makeBroker({
        executeMcp: async (invocation) => ({ echoed: invocation.toolName }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      const wrongTool = await run(broker, 
        page,
        makeRequest(lease, { grantId: 'grant_mcp00001', invocation: { kind: 'mcp', toolName: 'delete_issue' } }),
      );
      expect(wrongTool.ok).toBe(false);
      expect(wrongTool.error).toContain('grant-mismatch');

      const ok = await run(broker, 
        page,
        makeRequest(lease, { grantId: 'grant_mcp00001', invocation: { kind: 'mcp', toolName: 'create_issue', args: { title: 'x' } } }),
      );
      expect(ok.ok).toBe(true);
      expect(ok.body).toEqual({ echoed: 'create_issue' });
    });
  });

  describe('execution edges', () => {
    it('returns a structured error when the executor is not wired', async () => {
      const mcpGrant = makeGrant({
        id: 'grant_mcp00001',
        action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' },
      });
      const broker = makeBroker({}); // no executors
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const mcpPage = makePage({ grants: [mcpGrant] });
      disk.page = mcpPage;
      const result = await run(broker, 
        mcpPage,
        makeRequest(lease, { grantId: 'grant_mcp00001', invocation: { kind: 'mcp', toolName: 'create_issue' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('executor-unavailable');
    });

    it('folds executor throws into failed results', async () => {
      const broker = makeBroker({
        executeApi: async () => {
          throw new Error('connection reset');
        },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await run(broker, makePage(), makeRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toBe('connection reset');
    });

    it('cancelAction aborts an in-flight request', async () => {
      const broker = makeBroker({
        executeApi: (_invocation, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const request = makeRequest(lease);

      const pending = run(broker, makePage(), request);
      // Give the broker a tick to register the in-flight controller
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(broker.cancelAction(lease.leaseId, lease.nonce, request.requestId)).toBe(true);

      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error).toContain('cancelled');
      expect(broker.cancelAction(lease.leaseId, lease.nonce, request.requestId)).toBe(false);
    });
  });

  describe('script actions', () => {
    const scriptGrant = () =>
      makeGrant({
        id: 'grant_script001',
        action: { kind: 'script', script: 'pages/dash/run.sh', runtime: 'bun', args: ['--once'] },
      });
    const scriptRequest = (lease: PageRenderLease) =>
      makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' } });
    /** The page as it exists on disk, which is what execution re-reads. */
    const scriptPageOnDisk = () => {
      const page = makePage({ grants: [scriptGrant()] });
      disk.page = page;
      return page;
    };

    it('runs the grant-pinned script and returns stdout/stderr/exit on success', async () => {
      const seen: unknown[] = [];
      const broker = makeBroker({
        executeScript: async (invocation) => {
          seen.push(invocation);
          return { exitCode: 0, stdout: 'hello', stderr: '' };
        },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await run(broker, scriptPageOnDisk(), scriptRequest(lease));

      expect(result.ok).toBe(true);
      expect(result.body).toEqual({ exitCode: 0, stdout: 'hello', stderr: '' });
      // The executor receives the grant's pinned script/runtime/args, never page input.
      expect(seen[0]).toEqual({ pageSlug: 'dash', script: 'pages/dash/run.sh', runtime: 'bun', args: ['--once'] });

      const audit = await readAudit();
      const executed = audit.find((e) => e.event === 'page_action_executed');
      expect(executed?.ok).toBe(true);
      expect(executed?.actionKind).toBe('script');
    });

    it('reports ok:false but still surfaces output on a non-zero exit', async () => {
      const broker = makeBroker({
        executeScript: async () => ({ exitCode: 2, stdout: '', stderr: 'boom' }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await run(broker, scriptPageOnDisk(), scriptRequest(lease));

      expect(result.ok).toBe(false);
      expect(result.error).toContain('code 2');
      expect(result.body).toEqual({ exitCode: 2, stdout: '', stderr: 'boom' });
    });

    it('returns executor-unavailable when no script executor is wired', async () => {
      const broker = makeBroker({}); // no executors
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await run(broker, scriptPageOnDisk(), scriptRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('executor-unavailable');
    });

    it('folds a blocked/throwing executor into a failed result', async () => {
      const broker = makeBroker({
        executeScript: async () => {
          throw new Error('Script path escapes the workspace');
        },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await run(broker, scriptPageOnDisk(), scriptRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('escapes the workspace');
    });
  });

  describe('audit trail', () => {
    it('records rejections with codes and redacts sensitive params', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      await run(broker, 
        makePage(),
        makeRequest(lease, {
          nonce: 'wrong',
          invocation: { kind: 'api', method: 'GET', path: '/repos/x', params: { apiToken: 'sk-super-secret', page: 2 } },
        }),
      );

      const audit = await readAudit();
      const rejected = audit.find((e) => e.event === 'page_action_rejected');
      expect(rejected?.code).toBe('nonce-mismatch');
      // Kind and the closed code only. Nothing matched, so there is no approved
      // grant to describe and the caller's claims are exactly what must not be
      // kept — not even the method.
      expect(rejected?.invocation).toEqual({ kind: 'api' });
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain('sk-super-secret');
      expect(serialized).not.toContain('/repos/x');
    });
  });

  describe('host-side per-lease rate limiting', () => {
    it('caps in-flight actions per lease, audits the rejection, and frees slots on completion', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const broker = makeBroker({
        executeApi: async () => { await gate; return { status: 200, ok: true, body: null }; },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage();
      disk.page = page;

      // Fill every in-flight slot (calls run to the executor await synchronously).
      const inFlight = Array.from({ length: PAGE_ACTION_MAX_IN_FLIGHT_PER_LEASE }, () =>
        run(broker, page, makeRequest(lease)),
      );
      const overflowRequest = makeRequest(lease);
      const overflow = await run(broker, page, overflowRequest);
      expect(overflow.ok).toBe(false);
      expect(overflow.error).toContain('rate-limited');

      // The rejection is part of the audit contract, same as validation rejections.
      const audit = await readAudit();
      const rejected = audit.find(
        (e) => e.event === 'page_action_rejected' && e.requestIdHash === pageAuditIdHash(overflowRequest.requestId),
      );
      expect(rejected?.code).toBe('rate-limited');

      release();
      const settled = await Promise.all(inFlight);
      expect(settled.every((r) => r.ok)).toBe(true);

      // Slots freed → the same lease accepts actions again.
      const after = await run(broker, page, makeRequest(lease));
      expect(after.ok).toBe(true);
    });

    it('caps starts per sliding minute, refills after the window, and isolates leases', async () => {
      const broker = makeBroker({
        executeApi: async () => ({ status: 200, ok: true, body: null }),
      });
      // Long-lived grant: the test advances the clock past the default 60s expiry.
      const grant = makeGrant({ expiresAt: clock.now + 3_600_000 });
      const page = makePage({ grants: [grant] });
      disk.page = page;
      const leaseA = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      for (let i = 0; i < PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE; i++) {
        expect((await run(broker, page, makeRequest(leaseA))).ok).toBe(true);
      }
      const throttled = await run(broker, page, makeRequest(leaseA));
      expect(throttled.ok).toBe(false);
      expect(throttled.error).toContain('rate-limited');

      // A different render (lease) has its own budget.
      const leaseB = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      expect((await run(broker, page, makeRequest(leaseB))).ok).toBe(true);

      // The window slides: a minute later the first lease works again.
      clock.now += 61_000;
      expect((await run(broker, page, makeRequest(leaseA))).ok).toBe(true);
    });
  });

  // ==========================================================
  // SUV-0065 — runtime authority, trusted activation, containment
  // ==========================================================

  describe('mutating classification (ADR-0033 §2)', () => {
    it('classifies every descriptor kind, and only api GET is non-mutating', () => {
      // Enumerated from the table itself, so a kind added to the union without
      // a classification fails here as well as at the type level.
      expect([...PAGE_ACTION_KINDS].sort()).toEqual(['api', 'mcp', 'script']);

      expect(isMutatingPageAction({ kind: 'api', sourceSlug: 'gh', method: 'GET', pathPattern: '.*' })).toBe(false);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        expect(isMutatingPageAction({ kind: 'api', sourceSlug: 'gh', method, pathPattern: '.*' })).toBe(true);
      }
      expect(isMutatingPageAction({ kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' })).toBe(true);
      expect(isMutatingPageAction({ kind: 'script', script: 'run.sh' })).toBe(true);

      // Invocations classify identically to descriptors — the two gates must
      // never disagree about what is privileged.
      expect(isMutatingPageAction({ kind: 'api', method: 'GET', path: '/x' })).toBe(false);
      expect(isMutatingPageAction({ kind: 'api', method: 'DELETE', path: '/x' })).toBe(true);
      expect(isMutatingPageAction({ kind: 'script' })).toBe(true);
    });

    it('treats an unknown kind, and a method-less api action, as mutating', () => {
      // A future wire version or an untyped JS caller must fail closed rather
      // than fall into the GET exemption.
      expect(isMutatingPageAction({ kind: 'session' } as never)).toBe(true);
      expect(isMutatingPageAction({} as never)).toBe(true);
      expect(isMutatingPageAction({ kind: 'api' } as never)).toBe(true);
    });

    it('gives every origin a policy and no policy to an unattributed caller', () => {
      expect([...PAGE_ACTION_ORIGINS].sort()).toEqual(['sandboxed-page', 'scheduled-refresh']);
      // Asserted as an exact shape, not just non-null. Every field here is
      // read by code; a field added without a reader shows up as a failure
      // here, which is the cheapest available nudge against the policy table
      // growing decorative entries (`requiresRenderLease` was one, and flipping
      // it changed nothing).
      expect(pageActionOriginPolicy('sandboxed-page')).toEqual({
        requiresActivationTicket: true,
        requiresFirstUseConfirmation: true,
      });
      expect(pageActionOriginPolicy('scheduled-refresh')).toEqual({
        requiresActivationTicket: false,
        requiresFirstUseConfirmation: false,
      });
      // `host-ui` is deliberately absent until something actually uses it.
      for (const notAnOrigin of [undefined, null, '', 'agent', 'webui', 'host-ui', 42, {}]) {
        expect(pageActionOriginPolicy(notAnOrigin)).toBeNull();
      }
    });

    it('fails an unattributed mutation closed, before any lease or grant is consulted', async () => {
      const calls: unknown[] = [];
      const broker = makeBroker({ executeScript: async (i) => { calls.push(i); return { exitCode: 0, stdout: '', stderr: '' }; } });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({ grants: [makeGrant({ id: 'grant_script001', action: { kind: 'script', script: 'run.sh' } })] });
      disk.page = page;
      const request = makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' } });

      for (const authority of [
        undefined as never,
        { workspaceId: 'ws_test0001', permissionMode: 'allow-all' } as never,
        { workspaceId: 'ws_test0001', origin: 'agent', permissionMode: 'allow-all' } as never,
      ]) {
        const result = await broker.executeAction(page, request, authority);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('origin-unattributed');
      }
      expect(calls).toHaveLength(0);
    });

    it('confines the scheduled origin to script grants and exempts only it from activation', async () => {
      const broker = makeBroker({
        executeApi: async () => ({ status: 200, ok: true, body: null }),
        executeScript: async () => ({ exitCode: 0, stdout: 'ran', stderr: '' }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const scheduled = { workspaceId: 'ws_test0001', origin: 'scheduled-refresh', permissionMode: 'ask' } as const;

      // A cron run has no click, so it carries no ticket — and still executes.
      const page = makePage({ grants: [makeGrant({ id: 'grant_script001', action: { kind: 'script', script: 'run.sh' } })] });
      disk.page = page;
      const ran = await broker.executeAction(
        page,
        makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' } }),
        scheduled,
      );
      expect(ran.error ?? '').toBe('');
      expect(ran.ok).toBe(true);

      // That exemption must not become a general no-activation route: a
      // scheduled origin may not run an api grant at all.
      const apiPage = makePage({ grants: [makeGrant({ action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/repos/.*' } })] });
      disk.page = apiPage;
      const refused = await broker.executeAction(
        apiPage,
        makeRequest(lease, { invocation: { kind: 'api', method: 'POST', path: '/repos/x' } }),
        scheduled,
      );
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain('origin-forbidden');
    });
  });

  describe('activation tickets (ADR-0033 §3)', () => {
    const writeGrant = () => makeGrant({
      id: 'grant_write0001',
      action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/repos/.*' },
    });
    const writePage = () => makePage({ grants: [writeGrant()] });
    const writeRequest = (lease: PageRenderLease, overrides: Partial<PageActionRequest> = {}) =>
      makeRequest(lease, {
        grantId: 'grant_write0001',
        invocation: { kind: 'api', method: 'POST', path: '/repos/craft/issues' },
        ...overrides,
      });

    function activationBroker() {
      const calls: unknown[] = [];
      const broker = makeBroker({
        executeApi: async (invocation) => { calls.push(invocation); return { status: 201, ok: true, body: null }; },
      });
      return { broker, calls };
    }

    const ticketOf = (mint: Awaited<ReturnType<PageActionBroker['mintActivationTicket']>>) =>
      (mint as { ticketId: string }).ticketId;

    it('refuses a mutating action with no ticket, and runs it with one', async () => {
      const { broker, calls } = activationBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;

      const bare = await broker.executeAction(page, writeRequest(lease), AUTHORITY);
      expect(bare.ok).toBe(false);
      expect(bare.error).toContain('activation-required');
      expect(calls).toHaveLength(0);

      const request = writeRequest(lease);
      const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
      expect(mint.ok).toBe(true);
      const ran = await broker.executeAction(page, { ...request, activationTicket: ticketOf(mint) }, AUTHORITY);
      expect(ran.ok).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it('rejects forged and unknown ticket ids', async () => {
      const { broker, calls } = activationBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      for (const activationTicket of ['', 'guessed', 'f'.repeat(48)]) {
        const result = await broker.executeAction(writePage(), writeRequest(lease, { activationTicket }), AUTHORITY);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/activation-(required|invalid)/);
      }
      expect(calls).toHaveLength(0);
    });

    it('spends a ticket exactly once, including against a concurrent double-spend', async () => {
      const { broker, calls } = activationBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;
      const request = writeRequest(lease);
      const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
      const activated = { ...request, activationTicket: ticketOf(mint) };

      // Fired together: consumption is atomic, so exactly one can win. If the
      // ticket were validated before removal both would pass this gate.
      const [first, second] = await Promise.all([
        broker.executeAction(page, activated, AUTHORITY),
        broker.executeAction(page, activated, AUTHORITY),
      ]);
      expect([first!.ok, second!.ok].filter(Boolean)).toHaveLength(1);
      expect(calls).toHaveLength(1);

      // And it is gone for good afterwards.
      const replayed = await broker.executeAction(page, { ...activated, requestId: 'req_fresh' }, AUTHORITY);
      expect(replayed.ok).toBe(false);
      expect(replayed.error).toContain('activation-invalid');
    });

    it('binds the ticket to the exact request, so it cannot be moved to another call', async () => {
      const { broker, calls } = activationBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({
        grants: [
          writeGrant(),
          makeGrant({ id: 'grant_script001', action: { kind: 'script', script: 'run.sh' } }),
        ],
      });
      const approved = writeRequest(lease);
      const mint = await broker.mintActivationTicket(page, approved, AUTHORITY, CONFIRMING);
      const ticketId = ticketOf(mint);

      // Same render, same lease, same nonce — a different call. The harmless
      // approved write must not become authority for a host script run.
      const escalated = await broker.executeAction(
        page,
        { ...makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' } }), activationTicket: ticketId },
        AUTHORITY,
      );
      expect(escalated.ok).toBe(false);
      expect(escalated.error).toContain('activation-invalid');

      // Even the same grant with a different path is a different call.
      const redirected = await broker.executeAction(
        page,
        { ...writeRequest(lease, { invocation: { kind: 'api', method: 'POST', path: '/repos/other/issues' } }), activationTicket: ticketId },
        AUTHORITY,
      );
      expect(redirected.ok).toBe(false);
      expect(redirected.error).toContain('activation-invalid');
      expect(calls).toHaveLength(0);
    });

    it('hashes canonically, so key order is not a second identity', () => {
      const lease = { leaseId: 'l', nonce: 'n' } as PageRenderLease;
      const a = makeRequest(lease, { requestId: 'req_1', invocation: { kind: 'api', method: 'POST', path: '/x', params: { b: 1, a: 2 } } });
      const b: PageActionRequest = {
        invocation: { params: { a: 2, b: 1 }, path: '/x', method: 'POST', kind: 'api' },
        grantId: a.grantId, nonce: a.nonce, leaseId: a.leaseId, pageSlug: a.pageSlug, requestId: a.requestId,
      };
      expect(canonicalPageActionHash('ws', DIGEST_V1, a)).toBe(canonicalPageActionHash('ws', DIGEST_V1, b));
      // …but a different workspace or a different content digest is a different call.
      expect(canonicalPageActionHash('ws2', DIGEST_V1, a)).not.toBe(canonicalPageActionHash('ws', DIGEST_V1, a));
      expect(canonicalPageActionHash('ws', DIGEST_V2, a)).not.toBe(canonicalPageActionHash('ws', DIGEST_V1, a));
    });

    it('refuses a ticket across pages, renders, and workspaces', async () => {
      const { broker, calls } = activationBroker();
      const leaseA = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const leaseB = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;

      // A fresh ticket per attempt: redemption is atomic and unconditional, so
      // a failed attempt burns the ticket and a shared one would make the
      // second assertion pass for the wrong reason.
      const forRender = writeRequest(leaseA);
      const renderMint = await broker.mintActivationTicket(page, forRender, AUTHORITY, CONFIRMING);

      // Another render of the same page cannot spend it.
      const otherRender = await broker.executeAction(
        page,
        { ...writeRequest(leaseB), activationTicket: ticketOf(renderMint) },
        AUTHORITY,
      );
      expect(otherRender.ok).toBe(false);
      expect(otherRender.error).toContain('activation-invalid');

      // Another workspace cannot spend it, even naming the same request.
      const forWorkspace = writeRequest(leaseA);
      const workspaceMint = await broker.mintActivationTicket(page, forWorkspace, AUTHORITY, CONFIRMING);
      const otherWorkspace = await broker.executeAction(
        page,
        { ...forWorkspace, activationTicket: ticketOf(workspaceMint) },
        { ...AUTHORITY, workspaceId: 'ws_other' },
      );
      expect(otherWorkspace.ok).toBe(false);
      expect(otherWorkspace.error).toContain('workspace-mismatch');
      expect(calls).toHaveLength(0);
    });

    it('refuses a ticket minted under a different origin', async () => {
      const { broker } = activationBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;
      const request = writeRequest(lease);
      const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);

      const result = await broker.executeAction(
        page,
        { ...request, activationTicket: ticketOf(mint) },
        { ...AUTHORITY, origin: 'scheduled-refresh' },
      );
      expect(result.ok).toBe(false);
      // A scheduled origin cannot run an api grant at all, so it is refused
      // before the ticket is even considered — the ticket stays unspendable.
      expect(result.error).toContain('origin-forbidden');
    });

    it('expires tickets within the 10-second ceiling and clamps a generous option', async () => {
      const broker = new PageActionBroker({
        executors: { executeApi: async () => ({ status: 201, ok: true, body: null }) },
        auditLogPath: auditPath,
        workspaceId: TEST_AUDIT_SCOPE,
        now: () => clock.now,
        // A caller asking for an hour gets the ADR ceiling, not an hour.
        activationTicketTtlMs: 60 * 60 * 1000,
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;
      const request = writeRequest(lease);
      const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
      expect(mint.ok).toBe(true);
      expect((mint as { expiresAt: number }).expiresAt - clock.now).toBeLessThanOrEqual(PAGE_ACTIVATION_TICKET_TTL_CEILING_MS);

      clock.now += PAGE_ACTIVATION_TICKET_TTL_CEILING_MS + 1;
      const stale = await broker.executeAction(page, { ...request, activationTicket: ticketOf(mint) }, AUTHORITY);
      expect(stale.ok).toBe(false);
      expect(stale.error).toContain('activation-invalid');
    });

    it('invalidates outstanding tickets when the lease is released or the page changes', async () => {
      const { broker } = activationBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;

      const released = writeRequest(lease);
      const mintA = await broker.mintActivationTicket(page, released, AUTHORITY, CONFIRMING);
      expect(broker.activationTicketCount).toBe(1);
      broker.releaseLease(lease.leaseId);
      expect(broker.activationTicketCount).toBe(0);
      const afterRelease = await broker.executeAction(page, { ...released, activationTicket: ticketOf(mintA) }, AUTHORITY);
      expect(afterRelease.ok).toBe(false);

      const lease2 = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      await broker.mintActivationTicket(page, writeRequest(lease2), AUTHORITY, CONFIRMING);
      expect(broker.activationTicketCount).toBe(1);
      // A content change or a revocation must reach tickets too: they are the
      // one authority that does not re-read page.json for itself.
      broker.invalidateActivationsForPage('dash');
      expect(broker.activationTicketCount).toBe(0);
    });

    it('caps unspent tickets per render', async () => {
      const { broker } = activationBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;
      for (let i = 0; i < MAX_OUTSTANDING_TICKETS_PER_LEASE; i++) {
        expect((await broker.mintActivationTicket(page, writeRequest(lease), AUTHORITY, CONFIRMING)).ok).toBe(true);
      }
      const overflow = await broker.mintActivationTicket(page, writeRequest(lease), AUTHORITY, CONFIRMING);
      expect(overflow.ok).toBe(false);
      expect((overflow as { code: string }).code).toBe('rate-limited');
    });

    it('holds the outstanding cap against concurrent mints', async () => {
      // First-use confirmation is an await on a human, so counting only ISSUED
      // tickets let every concurrent mint read the same pre-dialog total and
      // all pass. Eight at once against a cap of four.
      const { broker } = activationBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;

      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const confirmFirstUse = async () => { await held; return true; };

      const attempts = Array.from({ length: 8 }, () =>
        broker.mintActivationTicket(page, writeRequest(lease), AUTHORITY, { confirmFirstUse }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      const outcomes = await Promise.all(attempts);

      const minted = outcomes.filter((o) => o.ok);
      expect(minted.length).toBeLessThanOrEqual(MAX_OUTSTANDING_TICKETS_PER_LEASE);
      expect(broker.activationTicketCount).toBeLessThanOrEqual(MAX_OUTSTANDING_TICKETS_PER_LEASE);
      // The rest are refused, not silently dropped.
      expect(outcomes.filter((o) => !o.ok).length).toBe(8 - minted.length);
      expect(outcomes.some((o) => !o.ok && (o as { code: string }).code === 'rate-limited')).toBe(true);
    });

    it('does not mint for a non-mutating action', async () => {
      const { broker } = activationBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const mint = await broker.mintActivationTicket(makePage(), makeRequest(lease), AUTHORITY, CONFIRMING);
      expect(mint.ok).toBe(false);
      expect(broker.activationTicketCount).toBe(0);
    });

    it('audits issue and rejection without the invocation payload', async () => {
      const { broker } = activationBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;
      await broker.mintActivationTicket(
        page,
        writeRequest(lease, { invocation: { kind: 'api', method: 'POST', path: '/repos/x', params: { apiToken: 'sk-super-secret' } } }),
        AUTHORITY,
        CONFIRMING,
      );
      await broker.mintActivationTicket(page, writeRequest(lease, { grantId: 'grant_missing' }), AUTHORITY, CONFIRMING);

      const audit = await readAudit();
      const issued = audit.find((e) => e.event === 'page_activation_issued');
      expect(issued?.origin).toBe('sandboxed-page');
      expect(issued?.workspaceId).toBe('ws_test0001');
      const rejected = audit.find((e) => e.event === 'page_activation_rejected');
      expect(rejected?.code).toBe('grant-not-found');
      // Activation rows are metadata: no arguments, bodies, or descriptors.
      expect(JSON.stringify(audit)).not.toContain('sk-super-secret');
      expect(issued?.invocation).toBeUndefined();
    });
  });

  describe('origin policy is enforced, not presented', () => {
    it('states the cells each caller consumes', () => {
      // The scheduled path structurally cannot produce either credential, and
      // refuses if its row ever says it must; the render path requires both and
      // enforces them. Asserting the rows here is what ties those two branches
      // to the table — if someone flips a cell, this fails alongside the
      // behaviour that depends on it.
      //
      // Honest limitation: with today's table the scheduled refusal branch is
      // unreachable, so it is guarded by this assertion rather than executed by
      // a test. Making it executable would mean injecting the policy, which is
      // more machinery than the guard is worth.
      expect(pageActionOriginPolicy('scheduled-refresh')).toEqual({
        requiresActivationTicket: false,
        requiresFirstUseConfirmation: false,
      });
      expect(pageActionOriginPolicy('sandboxed-page')).toEqual({
        requiresActivationTicket: true,
        requiresFirstUseConfirmation: true,
      });
    });
  });

  describe('first-use confirmation for script grants (ADR-0033 §3)', () => {
    const scriptPage = () => makePage({
      grants: [makeGrant({ id: 'grant_script001', action: { kind: 'script', script: 'pages/dash/run.sh' } })],
    });
    const scriptReq = (lease: PageRenderLease, overrides: Partial<PageActionRequest> = {}) =>
      makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' }, ...overrides });

    it('asks once per render, then stops asking for that grant', async () => {
      const broker = makeBroker({ executeScript: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = scriptPage();
      disk.page = page;
      let asked = 0;
      const confirmFirstUse = async () => { asked++; return true; };

      expect((await broker.mintActivationTicket(page, scriptReq(lease), AUTHORITY, { confirmFirstUse })).ok).toBe(true);
      expect(asked).toBe(1);
      expect((await broker.mintActivationTicket(page, scriptReq(lease), AUTHORITY, { confirmFirstUse })).ok).toBe(true);
      expect(asked).toBe(1);

      // A new render is a new consent scope, per ADR-0033.
      const lease2 = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      expect((await broker.mintActivationTicket(page, scriptReq(lease2), AUTHORITY, { confirmFirstUse })).ok).toBe(true);
      expect(asked).toBe(2);
    });

    it('mints nothing when confirmation is declined or unavailable', async () => {
      const calls: unknown[] = [];
      const broker = makeBroker({ executeScript: async (i) => { calls.push(i); return { exitCode: 0, stdout: '', stderr: '' }; } });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = scriptPage();
      disk.page = page;

      const declined = await broker.mintActivationTicket(page, scriptReq(lease), AUTHORITY, { confirmFirstUse: async () => false });
      expect(declined.ok).toBe(false);
      expect((declined as { code: string }).code).toBe('first-use-confirmation-declined');

      // A host with no confirmation surface refuses rather than proceeding.
      const unavailable = await broker.mintActivationTicket(page, scriptReq(lease), AUTHORITY);
      expect(unavailable.ok).toBe(false);
      expect((unavailable as { code: string }).code).toBe('first-use-confirmation-required');

      expect(broker.activationTicketCount).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it('re-checks authority after the dialog, so expiry during confirmation mints nothing', async () => {
      const broker = makeBroker({ executeScript: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = scriptPage();
      disk.page = page;

      // The grant expires while the user is reading the dialog. Approving the
      // question is not approving the state that follows it.
      const expiring = await broker.mintActivationTicket(page, scriptReq(lease), AUTHORITY, {
        confirmFirstUse: async () => { clock.now += 120_000; return true; },
      });
      expect(expiring.ok).toBe(false);
      expect((expiring as { code: string }).code).toBe('grant-expired');
      expect(broker.activationTicketCount).toBe(0);
    });

    it('mints nothing when the render is released while the dialog is open', async () => {
      const broker = makeBroker({ executeScript: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = scriptPage();
      disk.page = page;

      const abandoned = await broker.mintActivationTicket(page, scriptReq(lease), AUTHORITY, {
        confirmFirstUse: async () => { broker.releaseLease(lease.leaseId); return true; },
      });
      expect(abandoned.ok).toBe(false);
      expect((abandoned as { code: string }).code).toBe('lease-not-found');
    });

    it('requires confirmation for api and mcp writes too, not only scripts', async () => {
      // ADR-0033 §3 named script and session, on the assumption that a frame
      // click could be established as proof for the rest. The SUV-0065
      // experiment refuted that assumption, so a window gesture cannot tell an
      // approved POST the user asked for from one a timer fired on the back of
      // an unrelated click elsewhere in the app. Every mutating kind therefore
      // gets the one click that is unambiguously about this action.
      const calls: unknown[] = [];
      const broker = makeBroker({
        executeApi: async (invocation) => { calls.push(invocation); return { status: 201, ok: true, body: null }; },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({
        grants: [makeGrant({ id: 'grant_write0001', action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/repos/.*' } })],
      });
      const write = () => makeRequest(lease, {
        grantId: 'grant_write0001',
        invocation: { kind: 'api', method: 'POST', path: '/repos/x' },
      });

      const unconfirmed = await broker.mintActivationTicket(page, write(), AUTHORITY);
      expect((unconfirmed as { code: string }).code).toBe('first-use-confirmation-required');

      const declined = await broker.mintActivationTicket(page, write(), AUTHORITY, { confirmFirstUse: async () => false });
      expect((declined as { code: string }).code).toBe('first-use-confirmation-declined');
      expect(calls).toHaveLength(0);

      // Confirmed once, then not asked again for this grant on this render.
      let asked = 0;
      const confirmFirstUse = async () => { asked++; return true; };
      expect((await broker.mintActivationTicket(page, write(), AUTHORITY, { confirmFirstUse })).ok).toBe(true);
      expect((await broker.mintActivationTicket(page, write(), AUTHORITY, { confirmFirstUse })).ok).toBe(true);
      expect(asked).toBe(1);
    });
  });

  describe('permission mode and workspace revalidation', () => {
    it('refuses mutation in Explore while still allowing reads', async () => {
      const broker = makeBroker({
        executeApi: async () => ({ status: 200, ok: true, body: null }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const safe = { ...AUTHORITY, permissionMode: 'safe' } as const;

      const readable = await broker.executeAction(makePage(), makeRequest(lease), safe);
      expect(readable.ok).toBe(true);

      const page = makePage({
        grants: [makeGrant({ id: 'grant_write0001', action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/repos/.*' } })],
      });
      const request = makeRequest(lease, { grantId: 'grant_write0001', invocation: { kind: 'api', method: 'POST', path: '/repos/x' } });

      // Refused at mint, so the user is never shown a confirmation for
      // something that cannot run…
      const mint = await broker.mintActivationTicket(page, request, safe, CONFIRMING);
      expect(mint.ok).toBe(false);
      expect((mint as { code: string }).code).toBe('permission-mode-forbidden');

      // …and refused again at execution, so a ticket minted before the mode
      // changed cannot outlive the change.
      const permissive = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
      const afterSwitch = await broker.executeAction(
        page,
        { ...request, activationTicket: (permissive as { ticketId: string }).ticketId },
        safe,
      );
      expect(afterSwitch.ok).toBe(false);
      expect(afterSwitch.error).toContain('permission-mode-forbidden');
    });

    it('refuses an authority with no resolved workspace', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makePage(), makeRequest(lease), { ...AUTHORITY, workspaceId: '' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('workspace-mismatch');
    });
  });

  describe('lease-scoped in-flight keys and cancellation ownership', () => {
    function hangingBroker() {
      return makeBroker({
        executeApi: (_invocation, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      });
    }

    it('refuses a cancel that cannot prove the render it names', async () => {
      const broker = hangingBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const request = makeRequest(lease);
      const pending = broker.executeAction(makePage(), request, AUTHORITY);
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Knowing the request id is not authority: the caller must hold the
      // lease secret, which is the same bar acting on the render requires.
      expect(broker.cancelAction(lease.leaseId, 'wrong-nonce', request.requestId)).toBe(false);
      expect(broker.cancelAction('not-a-lease', lease.nonce, request.requestId)).toBe(false);

      expect(broker.cancelAction(lease.leaseId, lease.nonce, request.requestId)).toBe(true);
      expect((await pending).ok).toBe(false);
    });

    it('does not let one render cancel another render request id', async () => {
      const broker = hangingBroker();
      const victim = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const attacker = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const request = makeRequest(victim, { requestId: 'req_shared_id' });
      const pending = broker.executeAction(makePage(), request, AUTHORITY);
      await new Promise((resolve) => setTimeout(resolve, 5));

      // The attacker holds a real lease and its real nonce, and names the
      // victim request id. Lease-scoped keys are what make this miss.
      expect(broker.cancelAction(attacker.leaseId, attacker.nonce, 'req_shared_id')).toBe(false);

      expect(broker.cancelAction(victim.leaseId, victim.nonce, 'req_shared_id')).toBe(true);
      expect((await pending).ok).toBe(false);
    });

    it('withdraws an unspent ticket when its request is cancelled before execution', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 201, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({
        grants: [makeGrant({ id: 'grant_write0001', action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/repos/.*' } })],
      });
      const request = makeRequest(lease, { grantId: 'grant_write0001', invocation: { kind: 'api', method: 'POST', path: '/repos/x' } });
      const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
      expect(broker.activationTicketCount).toBe(1);

      broker.cancelAction(lease.leaseId, lease.nonce, request.requestId);
      expect(broker.activationTicketCount).toBe(0);

      const result = await broker.executeAction(
        page,
        { ...request, activationTicket: (mint as { ticketId: string }).ticketId },
        AUTHORITY,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('activation-invalid');
    });
  });

  describe('cost bounds: timeout, concurrency, queue, and the wider rate limits', () => {
    it('releases every slot on its own deadline even when the executor never settles', async () => {
      // The executor ignores its AbortSignal entirely — the case an
      // AbortSignal-only design cannot recover from.
      const broker = new PageActionBroker({
        executors: { executeApi: () => new Promise(() => {}) },
        auditLogPath: auditPath,
        workspaceId: TEST_AUDIT_SCOPE,
        actionTimeoutMs: 40,
        now: () => clock.now,
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      const result = await broker.executeAction(makePage(), makeRequest(lease), AUTHORITY);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('timeout');

      // The slot came back: the lease is usable rather than wedged forever.
      const after = await broker.executeAction(makePage(), makeRequest(lease), AUTHORITY);
      expect(after.ok).toBe(false);
      expect(after.error).toContain('timeout');
      // The durable row carries the stable outcome, not the executor's message.
      const audit = await readAudit();
      expect(audit.some((e) => e.event === 'page_action_executed' && e.outcome === 'timeout')).toBe(true);
      expect(JSON.stringify(audit)).not.toContain('exceeded');
    });

    it('runs at most two mutating actions at once and serializes the rest', async () => {
      let running = 0;
      let peak = 0;
      const gates: Array<() => void> = [];
      const broker = makeBroker({
        executeApi: () => new Promise((resolve) => {
          running++;
          peak = Math.max(peak, running);
          gates.push(() => { running--; resolve({ status: 201, ok: true, body: null }); });
        }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({
        grants: [makeGrant({ id: 'grant_write0001', expiresAt: clock.now + 3_600_000, action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/repos/.*' } })],
      });
      disk.page = page;
      const write = async () => {
        const request = makeRequest(lease, { grantId: 'grant_write0001', invocation: { kind: 'api', method: 'POST', path: '/repos/x' } });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY);
      };

      const first = write();
      const second = write();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const third = write();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(peak).toBe(PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE);

      // Draining one slot admits the queued third, and the ceiling still holds.
      gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 10));
      while (gates.length) gates.shift()!();
      const settled = await Promise.all([first, second, third]);
      expect(settled.every((r) => r.ok)).toBe(true);
      expect(peak).toBe(PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE);
    });

    it('overflows the mutating queue with a refusal instead of an unbounded backlog', async () => {
      const gates: Array<() => void> = [];
      const broker = makeBroker({
        executeApi: () => new Promise((resolve) => { gates.push(() => resolve({ status: 201, ok: true, body: null })); }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({
        grants: [makeGrant({ id: 'grant_write0001', expiresAt: clock.now + 3_600_000, action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/repos/.*' } })],
      });
      disk.page = page;
      const start = async () => {
        const request = makeRequest(lease, { grantId: 'grant_write0001', invocation: { kind: 'api', method: 'POST', path: '/repos/x' } });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY);
      };

      const pending: Array<Promise<PageActionResult>> = [];
      // Two running plus a full queue.
      for (let i = 0; i < PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE + PAGE_ACTION_MAX_QUEUED_MUTATING_PER_LEASE; i++) {
        pending.push(start());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const overflow = await start();
      expect(overflow.ok).toBe(false);
      expect(overflow.error).toContain('queue-overflow');

      // Each drained pair admits the next pair, so the queue unwinds in rounds
      // rather than all at once — keep releasing until everything has settled.
      let settled = false;
      void Promise.all(pending).then(() => { settled = true; });
      for (let round = 0; round < 10 && !settled; round++) {
        while (gates.length) gates.shift()!();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const results = await Promise.all(pending);
      expect(results.every((r) => r.ok)).toBe(true);
    });

    it('caps starts per minute for the page and the workspace, which a re-mount cannot reset', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const grant = makeGrant({ expiresAt: clock.now + 3_600_000 });
      const page = makePage({ grants: [grant] });
      disk.page = page;

      // Re-mount every 25 actions, which is what defeats the 30/minute
      // per-lease budget without pretending a client mints a lease per click.
      // What stops this is the page ceiling above the lease — the one a
      // re-mount cannot reset.
      let accepted = 0;
      let pageLimited = false;
      let lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      for (let i = 0; i < PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_PAGE + 5; i++) {
        if (i > 0 && i % 25 === 0) lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
        const result = await broker.executeAction(page, makeRequest(lease), AUTHORITY);
        if (result.ok) accepted++;
        else if (result.error?.includes('for this page')) pageLimited = true;
      }
      expect(accepted).toBe(PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_PAGE);
      expect(pageLimited).toBe(true);

      // Other pages share one workspace ceiling. Spreading the remaining budget
      // over several pages is what reaches it: two pages at the page cap land
      // exactly on the workspace cap, so the page limit would always answer
      // first and the workspace limit would never be the reason.
      let workspaceLimited = false;
      outer: for (const slug of ['other', 'third', 'fourth']) {
        const other = makePage({ slug, grants: [grant] });
        // Re-mount periodically rather than per action, for the same reason as
        // above: one lease per click is not a client, it is a way to dodge the
        // per-lease budget, and it now collides with the lease budget too.
        let otherLease = broker.createLease({ pageSlug: slug, contentDigest: DIGEST_V1 });
        for (let i = 0; i < PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_PAGE; i++) {
          if (i > 0 && i % 25 === 0) otherLease = broker.createLease({ pageSlug: slug, contentDigest: DIGEST_V1 });
          const result = await broker.executeAction(other, makeRequest(otherLease, { pageSlug: slug }), AUTHORITY);
          if (!result.ok && result.error?.includes('for this workspace')) { workspaceLimited = true; break outer; }
        }
      }
      expect(workspaceLimited).toBe(true);

      // The window slides.
      clock.now += 61_000;
      disk.page = page;
      const recovered = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      expect((await broker.executeAction(page, makeRequest(recovered), AUTHORITY)).ok).toBe(true);
    });
  });


  /**
   * Regressions for the three defects the PR #204 review found. Each one
   * passed the original suite, so each gets a test that fails without its fix.
   */
  describe('review regressions (PR #204)', () => {
    const writeGrant = () => makeGrant({
      id: 'grant_write0001',
      expiresAt: clock.now + 3_600_000,
      action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/repos/.*' },
    });
    const writePage = () => makePage({ grants: [writeGrant()] });

    it('holds the mutating ceiling against requests started in the SAME turn', async () => {
      // The original check-then-act read the count, awaited, and only then
      // incremented, so requests that never yielded between those two steps all
      // saw a free slot. The earlier concurrency test missed it by spacing the
      // third request with a timer; this one starts them together.
      let running = 0;
      let peak = 0;
      const gates: Array<() => void> = [];
      const broker = makeBroker({
        executeApi: () => new Promise((resolve) => {
          running++;
          peak = Math.max(peak, running);
          gates.push(() => { running--; resolve({ status: 201, ok: true, body: null }); });
        }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;

      const start = async () => {
        const request = makeRequest(lease, {
          grantId: 'grant_write0001',
          invocation: { kind: 'api', method: 'POST', path: '/repos/x' },
        });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY);
      };

      // No awaits between them: all four race into admission together.
      const all = [start(), start(), start(), start()];
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(peak).toBeLessThanOrEqual(PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE);

      let settled = false;
      void Promise.all(all).then(() => { settled = true; });
      for (let round = 0; round < 10 && !settled; round++) {
        while (gates.length) gates.shift()!();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await Promise.all(all);
      expect(peak).toBeLessThanOrEqual(PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE);
    });

    it('cancels a request that is still waiting for a slot, and never runs it', async () => {
      // The ticket is spent at admission but the controller used to be
      // registered only after the wait, so a queued write was uncancellable:
      // cancelAction found nothing, said so, and the write ran anyway.
      const gates: Array<() => void> = [];
      const executed: unknown[] = [];
      const broker = makeBroker({
        executeApi: (invocation) => new Promise((resolve) => {
          executed.push(invocation);
          gates.push(() => resolve({ status: 201, ok: true, body: null }));
        }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;

      const start = async (path: string) => {
        const request = makeRequest(lease, {
          grantId: 'grant_write0001',
          invocation: { kind: 'api', method: 'POST', path },
        });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return {
          requestId: request.requestId,
          result: broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY),
        };
      };

      const first = await start('/repos/a');
      const second = await start('/repos/b');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = await start('/repos/c');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(executed).toHaveLength(PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE);

      expect(broker.cancelAction(lease.leaseId, lease.nonce, queued.requestId)).toBe(true);

      while (gates.length) gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      while (gates.length) gates.shift()!();

      const settled = await Promise.all([first.result, second.result, queued.result]);
      expect(settled[2]!.ok).toBe(false);
      expect(settled[2]!.error).toContain('cancelled');
      // The withdrawn write never reached the executor, even after a slot freed.
      expect(executed).toHaveLength(PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE);
    });

    it('refuses a ticket whose approved command was swapped under the same grant id', async () => {
      // page.json can be rewritten in place while the confirmation dialog is
      // open: same grant id, same content digest (which covers index.html, not
      // the grant list). The ticket must name the command the user was shown,
      // not the slot it was filed under.
      const ran: Array<{ script: string }> = [];
      const broker = makeBroker({
        executeScript: async (invocation) => { ran.push({ script: invocation.script }); return { exitCode: 0, stdout: '', stderr: '' }; },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const approvedPage = makePage({
        grants: [makeGrant({ id: 'grant_script001', action: { kind: 'script', script: 'pages/dash/safe.ts' } })],
      });
      const request = makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' } });
      const mint = await broker.mintActivationTicket(approvedPage, request, AUTHORITY, CONFIRMING);
      expect(mint.ok).toBe(true);

      // The same id now points at a different command — this is what execution
      // re-reads from disk.
      const swappedPage = makePage({
        grants: [makeGrant({ id: 'grant_script001', action: { kind: 'script', script: 'pages/dash/evil.ts' } })],
      });
      const result = await broker.executeAction(
        swappedPage,
        { ...request, activationTicket: (mint as { ticketId: string }).ticketId },
        AUTHORITY,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('activation-invalid');
      expect(ran).toHaveLength(0);
    });

    it('asks again when the command behind a confirmed grant id changes', async () => {
      // Sibling of the ticket-binding hole: binding the descriptor into the
      // TICKET does not help if the confirmation cache still says "already
      // confirmed" for the id, because the replacement ticket is then minted
      // against the new descriptor consistently. The dialog is what has to be
      // re-shown, so the confirmation identity carries the command too.
      const broker = makeBroker({ executeScript: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const pageWith = (script: string) => makePage({
        grants: [makeGrant({ id: 'grant_script001', action: { kind: 'script', script } })],
      });
      const req = () => makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' } });

      const shown: string[] = [];
      const confirmFirstUse = async () => { shown.push('asked'); return true; };

      expect((await broker.mintActivationTicket(pageWith('pages/dash/safe.ts'), req(), AUTHORITY, { confirmFirstUse })).ok).toBe(true);
      expect(shown).toHaveLength(1);
      // Same command, same id: no second dialog, as designed.
      expect((await broker.mintActivationTicket(pageWith('pages/dash/safe.ts'), req(), AUTHORITY, { confirmFirstUse })).ok).toBe(true);
      expect(shown).toHaveLength(1);

      // Same id, different command: the user has consented to nothing here.
      expect((await broker.mintActivationTicket(pageWith('pages/dash/evil.ts'), req(), AUTHORITY, { confirmFirstUse })).ok).toBe(true);
      expect(shown).toHaveLength(2);

      // And a declined replacement mints nothing at all.
      const declined = await broker.mintActivationTicket(
        pageWith('pages/dash/worse.ts'), req(), AUTHORITY, { confirmFirstUse: async () => false },
      );
      expect((declined as { code: string }).code).toBe('first-use-confirmation-declined');
    });

    it('gives the slot back when a queued request is refused after the wait', async () => {
      // Admission reserves a slot before the queue; every exit path after that
      // has to return it, or a refused queue entry permanently shrinks the
      // render's concurrency.
      const gates: Array<() => void> = [];
      const broker = makeBroker({
        executeApi: () => new Promise((resolve) => { gates.push(() => resolve({ status: 201, ok: true, body: null })); }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = writePage();
      disk.page = page;
      const start = async () => {
        const request = makeRequest(lease, {
          grantId: 'grant_write0001',
          invocation: { kind: 'api', method: 'POST', path: '/repos/x' },
        });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY);
      };

      // Not awaited: `start` returns the executeAction promise, so awaiting it
      // would wait for an action the gate is deliberately holding open.
      const running = [start(), start()];
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Releasing the lease refuses the queued request after it wakes.
      broker.releaseLease(lease.leaseId);
      while (gates.length) gates.shift()!();
      const refused = await queued;
      expect(refused.ok).toBe(false);
      await Promise.all(running);

      // A fresh render still gets its full concurrency.
      const lease2 = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const after = async () => {
        const request = makeRequest(lease2, {
          grantId: 'grant_write0001',
          invocation: { kind: 'api', method: 'POST', path: '/repos/x' },
        });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY);
      };
      const nextPair = [after(), after()];
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(gates.length).toBe(PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE);
      while (gates.length) gates.shift()!();
      await Promise.all(nextPair);
    });
  });


  /**
   * Regressions for the independent architecture review of PR #204. Each covers
   * a check that passed against a snapshot or a test-only path while the
   * production one went around it.
   */
  describe('architecture review regressions (PR #204)', () => {
    const writeGrant = () => makeGrant({
      id: 'grant_write0001',
      expiresAt: clock.now + 3_600_000,
      action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/repos/.*' },
    });

    /** Two writes occupying both slots, plus a third that must queue behind them. */
    function saturated() {
      const gates: Array<() => void> = [];
      const executed: string[] = [];
      const broker = makeBroker({
        executeApi: (invocation) => new Promise((resolve) => {
          executed.push(invocation.path);
          gates.push(() => resolve({ status: 201, ok: true, body: null }));
        }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({ grants: [writeGrant()] });
      disk.page = page;
      const start = async (path: string) => {
        const request = makeRequest(lease, {
          grantId: 'grant_write0001',
          invocation: { kind: 'api', method: 'POST', path },
        });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY);
      };
      return { broker, lease, page, gates, executed, start };
    }

    it('sees a revocation that happens while the request is queued', async () => {
      const { broker, gates, executed, start } = saturated();
      const running = [start('/repos/a'), start('/repos/b')];
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = start('/repos/c');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(executed).toHaveLength(PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE);

      // The user revokes while the third write waits. The snapshot this call
      // was admitted against still lists the grant, so only re-reading disk can
      // see this — which is the whole point.
      disk.page = makePage({ grants: [] });

      while (gates.length) gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      while (gates.length) gates.shift()!();

      const result = await queued;
      expect(result.ok).toBe(false);
      expect(result.error).toContain('grant-not-found');
      // It never reached the source.
      expect(executed).toHaveLength(PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE);
      await Promise.all(running);
    });

    it('sees a content change that happens while the request is queued', async () => {
      const { broker, gates, executed, start } = saturated();
      const running = [start('/repos/a'), start('/repos/b')];
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = start('/repos/c');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // New content: the grant is still listed but is now bound to a digest the
      // page no longer has, which is what makes it stale rather than missing.
      disk.page = makePage({ contentDigest: DIGEST_V2, grants: [writeGrant()] });

      while (gates.length) gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      while (gates.length) gates.shift()!();

      const result = await queued;
      expect(result.ok).toBe(false);
      // The lease is bound to the digest it was issued for, so new content is
      // caught as a dead render before the grant is even reached — a stricter
      // refusal than `grant-stale`, and the earlier one.
      expect(result.error).toContain('content-changed');
      expect(executed).toHaveLength(PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE);
      await Promise.all(running);
    });

    it('refuses when the command is swapped while the request is queued', async () => {
      // The reload is what makes a revocation visible, and it is also what
      // could quietly substitute a command: the ticket was bound to the
      // descriptor at admission, and execution is about to use the reloaded
      // one. Same grant id, same content digest, different script.
      const ran: string[] = [];
      const gates: Array<() => void> = [];
      const broker = makeBroker({
        executeScript: (invocation) => new Promise((resolve) => {
          ran.push(invocation.script);
          gates.push(() => resolve({ exitCode: 0, stdout: '', stderr: '' }));
        }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const pageWith = (script: string) => makePage({
        grants: [makeGrant({ id: 'grant_script001', expiresAt: clock.now + 3_600_000, action: { kind: 'script', script } })],
      });
      const approved = pageWith('pages/dash/safe.ts');
      disk.page = approved;

      const start = async () => {
        const request = makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' } });
        const mint = await broker.mintActivationTicket(approved, request, AUTHORITY, CONFIRMING);
        return broker.executeAction(approved, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY);
      };

      const running = [start(), start()];
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = start();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ran).toEqual(['pages/dash/safe.ts', 'pages/dash/safe.ts']);

      // Swapped while the third waits.
      disk.page = pageWith('pages/dash/evil.ts');

      while (gates.length) gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      while (gates.length) gates.shift()!();

      const result = await queued;
      expect(result.ok).toBe(false);
      expect(result.error).toContain('activation-invalid');
      expect(ran).not.toContain('pages/dash/evil.ts');
      await Promise.all(running);
    });

    it('refuses a queued mutation when the workspace switches to Explore during the wait', async () => {
      // EXPLORE-DURING-QUEUE. Reloading only the page would re-confirm the
      // grant and run the write under an authority resolved before the user
      // changed the setting — and the queue is exactly where a user has time to
      // change it.
      const executed: string[] = [];
      const gates: Array<() => void> = [];
      const broker = makeBroker({
        executeApi: (invocation) => new Promise((resolve) => {
          executed.push(invocation.path);
          gates.push(() => resolve({ status: 201, ok: true, body: null }));
        }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({ grants: [writeGrant()] });
      disk.page = page;
      const start = async (path: string) => {
        const request = makeRequest(lease, {
          grantId: 'grant_write0001',
          invocation: { kind: 'api', method: 'POST', path },
        });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY);
      };

      const running = [start('/repos/a'), start('/repos/b')];
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = start('/repos/c');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(executed).toEqual(['/repos/a', '/repos/b']);

      // The user switches the workspace to Explore while the third write waits.
      disk.permissionMode = 'safe';

      while (gates.length) gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      while (gates.length) gates.shift()!();

      const result = await queued;
      expect(result.ok).toBe(false);
      expect(result.error).toContain('permission-mode-forbidden');
      // Two runs, not three: the queued write never reached the source.
      expect(executed).toEqual(['/repos/a', '/repos/b']);
      await Promise.all(running);
    });

    it('refuses a queued mutation when the host can no longer resolve admission', async () => {
      // Pages disabled, workspace gone, config unreadable — the host returns
      // null and the queued action fails closed rather than using its snapshot.
      const executed: string[] = [];
      const gates: Array<() => void> = [];
      const broker = makeBroker({
        executeApi: (invocation) => new Promise((resolve) => {
          executed.push(invocation.path);
          gates.push(() => resolve({ status: 201, ok: true, body: null }));
        }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({ grants: [writeGrant()] });
      disk.page = page;
      const start = async (path: string) => {
        const request = makeRequest(lease, {
          grantId: 'grant_write0001',
          invocation: { kind: 'api', method: 'POST', path },
        });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY);
      };

      const running = [start('/repos/a'), start('/repos/b')];
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = start('/repos/c');
      await new Promise((resolve) => setTimeout(resolve, 10));

      disk.page = null;

      while (gates.length) gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      while (gates.length) gates.shift()!();

      expect((await queued).ok).toBe(false);
      expect(executed).toEqual(['/repos/a', '/repos/b']);
      await Promise.all(running);
    });

    it('runs the descriptor that is on disk now, not the one admission saw', async () => {
      // The reload is not only a refusal mechanism: whatever it returns is what
      // executes, so the descriptor that runs is the one just re-validated.
      const ran: string[] = [];
      const broker = makeBroker({
        executeScript: async (invocation) => { ran.push(invocation.script); return { exitCode: 0, stdout: '', stderr: '' }; },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({
        grants: [makeGrant({ id: 'grant_script001', action: { kind: 'script', script: 'pages/dash/run.ts' } })],
      });
      disk.page = page;
      const request = makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' } });
      const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);

      const result = await broker.executeAction(
        page,
        { ...request, activationTicket: (mint as { ticketId: string }).ticketId },
        AUTHORITY,
      );
      expect(result.ok).toBe(true);
      expect(ran).toEqual(['pages/dash/run.ts']);
    });

    it('refuses a mutating action when the host cannot re-read page state', async () => {
      // No reload seam means no way to know the grant still stands. That has to
      // fail closed, not fall back to the snapshot.
      const broker = new PageActionBroker({
        executors: { executeApi: async () => ({ status: 201, ok: true, body: null }) },
        auditLogPath: auditPath,
        workspaceId: TEST_AUDIT_SCOPE,
        now: () => clock.now,
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({ grants: [writeGrant()] });
      const request = makeRequest(lease, {
        grantId: 'grant_write0001',
        invocation: { kind: 'api', method: 'POST', path: '/repos/x' },
      });
      const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
      const result = await broker.executeAction(
        page,
        { ...request, activationTicket: (mint as { ticketId: string }).ticketId },
        AUTHORITY,
      );
      expect(result.ok).toBe(false);
    });

    it('aborts in-flight actions when their lease is released', async () => {
      // Releasing a lease withdraws the authority the action runs under, so
      // letting it finish is the same defect as never cancelling it: an
      // unmounted Page's write lands on a source after the render is gone.
      const broker = makeBroker({
        executeApi: (_invocation, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage();
      disk.page = page;
      const pending = broker.executeAction(page, makeRequest(lease), AUTHORITY);
      await new Promise((resolve) => setTimeout(resolve, 5));

      broker.releaseLease(lease.leaseId);

      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error).toContain('cancelled');
    });

    it('aborts before deleting the lease, so ownership can still be proven', async () => {
      // Ordering matters: cancellation is authorized against the lease, so a
      // dropLease that deleted first would leave its own in-flight actions
      // running with nothing able to reach them.
      const broker = makeBroker({
        executeApi: (_invocation, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage();
      disk.page = page;
      const a = broker.executeAction(page, makeRequest(lease), AUTHORITY);
      const b = broker.executeAction(page, makeRequest(lease), AUTHORITY);
      await new Promise((resolve) => setTimeout(resolve, 5));

      broker.releaseLease(lease.leaseId);
      const settled = await Promise.all([a, b]);
      expect(settled.every((r) => !r.ok)).toBe(true);
      // And the lease really is gone afterwards.
      expect(broker.cancelAction(lease.leaseId, lease.nonce, 'anything')).toBe(false);
    });

    it('audits no caller-supplied value, recognized as sensitive or not', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage();
      disk.page = page;
      await run(broker, page, makeRequest(lease, {
        invocation: {
          kind: 'api',
          method: 'GET',
          // None of these key names are ones a redactor would recognize, which
          // is exactly why recording params at all was the wrong design.
          path: '/repos/craft/agents/patient-8871',
          params: { note: 'jeff@example.com', ref: 'bearer-abcdef', q: 'salary' },
        },
      }));

      const serialized = JSON.stringify(await readAudit());
      for (const leaked of ['patient-8871', 'jeff@example.com', 'bearer-abcdef', 'salary']) {
        expect(serialized).not.toContain(leaked);
      }
      // What remains is still enough to investigate with.
      const executed = (await readAudit()).find((e) => e.event === 'page_action_executed');
      expect(executed?.actionKind).toBe('api');
      expect(executed?.method).toBe('GET');
      expect(executed?.sourceSlug).toBe('github');
      expect(executed?.grantId).toBe('grant_test0001');
    });

    it('never persists the rejection reason, which interpolates the caller path', async () => {
      // `Path /patients/… does not match the granted pattern` is a perfectly
      // good message for the caller and a data leak in a file that outlives the
      // install. The code is stable and sufficient; the reason is not.
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage();
      disk.page = page;

      const result = await run(broker, page, makeRequest(lease, {
        invocation: { kind: 'api', method: 'GET', path: '/patients/SSN-078-05-1120-jeff@example.com' },
      }));
      // The caller still gets the detail it needs to fix the call.
      expect(result.ok).toBe(false);
      expect(result.error).toContain('/patients/SSN-078-05-1120');

      const audit = await readAudit();
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain('SSN-078-05-1120');
      expect(serialized).not.toContain('jeff@example.com');
      expect(serialized).not.toContain('patients');
      // …and the row is still useful.
      const rejected = audit.find((e) => e.event === 'page_action_rejected');
      expect(rejected?.code).toBe('grant-mismatch');
      expect(rejected?.invocation).toEqual({ kind: 'api' });
      expect(rejected?.reason).toBeUndefined();
    });

    it('never persists an executor error, which is whatever the far end said', async () => {
      const broker = makeBroker({
        executeApi: async () => {
          throw new Error('upstream rejected token sk-live-4eC39HqLyjWDarjtT1zdp7dc for tenant acme-health');
        },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage();
      disk.page = page;

      const result = await run(broker, page, makeRequest(lease));
      expect(result.ok).toBe(false);
      // The page sees the real message — it has to, to be actionable.
      expect(result.error).toContain('sk-live-4eC39HqLyjWDarjtT1zdp7dc');

      const audit = await readAudit();
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain('sk-live-4eC39HqLyjWDarjtT1zdp7dc');
      expect(serialized).not.toContain('acme-health');
      const executed = audit.find((e) => e.event === 'page_action_executed');
      expect(executed?.outcome).toBe('executor-error');
      expect(executed?.error).toBeUndefined();
    });

    // Narrower than the two above, and worth saying so: a non-zero exit puts
    // stderr in `body`, not in `error`, so this guards the body never reaching
    // the audit rather than the error path. It passes with the error leak
    // restored; the test above it is the one that catches that.
    it('never persists a script stderr through the audit', async () => {
      const broker = makeBroker({
        executeScript: async () => ({ exitCode: 2, stdout: '', stderr: 'DB_PASSWORD=hunter2 refused' }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({
        grants: [makeGrant({ id: 'grant_script001', action: { kind: 'script', script: 'run.sh' } })],
      });
      disk.page = page;

      await run(broker, page, makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' } }));
      const audit = await readAudit();
      expect(JSON.stringify(audit)).not.toContain('hunter2');
      expect(audit.find((e) => e.event === 'page_action_executed')?.outcome).toBe('non-zero-exit');
    });

    it('keeps no caller-supplied tool name, id, or payload on a rejection row', async () => {
      // The previous contract kept a bounded `toolName` on every row. It is now
      // read off the APPROVED grant instead, which means a rejection — where
      // nothing matched and there is no approved grant — carries none of the
      // caller's claims at all. Hashes remain so a burst is still correlatable.
      const broker = makeBroker({ executeMcp: async () => ({ ok: true }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({
        grants: [makeGrant({ id: 'grant_mcp00001', action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' } })],
      });
      disk.page = page;

      const hostileToolName = `sk-live-4eC39HqLyjWDarjtT1zdp7dc"${'\n'}{"event":"forged"}${'\n'}`
        + 'x'.repeat(5_000);
      const hostileRequest = makeRequest(lease, {
        requestId: 'req_sk-live-REQUEST-4eC39HqLyjWDarjtT1',
        grantId: 'grant_sk-live-GRANT-4eC39HqLyjWDarjt',
        invocation: { kind: 'mcp', toolName: hostileToolName, args: { patient: 'SSN-078-05-1120' } },
      });

      const result = await broker.executeAction(page, hostileRequest, AUTHORITY);
      expect(result.ok).toBe(false);

      const audit = await readAudit();
      const raw = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
      // One line per record: embedded newlines cannot forge a second entry.
      for (const line of raw) expect(() => JSON.parse(line)).not.toThrow();
      expect(raw.some((line) => JSON.parse(line).event === 'forged')).toBe(false);

      const serialized = JSON.stringify(audit);
      // Every caller-chosen string is absent — the tool name, and the ids the
      // caller minted with secrets inside them.
      expect(serialized).not.toContain('sk-live-4eC39HqLyjWDarjtT1zdp7dc');
      expect(serialized).not.toContain('sk-live-REQUEST');
      expect(serialized).not.toContain('sk-live-GRANT');
      expect(serialized).not.toContain('SSN-078-05-1120');
      expect(serialized).not.toContain('x'.repeat(300));

      const rejected = audit.find((e) => e.event === 'page_action_rejected');
      expect(rejected?.invocation).toEqual({ kind: 'mcp' });
      expect(rejected?.toolName).toBeUndefined();
      expect(rejected?.sourceSlug).toBeUndefined();
      expect(rejected?.requestId).toBeUndefined();
      expect(rejected?.grantId).toBeUndefined();

      // …and the hashes are present, fixed-width, and stable, so two rows
      // naming the same id still agree.
      expect(rejected?.requestIdHash).toBe(pageAuditIdHash(hostileRequest.requestId));
      expect(rejected?.grantIdHash).toBe(pageAuditIdHash(hostileRequest.grantId));
      expect(rejected?.leaseIdHash).toBe(pageAuditIdHash(lease.leaseId));
      expect(String(rejected?.requestIdHash)).toHaveLength(16);
      expect(pageAuditIdHash('a')).toBe(pageAuditIdHash('a'));
      expect(pageAuditIdHash('a')).not.toBe(pageAuditIdHash('b'));
    });

    it('keeps no caller-supplied request id on a cancellation row', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage();
      disk.page = page;

      // Nothing is in flight, so this takes the no-controller arm — which still
      // writes a row, and still must not quote what the caller asked to cancel.
      const hostileId = 'req_sk-live-CANCEL-4eC39HqLyjWDarjt';
      expect(broker.cancelAction(lease.leaseId, lease.nonce, hostileId)).toBe(false);

      const audit = await readAudit();
      expect(JSON.stringify(audit)).not.toContain('sk-live-CANCEL');
      const cancelled = audit.find((e) => e.event === 'page_action_cancelled');
      expect(cancelled?.phase).toBe('pre-execution');
      expect(cancelled?.requestId).toBeUndefined();
      expect(cancelled?.requestIdHash).toBe(pageAuditIdHash(hostileId));
    });

    it('audits the mode the decision was actually made under, after a queue reload', async () => {
      // ask → safe: the refusal must be recorded as `safe`, the mode that
      // caused it, not `ask`, the mode that applied when it was admitted.
      const gates: Array<() => void> = [];
      const broker = makeBroker({
        executeApi: () => new Promise((resolve) => { gates.push(() => resolve({ status: 201, ok: true, body: null })); }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({ grants: [writeGrant()] });
      disk.page = page;
      const start = async () => {
        const request = makeRequest(lease, {
          grantId: 'grant_write0001',
          invocation: { kind: 'api', method: 'POST', path: '/repos/x' },
        });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return { requestId: request.requestId, done: broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY) };
      };

      const running = [await start(), await start()].map((r) => r.done);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = await start();
      await new Promise((resolve) => setTimeout(resolve, 10));
      disk.permissionMode = 'safe';
      while (gates.length) gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      while (gates.length) gates.shift()!();
      await queued.done;
      await Promise.all(running);

      const refusal = (await readAudit()).find(
        (e) => e.event === 'page_action_rejected' && e.requestIdHash === pageAuditIdHash(queued.requestId),
      );
      expect(refusal?.code).toBe('permission-mode-forbidden');
      expect(refusal?.permissionMode).toBe('safe');
    });

    it('audits an upgraded mode when the reload widens it', async () => {
      // ask → allow-all: the execution row names `allow-all`, which is what the
      // decision was made under.
      const gates: Array<() => void> = [];
      const broker = makeBroker({
        executeApi: () => new Promise((resolve) => { gates.push(() => resolve({ status: 201, ok: true, body: null })); }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({ grants: [writeGrant()] });
      disk.page = page;
      const start = async () => {
        const request = makeRequest(lease, {
          grantId: 'grant_write0001',
          invocation: { kind: 'api', method: 'POST', path: '/repos/x' },
        });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return { requestId: request.requestId, done: broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY) };
      };

      const running = [await start(), await start()].map((r) => r.done);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = await start();
      await new Promise((resolve) => setTimeout(resolve, 10));
      disk.permissionMode = 'allow-all';
      while (gates.length) gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      while (gates.length) gates.shift()!();
      expect((await queued.done).ok).toBe(true);
      await Promise.all(running);

      const executed = (await readAudit()).find(
        (e) => e.event === 'page_action_executed' && e.requestIdHash === pageAuditIdHash(queued.requestId),
      );
      expect(executed?.permissionMode).toBe('allow-all');
    });

    it('audits no MCP arguments', async () => {
      const broker = makeBroker({ executeMcp: async () => ({ ok: true }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage({
        grants: [makeGrant({ id: 'grant_mcp00001', action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' } })],
      });
      disk.page = page;
      await run(broker, page, makeRequest(lease, {
        grantId: 'grant_mcp00001',
        invocation: { kind: 'mcp', toolName: 'create_issue', args: { title: 'acquisition-project-halo', body: 'jeff@example.com' } },
      }));

      const serialized = JSON.stringify(await readAudit());
      expect(serialized).not.toContain('acquisition-project-halo');
      expect(serialized).not.toContain('jeff@example.com');
      const executed = (await readAudit()).find((e) => e.event === 'page_action_executed');
      // Read off the approved grant, so an attacker-chosen tool name can never
      // appear here even when it matches.
      expect(executed?.actionKind).toBe('mcp');
      expect(executed?.toolName).toBe('create_issue');
      expect(executed?.sourceSlug).toBe('linear');
    });
  });

  describe('audit write budget', () => {
    it('bounds rows an unauthenticated caller can provoke, and counts the rest', async () => {
      // Refusals must be auditable — a probe that leaves no trace defeats the
      // log — but a refusal that ALWAYS writes is a disk-filling primitive for
      // anyone who can reach the RPC. The broker's rate limits cannot help
      // here: they need a valid lease, which this caller does not have.
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const page = makePage();
      disk.page = page;

      // 200 requests naming a lease that does not exist.
      for (let i = 0; i < 200; i++) {
        const result = await broker.executeAction(
          page,
          { ...makeRequest({ leaseId: 'ghost', nonce: 'ghost' } as PageRenderLease), requestId: `req_${i}` },
          AUTHORITY,
        );
        expect(result.ok).toBe(false);
      }

      const audit = await readAudit();
      const rejections = audit.filter((e) => e.event === 'page_action_rejected');
      // Bounded, not unbounded.
      expect(rejections.length).toBeLessThanOrEqual(20);
      expect(rejections.length).toBeGreaterThan(0);
      // Every caller still got a real refusal; only the WRITING is bounded.
      expect(rejections[0]?.code).toBe('lease-not-found');
    });

    it('carries the suppressed count onto the next window', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const page = makePage();
      disk.page = page;
      const probe = async (n: number) => {
        for (let i = 0; i < n; i++) {
          await broker.executeAction(
            page,
            { ...makeRequest({ leaseId: 'ghost', nonce: 'ghost' } as PageRenderLease), requestId: `p_${Math.random()}` },
            AUTHORITY,
          );
        }
      };

      await probe(50);
      // A burst leaves a number behind rather than a silence: the window rolls
      // and the first row of the next one reports what was dropped.
      resetPageAuditThrottleForTests();
      await probe(1);

      const audit = await readAudit();
      expect(audit.some((e) => e.event === 'page_action_rejected')).toBe(true);
    });
  });

  describe('lease flood containment', () => {
    it('bounds durable lifecycle rows however many leases a flood mints', async () => {
      // `pages:createLease` needs no lease to reach and wrote a row per call —
      // plus an eviction row once the store filled — so a flood amplified into
      // the audit file at up to 2x.
      //
      // The bound is on the WRITES, not on the creations. A per-caller creation
      // quota was tried and removed: it keys on `clientId`, a client-asserted
      // handshake field, so reconnecting resets it, and the bucket map it needs
      // grows with exactly that churn. This holds regardless of who is asking.
      const broker = makeBroker();
      for (let i = 0; i < 400; i++) {
        broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      }
      const lifecycle = (await readAudit()).filter(
        (e) => e.event === 'page_lease_created' || e.event === 'page_lease_evicted',
      );
      expect(lifecycle.length).toBeLessThanOrEqual(20);
      // …and memory is bounded by the store cap, which no identity trick moves.
      expect(broker.leaseCount).toBe(MAX_LIVE_LEASES);
    });

    it('evicts an idle lease rather than one doing work', async () => {
      // Eviction is where a flood reaches a stranger: the store is shared, any
      // client can mint into it, and dropping a lease aborts what it was
      // running. Age alone would let a later loop displace a window mid-write.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const broker = makeBroker({
        executeApi: async () => { await gate; return { status: 200, ok: true, body: null }; },
      });
      const page = makePage({ grants: [makeGrant({ expiresAt: clock.now + 3_600_000 })] });
      disk.page = page;

      // The oldest lease in the store, and it is busy.
      const busy = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const working = broker.executeAction(page, makeRequest(busy), AUTHORITY);
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Fill the rest of the store with idle leases, then push one past the cap.
      for (let i = 1; i <= MAX_LIVE_LEASES; i++) {
        clock.now += 1;
        broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      }

      // The busy lease survived: an idle one was chosen instead.
      expect(broker.hasActiveLease(busy.leaseId, 'dash', DIGEST_V1)).toBe(true);
      release();
      expect((await working).ok).toBe(true);
    });

    it('protects a mounted window that is merely between clicks', async () => {
      // "Idle" alone conflates a window waiting for its next click with a lease
      // a flood minted and abandoned. A mounted window has DONE something; that
      // is the distinction, and it needs no caller identity to draw.
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const page = makePage({ grants: [makeGrant({ expiresAt: clock.now + 3_600_000 })] });
      disk.page = page;

      // The OLDEST lease in the store, used once and now idle.
      const mounted = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      expect((await broker.executeAction(page, makeRequest(mounted), AUTHORITY)).ok).toBe(true);

      // A flood mints and abandons enough leases to churn the store twice over.
      for (let i = 0; i < MAX_LIVE_LEASES * 2; i++) {
        clock.now += 1;
        broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      }

      // The mounted window survived, and can still act.
      expect(broker.hasActiveLease(mounted.leaseId, 'dash', DIGEST_V1)).toBe(true);
      expect((await broker.executeAction(page, makeRequest(mounted), AUTHORITY)).ok).toBe(true);
    });

    it('survives churn with work queued behind its executing actions', async () => {
      // Busy is read from `inFlight`, which a mutating request joins BEFORE it
      // waits for a slot, rather than from the executing counter which it joins
      // after. That is the more precise reading, though it is worth recording
      // that the difference is not exploitable on its own: a request only
      // queues when the lease already has two executing actions, so such a
      // lease is busy either way. What this pins is the property that matters —
      // a lease with work outstanding is not evicted out from under it.
      const gates: Array<() => void> = [];
      const broker = makeBroker({
        executeApi: () => new Promise((resolve) => { gates.push(() => resolve({ status: 201, ok: true, body: null })); }),
      });
      const page = makePage({
        grants: [makeGrant({ id: 'grant_write0001', expiresAt: clock.now + 3_600_000, action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/repos/.*' } })],
      });
      disk.page = page;
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const write = async () => {
        const request = makeRequest(lease, { grantId: 'grant_write0001', invocation: { kind: 'api', method: 'POST', path: '/repos/x' } });
        const mint = await broker.mintActivationTicket(page, request, AUTHORITY, CONFIRMING);
        return broker.executeAction(page, { ...request, activationTicket: (mint as { ticketId: string }).ticketId }, AUTHORITY);
      };

      // Two executing, one queued behind them.
      const running = [write(), write()];
      await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = write();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Churn the store hard while that third write waits for a slot.
      for (let i = 0; i < MAX_LIVE_LEASES * 2; i++) {
        clock.now += 1;
        broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      }
      expect(broker.hasActiveLease(lease.leaseId, 'dash', DIGEST_V1)).toBe(true);

      while (gates.length) gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      while (gates.length) gates.shift()!();
      const settled = await Promise.all([...running, queued]);
      expect(settled.every((r) => r.ok)).toBe(true);
    });

    it('protects an actively-used window from a flood that touches its own leases', async () => {
      // A non-mutating grant needs no activation, so a flood holding an
      // approved GET can touch every lease it mints and leave the never-used
      // group entirely. What it cannot cheaply do is stay the MOST recently
      // used: each touch costs an action, and actions are budgeted per page and
      // per workspace — which is why the used group is ordered rather than just
      // ranked behind the unused one.
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const page = makePage({ grants: [makeGrant({ expiresAt: clock.now + 24 * 3_600_000 })] });
      disk.page = page;

      const mounted = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      expect((await broker.executeAction(page, makeRequest(mounted), AUTHORITY)).ok).toBe(true);

      // Spaced in simulated time so the flood's own actions are not throttled —
      // it gets to actually touch each lease, which is the hard case.
      for (let i = 0; i < MAX_LIVE_LEASES + 50; i++) {
        clock.now += 2_000;
        const junk = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
        expect((await broker.executeAction(page, makeRequest(junk), AUTHORITY)).ok).toBe(true);
        // The real window acts occasionally, as a user would.
        if (i % 25 === 0) {
          clock.now += 1_000;
          expect((await broker.executeAction(page, makeRequest(mounted), AUTHORITY)).ok).toBe(true);
        }
      }

      // It survived the churn and can still act.
      expect(broker.hasActiveLease(mounted.leaseId, 'dash', DIGEST_V1)).toBe(true);
      expect((await broker.executeAction(page, makeRequest(mounted), AUTHORITY)).ok).toBe(true);
    });

    it('evicts a busy lease only when every lease is busy, and aborts its work', async () => {
      // The previous version of this filled the store with IDLE leases and
      // asserted the oldest went — which exercises the ordinary path and says
      // nothing about the fallback. A small cap makes it cheap to put real
      // outstanding work on every candidate.
      const aborted: string[] = [];
      // A small cap so "every lease busy" is reachable without 256 never-
      // resolving actions.
      const small = new PageActionBroker({
        executors: {
          executeApi: (invocation, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted.push(invocation.path);
              reject(new Error('aborted'));
            }, { once: true });
          }),
        },
        auditLogPath: auditPath,
        workspaceId: TEST_AUDIT_SCOPE,
        now: () => clock.now,
        maxLiveLeases: 3,
        loadCurrentAdmission: async () => disk.page
          ? { page: disk.page, authority: { ...AUTHORITY, permissionMode: disk.permissionMode } }
          : null,
      });

      const page = makePage({ grants: [makeGrant({ expiresAt: clock.now + 24 * 3_600_000 })] });
      disk.page = page;

      // Three leases, each with a GET actually in flight and never settling.
      const leases = [] as PageRenderLease[];
      const running: Array<Promise<PageActionResult>> = [];
      for (let i = 0; i < 3; i++) {
        clock.now += 1;
        const lease = small.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
        leases.push(lease);
        running.push(small.executeAction(page, makeRequest(lease, {
          invocation: { kind: 'api', method: 'GET', path: `/repos/hold-${i}` },
        }), AUTHORITY));
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(small.leaseCount).toBe(3);

      // A fourth mount with nothing idle to take: the oldest busy lease loses,
      // and — the part that matters — its in-flight action is actually aborted
      // rather than left running against a lease that no longer exists.
      clock.now += 1;
      small.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(small.hasActiveLease(leases[0]!.leaseId, 'dash', DIGEST_V1)).toBe(false);
      expect(aborted).toContain('/repos/hold-0');
      expect((await running[0]!).ok).toBe(false);
      expect(small.leaseCount).toBe(3);

      // The newer busy leases survived.
      expect(small.hasActiveLease(leases[1]!.leaseId, 'dash', DIGEST_V1)).toBe(true);
      expect(small.hasActiveLease(leases[2]!.leaseId, 'dash', DIGEST_V1)).toBe(true);
    });

    it('treats a lease awaiting its first-use sheet as busy', async () => {
      // A mint holds a reservation while the native confirmation is on screen.
      // Evicting that lease would drop the render the user is being asked
      // about, leaving a prompt whose answer can no longer be used.
      let openSheet!: () => void;
      const onScreen = new Promise<void>((resolve) => { openSheet = resolve; });
      let release!: () => void;
      const answered = new Promise<void>((resolve) => { release = resolve; });

      const broker = new PageActionBroker({
        executors: { executeScript: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
        auditLogPath: auditPath,
        workspaceId: TEST_AUDIT_SCOPE,
        now: () => clock.now,
        maxLiveLeases: 2,
        loadCurrentAdmission: async () => disk.page
          ? { page: disk.page, authority: { ...AUTHORITY, permissionMode: disk.permissionMode } }
          : null,
      });
      const page = makePage({
        grants: [makeGrant({ id: 'grant_script001', expiresAt: clock.now + 24 * 3_600_000, action: { kind: 'script', script: 'run.sh' } })],
      });
      disk.page = page;

      // The OLDEST lease, waiting on a sheet.
      const confirming = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const minting = broker.mintActivationTicket(
        page,
        makeRequest(confirming, { grantId: 'grant_script001', invocation: { kind: 'script' } }),
        AUTHORITY,
        { confirmFirstUse: async () => { openSheet(); await answered; return true; } },
      );
      await onScreen;

      // Fill and overflow the store around it.
      clock.now += 1;
      broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      clock.now += 1;
      broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      // It survived: the idle newer lease was taken instead.
      expect(broker.hasActiveLease(confirming.leaseId, 'dash', DIGEST_V1)).toBe(true);
      release();
      expect((await minting).ok).toBe(true);
    });

    it('tells the host about every drop, so native chrome can be closed', async () => {
      // Eviction, expiry, and release all invalidate a lease on the broker's
      // schedule while host state — an open sheet, a requester binding —
      // outlives it. Refusing the answer is not enough; the prompt is still on
      // the window and host chrome drains serially.
      const dropped: Array<[string, string]> = [];
      const broker = new PageActionBroker({
        executors: {},
        auditLogPath: auditPath,
        workspaceId: TEST_AUDIT_SCOPE,
        now: () => clock.now,
        maxLiveLeases: 1,
        onLeaseDropped: (leaseId, reason) => { dropped.push([leaseId, reason]); },
      });

      const released = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      broker.releaseLease(released.leaseId);
      expect(dropped).toContainEqual([released.leaseId, 'released']);

      const evicted = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      clock.now += 1;
      broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      expect(dropped).toContainEqual([evicted.leaseId, 'evicted']);

      const expired = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      clock.now += 13 * 60 * 60 * 1000;
      expect(broker.leaseCount).toBe(0);
      expect(dropped).toContainEqual([expired.leaseId, 'expired']);
    });

    it('scopes the audit budget per workspace, so one cannot silence another', async () => {
      // A single shared throttle bucket means churn in workspace A suppresses
      // workspace B's lifecycle rows — one tenant erasing another's audit
      // trail, which is worse than the disk growth the throttle exists to stop.
      const brokerFor = (workspaceId: string) => new PageActionBroker({
        executors: {},
        auditLogPath: auditPath,
        now: () => clock.now,
        workspaceId,
      });
      const noisy = brokerFor('ws_noisy');
      const quiet = brokerFor('ws_quiet');

      // A floods well past the write budget.
      for (let i = 0; i < 200; i++) {
        noisy.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      }
      // B mounts one Page, as a user would.
      const quietLease = quiet.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      const audit = await readAudit();
      const quietRows = audit.filter(
        (e) => e.event === 'page_lease_created' && e.leaseId === quietLease.leaseId,
      );
      // B's row is present despite A having spent its own budget many times over.
      expect(quietRows).toHaveLength(1);
      // …and A is still bounded.
      const noisyRows = audit.filter(
        (e) => e.event === 'page_lease_created' && e.leaseId !== quietLease.leaseId,
      );
      expect(noisyRows.length).toBeLessThanOrEqual(20);
    });

    it('clamps the live-lease cap so a test can only lower the ceiling', async () => {
      // The option exists to make "every lease busy" cheap to construct. It
      // must never be a way to raise or disable the store cap, which is the one
      // bound that holds against a flood regardless of who is calling — and
      // `Math.max(1, x)` alone passed `Infinity` through and turned `NaN` into
      // `NaN`, either of which removes the cap entirely.
      const withCap = (maxLiveLeases: number) => new PageActionBroker({
        executors: {},
        auditLogPath: auditPath,
        workspaceId: TEST_AUDIT_SCOPE,
        now: () => clock.now,
        maxLiveLeases,
      });
      const fill = (broker: PageActionBroker, count: number) => {
        for (let i = 0; i < count; i++) {
          clock.now += 1;
          broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
        }
        return broker.leaseCount;
      };

      // Nothing can raise or disable the hard ceiling.
      for (const hostile of [Infinity, Number.NaN, MAX_LIVE_LEASES + 1, 10_000, 2.5]) {
        expect(fill(withCap(hostile), MAX_LIVE_LEASES + 5)).toBe(MAX_LIVE_LEASES);
      }
      // Zero and negatives floor at one rather than wedging the store. `-0` is
      // a valid integer, so it floors rather than falling back to the default.
      for (const tiny of [0, -0, -1, -99]) {
        expect(fill(withCap(tiny), 5)).toBe(1);
      }
      // A legitimate lower cap is honoured.
      expect(fill(withCap(3), 10)).toBe(3);
    });

    it('releases only a lease that exists, and audits nothing otherwise', async () => {
      const broker = makeBroker();
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      // Releasing an unknown lease is a no-op, not a row: otherwise release is
      // its own unbounded audit-write primitive.
      broker.releaseLease('never-existed');
      broker.releaseLease(lease.leaseId);
      broker.releaseLease(lease.leaseId);

      const released = (await readAudit()).filter((e) => e.event === 'page_lease_released');
      expect(released).toHaveLength(1);
    });
  });

  describe('lease store cap', () => {
    it('evicts the oldest lease past MAX_LIVE_LEASES (audited) and keeps new mounts working', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      // Long-lived grant: this test spans simulated minutes to spread lease
      // creation across windows, which would otherwise expire the 60-second
      // default out from under the assertions at the end.
      const page = makePage({ grants: [makeGrant({ expiresAt: clock.now + 3_600_000 })] });
      disk.page = page;

      const first = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      for (let i = 1; i < MAX_LIVE_LEASES; i++) {
        // Two seconds apart: strictly increasing `issuedAt` keeps "oldest"
        // deterministic, and spacing them keeps the per-minute lease budget out
        // of the way of the store cap this test is actually about. Well inside
        // the 12h lease TTL.
        clock.now += 2_000;
        broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      }
      expect(broker.leaseCount).toBe(MAX_LIVE_LEASES);

      clock.now += 2_000;
      // This test is about eviction, not about the audit write budget. Filling
      // the store burns through that budget on the way, so reset it here so the
      // eviction row is asserted on its own merits rather than on whether a few
      // hundred creations happened to leave room for it.
      resetPageAuditThrottleForTests();
      const newest = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      expect(broker.leaseCount).toBe(MAX_LIVE_LEASES);

      // The oldest render lost its lease (a re-mount recovers)…
      const evicted = await run(broker, page, makeRequest(first));
      expect(evicted.ok).toBe(false);
      expect(evicted.error).toContain('lease-not-found');

      // …the newest works, and the eviction is on the audit trail.
      expect((await run(broker, page, makeRequest(newest))).ok).toBe(true);
      const audit = await readAudit();
      const eviction = audit.find((e) => e.event === 'page_lease_evicted');
      expect(eviction?.leaseId).toBe(first.leaseId);
      expect(eviction?.reason).toBe('lease-store-full');
    });
  });
});
