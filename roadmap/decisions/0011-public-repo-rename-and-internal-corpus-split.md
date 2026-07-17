---
id: ADR-0011
title: Public source repo, rename to Swagatar-LLC/vorno, private internal corpus split
status: accepted
date: 2026-07-17
supersedes: []
superseded-by: []
---

# ADR-0011 — Public source repo, rename to `Swagatar-LLC/vorno`, private internal corpus split

## Context

The source repo has been private since the fork began. The maintainer wants the project developed in the open: a public repository, a published roadmap, and a public issue surface. A full-history secret scan (gitleaks, 2,475 commits) found `main` clean — the only real secret in any reachable history (an encrypted SSH key) exists solely on an upstream-remote branch that is not part of this repo's published refs.

The `roadmap/` directory mixed publishable material (ADRs, feature plans, directions, vision) with internal working detail: engineering postmortems (LEARNINGs), upstream-sync bookkeeping, QA runbooks, internal ticket IDs, private spec links, and signing-identity discussion.

Trademark clearance for the "Vorno" name has not yet been commissioned. The maintainer explicitly accepted the exposure risk of going public under the name before a clearance opinion, and is starting the legal thread in parallel.

## Decision

1. **The repo goes public**, renamed **`Swagatar-LLC/craft-agents-oss` → `Swagatar-LLC/vorno`**. GitHub redirects the old slug; the upstream remote (`craft-ai-agents/craft-agents-oss`) is unaffected. The local checkout convention becomes `~/dev/vorno`.
2. **Publish explicit branches only — never `git push --mirror`.** Upstream-remote refs are never pushed to `origin`. Stale merged branches are pruned before the visibility flip.
3. **Internal corpus splits to a private repo, `Swagatar-LLC/vorno-internal`** (local convention `~/dev/vorno-internal`): all `learnings/`, `upstream/{HEAD,delta,contribution-candidates}.md`, internal-only plans and discussions. New LEARNINGs land there. Public files cross-reference it as `vorno-internal:<path>`.
4. **What stays public in `roadmap/`:** decisions (thoroughly scrubbed), feature plans (scrubbed), directions, VISION, `upstream/compatibility.md` (the wire-compat contract is a public commitment). Scrub rules: no private spec URLs, internal ticket IDs, session codenames, signing identifiers, or personal contact info beyond `support@swagatar.co`.
5. **User-facing surfaces are brand-complete before the flip:** top-level docs say Vorno, the CLI command is `vorno-cli`, and the curated public `ROADMAP.md` exists at the repo root.

## Consequences

- Git history retains pre-scrub versions of roadmap files (internal ticket IDs, since-revoked spec links). Accepted: the scan confirms nothing secret; the residue is cosmetic, and a history rewrite is not warranted.
- The daily upstream-sync automation now writes sync logs to `vorno-internal` and must have that checkout present.
- Anything merged to `main` from this point is public immediately; sensitive material must go to `vorno-internal` first, not be scrubbed after the fact.
- The trademark risk (Vornado/Vorne proximity) is carried consciously until clearance; if clearance fails, a rename would be another repo redirect plus a product rebrand — painful but survivable.
