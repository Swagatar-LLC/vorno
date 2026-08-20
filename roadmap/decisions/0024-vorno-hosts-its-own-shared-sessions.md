---
id: ADR-0024
title: Vorno hosts its own shared sessions; VIEWER_URL splits from SERVICE_BASE_URL
status: proposed
date: 2026-08-17
supersedes: []
superseded-by: []
---

# ADR-0024 — Vorno hosts its own shared sessions; `VIEWER_URL` splits from `SERVICE_BASE_URL`

## Context

[ADR-0023](0023-vorno-owns-its-documentation-endpoint.md) split `DOCS_URL` out of
`SERVICE_BASE_URL` and deliberately left the other three constants alone. Its table said
why:

| Constant | What it is | Can Vorno own it? |
|---|---|---|
| `DOCS_URL` | Product documentation | **Yes — content is already ours** |
| `VIEWER_URL` | Shared-session backend | *Only by building a share backend* |
| `OAUTH_RELAY_CALLBACK_URL` | OAuth redirect relay | Only by running a relay + re-registering every OAuth app |
| `SLACK_OAUTH_RELAY_CALLBACK_URL` | Same, Slack-specific | Same |

This ADR reverses that scope **for `VIEWER_URL` only**, because the thing it was waiting
on — "building a share backend" — turned out to be a Worker, a bucket, and about 150
lines. The OAuth constants stay put; that is ADR-0025's
problem, and its cost (re-registering every provider app) is genuinely different in kind.

### What sharing does today

`SessionManager.ts` has four call sites against `${VIEWER_URL}/s/api`:

| Route | Body | Auth |
|---|---|---|
| `POST /s/api` | the entire `StoredSession` | **none** |
| `GET /s/api/:id` | — | none |
| `PUT /s/api/:id` | the entire `StoredSession` | **none** |
| `DELETE /s/api/:id` | — | **none** |

`VIEWER_URL` is `SERVICE_BASE_URL` is `https://agents.craft.do`. So the shipped product's
**Share online** button takes the user's complete transcript — every message, every tool
call, every file the agent read, every API response it got back — serialises it, and
`POST`s it unauthenticated to storage operated by the upstream project. We then hand the
user a URL and tell them, correctly, that the link is the only access control.

We published exactly that on [vorno.ai/docs/sharing](https://vorno.ai/docs/sharing/)
tonight, including the sentence "It is **not operated by Swagatar, LLC**, and the data
does not pass through infrastructure we run." That page is honest and it is the reason
this decision got pulled forward: a product whose charter leads with privacy should not
have its single publish button pointed at a third party's bucket.

Three further facts shape the design rather than just motivating it:

1. **We already own the front-end.** `apps/viewer` is a Vite/React SPA in this repo. It
   builds with `base: '/s/'` and fetches `/s/api/{id}` **same-origin, relative**. So
   whatever serves the API must also serve the viewer. This is a backend and a routing
   decision, not a new product.
2. **`PUT` and `DELETE` are unauthenticated and keyed only on the share id.** The id is
   in the URL the user deliberately forwards to other people. So under the current
   protocol, *any recipient of a share link can silently replace its contents or delete
   it*. Reproducing that on our own domain would mean shipping an endpoint where a
   stranger can host arbitrary content at a `vorno.ai` URL that the owner vouched for.
3. **Old links are not ours to break.** Every share created before the cutover lives on
   Craft's infrastructure. Those URLs must keep working, and — the part that is easy to
   miss — must stay **revocable**.

## Decision

**Vorno hosts its own shared sessions.** `VIEWER_URL` splits out of `SERVICE_BASE_URL`
the same way `DOCS_URL` did in ADR-0023, and points at a Cloudflare Worker on the
Swagatar Cloudflare account backed by R2.

1. `VIEWER_URL = 'https://share.vorno.ai'`, independent of `SERVICE_BASE_URL`.
2. A new Worker, `vorno-share`, serves the built `apps/viewer` SPA **and** the four API
   routes from one origin, because the viewer's fetch is relative and must stay that way.
3. Transcripts are stored as objects in an R2 bucket, `vorno-shares`.
4. Share ids are **128 bits** of `crypto.getRandomValues`, base64url — 22 characters.
5. `PUT` and `DELETE` require an **edit token** minted at create time and never present
   in the share URL.
6. `SERVICE_BASE_URL` keeps its value and narrows again: it now means *the OAuth relay*,
   and nothing else.

### Storage: R2, not KV

Both were live options; the deciding facts are measured, not aesthetic (all verified
against Cloudflare's docs on 2026-08-17):

| | Workers KV free | R2 free |
|---|---|---|
| Max value size | **25 MiB** | effectively unbounded |
| Writes | **1,000 / day** | 1M Class A ops / month (~33k/day) |
| Reads | 100,000 / day | 10M Class B ops / month |
| Storage | 1 GB | 10 GB-month |
| Consistency | **eventual** | strong read-after-write |
| Egress | — | free |

Any one of the first three rows would be enough. A transcript is JSON of unbounded-ish
size, so a 25 MiB hard ceiling is a wall we would hit on real sessions and could not
raise. 1,000 writes/day is a create+update budget small enough to exhaust by accident.

But the row that actually settles it is **consistency**. KV is eventually consistent: a
user who clicks *Share online* and immediately opens the link they were just handed can
get a 404. That is not a scaling limit you grow into, it is a broken feature on day one
for the single most common interaction. R2 is strongly read-after-write consistent.

R2 also gives retention for free: **object lifecycle rules** express "delete objects
older than N days" natively, and lifecycle deletions are not billed as operations. The
expiry policy below is therefore one bucket rule, not application code that has to be
written, scheduled, and monitored.

### Share ids are 128-bit random

The docs page says the link is the access control, so the id **is** the credential. 16
bytes from `crypto.getRandomValues`, base64url-encoded to 22 characters. This is not
a place to be clever: anything sequential, timestamp-derived, or short enough to sweep
makes every user's transcript enumerable by anyone with a loop, and the failure is
silent and total. 128 bits is the boring correct answer and costs nothing.

It also has to match the viewer's existing route regex, `^/s/([a-zA-Z0-9_-]+)$` —
base64url does, which is why it beats hex at equal entropy (22 chars vs 32).

### Unauthenticated `POST` is the risk; four things bound it

Create must stay unauthenticated — there is no account system, and inventing one to gate
a share button is a far larger decision than this. So the exposure is accepted and
bounded rather than removed:

- **Size cap, 8 MB.** `Content-Length` is required and checked before any write; missing
  or over ⇒ `413`. The client already renders `413` as "Session file is too large to
  share", so this reuses an error path that exists and is already user-tested.
- **Rate limit, 5 creates per 60s per IP**, via the Workers rate-limit binding. Cloudflare
  documents this as per-colo and permissive, so it is a burst brake, not an accounting
  system — it is stated that way here so nobody later mistakes it for a quota.
- **Expiry.** Objects are deleted 180 days after they are written. This bounds total
  storage, and it means abandoned shares stop being our liability on a schedule instead
  of accumulating forever.
- **Reads are always `application/json` with `X-Content-Type-Options: nosniff`.** The
  store can therefore never serve HTML, script, or an image. This is the specific thing
  that stops the endpoint being used as a free CDN or a phishing host on a `vorno.ai`
  domain: whatever an attacker uploads, a browser will only ever receive it as inert
  JSON.

**Retention is a policy choice, not a config value.** 180 days is a proposal. It trades a
real user expectation ("my link still works") against a real obligation (we are holding
other people's transcripts). Whatever number ships has to appear on the docs page,
because a share silently evaporating is worse than one that was documented as temporary.
Jeff owns the number.

### Edit tokens

`POST` returns `{ id, url, editToken }`. The client persists `editToken` in session
metadata beside `sharedId`, and sends it as `Authorization: Bearer` on `PUT`/`DELETE`.
The token never appears in the share URL, so forwarding a link grants read and only read.

This is a **deliberate divergence from upstream's protocol**, and it is additive: the
extra response field and the extra header are both ignored by a server that does not know
them, so the client keeps working against Craft's backend for old shares. Per
`roadmap/upstream/compatibility.md` the wire contract we owe upstream is the one on the
`craft-fork:*` / `craft_sk_*` surfaces; this is a service API we now operate ourselves on
our own domain, and reproducing a flaw for symmetry's sake is not compatibility.

### Old shares keep working — and keep being revocable

The subtle failure. `updateShare`, `revokeShare`, and the revoke-on-delete path all build
their URL as `${VIEWER_URL}/s/api/${sharedId}`. Flip `VIEWER_URL` and those three
suddenly aim at *our* backend for shares that live on *Craft's* — so every pre-existing
share 404s on revoke, the UI reports "Failed to revoke share", and the user's transcript
stays public on someone else's infrastructure **with no way to take it down from inside
the app**.

So the API base for an existing share is derived from its stored `sharedUrl`, not from
the constant. `VIEWER_URL` is used only to *create*. Old shares continue to be read,
updated and revoked at Craft; new shares are ours. This is six lines and it is the whole
back-compatibility story, but getting it wrong converts a link migration into a privacy
incident, so it is called out here rather than left to the plan.

### A separate origin, unlike `/docs`

ADR-0023 put docs on the existing `vorno.ai` Worker and argued a subdomain "buys nothing
here and costs real moving parts." Same test, different answer, because the input is
different: docs are static, first-party, same-trust content. **Shares are untrusted
content submitted by anyone with the URL of a `POST` endpoint.**

Putting that on the apex would host attacker-supplied bytes on the same origin as the
marketing site, the download page, and anything with a cookie on `vorno.ai` later. It
would also couple a user-data service to a Worker that redeploys on every release to
publish documentation. The viewer additionally builds with `base: '/s/'` and needs
`/s/*` routed to an SPA, which collides with the site's static-asset pipeline.

A Workers custom domain creates its own DNS record, so `share.vorno.ai` costs one binding
— not the "second pipeline" ADR-0023 was rejecting. The reasoning there was *don't add
moving parts that buy nothing*; here isolation is the thing being bought.

## Consequences

### Positive

- The publish button stops sending user transcripts to a third party. The claim that
  Vorno is privacy-respecting becomes checkable on the one feature where it was not.
- Sharing stops depending on a domain upstream is actively migrating off. Upstream moved
  `agents.craft.do` → `thecraftagents.com` and deleted its docs MCP server in a single
  release; `/s/api` has no stronger guarantee than `/docs` did.
- A share link can no longer be used by its recipients to overwrite or delete the share.
  We are shipping something better than what we inherited, not just relocated.
- Cost is $0 on documented free tiers, with the first cliff and its price named below.

### Negative

- **Swagatar LLC becomes the data controller for user transcripts.** This is the real
  cost of the decision and it is not technical. Today we can accurately tell a user the
  data never touches our infrastructure. After this, we are the operator: subject access,
  deletion requests, law-enforcement requests, breach notification, and retention are
  ours. **`vorno.ai` currently has no privacy policy** — `/privacy`, `/terms` and
  `/legal` all return 404 (checked over real HTTP, 2026-08-17). Publishing one is a
  prerequisite for cutover, not a follow-up, and it is Jeff's call as the company.
- **We now operate an unauthenticated public write endpoint.** The mitigations above
  bound it; they do not eliminate it. Someone determined can still burn our free tier.
  The failure mode is a service outage for a non-critical feature, which is the right
  thing to be exposed to, but it is a new pager surface that did not exist before.
- The docs page has to be rewritten in the same change. Half of "Where it goes" becomes
  false the moment this ships, and a privacy disclosure that is stale in the reassuring
  direction is worse than none.
- One more piece of infrastructure to deploy, verify, and remember on release day.

### Neutral

- `SERVICE_BASE_URL` now means only the OAuth relay. When ADR-0025 lands, the constant
  can be deleted outright.
- The share URL shape stays `/s/{id}`, matching upstream and the viewer's existing route
  regex, so neither the SPA nor the client's URL parsing changes.
- Old `agents.craft.do/s/…` links keep working because Craft keeps serving them. If
  upstream retires that host, those shares break and we cannot fix it — which is the
  status quo, and an argument for this change rather than against it.

### Cost, with the cliff named

All free-tier figures verified against Cloudflare's published limits on 2026-08-17.

| Resource | Free allowance | What consumes it |
|---|---|---|
| R2 storage | 10 GB-month | live shares × transcript size |
| R2 Class A | 1M / month | creates + updates |
| R2 Class B | 10M / month | reads |
| Workers requests | **100,000 / day** | every hit: HTML, JS, CSS, API |
| Workers CPU | 10 ms / invocation | see below |

At a realistic 200 KB–1 MB per transcript, 10 GB holds roughly **10,000–50,000 live
shares**; at the 8 MB cap it still holds 1,280. The R2 operation ceilings are not
reachable by this feature at any plausible scale.

**The first cliff is Workers' 100,000 requests/day**, and it is shared with nothing else
because this is its own Worker. A share page view costs about 5–8 requests (document,
JS, CSS, the API fetch), so it is roughly **12,000–20,000 share views per day**. Crossing
it costs **$5/month** for Workers Paid, which includes 10M requests and 30M CPU-ms, with
overage at $0.30/M requests. R2 beyond free is $0.015/GB-month, $4.50/M Class A,
$0.36/M Class B.

Expected spend: **$0.** Nothing here needs authorising before the fact; the point of
stating the numbers is that the cliff is a step to $5, not a surprise bill.

**The 10 ms CPU-per-invocation limit is a design constraint, not a footnote.** Parsing
and re-serialising a multi-megabyte transcript inside the Worker would exceed it. The
request body is therefore streamed straight into R2 and never parsed. That is why
validation is limited to `Content-Length` and content type: shape-validating the JSON is
not affordable at the free CPU budget, and pretending otherwise would produce a service
that works in testing and 500s on exactly the large sessions people most want to share.

## Alternatives considered

- **Do nothing; leave sharing on `agents.craft.do`.** Zero work, and it functions.
  Rejected: the fork's stated position is privacy and independence, and this is the one
  user-facing action that contradicts it outright. It also leaves every shared transcript
  on a host upstream has already shown it will move.
- **Remove the share feature.** Genuinely tempting, and it is the laziest fix that makes
  the disclosure true. Rejected: sharing is a real feature people use, we already own the
  viewer, and deleting a working feature to avoid operating 150 lines of Worker is the
  wrong trade.
- **Workers KV instead of R2.** Rejected on the table above; eventual consistency alone
  disqualifies it for read-immediately-after-write.
- **Host on `vorno.ai/s/*` via the existing site Worker.** Rejected: puts untrusted
  user-submitted content on the apex origin, couples a user-data service to the marketing
  site's release-day deploys, and collides with the static-asset pipeline.
- **Require an account to share.** Would remove the abuse surface entirely. Rejected as
  scope: there is no account system, and building one to gate a share button inverts the
  cost of the feature. Revisit if PLAN-023 hosted workspaces ships identity anyway.
- **Migrate existing shares off Craft.** Rejected: we do not have them — only the user's
  own copy plus a URL. Rewriting `sharedUrl` for existing sessions would silently break
  links other people already hold.

## References

- [ADR-0023](0023-vorno-owns-its-documentation-endpoint.md) — the `DOCS_URL` split this extends
- ADR-0025 — the OAuth relay, the remaining `SERVICE_BASE_URL` consumer
- [PLAN-035](../plans/in-progress/PLAN-035-vorno-hosted-session-shares.md) — implementation and cutover
- [ADR-0009](0009-vorno-rebrand-appid-release-feed-signing.md) — the precedent for decoupling an endpoint from upstream
- `roadmap/upstream/compatibility.md` — what wire compatibility does and does not cover
- [vorno.ai/docs/sharing](https://vorno.ai/docs/sharing/) — the disclosure this change makes obsolete
