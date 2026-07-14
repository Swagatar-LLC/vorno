# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **New Vorno app icon** — The app now ships the Vorno vortex-"V" identity across every icon surface: macOS Dock/Finder (`icon.icns`), macOS 26+ Liquid Glass (layered `AppIcon.icon` compiled to `Assets.car`), Windows (`icon.ico`), and Linux (`icon.png`). The Liquid Glass icon is built from three depth layers (background, vortex, white V) so Tahoe renders it with real glass parallax. Also fixes the icon asset/`CFBundleIconName` mismatch that prevented the Liquid Glass icon from loading at all.

## Improvements

- **In-app Vorno branding** — The splash/loading screen, app menu, and onboarding/reauth screens now show the Vorno vortex-"V" mark instead of the old Craft "C" symbol, and the bundled logo assets (`craft-logos/`, `craft_logo_c.svg`) carry the new identity.
- **"What's New" now carries the Vorno changelog** — Fork releases get their own release-notes entries (starting with the backfilled 0.11.2 notes), so the in-app What's New panel reflects what actually shipped in Vorno rather than only upstream history.

## Bug Fixes

## Breaking Changes
