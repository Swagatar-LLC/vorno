---
id: ADR-0012
title: Additive vorno:* protocol namespace atop maintained Craft wire compatibility
status: accepted
date: 2026-07-17
supersedes: []
superseded-by: []
---

# ADR-0012 — Additive `vorno:*` protocol namespace atop maintained Craft wire compatibility

## Context

ADR-0001/ADR-0009 and `roadmap/upstream/compatibility.md` commit the fork to Craft wire compatibility: `craft_sk_*` / `craft_whk_*` token prefixes, `craft-fork:*` RPC channel namespace, `__craftRpcType`, `CRAFT_*` env vars, `~/.craft-agent` migration paths. That compatibility keeps upstream merges cheap and preserves interoperability.

Vorno-specific capability is now growing past what fits comfortably in the compatibility envelope: richer WebSocket UI events, server-management surfaces for the hosted workspace server (PLAN-023), and a Vorno-owned OAuth path. Breaking the Craft wire now would buy nothing and cost upstream-merge friction.

## Decision

1. **Existing Craft-named wire identifiers are frozen, not renamed.** Everything in the compatibility contract stays byte-identical until a deliberate, ADR-recorded break.
2. **All new protocol surface is additive under a `vorno:*` namespace**: new RPC channels and WebSocket event families use `vorno:<area>:<name>` (e.g. `vorno:server:*` for hosted-instance management, `vorno:ui:*` for richer UI event streams). New env vars introduced by Vorno-only features use `VORNO_*`. New token types introduced by Vorno-only features use `vorno_` prefixes.
3. **Clients must tolerate absence.** A `vorno:*` capability is always optional: upstream-compatible peers that don't speak it must work unchanged. Feature detection over version sniffing.
4. **The compatibility audit** (`roadmap/upstream/compatibility.md`) gains a section tracking the `vorno:*` surface so the additive boundary stays explicit and reviewable at every upstream sync.
5. **A future compatibility break** (if ever) requires its own ADR with a migration story; this ADR only licenses addition.

## Consequences

- PLAN-023 Phase 2 (Vorno-owned OAuth relay/client IDs) and new WS UI events have a defined naming home and need no per-feature naming debate.
- Upstream syncs stay cheap: no diffs on frozen identifiers; `vorno:*` code is fork-delta by construction and easy to audit.
- Two namespaces coexist indefinitely; documentation must be explicit about which surface is Craft-compatible and which is Vorno-native.
