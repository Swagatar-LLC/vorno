# 03 — Portable / Runtime-Level Sandboxing

**Research date:** 2026-08-18. Source report preserved substantially as produced.
**Status:** research input only — see [`README.md`](README.md).

> ⚠️ **This document's Pyodide recommendation is superseded.** Document
> [`04-frameworks-and-adversarial.md`](04-frameworks-and-adversarial.md) establishes that the
> Pyodide-as-sandbox thesis was abandoned by the ecosystem in January 2026. The synthesis resolves
> the conflict against this document — see [`00-synthesis.md`](00-synthesis.md) §5.1. The rest of
> this document (QuickJS, Deno, Bun, Node, containers, hosted) stands.

---

## Executive answer as originally written

1. **No single portable mechanism gives identical isolation semantics on all three platforms without
   gutting capability.** The only genuinely identical candidate is a WASM runtime. It is a real
   memory-safety boundary, but costs native Python extensions outside a curated set, `subprocess`,
   real sockets, threads, and probably the bundled Python document CLIs.
2. **Tiered is the right answer — but tier on *tool*, not just OS.**
3. **`transform_data` is the one place a portable sandbox is straightforwardly right.**

---

## A) WebAssembly

### A1. Pyodide

**Current state.** Stable **314.0.5**, `main` at 314.1.0.dev0. The `0.2x` scheme was abandoned;
**314.x means CPython 3.14** (314.0 shipped Python 3.14.2 + Emscripten 5.0.3). GitHub's releases page
rendered dates as 2024 through the fetch tool — a parse artifact, since CPython 3.14 postdates that;
**treat those dates as unverified.**

**PEP 783 (Emscripten packaging) acceptance** now allows publishing and installing Pyodide-compatible
wheels *directly from PyPI*. Several packages were removed from Pyodide's lockfile in 314.0.x because
they now ship PyEmscripten wheels.

**Cross-platform truth: genuinely identical.** Same bytecode, same semantics on Windows/macOS/Linux.
Runs under Node and Bun (npm package `pyodide`).

**Filesystem model.** Emscripten virtual FS. Default MEMFS (in-memory — a hard capability boundary for
free). Disk access is explicit:

```js
pyodide.mountNodeFS("/mnt", "/path/to/only/this/dir");
```

Under NODEFS **writes land on the host immediately, no `syncfs()` needed.** The guest sees only
mounted directories.

**Network:** no real sockets. `requests` doesn't work; `httpx.AsyncClient` over host fetch does.

**What breaks:**
- **Available:** numpy, pandas, scipy, matplotlib, scikit-learn, lxml, pillow, cryptography, regex,
  PyYAML.
- **Pure Python, installable via `micropip`:** openpyxl, pypdf, pdfminer.six, python-docx. *(Could not
  fetch `packages-in-pyodide.html` — pyodide.org 403s automated fetches — so treat lockfile
  confirmation as unverified; the pure-Python argument is solid regardless.)*
- **PyMuPDF: partially, and painfully.** Official `pyemscripten` wheels exist on PyPI, but
  **`micropip.install()` does not work for it** (shared libraries) — you must `loadPackage(url)` a
  locally served wheel. Officially **experimental**. The third-party `@bentopdf/pymupdf-wasm` is
  **AGPL-3.0** — a licensing landmine for a shipped commercial desktop app.
- **reportlab: not available.** C extensions `_rl_accel`/`_renderPM` fail to build
  (pyodide-recipes #244).
- **No `subprocess`, no useful `threading`, no multiprocessing, no arbitrary native `.so`/`.dll`.**

**Startup cost.** ~5 s cold / ~2 s warm for full-distribution loads (issue #1365); `pyodide-core` much
faster. **Node-specific gotcha: `micropip` downloads are *not cached* under Node** — every
`micropip.install()` re-downloads from PyPI/jsDelivr. Unacceptable for a local-first desktop app;
vendor wheels locally and use a **frozen lock file** (`micropip.freeze()` → `lockFileURL` →
`loadPackage`).

**Installer size.** Full distribution 200+ MB. `pyodide-core` single-digit MB; add ~15–30 MB for
numpy+pandas+openpyxl. **Realistic add: 30–60 MB.**

### A2. wasmtime / WasmEdge / Wasmer + WASI Preview 2

WASI 0.2 (Preview 2) stable since **2024-01-25**. **Wasmtime v43.0.0** ships support for a WASIp3
`0.3.0-rc-2026-03-15` snapshot — p3 is the async/threads milestone and is *not* stable. Beware
secondary sources claiming "P2 stabilized January 2026" — that conflates the 2024 launch with
ecosystem maturity.

**Capability granularity is the good part.** P2 is capability-based by construction: no filesystem
access unless the host hands over a preopened directory handle, no network unless granted
`wasi:sockets`. Enforced by the runtime, not path-string matching. Identical on Windows.

**Node bindings are the bad part.** No first-class maintained npm binding to embed Wasmtime from
Node/Electron.
- **`@bytecodealliance/jco`** (published 2026-06-30) transpiles a component to core WASM + JS glue.
  **But** WASI P2 support in Node is **experimental**, and the implementation is `preview2-shim` —
  *JavaScript* code providing filesystem/env access. **A JS shim is only as much of a boundary as your
  own code is careful.**
- **`@wasmer/sdk`** ≥0.9.0 supports Node and Bun but is built around **WASIX** (non-standard Preview1
  fork) and requires `SharedArrayBuffer` across Web Workers even single-threaded.
- **WasmEdge** has a Node SDK, oriented at edge/AI inference.

**Verdict:** the model is right, the Node embedding story is not ready. Properly using Wasmtime means
shipping a native host binary per platform and IPC — a container runtime with extra steps. **Not
recommended for 2026.**

### A3. Running JS/TS itself in a sandbox

| Option | 2026 status | Isolation strength | Windows | Size | Verdict |
|---|---|---|---|---|---|
| **quickjs-emscripten** | **Actively maintained** — QuickJS 2025-09-13 vendored Feb 2026; supports QuickJS-NG (40+ contributors, TC39 stage-4) | **Strongest of the three.** Guest runs in WASM linear memory; total corruption inside QuickJS cannot escape the WASM boundary. No host syscalls, no host memory. | Identical (WASM) | **~500 KB sync / ~1 MB ASYNCIFY** (+~40% async overhead) | **Recommended** for `transform_data`-class JS |
| **isolated-vm** | **Maintenance mode**, author's own words; v7.x for Node 26, v6/5 for Node 24, v5/4 for Node 22. Requires `--no-node-snapshot` on Node ≥20 | V8 isolate boundary. Author: *"running untrusted code is an extraordinarily difficult problem"*, recommends *also* using process isolation | Supported, but **native C++ addon via node-gyp** | Small, per-ABI | **Avoid.** Rebuild against Electron's ABI every bump × 3 platforms. Maintenance-mode upstream. Exactly why `proxy-agents` dropped it for quickjs-emscripten. |
| `vm` / `vm2` | vm2 is dead | None | — | — | Non-starter |
| Deno core / V8 isolates | Viable only as "shell out to `deno`" | Policy-level, not memory-level | Yes | ~40 MB+ | See §B1 |

**Cost of QuickJS:** pure interpreter, no JIT — **10–50× slower than V8**. Fine for config eval, data
reshaping, short scripts. Bad for numeric or long-running work. OOM inside the WASM module can leave
it unrecoverable (kill and recreate); every `JSValue` handle must be explicitly disposed — use
`quickjs-emscripten-sync`'s `Arena` or `@sebastianwessel/quickjs`.

### A4. container2wasm — curiosity, not a dependency

**CNCF Sandbox project** (accepted Jan 2025), LF-governed, `c2w`/`c2w-net` released **2026-03-16**,
KubeCon EU 2026 lightning talk headlining **QEMU-based emulation**. Next CNCF review 2026-09-22; has
**not** graduated to Incubating. Mechanism is *CPU emulation of x86/RISC-V inside WASM*, booting
Linux + runc. Order-of-magnitude bad performance, large images, one maintainer. **Do not build a
product on it.**

---

## B) Runtime permission models

### B1. Deno — best-in-class policy layer, with honest limits

**Good.** Deny-by-default: no fs, net, env, or subprocess without a flag. Grants are scoped
(`--allow-read=./data`, `--allow-env=API_KEY`). `--deny-*` takes precedence. **Deno 2.5 (Sept 2025)**
added **named permission sets in `deno.json` via `--permission-set`**, plus `DENO_AUDIT_PERMISSIONS`
(JSONL log of every permission check) and `DENO_TRACE_PERMISSIONS=1` — genuinely useful for a desktop
app that wants to *show the user* what a script tried to do. Newer support for delegating checks to an
**external broker process** would let Vorno's main process be the policy authority (though a broker
disables CLI flags and prompts).

**Cross-platform: yes, identically.** The real selling point over `sandbox-exec`/`bwrap`.

**Weaker than it looks, structurally:**
- **`--allow-run` is a full escape.** Deno's docs say granting it *"essentially invalidates the Deno
  security sandbox."* A subprocess runs with the *user's* permissions. `--allow-run=deno` is
  catastrophic. Even allowlisting is leaky: you restrict *which* binary, not its arguments, so
  `--allow-run=cat` equals unrestricted read.
- **`--allow-ffi` is a full escape.** Native libraries run with full OS privileges; dynamic libraries
  are explicitly not sandboxed. Open issue denoland/deno **#30643** argues FFI *"essentially nullifies
  Deno's sandbox"* — acknowledged, unfixed.
- **It gates syscalls, not provenance.** A compromised npm dependency runs inside your legitimate
  grants. Deno doesn't run npm lifecycle scripts by default, but import-time code still executes.

**For Vorno:** if you never grant `--allow-run` or `--allow-ffi`, the boundary is meaningfully real
for pure-JS compute + scoped file I/O. It is not a boundary against a determined V8 exploit.

**Cost.** A second bundled runtime. Deno's docs (updated 2026-08-06) say a `deno compile` output is
**~70 MB**, with a **50–130 MB range** — that's `denort` plus your program. On-disk is likely
**70–110 MB**; **no authoritative figure found for a specific 2026 release's raw binary — unverified.**
Deno added an experimental **`--engine` flag to compile against QuickJS** for a smaller binary — but
then you inherit QuickJS's slowdown, so just use quickjs-emscripten directly.

**Precedent:** LangChain's `PyodideSandbox` is exactly the Deno + Pyodide combination. Its documented
limitations match: *"a few seconds of latency when starting the sandbox per run,"* *"file access is not
currently supported,"* and `requests` doesn't work. The PyPI package sat at **0.0.6 (2025-05-21)**.
**Treat langchain-sandbox as a design reference, not a dependency** — and see document 04 for its
January 2026 archival.

### B2. Bun — **nothing. Verified.**

Checked specifically. As of 2026-08-18, **Bun has shipped no permission or sandbox model.**

- **#6617 "Support sandboxing permissions"** (opened 2023-10-20) is **still open**, `enhancement`,
  **no assignee, no milestone, no linked PR, no visible Bun-team response.**
- **#25929 / #25928** (Jan 2026), proposing Deno-compatible
  `bun --secure --allow-net=... --allow-read=...` explicitly motivated by LLM-generated code, was
  **closed as a duplicate of #6617.** The reporter referenced #25911 as implementing it; no evidence
  it landed.
- **#26637** (Jan 2026) requests a runtime filesystem permission system. Open.
- **Bun 1.3 (Oct 2025)** added `--no-addons` — the only containment-adjacent flag, one bit, not a model.
- **Bun 1.4 (July 2026)** was the Zig→Rust rewrite. Headline was **Node compatibility**, not security.

One point in its favour: **npm lifecycle scripts are off by default.**

**→ Bun cannot be your sandbox.**

### B3. Node.js `--permission` — stable, but Node says it is *not* a security boundary

**Stability 2 — Stable.** Added v20.0.0, un-flagged in **v23.5.0 and v22.13.0**.

Verbatim from nodejs.org/api/permissions.html:

> *"The permission model implements a 'seat belt' approach, which prevents trusted code from
> unintentionally changing files or using resources that access has not explicitly been granted to.
> **It does not provide security guarantees in the presence of malicious code. Malicious code can
> bypass the permission model and execute arbitrary code without the restrictions imposed by the
> permission model.**"*

> *"According to the Node.js Security Policy, **Node.js trusts any code it is asked to run.**"*

Dispositive: agent-generated code *is* the untrusted input.

**Documented holes, all from Node's own docs:**
- **Symlinks are followed out of the allowed set.** You must guarantee no granted path contains a
  relative symlink — not a guarantee you can make on a user's machine with agent-writable directories.
- **Existing file descriptors bypass the model entirely.**
- **Does not inherit to worker threads** or child Node processes.
- **`process._debugProcess(pid)` is not gated by any scope** — a fully-restricted process can force
  *another* Node process under the same user to open its V8 Inspector (**a remote thread on Windows**).
  Node punts this back to OS isolation/seccomp/AppArmor — i.e. back to the layer you're replacing.
- Initialization happens *after* env setup, so `--env-file`, `--openssl-config`, and
  `v8.setFlagsFromString` escape it.
- `permission.drop()` only drops exact grants and does not close open fds/sockets/children.

**2026 CVE reality: CVE-2026-58043** — filesystem allowlist bypass from improper prefix-boundary
handling in the radix tree tracking allowed paths. Affected main, 22.x, 24.x, 26.x; fixed in the July
2026 security releases. **One of three permission-model bypasses in a single release.**

**Verdict: defence-in-depth, never the boundary.**

---

## C) Container / microVM

### C1. Docker / Podman as a desktop dependency — **no**

**Licensing.** Docker's SSA: free use is limited to non-commercial open source **or** a commercial
undertaking with **fewer than 250 employees AND less than US$10M annual revenue**. Note the
conjunction — crossing *either* threshold requires a paid subscription. **Government entities require
a paid subscription at any size.** 2026 pricing: Pro **$9**/user/mo annual, Team **$15**, Business
**$24**.

**The critical point: this liability lands on *your users*, not on Vorno.** Hard-requiring Docker
Desktop means every enterprise customer over 250 employees needs Docker Business seats to run your
app. Escape hatches (Podman Desktop, Rancher Desktop, OrbStack, Docker Engine in WSL2) mean shipping a
matrix of "which container runtime does the user happen to have."

**Install friction.** Windows requires WSL2 or Hyper-V; macOS a full VM. Neither is bundleable.

**What the field does:**
- **Gemini CLI**: sandboxing is **optional and off by default on non-macOS.** Docker/Podman documented
  with explicit cons: *"requires a container runtime, slower startup, extra disk space."*
- **OpenHands**: Docker is **mandatory** — the runtime *is* a container. Documented drawbacks are
  damning for a desktop analogue: **30–60 s container start per session**, and it requires mounting
  `/var/run/docker.sock`, effectively root on the host. Open proposal #13203 for a QEMU microVM
  backend precisely because Docker is too heavy. They *removed* the E2B/Modal/Daytona/Runloop runtimes
  in June 2025.

**Gemini CLI is the closest analogue to Vorno, and it made containers optional.**

### C2. Apple `container` / Containerization — macOS-only, Apple-silicon-only

**`apple/containerization`** is a **Swift package** with real APIs, abstracting the VMM behind
`VirtualMachineManager`/`VirtualMachineInstance`. **Source stability guaranteed only within minor
versions** — pin `.upToNextMinorVersion(from: "0.1.0")`.

**`apple/container` 1.0.0 shipped 2026-06-09** (first stable; 42K+ stars), requires **macOS 26 and
Apple silicon**, runs OCI images in per-container lightweight VMs with sub-second starts. WWDC26
session 389 added `container machine`.

**For Vorno:** a *Swift* API, so from Electron you'd shell out to the `container` CLI or write a native
module. Hardware-isolated (each container its own VM) — stronger than `sandbox-exec`. But **macOS 26+,
Apple silicon only** — it makes the best platform better and does nothing for the worst. A tier-1
upgrade, not a portability answer.

### C3. microVMs — not desktop-viable

- **Firecracker**: **Linux and OSv guests only. Windows explicitly unsupported.** Five devices, no
  BIOS/UEFI/ACPI/graphics/USB. Requires KVM. Boot ~100–150 ms.
- **Cloud Hypervisor**: same KVM requirement, more features.
- **crosvm**: powers ChromeOS Crostini; Linux-oriented.
- **krunvm/libkrun**: targets macOS + Linux desktop OCI workloads; **2026 status unverified.**

All need **KVM on Linux** and have **no Windows host story**. **Server technology, not a desktop
dependency.**

### C4. Hosted sandboxes — architecturally disqualified for a local-first app

| Provider | Price | Cold start (vendor) | Cold start (LogRocket, independent) | Isolation |
|---|---|---|---|---|
| **E2B** | $0.0504/vCPU-hr + $0.0162/GiB-hr | 150–500 ms | **717 ms create / 662 ms resume** (fastest) | Firecracker microVM |
| **Daytona** | Same | sub-90 ms p99 | **742 ms create / 1254 ms resume** | **Disputed** — Docker vs gVisor |
| **Modal** | $0.1419/physical-core-hr; **$0 idle** | sub-second | **2437 ms create** (slowest) | gVisor; only GPU-in-sandbox |
| **Cloudflare Sandboxes** | **GA April 2026.** $0.00002/vCPU-second active CPU + Workers/DO; requires $5/mo Workers Paid | — | — | Containers on Workers+DO |
| Fly.io Sprites | $0.07/CPU-hr | — | — | — |

**The gap between vendor-quoted and measured latency is 8–25×.**

**The dealbreaker is a change of product category, not a tuning trade-off.** `transform_data` on a
customer's payroll spreadsheet means uploading that spreadsheet to E2B/Modal. That breaks the privacy
posture, creates DPA/GDPR/HIPAA obligations, adds a hard network dependency to a desktop app, and adds
700–2400 ms plus upload time. **Not as a default. If offered at all, an explicitly-labelled opt-in
"cloud execution" mode.**

**Framework defaults:** smolagents defaults to **local, in-process** and explicitly states the local
executor is *not* a security boundary; CrewAI **removed `CodeInterpreterTool`** and now points at E2B
or Modal; LangChain recommends **"Sandbox as Tool"** (remote); **OpenAI Agents SDK v2 (2026-04-15)**
shipped **seven** native sandbox providers. **Nobody defaults to a strong local sandbox, because there
isn't one.** Vorno's OS-native local sandboxing already puts it ahead of smolagents and LangChain.

---

## Comparison

| Option | Windows: really? | Cold start | Installer add | Capability lost | Maintenance |
|---|---|---|---|---|---|
| **Pyodide** | Yes, identical | ~2–5 s cold, ~0 warm | 30–60 MB curated | Native ext.; PyMuPDF experimental; reportlab absent; no subprocess/sockets/threads | Moderate — **and see doc 04: not a security boundary** |
| **quickjs-emscripten** | **Yes, identical** | ~10s of ms | **0.5–1 MB** | 10–50× slower; JS only; manual handle disposal | **Low** — pure WASM, no native build |
| **Wasmtime + WASI P2** | Yes in principle | ms | 10–30 MB native host per platform | No mature Node embedding; `preview2-shim` is JS | **High** |
| **Deno permissions** | Yes, identical flags | ~100–300 ms spawn | **~70–110 MB** (unverified) | `--allow-run`/`--allow-ffi` are full escapes | Low-moderate; second runtime |
| **Node `--permission`** | Yes | ~50 ms | Node binary (~50 MB) | **Node says it is not a boundary**; symlink + fd bypasses; CVE-2026-58043 | Low, but false confidence is the real cost |
| **Bun permissions** | **Does not exist** | — | — | — | — |
| **Docker/Podman** | Via WSL2 only | **30–60 s/session** | Not bundleable | Licensing liability lands on *customers* | High |
| **Apple `container`** | **No — macOS 26 + Apple silicon** | sub-second | CLI/Swift dep | Not portable | Moderate |
| **microVMs** | **No Windows story; needs KVM** | 100–150 ms | Large | Everything | Very high |
| **Hosted** | Yes (an API) | **700–2400 ms** + upload | ~0 | **Local-first privacy posture** | Low technical / high legal |
| **container2wasm** | Yes | Slow (emulation) | Large | Performance | Prototype-grade |

---

## Original recommendations (partially superseded)

**Tier by tool first, OS second.** A pure OS-tier model means the *same* script has *different*
security properties per platform — impossible to reason about, impossible to document, producing bugs
that reproduce on one OS only.

- **Tier 0 — portable, all platforms, identical.** `transform_data` and pure-compute `script_sandbox`.
- **Tier 1 — OS-native.** General Bash, subprocess-using document tools, anything needing native libs.
- **Tier 2 — unsandboxed, explicit per-session consent, prominently surfaced.**
- **Tier 3 — remote, opt-in, never default.**

**For `transform_data`** — no network, one input file, one output file, pure reshaping:

- **JS → `quickjs-emscripten`.** ~500 KB sync build (skip ASYNCIFY). Host reads the input and passes
  contents *in*; host receives the result *out*. **The guest gets no file handle at all** — the
  strongest model, making the one-in/one-out contract structural rather than policy. Use
  `quickjs-emscripten-sync`'s `Arena`. Set a memory limit and an interrupt handler for wall-clock
  timeout; on OOM, discard and recreate.
- **Python → *(superseded — see doc 04 and synthesis §5.1; use OS-native instead)*.** If Pyodide is
  used for portability inside an OS sandbox, use MEMFS only, vendor wheels locally, load from a frozen
  lock file, and keep one warm instance per session.
- **Do not mount NODEFS for `transform_data`.** Mounting a host directory reintroduces path-traversal
  reasoning. Pass bytes.

---

## Caveats and things not verified

- **pyodide.org returns HTTP 403 to automated fetches.** Package availability claims rest on the
  pure-Python argument plus search summaries, not the lockfile. **Verify against the live index.**
- **GitHub's Pyodide releases page rendered dates as 2024** — certainly wrong. Version numbers are
  consistent across sources; **exact release dates unverified.**
- **Deno's raw binary size for a specific 2026 release** — no authoritative figure.
- **Daytona's isolation technology is disputed** (Docker shared-kernel vs gVisor) — don't cite either.
- **krunvm/libkrun 2026 status** — unverified.
- **Open Interpreter's current default execution model** — not verified from primary sources.
- **Bun**: verifying the *absence* of a feature is inherently harder than verifying presence. Issue
  #6617 open with no team engagement + #25929 closed as duplicate + no mention in 1.3/1.4 release
  material is strong evidence, but a quiet undocumented flag can't be ruled out.
