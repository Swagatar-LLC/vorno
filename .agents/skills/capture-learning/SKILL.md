---
name: capture-learning
description: Scaffold a debugging-insight entry in the private vorno-internal learnings/ corpus with an allocated ID and standard frontmatter, then update the index
---

# Skill: capture-learning

After diagnosing a non-obvious bug, capture the insight as a `LEARNING-NNN` markdown so the next agent (or human) doesn't have to re-debug.

## Where learnings live

**The private `Swagatar-LLC/vorno-internal` repo, under `learnings/` — never the public `vorno` repo.** The public repository has no `roadmap/learnings/` directory; writing one there leaks internal material and lands it where nobody reads it. See the public/private split in the public repo's `roadmap/README.md`.

Local clone: `~/dev/vorno-internal/` (`learnings/`, `learnings/_template.md`, `learnings/README.md`). If it is missing, clone it rather than falling back to the public repo.

Because it is a **separate repository**, the learning is its own commit there. It cannot ride the PR that carries the fix, and the fix's PR will legitimately contain no `LEARNING-NNN` file — reference the entry from the PR as `vorno-internal:learnings/LEARNING-NNN-...` and cite the internal commit instead.

## Hard rule

This is invoked **automatically** as part of any meaningful debugging fix — not just on user request. See the rule in root `AGENTS.md` / `CLAUDE.md`. If you've fixed something whose solution wasn't trivially derivable from the error message, capture it before moving on.

## When to invoke

Trigger on:

- A non-trivial build/runtime/test failure that you root-caused
- A workaround for upstream behavior
- A recurring issue you've fixed before (or anticipate will recur)
- Any fix that required reading multiple files, comparing versions, or thinking about resolution order

Skip on:

- Trivial typo fixes in your own freshly-written code
- Removing code you just added that didn't work (you haven't *learned* anything reusable)

## Inputs

Ask for or infer:

- **title** (required) — short imperative, e.g. *"Stale nested @mariozechner deps in workspace packages"*
- **component** (required) — tag like `build`, `tests`, `upstream-sync`, `electron`, `server`, `agent`
- **signal** (required) — exact error message or symptom, verbatim where possible
- **root-cause** (required) — why it happens
- **fix** (required) — exact remediation (commands, code)
- **recurrence** (optional) — when it'll likely come back
- **prevention** (optional) — anything to keep it from recurring

## Procedure

1. **Allocate the next ID — ask history, not the working tree.** In the `vorno-internal` clone:

   ```bash
   git log --all --pretty=format: --name-only -- learnings \
     | grep -o 'LEARNING-[0-9]\{3\}' | sort -u | tail -1
   ```

   Take that + 1, zero-padded to three digits. **Never glob the directory** (ADR-0030): a glob sees only the branch you are standing on, so an id minted on an unmerged branch is invisible and you will reissue it. **Never add `--diff-filter=A`** either — git reports a renumber as a rename, so an add-filter misses ids that entered by being renamed into.
2. **Read** `learnings/_template.md`.
3. **Fill the frontmatter:**
   - `id`: new ID
   - `title`: user/inferred title
   - `date`: today's date (`YYYY-MM-DD`)
   - `status`: `active`
   - `component`: tag
   - `related-plans`, `related-decisions`: empty unless obvious
4. **Fill the body** — Signal, Root cause, Fix, Recurrence, Prevention, References.
   - **Signal section MUST quote the error verbatim** in a code block. Greppability is the point.
   - **Fix section MUST be runnable** — commands in code blocks, not prose.
5. **Write** the file to `learnings/LEARNING-NNN-<kebab-slug>.md` in the `vorno-internal` clone.
6. **Update** `learnings/README.md` — add a row to the index table.
7. **Commit in `vorno-internal`, on its own.** The fix's PR lives in the public repo and cannot carry this file. Commit and push the learning there, then quote the resulting commit SHA wherever the fix is reviewed.

## Constraints

- Never overwrite an existing learning entry.
- The Signal section is sacred — greppable strings matter more than narrative prose.
- Don't describe the fix in past tense ("we removed…"); describe it as instructions for whoever hits it next.
- Keep "Recurrence" honest. If you don't know when it'll bite again, say so.

## Tools

- `Bash` (`git log --all`) to allocate the next ID — not `Glob`, which cannot see other refs
- `Read` for the template
- `Write` to create the entry
- `Edit` to update the README index

## Edge cases

- **Same root cause as an existing learning** — don't duplicate. Either update the existing entry's "Recurrence" section or create a sibling entry that cross-references.
- **Fix is upstream** — set `status: resolved-upstream` and document the upstream commit/PR in References. Keep the entry; future readers benefit from the history.
- **You're not sure if it's worth capturing** — capture it. The cost of a false positive is one short markdown file. The cost of a false negative is re-debugging.
