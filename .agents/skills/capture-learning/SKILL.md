---
name: capture-learning
description: Scaffold a debugging-insight entry in roadmap/learnings/ with auto-assigned ID and standard frontmatter, then update the index
---

# Skill: capture-learning

After diagnosing a non-obvious bug, capture the insight as a `LEARNING-NNN` markdown so the next agent (or human) doesn't have to re-debug.

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

1. **Find the next ID.** Glob `roadmap/learnings/LEARNING-*.md`, parse `LEARNING-NNN`, take max + 1. Format as zero-padded three digits.
2. **Read** `roadmap/learnings/_template.md`.
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
5. **Write** the file to `roadmap/learnings/LEARNING-NNN-<kebab-slug>.md`.
6. **Update** `roadmap/learnings/README.md` — add a row to the index table.
7. **Don't commit.** The user (or another skill) commits, usually as part of the same PR that contains the fix.

## Constraints

- Never overwrite an existing learning entry.
- The Signal section is sacred — greppable strings matter more than narrative prose.
- Don't describe the fix in past tense ("we removed…"); describe it as instructions for whoever hits it next.
- Keep "Recurrence" honest. If you don't know when it'll bite again, say so.

## Tools

- `Glob` to find next ID
- `Read` for the template
- `Write` to create the entry
- `Edit` to update the README index

## Edge cases

- **Same root cause as an existing learning** — don't duplicate. Either update the existing entry's "Recurrence" section or create a sibling entry that cross-references.
- **Fix is upstream** — set `status: resolved-upstream` and document the upstream commit/PR in References. Keep the entry; future readers benefit from the history.
- **You're not sure if it's worth capturing** — capture it. The cost of a false positive is one short markdown file. The cost of a false negative is re-debugging.
