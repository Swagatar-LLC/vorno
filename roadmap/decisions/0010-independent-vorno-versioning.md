---
id: ADR-0010
title: Vorno versions independently of upstream from 0.11.2 onward
status: accepted
date: 2026-07-13
supersedes: []
superseded-by: []
---

# ADR-0010 — Vorno versions independently of upstream from 0.11.2 onward

## Context

Through v0.11.1 the fork's version numbers mirrored upstream's release tags: an upstream sync brought the version stamp along, and fork builds shipped under upstream's number. That worked while the fork was a patched build of upstream.

Two things changed:

1. **Vorno released ahead of upstream.** v0.11.2 (2026-07-13) is a fork-authored release — Developer ID signing + notarization, the fork-owned update feed, the tag-triggered release pipeline — with no upstream counterpart. Upstream will eventually publish its own 0.11.2, and the two would collide: in git tags, in the release feed's semver ordering, and in the in-app "What's New" panel (release-notes files are keyed by version string).
2. **Vorno is now treated as a semi-polished product** (VORNO productization program, tracked internally): signed, notarized, auto-updating, with its own icon, branding, changelog, and release feed. A product's version is a promise to its users about *its own* releases, not a mirror of someone else's.

## Decision

**Vorno maintains its own semantic versioning, decoupled from upstream, starting at v0.11.2.**

Elaboration:

- The version in `apps/electron/package.json`, git `v*` tags, the update feed (`Swagatar-LLC/vorno-releases`), and `release-notes/{version}.md` files are all **Vorno-owned** from 0.11.2 onward. Versions ≤ 0.11.1 remain historically shared with upstream.
- Upstream syncs are **features-in, not versions-in**: an upstream merge never changes Vorno's version, and upstream release tags are tracked by their own tag names in the private upstream `HEAD.md` (`vorno-internal`) and public `compatibility.md` — that mapping (Vorno version ⇄ last-merged upstream tag) is the compatibility record.
- **Release notes**: upstream's `release-notes/{version}.md` files are no longer adopted as versioned files during syncs. Notable upstream features folded in by a sync get summarized as bullets in `next.md` (attributed "from upstream") and ship under the next Vorno version. Existing upstream-authored files ≤ 0.11.1 stay as history.
- **Wire compatibility is unaffected.** The protocol contract (`roadmap/upstream/compatibility.md`) is orthogonal to version numbering; audits continue per upstream merge exactly as before.
- Version bumps follow semver by Vorno's own release content: patch for fixes, minor for features, and 1.0 when the VORNO program ladder (tracked internally) says the product promise is met.

## Consequences

### Positive

- No future collision with upstream tags in our repo, feed, or changelog.
- "What's New" reads as one coherent Vorno story (per the 0.11.2 backfill).
- Release cadence is ours — we can ship signed releases whenever value lands, without waiting to shadow an upstream tag.

### Negative

- A Vorno version no longer telegraphs which upstream it contains; you must consult the private upstream `HEAD.md` (`vorno-internal`) / public `compatibility.md` for the mapping.
- Upstream-sync conflict resolution gains two standing rules (version stamp = ours; upstream release-notes files = don't adopt).

### Neutral

- Upstream's own 0.11.2+ tags will exist in the `upstream` remote with different content than our identical-looking tags. Our tags live in `origin`; git handles this fine, but never push our `v*` tags upstream or fetch upstream tags into `origin`.
- If upstream's numbering someday runs far ahead (e.g. their 0.14 vs our 0.12), that's cosmetic — resist the urge to "catch up" by skipping numbers.

## Alternatives considered

- **Keep mirroring upstream versions, suffix fork builds (e.g. `0.11.2-vorno.1`)** — rejected: prerelease suffixes sort *below* the base version in semver, which breaks electron-updater feed ordering, and the suffix leaks fork-internals into a product surface.
- **Jump to a clean break (e.g. 1.0 or 2026.x calendar versioning)** — rejected for now: 1.0 is a milestone the VORNO ladder should earn, and a numbering-scheme change mid-stream costs user trust for zero functional gain. Continuing the 0.11.x line preserves feed continuity for the already-installed 0.11.1/0.11.2 fleet.

## References

- [ADR-0009](0009-vorno-rebrand-appid-release-feed-signing.md) — rebrand, appId, release feed, signing (the release infrastructure this decision builds on)
- [`roadmap/upstream/compatibility.md`](../upstream/compatibility.md) — wire-contract audits (unchanged by this ADR)
- [`.agents/skills/upstream-sync/SKILL.md`](../../.agents/skills/upstream-sync/SKILL.md) — sync mechanics updated per this ADR
- VORNO program hub (internal) — product ladder to 1.0
