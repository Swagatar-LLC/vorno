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
- Published content is retained **30 days from its last update**; every update
  restarts the window, password changes included. Because the R2 lifecycle rule
  enforcing the other half counts each object's own upload and cannot see a
  manifest write, a password set or clear **re-uploads the retained objects** so
  both deadlines move together, and the stored anchor advances only after those
  re-uploads succeed. A renewal that cannot finish writes nothing at all rather
  than claiming a renewal it did not get. Past the deadline every public `/p/{id}` route returns
  the same bare `404` as an unknown id and as an unpublished page — expiry is
  never distinguishable from absence, because that difference would disclose
  someone else's publishing history to an unauthenticated caller. Admin routes
  keep working past the deadline so an owner is never stranded from cleanup by
  the deadline that hid the page.
- Snapshots are optional and only exist when explicitly uploaded. The desktop
  scans opt-in snapshot data for secret-looking key names before upload; the
  Worker validates all byte limits again but does not create a second heuristic
  scanner.

## Required Cloudflare provisioning — owner gate

**Gate discharged 2026-09-13.** SUV-0063 landed (`vorno-site` a829555) and Jeff
approved the privacy policy and retention explicitly. First deploy went out the
same evening as version `7a690805-5d0f-4097-bc89-c428303ddfec`. No CI workflow
deploys this Worker; it is deployed by hand with `npx wrangler deploy`.

Provisioning state:

1. DONE. Worker `vorno-pages` at custom domain `pages.vorno.ai`. Wrangler creates
   the DNS record itself from the `custom_domain: true` route — **do not
   pre-create it by hand**, a conflicting record makes the attach fail.
2. DONE. A dedicated R2 bucket named `vorno-pages`; never `vorno-shares`.
3. DONE. Two Workers rate-limit namespaces, `2001` (`PAGE_CREATE_LIMIT`,
   5/minute/IP) and `2002` (`PAGE_PASSWORD_LIMIT`, 10/minute/publication+IP).
   These ids are **self-assigned per Worker**, not provisioned resources — there
   is no API that creates them. The `1001` block is left free for `vorno-share`,
   which does not yet exist on the account.
4. DONE. The Worker secret `PASSWORD_TICKET_SECRET`, a random 256-bit value. It signs
   short-lived, path-scoped, HttpOnly, Secure, SameSite=Strict password tickets
   and is never a repository variable or client credential.
5. DONE. The R2 lifecycle rule and the operational log ceiling, both verified on
   the free plan on 2026-09-13:

   - **R2 lifecycle** — rule `vorno-pages-30-day-retention` is enabled on
     `vorno-pages`, all prefixes, "expire objects after 30 days". Confirm with
     `npx wrangler r2 bucket lifecycle list vorno-pages`. Age is measured from
     upload, which is why the Worker re-uploads retained objects on a password
     change: that restarts the clock so "30 days from last update" and the R2
     rule stay in step rather than drifting apart.
   - **Log retention** — nothing to configure, and this item was previously
     misstated as "set log retention to 90 days". Workers Logs retention is a
     fixed plan benefit, not a setting: 3 days on Free, 7 on Paid. The published
     commitment is a *ceiling* ("no more than 90 days"), so the platform default
     satisfies it with two orders of magnitude to spare. The only mechanism that
     could exceed the ceiling is Logpush to external storage, which is
     Enterprise-only and therefore unavailable here. If Vorno ever leaves the
     free plan, re-check that no Logpush job ships Pages logs somewhere with a
     longer retention than 90 days.

   Both follow the retention policy Jeff approved on 2026-09-13 (PLAN-052 owner
   gate), published at `/privacy`:

   - published content is retained **30 days from its last update** — publication,
     content update, or password change; the Worker re-uploads the retained
     objects on a password change so this rule and the read path stay in step;
   - unpublish immediately revokes public access;
   - physical deletion is attempted immediately and retried on failure, with the
     publisher warned while the content stays revoked;
   - Cloudflare operational logs are kept **no more than 90 days** —
     deliberately longer than content, to preserve an abuse-investigation
     window.

   The lifecycle rule is bucket configuration, not `wrangler.jsonc`, so nothing
   in this repository can assert it exists. **Verify it against the real bucket
   before deploying** — this is the one provisioning item with no automated
   check behind it. Every operation that renews retention re-puts the retained
   objects, so their R2 age resets at exactly the moment the Worker's
   `retentionAnchorAt` advances and an upload-age rule agrees with the read-path
   deadline by construction. That is why the anchor is not `updatedAt`: it must
   track object uploads, which is the only thing the lifecycle rule can see.

   The Worker enforces the same deadline on the read path (`RETENTION_MS` in
   `index.js`), and that is not redundant: R2 evaluates lifecycle
   asynchronously, so bytes can outlive the deadline by hours, and serving them
   in that window would be the service contradicting its own policy. The
   lifecycle rule makes the promise true on disk; the read path makes it true
   for a reader at the moment it falls due. Keep the two numbers, the bundled
   Pages guide, and `/privacy` in agreement.
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
