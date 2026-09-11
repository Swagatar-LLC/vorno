# `vorno-pages` — public Pages sharing Worker

This is an isolated Cloudflare Worker for public Vorno Pages. It is **not** the
session-sharing Worker: it serves user-authored HTML, while `vorno-share` / the
`share.vorno.ai` origin must remain an inert-JSON service. Do not share its
host, R2 bucket, rate-limit namespace, credentials, or deployment pipeline.

## Contract

- Fresh client publication targets only `https://pages.vorno.ai/api` (or an
  explicitly port-bounded localhost development endpoint). The desktop client
  refuses arbitrary/Craft origins; update and unpublish recover only validated
  stored HTTPS publication origins.
- `POST /api/publications` creates a public `/p/{id}` page and returns the
  256-bit admin token **once**. R2 stores only its SHA-256 hash.
- `PUT /api/publications/{id}` updates content/snapshot or password metadata;
  `DELETE` logically revokes first, so every public `/p/{id}` route returns
  `404` before best-effort physical deletion begins. A deletion failure remains
  in the tombstone audit record, returns `cleanupPending: true`, and retries on
  the next authenticated delete.
- Content uses a `src` iframe with an opaque sandbox and per-document CSP:
  `connect-src 'none'`, no store, nosniff, no credentials, no privileged bridge
  actions, and no public `open-url` relay. The persistent shell says **“Published by a Vorno user — not by
  Vorno.”** Frame self-navigation is a documented residual; this Worker only
  claims no *scripted* network egress.
- Snapshots are optional and only exist when explicitly uploaded. The desktop
  scans opt-in snapshot data for secret-looking key names before upload; the
  Worker validates all byte limits again but does not create a second heuristic
  scanner.

## Required Cloudflare provisioning — owner gate

**Do not deploy yet.** SUV-0063 plus Jeff’s privacy policy and retention
approval are prerequisites. No CI workflow deploys this Worker.

After that gate, the privacy owner must create and bind:

1. Worker `vorno-pages` at custom domain `pages.vorno.ai`.
2. A dedicated R2 bucket named `vorno-pages`; never `vorno-shares`.
3. Two isolated Workers rate-limit namespaces, replacing the two explicit
   `REPLACE_WITH_…` placeholders in `wrangler.jsonc`:
   `PAGE_CREATE_LIMIT` (5/minute/IP) and `PAGE_PASSWORD_LIMIT`
   (10/minute/publication+IP).
4. The Worker secret `PASSWORD_TICKET_SECRET`, a random 256-bit value. It signs
   short-lived, path-scoped, HttpOnly, Secure, SameSite=Strict password tickets
   and is never a repository variable or client credential.
5. The proposed retention lifecycle only after Jeff decides it: content until
   unpublish, immediate physical deletion attempt on unpublish, operational
   tombstone/audit data at most 30 days. The Worker does not invent a retention
   rule in code.
6. A narrowly scoped deployment credential (if CI deployment is later added):
   Workers edit for this Worker, R2 access for `vorno-pages`, and nothing for
   `vorno-share`/`vorno-shares` or unrelated zones.

## Password cost calibration

The configured default is 100,000 PBKDF2-SHA256 iterations. It is not a
security constant. On 2026-09-10, `bun run bench:password` on the implementation
machine (Bun 1.3.8, five samples) measured **6.01 ms min / 6.48 ms median /
6.58 ms max**. That calibrates the local implementation only; benchmark it again
before the deploy decision and record the intended-runtime result in the
deployment review:

```sh
cd workers/pages
bun run bench:password
PBKDF2_ITERATIONS=100000 SAMPLES=20 bun run bench:password
# then repeat with wrangler dev under the intended Workers plan/runtime
```

Keep the selected cost only when the intended runtime’s measured median and
worst-case fit the Worker CPU budget together with multipart parsing. If it
does not, choose a measured lower cost plus the existing per-publication/IP
password limiter; do not silently ship a guessed iteration count.

## Local validation

```sh
cd workers/pages
bun test
bun run typecheck
```

## Post-gate real HTTP acceptance sequence

Run only after the privacy/retention gate and actual deployment:

1. Create a plain page; verify shell and content are 200 and content includes
   `connect-src 'none'`, `frame-ancestors`, `nosniff`, and `no-store`.
2. Verify a public bridge `action` returns `public-actions-disabled`; use a real
   browser to verify CSP behavior and record the known self-navigation residual.
3. Verify unauthenticated update/delete are 401 and leave content unchanged.
4. Create/set password; verify shell/content/snapshot are 401 without a ticket,
   succeed with the ticket, and wrong attempts are rate-limited.
5. Update content; verify revision changes. Change only password; verify revision
   does not change.
6. Delete with the admin token; verify shell, content, and snapshot all return
   404 immediately. Exercise the failure/retry audit path before sign-off.

A green deploy is not production verification.
