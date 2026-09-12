/**
 * The one definition of "does this authority hold this grant for this call".
 *
 * Page actions arrive on two paths that share almost everything and differ in
 * exactly one thing: a rendered Page acts through a lease, and a cron tick has
 * no render at all. Before this module each path answered the shared question
 * separately — the broker in `validate()`, the scheduler in its own sequence of
 * checks — which is how a laxer answer gets into the background path without
 * anyone noticing, because nothing forces the two to agree.
 *
 * So the shared question lives here, pure and synchronous, and both callers ask
 * it. What is genuinely render-specific — lease, nonce, replay, activation
 * ticket, first-use confirmation — stays layered on top in the broker, where it
 * belongs. The split is not "expensive checks vs cheap ones"; it is "true of
 * every invocation" vs "true only when a render made it".
 *
 * Pure and browser-safe: no IO, no clock of its own, no state. The caller
 * supplies `now` so a test can move time without the primitive knowing.
 */

import type {
  PageActionAuthority,
  PageActionGrant,
  PageActionInvocation,
  PageConfig,
} from '@craft-agent/core';
import {
  hasPathTraversal,
  isMutatingPageAction,
  pageActionOriginAllowsKind,
  pageActionOriginPolicy,
} from './types.ts';

export type PageAdmissionErrorCode =
  | 'origin-unattributed'
  | 'origin-forbidden'
  | 'permission-mode-forbidden'
  | 'workspace-mismatch'
  | 'content-missing'
  | 'grant-not-found'
  | 'grant-stale'
  | 'grant-expired'
  | 'grant-mismatch'
  | 'grant-pattern-invalid'
  | 'invocation-path-unsafe';

export type PageAdmissionOutcome =
  | { ok: true; grant: PageActionGrant; mutating: boolean }
  | { ok: false; code: PageAdmissionErrorCode; reason: string };

export interface PageAdmissionInput {
  page: PageConfig;
  grantId: string;
  /** For the scheduled path this is the bare `{ kind: 'script' }` trigger. */
  invocation: PageActionInvocation;
  authority: PageActionAuthority;
  now: number;
}

/**
 * Decide whether this authority may run this invocation under this grant.
 *
 * Ordered so a caller learns as little as possible before it has proven the
 * right to ask: origin and workspace first, because an unattributed caller must
 * not discover whether a page or grant even exists.
 */
export function authorizePageAction(input: PageAdmissionInput): PageAdmissionOutcome {
  const { page, grantId, invocation, authority, now } = input;

  const originPolicy = pageActionOriginPolicy(authority?.origin);
  if (!originPolicy) {
    return { ok: false, code: 'origin-unattributed', reason: 'Page actions require a host-declared origin' };
  }
  if (!authority.workspaceId) {
    return { ok: false, code: 'workspace-mismatch', reason: 'Page actions require a resolved workspace' };
  }

  if (!page.contentDigest) {
    return { ok: false, code: 'content-missing', reason: 'Page has no content digest' };
  }

  const grant = page.grants?.find((candidate) => candidate.id === grantId);
  if (!grant) {
    return { ok: false, code: 'grant-not-found', reason: `No grant ${grantId} on this page` };
  }
  if (grant.contentDigest !== page.contentDigest) {
    return { ok: false, code: 'grant-stale', reason: 'Grant was approved for older page content — re-approval required' };
  }
  if (now > grant.expiresAt) {
    return { ok: false, code: 'grant-expired', reason: 'Grant expired — re-approval required' };
  }

  const mismatch = invocationMismatch(grant, invocation);
  if (mismatch) return mismatch;

  if (!pageActionOriginAllowsKind(authority.origin, grant.action.kind)) {
    return {
      ok: false,
      code: 'origin-forbidden',
      reason: `A ${authority.origin} action may not run a ${grant.action.kind} grant`,
    };
  }

  // Classify from the GRANT, not the invocation. They agree by here — the
  // mismatch check proved the kinds match, and api method equality with them —
  // so reading the approved descriptor means the privileged/unprivileged
  // decision is made against what the user consented to rather than what the
  // caller sent.
  const mutating = isMutatingPageAction(grant.action);

  // Explore is read-only across the product and a Page is not an exception. Its
  // position last is deliberate: it is the only check whose answer can change
  // without anything about the page or grant changing, so callers re-run this
  // whole primitive rather than caching its verdict.
  if (mutating && authority.permissionMode === 'safe') {
    return { ok: false, code: 'permission-mode-forbidden', reason: 'Explore mode does not run mutating page actions' };
  }

  return { ok: true, grant, mutating };
}

/** Check a concrete invocation against the grant's approved descriptor. */
function invocationMismatch(
  grant: PageActionGrant,
  invocation: PageActionInvocation,
): Extract<PageAdmissionOutcome, { ok: false }> | null {
  if (grant.action.kind !== invocation.kind) {
    return {
      ok: false,
      code: 'grant-mismatch',
      reason: `Grant allows ${grant.action.kind} actions, request is ${invocation.kind}`,
    };
  }

  if (grant.action.kind === 'api' && invocation.kind === 'api') {
    if (grant.action.method !== invocation.method) {
      return {
        ok: false,
        code: 'grant-mismatch',
        reason: `Grant allows ${grant.action.method}, request is ${invocation.method}`,
      };
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
      return {
        ok: false,
        code: 'grant-mismatch',
        reason: `Grant allows tool ${grant.action.toolName}, request is ${invocation.toolName}`,
      };
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
