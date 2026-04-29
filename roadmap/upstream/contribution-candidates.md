# Contribution candidates

Things we currently maintain in our fork that might make sense to PR upstream. Tracked here so we don't forget; promoted to a formal proposal when we're ready.

## Selection criteria

A change is a good upstream candidate when:

1. The value is clear and not paradigm-specific to our fork's directions.
2. Maintenance cost is *lower* upstream (less drift between forks).
3. It doesn't require accepting our broader vision to be useful.
4. Upstream's API/style conventions can absorb it without contortion.

## Candidates

### `CLAUDECODE` env strip in `buildClaudeSubprocessEnv`

- **Where**: `packages/shared/src/agent/options.ts`
- **What**: One line — `delete env.CLAUDECODE` — preventing the Claude SDK CLI from refusing to spawn when Craft itself runs inside a Claude Code session.
- **Why upstream**: Affects anyone running Craft from inside Claude Code. Trivial change. No downsides.
- **Status**: Pending — open small PR with a test.

### Lightweight HTTP trigger server (`apps/server/`)

- **Where**: Entire `apps/server/` app + `packages/server-core/` adjacencies (already upstream).
- **What**: A Bun-native, ~12 MB-bundle alternative to upstream's headless `packages/server/` for short-lived API-key-authenticated sessions. Dual transport (HTTP/SSE + WebSocket) on a single port.
- **Why upstream**: Useful as a deployment target for serverless / containerized scenarios where the full `packages/server/` is overkill.
- **Status**: Probably *not* a candidate — upstream's roadmap centers on the heavyweight server. Better as a fork specialty.
- **Decision**: Re-evaluate after Direction 3 ships; the Observatory may make this server's role clearer.

### Validate-PR CI workflow

- **Where**: `.github/workflows/validate-pr.yml`
- **What**: A working CI sanity suite (typecheck across all passing packages, threshold-based shared tests, strict server tests, doc-tools, build check).
- **Why upstream**: Upstream's `Validate` workflow is broken (fails on Electron typecheck since v0.7.7). Ours actually passes.
- **Status**: Worth proposing — but upstream might not want the threshold-based shared-test approach. Possible alternative: PR the typecheck and build-check jobs only.

### Documentation patterns

- **Where**: `ARCHITECTURE.md`, `CONTAINER-ARCHITECTURE.md`, `docs/http-trigger-server.md`
- **What**: Architectural overview docs that don't currently exist upstream.
- **Why upstream**: Helpful onboarding artifacts for upstream contributors too.
- **Status**: Worth offering once they're stable — low priority.

## Out of scope (not contribution candidates)

These are paradigm-specific and stay in the fork:

- `roadmap/` system (specific to our governance posture)
- Visual fork branding (intentionally distinguishes us)
- Direction 1 / 2 / 3 implementations (paradigm bets, not portable utilities)
