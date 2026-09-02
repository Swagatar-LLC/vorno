# PLAN-049 — `vorno-cli` ships with the product and has an install story

**Status:** implemented, awaiting review
**Branch:** `plan/plan-049-vorno-cli-install`
**Raised by:** Jeff, 2026-09-01 — *"It's pretty darned important that `vorno-cli`
is easy to install (comes with the product) and has a clear installation path
and story."*

## The problem, precisely

`vorno-cli` was undeliverable. Not broken — **undeliverable**. The code was
healthy the whole time; there was simply no path from the repo to a user's
shell.

Four independent failures stacked:

1. **No build step.** `apps/cli/package.json` declared
   `"bin": { "vorno-cli": "src/index.ts" }` — a TypeScript entry. That only
   resolves under `bun`, inside the workspace. Not installable by `npm i -g`,
   not runnable standalone.

2. **Dead environment variables.** `apps/electron/src/main/index.ts` set
   `CRAFT_CLI_ENTRY` → `packages/craft-cli/src/cli.ts` and
   `CRAFT_COMMANDS_ENTRY` → `packages/craft-agents-commands/src/main.ts`.
   **Neither package exists in this repo.** The CLI lives at `apps/cli`. Both
   variables were dead in packaged *and* dev builds.

3. **The wrapper never shipped.** `resources/bin/craft-agent` exists in the repo
   and looks present, but `electron-builder.yml` enumerates `resources/bin`
   **file by file** and never listed it. It was absent from every packaged
   build. Confirmed against installed 0.21.0: `resources/bin/` contains the eight
   doc tools and nothing else.

4. **Nothing validated any of it.** `validate-assets.ts` checked renderer and
   WebUI outputs only. Every failure above was silent, which is why they
   survived a release.

The tell: `~/.vorno-agent/docs/vorno-cli.md` **does** ship in the bundle, and the
app sets `CRAFT_COMMANDS_DOC_PATH` to it. **The documentation for the CLI shipped
while the CLI did not.**

## The fix

**A standalone compiled binary, not a wrapper around a runtime.**
`scripts/build-cli.ts` uses `bun build --compile`, mirroring the existing
`scripts/build-server.ts` precedent. This embeds the Bun runtime, so the artifact
runs under `env -i` — no PATH, no `CRAFT_*`, no bun installed. That is what makes
"comes with the product" true rather than "works if your shell is set up right".

It also sidesteps workspace module resolution. The alternative — staging
`packages/shared` and `packages/server-core` sources into the bundle and hoping
the import graph resolved at runtime — is how failure #2 happened in the first
place.

| Change | File |
|---|---|
| Compile script, per-platform, with a smoke test | `scripts/build-cli.ts` (new) |
| Build + install npm scripts | `package.json` |
| Compile step wired into packaging | `apps/electron/scripts/build-dmg.sh` |
| Wrapper with 3-tier resolution | `apps/electron/resources/bin/vorno-cli{,.cmd}` (new) |
| Entry vars corrected; `CRAFT_VORNO_CLI_BIN` exported | `apps/electron/src/main/index.ts` |
| Wrappers + binary added to the ship list | `apps/electron/electron-builder.yml` |
| **Regression gate** | `apps/electron/scripts/validate-assets.ts` |
| 57MB artifact excluded from git | `apps/electron/resources/bin/.gitignore` |

### The wrapper resolves three ways

Most-specific first, so the command behaves identically everywhere:

1. `$CRAFT_VORNO_CLI_BIN` — the compiled binary, set by the Electron main process
2. a sibling `vorno-cli-bin` — covers direct invocation with no env injected
3. `$CRAFT_CLI_ENTRY` under `${CRAFT_BUN:-bun}` — dev mode

Failing all three it exits **127** with the list of paths it tried.

### The regression gate is the load-bearing part

`validate-assets.ts` now fails the build unless each wrapper **both** exists on
disk **and** is named in `electron-builder.yml`. Checking only the file would
have stayed green through the entire 0.21.0 bug — the file was there; the
manifest entry was not.

## Install story

**Desktop users:** nothing to do. The binary ships in `resources/bin`, which the
main process already prepends to the agent `PATH`. `vorno-cli` is on `PATH` in
every agent shell.

**Terminal users:**
```sh
bun run cli:install        # compiles to ~/.local/bin/vorno-cli
```

**Package maintainers:** `bun run cli:build:<target>` for
`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`.

## Verification performed

- Compiles: 85 modules, 57.3 MB, ~70ms.
- Runs under `env -i PATH=/usr/bin:/bin` — no bun, no `CRAFT_*`.
- All three wrapper tiers exercised individually; missing-CLI path exits 127.
- `validate-assets` negative-tested **both** directions: unlisted-from-yml → exit
  1, missing-from-disk → exit 1. Restored → pass.
- `bun run cli:install` end to end: `which vorno-cli` resolves, `--help` works
  from a stripped env.
- Electron typecheck: **107 errors on `main`, 107 on this branch** — identical,
  all pre-existing. Zero in touched files. `apps/cli` typecheck clean.

### Two bugs this work found in itself

**The validator's own check was wrong.** `includes('resources/bin/vorno-cli')`
matched the `vorno-cli.cmd` line as a substring, so deleting the real entry still
passed. Found by deliberately unlisting it and watching the check stay green.
Now matches whole YAML list entries.

**A server-URL auto-detect was written and then reverted.** The idea was to read
`~/.vorno-agent/server-config.json` so a fresh install could `ping` with no
configuration. It was wrong: port 3847 is the **HTTP trigger server** (it rejects
WS upgrade), not the CLI's RPC endpoint, and `.server.lock` holds only a pid. The
helper turned a clear `No server URL` message into an opaque
`WebSocket connection error`. Reverted rather than shipped — a plausible wrong
answer is worse than an honest error.

## Known issue, stated not hidden

Running the compiled binary with cwd set to the **monorepo root specifically**
fails to resolve `@craft-agent/core/branding`: Bun prefers the on-disk workspace
`node_modules` over the embedded bundle. Any other cwd works — a subdirectory of
the repo, `/tmp`, a home directory. It affects a developer running the artifact
in place, never a shipped install. The build script's smoke test runs from
`tmpdir()` because that is the real deployment condition, not to dodge this.

## Not done

- **`craft-agent` wrapper left alone.** It reads the now-corrected
  `CRAFT_COMMANDS_ENTRY`, so it works again for anyone depending on the old name,
  but it is still unlisted in `electron-builder.yml` and still will not ship.
  Deleting it is a separate branding decision.
- **CI does not build the CLI.** `validate-assets` catches the packaging
  regression; nothing yet catches a compile break on a target nobody built.
- **The docs describe a different CLI.** `vorno-cli.md` documents
  `label list`, `automation create` — entity/action config management. The shipped
  CLI is a WebSocket client (`run`, `ping`, `sessions`, `send`, `invoke`). Those
  are reachable via `invoke`, but the doc reads as though first-class subcommands
  exist. Worth reconciling; out of scope here.
