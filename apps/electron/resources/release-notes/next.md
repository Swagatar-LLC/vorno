# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- Agents can create unstarted Tasks on the board with the new `create_task` tool — title, description, acceptance criteria, sources, skills, LLM connection/model, and working directory; Tasks inherit the current project unless another is specified, and unknown source/skill references become warnings instead of blocking creation (from upstream v0.11.2)
- Sessions can be sent between any two workspaces, including remote-to-local and local-to-local transfers (from upstream v0.11.2)

## Improvements

- Press Up arrow in a truly empty chat input to cancel the running turn and bring your last prompt back for editing (from upstream v0.11.2)
- In-app "background session finished" alerts are now off by default — enable them under Settings → Appearance (from upstream v0.11.2)
- Background task chips can be dismissed without stopping the task; a chip with no updates stops spinning and shows an Unknown state without claiming the task stopped (from upstream v0.11.2)

## Bug Fixes

- Large transfers involving a remote workspace now allow more time for bundle export/import, reducing timeouts on slower connections (from upstream v0.11.2)
- Queuing a message while the agent is still replying no longer pushes the in-progress response below your new message (from upstream v0.11.2)
- Queuing a message mid-turn no longer makes the agent treat its already-finished previous response as interrupted (from upstream v0.11.2)

## Breaking Changes
