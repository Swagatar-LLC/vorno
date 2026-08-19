# 02 — OS-Native Sandboxing Primitives (2026)

**Research date:** 2026-08-18. Source report preserved substantially as produced.
**Status:** research input only — see [`README.md`](README.md).

> **Windows content is recorded, not proposed.** Windows support is explicitly not a decision
> at this time.

---

## Executive answer

**There is exactly one Windows primitive that gives kernel-enforced *network* denial to a
non-admin-spawned child process: AppContainer (LowBox token) launched without the
`internetClient` capability.** Everything else on Windows that denies network requires admin
(WFP filters, `netsh advfirewall`, a separate local user account, Hyper-V).

**Filesystem confinement without admin is achievable two ways** — AppContainer package-SID ACLs,
or a `WRITE_RESTRICTED` restricted token with a synthetic restricting SID stamped into workspace
ACLs. The second is what OpenAI and DeepSeek shipped.

**Both major agent vendors evaluated AppContainer and rejected it**, then were forced into
requiring elevated one-time setup to get network denial. Their reasoning is partially inapplicable
to a scratch-directory model like Vorno's.

---

# WINDOWS

## 1. AppContainer / LowBox tokens

### Documented launch sequence

From [Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
(MS Learn, updated 2025-09-03):

1. `DeriveCapabilitySidsFromName(L"internetClient", ...)` → capability SIDs (wrap it; it returns
   both group and capability SIDs and you want `CapabilitySids[0]`).
2. `CreateAppContainerProfile(name, displayName, description, pCapabilities, count, &pSidAppContainer)`
   — `userenv.h`, `Userenv.dll`, **minimum Windows 8 / Server 2012**, desktop apps only. Name must
   match `[-_. A-Za-z0-9]+`, ≤64 chars.
3. On `HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)`, fall back to
   `DeriveAppContainerSidFromAppContainerName(name, &sid)` for a stable SID across runs.
4. `InitializeProcThreadAttributeList` (twice — once with `NULL` to size), then
   `UpdateProcThreadAttribute(..., PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &SECURITY_CAPABILITIES{...})`.
5. For LPAC additionally: `UpdateProcThreadAttribute(..., PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
   &PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT, ...)` — attribute count becomes 2.
6. `CreateProcess(NULL, cmdline, ..., EXTENDED_STARTUPINFO_PRESENT, NULL, NULL, (LPSTARTUPINFOW)&si, &pi)`.

### Non-elevated? Yes. (Confidence: high)

`CreateAppContainerProfile` *"creates a profile for the current user"*; only creating a profile on
behalf of another user requires impersonation. The profile lives at
`C:\Users\<u>\AppData\Local\Packages\<Name>\AC` and the OS **automatically reroutes `LOCALAPPDATA`,
`TEMP` and `TMP`** into it. Corroborating: [Chromium's sandbox FAQ](https://chromium.googlesource.com/chromium/src/+/main/docs/design/sandbox_faq.md)
states *"no administrator access is necessary… a pure user-mode library, and any user can run
sandboxed processes"*, and Chrome's non-elevated browser process ships AppContainer for the network
service today.

### Network denial — the headline capability

Without `internetClient`, an AppContainer has **no network access, enforced by the kernel via WFP's
ALE AppContainer layers** — not by an installed firewall rule. MS doc: *"without the network
capability, an AppContainer cannot access the network."* Independently verified in
[blahcat's writeup](https://blahcat.github.io/2020-12-29-cheap-sandboxing-with-appcontainers/) — DNS
resolution fails outright.

Capabilities: `internetClient` (outbound), `internetClientServer` (+inbound),
`privateNetworkClientServer` (RFC1918; note "private" classification is Group-Policy-configurable).
Granularity is coarse — internet yes/no, **no per-host allowlist at this layer**.

**Loopback is blocked by default — two-edged.** AppContainers cannot connect to 127.0.0.1.
Exempting requires `CheckNetIsolation.exe LoopbackExempt -a -n=<name>` or
`NetworkIsolationSetAppContainerConfig`. **Chromium's own commit message for the LPAC network
service flag calls this a shipping blocker: *"LPAC blocks access to localhost, which cannot be
resolved without a loopback exemption requiring Admin access."*** For Vorno this is *good* if the
child shouldn't reach a local dev server, and *bad* if TCP-based IPC was planned. **Use stdio pipes
or a named pipe ACL'd to the package SID.**

### Filesystem / ACL implications — the real cost

Dual-principal model: effective access is the *intersection* of user/group SIDs and
package/capability SIDs. The container runs at **Low integrity**.

- `C:\Windows\System32` already carries `ALL APPLICATION PACKAGES` (`S-1-15-2-1`) read+execute ACEs
  → a plain AppContainer can load system DLLs. **LPAC cannot** — it only honors
  `ALL RESTRICTED APPLICATION PACKAGES` (`S-1-15-2-2`) or the specific package SID, so LPAC needs
  `registryRead`, `lpacCom`, etc. explicitly.
- **Your own app tree does not have these ACEs.** An Electron app in
  `%LOCALAPPDATA%\Programs\Vorno` needs an explicit read+execute ACE for the package SID on
  `node.exe`/`bun.exe`, every `.node` addon, and all touched `node_modules`. You own those files, so
  **no admin needed** — but you must do it, and **an electron-updater differential/NSIS update that
  replaces the app directory may drop the ACEs. Re-apply idempotently on every launch.**
- Grant write to exactly one scratch dir via a package-SID ACE. Everything else denied by default.
- APIs: `SetEntriesInAclW` + `SetNamedSecurityInfoW`, `SE_FILE_OBJECT`, `TRUSTEE_IS_SID`.

### Developer experience from Node/Electron

**No first-party Microsoft binding and no long-established npm package.** As of 2026-08:

| Package | Latest | Windows story | Assessment |
|---|---|---|---|
| `@landstrip/landstrip` | 0.18.33 (2026-08-17) | Ships `landstrip-win32-x64`/`arm64` prebuilts; README says *"AppContainer or restricted users on Windows"* | Only maintained npm package claiming AppContainer. **LGPL-2.1+ core** with Apache-2.0 JS wrapper — *check implications for a signed shipped binary.* Docs thin on Windows specifics. |
| `@anthropic-ai/sandbox-runtime` | 0.0.73 (2026-08-13) | Windows **alpha**; does *not* use AppContainer — dedicated `srt-sandbox` user + WFP + NTFS ACLs, **requires one-time elevated `windows-install`** | Mature on macOS/Linux; disqualifying admin requirement on Windows |
| `@deepseek-ai/dsh-sandbox-windows-acl` | 0.0.1-rc.1 (2026-08) | Restricted-token spawn with orphan-SID write allowlist, **via `koffi` FFI** | Pre-release, but the `koffi` approach is the DX unlock |

**You do not need a C++ N-API addon.** DeepSeek's Windows backend depends only on
[`koffi`](https://www.npmjs.com/package/koffi). Every API in the chain
(`CreateAppContainerProfile`, `DeriveCapabilitySidsFromName`, `InitializeProcThreadAttributeList`,
`UpdateProcThreadAttribute`, `CreateProcessW`, `SetEntriesInAclW`, `SetNamedSecurityInfoW`) is a
plain `advapi32`/`userenv`/`kernel32` export. Struct layout (`SECURITY_CAPABILITIES`,
`SID_AND_ATTRIBUTES`, `STARTUPINFOEXW`) plus the opaque `PROC_THREAD_ATTRIBUTE_LIST` is the fiddly
part. **Estimate: 400–800 lines of TS + FFI declarations.**

**Caveat that gates everything:** **could not verify whether stock `node.exe`/`bun.exe` runs cleanly
inside an externally-imposed AppContainer.** Closest analogue is
[SandboxYourFox](https://github.com/WildByDesign/SandboxYourFox), which runs Firefox under LPAC only
in single-process mode. Node is single-process and simpler, and a plain AppContainer inherits
System32's ACEs, so it *should* work — **but prototype before committing.** Expected friction:
named-pipe ACLs, `%TEMP%` redirection surprising build tools, children that spawn.

## 2. Restricted tokens and Job Objects

[`CreateRestrictedToken`](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)
(`securitybaseapi.h`, `Advapi32.dll`, **Windows XP+**). Three axes: deny-only SIDs, deleted
privileges, and **restricting SIDs** (two access checks — enabled SIDs and restricting SIDs — grant
only the intersection).

Flags: `DISABLE_MAX_PRIVILEGE` (0x1), `SANDBOX_INERT` (0x2 — post-KB2532445 *ignored* unless caller
is LocalSystem/TrustedInstaller), `LUA_TOKEN` (0x4), `WRITE_RESTRICTED` (0x8 — restricting SIDs
consulted **only on writes**).

**Critical non-admin note, from the doc:** *"If a process calls `CreateProcessAsUser` using a
restricted version of its own token, the calling process does not need to have the
`SE_ASSIGNPRIMARYTOKEN_NAME` privilege."* → **fully available to a non-elevated Electron app.**

**What it cannot do: network.** A restricted token has no network dimension.

**Also from the doc:** *"Applications that use restricted tokens should run the restricted
application on desktops other than the default desktop… to prevent an attack by a restricted
application, using `SendMessage` or `PostMessage`, to unrestricted applications on the default
desktop."* Codex implements this (`desktop.rs` → `CreateDesktopW` + `SetSecurityInfo` on
`SE_WINDOW_OBJECT`).

### Job Objects

`CreateJobObject` → `AssignProcessToJobObject` → `SetInformationJobObject`. Children auto-associate
unless `JOB_OBJECT_LIMIT_BREAKAWAY_OK`/`SILENT_BREAKAWAY_OK`. Nesting since Windows 8.

**Can confine:** process count, committed/working-set memory, CPU rate, wall-clock end-of-job time,
priority/affinity, UI restrictions (clipboard, desktop switching, global atoms, handle access), and
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` for guaranteed teardown.

**Cannot confine:** filesystem, registry, network. Note *"Starting with Windows Vista, security
limits must be set individually for each process associated with a job object."*

**Verdict: mandatory complement (resource DoS + reliable kill), never a security boundary.**

## 3. Windows Sandbox and WDAG

**Windows Sandbox** (docs page dated 2026-03-29): Pro / Enterprise / Pro Education / SE / Education.
**Explicitly not supported on Home.** Requires hardware virtualization + Windows Hypervisor Platform.
Networking on by default; disable via `.wsb` `<Networking>`. **Only one instance at a time** — fatal
for a multi-session agent app. Arm64 supported on Windows 11, but Snapdragon X users report
BaseImage provisioning failures. Enabling requires admin. Host software isn't present inside.

**WDAG / Microsoft Defender Application Guard is deprecated and removed.** Deprecation announced
Dec 2023 (Edge) / Nov 2023 (Office). **Removed in Windows 11 24H2, including the Windows Isolated App
Launcher APIs.** Final support ends **2026-11-10**. Microsoft concedes *"there is no direct
replacement."* **Do not build on WDAG.**

## 4. WSL2 as a sandbox

`wsl --install` (page updated 2026-06-02) requires Windows 10 build 19041+ or Windows 11, **and
explicitly "Open PowerShell in administrator mode"**, then reboot, then a hundreds-of-MB distro
download.

- **Cannot be silently provisioned from a non-elevated signed app.**
- Arm64 supported on modern hardware; **not on Snapdragon 835-class** devices.
- Enterprise-managed machines frequently block virtualization or WSL by policy.
- Codex supports WSL2 and **dropped WSL1 in v0.115**. Note `wsl.exe` is blocked from inside Codex's
  own Windows sandbox ([codex#21470](https://github.com/openai/codex/issues/21470)).

**Verdict: opt-in "advanced mode" for users who already have WSL2. Never a default.**

## 5. Newer Windows 11 primitives

**Win32 App Isolation** — **still carries the "This feature is in preview" banner.** Release notes
have not been updated since **build 26100.2454 (2024-11-21)** — ~21 months. Requires Windows 11 24H2+.

**Structurally it does not apply.** It is a *packaging* feature: you MSIX-package your app and the OS
launches *that app* into an AppContainer. It confines the packaged app, not an arbitrary spawned
child. Underneath it is the same AppContainer machinery — so call the APIs directly and skip the
packaging, preview status, 24H2 floor, and auto-update/code-signing disruption.

"Trusted Launch" is an Azure VM feature, unrelated. **No other new Windows 11 process-confinement
primitive was found** — treat as "not verified absent" rather than confirmed absent.

## 6. Chromium's sandbox — can Electron reuse it?

Architecture: **broker/target**, four layers — restricted token (untrusted IL), job object,
alternate desktop, integrity levels — plus mitigations (ACG, CIG, win32k lockdown, CFG).

Current state from [`sandbox/policy/features.cc`](https://github.com/chromium/chromium/blob/main/sandbox/policy/features.cc)
(read at HEAD, 2026-08): `kWinSboxNetworkServiceSandboxIsLPAC` is `FEATURE_DISABLED_BY_DEFAULT` →
**the network service runs in a plain App Container by default.** `kRendererAppContainer` and
`kPrintCompositorLPAC` also disabled by default. AppContainer gate is `base::win::Version::WIN10_20H1`.

**Structurally unusable, for two documented reasons:**

1. **It requires cooperative targets.** The target must call `LowerToken()` after bootstrapping.
   Before that call the process is *not* fully restricted. The design *"assumes malicious code only
   appears after early startup"* — the doc concedes this *"is not security"* against non-cooperative
   code. Model-authored code runs from the moment the interpreter starts.
2. **The FAQ warns against it:** *"you should only sandbox code that you fully control or that you
   fully understand. Sandboxing third-party code can be very difficult."*

Electron doesn't expose `sandbox::BrokerServices` to JS; `utilityProcess` gives a Node process, and
Electron's `sandbox: true` is a *renderer* flag with no Node access.

**Verdict: no. Borrow the design, not the code.**

## 7. Prior art — what OpenAI and Anthropic shipped

### OpenAI Codex (`codex-rs/windows-sandbox-rs`, read at `main` 2026-08-18)

Their engineering post states they evaluated and rejected all three off-the-shelf options:

- **AppContainer** — real OS boundary, but *"its reliance on ACLs for file-based restrictions makes
  changing sandbox semantics expensive and complex,"* versus macOS where an `.sbpl` profile is
  regenerated per invocation. Also assumes the app needs no host access — false for an agent that
  must read a whole checkout.
- **Windows Sandbox** — too detached from the real checkout, unavailable on Home.
- **MIC labeling** — would change the trust semantics of the user's actual workspace.

What they built, verified in source:

- `token.rs`: `CreateRestrictedToken` with **`DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`**
  and restricting SIDs ordered *`[capabilities…, extraRestricting…, LogonSid, Everyone]`*, then
  `SetTokenInformation(TokenDefaultDacl)`.
- `cap.rs`: the "capability SID" is a **randomly generated synthetic SID
  `S-1-5-21-{u32}-{u32}-{u32}-{u32}`**, persisted to `~/.codex/cap_sid`, per-workspace and
  per-write-root. ACE'd onto the workspace; with `WRITE_RESTRICTED`, writes succeed only where that
  ACE exists. **Needs no admin.**
- `desktop.rs`: alternate desktop. `acl.rs`/`workspace_acl.rs`/`deny_read_acl.rs`: ACL machinery.
- `wfp.rs`/`wfp_setup.rs`: `FwpmEngineOpen0`/`FwpmFilterAdd0` with `FWPM_CONDITION_ALE_USER_ID` and
  `FWPM_FILTER_FLAG_PERSISTENT` — **network blocking, elevated only.**
- `identity.rs`/`setup.rs`: dedicated local accounts `CodexSandboxOffline`/`CodexSandboxOnline`,
  DPAPI-protected credentials, plus `hide_users.rs`.

`sandboxing/windows.rs` enumerates what **unelevated** mode cannot do, in its own error strings:
*"windows unelevated restricted-token sandbox cannot enforce split filesystem…"*, *"…cannot enforce
deny-read restrictions"*, *"…cannot enforce split writable roots"*, *"…cannot reopen writable
descendants."* Because *"its `WRITE_RESTRICTED` token does not make capability SID deny-read ACEs
[effective]."*

**Unelevated Codex therefore has: write confinement (with the documented "Everyone SID gap"), no read
confinement, and only environment-variable-level network blocking** which they describe as easily
bypassed by any program that opens a socket directly.

### Anthropic Sandbox Runtime (v0.0.73, 2026-08-13)

- macOS: `sandbox-exec` with dynamically generated Seatbelt profiles. No elevation.
- Linux: bubblewrap + netns isolation + seccomp-BPF for Unix socket restrictions. No elevation.
- **Windows: alpha.** Dedicated `srt-sandbox` local user + WFP + NTFS ACLs. **Requires one-time
  elevated `windows-install`.**
- Network proxy-mediated everywhere (HTTP + SOCKS5, deny-by-default allowlist).

**Convergent conclusion from two independent teams: with no admin and no install, you cannot strongly
deny network on Windows via the restricted-token route.** Neither took the AppContainer route that
*would* have given non-admin network denial — because AppContainer's ACL model is too rigid for an
agent that must read the user's entire filesystem.

**Vorno's situation differs.** If model-authored code runs against a *scratch workspace* rather than
the user's whole checkout, AppContainer's rigidity is far less costly.

---

# macOS

## `sandbox-exec` / Seatbelt

**Deprecated in the man page since ~2016; still present and functional through macOS 26 (Tahoe),
including 26.3.** Newer builds emit a runtime banner: *"sandbox-exec is deprecated. Consider adopting
the App Sandbox instead."* `sandbox_init(3)` has carried `__deprecated` for the same period.

**Is it going away?** No evidence of a removal date. It is load-bearing for macOS itself (profiles at
`/System/Library/Sandbox/Profiles`), for Bazel, and for Codex.
[apple/containerization#737](https://github.com/apple/containerization/issues/737) (opened
2026-05-12, **still open, no Apple response**) asks Apple directly for a removal timeline and a
supported non-App-Store replacement. **Unresolved standing risk.**

The larger risk is **silent behavior change plus an undocumented policy language** — SBPL is not
documented for third-party use, and Bazel got a report that network blocking silently stopped working
around Catalina.

## Successors — there is no real one

- **App Sandbox** — entitlement-driven, requires code signing, designed for GUI apps. Not a
  per-invocation policy mechanism.
- **Sandbox inheritance.** Children inherit the parent's sandbox automatically **at the kernel level,
  regardless of entitlements**. `com.apple.security.inherit` exists chiefly as an App Review marker.
  Hard rule: a child that inherits must have **exactly** `app-sandbox` + `inherit` and **no other App
  Sandbox entitlement — any extra aborts the child** (classic failure: Xcode's
  `com.apple.security.get-task-allow` in a debug build). Also `_libsecinit_appsandbox` traps if a
  *non*-sandboxed parent spawns a child marked `inherit`. Inheritance gives the *parent's* sandbox —
  coarse, and Vorno's main process presumably isn't sandboxed.
- **Endpoint Security** — authorization callbacks (`ES_EVENT_TYPE_AUTH_*`), but it's a
  monitoring/authorization framework, not a declarative exec-time confinement profile. Requires the
  `com.apple.developer.endpoint-security.client` entitlement, which **Apple grants by application
  only**, plus TCC Full Disk Access. Wrong tool, high friction.
- **Virtualization.framework / `container`** — real isolation, but ~800 ms startup and 128 MB+ per
  instance versus <5 ms for Seatbelt.

**Recommendation: keep `sandbox-exec`, keep SBPL profiles small and mechanically generated, add a
startup self-test that verifies the profile actually denies what you think it denies, and log loudly
if it stops working.**

---

# LINUX

## Landlock — the strategic winner

Introduced **Linux 5.13**, requires `CONFIG_SECURITY_LANDLOCK=y`. ABI ladder:

| ABI | Kernel | Adds |
|---|---|---|
| 1 | 5.13 | Filesystem access control |
| 2 | 5.14 | `LANDLOCK_ACCESS_FS_REFER` (rename/link) |
| 3 | 5.15 | Truncation |
| 4 | **5.16** | **TCP bind + connect restrictions** |
| 5 | 5.17 | Device ioctl |
| 6 | 5.19 | Signal + abstract UNIX socket scoping |
| 7 | 6.2 | Audit logging |
| 8 | 6.5 | Multithreaded enforcement (`RESTRICT_SELF_TSYNC`) |
| 9 | 6.8 | Pathname UNIX socket restrictions |
| 10 | 6.11 | UDP operations, quiet rule flags |

*(Some sources place TCP restrictions at 6.7 rather than 5.16. **Verify at runtime** via
`landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` rather than trusting a table.)*

**Key property:** *"empowers any process, including unprivileged ones, to securely restrict
themselves."* No root, no setuid, no namespaces. Requires `CAP_SYS_ADMIN` or — the normal path —
`PR_SET_NO_NEW_PRIVS`.

**Limitations:** max 16 stacked rulesets per thread; cannot restrict mount/`pivot_root`; ioctl
restrictions apply only to newly-opened device files; special filesystems not explicitly covered; and
it **cannot restrict `chdir`, `stat`, `flock`, `chmod`, `chown`, `setxattr`, `utime`, `fcntl`,
`access`**. Metadata leaks through.

**Availability is the real problem.** Landlock must also be in `CONFIG_LSM` or on the `lsm=` cmdline.
Enabled by default in Arch, Fedora, Gentoo. **Debian historically declined**
([#999551](https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=999551)). Could **not verify** current
status for Debian 13, Ubuntu 24.04/26.04, or RHEL 10 — **detect at runtime** (`/sys/kernel/security/lsm`).
Gotcha: the `lsm=` boot parameter **replaces** `CONFIG_LSM` rather than appending.

## seccomp-bpf

Universally available, no privileges needed. Filters syscalls by number and *scalar* arguments only —
**it cannot dereference pointers**, so it cannot filter by pathname or sockaddr. Useful for killing
whole syscall families (`socket`, `connect`, `ptrace`, `mount`, `keyctl`, `bpf`, `unshare`).
`SECCOMP_RET_USER_NOTIF` allows richer supervisor decisions but is complex and TOCTOU-prone for path
arguments. **Complement to Landlock, never alone.**

## bubblewrap

Two build modes: setuid-root, or unprivileged-with-user-namespaces. Modern distros ship the latter —
which is where it breaks.

**Ubuntu 23.10+ and 24.04 LTS set `kernel.apparmor_restrict_unprivileged_userns=1` by default**,
blocking `unshare(CLONE_NEWUSER)`. Symptoms: `bwrap: setting up uid map: Permission denied`,
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. **Canonical deliberately declined to
ship a `bwrap` profile** — because bwrap can launch arbitrary binaries into a new userns, a permissive
profile would nullify the mitigation. A profile was added, reverted (it broke Flatpak saves), and
partially reworked; **a current 24.04 install has no bwrap profile out of the box.**

Workarounds, none performable by a non-admin installer: load the upstream `bwrap-userns-restrict`
profile (root, no reboot); a custom `/etc/apparmor.d/bwrap` with `userns,` (grants the capability to
*anything* executing `/usr/bin/bwrap`); or `kernel.apparmor_restrict_unprivileged_userns=0`
(disables the mitigation machine-wide — don't).

**Consequence: the bwrap path silently fails on the most common Linux desktop distro. Detect and fall
back rather than erroring.**

## firejail — recommend dropping

Firejail is **setuid-root by design**, and its CVE history follows directly:

- **CVE-2022-31214** (fixed 0.9.70) — `--join` accepts an attacker-crafted container where the userns
  is still the initial one and `NO_NEW_PRIVS` is inactive; escalates via `su`/`sudo`. Mitigation
  without upgrade: `force-nonewprivs yes` or `join no`.
- **CVE-2021-26910** — OverlayFS TOCTOU between `stat` and mount; sandbox escape → privesc.
- Command injection via `--output`/`--output-stderr` shell metacharacters (≤0.9.62).
- Host `firejail` binary truncation from inside a root-started sandbox (<0.9.60), CVE-2019-5736-style.
- Dotfile handling with euid 0 (<0.9.44.6); 2016 `--get`/`--put` TOCTOU root privesc.

No 2024–2026 CVEs found in aggregators — but absence in aggregators is weak evidence, and the
architectural pattern (setuid-root + complex namespace/path validation) has not changed. Gentoo has
issued repeated GLSAs ([202105-19](https://security.gentoo.org/glsa/202105-19),
[202305-19](https://security.gentoo.org/glsa/202305-19)).

**Recommendation: drop firejail.** Shipping a signed desktop app that shells out to a setuid-root
binary with this record adds attack surface to the *host*. Landlock + seccomp covers the same ground.

---

# Direct answers

## Q1 — Can a non-admin Electron app confine a child's filesystem AND network with no extra install?

**Yes, exactly one way: AppContainer without `internetClient`.**

| Dimension | Verdict | Confidence |
|---|---|---|
| **Network denial**, non-admin, no install | **Yes — AppContainer with zero network capabilities.** Kernel/WFP-enforced. Blocks loopback for free. **Only such mechanism.** | **High** |
| **Filesystem confinement**, non-admin | **Yes, two routes.** (a) AppContainer package-SID ACLs (default-deny). (b) `WRITE_RESTRICTED` token + synthetic restricting SID (write-only, no read confinement, `Everyone` gap). | **High** — (b) shipping in Codex |
| **Both together**, non-admin, no install | **Yes via AppContainer — but unproven for a Node/Bun child** | **Medium** |
| Both via restricted tokens alone | **No.** No network dimension; the only non-admin substitute is env-var proxy poisoning, bypassable by any direct socket call. | **High** |

**Gating spike:** plain AppContainer (not LPAC), read+execute ACEs for the package SID on the app
tree, write ACE on one scratch dir, no capabilities, stdio-only IPC. Test
`node -e "require('fs').writeFileSync(...)"` and a `fetch()`.

## Q2 — Ranking

Cost 1 cheap → 5 brutal; strength 1 weak → 5 strong; friction 1 none → 5 blocking.

| # | Option | Cost | Strength | Friction | Verdict |
|---|---|---|---|---|---|
| **1** | **Job Object + `WRITE_RESTRICTED` token + synthetic SID + scratch ACE + alt desktop** | **2** | **2.5** (writes/privileges/UI; **no network, no read confinement**) | **1** | Ship first. Proven in Codex and DeepSeek. All non-admin. Reachable via `koffi`. |
| **2** | **AppContainer (no capabilities) + package-SID ACLs + Job Object** | **4** | **4** | **1.5** | **Strategic target.** Only non-admin path to network denial. Gate on the spike. |
| 3 | AppContainer → **LPAC** | 5 | 4.5 | 3 | Strongest non-VM, but endless capability chasing. Mozilla deprioritized; Chromium flag-off. Not for v1. |
| 4 | Dedicated local user + WFP (OpenAI/Anthropic elevated design) | 5 | 4.5 | **5 — admin** | Violates the no-admin constraint. Opt-in "hardened mode" only. |
| 5 | WSL2 | 3 | 4.5 | **5** | Opt-in only. |
| 6 | Windows Sandbox | 3 | 5 | **5** | Disqualified by Home + single-instance. |
| 7 | Chromium sandbox reuse | 5 | n/a | 1 | **Structurally impossible** (`LowerToken()`). |
| 8 | Win32 App Isolation | 4 | 4 | 3 | Preview, stalled, wrong shape. Skip. |
| 9 | WDAG | — | — | — | **Removed.** |

## Q3 — Minimum viable Windows isolation

All non-admin:

**Layer 0 — Job Object (unconditional, ~50 lines).** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
`LIMIT_ACTIVE_PROCESS`, `LIMIT_JOB_MEMORY`, CPU rate cap, and UI restrictions
(`UILIMIT_HANDLES | READCLIPBOARD | WRITECLIPBOARD | DESKTOP | EXITWINDOWS | GLOBALATOMS | SYSTEMPARAMETERS`).
Do **not** set `BREAKAWAY_OK`.

**Layer 1 — restricted token.**
```
CreateRestrictedToken(
  hOwnToken,
  DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
  0, NULL,                      // no deny-only SIDs
  0, NULL,                      // DISABLE_MAX_PRIVILEGE covers privileges
  n, restrictingSids,           // [syntheticWorkspaceSid, LogonSid, Everyone]
  &hRestricted);
SetTokenInformation(hRestricted, TokenDefaultDacl, ...);  // exclude the synthetic SID
CreateProcessAsUser(hRestricted, ...);                     // no SE_ASSIGNPRIMARYTOKEN needed
```

**Layer 2 — scratch directory.** `%LOCALAPPDATA%\Vorno\sandboxes\<sessionId>` with a write-allow ACE
for the synthetic SID. Fresh SID per session. Set `TEMP`/`TMP`/`HOME` into it.

**Layer 3 — alternate desktop.** `CreateDesktopW` with a random name, ACL'd to the logon SID, passed
via `STARTUPINFO.lpDesktop`. Documented as required, not optional.

**Layer 4 — network.** **Cannot be enforced** without admin or AppContainer. Env-var proxy poisoning
is what Codex's unelevated mode does; **label it "best-effort" in the UI, not "blocked."**

### Gaps to document

1. **No network enforcement** in this configuration.
2. **No read confinement** — `WRITE_RESTRICTED` consults restricting SIDs only for writes. The child
   reads anything the user can: SSH keys, browser profiles, `.env`, cloud credentials. **For an agent
   running model-authored code, exfiltration-by-reading is arguably the primary threat, and this
   design does not address it.**
3. **The `Everyone` gap** — any directory already granting `Everyone` write is unprotected.

Gaps 1 and 2 are exactly why AppContainer matters — it closes both.

---

## Cross-platform architectural notes

- **Do not use loopback TCP for host↔child IPC.** AppContainer blocks it, Linux netns blocks it,
  exempting needs admin on Windows. **Use stdio pipes** (or named pipes / Unix domain sockets).
  Decide now — expensive to retrofit.
- **Per-domain network allowlisting is not an OS primitive on any platform.** Both reference
  implementations use a deny-by-default local HTTP/SOCKS5 proxy, with the OS layer forcing traffic
  through it.
- **Code signing / auto-update:** the `koffi` route means the only new signed native artifact is
  koffi's prebuilt `.node`. AppContainer's ACL requirement is the real interaction risk — an
  NSIS/differential update that rewrites the app directory can drop ACEs. **Re-apply idempotently on
  every launch.**
- **Always detect and degrade, never hard-fail silently.** Surface the *actual achieved* isolation
  level rather than implying a guarantee you didn't get.

## Explicitly unverified

- Whether stock `node.exe`/`bun.exe` runs correctly inside an externally-created AppContainer —
  **gates the entire recommended Windows strategy.**
- Landlock default-enablement on Debian 13, Ubuntu 24.04/26.04, RHEL 10.
- Landlock ABI 4 kernel version (5.16 vs 6.7) — query at runtime.
- Firejail CVEs 2024–2026: none found, weak negative evidence.
- Any *new* Windows 11 process-confinement primitive shipped 2025–2026.
- `@landstrip/landstrip`'s Windows implementation and its **LGPL-2.1+** implications for a signed
  shipped binary — **read the source and clear the license with counsel before adopting.**
