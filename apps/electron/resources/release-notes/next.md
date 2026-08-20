# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- New workspace setting **Idle agent timeout**: an idle session's warm agent process is now released after a configurable number of minutes (default 60, `0` disables). Sessions resume transparently on their next message.

## Improvements

## Bug Fixes

- Fixed unbounded accumulation of idle agent subprocesses: sessions that finished a turn (including scheduled-automation runs) kept a live agent process forever, and archiving a session never released it. Idle and archived sessions now release their agent process; background tasks in flight are never interrupted.

## Breaking Changes
