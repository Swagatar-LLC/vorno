---
id: LEARNING-024
title: actool with --app-icon exits 0 but writes no Assets.car; the .icon filename (not a flag) must match CFBundleIconName
date: 2026-07-13
status: active
component: electron
related-plans: []
related-decisions: []
---

# LEARNING-024 — actool with `--app-icon` exits 0 but writes no Assets.car; the `.icon` filename (not a flag) must match CFBundleIconName

## Signal

Running the documented Liquid Glass regeneration command (Xcode 26.2's actool) "succeeds" but changes nothing:

```
$ xcrun actool "resources/icon.icon" --compile "resources" \
    --app-icon AppIcon --minimum-deployment-target 26.0 \
    --platform macosx --output-partial-info-plist /dev/null
/* exits 0; plist output lists ONLY the partial plist: */
	<key>output-files</key>
	<array>
		<string>/dev/null</string>
	</array>
```

`resources/Assets.car` keeps its old size/mtime (17.6K stale catalog). No warning, no error — the only tell is that `Assets.car` is absent from `output-files`.

Second, subtler failure even when a car exists: the compiled asset is named after the **`.icon` bundle's filename** (`icon.icon` → asset `icon`, entries like `icon_Assets/…`), while `electron-builder.yml` sets `CFBundleIconName: AppIcon`. macOS looks up `AppIcon` in the car, finds nothing, and silently falls back to `icon.icns` — the Liquid Glass icon never renders and nothing logs the mismatch.

## Root cause

1. `--app-icon <name>` selects an app-icon set by name from the compiled inputs. When no input asset matches the name, Xcode 26.2's actool emits nothing — and still exits 0. There is no `--app-icon`-style flag that renames the output; the asset name always comes from the `.icon` file's basename.
2. The repo's `icon.icon` was authored before `CFBundleIconName: AppIcon` was set, so the name contract (`CFBundleIconName` ⇔ `.icon` basename) was never actually satisfied.

## Fix

Rename the bundle so the basename equals `CFBundleIconName`, and compile with `--include-all-app-icons` (no `--app-icon`):

```bash
cd apps/electron
mv resources/icon.icon resources/AppIcon.icon   # basename must equal CFBundleIconName
xcrun actool resources/AppIcon.icon --compile resources \
  --include-all-app-icons \
  --enable-on-demand-resources NO --enable-icon-stack-fallback-generation NO \
  --development-region en --target-device mac --platform macosx \
  --minimum-deployment-target 26.0 \
  --warnings --errors --notices --output-format human-readable-text
```

Always verify — exit code 0 proves nothing:

```bash
# 1. actool must list Assets.car in its compilation results output
# 2. the car must contain IconGroup entries named after CFBundleIconName:
xcrun assetutil --info resources/Assets.car | grep '"Name" : "AppIcon"'
```

A real compile jumped the car from 17.6K to ~1.7M (three 1024px layer groups).

## Recurrence

- Any future icon change that re-runs the old command from docs/comments (they were corrected in this fix — `apps/electron/README.md`, `scripts/afterPack.cjs`, `electron-builder.yml`).
- Renaming the `.icon` bundle or changing `CFBundleIconName` independently reintroduces the silent fallback-to-icns behavior.

## Prevention

- The name contract is now documented at all three sites (README, afterPack.cjs header, electron-builder.yml comment).
- Verification step (`assetutil --info | grep CFBundleIconName-value`) is part of the documented regeneration procedure.

## References

- Working invocation sourced from jimeh/emacs-liquid-glass-icons `Makefile` (actool + `--include-all-app-icons`).
- Jim Myhrberg, "How to add Apple's new Liquid Glass icons to applications" — Electron-specific Liquid Glass walkthrough.
- [LEARNING-020](LEARNING-020-adhoc-fork-upstream-feed-squirrel-code-requirement.md) — sibling "macOS silently falls back with no diagnostics" failure mode.
