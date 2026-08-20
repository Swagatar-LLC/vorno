# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Idle agent timeout is now a workspace setting** — an idle session's warm agent process is released after a configurable number of minutes (default 60; `0` keeps agents alive until quit). The session itself stays fully usable: the next message transparently restarts its agent and the conversation resumes where it left off. Find it under Workspace Settings → Advanced. ([#167](https://github.com/Swagatar-LLC/vorno/pull/167), `9d6d5549`)

## Improvements

## Bug Fixes

- **Idle and archived sessions no longer accumulate live agent processes.** Every session kept its agent subprocess alive until the app quit — scheduled automations added ~25–30 leaked processes a day, and archiving a session never released its runtime. Idle sessions past the workspace timeout and archived sessions now release their agent process; sessions with background tasks still running are never interrupted. ([#167](https://github.com/Swagatar-LLC/vorno/pull/167), `1cee69f9`)

## Breaking Changes
