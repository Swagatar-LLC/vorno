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

# ⚠ Deploy prerequisite

**`pages.vorno.ai` must not be deployed until this lands.** Jeff's 2026-09-13
retention decision replaced "content remains until its publisher unpublishes it"
with a **fixed 30-day TTL from last update**. SUV-0063 publishes that as the
policy at `/privacy`. The Worker does not implement it.

Deploying the Worker with the policy published and the TTL unenforced would state
a deletion commitment the service does not honour — a privacy disclosure that is
stale in the reassuring direction, which is the exact failure mode
`vorno-site` PR #1 was written to avoid.

## Goal

Delete published Page content 30 days after its last update, and stop serving it
at 30 days, so the published retention policy is true.

## Current state

`workers/pages/index.js` records `createdAt` and `updatedAt` on the manifest
(`:313`, `:323-324`, `:347`, `:358`, `:402`) and re-puts the content object on
update. It has **no TTL check on read, no scheduled handler, and no R2 lifecycle
rule**. `wrangler.jsonc` declares no `triggers`. Nothing expires.

## Scope

Two independent mechanisms, because neither alone is sufficient:

- **Access stops on time** — an age check on the public read path, derived from
  the manifest's `updatedAt`. This is exact and immediate; it is what makes the
  30-day promise true from the user's point of view.
- **Bytes actually go** — an R2 bucket lifecycle rule deleting objects 30 days
  after upload. Because an update re-puts the content object, object age resets on
  update and "30 days from last update" falls out without bookkeeping. This is
  eventual, not exact — hence the read guard above.

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

- [ ] A publication whose `updatedAt` is older than 30 days returns 404 on every
      public route, identically to an unpublished one.
- [ ] Updating a publication resets the window; coverage proves a page updated on
      day 29 survives to day 59.
- [ ] The R2 lifecycle rule is declared in the deployment guide and verified against
      the real bucket before deploy, not assumed.
- [ ] The bundled Pages guide and `/privacy` state the same number, and that number
      is 30 days.
- [ ] Cloudflare operational log retention is configured to 90 days and recorded in
      the deployment guide.

## Status log

- `2026-09-13` — created in `planned/` when Jeff's retention decision changed
  bullet 1 from indefinite-until-unpublish to a fixed 30-day TTL, which the Worker
  does not implement. Raised as a `pages.vorno.ai` deploy prerequisite.
