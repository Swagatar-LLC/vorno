---
id: ADR-0020
title: Additive vorno:// deep-link scheme alongside frozen craftagents://
status: accepted
date: 2026-07-26
supersedes: []
superseded-by: []
---

# ADR-0020 — Additive `vorno://` deep-link scheme alongside frozen `craftagents://`

## Context

The app registers a single OS deep-link scheme, `craftagents://` (`setAsDefaultProtocolClient` in `apps/electron/src/main/index.ts`; parser in `apps/electron/src/main/deep-link.ts`). Jeff runs upstream stable side-by-side with Vorno, and both apps claim `craftagents://` — macOS Launch Services picks one handler nondeterministically, so a deep link (e.g. from an ntfy notification) may open the wrong app. `craftagents://` is part of the frozen upstream-compat surface (`roadmap/upstream/compatibility.md`, ADR-0001/0009) and cannot be dropped or renamed. ADR-0012 already establishes the pattern for this situation: freeze Craft-named identifiers, add new capability under a `vorno` namespace.

## Decision

1. **Register `vorno://` as a second deep-link scheme**, additively, everywhere `craftagents://` is handled today: OS protocol registration (`setAsDefaultProtocolClient`, both schemes, plus a `protocols` declaration in `electron-builder.yml` so packaged builds carry `CFBundleURLTypes`), the deep-link parser, the second-instance command-line scan (Windows/Linux), the internal-deeplink URL classifier (`packages/shared/src/utils/url-safety.ts`), and the server-core `OPEN_URL` internal router.
2. **`vorno://` and `craftagents://` are byte-for-byte equivalent** in path/route grammar. No `vorno://`-only routes; new routes always ship on both schemes.
3. **`craftagents://` remains handled forever** — frozen per the compatibility contract. No `craft*` identifier is renamed or removed; the change is purely additive.
4. **`vorno://` is the preferred scheme for Vorno-generated links** (notifications, copied session links) because only Vorno claims it, making OS routing deterministic in side-by-side installs. Migration of link *producers* is incremental and out of scope here.
5. The `CRAFT_DEEPLINK_SCHEME` env override (multi-instance dev) keeps its meaning: when set, it replaces the default scheme list with that single scheme.

## Consequences

- Side-by-side installs get a deterministic deep-link path: `vorno://…` always reaches Vorno; `craftagents://…` keeps working but stays subject to Launch Services arbitration.
- Two schemes coexist indefinitely; docs and link producers should prefer `vorno://` while never assuming `craftagents://` is gone.
- Upstream syncs stay cheap: fork delta is small, marked `fork(ADR-0020)`, and never collides with upstream edits to the frozen scheme string.
