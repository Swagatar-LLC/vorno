---
id: SUV-0060
title: Operate Vorno Pages sharing
status: done
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [SUV-0058, SUV-0059, ADR-0033]
blocked-by: []
---

# SUV-0060 — Operate Vorno Pages sharing

## Goal

Publish enabled Pages only through a Vorno-owned, isolated Worker that can be
securely updated, password-protected, honestly branded, and immediately
unpublished.

## Scope

- Add public `workers/pages/` source, tests, Worker config, deployment guide,
  and a separate `pages.vorno.ai`/`vorno-pages` R2 topology.
- Make sharing default `false`; require the owning workspace's enabled Pages
  setting and a verified backend capability before publish is available.
- Implement create/update/delete plus shell/content/snapshot routes, secret
  scanning before publish, explicit snapshot opt-in, size/rate limits, hashed
  one-time-returned admin tokens, password tickets, revision updates, no-store,
  immediate logical revocation, and separately warned/audited/retried physical
  deletion failures.
- Use an opaque sandboxed `src` iframe, per-document CSP with
  `connect-src 'none'`, refused public bridge actions, and a Vorno-branded shell
  carrying a persistent "published by a Vorno user—not by Vorno" disclaimer.
- Point publish at a strict Vorno origin allowlist; derive update/unpublish from
  a stored publication's validated HTTPS origin so existing publications remain
  revocable.

Deployment waits for SUV-0063 and Jeff's retention decision. Proposed default:
content until unpublish, immediate object deletion, and operational logs no
longer than 30 days.

## Acceptance

- [x] Worker source and tests live in the public Vorno repo; Worker, R2 bucket,
      host, and admin-token namespace are isolated from `vorno-share`.
- [x] Sharing defaults false and is unavailable unless the workspace Pages
      setting is enabled and the backend capability check succeeds; no default
      points to Craft infrastructure.
- [x] Secret scanning runs before publish; snapshot inclusion is opt-in; content,
      snapshot, and total caps hold for missing or false `Content-Length` without
      partial persistence, and create/password rate-limit failures are covered.
- [x] Public responses prove CSP, opaque sandbox, `nosniff`, `no-store`, refused
      bridge actions, no scripted network egress, and the branded
      user-published/phishing disclaimer.
- [x] Admin tokens are returned only at creation and stored only as hashes;
      unauthenticated mutation leaves objects unchanged; update/unpublish uses
      stored validated HTTPS origin; unpublish first logically revokes so every
      public route returns 404. Physical R2/object deletion failure is separately
      warned, audited, and retried, with a delete-failure-path regression test.
- [x] Before deployment, the policy/site prerequisite and real-HTTP
      create/view/password/update/unpublish verification are recorded in the
      Worker guide as a post-gate procedure; no deploy or real HTTP call occurred.

## Status log

- `2026-09-10` — created in `planned/`; deployment awaits the explicit privacy
  and retention gate rather than treating it as a follow-up.

- `2026-09-10` — moved from `planned` to `in-progress`: isolated Worker implementation, client contract verification, and security tests started on `pages-sharing-0060`.
- `2026-09-10` — implementation complete: isolated Worker, client cleanup warning, strict CI gates, and pre-deployment guide added; focused Worker/client checks passed. No Cloudflare resource, secret, DNS, or deployment was mutated.
- `2026-09-10` — moved from `in-progress` to `done`: implementation is committed for review; deployment remains blocked by SUV-0063 and Jeff's privacy/retention decision.
