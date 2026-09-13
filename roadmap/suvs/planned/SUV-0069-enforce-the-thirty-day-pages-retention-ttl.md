---
id: SUV-0069
title: Enforce the thirty-day Pages retention TTL
status: planned
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

**Both halves must count the same event.** The deadline is anchored on
`contentUpdatedAt` — stamped only where `writeBundle` runs, meaning publication
and content update — and deliberately not on `updatedAt`. A password set or
clear writes the manifest without re-putting any object, so `updatedAt` moves
while the R2 rule goes on counting from the original upload. Anchoring on
`updatedAt` therefore advanced the logical window while the physical one did
not: publish on day 0 and set a password on day 25, and the content is deleted
at day 30 while the Worker still serves the shell until day 55 — an iframe
404ing under a 200 shell, which is both a broken page and a status split that
occurs in no other state, so it distinguishes "something was published here
once" from "nothing ever was".

A password change is therefore **not** an update for retention purposes. It
changes who may read the page, not what is stored.

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

- [ ] A publication whose `contentUpdatedAt` is older than 30 days returns 404 on
      every public route, identically to an unpublished one and to an unknown id.
- [ ] A CONTENT update resets the window; coverage proves a page updated on day 29
      survives past the original day-30 deadline.
- [ ] A password set or clear does NOT reset the window, so the read-path deadline
      and the R2 lifecycle rule cannot drift apart.
- [ ] The R2 lifecycle rule is declared in the deployment guide and verified against
      the real bucket before deploy, not assumed.
- [ ] The bundled Pages guide and `/privacy` state the same number — 30 days —
      and both say it runs from the last CONTENT update, not from any change to
      the publication.
- [ ] Cloudflare operational log retention is configured to 90 days and recorded in
      the deployment guide.

## Status log

- `2026-09-13` — created in `planned/` when Jeff's retention decision changed
  bullet 1 from indefinite-until-unpublish to a fixed 30-day TTL, which the Worker
  does not implement. Raised as a `pages.vorno.ai` deploy prerequisite.
- `2026-09-13` — the bounded review of the implementation found the deadline and
  the R2 lifecycle rule counting different events, because a password-only update
  moves `updatedAt` without re-putting an object. Retention re-anchored on
  `contentUpdatedAt`. This narrows the published wording: SUV-0063 must say the
  last CONTENT update and that a password change does not extend it.
