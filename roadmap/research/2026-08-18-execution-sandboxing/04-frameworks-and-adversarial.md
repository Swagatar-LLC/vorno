# 04 — Framework & MCP Tool Sandboxing, and the Adversarial View

**Research date:** 2026-08-18. Source report preserved substantially as produced.
**Status:** research input only — see [`README.md`](README.md).

---

## Executive summary

1. **Nobody sandboxes ordinary tools.** Every major framework runs tool bodies in-process with full
   host privilege. Sandboxing, where it exists, is scoped to *the code-interpreter tool only*. This is
   a demonstrated exploit path, not theory (CVE-2026-25592: the code executor *was* containerized; the
   attacker escaped through a different, unsandboxed in-process tool used as a file-write primitive).
2. **MCP stdio servers are universally full-privilege child processes.** The spec's sandboxing
   language is SHOULD-level. No major host confines them by default.
3. **Pattern-matching command approval is not treated as a security boundary by anyone credible —
   including the vendors who ship it.** Cursor: *"The allowlist is best-effort—bypasses are possible."*
4. **The 2026 trend line moved from approval-bypass to sandbox-escape.** Cursor shipped 9 sandbox-escape
   CVEs in 2026; Claude Code 4+. Both layers fail — but *differently*, which is the argument for a dual
   boundary.
5. **Credential isolation state of the art has moved past env-scrubbing to sentinel substitution at an
   egress proxy.** See [`05-credential-isolation.md`](05-credential-isolation.md).

---

## 1. MCP server isolation

### 1.1 What the spec says

**MCP Security Best Practices, revision `2026-07-28`.** The section is **"Local MCP Server
Compromise."** Risks, verbatim:

> * **Arbitrary code execution**. Attackers can execute any command with MCP client privileges.
> * **No visibility**. Users have no insight into what commands are being executed.
> * **Command obfuscation**. Malicious actors can use complex or convoluted commands to appear legitimate.

The only **MUST** is about consent UI:

> If an MCP client supports one-click local MCP server configuration, it **MUST** implement proper
> consent mechanisms prior to executing commands. • Show the exact command that will be executed,
> without truncation • Require explicit user approval before proceeding

Everything about confinement is **SHOULD**:

> The MCP client **SHOULD** implement additional checks and guardrails […] • **Warn that MCP servers
> run with the same privileges as the client** • Execute MCP server commands in a sandboxed environment
> with minimal default privileges • Launch MCP servers with restricted access to the file system,
> network, and other system resources • Provide mechanisms for users to explicitly grant additional
> privileges • Use platform-appropriate sandboxing technologies • **Keep sandboxing solutions
> up-to-date**

There is a separate **"stdio Transport Security in Proxy Scenarios"** section, opening *"The `stdio`
transport itself is not inherently vulnerable."* Its controls — *"Implement sandboxing or
containerization for spawned processes; Restrict file system access for spawned MCP servers; Log all
`stdio` transport usage; Require additional authorization for potentially dangerous commands"* — are
scoped to proxy architectures. **Vorno is a proxy architecture in the spec's sense** (a local process
spawning MCP servers as children on behalf of a renderer/UI), so this applies directly, including the
XSS→token-theft→arbitrary-spawn chain it describes.

**Verdict: the spec names the problem accurately and assigns zero normative isolation requirement.
Sandboxing MCP servers puts you ahead of the spec, not in compliance with it.**

### 1.2 What hosts actually do

| Host | MCP stdio server confinement (default) |
|---|---|
| **Claude Desktop** | None. Secrets in JSON config in plaintext, passed as env vars at spawn. No sandbox-mode toggle. |
| **Claude Code** | None for MCP. Docs explicit that the sandbox covers **Bash and its children only**; MCP servers + hooks are separate unconstrained host processes. Anthropic's own workaround is to wrap the *entire* Claude Code process in `sandbox-runtime`. |
| **VS Code / Copilot** | None. A malicious repo shipping `.vscode/settings.json` with `chat.permissions.default: autoApprove` silently starts every session in bypass mode after "trust the authors" — reported to MSRC, **which declined to treat it as a vulnerability** (VS Code 1.123.0). |
| **Cursor** | None by default. `.cursor/mcp.json` was itself an attack surface — **CVE-2025-54136 "MCPoison"**: approve once, attacker swaps contents later, no re-prompt. |
| **Goose (Block)** | Historically none; `uvx` can install and run arbitrary Python. v1.25.0 added OS-level sandboxing for Goose Desktop on macOS. First-party isolation is the opt-in Container Use MCP extension (requires Docker). **CVE-2026-72718** — arbitrary command execution in `goose review` via `git core.fsmonitor`. |

*Confidence note: the Goose sandbox-analysis report and v1.25.0 claim came from search summaries, not
a primary Block doc. Medium confidence.*

### 1.3 Registry, signing, provenance

- **Official MCP Registry** is **still in preview** — *"breaking changes or data resets may occur
  before general availability."*
- Provides **namespace verification only, not artifact signing.** Reverse-DNS names bound via GitHub
  OAuth, GitHub OIDC, or DNS/HTTP domain verification. Anti-abuse is character limits, regex
  validation, manual spam removal.
- **It does not sign or attest artifacts, and is explicitly not intended for direct host consumption.**
- Signing/provenance exists only in **third-party** infrastructure: Stacklok **ToolHive** (Sigstore
  keyless signing + GitHub Attestations; verify signature → validate build provenance → allow/warn/block);
  **Docker MCP Gateway/Toolkit** (per-server container with CPU/memory limits; secrets resolved through
  Docker Desktop's secrets API rather than env vars — the gateway reads the secrets file internally and
  never mounts it into any container).
- Academic proposal: https://doi.org/10.3390/fi18050243. Caveat: Sigstore records *who signed*, not
  *which registry distributed*.

**Real-world MCP supply-chain incidents:** `postmark-mcp` (clean for 15 versions, then v1.0.16
2025-09-17 added one line BCC'ing every outgoing email); **CVE-2025-6514** (CVSS 9.6, `mcp-remote`
0.0.5–0.1.15, OS command injection via an untrusted server's `authorization_endpoint`, fixed 0.1.16 —
the first full RCE on a client OS purely from connecting to an untrusted remote MCP server).

### 1.4 Institutional guidance (2026)

- **CoSAI** (Jan 2026): servers that touch the host environment — files, commands, network — or execute
  LLM-generated code **should always run in a sandbox**; complement TEEs with other isolation; use
  remote attestation and end-to-end signatures.
- **NSA CSI on MCP** (May 2026): align tools to data-classification zones; prefer local MCP server
  instances for private data.
- **Five Eyes, "Careful adoption of agentic AI services"** (May 2026): each agent as a **distinct
  cryptographically-anchored principal with its own keys/certs**; least privilege for the shortest
  time; **no long-lived credentials**; fail-safe defaults; tool allowlists; human-readable tool-use
  logging; separation of duties into **Orchestrator / Reader / Actuator**.
- **OWASP Top 10 for Agentic Applications 2026** (2025-12-09): **ASI02 Tool Misuse**; controls are
  per-tool permission profiles, action-level auth for destructive actions, sandboxed execution with
  egress controls, argument-semantics validation, short-lived task-scoped JIT credentials, and treating
  planner output as untrusted behind an intent gate. Introduces **"Least Agency"**.

---

## 2. Framework-level tool sandboxing

| Framework | Ordinary tools | Code execution | Sandboxed by default? |
|---|---|---|---|
| LangChain / LangGraph | Unsandboxed in-process | `PythonREPL` = in-process `exec()` | **No** |
| LlamaIndex | Unsandboxed in-process | `subprocess.run([sys.executable, "-c", code])` on host | **No** |
| CrewAI | Unsandboxed in-process | Was Docker; **now deprecated and removed** | Was yes → **now none** |
| AutoGen / AG2 | Unsandboxed in-process | 0.2 = Docker default; 0.4+/AG2 = explicit choice | Partially → **no** |
| smolagents | Unsandboxed in-process | `LocalPythonExecutor` (AST interpreter, explicitly **not** a boundary) | **No** |
| Open Interpreter | — | Rust rewrite adds native Seatbelt/bubblewrap/Windows sandboxing | **Yes now** |
| PydanticAI | Unsandboxed in-process | No local exec; runs on provider infra | N/A / remote |
| OpenAI Agents SDK | Unsandboxed in-process | Hosted OpenAI sandbox only | **No** |
| Google ADK | Unsandboxed in-process | Pick `UnsafeLocal`/`Container`/`VertexAi`/`BuiltIn`/`Gke` | **No** |
| Semantic Kernel | Unsandboxed in-process (`[KernelFunction]`) | Azure Container Apps dynamic sessions (opt-in) | **No** |
| Vercel AI SDK | Unsandboxed in-process `execute()` | Vercel Sandbox (Firecracker) opt-in | **No** |

### The verbatim disclaimers

**LangChain:** *"Python REPL can execute arbitrary code on the host machine (e.g., delete files, make
network requests). Use with caution."* Repo banner: *"`langchain-experimental` is being sunset."*
**Archived read-only 2026-05-26**; `PythonREPLTool` has no v1 replacement.

**LlamaIndex:** *"WARNING: This tool provides the Agent access to the `subprocess.run` command.
Arbitrary code execution is possible on the machine running this tool. This tool is not recommended to
be used in a production setting, and would require heavy sandboxing or virtual machines"*

**smolagents:** *"no local python sandbox can ever be completely secure… The only way to run
LLM-generated code with truly robust security isolation is to use remote execution options like E2B or
Docker."* And from `SECURITY.md`: *"The local code executor is not a security boundary. […] The local
executor makes no isolation guarantee; escaping it, reading the host filesystem, or reaching the
network from it is expected and **out of scope**."* → **Future local-executor bypasses will not get
CVEs.**

**CrewAI:** *"Deprecated: CodeInterpreterTool has been removed from crewai-tools. The
allow_code_execution and code_execution_mode parameters on Agent are also deprecated. Use a dedicated
sandbox service — E2B or Modal."* Driven by issue **#4516** (command injection CWE-78 + sandbox escape
CWE-94 via `__class__`/`__bases__`/`__subclasses__`) and **#5150**.

**AutoGen 0.2:** *"By default it runs code in a docker container."* / *"If you want to run code locally
(not recommended) then `use_docker` can be set to `False`."*

**Google ADK** `UnsafeLocalCodeExecutor` docstring: *"A code executor that unsafely execute code in the
current local context."*

### Two cross-cutting findings

**(a) The Pyodide/Deno sandbox thesis died in January 2026.** LangChain Sandbox archived **2026-01-14**;
Pydantic's `mcp-run-python` archived **2026-01-30**. Pydantic's postmortem:

> *"there's just no safe way to run Python within pyodide safely with reasonable latency"*
> *"Python code running in pyodide can run arbitrary javascript"*
> *"These issues are not problems with Pyodide or Deno—they're behaving as advertised, it's just that
> **those tools were not designed as sandboxes to run untrusted code**."*

**(b) Restricted-interpreter / AST-allowlist approaches lose reliably.** LangChain PALChain fell four
times in a chain (CVE-2023-36258 → CVE-2023-44467 → CVE-2024-27444 → CVE-2024-38459), each fix bypassed
via `__import__`, `__subclasses__`, `__globals__`, `__mro__`. smolagents fell twice (**CVE-2025-5120**,
CVSS 9.9, fixed 1.17.0; **CVE-2025-9959**). Same structural failure as regex command validation:
enumerating badness in a Turing-complete surface.

### The single most relevant CVE

**CVE-2026-25592 — Semantic Kernel .NET, fixed 1.71.0** (Microsoft Security Blog, 2026-05-07,
"When prompts become shells"):

> *"`DownloadFileAsync` was accidentally marked with a `[KernelFunction]` attribute, which officially
> advertised it to the AI model as a callable tool."*

No path validation → write a payload to the Windows Startup folder → **sandbox escape by a sibling
tool**, defeating the code executor's container entirely. Microsoft's recommendation: *treat AI models
as non-security boundaries; restrict tool parameters accessible to models.*

**For Vorno: the bundled Python converters, browser automation tool, and MCP integrations are each a
potential sibling-tool escape from whatever sandbox is placed around Bash.**

Companion: **CVE-2026-26030** (Semantic Kernel Python, fixed 1.39.4) — *"`kwargs[param.name]` is AI
model-controlled and not sanitized. This acts as a classic injection sink."*

### Bundled Python converters: a distinct attack surface

- **Pillow CVE-2026-25990** (High, CVSS 8.9): OOB write from a crafted PSD, 10.3.0 → before 12.1.1.
  **CVE-2026-40192** (FITS decompression bomb), **CVE-2026-42308/09/10/11** (PSD OOB write via integer
  overflow, PDF trailer infinite loop, font integer overflow, heap overflow). **CVE-2025-48379** (heap
  overflow saving >64k DDS, fixed 11.3.0).
- Pillow's docs carry an explicit threat model: TIFF nested IFD chains, animated GIF/WebP, and PNG text
  chunks can exhaust CPU/memory before pixel decode.
- **pypdf**: CVE-2026-27628, -33123, -41314, -41313, -71852, -71870.
- openpyxl/python-docx are ZIP+XML: zip bombs and entity expansion (CVE-2017-5992 XXE class).

**These should run resource-capped and sandboxed even though they aren't "code execution." They are
memory-unsafe parsers fed attacker input.**

---

## 3. Approval gates as a security control

### 3.1 The vendors' own position

**Cursor:** *"The allowlist is best-effort—bypasses are possible. Never use 'Run Everything' mode,
which skips all safety checks."*

**Anthropic** (engineering blog, 2025-10-20): *"Constantly clicking 'approve' slows down development
cycles and can lead to 'approval fatigue'…"* / *"Without network isolation, a compromised agent could
exfiltrate sensitive files like SSH keys; without filesystem isolation, a compromised agent could
easily escape the sandbox and gain network access."* / *"Sandboxing ensures that even a successful
prompt injection is fully isolated."*

And: *"The operating system enforces the sandbox boundary on the running process, so it holds
regardless of what the model chose to run **and even if an allowed command does more than its name
suggests**."* That last clause is a direct concession that name-based approval doesn't bound behaviour.

### 3.2 The bypass taxonomy

**(a) Shell metacharacters / command substitution.** **CVE-2025-54131** (Cursor <1.3, CVSS 6.4):
*"An attacker can bypass allow list in auto-run mode with backtick(`) character or `$(cmd)`."* Fix
replaced the matcher with "a more robust parser." Also **brace expansion** under zsh/bash (HiddenLayer,
1.3.4 → <2.0).

**(b) Allowlisted-command argument abuse — 8 variants in one product.** **CVE-2025-66032** (Claude Code,
fixed v1.0.93), GMO Flatt "Pwning Claude Code in 8 Different Ways":
1. `man --html` → arbitrary command
2. `sort --compress-program` + redirection
3. `history -s`/`-a` injecting into shell rc files
4. `git --upload-pa` — abbreviated option defeats a filter on `--upload-pack` because Git prefix-matches
5. `sed`'s `e` modifier executes shell from within substitution
6. `xargs` flag confusion — the regex validator and xargs parse flags differently
7. `$IFS` expansion to evade the pattern, then `rg --pre=sh`
8. Nested variable assignment + bash `@P` prompt modifier → command substitution

Root cause: **blocklisted arguments on allowlisted commands.** Anthropic's fix moved to an allowlist.
Author: *"favoring an allowlist approach over a blocklist approach when implementing security-sensitive
features like command execution."*

**Items 4 and 6 are the general problem: your validator and the real parser disagree.** Any
command-string validator is a second, worse implementation of a parser you don't control.

**(c) Environment variable injection.** **CVE-2026-22708** (Cursor ≤2.2, fixed **2.3**, 2026-01-14,
Pillar Security). Shell **built-ins** — `export`, `typeset`, `declare`, `readonly`, `unset`, `local` —
bypassed allowlist validation entirely **because they are not separate binaries and the parser only
tracked external executables.** Then: zero-click arbitrary file write via `export` with here-string
redirection; direct RCE via `typeset -i` with zsh's `(e)` flag; one-click `PAGER=` hijack triggered by
an *approved* `git branch` or `man ls`; and a chain `PYTHONWARNINGS` → `antigravity` module →
`BROWSER=` → `PERL5OPT`.

**This is the LD_PRELOAD/NODE_OPTIONS/PYTHONSTARTUP class with a shipped CVE. Any approved interpreter
invocation is a universal execution primitive if the attacker controls the environment.** Cursor
acknowledged it internally as a "systemic issue."

**(d) Parser resource limits failing open.** **ADVISORY-CC-2026-002** (Claude Code, fixed **v2.1.90**,
Adversa AI). A performance cap in `bashPermissions.ts` (lines 2162–2178) limited per-subcommand analysis
to **50 entries**; any command with >50 subcommands joined by `&&`/`||`/`;` caused **all deny rules to
be silently skipped**, falling back to a generic prompt. PoC: 50 `true` no-ops then `curl`. Claude
Code's own message admitted the command *"splits into 51 subcommands, too many to safety-check
individually."* Origin was internal ticket CC-643: complex compound commands froze the UI. A correct
tree-sitter-based path already existed in the codebase but wasn't deployed to public builds.

**Any bailout path in a validator — length cap, timeout, parse error, unsupported syntax — must fail
closed to deny, not to "ask" and not to "allow." Non-interactive contexts make "ask" equal "approve."**

**(e) Path/symlink and canonicalization escapes.**
- **CVE-2026-50549** (Cursor, critical, CWE-59, "DuneSlide"): path canonicalization **falls back to the
  original path on failure**; force a failure plus an in-workspace symlink → arbitrary file write.
- **CVE-2026-50548** (Cursor, critical): the LLM-controlled `working_directory` parameter on
  `run_terminal_cmd` was added to the allowed-write list **with no validation** — point it at the app
  bundle and overwrite the sandbox binary itself.
- **CVE-2026-39861** (Claude Code, fixed v2.1.64): *"neither the sandboxed command nor the unsandboxed
  app could independently write outside the workspace, but **their combination** could write to
  arbitrary locations."* A confused deputy between two privilege levels — **highly relevant to an
  Electron main process + sandboxed child split.**
- **CVE-2025-54794** (Claude Code, CVSS 7.7): path restriction bypass "when path prefixes collide" —
  i.e. `startsWith` on a path string.
- Denylist evasion by aliasing the same binary through a different path: `/proc/self/root/usr/bin/npx`.

**(f) Config-as-code / persistence.**
- **CVE-2026-25725** (Claude Code, fixed v2.1.2): bubblewrap failed to protect `.claude/settings.json`
  **when the file did not exist at startup** — the deny-path mount was silently skipped for a missing
  path. In-sandbox code creates it with `SessionStart` hooks that execute **with host privileges** on
  restart.
- **CVE-2026-33068**: `settings.json` resolved *before* the trust dialog.
- **CVE-2026-21852** (Check Point, fixed v2.0.65): repo-controlled settings set `ANTHROPIC_BASE_URL` to
  an attacker endpoint; requests fire **before** the trust prompt, sending the API key in plaintext.
  *"Cloning an untrusted repository is now equivalent to running untrusted code if your tools auto-load
  project configs."*
- **CVE-2025-54136 "MCPoison"** (Cursor, fixed 1.3): approve `.cursor/mcp.json` once; attacker swaps
  contents later; no re-approval.
- **CVE-2025-53773** (GitHub Copilot, Johann Rehberger): injection modifies workspace settings to
  auto-approve tool calls — *the agent edits its own permission config.*
- **CVE-2026-55607** (Claude Code, v2.1.163) and **CVE-2026-72718** (Goose): both abuse
  **`git core.fsmonitor`** — now a cross-vendor primitive.

**(g) Egress allowlist granularity.** **CVE-2026-54316** (Claude Code, fixed v2.1.163):
`huggingface.co` pre-approved **as a bare hostname**, so any path — including attacker-controlled model
repos — was auto-approved and exempt from `--allowedTools`. *"HuggingFace counts as downloads
server-side, creating a covert out-of-band channel."* Same lesson thrice: **ForcedLeak** (expired
allowlisted domain repurchased for **~$5**); **CamoLeak** (CVE-2025-59145, exfiltration
character-by-character through GitHub's *own signed* Camo image proxy via pre-computed validly-signed
1×1-pixel URLs).

**(h) The approval UI itself is spoofable.**
- Whitespace padding pushes the malicious tail out of the visible render (Gemini CLI — allowlist checked
  the "root command" `grep` from a string that continued after `;`, fixed v0.1.14).
- **"Line jumping"** (Trail of Bits, 2025-04-21): MCP `tools/list` descriptions load into context on
  connect, so a malicious server manipulates the model **before any tool is invoked** — the malicious
  tool is never called.
- **Mozilla 0DIN, "Clone This Repo and I Own Your Machine"** (2026-06-25, targets Claude Code): a repo
  with **no malicious code**. README says run `python3 -m axiom init`; the package deliberately raises
  `RuntimeError`; the init script fetches a **DNS TXT record** and pipes it to `bash -c`. *"Claude Code
  never decided to open a shell. It decided to fix an error."* / *"The payload that eventually executes
  was never part of the repo but lives in a DNS TXT record."* **The approved command string is
  genuinely benign. String-level approval cannot see this.**

### 3.3 Volume as evidence

`anthropics/claude-code` has **30 GitHub security advisories, 17 published in 2026**. `cursor/cursor`
similarly ~30. RyotaK (GMO Flatt) reports filing **~50 permission-bypass/command-execution reports to
Anthropic**, ranked #1 in their bounty with 45 accepted as of 2026-05-13.

**A control class that produces 50 accepted bypasses from a single researcher against a well-resourced
vendor is not a boundary. It is a filter.**

---

## 4. Direct answers

### Is pattern-matching command approval a real security boundary?

**No. Universally treated as UX and defense-in-depth — including by the vendors who ship it.**

- **Cursor, on the record:** *"The allowlist is best-effort—bypasses are possible."*
- **Anthropic:** the security argument rests on OS enforcement; approval is framed as reducing prompts,
  and approval fatigue is named as a security *problem*.
- **Hugging Face** formally declared their equivalent **out of scope for security reporting**.
- **Microsoft:** *treat AI models as non-security boundaries.*
- **Empirically:** ~12+ CVEs against exactly this control in 18 months across six independent bypass
  classes, plus a class (0DIN's DNS-TXT PoC) where **the approved string is genuinely benign**.

Mental model: **pattern approval is a speed bump and an intent-communication device.** It reduces
accidental damage and gives the user a decision point. It does not bound a motivated adversary who
controls the model's context. **Its size is itself a risk signal, because complexity is where
fail-open bailouts live.**

### Recommended layered architecture (2026)

**L0 — Trust decision before any config is read.** Never read, parse, or act on repo-controlled config
before the trust prompt. Security-relaxing settings must be **honorable only from user/managed scope,
never from a workspace file.**

**L1 — OS-enforced sandbox applied to *everything*, not just Bash.** Filesystem *and* network,
deny-by-default on both. **Must wrap MCP servers, the Python converters, and the browser automation
tool** — CVE-2026-25592 is the proof. Profile must be **deny-default**, not `(allow default)`.

**L2 — Network egress through a proxy the sandboxed process cannot bypass.** Not env-var proxy settings
— a namespace/filter-enforced chokepoint. Allowlist by **host + path prefix**, not bare hostname.
Monitor allowlisted domains for expiry.

**L3 — Credentials never inside the boundary.** Env scrub + PID namespace on Linux. Explicit deny on
`~/.aws`, `~/.ssh`, `~/.config/gh`, `~/.netrc`, browser profile dirs, and Vorno's own store.

**L4 — Credential brokering.** Sentinel substitution at the L2 proxy, injecting the real secret only for
listed hosts, failing closed.

**L5 — Protected paths with no allowlist exemption.** Own settings/hooks/MCP config, `.git/config`,
`.git/hooks`, shell rc files, credential store — write-denied even inside otherwise-writable
directories, with symlinks followed and denied. **Converts a transient injection into a non-persistent
one.**

**L6 — Approval as UX and intent signalling, explicitly not a boundary.** Fail **closed to deny** on
every bailout. Surface *runtime behavior* where possible, not just the string.

**L7 — Blast-radius controls and audit assuming L1–L6 all failed.** Per-session caps, rate limits, one
cryptographic principal per agent with short-lived credentials, human-readable tool-use logging.

**Approval and sandbox fail in disjoint ways.** Approval fails to injection, parser confusion, and
fatigue. Sandboxes fail to symlinks, config persistence, and kernel gaps. Neither substitutes for the
other.

### Top 5 by (risk reduced / effort)

1. **Make every bailout path in the command validators fail closed to DENY — and audit for them today.**
   *(hours–days; very high.)* Grep for length caps, subcommand limits, `try/catch` around parsing,
   timeouts, "unknown command shape," and non-interactive paths. Verify that "ask" in a non-interactive
   context does not resolve to "approve." **Highest ratio in the report.**
2. **Extend the sandbox to MCP servers and the bundled Python converters.** *(days–weeks; very high.)*
   The `srt`-style wrapper makes this cheap: change the spawn command from `npx`/`python` to
   `<sandbox-wrapper> npx`/`python`. Audit the Seatbelt profile for `(allow default)` while you're there.
3. **Scrub credentials from all child-process environments + PID namespace on Linux + explicit deny-read
   on credential dotfiles.** *(days; high.)* Closes the Nx s1ngularity pattern and the
   `/proc/self/environ` chain. Electron `safeStorage` gives **nothing** against same-user code.
4. **Protected paths + config-before-trust hygiene.** *(days; high.)* This class alone accounts for
   CVE-2026-25725, -33068, -21852, CVE-2025-59536, -54136, -53773, and the `git core.fsmonitor`
   primitive. Mostly a deny-list of ~15 paths.
5. **Deny-by-default network egress through a proxy the sandboxed process cannot bypass, allowlisted by
   host + path.** *(weeks; high — and the only control that stops exfiltration once injection succeeds.)*

**Explicitly not in the top 5:** adding more patterns to the validator (negative ratio — every vendor
that tried this lost); a WASM/Pyodide in-process sandbox (abandoned by the ecosystem in Jan 2026);
prompt-level injection detection/classifiers (12 defenses broken at >90% ASR).

---

## Confidence caveats

- **High confidence (primary fetched):** MCP spec text; Claude Code security/sandboxing docs; MCP
  authorization quotes; GHSA-x5gv-jw7f-j6xj; GHSA-82wg-qcm4-fp2w; GHSA-534m-3w6r-8pqr; the Flatt
  8-techniques post; Anthropic's sandboxing blog; the Antigravity Seatbelt escape; framework doc quotes.
- **Medium confidence (search-summary):** ADVISORY-CC-2026-002 line numbers and ticket CC-643; the Goose
  sandbox report and v1.25.0 claim; Five Eyes PDF specifics (landing page 403); Repello VS Code details.
- **Known unresolved:** CVSS figures for CVE-2025-54135/54136 and CVE-2026-50548/50549 vary between
  press and GHSA. NVD does not carry CVSS for most Claude Code CVEs — cited scores are Anthropic's own
  CVSS 4.0 via GHSA.
- **Not verified:** the exact six pattern names in arXiv:2506.08837; OpenAI Codex/ChatGPT-agent proxy
  internals; Chrome ABE bypass specifics. **PowerShell-validator-specific bypass research could not be
  searched — a dedicated follow-up is recommended given Vorno ships a ~1,100-line PowerShell validator.**
