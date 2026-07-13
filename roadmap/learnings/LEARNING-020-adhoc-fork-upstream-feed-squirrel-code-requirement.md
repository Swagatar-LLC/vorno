---
id: LEARNING-020
title: Ad-hoc-signed fork on the upstream update feed fails Squirrel.Mac code-requirement validation
date: 2026-07-13
status: active
component: electron
related-plans: [PLAN-018, PLAN-019]
related-decisions: [ADR-0009]
---

# LEARNING-020 — Ad-hoc-signed fork on the upstream update feed fails Squirrel.Mac code-requirement validation

## Signal

Auto-update downloads complete but installation fails; electron-updater / Squirrel.Mac logs show:

```
code failed to satisfy specified code requirement(s)
```

The running app is a local fork build; `codesign -dv` on it shows:

```
Signature=adhoc
flags=0x20002(adhoc,linker-signed)
TeamIdentifier=not set
```

while the downloaded update (from `https://agents.craft.do/electron/latest`) is signed by "Craft Docs Limited (LVV532B7S8)".

## Root cause

`apps/electron/electron-builder.yml` ships upstream's `publish:` block (`provider: generic`, `url: https://agents.craft.do/electron/latest`), so every fork build's packaged `app-update.yml` points electron-updater at **upstream's** feed. Squirrel.Mac validates the downloaded app bundle against the *running* app's code-signing requirement before swapping bundles. A locally built fork is ad-hoc signed (`TeamIdentifier=not set`); the feed serves Developer-ID-signed official builds (team `LVV532B7S8`). The identities can never match, so validation fails by construction — this is Squirrel working as designed, not a transient error. (Had it succeeded, the "update" would have silently replaced the fork with the official upstream app.)

## Fix

Do not point fork builds at a feed serving builds signed with a different identity chain. Structural fix (ADR-0009 / PLAN-018 / PLAN-019):

- Repoint `publish:` to the fork-owned feed (github provider, `Swagatar-LLC/vorno-releases`) and make the feed runtime-configurable (`updater-config.json`, PLAN-018).
- Only publish builds signed with the fork's own Developer ID; when signing secrets are absent, CI builds ad-hoc for verification and **skips publish**.

Interim: ad-hoc dev builds simply cannot auto-update — install manually and ignore updater errors.

Diagnosis commands:

```bash
# what identity is the running app?
codesign -dv --verbose=2 "/Applications/Craft Agents.app" 2>&1 | grep -E 'Signature|TeamIdentifier|flags'

# what feed does the packaged build point at?
cat "/Applications/Craft Agents.app/Contents/Resources/app-update.yml"
```

## Recurrence

Any time a build signed with identity A checks a feed serving builds signed with identity B: ad-hoc dev build + signed feed, a future cert rotation to a different Team ID, or a mispointed `publish:` block after an upstream sync (the yml is upstream-synced and will try to reintroduce `agents.craft.do` on every merge until PLAN-019 lands).

## Prevention

- ADR-0009 makes feed + signing fork-owned; the branding gate's allowlist rule ties the yml publish URL to `UPDATE_MANIFEST_BASE_URL`, so an upstream-sync regression of the feed URL fails CI once PLAN-019 tightens the allowlist.
- Release workflow hard-gates publishing on signing secrets — an ad-hoc artifact can never reach the feed.

## References

- ADR-0009 — Vorno rebrand, appId, feed strategy, signing posture.
- PLAN-018 — runtime-configurable feed; PLAN-019 — publish-block flip + release pipeline.
- Squirrel.Mac code-signing validation (designated-requirement check before bundle swap).
