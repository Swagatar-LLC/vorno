---
id: SUV-0060
title: Operate Vorno Pages sharing
status: planned
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
  immediate delete, and best-effort delete warnings.
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

- [ ] Worker source and tests live in the public Vorno repo; Worker, R2 bucket,
      host, and admin-token namespace are isolated from `vorno-share`.
- [ ] Sharing defaults false and is unavailable unless the workspace Pages
      setting is enabled and the backend capability check succeeds; no default
      points to Craft infrastructure.
- [ ] Secret scanning runs before publish; snapshot inclusion is opt-in; content,
      snapshot, and total caps hold for missing or false `Content-Length` without
      partial persistence, and create/password rate-limit failures are covered.
- [ ] Public responses prove CSP, opaque sandbox, `nosniff`, `no-store`, refused
      bridge actions, no scripted network egress, and the branded
      user-published/phishing disclaimer.
- [ ] Admin tokens are returned only at creation and stored only as hashes;
      unauthenticated mutation leaves objects unchanged; update/unpublish uses
      stored validated HTTPS origin; unpublish returns 404 or a best-effort
      deletion warning on every public route.
- [ ] Before deployment, the policy/site prerequisite and real-HTTP
      create/view/password/update/unpublish verification are recorded.

## Status log

- `2026-09-10` — created in `planned/`; deployment awaits the explicit privacy
  and retention gate rather than treating it as a follow-up.
