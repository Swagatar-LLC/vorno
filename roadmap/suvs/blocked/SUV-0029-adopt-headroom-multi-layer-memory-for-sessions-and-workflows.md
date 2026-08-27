---
id: SUV-0029
title: Adopt Headroom multi-layer memory for sessions and workflows
status: blocked
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-27
related: []
blocked-by:
  - SUV-0018-resolved-config-drives-the-headroom-boundary.md (memory rides the same config-driven adapter — satisfied, landed as 1291b25c)
  - "DECISION: which Headroom surface provides memory. The pinned TypeScript SDK has no memory API, and neither the proxy's HTTP API nor the MCP server exposes one; memory is reachable only via `headroom wrap --memory`, the Python client, or proxy-injected model tools. Its substrate is SQLite + HNSW + FTS5, not the local markdown this SUV's acceptance list requires. Needs an ADR (PLAN-040 open question 1 / §I1). Evidence: roadmap/evidence/PLAN-040/headroom-memory-surface-audit.md"
---

# SUV-0029 — Adopt Headroom multi-layer memory for sessions and workflows

## Goal

Make Headroom's multi-layer memory the flag-gated memory substrate for agent
sessions and workflow runs, exposed through memory operations on the boundary
adapter.

## Scope

- Extend the `HeadroomAdapter` boundary (SUV-0015) with the memory operations
  the plan needs — write, query, and provenance-carrying reads — backed by
  Headroom's memory layers with its default local-markdown substrate; the
  no-op adapter reports memory as unavailable.
- Wire session and Conductor workflow construction so agents read and write
  through that memory when the workspace flag enables it.
- Deliberately out: the pluggable extension interface (SUV-0030), the
  agentic-memory v2 backend (SUV-0031), and `headroom learn` mining.

## Acceptance

- [ ] The boundary adapter exposes memory operations, and the only production import of Headroom's memory APIs remains inside the boundary module (SUV-0015 guard still passes).
- [ ] In an enabled workspace, a memory written during one session is retrievable in a later session and in a workflow run, asserted by an integration test.
- [ ] The memory substrate on disk is local markdown, human-readable, and nothing is sent off-machine — verified against the SUV-0014 telemetry audit's opt-in findings.
- [ ] With Headroom disabled or absent, sessions and workflows run unchanged and memory operations report unavailable rather than throwing.

## Status log

- `2026-08-26` — created in `planned/`
- `2026-08-26` — **`planned/` → `blocked/`. Execution attempted; the SUV's premise
  does not hold, and no implementation was written.**

  PLAN-040 prefixes its capability list with "verify at integration time, not
  from README claims". Doing that first, before shaping any adapter surface,
  established that `headroom-ai@0.36.5` has **no memory API of any kind**: no
  `/v1/memory*` endpoint among the 19 the bundle calls, no `memory` member on
  `HeadroomClient`, no filesystem access at all, and not one occurrence of
  "memory" in its README. Upstream confirms memory is a proxy/CLI feature
  reachable only through `headroom wrap --memory`, the Python client's
  `client.memory.*`, or `memory_save`/`memory_search` tools the proxy injects
  into the model's own tool list. Its substrate is a project-scoped **SQLite**
  database (`.headroom/memory.db`, HNSW + FTS5) — **not** the local markdown this
  SUV's acceptance item 3 requires, and its vector index is a PLAN-040 non-goal.
  `SharedContext`, the one memory-shaped export, is an in-process `Map` with a
  one-hour TTL that dies with the session and fabricates token counts when the
  proxy is unreachable.

  Consequently: acceptance item 1 presupposes memory APIs that do not exist to
  import; item 2 (cross-session, cross-run retrieval) is unachievable without
  building persistence ourselves, PLAN-040's first non-goal; item 3 rests on a
  false premise about Headroom. Only item 4 is satisfiable, and only degenerately
  — "unavailable" would be every path's outcome.

  Deliberately **not** worked around. All four routes forward (adopt the proxy's
  injected model tools; adopt the Python client; read `.headroom/memory.db`
  directly; contribute memory to the TS SDK upstream) are architectural decisions
  above SUV granularity — PLAN-040 open question 1, which §I1 already says to
  record as an ADR. Recommendation is the upstream route, matching the plan's
  upstream-first posture and pairing naturally with SUV-0030. **The owner's call,
  not this SUV's.**

  Landed on `plan/plan-040`, no implementation:
  - `roadmap/evidence/PLAN-040/headroom-memory-surface-audit.md` — findings M1–M5,
    acceptance-by-acceptance impact, the four options, full reproduction steps.
  - `packages/shared/src/headroom/__tests__/sdk-memory-surface.test.ts` — the audit
    as an executable tripwire (6 tests). Reads the package off disk rather than
    importing it, because the boundary gate exempts no file, tests included. On
    the SUV-0014 monthly bump cadence it turns "upstream added memory" from
    something nobody would notice into a red build that says re-open this SUV.
  - PLAN-040's "Memory, multi-layer" bullet corrected in place — it asserted
    "Default substrate: local markdown" as fact — plus a plan status-log entry.
    **SUV-0030 (the plan's priority build item) and SUV-0031 inherit this premise
    and need re-grounding before they are executable.**

- `2026-08-27` — **Second execution attempt. Blocker independently re-verified
  against the installed package; stays `blocked/`; still no implementation.**

  Re-derived from scratch rather than trusting the 08-26 log. `headroom-ai` is
  still pinned at `0.36.5` (`packages/shared/package.json:100`), and its shipped
  `dist/index.d.ts` export list contains exactly three memory-named symbols:
  `MemoryUsage` / `memoryUsage()` (the proxy process's RSS — unrelated), and the
  path helpers `memoryDbPath()` / `nativeMemoryDir()`. There is no `memory`
  member on `HeadroomClient` (`"memory" in client === false` at runtime), and
  the one `retrieve()` method is CCR block-retrieval by content hash, not memory.

  One route the prior audit named but did not close out loud, closed here:
  `nativeMemoryDir()` resolves to `<workspaceDir>/memories` — a *directory*, and
  therefore the last plausible candidate for this SUV's "local markdown"
  substrate. It is a dead path string. Both helpers are pure `joinPath` calls
  (`dist/index.js:253-260`), the identifier appears three times in the whole
  bundle (declaration, export, nothing else), and the package performs no
  filesystem access at all. Neither `~/.headroom/` nor `~/.headroom/memories`
  exists on this machine after the SDK has been exercised. The sibling helper
  names the real substrate: `memory.db`.

  So acceptance item 3's premise is falsified twice over, and the escape hatch —
  writing markdown ourselves — is PLAN-040's first non-goal ("Building our own
  compression, token, or memory library"). Items 1 and 2 remain unimplementable
  for want of an API to import and cross-process persistence to build on. Item 4
  alone is reachable, still only degenerately.

  Also confirmed the 08-26 tripwire is not merely green but *able to go red*:
  each of its five assertion shapes was fed the mutation it exists to catch
  (a `/v1/memory/search` literal, a `readonly memory:` client member,
  `memorySave`/`MemoryStore` after the `MemoryUsage` scrub, a `node:fs` write,
  and a `persistPath` on `SharedContextOptions`) and every one fired. A vacuous
  tripwire would have made "still blocked" unfalsifiable; it isn't.

  Deliberately **not** worked around a second time. Shipping just the adapter
  surface plus "unavailable" would mean designing `MemoryEntry`, provenance, and
  query semantics against an unmade decision — the four routes (proxy-injected
  model tools, Python client, direct `.headroom/memory.db` reads, upstream TS
  contribution) produce four different shapes. That is PLAN-040 open question 1,
  reserved to the owner.

  What SUV-0030's delivery changed: the recommended upstream route is now
  better-grounded, not unblocked. `headroom/memory/ports.py` already defines the
  `MemoryStore` / `VectorIndex` / `TextIndex` Protocols and `factory.py` loads
  backends from setuptools entry points — Python-side seams, with the TypeScript
  gap filed upstream as headroomlabs-ai/headroom#3287.

  **Unblocking act is an ADR choosing the memory surface. After that this SUV
  needs re-cutting, not executing: acceptance item 3's markdown requirement has
  to go, and items 1–2 re-grounded on whichever surface the ADR picks.**

  Landed on `plan/plan-040`: this status-log entry only. No source file was
  created, edited, moved, or deleted.
