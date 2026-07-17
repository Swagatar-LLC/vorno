---
name: upstream-sync
description: Merge the latest from craft-ai-agents/craft-agents-oss into our fork on a branch, resolve standard conflicts, run validations, and open a PR
---

# Skill: upstream-sync

Perform the canonical upstream-merge workflow we've refined across multiple cycles. Mechanical when conflicts are limited to `bun.lock`; falls back to human judgment when novel conflicts appear.

> **REPO_DIR** — the local checkout of `Swagatar-LLC/vorno`. On the maintainer's machine this is `~/dev/vorno` (the local directory is being renamed to match the repo rename; older checkouts may still live at `~/dev/craft-agents-oss` until renamed). All commands below that reference an absolute path use `REPO_DIR` as shorthand for this checkout.

## When to invoke

- A new upstream release tag has been published (`v0.x.y`)
- The user says "pull from upstream" / "sync upstream" / "merge upstream"
- During a periodic upstream check

## Inputs

- **target-ref** (default: `upstream/main`) — usually leave default
- **branch-name** (default: `jh/YYYY-MM-DD_Upstream_Merge`) — auto-generate from today's date

## Procedure

### Step 1 — Verify state

```bash
cd REPO_DIR
git status                      # must be clean
git branch --show-current       # should be main (or warn)
git remote -v | grep upstream   # must show upstream remote
```

If working tree is dirty → abort with a clear message.

### Step 2 — Fetch and diagnose

```bash
git fetch upstream
git fetch origin

# How many commits behind?
git rev-list --count main..upstream/main

# What's new?
git log --oneline main..upstream/main
git diff --stat main..upstream/main | tail -20
```

Summarize the new versions/commits to the user before proceeding. If 0 commits behind → report and exit.

> **Versioning (ADR-0010):** upstream tags are *their* releases, not ours. A sync brings features in; it never drives a Vorno version bump, and upstream `v*` tags are never pushed to `origin` (nor ours to `upstream`). Record the Vorno-version ⇄ upstream-tag mapping in `roadmap/upstream/HEAD.md`.

### Step 3 — Branch and merge

```bash
git checkout -b jh/$(date +%Y-%m-%d)_Upstream_Merge
git merge upstream/main
```

Expected conflicts and resolutions:

| File | Resolution |
|------|------------|
| `bun.lock` | `git checkout --theirs bun.lock && bun install` |
| `packages/shared/src/agent/options.ts` | Take upstream's `buildClaudeSubprocessEnv()` and ensure our `delete env.CLAUDECODE` line is preserved inside it |
| `apps/electron/package.json` (`version` field) | **Keep OURS.** Per [ADR-0010](../../../roadmap/decisions/0010-independent-vorno-versioning.md), Vorno versions independently from 0.11.2 onward — an upstream merge never changes our version stamp. |
| `apps/electron/resources/release-notes/*.md` | **Do not adopt upstream's versioned files** (ADR-0010). Delete any incoming `{version}.md` the merge adds (ours ≥ 0.11.2 are Vorno-owned; upstream numbers ≥ 0.11.2 are not our releases). Instead, summarize notable upstream features as bullets in `next.md` attributed "from upstream" — they ship under the next Vorno version. Files ≤ 0.11.1 are shared history; leave them alone. |
| Anything else | **Stop and surface to user.** Don't auto-resolve novel conflicts. |

After resolving:

```bash
git add <resolved files>
git commit --no-edit          # use the merge default message
```

### Step 4 — Validate

```bash
# packages/shared typecheck (often has pre-existing upstream issues — surface but don't block)
cd packages/shared && bunx tsc --noEmit 2>&1 | tail -5
cd ../..

# apps/server (must be clean)
cd apps/server && bunx tsc --noEmit 2>&1 | grep -v "TS6059" | grep error
bun test
cd ../..

# bundle build (must succeed)
bun build apps/server/src/index.ts --target=bun --outdir=/tmp/build-check --no-splitting 2>&1 | tail -3

# pi-agent-server build — catches stale nested @earendil-works/* (see LEARNING-001)
bun build packages/pi-agent-server/src/index.ts --target=bun --outdir=/tmp/pi-build --no-splitting 2>&1 | tail -3
```

If `pi-agent-server` build fails with "No matching export" errors for `@earendil-works/*` symbols (the Pi SDK scope, renamed from `@mariozechner/*` upstream in v0.10.4), that's [LEARNING-001](../../../roadmap/learnings/LEARNING-001-stale-nested-mariozechner-deps.md). Apply the fix:

```bash
rm -rf packages/{shared,server-core,pi-agent-server}/node_modules/@earendil-works
bun build packages/pi-agent-server/src/index.ts --target=bun --outdir=/tmp/pi-build --no-splitting 2>&1 | tail -3
```

If the merge bumps `@anthropic-ai/claude-agent-sdk`, also verify subagent-launch semantics in the new CLI binary. Context ([LEARNING-008](../../../roadmap/learnings/LEARNING-008-node-modules-sdk-drift-forces-async-subagents.md)): Claude Code ≥ 2.1.197 launches Task subagents async by default behind the remote `tengu_amber_heron` GrowthBook gate; we pin `DISABLE_GROWTHBOOK=1` in `buildClaudeSubprocessEnv()` (`packages/shared/src/agent/options.ts`) so all gates resolve to their compiled-in defaults and the async gate defaults off.

```bash
# 1. The async decision should still be feature-gated (expect >= 1):
strings -a node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude | grep -c "tengu_amber_heron"

# 2. Inspect the launch decision; confirm it is still ANDed with the
#    disable flag and gated on the GrowthBook lookup:
strings -a node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude | grep -o ".\{300\}tengu_amber_heron.\{80\}" | head -2
```

The invariant to confirm (minified names change every version): the feature-gate helper returns the passed compiled-in default when `DISABLE_GROWTHBOOK` is set, *before* consulting cached gate values, and the Task launch path only goes async via that gate or an explicit `run_in_background`/`background: true`. If the gate disappears or async becomes unconditional, stop and re-audit blocking semantics before merging — the fork's orchestration and `tool-matching.ts` backgrounded-task detection assume blocking-by-default.

Report counts. If `apps/server` tests fail → abort, don't push.

### Step 5 — Push and open PR

```bash
git push -u origin <branch>
gh pr create \
  --repo Swagatar-LLC/vorno \
  --base main \
  --head <branch> \
  --title "Merge upstream <range>" \
  --body "<see template below>"
```

PR body template:

```markdown
## Summary

Merge upstream releases <list> into our fork.

- `vX.Y.Z` — <one-line summary of major changes>

**Conflicts:** <list>

## Architecture alignment

<note any wire/protocol concerns; reference roadmap/upstream/compatibility.md>

## Test plan

- [x] apps/server typecheck clean
- [x] apps/server tests: <N pass / N fail>
- [x] Bundle build succeeds
- [ ] CI green on PR
```

### Step 6 — Update upstream tracking

After CI passes and PR merges, update:

- `roadmap/upstream/HEAD.md` — last merged tag, commit, merge PR link, date
- `roadmap/upstream/delta.md` — refresh via `[skill:upstream-delta-report]`
- `roadmap/upstream/compatibility.md` — add audit-log entry if any contracts touched

## Constraints

- **Never** force-push. **Never** rebase merged commits.
- **Never** skip CI. If `validate-pr.yml` fails on a known transient pre-existing issue, the threshold-bump pattern is the documented fix (see existing CI history). Otherwise, investigate.
- If `bun install` fails after `--theirs`, do NOT delete `bun.lock` and regenerate without confirming. Investigate first.
- Watch for new files under `packages/shared/src/protocol/` or `packages/shared/src/agent/` — these often indicate wire changes that warrant a compatibility audit.

## Reference history

The pattern was forged across these merges (see `git log` for details):

- v0.7.7 → v0.7.12 (commit `61f7d48` etc.)
- v0.8.0 → v0.8.1
- v0.8.2 → v0.8.6 (PR #3)
- v0.8.7 → v0.8.9 (commit `964d56d`)
- v0.8.10 → v0.8.12 (PR #4, commit `4e6cf10`, 2026-04-28)
