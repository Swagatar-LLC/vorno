---
id: SUV-0069
title: Enforce the thirty-day Pages retention TTL
status: in-progress
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-13
related: [SUV-0060, SUV-0063, ADR-0033]
blocked-by: []
---

# SUV-0069 — Enforce the thirty-day Pages retention TTL

## Deploy prerequisite

**`pages.vorno.ai` must not be deployed until this lands.** Jeff's 2026-09-13
retention decision replaced "content remains until its publisher unpublishes it"
with a **fixed 30-day TTL**. SUV-0063 publishes that as the policy at
`/privacy`. The Worker does not implement it.

Deploying the Worker with the policy published and the TTL unenforced would state
a deletion commitment the service does not honour — a privacy disclosure that is
stale in the reassuring direction, which is the exact failure mode
`vorno-site` PR #1 was written to avoid.

## Goal

Delete published Page content 30 days after its content was last written, and
stop serving it at the same moment, so the published retention policy is true.

## Current state

`workers/pages/index.js` records `createdAt` and `updatedAt` on the manifest and
re-puts the content objects in `writeBundle`. It has **no TTL check on read, no
scheduled handler, and no R2 lifecycle rule**. `wrangler.jsonc` declares no
`triggers`. Nothing expires.

## Scope

Two independent mechanisms, because neither alone is sufficient:

- **Access stops on time** — an age check on the public read path, in
  `publicRecord`, the single loader behind every public route. This is exact and
  immediate; it is what makes the 30-day promise true from a reader's point of
  view at the moment it falls due.
- **Bytes actually go** — an R2 bucket lifecycle rule deleting objects 30 days
  after upload. This is eventual, not exact: R2 evaluates lifecycle
  asynchronously and bytes can outlive the deadline by hours, which is why the
  read guard above is not redundant.

**Both halves must count the same event.** The R2 lifecycle rule deletes an
object N days after its own upload and cannot see a manifest write, so a renewal
that moved only a timestamp would advance the read-path deadline past the age R2
is enforcing: the content would be deleted on the old schedule while the shell
kept rendering over it — a broken page, and a 200-over-404 split that occurs in
no other state and so distinguishes "something was published here once" from
"nothing ever was".

**Every update restarts the window, password changes included** (Jeff,
2026-09-13). Honouring that means a password set or clear **re-uploads the
retained objects** so their R2 age restarts too. The anchor — `retentionAnchorAt`,
named for what it tracks rather than for content changing — advances only after
every re-upload succeeds. A renewal that cannot finish writes no manifest at all,
leaving the anchor behind the object age rather than ahead of it, which is the
only safe direction.

Also in scope:

- The expired response is the same 404 as an unpublished page. Do not add a
  distinguishing "expired" status to the public route — it would let an
  unauthenticated caller separate "never existed" from "existed and lapsed".
- State the TTL in the bundled Pages guide (SUV-0061) so a publisher learns it
  before publishing, not after a link dies.

## Non-goals

- **No in-app expiry display or renewal prompt in this SUV.** Showing the publisher
  a countdown or an "expiring soon" notice is real product work in the desktop
  client; it is a follow-up, not a deploy prerequisite. The guide and the policy
  carry the disclosure for the beta.
- No grace period, no archive tier, no restore path. Expired means gone.

## Acceptance

- [ ] A publication whose `retentionAnchorAt` is older than 30 days returns 404 on
      every public route, identically to an unpublished one and to an unknown id.
- [ ] Any update resets the window; coverage proves a page updated on day 29
      survives past the original day-30 deadline.
- [ ] A password set, change, or clear renews the window AND re-uploads the
      retained objects, so the read-path deadline and the R2 lifecycle rule cannot
      drift apart. A partial re-upload failure advances nothing and reports no
      renewal.
- [ ] The R2 lifecycle rule is declared in the deployment guide and verified against
      the real bucket before deploy, not assumed.
- [ ] The bundled Pages guide and `/privacy` state the same number — 30 days —
      running from the last update, with no carve-out.
- [ ] Cloudflare operational log retention is configured to 90 days and recorded in
      the deployment guide.

## Status log

- `2026-09-13` — created in `planned/` when Jeff's retention decision changed
  bullet 1 from indefinite-until-unpublish to a fixed 30-day TTL, which the Worker
  does not implement. Raised as a `pages.vorno.ai` deploy prerequisite.
- `2026-09-13` — moved from `planned` to `in-progress`: implementation opened as
  PR #208.
- `2026-09-13` — the bounded review found the deadline and the R2 lifecycle rule
  counting different events, because a password-only update moved `updatedAt`
  without re-putting an object. The implementation first narrowed "update" to
  content writes, which would have changed the published policy without
  authority. Jeff decided at 14:53 EDT that a password change IS an update, so
  the narrowing was reverted and the Worker re-uploads the retained objects on a
  password change instead. `/privacy` publishes bullet 1 unmodified.
- `2026-09-13` — merged evidence recorded: SUV-0061 landed via PR #209
  (`8a5f44d6`, on `origin/main`), with supporting roadmap/docs PR #207 and
  quiescence-flake fix PR #210. `vorno-site` PR #2 carried SUV-0063's
  privacy-page implementation and `https://vorno.ai/privacy/` is live. This
  SUV's own acceptance (TTL enforcement, R2 lifecycle rule, deploy
  verification) is unaffected by that evidence and remains open, so it stays
  in `in-progress/`.
