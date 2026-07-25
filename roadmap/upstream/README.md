# Upstream tracking

Our relationship with [craft-ai-agents/craft-agents-oss](https://github.com/craft-ai-agents/craft-agents-oss). Posture is fixed by [ADR-0001](../decisions/0001-fork-relationship-with-upstream.md): wire-compatible, deliberately divergent.

## Public / private split

Only `compatibility.md` (wire/protocol commitments) is public and lives here.
The sync bookkeeping is internal and now lives in the private repo
**`Swagatar-LLC/vorno-internal`** under `roadmap/upstream/`:

| File | Repo | Purpose | Refresh cadence |
|------|------|---------|-----------------|
| [`compatibility.md`](compatibility.md) | public (here) | Wire/protocol compatibility commitments | When commitments change |
| `HEAD.md` | `vorno-internal` (private) | Current sync state — last merged upstream commit/tag | After each merge |
| `delta.md` | `vorno-internal` (private) | Files we own that differ from upstream/main | After each merge (via `[skill:upstream-delta-report]`) |
| `contribution-candidates.md` | `vorno-internal` (private) | Things we might PR back upstream | Continuous |

## Process

1. **Sync** — when upstream tags a release, run `[skill:upstream-sync]`. It creates a branch, merges, resolves the standard `bun.lock` conflict, runs tests, pushes a PR.
2. **Refresh delta** — once merged, run `[skill:upstream-delta-report]` to update the private `delta.md` (`vorno-internal`).
3. **Review compatibility** — if upstream touches `MessageEnvelope`, `AgentEvent`, source/skill schemas, or any contract we mirror, audit `compatibility.md` (public, here).
4. **Decide on contributions** — if anything in our diff looks portable upstream, add it to the private `contribution-candidates.md` (`vorno-internal`).

## Quick git commands

```bash
# What's new upstream?
git fetch upstream && git log --oneline main..upstream/main

# Are we behind?
git rev-list --count main..upstream/main

# Files we own that differ
git diff --name-only upstream/main...main

# Are we ahead of origin?
git rev-list --count origin/main..main
```
