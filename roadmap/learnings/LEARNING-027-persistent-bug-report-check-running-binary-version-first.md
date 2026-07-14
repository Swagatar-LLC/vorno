---
id: LEARNING-027
title: "Persistent" bug after a shipped fix — check the running binary's version before re-debugging
date: 2026-07-14
status: active
component: release / auto-update
related-plans: [PLAN-020]
related-decisions: [ADR-0010]
---

# LEARNING-027 — A fixed bug that "persists" is usually a deployment-chain gap, not a code regression

## Signal

Hours after the LEARNING-026 WebUI 500 fix merged and shipped in v0.11.5, the
installed app still returned the exact pre-fix signature (`GET /` → 500,
`GET /login` → 404). A second debugging session was spun up to "squash the
persistent bug."

## Root cause

There was no new bug. The running app was still **0.11.4** — electron-updater
had already downloaded v0.11.5 (`Update downloaded: v0.11.5` in
auto-update.log) but updates only install on quit/relaunch, which is Jeff's
action. The pre-fix binary kept serving the pre-fix behavior.

## The 5-minute triage that should come FIRST

Before re-debugging any "fix didn't take" report:

1. **Version of the running/installed binary** —
   `defaults read /Applications/Vorno.app/Contents/Info.plist CFBundleShortVersionString`
   (the `<craft_agent_environment version="...">` header in agent sessions
   also carries it).
2. **Is the fix in the tag the user should have?** —
   `git merge-base --is-ancestor <fix-sha> vX.Y.Z`.
3. **Auto-update state** — `~/.craft-agent/logs/auto-update.log`; a trailing
   `Update downloaded: vX.Y.Z` with no `Installing update` after it means the
   fix is sitting on disk waiting for a restart.
4. **Does the shipped artifact actually contain the fix?** — download the DMG
   from vorno-releases, mount, grep `dist/main.cjs` for the old/new code and
   confirm `dist/resources/webui/` staging. (Verified clean for 0.11.5.)

Steps 1–3 take minutes and would have closed this immediately; step 4 is the
release-integrity check worth doing once per report anyway.

## Related

- LEARNING-026 (the underlying WebUI 500 code bugs)
- LEARNING-025 (version-display lied about the running version — 0.11.2/0.11.3
  builds showed "0.11.1", which makes step 1 above extra important: trust
  Info.plist, not the About dialog, on pre-0.11.4 builds)
