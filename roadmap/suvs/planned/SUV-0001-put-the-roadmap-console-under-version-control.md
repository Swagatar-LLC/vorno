---
id: SUV-0001
title: Put the roadmap console under version control
status: planned
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-23
related: []
blocked-by: []
---

# SUV-0001 — Put the roadmap console under version control

## Goal

`~/.craft-agent/serve/apps/vorno-roadmap/` becomes a git repository with a
remote, an ignore file, and a stated branch discipline.

## Scope

- `git init` in the console directory; initial commit of the current working
  tree as-is (no cleanup pass — history starts where it starts).
- `.gitignore` covering caches, `__pycache__`, and any local state the console
  writes beside itself. Nothing that references a roadmap repo path.
- A remote under `Swagatar-LLC`. Decide public vs private on the same axis the
  roadmap split uses: the console can write to *both* roadmap repos and may
  embed private-repo paths, so default to **private** unless an audit of the
  tree shows it clean.
- A short `README.md`: what the console is, how to run it, and the branch
  discipline — feature branches, never push to `main`.

## Non-scope

- No refactor, no dependency changes, no feature work. This SUV is history and
  a backup, nothing else.

## Acceptance

- [ ] `git -C ~/.craft-agent/serve/apps/vorno-roadmap log` shows at least one commit.
- [ ] `git remote -v` resolves to a `Swagatar-LLC` remote and `git push` succeeds on a branch.
- [ ] `git status` is clean after a normal console run — no untracked state files.
- [ ] The README states the public/private choice and the reason for it.
- [ ] `grep -r` over the tracked tree finds no credential, token, or absolute private-repo path.

## Status log

- `2026-08-23` — created in `planned/`. Partially landed already: the console has a local repo (`89fdbff`, "Initial commit") and a `.gitignore`. Outstanding: the remote, the public/private decision, and the README branch-discipline section.
