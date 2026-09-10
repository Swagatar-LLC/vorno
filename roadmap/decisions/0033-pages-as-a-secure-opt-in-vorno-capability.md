---
id: ADR-0033
title: Pages as a secure, opt-in Vorno capability
status: proposed
date: 2026-09-10
supersedes: []
superseded-by: []
---

# ADR-0033 — Pages as a secure, opt-in Vorno capability

## Context

Upstream v0.13.x adds a useful local Pages surface: `pages:*`, a
`pages/{slug}` store, and the `craft-pages/v1` bridge. The upstream capability
model already has digest-bound grants, leases/nonces, replay defence, path
containment, and a no-shell script runner. It is not sufficient unchanged for
Vorno: a token-holding client can currently bypass renderer-only consent,
activation, and mutating-action checks through direct RPC; session callbacks do
not exist; Pages sharing points at Craft infrastructure; and sharing defaults
on.

The fork has one relevant precedent. ADR-0021 makes declared intent—not a
transport assertion—the authoritative gate for session mutation. RPC client and
`webContentsId` claims are not a security tier. Pages must use the same rule,
not invent a second privilege vocabulary.

A published Page is a new user-data service, not documentation. The existing
`share.vorno.ai` design deliberately serves inert JSON; accepting HTML there
would defeat its core safety property. `vorno.ai/privacy` is currently absent,
so operating a Pages publication service without a privacy/retention decision
would contradict ADR-0024's stated cutover gate.

## Decision

**Vorno adopts upstream Pages additively, but exposes it only as a
per-workspace opt-in whose privileged actions and publication path are enforced
by Vorno-owned, host-authoritative boundaries.**

1. **Compatibility and availability.** Preserve upstream `pages:*`,
   `pages/{slug}`, and `craft-pages/v1` unchanged; these coexist with a future
   MCP Apps surface rather than replacing it. `defaults.pages.enabled` is
   persisted per workspace and defaults to `false`. One host-side gate covers
   RPC, tools, scheduler, broker, desktop, and WebUI; delete, unpublish, and
   revoke remain available in either state for cleanup.

2. **One declared-intent authority.** Introduce `PageActionOrigin` with an
   unattributed default that cannot mutate. Move the mutating classifier into a
   shared module and classify from the grant descriptor: only `api GET` is
   non-mutating; non-GET API, MCP, script, and session are mutating. The broker
   validates origin, lease, nonce, page/digest, grant, expiry, replay, rate,
   workspace containment, and cancellation ownership for every action.

3. **Host-issued interaction proof.** A broker mints a random activation ticket
   bound to lease and content digest, with a five-second TTL, one redemption,
   and at most three outstanding tickets per lease. Script and session grants
   additionally require a host-rendered first-use confirmation per render;
   their target, action, arguments, and any message body are pinned at approval.
   Page content never supplies an executable scope or callback payload.

   **Unverified premise and safe branch.** It is unverified whether a click in
   the opaque `srcDoc` iframe grants usable parent-window activation, and even
   if it does, it does not prove that the click landed in the frame. After the
   merge, run the bounded Electron experiment before relying on that signal. If
   it fails or is ambiguous, use a trusted host-click path for the affected
   operation or reject it; do not weaken host enforcement or claim frame proof.

4. **Session callbacks stay inside existing choke points.** The `session`
   descriptor is a bare trigger with a user-approved, digest-bound target and
   pinned body. Its executor uses the existing session-action checks,
   `SessionManager` mutators, workspace membership check, and outcome producer.
   It declares `{ kind: 'page', pageSlug, grantId }` to ADR-0021's origin gate;
   pages can never close a session and receive no `allowClosed` escape hatch.

5. **Capabilities are finite and observable.** Grants have type-specific,
   clamped TTLs; revocation is immediate; leases expire sooner than upstream's
   default; and content changes invalidate grants and outstanding tickets.
   Per-lease replay, in-flight keys scoped by lease, lease/page/workspace rate
   limits, lease-bound cancellation, timeout, rejection, execution, and result
   are audit logged without credentials or sensitive payloads.

6. **Vorno operates Page sharing separately.** `workers/pages/` is a separate
   Worker on `pages.vorno.ai` with its own `vorno-pages` R2 bucket, admin-token
   namespace, and deployment credentials. The client publishes only to a strict
   Vorno origin allowlist (plus explicit development localhost), while update
   and unpublish derive an existing publication's HTTPS origin from its stored
   URL so old/stored publications remain revocable. The Worker serves an opaque
   sandboxed `src` iframe, strict per-document CSP, no privileged bridge actions,
   size/rate/password controls, hashed admin tokens, no-store responses, and
   immediate object deletion on unpublish. The precise claim is **no scripted
   network egress** (`connect-src 'none'`); frame self-navigation is a named
   residual, not an erased risk.

7. **Privacy, docs, and release are gates, not follow-ups.** Privacy policy and
   retention are pre-deploy requirements. Proposed default pending Jeff: keep
   content until unpublish, delete objects immediately on unpublish, and retain
   operational logs no longer than 30 days. No Pages Worker deploys if either is
   unanswered. Bundled Pages docs remain the source consumed by both in-app and
   online publishing; a missing docs-manifest grouping is a build failure.
   `0.22.0-beta.1` must be a GitHub prerelease, keep `latest-mac.yml`, and only
   tag after the vorno-site prerelease-tag PR has merged.

8. **Sentry is explicit non-scope.** Sentry already ships unchanged since this
   merge base. This program preserves it as a no-op and records a separate owner
   telemetry/privacy decision rather than treating merge resolution as consent.

## Consequences

### Positive

- Pages remains wire-compatible and available for local use without silently
  enabling it for every workspace.
- Direct RPC, WebUI, and desktop paths share host-side privilege checks instead
  of trusting renderer-only policy.
- Scripts and session callbacks are useful without permitting agent-authored
  content to choose executable scope, session targets, or message payloads.
- Sharing moves user content from Craft infrastructure to a reviewable,
  Vorno-operated implementation with distinct blast radius and revocation.
- Privacy, documentation, and prerelease correctness become release gates with
  named owners rather than post-ship cleanup.

### Negative

- First-use confirmation adds friction for script and session grants, and
  activation behavior needs an explicit Electron experiment.
- Vorno becomes the data-service operator for published Pages, including abuse,
  deletion, retention, and legal/privacy obligations.
- Strict publish allowlisting intentionally rejects arbitrary endpoint overrides;
  stored-origin unpublish/update must keep careful HTTPS validation.
- The `pages.vorno.ai` subdomain still has brand-phishing/reputation risk. A
  separate registrable domain is reconsidered at the first abuse report or
  credential-collection use.

### Neutral

- `craft-pages/v1`, `pages:*`, `CRAFT_PAGES_SHARE_API_URL`, and the existing
  Pages storage layout remain Craft-named compatibility contracts.
- Upstream Sentry remains as it was; this ADR neither enables nor disables it.
- Retention duration and any separate-domain move remain owner gates, not
  hidden configuration defaults.

## Alternatives considered

- **Take upstream Pages unchanged.** Rejected: renderer-only activation and
  consent leave direct RPC as a privilege bypass; sharing defaults to Craft.
- **Make Pages display-only.** Rejected: approved program scope requires useful
  script and session callbacks; removing them avoids rather than designs the
  security boundary.
- **Treat desktop renderer or WebUI transport as trusted.** Rejected: clients
  holding the token can forge the routing/capability claims. Declared intent at
  the host choke point is the existing safe vocabulary.
- **Put Page HTML on `share.vorno.ai` or the marketing origin.** Rejected:
  `share.vorno.ai` depends on inert JSON and the apex couples untrusted HTML to
  first-party site deployment. A separate Worker, bucket, and host are earned
  isolation.
- **Use parent `navigator.userActivation` as frame proof.** Rejected pending
  the experiment: even a positive activation signal is app-window freshness,
  not proof of an iframe click.

## References

- [PLAN-052 — Ship upstream Pages securely in Vorno](../plans/in-progress/PLAN-052-ship-upstream-pages-securely-in-vorno.md)
- [PLAN-053 — Customize workspace navigation after Pages](../plans/planned/PLAN-053-customize-workspace-navigation-after-pages.md)
- [ADR-0021 — Gate session-mutating automation actions on declared intent](0021-session-actions-gated-by-declared-intent.md)
- [ADR-0024 — Vorno hosts its own shared sessions](0024-vorno-hosts-its-own-shared-sessions.md)
- `260910-witty-raven` — Pages callback security design
- `260910-silver-leaf` — Pages sharing and Cloudflare architecture
- `260910-strong-valley` — navigation feasibility
- `260910-wild-pond` — Pages documentation and branding inventory
- `260910-strong-poplar` — prerelease delivery semantics
