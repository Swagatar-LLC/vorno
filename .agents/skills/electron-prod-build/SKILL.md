---
name: electron-prod-build
description: Produce a local production-mode Electron build for hands-on QA — faster than dev mode, identical to what ships
---

# Skill: electron-prod-build

`bun run electron:dev` is fine for iteration, but it ships unminified renderer assets through Vite's dev server with HMR overhead — perceivably slow on a real machine. When the user wants to **test** something the way it will ship (animations, scrolling, bundle behavior, IPC timing), build the prod bundle and launch the app against it.

There are three flavors. Pick by what the user actually wants to do:

| Flavor | Command (from repo root) | Output | When |
|--------|--------------------------|--------|------|
| **Build only** | `bun run electron:build` | Optimized `apps/electron/dist/` assets | User wants to launch it themselves (Finder, separate terminal, repeat runs) |
| **Build + launch** | `bun run electron:start` | Builds, then runs `electron apps/electron` in the foreground | One-shot smoke test; the agent shouldn't kick this off in the background — Electron stays attached to the terminal |
| **Build + package** (`.app` / `.dmg`, unsigned) | `bun run electron:dist:dev:mac` (mac) / `electron:dist:dev:win` (win) | Real installer in `apps/electron/dist/`, but skips Apple signing/notarization (`CSC_IDENTITY_AUTO_DISCOVERY=false`, `CRAFT_DEV_RUNTIME=1`) | User wants an artifact they can share, drag to Applications, or test exactly the way an end user would launch it |

The fork uses `CRAFT_CONFIG_DIR=$HOME/.craft-agent-swagatar` so it doesn't collide with upstream stable. The dev script sets it automatically; the prod-mode launches **do not** — see "Launching" below.

## When to invoke

- "Make me a production build to test"
- "The dev build feels sluggish, I want to verify perf on a real bundle"
- "Give me a `.app` I can install"
- After a renderer-heavy change (animation, virtualization, large component) where dev-mode timing is misleading

## Procedure

### Build only (most common)

```bash
bun run electron:build
```

Roughly: bundles main (esbuild) → preload → renderer (Vite, minified) → resources (skills, MCP examples) → asset copy. ~30–60 s on a recent Mac. Output lives at `apps/electron/dist/`.

Run it in the **background** if the user wants to keep working — it doesn't open any windows on its own.

### Build + launch

```bash
bun run electron:start
```

This rebuilds **every time** and then runs `electron apps/electron`. The Electron process stays attached to the terminal until the user quits the window, so:

- **Don't** launch this from the agent in a non-background shell — it blocks. If invoked, prefer `run_in_background: true` and tell the user to switch focus to the new window.
- **Do** prefer the two-step variant (`electron:build` → user launches) for repeated test cycles.

### Build + package (unsigned)

```bash
# macOS
bun run electron:dist:dev:mac
# Windows
bun run electron:dist:dev:win
```

These set `CSC_IDENTITY_AUTO_DISCOVERY=false` and `CRAFT_DEV_RUNTIME=1` so electron-builder skips Apple/Microsoft signing — the resulting `.app` / `.dmg` / installer will Gatekeeper-warn on first open but is otherwise identical to what ships. Output: `apps/electron/dist/<name>-<version>-<arch>.dmg` (mac) or the win installer.

Don't reach for the **un-suffixed** `electron:dist:mac` / `electron:dist:win` unless the user explicitly wants signed/notarized output — those require Apple/Microsoft credentials in `.env` (or 1Password CLI for the DMG script).

## Launching the build manually

If you went the build-only route, the user can launch it any time with either:

```bash
# From repo root, optimized renderer + dev process model
CRAFT_CONFIG_DIR=$HOME/.craft-agent-swagatar electron apps/electron

# Or, since electron:start always rebuilds, you generally just rerun:
bun run electron:start
```

The `CRAFT_CONFIG_DIR` override matters — the fork is built to coexist with the upstream stable build the user runs side-by-side. Without it, the prod-mode launch falls back to the upstream config dir and the two builds will fight over the same workspace.

The desktop fork build has a visible **"FORK" badge** with a rust accent stripe. If you don't see it on launch, you launched the wrong binary or the badge regressed.

## Validation

A successful `electron:build` ends with `validate-assets` reporting OK. If it fails:

- **Missing `dist/main.cjs`** → the esbuild step blew up; re-run `bun run electron:build:main` alone for a cleaner error.
- **Missing renderer chunks** → Vite import error; re-run `cd apps/electron && bun run build:renderer` alone.
- **`Asset … not found`** from `validate-assets` → run `bun run electron:build:resources` and `bun run electron:build:assets`.

If a clean rebuild is needed:

```bash
bun run electron:clean
bun run electron:build
```

For the packaged flavor, electron-builder dumps its own logs in `apps/electron/dist/` — read them rather than re-running blind.

## Constraints

- **Don't skip the lint step.** `apps/electron`'s `build` script runs `bun run lint` first; that's intentional. If lint fails, fix the lint, don't bypass.
- **Don't mix dev and prod state.** Dev mode writes to `~/.craft-agent-swagatar/dev-*` paths in some cases; if the user reports weirdness after switching modes, suggest closing the dev session before launching the prod build.
- **The packaged flavor takes minutes**, not seconds. Confirm with the user before kicking it off if you're not certain that's what they want.
- The fork badge stays on. Never strip it as part of a "clean prod build" instinct.

## Recurrence / common pitfalls

- **`electron:start` looks hung** — Electron logs to `~/.craft-agent-swagatar/main.log` (or the upstream path if `CRAFT_CONFIG_DIR` wasn't set). Tail that, not the foreground stdout.
- **First launch after a packaged build is rejected by Gatekeeper** — expected with the `:dev:` flavor. Right-click → Open, or `xattr -cr <path-to-.app>`.
- **Build succeeds but the app shows the *upstream* UI** — `CRAFT_CONFIG_DIR` wasn't set; you launched the upstream config. Quit, set the env var, relaunch.

## Tools

- `Bash` for the build commands and log inspection
- `Read` to inspect `apps/electron/package.json` if a flavor isn't behaving as documented
