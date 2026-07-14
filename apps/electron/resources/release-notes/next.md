# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

## Bug Fixes

- **The browser WebUI works in packaged builds** — opening `http://127.0.0.1:3848` returned a bare "Internal Server Error" instead of the login page. Two packaged-only bugs: the login redirect used an API that throws in the packaged runtime (but not in tests), and the WebUI's bundled assets were looked up at a path that never exists in the installed app. Both fixed; handler failures now also land in the main log instead of vanishing.

## Breaking Changes
