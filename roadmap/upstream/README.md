# Upstream tracking

Our relationship with [lukilabs/craft-agents-oss](https://github.com/lukilabs/craft-agents-oss). Posture is fixed by [ADR-0001](../decisions/0001-fork-relationship-with-upstream.md): wire-compatible, deliberately divergent.

## Files

| File | Purpose | Refresh cadence |
|------|---------|-----------------|
| [`HEAD.md`](HEAD.md) | Current sync state — last merged upstream commit/tag | After each merge |
| [`delta.md`](delta.md) | Files we own that differ from upstream/main | After each merge (via `[skill:upstream-delta-report]`) |
| [`compatibility.md`](compatibility.md) | Wire/protocol compatibility commitments | When commitments change |
| [`contribution-candidates.md`](contribution-candidates.md) | Things we might PR back upstream | Continuous |

## Process

1. **Sync** — when upstream tags a release, run `[skill:upstream-sync]`. It creates a branch, merges, resolves the standard `bun.lock` conflict, runs tests, pushes a PR.
2. **Refresh delta** — once merged, run `[skill:upstream-delta-report]` to update `delta.md`.
3. **Review compatibility** — if upstream touches `MessageEnvelope`, `AgentEvent`, source/skill schemas, or any contract we mirror, audit `compatibility.md`.
4. **Decide on contributions** — if anything in our diff looks portable upstream, add it to `contribution-candidates.md`.

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
