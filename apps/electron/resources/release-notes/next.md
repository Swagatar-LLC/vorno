# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

## Bug Fixes

- **Port and rate-limit fields in Remote Access settings can now be typed into** — previously, clearing the field instantly snapped back to a default and every keystroke was saved as a real value (typing a port like 3999 could persist 3, 39, 399… along the way, silently changing which port the server uses). These fields now accept normal typing and apply the value when you press Enter or leave the field, clamped to the valid range.

## Breaking Changes
