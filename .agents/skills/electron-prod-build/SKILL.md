---
name: electron-prod-build
description: Produce a local production-mode Electron build for hands-on QA — faster than dev mode, identical to what ships
---

# Skill: electron-prod-build

> **Config-dir note (2026-07-03, VOR-2 / ADR-0005):** the fork now defaults to
> `~/.vorno-agent` automatically — **no `CRAFT_CONFIG_DIR` needed** for
> isolation from upstream stable. References below to
> `CRAFT_CONFIG_DIR=$HOME/.craft-agent-swagatar` predate this; do **not** set
> that var anymore (it pins the app to the legacy pre-migration dir). Also note
> some scripts referenced here (`electron:prod`) have drifted out of
> `package.json` during upstream merges — verify against `package.json` before
> quoting commands.

`bun run electron:dev` is fine for iteration, but it ships unminified renderer assets through Vite's dev server with HMR overhead — perceivably slow on a real machine. When the user wants to **test** something the way it will ship (animations, scrolling, bundle behavior, IPC timing), build the prod bundle and launch the app against it.

There are three flavors. Pick by what the user actually wants to do:

| Flavor | Command (from repo root) | Output | When |
|--------|--------------------------|--------|------|
| **Build only** | `bun run electron:build` | Optimized `apps/electron/dist/` assets | User wants to launch it themselves (Finder, separate terminal, repeat runs) |
| **Build + launch (fork)** | `bun run electron:prod` | Builds, then launches the fork's prod bundle with `CRAFT_CONFIG_DIR=$HOME/.craft-agent-swagatar` already set, using the repo-local Electron binary (no global install) | The default for hands-on QA on this fork. One-shot smoke test that mirrors the shipped build *and* keeps the fork's config dir isolated from upstream stable |
| **Build + launch (raw)** | `bun run electron:start` | Same build, but launches with whatever `CRAFT_CONFIG_DIR` is already in your shell (so it falls through to upstream's default) | Only when you explicitly want to point the prod-mode launch at a different config dir (e.g. testing against an upstream-shaped workspace) |
| **Build + package** (`.app` / `.dmg`, unsigned) | `bun run electron:dist:dev:mac` (mac) / `electron:dist:dev:win` (win) | Real installer in `apps/electron/dist/`, but skips Apple signing/notarization (`CSC_IDENTITY_AUTO_DISCOVERY=false`, `CRAFT_DEV_RUNTIME=1`) | User wants an artifact they can share, drag to Applications, or test exactly the way an end user would launch it |

The fork uses `CRAFT_CONFIG_DIR=$HOME/.craft-agent-swagatar` so it doesn't collide with upstream stable. `electron:dev` and `electron:prod` set it automatically; `electron:start` does **not** — it's the bare upstream-style launch and falls through to whatever's in your shell.

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

### Build + launch (fork — preferred)

```bash
bun run electron:prod
```

This is the script you almost always want for hands-on QA on this fork. It:

1. Runs `bun run electron:build` (full prod bundle).
2. Launches `./node_modules/.bin/electron apps/electron` — i.e. the repo-local Electron binary, so **no global `electron` install is required**.
3. Sets `CRAFT_CONFIG_DIR=$HOME/.craft-agent-swagatar` (overridable by exporting your own first) so the launch stays isolated from upstream stable's config dir.

The Electron process stays attached to the terminal until the user quits the window:

- **Don't** launch this from the agent in a non-background shell — it blocks. If invoked, prefer `run_in_background: true` and tell the user to switch focus to the new window.
- **Do** prefer the two-step variant (`electron:build` → user launches) for repeated test cycles where the agent doesn't want to babysit a foreground process.

### Build + launch (raw — upstream-style)

```bash
bun run electron:start
```

Same build, but does **not** set `CRAFT_CONFIG_DIR` and uses a bare `electron apps/electron` (which only works if `electron` is on PATH or hoisted into the shell — `bun run` happens to make this work via `node_modules/.bin/`). Use this only when you intentionally want to launch the fork against upstream's default config dir; in any other case, prefer `electron:prod`.

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

If you went the build-only route, the cleanest way to launch is:

```bash
# From repo root — uses the repo-local electron binary, sets the fork
# config dir, no global install needed.
bun run electron:prod
```

`electron:prod` always rebuilds before launching; if you want to skip the rebuild on a repeat run, use the local binary directly:

```bash
CRAFT_CONFIG_DIR=$HOME/.craft-agent-swagatar ./node_modules/.bin/electron apps/electron
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
