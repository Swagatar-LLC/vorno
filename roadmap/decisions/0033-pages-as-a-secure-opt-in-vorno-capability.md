---
id: ADR-0033
title: Pages as a secure, opt-in Vorno capability
status: accepted
date: 2026-09-10
supersedes: []
superseded-by: []
---

# ADR-0033 — Pages as a secure, opt-in Vorno capability

## Context

Upstream v0.13.x adds a local Pages surface: `pages:*`, a `pages/{slug}` store,
and the `craft-pages/v1` bridge. Its capability model already has grants,
leases/nonces, replay defence, path containment, and a no-shell script runner.
Vorno must not trust renderer-only consent, activation, or mutating-action
checks: a token-holding client can otherwise call RPC directly. Upstream sharing
also defaults on and points to Craft infrastructure.

ADR-0021 establishes declared intent—not a client transport assertion—as the
authoritative gate for session mutation. RPC client and `webContentsId` claims
are not a security tier. Pages uses that rule rather than inventing a second
privilege vocabulary.

A published Page is a user-data service, not documentation. The existing
`share.vorno.ai` design deliberately serves inert JSON; accepting HTML there
would defeat that property. Privacy and retention must therefore be resolved
before this distinct service is deployed.

## Decision

**Vorno adopts upstream Pages additively, but exposes it only as a
per-workspace opt-in whose privileged actions and publication path are enforced
by Vorno-owned, host-authoritative boundaries.**

1. **Compatibility and availability.** Preserve the upstream storage and
   bridge contracts—`pages/{slug}` and `craft-pages/v1`—and preserve
   non-privileged `pages:*` behavior. `defaults.pages.enabled` is persisted per
   workspace and defaults to `false`. Sharing also defaults to `false`, may be
   enabled only by that workspace, and is unavailable without a verified
   backend capability. One host-side Pages gate covers RPC, tools, scheduler,
   broker, desktop, and WebUI; delete, unpublish, and grant revocation remain
   available for cleanup.

2. **One declared-intent authority and consented grants.** Introduce
   `PageActionOrigin` with an unattributed default that cannot mutate. The
   mutating classifier is shared and descriptor-based: only `api GET` is
   non-mutating; non-GET API, MCP, script, and session are mutating. The host
   alone handles additive `pages:requestGrant`, renders the approval, and
   persists a grant only after consent. Direct `pages:issueGrant` requests are
   refused. This is the named, sanctioned wire-behavior divergence for
   privileged grant issuance; it does not alter the compatible storage or
   bridge contracts. A declined, disconnected, or unanswered request leaves no
   grant. The broker revalidates origin, permission mode, lease, nonce,
   page/digest, grant, expiry, replay, rate, workspace containment, and
   cancellation ownership on every invocation.

3. **Host-issued interaction proof.** A broker mints a short-lived, single-use
   activation ticket bound to lease and content digest. Script and session
   grants also require host-rendered first-use confirmation per render; their
   target, action, arguments, and any message body are pinned at approval.
   Page content never supplies executable scope or callback payload. Ticket
   lifetime, outstanding-ticket limit, grant TTL ceilings, and confirmation
   presentation are implementation policy with conservative initial defaults,
   not owner gates or immutable ADR constants.

   **Unverified premise and safe branch.** It is unverified whether a click in
   the opaque `srcDoc` iframe grants usable parent-window activation, and even
   if it does, it does not prove that the click landed in the frame. The bounded
   Electron experiment must be run and recorded before relying on that signal.
   If it fails or is ambiguous, use a trusted host-click path for the affected
   operation or reject it; do not weaken host enforcement or claim frame proof.

4. **Pinned session callbacks stay inside existing choke points.** A `session`
   descriptor is a bare trigger with a user-approved, digest-bound target and
   pinned body. Its executor uses the shared, workspace-contained target
   resolver, existing session-action checks, `SessionManager` mutators, and
   the canonical outcome producer; that resolver also protects the existing
   webhook path. It declares `{ kind: 'page', pageSlug, grantId }` to
   ADR-0021's origin gate. Pages can never close a session and receive no
   `allowClosed` escape hatch.

5. **Capabilities are finite, managed, and observable.** Grants have
   type-specific clamped TTLs, immediate revocation, and a user-visible
   listing/management surface; content changes invalidate grants and
   outstanding tickets. Per-lease replay, in-flight keys scoped by lease,
   lease/page/workspace rate limits, lease-bound cancellation, timeout,
   rejection, execution, and result are audit logged without credentials or
   sensitive payloads. Recurring refresh execution must use a user-approved,
   declared grant and undergo the same invocation checks.

6. **Vorno operates Page sharing separately.** `workers/pages/` is a separate
   Worker on `pages.vorno.ai` with its own `vorno-pages` R2 bucket,
   admin-token namespace, and deployment credentials. Publishing scans for
   secrets, includes snapshots only by explicit opt-in, and targets only a
   strict Vorno origin allowlist (plus explicit development localhost).
   Update and unpublish derive an existing publication's HTTPS origin from its
   stored URL so old publications remain revocable; deletion failures surface
   best-effort warnings. The Worker serves a Vorno-branded public shell with a
   persistent disclaimer that a page is published by a Vorno user, not by
   Vorno, an opaque sandboxed `src` iframe, strict per-document CSP, no
   privileged bridge actions, size/rate/password controls, hashed admin tokens,
   no-store responses, and immediate object deletion on unpublish. The precise
   claim is **no scripted network egress** (`connect-src 'none'`); frame
   self-navigation is a named residual, not an erased risk.

7. **Privacy is a release gate.** Privacy policy and a Jeff-approved retention
   decision are required before Worker deployment. The proposed retention
   policy remains pending Jeff: retain content until unpublish, delete objects
   immediately on unpublish, and retain operational logs for at most 30 days.
   The site policy and deployment prerequisite must land before the Worker.
   PLAN-052 owns the release/tag consequence of an unresolved policy.

## Consequences

### Positive

- Pages remains locally available without silently enabling it for every
  workspace or sending content to an unavailable or Craft-owned service.
- Direct RPC, WebUI, and desktop paths share host-side consent and privilege
  checks rather than trusting renderer-only policy.
- Scripts and callbacks are useful without permitting page-authored scope,
  targets, or payloads, and grant management remains with the user.
- Sharing is isolated, branded honestly, reviewable, and revocable.

### Negative

- First-use confirmation adds friction and activation behavior requires an
  explicit Electron experiment.
- Vorno becomes the data-service operator for published Pages, including abuse,
  deletion, retention, and legal/privacy obligations.
- Strict publication allowlisting intentionally rejects arbitrary endpoints;
  stored-origin update/unpublish needs careful HTTPS validation.

### Neutral

- `craft-pages/v1`, `pages/{slug}`, `CRAFT_PAGES_SHARE_API_URL`, and the
  existing Pages storage layout remain Craft-named compatibility contracts.
- Ticket and TTL numeric defaults may change through implementation policy
  without reopening this architecture decision.
- Retention duration remains the sole owner gate for the sharing release path.

## Alternatives considered

- **Take upstream Pages unchanged.** Rejected: renderer-only consent leaves
  direct RPC as a privilege bypass and sharing defaults to Craft.
- **Make Pages display-only.** Rejected: the approved program requires useful
  scripts and session callbacks; removing them avoids rather than designs the
  security boundary.
- **Trust desktop renderer or WebUI transport.** Rejected: token-holding
  clients can forge routing/capability claims. Declared intent at the host choke
  point is the established safe vocabulary.
- **Keep direct `pages:issueGrant`.** Rejected: a client could persist a
  capability without host-rendered user consent.
- **Put Page HTML on `share.vorno.ai` or the marketing origin.** Rejected:
  `share.vorno.ai` depends on inert JSON and the apex couples untrusted HTML to
  first-party site deployment.
- **Use parent `navigator.userActivation` as frame proof.** Rejected pending
  the experiment: a positive activation signal is app-window freshness, not
  proof of an iframe click.

## References

- [PLAN-052 — Ship upstream Pages securely in Vorno](../plans/in-progress/PLAN-052-ship-upstream-pages-securely-in-vorno.md)
- [PLAN-053 — Customize workspace navigation after Pages](../plans/planned/PLAN-053-customize-workspace-navigation-after-pages.md)
- [ADR-0021 — Gate session-mutating automation actions on declared intent](0021-session-actions-gated-by-declared-intent.md)
- [ADR-0024 — Vorno hosts its own shared sessions](0024-vorno-hosts-its-own-shared-sessions.md)
