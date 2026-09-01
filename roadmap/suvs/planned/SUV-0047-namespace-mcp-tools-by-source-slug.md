---
id: SUV-0047
title: Namespace MCP tools by source slug so same-endpoint sources stop shadowing each other
status: planned
plan: PLAN-048
direction: DIR-03
owner: jh
created: 2026-09-01
updated: 2026-09-01
related:
  - ADR-0022
  - SUV-0046
blocked-by: []
---

# SUV-0047 — Namespace MCP tools by source slug

## Goal

Two sources pointing at the same MCP endpoint each get their own connection and
their own tool namespace, so neither shadows the other.

## Scope

- Derive MCP tool prefixes from the **source slug**, not the provider —
  `mcp__notion_personal__*` alongside `mcp__notion__*`.
- Maintain one connection per enabled source, keyed by slug, rather than one per
  endpoint.
- Regression coverage for the same-endpoint case specifically. This defect fails
  silently: calls resolve against the wrong account and return
  `404 object_not_found`, which reads as a permissions problem. Without a test it
  will recur unnoticed.

**Deliberately out:** renaming existing single-source prefixes where no collision
exists, if that would churn saved automations or guides. If prefixes must change,
say so explicitly in the PR and sweep `sources/*/guide.md` in the same change.

## Reproduction

Observed 2026-09-01, session `260901-dynamic-lagoon`:

1. Session starts with `notion` (YouVersion workspace) active.
2. Fetching a Swagatar-workspace page returns `404 object_not_found`.
3. `notion-personal` is enabled mid-session; the panel shows `Active`.
4. No `mcp__notion_personal__*` namespace exists; only `mcp__notion__*`.
5. Re-fetch returns 404 carrying the same `integration_id`
   (`1f8d872b-594c-80a4-b2f4-00370af2b13f`) as before enablement — the original
   connection is still serving.

## Acceptance

- [ ] `notion` and `notion-personal` are both callable in one session and resolve
      to their own workspaces
- [ ] Tools are addressable per source slug; enabling a second same-endpoint
      source does not displace the first
- [ ] The reproduction above passes end to end once SUV-0046 has landed
- [ ] Regression test asserts two same-endpoint sources coexist
- [ ] Any prefix change is swept through affected source guides in the same PR

## Status log

- `2026-09-01` — created in `planned/`
