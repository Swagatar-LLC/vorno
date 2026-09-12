# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

- **Host-consented Page actions** — Page capabilities now require approval in a native dialog tied to the requesting workspace window. Approvals are digest-bound, expiring, revocable, and safely serialized when multiple Pages request access. #201, SUV-0059, 74ccdac
- **Confirmed Page actions** — a Page that wants to act on your behalf now asks first. The action it is about to run is described in a native dialog the first time you use each approved capability in a view, and every action afterwards needs a real click you just made. Actions cannot fire on page load, on a timer, from a hover, or from a stale window, and approving one action never approves a different one — if the underlying command changes, you are asked again. Available in the desktop app, which is the only place a click can be confirmed; the web interface can still view Pages and read data, but will decline actions that change things. #204, SUV-0065, 9a8531ba
- **Secure optional Pages sharing** — publish Pages to an isolated public service with password protection, immediate logical revocation, and explicit cleanup recovery; sharing remains disabled until a workspace enables it. #202, 06de5295
- **Per-workspace Pages availability** — Pages now stays disabled until enabled in a workspace’s Settings, with its navigation, authoring tools, refresh scheduling, and publication controls following the same persisted host authority. Cleanup remains available if Pages is turned back off. #200, 891060be
- **Workspace Pages foundation** — persistent local pages, sandboxed rendering, data refresh, and mediated action contracts are present as an upstream compatibility baseline. Pages and publication remain unavailable by default in Vorno until the per-workspace authority and service boundaries land. (from upstream v0.13.0–v0.13.3)
- **Expanded model catalog** — upstream additions include Claude Fable 5.1 across Anthropic and Bedrock profiles, GPT-6 Astra for OpenAI and ChatGPT connections, and newer Pi-provider model families. Existing saved connections retain explicit defaults; new OpenAI and ChatGPT connections default to GPT-6 Astra. (from upstream v0.13.1–v0.13.3)

## Improvements

- **More resilient Pi conversations** — upstream retry/recovery work keeps eligible transient provider failures open with visible backoff progress, discards failed partial output, and bounds utility-query execution. (from upstream v0.13.3)
- **Updated Claude and Pi SDKs** — upstream SDK updates add improved usage/cost reporting, MCP resource links, model catalog coverage, and streaming/recovery fixes. (from upstream v0.13.1–v0.13.3)

## Bug Fixes

- **Reliable session saving across workspaces and windows** — session saving is now tracked per workspace as well as per session, serialized so two saves for one session cannot overlap, and reconciled field by field against outside edits. Four faults went with it. Two workspaces holding the same session id — which happens whenever a workspace is copied, restored from a backup, or cloned between machines — were treated as one session, so deleting the session in one could delete the other's live transcript. A session renamed, relabelled, flagged, or marked read in another window, by a sync tool, or by a second running copy of Vorno could have that edit undone a moment later by a save already in flight. A plan accepted with "Accept & Compact" was kept only on disk, so the next save deleted it and the plan never ran. And text typed but not sent when accepting a plan was included in the session list pushed to every connected client; it now stays on disk for recovery only. Quitting the app also waits for a session save that is already in progress instead of exiting mid-write, and a save that fails no longer causes the next one to overwrite your unsaved change with what was on disk. #206, SUV-0066, 07c3d27c
- **Safer diagnostics redaction** — shared Sentry and diagnostic redaction now removes sensitive headers and breadcrumb fields consistently across main and renderer processes. (from upstream v0.13.3)
- **Clearer CLI failures** — upstream CLI runs now preserve structured provider errors, return nonzero exit status on failure, and mark discarded partial output explicitly. (from upstream v0.13.3)

## Breaking Changes
