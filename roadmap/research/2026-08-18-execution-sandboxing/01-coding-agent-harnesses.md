# 01 — How OSS Coding-Agent Harnesses Sandbox Local Execution

**Research date:** 2026-08-18. Source report preserved substantially as produced.
**Status:** research input only — see [`README.md`](README.md).

---

## Headline: the 2025 consensus is out of date

**Three major harnesses now ship real Windows-native sandboxes built on Win32 primitives —
not WSL2 and not containers.** Codex CLI, Gemini CLI, and Anthropic's `sandbox-runtime` all
independently converged on **restricted tokens + Windows Filtering Platform (WFP) for egress
+ ACL/MIC for filesystem**. Notably, **none of them use AppContainer** — all three explicitly
rejected it.

Vorno's `'sandbox-exec' | 'bwrap' | 'firejail' | 'none'` union is the 2025 consensus. The 2026
consensus adds a fourth real backend.

---

## Master comparison

| Harness | macOS | Linux | Windows | Network separate from FS? | Fail closed? | Degradation surfaced how? |
|---|---|---|---|---|---|---|
| **Claude Code** (product) | Seatbelt via `sandbox-exec`, built in | bubblewrap + optional seccomp BPF + socat + ripgrep | **Not supported.** Docs: *"Native Windows is not supported… run Claude Code inside a WSL2 distribution"* | Yes — `sandbox.network` allowlist (default deny-all) vs `filesystem.allowWrite`/`allowRead` | **Configurable.** Default = warn + degrade; `sandbox.failIfUnavailable: true` blocks startup | `/sandbox` panel w/ Mode / Overrides / Config / Dependencies tabs; violation text appended to failing command output |
| **`@anthropic-ai/sandbox-runtime`** (`srt`) | `sandbox-exec` (stable) | bubblewrap (stable) | **Yes — alpha.** Dedicated `srt-sandbox` local user + WFP egress fence keyed on that SID + additive NTFS ACEs + restricted token in job object | Yes — HTTP/SOCKS5 localhost proxies; net allow-only, FS write allow-only, FS read deny-then-allow | Yes — blocked ops return `EPERM` | Violation store + macOS sandbox-violation log monitoring; proxy denial reasons (v0.0.68) |
| **OpenAI Codex CLI** | Seatbelt | Vendored bubblewrap (`--ro-bind / /`, `--unshare-user/pid/net`) + `PR_SET_NO_NEW_PRIVS` + seccomp net filter; legacy Landlock behind `features.use_legacy_landlock` | **Yes — native.** `[windows] sandbox = "elevated" \| "unelevated"`; `CreateRestrictedToken` w/ `WRITE_RESTRICTED`+`LUA_TOKEN`+`DISABLE_MAX_PRIVILEGE`, WFP, separate desktop | Yes — `[sandbox_workspace_write] network_access` separate from `writable_roots`; net off by default | **No.** Startup warnings when bwrap missing / userns unavailable | Startup warnings; AppArmor `bwrap-userns-restrict` guidance; approval prompts |
| **Google Gemini CLI** | Seatbelt, 5+ named profiles (`permissive-open` default → `restrictive-closed`), custom `.gemini/sandbox-macos-<name>.sb` | Docker/Podman; **gVisor/runsc**; LXC/LXD (experimental) | **Yes — native.** `WindowsSandboxManager.ts` + `GeminiSandbox.cs`: restricted token w/ double-SID eval, Job Objects, MIC "Low Mandatory Level" via `icacls`, Network SID (S-1-5-2) stripped | Yes — profile axis (`-open`/`-closed`/`-proxied`) on macOS; `networkAccess` + SID stripping on Windows | **No.** Off by default | `/about` shows `Sandbox: no sandbox / OS win32`; `security.toolSandboxing` setting |
| **Zed agent** (v1.14+) | Seatbelt | bubblewrap, non-setuid `bwrap` on `$PATH` required | **WSL only.** Non-WSL shells → native shell, unsandboxed | Yes — HTTP/HTTPS proxy for per-host grants on mac/Linux; **Windows/WSL all-or-nothing** | **No** — *"Zed may run the command without the OS sandbox and show a warning in the tool output"* | Padlock icon in thread header; escalation prompts stating *which* privilege and *why*; grant once/thread/permanent |
| **Cursor** (incl. `cursor-agent` CLI) | Seatbelt, profile generated at runtime from workspace settings + `.cursorignore` | Landlock (FS) + seccomp (syscalls) | **WSL2 only.** *"Building an equivalent native Windows sandbox is significantly harder because most existing sandboxing primitives are tailored to browsers"* | Yes — `sandbox.json` network policy separate from readable/writable paths | **No** — falls back to approval-based Run Modes | `/sandbox` slash command, `--sandbox <mode>`, interactive toggle menu |
| **VS Code agent mode** | Yes (preview) | Yes, incl. WSL2 | **Not supported** | Yes — `chat.agent.sandbox.allowNetwork` (default `false`), `chat.agent.allowedNetworkDomains` / `deniedNetworkDomains` | No — `chat.agent.sandbox.enabled` defaults `off` | Offers to install missing OS dependencies; sandboxed commands skip confirmation |
| **OpenHands** | Docker container runtime | Docker container runtime | Local Runtime only (CLI + headless), PowerShell prereq | Container-level only | N/A — you pick a runtime | Local Runtime docs warn it runs *"without any sandbox isolation"* |
| **OpenCode** | Experimental Seatbelt (`src/sandbox/spawn.ts`, `policy.ts`, `preset.ts`) — **merge status unverified**; plus `opencode-sandbox` plugin wrapping `sandbox-runtime` | Same plugin (bubblewrap) | None | Yes, via sandbox-runtime proxies | **Fail-open** — runs commands normally if init fails or platform unsupported | `bash:unsandboxed` permission request on denial + retry |
| **Goose** (Block) | None | None | None | N/A | N/A — full user privileges | Open issues #5943 (bwrap/seatbelt request), #6040 (BoxLite microVM) |
| **Aider** | None | None | None | N/A | N/A | `/run` prompts Y/N/Don't-ask; `--suggest-shell-commands` (default on), `--yes-always` |
| **Cline** | None | None | None | N/A | N/A | Model-emitted `requires_approval` flag (heuristic); YOLO mode; OS notification after 30s |
| **Roo Code** | **Archived 2026-05-15** — mode-scoped permissions only | — | — | — | — | Successor forks: Kilo Code, Zoo Code |
| **Continue.dev** | None — `allow`/`ask`/`exclude` policy engine only | Same | Same | Pattern-based only, e.g. `Bash(curl*)` | N/A | TUI approval prompt; `~/.continue/permissions.yaml` |
| **Amp** (Sourcegraph) | Permission rules only; **no Seatbelt evidence found** | Same | Same | No | No | Remote/"orb" execution offered as the isolation story |

---

## Q1 — Does any major OSS harness ship a real Windows-native sandbox?

**Yes — three, and they picked the same primitives.**

| | Codex CLI | Gemini CLI | Anthropic `sandbox-runtime` |
|---|---|---|---|
| Token | `CreateRestrictedToken`, `WRITE_RESTRICTED` + `LUA_TOKEN` + `DISABLE_MAX_PRIVILEGE` | Restricted token, double-SID evaluation (S-1-5-12) | Restricted token in job object, dedicated `srt-sandbox` user |
| Filesystem | Synthetic SID ACL checks | MIC **Low Mandatory Level** via `icacls`, `/deny` for `forbiddenPaths` | Additive inheriting explicit ACEs for the sandbox SID |
| Network | WFP | Strips Network SID **S-1-5-2** | WFP at `FWPM_LAYER_ALE_AUTH_CONNECT_V4/V6`: PERMIT loopback proxy ports 60080–60089, BLOCK anything carrying the sandbox SID |
| Job Objects | Not in `token.rs` | **Yes** | Yes |
| AppContainer | **No** | **No** | **No** |

Source evidence: `codex-rs/windows-sandbox-rs/src/` contains `token.rs`, `wfp.rs`, `wfp_setup.rs`,
`acl.rs`, `deny_read_acl.rs`, `desktop.rs`, `dpapi.rs`, `hide_users.rs`, `elevated_impl.rs`,
`conpty/`. From `token.rs`:

> *"Additional restricting SIDs are identity markers, not capabilities. Deliberately exclude
> them from the default DACL so possessing a route identity cannot grant object access."*

**Why not AppContainer:** Cursor rejected macOS App Sandbox for the analogous reason (requires
signing every binary the agent might exec) and says Windows primitives are "tailored to browsers."
OpenAI rejected Windows Sandbox because it's a full lightweight VM, unavailable on Home edition,
with startup latency incompatible with an execute-observe loop; and rejected MIC alone because it
gives only a coarse vertical hierarchy and *"cannot express horizontal boundaries like 'write here
but not there'."*

**Known Windows-native gaps:** Codex's sandbox *"does not prevent file writes, deletions, or
creations in any directory where the Everyone SID already has write permissions."* Gemini's
`icacls` Low-integrity marks are **persistent on disk** after the session ends. `sandbox-runtime`'s
Windows alpha doesn't fence DNS via the system resolver, breaks schannel revocation checking, and
leaks proxy auth tokens on the runner's command line.

**Counterpoint:** the *flagship* Anthropic product still says no — *"supports macOS, Linux, and
WSL2. WSL1 and native Windows are not supported."* Anthropic ships a Windows sandbox in the library
but not in the product, a strong signal the alpha isn't production-ready.

## Q2 — Emerging consensus

**OS-native primitives have decisively won for local harnesses; containers are the fallback and
the CI/remote story; approval-based trust is now explicitly framed as insufficient.**

Zed, 2026-08-05: fine-grained pattern rules *"work well as a guideline when dealing with a
well-aligned agent. They fall over instantly in the presence of an even vaguely sophisticated
attacker."* Cursor calls Run Modes *"best-effort guardrails rather than a hard security boundary."*
Cline's model-emitted `requires_approval` flag is documented as *"not guarantees."*

Four sub-patterns worth stealing:

- **Two independent axes.** Every serious implementation separates network from filesystem, and
  network defaults to deny-all-with-allowlist while filesystem read often defaults to allow.
  Claude Code's asymmetry is sharpest: read = deny-then-allow, write = allow-only, network = allow-only.
- **Proxy-mediated egress, not just a network namespace.** Claude Code, sandbox-runtime, Zed, and
  Codex's managed-proxy mode all run a local HTTP/SOCKS proxy so policy can be *per-domain*. Codex
  bridges TCP→UDS→TCP inside the netns and uses seccomp to block new `AF_UNIX`/`socketpair`
  creation so the bridge can't be subverted.
- **The structured escape hatch.** Claude Code has `dangerouslyDisableSandbox` (the model reads the
  violation appended to failed output and may retry outside the sandbox, subject to the permission
  flow); OpenCode mirrors this with a distinct `bash:unsandboxed` permission; Zed lets the agent
  request specific `fs_write_paths` or `allow_hosts` with a stated reason (PR #57972 replaced
  all-or-nothing `allow_fs_write: true`). **Don't just fail — feed the violation back to the model
  and offer a narrowly-scoped, user-approved widening.**
- **Protected paths the escape hatch cannot reach.** Zed refuses to grant write to `.git` at all,
  because git hooks execute outside the sandbox. Claude Code protects `.claude/skills` and gates
  `rm` on critical paths even in auto-allow. Codex re-applies `.git` and `.codex` as read-only after
  writable roots are bound.

## Q3 — How degradation is communicated

Best to worst:

1. **Zed** — persistent padlock icon showing live sandbox state; escalation prompts must state which
   privilege and a model-supplied reason; grant once / thread / permanently.
2. **Claude Code** — `/sandbox` command with Mode / Overrides / Config tabs, plus a **Dependencies
   tab that only appears when something is missing**. Violations appended to failing stdout so the
   *model* sees them. Enterprise: `failIfUnavailable`, `allowManagedReadPathsOnly`,
   `allowManagedDomainsOnly` so developers can't widen policy.
3. **Gemini CLI** — `/about` prints `Sandbox: no sandbox / OS win32`. Passive.
4. **Codex** — startup warnings only, then silence.
5. **Cline / Aider / Goose / Continue / Amp** — nothing to surface; there is no sandbox.

**Implication for Vorno:** silently degrading is below every harness in tier 1–4. Minimum viable is
Gemini's state readout; the right fix is Claude Code's `failIfUnavailable` + Zed's always-visible
indicator.

---

## Could not verify

- **OpenCode PR #21538** (native macOS Seatbelt) — file paths found, merge status unconfirmed. The
  repo appears to have moved from `sst/opencode` to `anomalyco/opencode`; reason unconfirmed.
- **The exact Gemini CLI release** where `WindowsSandboxManager` became available or default. PR
  #21807 is the implementation, #23691 dynamic expansion, #23282 `forbiddenPaths`, #23923 shell-tool
  enablement — **which was reverted in #24357.**
- **Amp** — no evidence of any OS-level sandbox, but also no explicit statement that there isn't
  one. Treat "permission rules only" as inference.
- Could not retrieve `openai.com/index/building-codex-windows-sandbox/` (HTTP 403) or
  `codex-rs/windows-sandbox-rs/README.md` (404). Windows details come from `src/token.rs`, the repo
  file listing, and GitHub Discussion #6065 (2025-11-01).
- `sandbox-runtime` has **no tagged 1.0**; latest observed **v0.0.73 (2026-08-13)**, with Windows
  work landing continuously v0.0.67 (2026-07-23) → v0.0.73. Treat the Windows path as alpha.

## Sources

**Anthropic** — `github.com/anthropic-experimental/sandbox-runtime` (README platform matrix,
"Windows (alpha)", security model, known limitations; `src/sandbox/`, `vendor/`) ·
`api.github.com/repos/anthropic-experimental/sandbox-runtime/releases` (v0.0.66 2026-07-17 →
v0.0.73 2026-08-13) · `code.claude.com/docs/en/sandboxing`

**OpenAI Codex** — `codex-rs/linux-sandbox/README.md` · `codex-rs/windows-sandbox-rs/src/` +
`token.rs` · `github.com/openai/codex/discussions/6065` · `learn.chatgpt.com/docs/sandboxing` ·
Issue #13373

**Gemini CLI** — `docs/cli/sandbox.md` · `packages/core/src/sandbox/windows/` · PRs #21807, #23691,
#23282, #23923/#24357 · Issues #20780, #25194

**Zed** — `zed.dev/blog/sandboxing` (2026-08-05) · `zed.dev/docs/ai/sandboxing` · PR #57972

**Cursor** — `cursor.com/blog/agent-sandboxing` (2026-02-18) · `cursor.com/docs/agent/security/run-modes`

**Others** — `code.visualstudio.com/docs/agents/run/approvals` · `docs.cline.bot/features/auto-approve` ·
`docs.continue.dev/cli/tool-permissions` · `docs.openhands.dev/openhands/usage/architecture/runtime` ·
`github.com/block/goose` Issues #5943, #6040 · `aider.chat/docs/config/options.html` ·
`embracethered.com/blog/posts/2025/amp-agents-that-modify-system-configuration-and-escape/`
