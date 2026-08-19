# Execution Sandboxing for Vorno — Research Synthesis

**Date:** 2026-08-18 · **Session:** 260818-early-heron · **Status:** research only — no decision, no plan

> **Not a decision and not a plan.** The "recommended sequence" in §8 is the author's reading of the
> evidence, not an accepted roadmap. **Windows support is explicitly out of scope for any decision at
> this time** — the Windows material is recorded because it was researched. Decisions go to
> [`../../decisions/`](../../decisions/); work goes to [`../../plans/`](../../plans/).
>
> Start with the dossier [`README.md`](README.md) for reading order and what is / isn't established.

Four parallel research lanes (harness survey, OS primitives, portable runtimes, framework + adversarial),
grounded against Vorno's own source at `~/dev/craft-agents-oss`.

---

## 1. Executive summary

**The single most important finding:** every published prompt-injection defense that has faced a
competent adaptive attacker has failed. Zhan et al. (NAACL 2025, arXiv:2503.00061) evaluated 8 defenses
and bypassed all 8 at >50% ASR. Nasr et al. (arXiv:2510.09023) bypassed 12 more at >90% ASR. A 2026
survey (arXiv:2607.05743) finds policy enforcement failing at **69–98%**.

Therefore: **the boundary must be OS-enforced.** Model-level filtering, prompt hardening, and
command-string pattern matching are UX and defense-in-depth — not boundaries. Anthropic states the
principle directly: *"The operating system enforces the sandbox boundary on the running process, so it
holds regardless of what the model chose to run and even if an allowed command does more than its name
suggests."*

**Where Vorno actually stands:** better than the field on one axis (we fail closed where most degrade
silently), worse on three (an unisolated tool, permissive reads, and a credential store weaker than the
OS keychain baseline).

**The Windows picture changed in our favour.** Three harnesses now ship native Windows sandboxes built
on restricted tokens + Windows Filtering Platform. A viable non-admin path exists that neither vendor
took, and our architecture makes it cheaper for us than it was for them.

---

## 2. What we have today — five local findings

Verified by reading the source, not inferred.

### 2.1 `script_sandbox` fails closed ✅

`packages/session-tools-core/src/handlers/script-sandbox.ts:106-118` hard-errors when either isolation
plan returns `unavailable`, stamping `isolationPolicy: required-in-all-modes` into every result. On
Windows the tool is **unavailable, not unsafe**.

This is *better* than Codex CLI, Gemini CLI, Zed, Cursor, and OpenCode — all of which degrade to
unsandboxed with a warning. Only Claude Code offers fail-closed, and only as opt-in
(`sandbox.failIfUnavailable`).

### 2.2 `transform_data` has no isolation at all — on any platform ⚠️

`packages/session-tools-core/src/handlers/transform-data.ts:97` calls `createScriptRuntimeEnv`
(env scrubbing + redirected caches) and **never** calls `applyFilesystemIsolation` or
`applyNetworkIsolation`. It is the only other script-executing handler. A `transform_data` script today
can write anywhere the user can and open sockets — **including on macOS**.

This is a present-tense gap on our primary platform, not a Windows question.

### 2.3 The macOS profile confines writes but permits all reads ⚠️

`runtime/filesystem-isolation.ts:50` is `(allow file-read*)`, with only `file-write*` narrowed to the
session dir. A correctly sandboxed script can read `~/.ssh`, `~/.aws`, browser cookie stores, and our
own credential store. `(deny network*)` is therefore load-bearing for confidentiality.

Claude Code's docs admit the identical default: *"this default still allows reading credential files
such as `~/.aws/credentials` and `~/.ssh/`."* We share the industry default; they have since built two
mitigations we lack (§6).

### 2.4 Linux: firejail should be dropped; bwrap silently fails on Ubuntu 24.04 ⚠️

- **firejail is setuid-root by design.** CVE-2022-31214 (`--join` → root), CVE-2021-26910 (OverlayFS
  TOCTOU → privesc), `--output` command injection, repeated Gentoo GLSAs. We invoke it as a fallback in
  *both* isolation modules. A signed desktop app shelling out to a setuid-root binary adds attack
  surface to the **host**, not just the sandbox.
- **Ubuntu 23.10+ / 24.04 set `kernel.apparmor_restrict_unprivileged_userns=1` by default**, blocking
  `unshare(CLONE_NEWUSER)`. Canonical *deliberately* declined to ship a permissive bwrap profile. Our
  `existsOnPath('bwrap')` check passes; the spawn then fails. No user-level installer can fix it.
- **We have no Landlock**, which is the strategically correct primitive: it *"empowers any process,
  including unprivileged ones, to securely restrict themselves"* — no root, no setuid, no namespaces,
  sidestepping the Ubuntu problem entirely. Detect ABI at runtime via `LANDLOCK_CREATE_RULESET_VERSION`.

### 2.5 The credential store does not use the OS keychain 🔴

`packages/shared/src/credentials/backends/secure-storage.ts` encrypts with
**AES-GCM under `PBKDF2(machineId, salt, 100k)`**, where `machineId` is `IOPlatformUUID` (macOS),
`MachineGuid` from the registry (Windows), or `/etc/machine-id` (Linux). **Electron `safeStorage` is not
used anywhere in the repo.**

All three identifiers are readable by any process running as the user. `ioreg` needs no privileges;
`/etc/machine-id` is world-readable by design. **Any code running as the user can re-derive the key.**
This is obfuscation against casual file reads, not encryption at rest against local code — and it sits
*below* the OS-keychain baseline, which at least gates on code identity (macOS) or user scope (DPAPI).

This is live: **ACRStealer/Amatera** is described as the first infostealer built specifically to harvest
API keys from AI coding assistants (Cline, Continue.dev by name), via 88 domains impersonating Claude
Code and JetBrains. Trail of Bits found Claude Desktop's config world-readable and the Figma MCP server
defaulting to `0666`.

---

## 3. Field survey — how the harnesses actually do it

| Harness | macOS | Linux | Windows | Fails closed? |
|---|---|---|---|---|
| **Claude Code** | Seatbelt | bubblewrap + seccomp | **No** — WSL2 only | Configurable (`failIfUnavailable`) |
| **`sandbox-runtime`** | Seatbelt | bubblewrap | **Yes (alpha)** — dedicated user + WFP, *needs admin install* | Yes |
| **Codex CLI** | Seatbelt | bubblewrap + seccomp, Landlock legacy | **Yes** — restricted token + WFP + alt desktop | No |
| **Gemini CLI** | Seatbelt (5 profiles) | Docker/Podman/gVisor | **Yes** — restricted token + Job Objects + MIC | No (off by default) |
| **Zed** | Seatbelt | bubblewrap | WSL only | No |
| **Cursor** | Seatbelt | Landlock + seccomp | WSL2 only | No |
| **OpenHands** | Docker | Docker | Local runtime, *"no sandbox isolation"* | N/A |
| **Goose / Aider / Cline / Continue** | none | none | none | N/A |

**Four patterns worth stealing:**

1. **Feed violations back to the model, then negotiate a narrow widening.** Claude Code appends the
   violation to failing stdout so the model can request a scoped exception; Zed's PR #57972 replaced
   all-or-nothing `allow_fs_write` with per-path `fs_write_paths` plus a model-supplied reason.
2. **Protected paths the escape hatch cannot reach.** Zed refuses `.git` writes outright because **git
   hooks execute outside the sandbox**. Confirmed as a cross-vendor primitive: Claude Code
   CVE-2026-55607 and Goose CVE-2026-72718 both abuse `git core.fsmonitor`. Claude Code
   CVE-2026-25725: bubblewrap failed to protect `.claude/settings.json` **when it did not exist at
   startup**, so sandboxed code created it and injected hooks that ran with host privileges on restart.
3. **Proxy-mediated egress, not binary on/off.** Per-domain policy is not an OS primitive on any
   platform; every serious implementation runs a local deny-by-default HTTP/SOCKS5 proxy.
4. **Asymmetric defaults.** Read = deny-then-allow, write = allow-only, network = allow-only.

**Degradation disclosure** is where we rank last. Zed shows a persistent padlock; Claude Code has a
`/sandbox` panel with a Dependencies tab that appears only when something is missing; Gemini CLI prints
`Sandbox: no sandbox / OS win32`. We surface nothing.

---

## 4. Windows — build, don't vendor

`@anthropic-ai/sandbox-runtime`'s Windows path **requires a one-time elevated `windows-install`**. We
ship a per-user NSIS install to `%LOCALAPPDATA%\Programs` specifically to avoid admin. Disqualified.

**AppContainer launched without the `internetClient` capability is the only mechanism giving a non-admin
app kernel-enforced network denial on Windows.** Loopback is blocked for free.

Both OpenAI and Anthropic evaluated AppContainer and rejected it. OpenAI's reason: *"its reliance on
ACLs for file-based restrictions makes changing sandbox semantics expensive and complex"* — because a
coding agent must read the user's **entire checkout**.

**That rationale is much weaker for us.** `script_sandbox` already runs against a scratch session
directory, not the user's tree. If the confined surface is one scratch dir, AppContainer's rigidity
costs little — and we get the thing OpenAI needed admin for.

**DX unlock:** no C++ N-API addon required. DeepSeek's Windows backend uses **`koffi`** (plain FFI);
every call in the chain is a marshalable `advapi32`/`userenv`/`kernel32` export. Estimate **400–800
lines of TS**, with koffi's prebuilt `.node` as the only new signed artifact.

**The one unverified item gates everything:** nobody could confirm that stock `node.exe`/`bun.exe` runs
correctly inside an externally-created AppContainer. Chromium's *own* network service runs in a plain
AppContainer non-elevated (so complex Windows binaries can), but Firefox under LPAC needs single-process
mode. **1–2 day spike; must be first.**

**Fallback if the spike fails** (all non-admin, proven in production by Codex and DeepSeek):
Job Object (`KILL_ON_JOB_CLOSE`, memory/CPU/UI limits) + `CreateRestrictedToken` with
`DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED` + a synthetic restricting SID ACE'd onto the
scratch dir + an alternate desktop (documented as required — otherwise the child drives unrestricted
apps via `SendMessage`). Known gaps to disclose: **no network enforcement, no read confinement**, and
the `Everyone`-ACE gap.

**Closed off:** WDAG is removed in 24H2 (EOS 2026-11-10). Win32 App Isolation is still preview after
~21 months and confines a *packaged app*, not a child process. Windows Sandbox has no Home edition and
allows one instance. Chromium's sandbox requires a **cooperative target calling `LowerToken()`** —
structurally impossible for model-authored code.

**macOS:** keep `sandbox-exec`. Deprecated in the man page since ~2016, still functional through 26.3,
no removal date. But [apple/containerization#737](https://github.com/apple/containerization/issues/737),
asking Apple for a timeline and a supported replacement, has been **open since 2026-05-12 with no
response**, and there's precedent for silent breakage (Bazel's network blocking around Catalina).
**Add a startup self-test** that verifies the profile denies what we think it denies.

---

## 5. Portable tier — WASM for the narrow tools

**Bun has no sandbox and no visible timeline.** Issue #6617 (Oct 2023) is open with no assignee and no
team response; a Jan 2026 Deno-style proposal (#25929) was closed as duplicate. Bun 1.4 was the Zig→Rust
rewrite — Node compatibility, not security. **We ship Bun; it can never be the boundary.**

**Node `--permission` is out too**, per Node's own docs: *"It does not provide security guarantees in
the presence of malicious code… Node.js trusts any code it is asked to run."* Plus CVE-2026-58043, one
of three permission-model bypasses in a single release.

**Tier by tool, not by OS.** Tiering purely by OS means the same script has different security
properties per platform — impossible to document, impossible to test, and it produces bugs that
reproduce on exactly one OS. That is the flaw we live with today.

- **Tier 0 — portable WASM, identical everywhere.** `transform_data` and pure-compute `script_sandbox`.
- **Tier 1 — OS-native.** General Bash, the document CLIs, anything needing native libs.
- **Tier 2 — unsandboxed, explicit per-session consent, prominently surfaced.**
- **Tier 3 — remote sandbox.** Opt-in only, never default.

**`transform_data` is the decisive, cheap win.** Constraints (no network, one input, one output, pure
reshaping) dodge every WASM weakness.

Key design move: **pass bytes, don't mount a directory.** Host reads input and injects contents; host
receives the result and writes it. The guest gets **no file handle at all** — the one-in-one-out
contract becomes structural rather than policy, eliminating path-traversal reasoning.

- JS → **`quickjs-emscripten`** (~500 KB sync build; QuickJS-NG; actively maintained). Accept the 10–50×
  slowdown. Avoid `isolated-vm` — maintenance mode per its own author, and a native addon we'd rebuild
  against Electron's ABI every bump.
- Python → **NOT Pyodide as a boundary. See §5.1.**

### 5.1 ⚠️ Correction — the Pyodide-as-sandbox thesis died in January 2026

Lane 3 recommended Pyodide for Python transforms. **Lane 4 refutes it, and lane 4 is right.** The
ecosystem tried this and abandoned it:

- **LangChain Sandbox** (Deno + Pyodide) — archived **2026-01-14**.
- **Pydantic `mcp-run-python`** — archived **2026-01-30**. Their postmortem is the decisive text:
  > *"there's just no safe way to run Python within pyodide safely with reasonable latency"*
  > *"Python code running in pyodide can run arbitrary javascript"*
  > *"These issues are not problems with Pyodide or Deno — they're behaving as advertised, it's just
  > that **those tools were not designed as sandboxes to run untrusted code**."*

The escape is the **Python→JS bridge**, not the filesystem — so "pass bytes, don't mount" does *not*
mitigate it. Pyodide is a **portability layer, not a security boundary**.

**What survives the correction:** `quickjs-emscripten` is a different animal — a JS interpreter compiled
to WASM with no host bindings by default, so the guest cannot reach the host without an explicitly
exposed function. The JS half of Tier 0 stands.

**Revised position:** JS transforms → quickjs-emscripten (Tier 0). **Python transforms → OS-native
Tier 1**, same as the document CLIs. If Pyodide is used at all, it is for *portability and convenience
inside an OS sandbox*, never as the boundary itself.

Corollary: this also kills the idea that WASM gives us a Windows answer for Python. Windows Python
isolation depends entirely on §4.

**Our document CLIs audit clean-ish.** Declared deps are `pypdf`, `pypdfium2`, `Pillow`, `python-docx`,
`python-pptx`, `icalendar`, `img2pdf`, `markitdown`, `click` — **no PyMuPDF** (experimental in WASM; the
third-party build is AGPL-3.0, a licensing landmine) and **no ReportLab** (unavailable). The one real
casualty is `pypdfium2` (native PDFium) in `pdf_tool.py`. The doc CLIs stay on Tier 1; they were never
the risky surface.

**Closed off:** Docker's SSA requires a paid subscription above **250 employees OR $10M revenue** (either
threshold) — **that liability lands on our customers, not us**; Gemini CLI, our closest analogue, made
containers optional. Hosted sandboxes (E2B/Modal/Daytona) are a change of product category: measured
cold starts **700–2400 ms**, plus uploading customer files off-machine.

---

## 6. Credentials — give the agent a verb, not a string

**No keychain stops same-user code.** Electron `safeStorage` on Windows protects *"from other users on
the same machine, but not from other apps running in the same userspace."* On Linux with no secret
store it uses a **hardcoded plaintext password** (`getSelectedStorageBackend() === 'basic_text'`). GNOME
disputes CVE-2018-19358 because **the session bus *is* the trust boundary**. Chrome's App-Bound
Encryption was framed as cost-and-noise from day one and a no-admin bypass still works on Chrome
144/145. Wardle proved it for Keychain in 2017.

**The macOS TCC asymmetry:** Apple's "Controlling app access to files" enumerates Desktop, Documents,
Downloads, network and removable volumes — and **never mentions dotfiles**. `~/Documents` (vacation
photos) is protected; `~/.aws/credentials` (production cloud access) is not.

**Eight prior-art designs converge on one inversion** — GitHub Actions OIDC (inject a *ticket to
request*, not the token), Docker credential helpers (a pointer to a fetcher), K8s bound SA tokens
(audience + time + object), Vault Agent, **SPIFFE/SPIRE** (*"MUST NOT require any direct authentication
of its clients"* — authorize by kernel peer credentials), tailscaled (keys stay in the daemon; expose
verbs, authorize by uid), Cloudflare write-only bindings. Academic form: **CapSeal** (arXiv:2604.16762) —
shift *"from handing the model a key to granting the model a narrowly scoped, non-exportable action
capability."*

**The strongest shipped design is the sentinel/mask proxy** (Claude Code v2.1.199+): the sandboxed
command sees a per-session placeholder; the proxy terminates TLS and swaps in the real secret **only on
requests to explicitly listed `injectHosts`**. *"The command and anything it logs never hold the real
credential, but its requests still authenticate."* It **fails closed** — without TLS termination the
sentinel reaches the server unchanged and auth simply fails. It even re-signs AWS SigV4.

Critically, the *setting itself* is privilege-separated: `mask`, `tlsTerminate`, and `strictAllowlist`
are **ignored in a repository's `.claude/settings.json`**. Copy that rule verbatim.

**Two implementation lessons:**

1. **Env scrubbing is a `fork()`-boundary control, not process-wide.** Microsoft found Claude Code's
   **Read tool ran in-process, bypassing bubblewrap entirely**, and read `/proc/self/environ` for the
   unscrubbed API key (fixed 2026-05-05 in v2.1.128 by hard-rejecting `/proc`). We have in-process tools
   too. Our `BLOCKED_ENV_VARS` is an **11-name denylist** and does nothing about `/proc`.
2. **The cheapest high-value control is a phase split.** Codex Cloud: *"secrets are removed before the
   agent phase starts."* Authenticate and cache in a trusted setup phase, then `exec` the model-facing
   worker with a scrubbed environment. No proxy, no broker, no FFI required.

**MCP tension we inherit:** the spec (current revision **2026-07-28**) is emphatic — *"MCP servers MUST
NOT accept or transit any other tokens"* — but also says stdio-transport implementations *"SHOULD NOT
follow this specification, and instead retrieve credentials from the environment."* We spawn stdio MCP
servers; the spec points us at the vulnerable pattern. Unresolved upstream.

---

## 7. Adversarial reality

**2025 was approval-bypass; 2026 is sandbox-escape.** Nine Cursor escapes and four Claude Code escapes
this year, including two *critical* Cursor CVEs (agent-controlled working directory; symlink with failed
path canonicalization falling back to the original path). **Assume escape and cap blast radius.**

**Egress allowlists rot** — three independent proofs: ForcedLeak exfiltrated to an **expired allowlisted
domain repurchased for ~$5**; CamoLeak (CVE-2025-59145) pre-computed a dictionary of **validly-signed
GitHub Camo URLs**, one per character; Claude Code CVE-2026-54316 allowlisted `huggingface.co` as a
**bare hostname**, so any attacker-controlled repo path was auto-approved. Our binary `(deny network*)`
is actually safer than a coarse allowlist.

**Command-string allowlists are not boundaries.** CVE-2025-66032 (blocklisted *arguments* on allowlisted
commands — RyotaK's "Pwning Claude Code in 8 Different Ways"); CVE-2026-22708 (shell **built-ins**
`export`/`set`/`declare` bypass allowlist validation entirely because they aren't binaries, poisoning
the environment so a legitimately-allowlisted `git branch` runs attacker code). Cursor's post-fix
guidance now *discourages relying on allowlists as a security barrier*. Zed is blunter: pattern rules
*"fall over instantly in the presence of an even vaguely sophisticated attacker."*

**Config is code.** CVE-2026-21852, CVE-2026-33068, CVE-2026-25725, MCPoison, CVE-2025-53773 all exploit
agent config files the agent or repo can write. Check Point: *"Configuration files that were once
passive data now control active execution paths."*

**Nx "s1ngularity" (2025-08-26)** is the one to internalize: attackers **weaponized victims' own AI
CLIs** with `--dangerously-skip-permissions` / `--yolo` to hunt for secrets. **2,349 credentials from
1,079 systems**; 33% of compromised machines had an LLM CLI installed; of 366 systems targeted this way,
95 executed the prompt.

**External citations that support our design** — NCSC (Dec 2025): *"Under the hood of an LLM, there's no
distinction made between 'data' or 'instructions'; there is only ever 'next token,'"* recommending
**deterministic (non-LLM) safeguards that constrain the actions of the system**. Five Eyes joint
guidance (May 2026): *"If you cannot understand, monitor or contain an agent's actions, it is not ready
for deployment."* NIST AI 100-2e2025 §3.5 covers agent hijacking to arbitrary code execution.

---

## 8. Recommended sequence

Ordered by risk-reduced ÷ effort. **Nothing here is decided — this is a proposal.**

| # | Action | Effort | Why now |
|---|---|---|---|
| 0 | **Audit every bailout path in `mode-manager.ts` + PowerShell validator for fail-open** | hours | Highest ratio in the report. **Partially done — see §11; we currently pass** |
| 1 | **Isolate `transform_data`** — JS via quickjs-emscripten; **Python via OS-native, not Pyodide** (§5.1) | S–M | Closes a live gap on macOS |
| 1b | **Sandbox the *sibling* tools too** — MCP stdio servers, the Python converters, browser automation | M | CVE-2026-25592: a sandboxed code path + one unsandboxed sibling = no sandbox |
| 2 | **Drop firejail** from both isolation modules | XS | Deletion. Removes a setuid-root dependency with a privesc CVE history |
| 3 | **Report achieved isolation honestly** — detect the Ubuntu bwrap failure; surface state in the UI | S | We currently claim `enforced` where it isn't, and disclose nothing |
| 4 | **Protected paths with no exemption** — `.git/hooks`, `.git/config`, settings, `.mcp.json`, shell rc | S | Cross-vendor escape primitive; we allow all writes under `sessionRoot` |
| 5 | **Phase-split credentials** — drop secrets before model-directed execution | S | Codex Cloud's model; large blast-radius cut, no new infrastructure |
| 6 | **macOS sandbox self-test** at startup | XS | Insurance against silent Seatbelt degradation (LEARNING-048 shape) |
| 7 | **AppContainer spike** — does `node.exe`/`bun.exe` run inside one? | 1–2 d | **Gates the entire Windows strategy** |
| 8 | **Windows Tier-1** — Job Object + restricted token + alt desktop, or AppContainer if #7 passes | M–L | Depends on #7 |
| 9 | **Landlock backend** for Linux | M | Correct primitive; sidesteps the Ubuntu userns block |
| 10 | **Credential store → OS keychain / `safeStorage`**, with honest Linux `basic_text` detection | M | Current key is derivable by any same-user process |
| 11 | **Deny-read the credential dotfiles** in the Seatbelt profile | S | `(allow file-read*)` currently permits `~/.ssh`, `~/.aws`, our own store |
| 12 | **Broker + egress proxy** with sentinel masking | L | The strategic end-state; only after 1–11 |

**Commit now, before any Windows work:** **stdio-pipe IPC, never loopback TCP.** AppContainer blocks
loopback, Linux netns blocks it, and exempting it on Windows requires admin. Expensive to retrofit.

---

## 9. Open questions

**For Jeff:**
- Is the AppContainer spike worth 1–2 days? It's the fork between a real Windows boundary and
  write-confinement only.
- Does ADR-0009's "Windows/Linux lanes keep their config but are not published" posture get reversed?
  That's a separate ADR, and a one-way-ish door on support burden.
- Item 10 touches shipped credential storage — migration needs care and is Jeff's call.

**Unverified / needs follow-up:**
- Whether `node.exe`/`bun.exe` runs in an externally-created AppContainer (**gates §4**).
- Landlock default-enablement on Debian 13, Ubuntu 24.04/26.04, RHEL 10 — detect at runtime regardless.
- Pyodide package availability was argued from pure-Python reasoning; **pyodide.org 403s automated
  fetches**. Verify against the live package index before committing.
- `@landstrip/landstrip`'s Windows implementation and its **LGPL-2.1+** implications for a signed binary.
- Trend Micro's widely-recirculated "48% of 19,402 MCP implementations" — primary returns 403,
  unverified. The **Cyata "MCP's Quiet Crisis" post contains no statistics at all**; any percentage
  attributed to it is misattributed.
- Deno's raw runtime binary size for a 2026 release (the 70–110 MB figure is `deno compile` output).

---

## 10. Two audits run against our code — both pass

### 10.1 Fail-open bailouts: we fail **closed** ✅

The highest-ratio finding in the report is Claude Code's **ADVISORY-CC-2026-002**: a *performance* cap in
`bashPermissions.ts` limited analysis to 50 subcommands, and any command with more caused **all deny
rules to be silently skipped**. PoC was 50 `true` no-ops then `curl`. It originated as a UI-freeze fix.

Our equivalent surfaces are large (`mode-manager.ts` 2,177 lines; `powershell-validator.ts` 1,095), so I
audited the bailout paths. **On everything I checked, we fail closed:**

- `powershell-validator.ts:400-418` — both `!parseResult.success` and non-empty `parseErrors` return
  **`allowed: false`** with `type: 'parse_error'`. This is exactly what Anthropic got wrong.
- `powershell-validator.ts:355-368` — JSON-parse failure and PowerShell-execution failure both return
  `{success: false}`, which the caller converts to `allowed: false`.
- `mode-manager.ts:153-161` — an invalid glob pattern is caught, skipped, and the function falls through
  to `return false` (not allowed).

**One item still worth a dedicated look:** `mode-manager.ts:1653` documents a **regex fallback for
PowerShell write-target extraction** used when `isPowerShellAvailable()` is false — *"this regex is the
only path extraction mechanism."* A regex approximating a parser is the CVE-2025-66032 class (your
validator and the real parser disagree). The open question is whether a `null` extraction result denies
or allows; I did not trace the caller.

**Also unresearched:** lane 4 explicitly flagged that it could not find PowerShell-validator-specific
bypass research and recommended a dedicated follow-up. Given we ship 1,095 lines of it and it is
Windows-critical, that gap should be closed before Windows ships.

### 10.2 Seatbelt default posture: `(deny default)` ✅

Pillar Security's Antigravity writeup (2026-07-20) found a profile using `(allow default)` — making it a
denylist — and escaped via devfs + a fake `.app` bundle + Launch Services + `BASH_ENV`. Their conclusion:
**"You cannot patch your way out of an inverted default."**

`filesystem-isolation.ts:46` is `(deny default)`. We pass. (The `(allow default)` at line 30 is only the
capability probe for whether `sandbox-exec` works at all — not the enforcement profile.)

---

## 11. Standards corrections from the final lane

- **OWASP LLM Top 10 2026 exists** (resources-library date **2026-08-03**; the shipped PDF still has
  `[Publication date to be set]` placeholders). LLM01 remains #1; **Excessive Agency climbed to #3**.
  Its framing is now unambiguous: *"no reliable prevention mechanism exists today… **Defense is
  therefore architectural rather than interceptive**."* Mitigation #11 explicitly says to **reject
  static-only attack-success claims**, citing Nasr et al.
- **OWASP Top 10 for Agentic Applications 2026 is released**, not draft (announced 2025-12-09,
  ASI01–ASI10). LLM01 maps to seven of the ten ASI entries — the widest fan-out on the list.
- **MCP's isolation language is entirely SHOULD-level.** The only MUST is a consent-UI requirement.
  *"Sandboxing MCP servers puts you ahead of the spec, not in compliance with it."* Note the spec's
  **"stdio Transport Security in Proxy Scenarios"** section applies to us directly — an Electron main
  process spawning MCP servers on behalf of a renderer *is* a proxy architecture in the spec's sense,
  including the XSS→token-theft→arbitrary-spawn chain it describes.
- **The MCP Registry is still in preview and provides namespace verification only — no artifact
  signing.** Provenance exists only in third-party infrastructure (Stacklok ToolHive with Sigstore;
  Docker MCP Gateway with per-server containers and secrets-API injection).
- **Our bundled converters are a distinct attack surface.** They parse attacker-supplied files through
  memory-unsafe C. Pillow 2026: CVE-2026-25990 (CVSS 8.9, OOB write via crafted PSD), CVE-2026-40192
  (FITS decompression bomb), CVE-2026-42308/09/10/11. pypdf: CVE-2026-27628, -33123, -41314, -71852,
  -71870. **These deserve resource caps and sandboxing even though they are not "code execution."**

---

## 12. Source anchors

Harnesses: `anthropic-experimental/sandbox-runtime` (**not** `anthropics/` — that 404s), v0.0.73
2026-08-13 · `openai/codex` `codex-rs/windows-sandbox-rs/src/{token,wfp,acl,desktop}.rs` ·
`google-gemini/gemini-cli` `packages/core/src/sandbox/windows/` · `chromium/src` `sandbox/policy/features.cc`
· zed.dev/blog/sandboxing (2026-08-05) · cursor.com/blog/agent-sandboxing (2026-02-18)

OS: MS Learn "Launch an AppContainer" (2025-09-03), `CreateRestrictedToken`, Job Objects (2025-07-14),
Windows Sandbox (2026-03-29), MDAG deprecation · docs.kernel.org/userspace-api/landlock.html ·
apple/containerization#737

Adversarial: arXiv:2503.00061 · arXiv:2510.09023 · arXiv:2607.05743 · arXiv:2604.16762 (CapSeal) ·
NIST AI 100-2e2025 §3.5 · NCSC "Prompt injection is not SQL injection" (2025-12-08) · Five Eyes
"Careful adoption of agentic AI services" (2026-05) · GitGuardian s1ngularity analysis ·
Trail of Bits "Insecure credential storage plagues MCP" (2025-04-30)

Credentials: code.claude.com/docs/en/{env-vars,sandboxing,authentication} ·
electronjs.org/docs/latest/api/safe-storage · security.googleblog.com (2024-07-30) ·
support.apple.com "Controlling app access to files" · modelcontextprotocol.io/specification/2026-07-28
