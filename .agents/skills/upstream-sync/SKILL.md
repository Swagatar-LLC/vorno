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

> **Versioning (ADR-0010):** upstream tags are *their* releases, not ours. A sync brings features in; it never drives a Vorno version bump, and upstream `v*` tags are never pushed to `origin` (nor ours to `upstream`). Record the Vorno-version ⇄ upstream-tag mapping in `INTERNAL_DIR/upstream/HEAD.md` (private `vorno-internal` repo — see Step 6).

> **Tag collisions are EXPECTED — not a failure (confirmed by Jeff 2026-08-04).** Because ADR-0010 versions this fork independently, we and upstream mint the *same version numbers for different commits* (e.g. our `v0.11.2` = `4873d18a` via PR #75; upstream's `v0.11.2` = `a60ebc1a`). Anyone who runs `git fetch upstream --tags` by hand will therefore see:
>
> ```
> ! [rejected]  v0.11.2 -> v0.11.2  (would clobber existing tag)
> ```
>
> **This is git protecting our tags, and it is correct.** Do not force-fetch, do not re-tag, do not report it as a sync failure, and do not open a question about it — it is settled. The collision set only grows as more version numbers overlap. Step 2 deliberately uses a plain `git fetch upstream` (branch refs only), which is unaffected. Decision: leave the default fetch behavior as-is rather than pinning `remote.upstream.tagOpt --no-tags`, so the tags stay visible if we ever need them.

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

If the merge bumps `@anthropic-ai/claude-agent-sdk`, also verify subagent-launch semantics in the new CLI binary (LEARNING-008).

> **Revised 2026-08-05 (SDK 0.3.220).** The old recipe grepped for the `tengu_amber_heron` GrowthBook gate. **That gate no longer exists** — grepping for it now returns `0`, which is not a failure signal, just a stale check. The async decision is now **ungated and async-by-default**. We stay blocking for a different reason: the SDK always spawns the CLI with piped stdio, so `!process.stdout.isTTY` marks it non-interactive, and the launch path forces synchronous in that mode.

The decision to re-verify each bump (minified names change every version — find it by locating the agent-launch function and reading its guard):

```js
// sync when: explicit sync || DISABLE_BACKGROUND_TASKS || !isInteractive
if (t || DT() || _n()) return false;
return e.background ?? true;   // otherwise async-by-default
```

Practical check — dump the binary once, then search with full context (`grep -o '.\{N\}pattern'` fights `strings` line boundaries; Python over a dumped blob does not):

```bash
B=node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
strings -a "$B" > /tmp/claude-strings.txt

# 1. Locate the interactivity predicate (expect: return !<state>.isInteractive)
grep -o 'function [A-Za-z_$]*(){return![A-Za-z_$]*\.isInteractive}' /tmp/claude-strings.txt | head -1

# 2. Print context around any launch guard that ORs three terms and then
#    falls through to `.background ?? true` — that is the decision.
python3 - <<'PY'
import re
blob = open('/tmp/claude-strings.txt', errors='replace').read()
for m in re.finditer(r'\.background\?\?!0', blob):
    print(blob[max(0, m.start()-220): m.start()+60].replace('\n', ' | '), '\n')
PY
```

**The invariant to confirm:** the launch path still resolves synchronously when the process is non-interactive. **If a future SDK decouples the async decision from interactivity, stop and re-audit before merging** — the fork's orchestration and `tool-matching.ts` backgrounded-task detection assume blocking-by-default. (`tool-matching.ts` does already handle the async-by-default result shape as "launch shape 2", so detection degrades gracefully, but the semantics change.)

**Do not "fix" this by setting `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`** — considered and rejected 2026-08-05. It is far blunter than its name: it also strips `run_in_background` from the **Bash** tool schema (killing background shells and `shell_backgrounded` detection), strips it from the Agent tool, and disables observer agents and MCP auto-backgrounding.

Also re-check the subagent nesting cap on each bump. We pin `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=5` in `buildClaudeSubprocessEnv()`; without it, `DISABLE_GROWTHBOOK=1` resolves `tengu_hazel_trellis` to its compiled-in default (3 as of 0.3.220).

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

> **Merge method matters:** the sync PR MUST be merged with **"Create a merge commit"** — never squash or rebase. Squashing flattens the branch's `git merge upstream/main` commit into a single-parent commit, so upstream's tip never becomes an ancestor of `main`: the repo keeps reading "behind", the next sync re-merges the same commit with re-conflicts, and the delta report's triple-dot diff misclassifies that release's files as fork-owned (`vorno-internal` LEARNING-036, PR #110). If it happens anyway, repair with `git merge -s ours upstream/main` on a branch and merge *that* PR with a merge commit.

### Step 6 — Update upstream tracking

After CI passes and PR merges, verify ancestry landed (`git rev-list --count main..upstream/main` must be `0` — if not, see the merge-method note above), then update:

- `INTERNAL_DIR/upstream/HEAD.md` — last merged tag, commit, merge PR link, date. `INTERNAL_DIR` is the local checkout of the private `Swagatar-LLC/vorno-internal` repo (maintainer convention: `~/dev/vorno-internal`) — the sync logs moved there when the main repo went public (2026-07-17). Commit and push `vorno-internal` after updating.
- `INTERNAL_DIR/upstream/delta.md` — refresh via `[skill:upstream-delta-report]` (same repo)
- `roadmap/upstream/compatibility.md` — public, stays in the main repo; add audit-log entry if any contracts touched

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
