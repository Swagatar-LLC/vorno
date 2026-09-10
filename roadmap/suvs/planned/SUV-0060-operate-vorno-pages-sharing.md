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
securely updated, password-protected, and immediately unpublished.

## Scope

- Add public `workers/pages/` source, tests, Worker config, deployment guide,
  and a separate `pages.vorno.ai`/`vorno-pages` R2 topology.
- Implement create/update/delete plus shell/content/snapshot routes, size and
  rate limits, hashed one-time-returned admin tokens, password tickets, revision
  updates, no-store, and immediate delete on unpublish.
- Use an opaque sandboxed `src` iframe and per-document CSP with
  `connect-src 'none'`; public bridge actions always refuse.
- Point publish at a strict Vorno origin allowlist; derive update/unpublish from
  a stored publication's validated HTTPS origin so existing publications remain
  revocable.

Deployment is blocked until Jeff has published the privacy policy and decided
retention. Proposed default: content until unpublish, immediate object deletion,
and operational logs retained no longer than 30 days.

## Acceptance

- [ ] Worker source and tests live in the public Vorno repo; Worker, R2 bucket,
      host, and admin-token namespace are isolated from `vorno-share`.
- [ ] Content/snapshot/total caps hold for missing or false `Content-Length`
      without partial persistence; create/password rate-limit failure behavior
      is covered.
- [ ] Public responses prove CSP, opaque sandbox, `nosniff`, and `no-store`;
      copies have no privileged actions and no scripted network egress.
- [ ] Admin tokens are returned only at creation, stored only as hashes, and
      unauthenticated mutation leaves objects unchanged.
- [ ] Publish rejects non-Vorno origins; update/unpublish uses the stored HTTPS
      origin; unpublish immediately makes every public route return 404.
- [ ] Before deployment, privacy policy, retention/log policy, and real-HTTP
      create/view/password/update/unpublish verification are recorded.

## Status log

- `2026-09-10` — created in `planned/`; deployment awaits the explicit privacy
  and retention gate rather than treating it as a follow-up.
