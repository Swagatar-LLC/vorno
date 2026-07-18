---
id: ADR-0009
title: Vorno rebrand — appId co.swagatar.vorno, public vorno-releases update feed, parameterized signing
status: accepted
date: 2026-07-13
supersedes: []
superseded-by: []
---

# ADR-0009 — Vorno rebrand: appId `co.swagatar.vorno`, public `vorno-releases` update feed, parameterized signing

## Context

The fork still ships upstream's app identity: electron-builder `appId:
com.lukilabs.craft-agent`, `productName: Craft Agents`, artifact names
`Craft-Agents-${arch}`, and — critically — `publish: { provider: generic, url:
https://agents.craft.do/electron/latest }`. That publish block points the
fork's electron-updater at **upstream's** feed, which serves builds signed by
upstream's own Apple identity. Local fork builds are ad-hoc signed
(`TeamIdentifier=not set`), so Squirrel.Mac's code-requirement validation
rejects the downloaded official build against the running fork app ("code
failed to satisfy specified code requirement(s)") — auto-update is structurally
broken for the fork today (see `vorno-internal:learnings/LEARNING-020-*`,
private repo). Full identity/signing detail: `vorno-internal`.

The identity is already half-flipped: ADR-0005 moved the config dir to
`~/.vorno-agent`, the headless unit ships as `vorno-server.service`, and the
VORNO productization program (tracked internally) names the productized fork.
What remains is the user-visible product identity, the bundle identity, and a
working release + auto-update pipeline the fork owns. The bundle-ID migration
and branding gate were sequenced to enable exactly this flip; the branding module
(`packages/core/src/branding.ts`) and gate (`scripts/check-branding.ts` +
`scripts/branding-allowlist.json`) were built so the rebrand is a one-module
flip plus a static-file sweep.

Constraints that shape the decision:

- The source repo (`Swagatar-LLC/craft-agents-oss`) is **private**. electron-
  updater's `github` provider needs unauthenticated access to release assets;
  no token may ship inside the app.
- The individual Apple Developer ID certificate is pending (tracked
  internally). The pipeline must be buildable and mergeable now, and start
  signing the day the cert lands, with zero rework.
- Squirrel.Mac ties update continuity to the bundle identifier. Whatever appId
  ships in the first published Vorno build is frozen forever.
- macOS Intel (x64) builds were discontinued upstream at v0.10.1 (arm64 only);
  the fork inherits that posture. `electron-builder.yml` still lists both
  arches — this ADR's implementation drops x64 from mac targets.

## Decision

1. **Product name: "Vorno".** `PRODUCT_NAME` and derived strings flip in
   `packages/core/src/branding.ts`; static files in the `flip-sync` /
   `flip-deferred` allowlist classes are swept in the same PR; the branding
   gate stays green and the allowlist is **tightened** (flipped entries
   removed) so regressions to "Craft Agents" fail CI. Artifacts become
   `Vorno-${arch}.dmg` / `.zip`. The visible FORK badge stays on (CLAUDE.md
   rule); the fork-vs-upstream distinction still matters while both run
   side-by-side.

2. **appId: `co.swagatar.vorno` — permanent.** Confirmed by the maintainer
   2026-07-13; once a build is published under it, it never changes (Squirrel
   continuity). The appId is independent of the Apple Team ID — the Team ID
   arrives with the cert and lives only in signing metadata, not the bundle
   identifier. Full identity/signing detail: `vorno-internal`.

3. **Update feed: dedicated public repo `Swagatar-LLC/vorno-releases`** via
   electron-updater's `github` provider (`owner: Swagatar-LLC`, `repo:
   vorno-releases`). Source stays private; release CI in the private repo
   publishes DMG + ZIP + `latest-mac.yml` to the public releases repo using a
   repo-scoped token that exists only as a CI secret (a fine-grained PAT or
   GitHub App token — the Actions-provided `GITHUB_TOKEN` is scoped to the
   repo the workflow runs in and cannot write cross-repo). **No token in the
   app.** The `vorno-releases` repo was created 2026-07-13 (confirmed).
   `UPDATE_MANIFEST_BASE_URL` decouples from `SERVICE_BASE_URL` and points at
   the releases repo.

4. **Signing is parameterized and deferred.** The release workflow gates the
   sign + notarize + staple + publish path on the presence of CI secrets
   (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`). Secrets absent → build ad-hoc for verification only and
   **never publish** (an ad-hoc build on the feed would brick updates for
   everyone who installed it). Secrets present → full path, no code changes
   needed.

5. **Runtime-configurable feed (PLAN-018)** complements the static publish
   block: an `updater-config.json` in `CONFIG_DIR` whose default is the
   vorno-releases github feed, editable in Settings. The yml `publish:` block
   remains the packaged default (`app-update.yml`); runtime config overrides
   it via `autoUpdater.setFeedURL()`.

6. **Clean break from upstream identity.** A new appId means macOS treats
   Vorno as a **different application**: the first Vorno build is a fresh
   `/Applications` install, not an in-place update of any existing "Craft
   Agents" install (official or fork-built). Existing installs are neither
   migrated nor uninstalled. User data is unaffected — the config dir is
   already fork-owned (`~/.vorno-agent`, ADR-0005). A minimal one-shot install
   script drops the first signed Vorno build into `/Applications`; Squirrel
   handles everything after that.

### Explicitly NOT rebranded

- **Wire contracts** (compatibility.md): `craft_sk_*` key prefixes,
  `craft-fork:*` RPC namespaces, `__craftRpcType`, MessageEnvelope fields,
  `CRAFT_CONFIG_DIR` env var, `~/.craft-agent` migration-source paths.
- **Upstream service endpoints the fork still consumes**: `SERVICE_BASE_URL`
  and derivatives (viewer, docs, OAuth relay). The OAuth relay callback URLs
  are registered with providers; flipping them without Swagatar-hosted relay
  infrastructure would break source OAuth. These are service dependencies,
  not branding. Only `UPDATE_MANIFEST_BASE_URL` leaves this group.
- **`OAUTH_CLIENT_NAME`** ("Claude Code (Craft Agent)") — some MCP
  authorization servers gate on it; flip deferred to its own change.

## Consequences

### Positive

- Auto-update works end-to-end for the fork: fork-owned feed, fork-signed
  builds, Squirrel-validating chain — the auto-update failure class (private
  `vorno-internal:learnings/LEARNING-020-*`) is eliminated by construction.
- Zero-rework signing: the cert landing is a secrets-configuration event, not
  a code change.
- The branding gate flips from "hold upstream identity stable" to "enforce
  Vorno identity" — regressions fail CI in both directions.
- Distribution requires no Swagatar-hosted infrastructure (GitHub releases +
  github provider; no S3/R2 bucket, no token in the app).

### Negative

- The appId is a one-way door; a wrong choice cannot be corrected after first
  publish. Mitigated by the explicit PR-review confirmation gate.
- Users of the old fork-built "Craft Agents" app must manually install Vorno
  once (clean break). Acceptable: today's population is one person.
- Release assets are public even though source is private. Acceptable: the
  app is a build of (mostly) public upstream code; secrets never enter
  artifacts.
- A wider one-time diff against upstream in `electron-builder.yml`,
  `package.json`, i18n locales, and static HTML — recorded in the private
  upstream-delta log (`vorno-internal`); future upstream syncs will conflict on
  these files predictably.

### Neutral

- Until the cert lands, no build is published; the feed repo can exist empty
  and the runtime updater handles a 404/empty feed gracefully.
- Windows/Linux lanes keep their config but are not published (mac arm64
  only, matching upstream's platform posture and the fork's actual user base).
- Icon assets remain the upstream art until a Vorno icon is designed — an
  explicit human/design step, not silently shipped as "done" (PLAN-019).

## Alternatives considered

- **Generic provider on Swagatar-owned S3/R2** — mirrors upstream's setup, but
  adds bucket infrastructure, credential management, and upload tooling for no
  benefit at this scale. Rejected.
- **Releases on the private repo** — electron-updater would need an embedded
  token with private-repo read scope; shipping any token in a distributed app
  is disqualifying. Rejected.
- **Keep "Craft Agents" name, change only the feed** — leaves two identically
  named apps (official + fork) on one machine and squats on upstream's
  trademark-adjacent identity while diverging. The VORNO ladder exists
  precisely to productize the fork under its own name. Rejected.
- **Reuse `com.lukilabs.craft-agent` appId with the new feed** — would make
  Vorno impersonate the official app's identity (Squirrel would happily
  cross-update between them given signature compatibility) and permanently
  couples the fork to upstream's namespace. Rejected.

## References

- `vorno-internal:learnings/LEARNING-020-*` (private) — ad-hoc fork + upstream
  feed → Squirrel code-requirement failure (the motivating breakage).
- ADR-0005 — fork-owned config dir `~/.vorno-agent` (the identity flip's first
  half; makes the clean break data-safe).
- PLAN-018 — runtime-configurable update feed + Updates settings UI.
- PLAN-019 — rebrand + release pipeline implementation of this ADR.
- Bundle-ID migration, branding gate, and signing path (Apple enrollment = M2
  critical path) — tracked internally.
- `scripts/check-branding.ts`, `scripts/branding-allowlist.json` — the gate
  this ADR's implementation must keep green and tighten.
- `roadmap/upstream/compatibility.md` — wire contracts unaffected.
