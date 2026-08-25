---
id: SUV-0001
title: Put the roadmap console under version control
status: done
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
- `2026-08-23` — moved from `planned` to `in-progress`: Repo initialised (89fdbff); .gitignore, vendored assets committed deliberately, README documents branch discipline.
- `2026-08-23` — moved from `in-progress` to `blocked`: Local repo done, but two acceptance criteria remain open and both hinge on one owner decision. There is no remote, so the push criterion cannot be met. The private-path criterion is coupled to the same call: corpus.py documents the internal corpus root (~/dev/vorno-internal) in its module docstring, which is a private-repo path only if this repo goes public. Resolve the public/private question and both close together.
- `2026-08-23` — moved from `blocked` to `in-progress`: Unblocked by owner: the console repo is a temporary PRIVATE repo in the Swagatar-LLC org, so the internal-corpus path in corpus.py carries no leak risk.
- `2026-08-23` — moved from `in-progress` to `done`: Remote created and pushed: https://github.com/Swagatar-LLC/vorno-roadmap-console (private=true, verified). main and plan-043-p2-suv-corpus-type both tracking. Pushed over HTTPS — the SSH remote gh set by default could not authenticate. All five acceptance criteria now met; the private-path criterion is satisfied by the repo being private rather than by removing the path.
