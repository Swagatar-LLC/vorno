---
id: ADR-0025
title: Vorno-owned OAuth redirect relay — allowlist-not-open-redirector, tiered by deployment
status: proposed
date: 2026-08-17
supersedes: []
superseded-by: []
---

# ADR-0025 — Vorno-owned OAuth redirect relay — allowlist-not-open-redirector, tiered by deployment

## Context

Vorno brokers source OAuth for a local client. Two of its three OAuth paths route the
authorization response through a **hosted relay** whose redirect URI is fixed at the
provider and whose real callback target is carried back in the request state:

- **WebUI generic path** (Google, Microsoft, generic OAuth, MCP): the real callback
  (`${origin}/api/oauth/callback`) is packed into an outer `state` envelope
  `ca1.<base64url({ v, r:returnTo, s:innerState })>` and the provider-facing `redirect_uri`
  is pinned to `OAUTH_RELAY_CALLBACK_URL` (`packages/shared/src/auth/oauth-relay.ts:40,77`;
  `packages/shared/src/sources/credential-manager.ts:414`). The relay decodes `r` and
  forwards the code there.
- **Slack path** (always — Slack rejects `http://localhost` redirect URIs): the relay
  redirect carries only a localhost **port** (`?port=N`), and forwards to
  `http://localhost:{port}/callback` (`packages/shared/src/auth/slack-oauth.ts:270,361`).
- **Plain desktop path** goes straight to an RFC 8252 loopback listener and never touches
  the relay (`packages/shared/src/auth/callback-server.ts:32`).

Today both relay endpoints point at **upstream's** infrastructure —
`OAUTH_RELAY_CALLBACK_URL` / `SLACK_OAUTH_RELAY_CALLBACK_URL` derive from
`SERVICE_BASE_URL = 'https://agents.craft.do'` (`packages/core/src/branding.ts:68,96,97`).
PLAN-023 Phase 2 requires Vorno to own them; ADR-0013 decision 2e carries the unsigned-state
relay transit as a named zero-trust gap (SEC-004).

**The vulnerability.** In our tree, `decodeOAuthRelayState` validates only that `returnTo`
is a non-empty string — no scheme, host, or allowlist check
(`packages/shared/src/auth/oauth-relay.ts:49`). The actual forwarding decision lives in
upstream's Worker, which we cannot see and have no reason to believe validates `returnTo`.
An endpoint that forwards an authorization code to an attacker-influenceable URL is an
**open redirector that leaks OAuth codes** — exactly what RFC 9700 §4.11 and
draft-ietf-oauth-v2-1 §7.12 say a compliant endpoint MUST NOT be. PKCE (used by Google/MS/
generic/MCP; verifier held server-side, never transiting the relay) substantially de-risks
a *code* leak in a server-initiated flow, but does not make the relay safe to be a
general-purpose open redirector: an attacker who initiates their own public-client flow
holds their own verifier and can use Vorno's trusted relay to launder a consent-phishing
attack (the class RFC 10027 / BCP 247, Aug 2026, addresses). **Slack is worse**: no PKCE,
and a build-time baked-in shared client **secret** (`slack-oauth.ts:28-29`) — a stolen Slack
code is redeemable by anyone who extracts that secret; its only saving grace is the
localhost-only forwarding template.

Constraints: the relay must stay a stateless, cheap Cloudflare Worker (Workers Free: 10 ms
CPU/req); users register their own OAuth apps for Google/generic/MCP (so the redirect URI is
theirs to update); Vorno sessions are increasingly reached remotely (WebUI over a tailnet,
Electron against a remote server — PLAN-022 / PLAN-023), so a localhost-only design will not
survive. All new surface is additive under `vorno:*` (ADR-0012).

Full threat model, per-option trade-offs, and source citations live in the session decision
brief `oauth-relay-security-design.md` (session 260817-sunny-galaxy `data/`, not in-repo).

## Decision

**Vorno runs its own OAuth redirect relay, on its own origin, that refuses to be an open
redirector: it forwards an authorization code only to a `returnTo` that is either loopback
or an origin pre-registered for the requesting instance — never a wildcard, never a raw URL
trusted from the wire.** The design is tiered by deployment shape.

1. **Own origin, isolated blast radius.** The relay is a dedicated Worker at
   **`auth.vorno.ai`**, separate from the marketing apex and from the session-share backend
   (ADR-0024). An endpoint that handles authorization codes in query strings must not share
   an origin with static or user-submitted content. (Same own-origin argument ADR-0023 made
   for docs, stronger here.)

2. **The relay is not an open redirector.** It forwards a code only when the resolved
   `returnTo` is:
   - **(a) loopback** — host ∈ {`localhost`, `127.0.0.1`, `[::1]`}, **any port** allowed
     (RFC 8252 §7.3); safe because PKCE covers the local-port-race leak, or
   - **(b) a registered origin** — an exact origin previously registered for this
     instance's `instanceId` (ADR-0013 decision 5).

   No wildcard suffixes (`*.ts.net` is rejected — it would forward to any tenant on a shared
   apex). Exact-match only (RFC 9700 §4.1.3).

3. **Registered origins are carried as a relay-signed binding, not a raw URL.** For the
   non-loopback remote case, the state envelope carries a **relay-issued HMAC-SHA256 token**
   binding `(instanceId, origin)`, minted at a registration step and verified in-Worker
   (well under the 10 ms budget). The relay is the **only** key holder — no shared secret is
   distributed to clients (the failure mode already afflicting the Slack client secret). Key
   rotation uses a `kid` two-key verify window so outstanding bindings survive a rotation.
   Sign, do not encrypt — `returnTo` is not secret, it must only be un-forgeable.

4. **The verifier never transits the relay.** The PKCE `code_verifier` stays in the
   server-side flow store and is presented only at token exchange
   (`packages/server-core/src/handlers/rpc/oauth.ts`). The relay must never be handed
   anything that lets it redeem a code. (Already true; made a standing invariant.)

5. **Slack is a constrained special case, twice.** Immediately: the Slack relay forwards to
   **localhost only** and rejects any off-loopback port target. Separately and as a target
   state: move Slack off the **build-baked shared client secret** toward user-registered
   Slack apps — that secret is the single most exposed credential in the tree and is a
   problem independent of the relay. Microsoft's baked-in `client_id` (PKCE, no secret in
   the read path) gets the same "should this be user-registered?" question at lower
   priority.

6. **This is PLAN-023 Phase 2's relay sub-decision, not a standalone build.** The registered-
   origin allowlist is populated by the **same pairing/registration flow PLAN-023 Phase 0
   designed** for connecting a client to a hosted instance, keyed on the existing opaque
   `instanceId`. One registration ceremony, two consumers. Adopting this ADR discharges
   ADR-0013's SEC-004.

7. **OIDC / Workload Identity Federation is explicitly out of scope for the relay.** The
   relay answers "may this code go here," not "who is this principal." The account-level
   feature this introduces is a **callback-origin registry**, not an identity provider.
   Multi-user AuthN stays where ADR-0013 (decisions 2a–2d) put it: the HTTP redirect edge,
   never the relay. Nothing in the relay may become a path to unlock the vault (ADR-0013
   decision 4b, auth ≠ decryption).

## Consequences

### Positive

- The open redirector is closed for every path: desktop has no relay, Slack is
  localhost-scoped, remote is registered-origin-only. Satisfies RFC 9700 §4.11 /
  draft-oauth-v2-1 §7.12.
- Vorno stops depending on `agents.craft.do` for source auth — removes the hidden coupling
  and trust leak PLAN-023 Risk "OAuth redirect ownership" and ADR-0013 SEC-004 named.
- The relay holds no client-redeemable secret and no long-term user data beyond a small
  origin registry; a relay compromise leaks in-flight codes for *registered* origins only,
  and PKCE blunts even that for the public-client paths.
- Registration reuses `instanceId` and the PLAN-023 pairing surface — no second notion of
  "which origins may receive this instance's tokens."

### Negative

- Users who registered their own OAuth app against the old `agents.craft.do/auth/callback`
  **must add the new Vorno callback** to their app's authorized redirect URIs. Mitigated by
  a dual-registration window (ship new relay, keep old working, then flip the branding
  constant); existing tokens are unaffected, only re-auth.
- The remote tier adds a registration step and relay-side state (KV; registration is rare,
  1,000 writes/day free tier is ample) — more than a pure-localhost product needs, carried
  because the remote future requires it.
- Provisioning is Jeff-gated. The workspace `cloudflare` source token *reads* account state
  from Jeff's network (Lane F listed R2 buckets 2026-08-17), but **no agent has an
  unattended deploy path** — `wrangler whoami` is unauthenticated and standing up a public
  auth endpoint is Jeff's call. What Jeff must create for this lane, to consolidate with Lane
  F's `share.vorno.ai` list (ADR-0024 / PLAN-035) into one ask:

  | # | Thing | Notes |
  |---|---|---|
  | 1 | Worker `vorno-auth-relay` + `auth.vorno.ai` custom domain | custom domain auto-creates the DNS record; separate Worker/origin from apex and from `share.vorno.ai` |
  | 2 | HMAC signing key as a Worker secret | for the remote-tier binding tokens (decision 3); `kid`-tagged for rotation |
  | 3 | KV namespace for the callback-origin registry | remote tier only; registration is rare (1,000 writes/day free is ample) |
  | 4 | `CLOUDFLARE_API_TOKEN` for deploys | shared blocker with Lane F — `wrangler` not authenticated today |
  | 5 | A privacy policy at `vorno.ai/privacy` | **blocks cutover** — see below; shared with Lane F |
- Moving user auth traffic onto Swagatar infrastructure makes Swagatar LLC the data
  controller for it; `vorno.ai` has no privacy policy / terms today. A cutover prerequisite,
  raised in ADR-0024 and referenced here.

### Neutral

- Key rotation is a live operational concern once binding tokens exist; the `kid` window
  keeps it non-breaking but must be documented.
- The relay could later adopt RFC 8628 device flow for providers that support it, further
  shrinking the redirect surface for headless cases — out of scope here, noted as a door.

## Migration & resource-stranding analysis

LEARNING-057 (vorno-internal, filed by Lane F 2026-08-17) names the trap: **a branding/
endpoint constant is the address of a *service*, never the address of a *resource*.**
Flipping `VIEWER_URL` in the share lane aimed live operations at a new backend for objects
that still lived on the old one — a green typecheck, test suite, and branding gate, and a
user's transcript stranded publicly-readable forever. Lane F flagged that the OAuth case is
*potentially worse*, because a redirect URI is registered **with the provider**, so old
addresses are referenced by more than local state. That warning was correct to raise, and I
answered its three diagnostic questions against the code rather than by assertion. The
verified conclusion: **for this lane the cutover is clean** — the relay is a service address
transited during a stateless leg, not a resource address. Evidence:

1. **What already exists at the old (`agents.craft.do`) address?** Registered redirect URIs
   inside users' *own* OAuth apps (Google / generic / MCP) and Vorno's own apps (Slack /
   Microsoft); ephemeral in-flight flows in the server flow store; and stored access/refresh
   tokens in the vault.
2. **Is each one's address persisted, or only an opaque id?** The relay callback is **not
   persisted as a resource address that later operations target.** Stored tokens reference
   the *provider's* token/API endpoints, never the relay. The redirect URI is persisted only
   for the lifetime of a single flow, as `flow.redirectUri` in the flow store — not as a
   durable property of any credential.
3. **Which call sites mutate an existing resource rather than create one?** **None address
   the relay by URL to mutate a resource** — Lane F's stranding-shape grep (a `${...URL}`
   interpolation followed by a `${...Id}` in the same template literal) returns **zero
   matches** in this lane. Token exchange *replays* `redirect_uri`, but resolves it from the stored flow
   (`flow.redirectUri`, `packages/server-core/src/handlers/rpc/oauth.ts:55`), **not from the
   constant** — so a flow that began before a flip still exchanges correctly after it. Token
   **refresh** carries no `redirect_uri` at all (`grant_type=refresh_token` + client creds;
   verified in `google-oauth.ts:207`, `generic-oauth.ts:162`, `slack-oauth.ts` refresh) —
   **stored tokens do not reference the relay and survive the flip untouched.**

This is why the cutover looks like ADR-0023's *stateless* docs flip, not Lane F's stateful
share flip: no resource is created against the relay address. The two real obligations that
remain:

- **Re-authorization needs the new URI registered** in each user's own OAuth app
  (Google/generic/MCP) — the only user-visible migration. Handled by the **dual-registration
  window**: stand up `auth.vorno.ai`, let users add it alongside the old URI, then flip
  `OAUTH_RELAY_CALLBACK_URL`. Users who *replace* rather than *add* strand their own in-flight
  auths until they re-add — call this out in migration docs.
- **The old relay must stay reachable through the flow-completion window**, because a flow
  whose auth request already went out points the provider's browser redirect at the *old*
  origin. This is the transit-leg equivalent of "keep the old backend alive during cutover" —
  bounded by the flow store's short TTL (minutes), not by resource lifetime. **The exposure
  is not a window we can size — it is a dependency on upstream's uptime for a deprecated
  host.** The old relay is `agents.craft.do`, which upstream promises only "during the
  transition"; it already moved `agents.craft.do → thecraftagents.com` and deleted the docs
  MCP in a single release, with no deprecation signal we can observe. So the accurate risk
  statement is not "an in-flight flow might fail for N minutes" but "an in-flight flow fails
  whenever upstream retires the host, and we learn it from users." Because the flow-completion
  window is genuinely short (minutes), **the honest mitigation is brevity, not a guarantee**:
  keep the window small and accept it; we have neither a contract nor a deprecation signal to
  make it safe.

**Shared cross-lane risk (raised with Lane F / ADR-0024).** This lane's residual exposure and
the session-share lane's are the *same* underlying risk seen from two sides: **for the
deprecated half of each migration we depend on a third party's uptime we do not control and
cannot close.** Here, in-flight auths complete only while Craft keeps serving the relay;
there, existing shares resolve only while Craft keeps serving `VIEWER_URL`. Neither lane can
fix it from inside its own design. That is the strongest argument for executing *both*
migrations sooner rather than later, and Jeff should see it as one risk, not two footnotes.

Slack/Microsoft (Vorno-owned apps) need **no user action** — Vorno adds the new URI to its
own app config — *unless* Slack also moves to per-user apps (decision 5), a separate opt-in
migration.

## Alternatives considered

- **Kill the relay entirely; each deployment registers its own origin (n8n / RFC 8252
  model).** The most standards-pure option and the desktop default. Rejected as the *whole*
  answer because it forces a per-origin redirect-URI registration for every remote shape
  (localhost, tailnet, hosted = up to three), fails the zero-config product ruling for
  remote access, and still leaves Slack (HTTPS-only) needing a relay. Folded in as the
  desktop tier of the decision.
- **Stateless relay with a static wildcard allowlist (`localhost` + `*.ts.net`).** Simple,
  no per-user state. Rejected: a `*.ts.net` wildcard forwards codes to *any* tailnet host on
  the internet — still an open redirector, scoped to one apex. Exact registered origins
  only.
- **Sign a raw `returnTo` with a client-held key.** Rejected: distributing a signing key to
  every Vorno install makes it not-secret — the exact failure mode of the current Slack
  client secret. The relay must be the sole key holder.
- **Encrypt the envelope.** Rejected: `returnTo` needs integrity, not confidentiality; HMAC
  is sufficient and cheaper.
- **OIDC / WIF at the relay.** Rejected as miscategorized: it authenticates principals, not
  callback destinations. Reserved for multi-user AuthN at the HTTP edge per ADR-0013.

## References

- Decision brief with full threat model + citations:
  `sessions/260817-sunny-galaxy/data/oauth-relay-security-design.md`
- PLAN-023 — Hosted Workspace Server (Phase 2 owns this; lines 41, 118–123, Risks).
- ADR-0013 — hosted-workspace AuthN/AuthZ (SEC-004 discharged here; `instanceId` decision 5;
  auth ≠ decryption decision 4b).
- LEARNING-057 (vorno-internal) — flipping an endpoint constant strands resources created
  against the old one; the diagnostic answered in the migration analysis above.
- ADR-0023 — Vorno owns its documentation endpoint (own-origin precedent).
- ADR-0024 (session 260817-windy-vista, Lane F) — own-origin share backend; privacy-policy
  prerequisite; consolidated provisioning ask.
- ADR-0012 — additive `vorno:*` namespace.
- PLAN-022 — WebUI remote access / `tailscale serve` origin.
- RFC 9700 §4.1 / §4.5 / §4.11 (open redirectors, code injection, exact-match) —
  https://www.rfc-editor.org/rfc/rfc9700.html
- RFC 8252 §7.3 / §8.4 (loopback, exact-match) — https://www.rfc-editor.org/rfc/rfc8252.html
- RFC 7636 (PKCE) — https://www.rfc-editor.org/rfc/rfc7636.html
- draft-ietf-oauth-v2-1-15 §7.12 (open redirectors) —
  https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-15
- RFC 10027 / BCP 247 (cross-device consent phishing) —
  https://www.rfc-editor.org/info/rfc10027/
- Code: `packages/shared/src/auth/{oauth-relay,slack-oauth,callback-server}.ts`,
  `packages/shared/src/sources/credential-manager.ts`, `packages/core/src/branding.ts`.
