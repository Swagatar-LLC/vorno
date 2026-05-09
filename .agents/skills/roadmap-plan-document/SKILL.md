---
name: roadmap-plan-document
description: Update docs to reflect a shipped plan, run a code review of the merged diff, append release-note bullets, then advance from done/ to documented/
---

# Skill: roadmap-plan-document

Take a plan in `roadmap/plans/done/` (code merged, docs not yet refreshed), update the relevant project documentation to match what shipped, run a code review of the merged diff for residual concerns, append a release-note entry to the plan's status log, and advance the plan to `documented/`.

This is the terminal docs-hygiene step in the plan lifecycle:

```
planned → in-progress → done → documented
                                 ▲
                                 └─ this skill
```

## When to invoke

- "Document PLAN-NNN" / "Move PLAN-NNN to documented"
- After verifying that one or more plans in `done/` have shipped and CI is green on `main`
- Periodically as a docs-hygiene sweep (e.g. every release cut, every upstream sync)

If the user passes multiple plan IDs, process them one at a time — each plan gets its own diff review, its own doc edits, and its own status-log entry. Don't batch the analysis.

## Inputs

- **plan-id** (required) — `PLAN-NNN`. Must currently live in `roadmap/plans/done/`. Refuse other statuses with a clear "run roadmap-plan-advance first" message.
- **release-note** (optional) — one-line summary the user wants on the status-log entry. If omitted, infer from the merged commits.
- **scope-hint** (optional) — paths the user wants you to focus the doc audit on (e.g. `packages/shared/CLAUDE.md`).

## Procedure

### 1. Locate and validate

1. Glob `roadmap/plans/done/PLAN-NNN-*.md`. If not found, error with which folder it actually lives in.
2. Read frontmatter. Confirm `status: done`. If frontmatter and folder disagree, surface the inconsistency rather than silently fixing.

### 2. Identify the merged work

Walk the plan's `## Status log` for PR numbers, commit SHAs, or merge dates. If absent or thin, fall back to:

```bash
git log --oneline --grep "PLAN-NNN" main
```

Collect every commit/PR that contributed. For each PR, capture its merge SHA and changed-files list. **Do not re-litigate the implementation** — that already happened at PR time. The goal here is to spot doc impact and code-review residue, not to re-review architecture.

### 3. Run a code review of the merged diff

Delegate a focused review to the `staff-code-reviewer` agent (Claude Code) or the equivalent code-review path on Codex / Pi Agent. Hand it:

- The plan's `## Acceptance` checklist
- The merged diff (`git show <sha>` per commit, or `git diff <base>..<head>` per PR)
- A note that this is a **post-merge docs-hygiene review** — the agent is looking for:
  - Acceptance items the merged code didn't actually cover
  - Hidden contracts or behaviors that need to be documented
  - Public APIs / scripts / config keys / file paths the merged code introduced that aren't yet referenced anywhere in `AGENTS.md` / `CLAUDE.md` / package CLAUDE.md / `roadmap/`
  - Any test coverage gaps or follow-ups worth a `LEARNING-NNN` or a follow-up plan

**Cap the review's scope**: it's not allowed to suggest refactors or reopen design questions for code that already shipped. If it does, summarize them as candidate follow-up plans for the user to triage — do not act on them in this skill.

### 4. Identify documentation that needs updating

For each merged change, check the corresponding doc surfaces:

| Change shape | Doc surfaces to audit |
|--------------|------------------------|
| New script in `package.json` | root `AGENTS.md` build/test commands, root `CLAUDE.md` quick commands, the script's own JSDoc/header |
| New CI job / workflow change | `.github/workflows/validate-pr.yml` comment block at top, root `AGENTS.md` "CI" section, `CLAUDE.md` "CI" section |
| New skill or skill change | `.agents/skills/README.md` table, root `AGENTS.md` skills list, root `CLAUDE.md` skills paragraph |
| New source/integration | `apps/electron/resources/AGENTS.md` if relevant, the source's own `guide.md` if shipped |
| New package / package contract change | the package's own `CLAUDE.md`, `packages/shared/CLAUDE.md` cross-refs, root `AGENTS.md` "Where things live" |
| New convention / hard rule | root `AGENTS.md` Hard rules, root `CLAUDE.md` Hard rules, package CLAUDE.md if scoped |
| New direction or paradigm move | `roadmap/directions/<DIR>.md` body + `related-plans` |
| Wire / protocol change | `roadmap/upstream/compatibility.md` (this should never happen without an ADR — flag if it did) |
| New runtime behavior / config flag | the package's `CLAUDE.md` Notes section |

If a check finds the doc is already accurate, note it but don't edit it. If a check finds drift, edit the doc. **Edits must be minimal and surgical** — do not reformat unrelated sections, do not "improve" prose that is already correct.

If the merged work introduced a non-obvious quirk that merits a `LEARNING-NNN`, scaffold one via `[skill:capture-learning]` and cross-reference it in the plan's status log. Don't skip this — the always-record-debugging-insights hard rule applies retroactively.

### 5. Update the plan file

In the plan's body:

- Tick any `## Acceptance` items that the merged code actually delivered. Leave unticked items unticked and surface them as gaps to the user — do not claim coverage you didn't verify.
- Append a status-log entry:
  ```
  - YYYY-MM-DD — moved from done to documented: <one-line release-note>. Docs touched: <comma-separated relative paths>.
  ```
- If acceptance gaps exist, add a `## Follow-ups` section (only if missing) listing them as candidates for new plans. Do not auto-create the follow-up plans — that's the user's call.

### 6. Advance the status

Invoke `[skill:roadmap-plan-advance] PLAN-NNN documented` to perform the `git mv done → documented` and rewrite the frontmatter `status` field. The advance skill is the single source of truth for status transitions; **do not** `git mv` directly.

### 7. Report

Return to the user:

- Which doc files you edited (or "none — docs already in sync").
- Code review summary (one paragraph; full review goes in PR description if a PR is opened).
- Any acceptance gaps and proposed follow-up plan titles.
- Suggested commit message: `roadmap: PLAN-NNN → documented` plus the doc paths edited.

**Do not commit.** The user (or another skill) commits and opens the PR. Suggested PR title: `roadmap: PLAN-NNN → documented`.

## Constraints

- **Refuse non-`done/` plans.** Tell the user to run `[skill:roadmap-plan-advance]` first.
- **No retroactive code edits.** This skill is docs-only. If the review finds shipped-code bugs, surface them as follow-up plans — do not patch the code in the documented PR.
- **No fabricated acceptance ticks.** Only tick items you verified against the merged diff.
- **No emojis.** Plain technical English (root `AGENTS.md` hard rule).
- **No marketing fluff.** Doc edits report what changed, not why it's exciting.
- **Don't reformat unrelated sections** of any doc you edit. Surgical patches only.
- **Don't run `git add` or commit.** The user commits.

## Tools you'll typically use

- `Glob` to locate the plan and audit doc surfaces
- `Bash` for `git log` / `git show` / `gh pr view <N>` (don't `gh pr merge`, don't push)
- `Read` for plan body, doc files, and merged diffs
- `Edit` for surgical doc updates and status-log appending
- The `staff-code-reviewer` agent (Claude Code) or equivalent for the code-review pass
- `[skill:capture-learning]` if a `LEARNING-NNN` is warranted
- `[skill:roadmap-plan-advance]` for the final status transition

## Edge cases

- **Plan in `in-progress/` or `blocked/`** — refuse. Tell the user to advance to `done/` first.
- **Plan already in `documented/`** — terminal. Refuse with a no-op message.
- **No status-log entry mentioning PRs/commits** — fall back to `git log --grep "PLAN-NNN"`. If still empty, ask the user which PR(s) to associate.
- **Acceptance items genuinely cannot be verified from the diff** (e.g. UI-only behaviors) — leave them unticked, note in the report, and either ask the user to verify manually or move them to follow-ups.
- **Multiple PRs for one plan** — review each separately; consolidate the doc audit so each surface is touched at most once.
- **Plan body asks for docs that don't exist yet** — create them at the path the plan specified, following the conventions of neighboring docs (frontmatter, tone, formatting). Don't invent a new doc location.

## Examples

```
roadmap-plan-document PLAN-004
  → reads roadmap/plans/done/PLAN-004-restore-i18n-coverage-lint.md
  → finds PR #17 in status log; pulls diff
  → audits: package.json (new script — already documented),
            packages/shared/CLAUDE.md i18n section (already documents the gate — no edit),
            .github/workflows/validate-pr.yml (new i18n gates job — comment block accurate),
            root AGENTS.md "CI" section (mentions five jobs — needs sixth)
  → edits: AGENTS.md to add the i18n gates job to the CI section
  → ticks acceptance items 1-5; flags item 6 as N/A
  → appends status-log: "- 2026-05-08 — moved from done to documented: i18n coverage
                        gate live in CI. Docs touched: AGENTS.md."
  → calls roadmap-plan-advance PLAN-004 documented
  → reports doc edits + suggests commit msg "roadmap: PLAN-004 → documented"
```
