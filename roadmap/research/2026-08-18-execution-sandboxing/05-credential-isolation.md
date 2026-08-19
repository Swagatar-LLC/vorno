# 05 — Credential Isolation from Agent-Executed Code

**Research date:** 2026-08-18. Source report preserved substantially as produced.
**Status:** research input only — see [`README.md`](README.md).

Claude Code latest at time of writing: **2.1.235**. `@anthropic-ai/sandbox-runtime`: **0.0.73**.

---

## 1. Environment scrubbing — `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`

Verbatim from `code.claude.com/docs/en/env-vars`:

> Set to `1` to strip Anthropic and cloud provider credentials from subprocess environments (Bash tool,
> hooks, MCP stdio servers). The parent Claude process keeps these credentials for API calls, but child
> processes cannot read them, reducing exposure to prompt injection attacks that attempt to exfiltrate
> secrets via shell expansion. On Linux, this also runs Bash subprocesses in an isolated PID namespace
> so they cannot read host process environments via `/proc`; as a side effect, `ps`, `pgrep`, and `kill`
> cannot see or signal host processes. `claude-code-action` sets this automatically when
> `allowed_non_write_users` is configured

**Default: not set / off.** Version history from `anthropics/claude-code` CHANGELOG:
- **v2.1.83** (2026-03-24): the variable introduced.
- **v2.1.98** (2026-04-09): PID namespace isolation on Linux + `CLAUDE_CODE_SCRIPT_CAPS`.

**What it scrubs:** "Anthropic and cloud provider credentials." The concrete list is **not published** —
could not verify.

**Coupled side effect, documented:** *"When `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is set, Claude Code
ignores `filesystem.disabled` from every source, including managed settings, and keeps filesystem
isolation on."* Open issues confirm this surprises people: #50167, #51258, #80212.

`CLAUDE_CODE_SCRIPT_CAPS` limits per-session script invocations, with an honest self-assessment:
*"Runtime fan-out via `xargs` or `find -exec` is not detected; this is a defense-in-depth control."*

### The documented gap: in-process tools bypass the scrub

**Microsoft Security Blog, 2026-06-05**, on `claude-code-action`:

> *"Read operations represent direct, in-process calls. They inherently bypass the Bubblewrap sandbox,
> operating with full access to the process's environment variables."*
> *"If Read ran inside the same Bubblewrap subprocess that Bash uses, it would not contain this key in
> the process's environment variable."*

Attack: Read `/proc/self/environ` → unscrubbed `ANTHROPIC_API_KEY`. Reported via HackerOne 2026-04-29;
fixed **2026-05-05 in v2.1.128** by "unconditionally rejecting a number of files in `/proc/`."

**Architectural lesson: env scrubbing at the `fork()` boundary is defeated by any tool that runs
in-process. The scrub is a subprocess-boundary control, not a process-wide one.**

### Credential storage

From `code.claude.com/docs/en/authentication`:
- *"On macOS, credentials are stored in the encrypted macOS Keychain."*
- *"On Linux, credentials are stored in `~/.claude/.credentials.json` with file mode `0600`."*
- *"On Windows, credentials are stored in `%USERPROFILE%\.claude\.credentials.json` and inherit the
  access controls of your user profile directory"*

`apiKeyHelper` is the credential-helper pattern applied to the model API key — config holds a command,
not a secret. `CLAUDE_CODE_SIMPLE`/`--bare`: *"OAuth tokens and keychain credentials are not read"* — a
documented "no ambient credential" mode.

The sandbox **write**-protects the store (protected paths include `~/.claude.json` and
`.credentials.json`, *"There is no way to exempt one of these paths"*) — but **the default read policy
still permits reading it.**

**CVE-2026-21852** (NVD, 2026-01-21): *"Prior to version 2.0.65, vulnerability in Claude Code's
project-load flow allowed malicious repositories to exfiltrate data including Anthropic API keys before
users confirmed trust."* CVSS v3.1 7.5 HIGH (NIST) / v4.0 5.3 MEDIUM (GitHub). Fixed 2.0.65.

---

## 2. The sentinel-substitution proxy — the most transferable design found

This is the answer to "let executed code *use* a credential without *holding* it." Implemented in both
`srt` (`src/sandbox/credential-mask-env.ts`, `credential-mask-files.ts`, `credential-sentinel.ts`,
`credential-aws-pairs.ts`, `credential-decode.ts`) and Claude Code's `sandbox.credentials`.

**`"mode": "deny"`** (v2.1.187+) — file paths denied for reads inside the sandbox; env vars **unset
before each sandboxed command runs**. Docs example denies `~/.aws/credentials`, `~/.ssh`, `GITHUB_TOKEN`,
`NPM_TOKEN`.

**`"mode": "mask"`** (v2.1.199+) — the real design:

> *"Instead of blocking a credential, Claude Code shows sandboxed commands a placeholder, the
> **sentinel**, and the sandbox proxy **swaps in the real value on outbound requests to hosts you
> allow**."*
> *"With `mask`, the sandboxed command sees a **per-session sentinel value** instead of the real one.
> Each `mask` entry can list `injectHosts`… **The command and anything it logs never hold the real
> credential, but its requests still authenticate.**"*

From `srt` source:

> *"For a `credentials.envVars` entry with `mode: "mask"`, srt reads the real value from the host
> environment, registers one or more sentinels in the SentinelRegistry, and sets the variable to the
> fake value inside the sandbox (bwrap `--setenv` on Linux, the env preamble on macOS). The proxy
> substitutes sentinel→real on egress to the entry's injectHosts."*

Mechanics and limits, all documented:

- Requires `network.tlsTerminate` because *"The proxy substitutes the credential inside request
  contents, so it has to see them."* Without it, *"masking fails **without exposing anything**: the
  command still sees only the sentinel, but the sentinel reaches the server unchanged and
  authentication fails."* — **fail-closed, well designed.**
- Substitution covers **headers and request bodies**.
- **AWS SigV4 re-signing**: mask `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` together; the proxy
  detects a SigV4 request by the access key's sentinel and **re-signs** after substitution
  (`credentials.awsPairs`, v2.1.224+). Three request forms it can't recompute default to failing rather
  than forwarding a broken signature.
- **File masking** on Linux/WSL2: a **sentinel copy** of the file with an `extract` regex (capture group
  1) marking the secret, so e.g. `~/.config/gh/hosts.yml` still parses. **macOS cannot do this — it
  blocks the file outright.** Falls back to `deny` for directories, globs, files >8 MiB, or non-UTF-8.
- **Privilege separation on the setting itself:** *"Unlike `deny`, masking **authorizes the proxy to
  send your real credential to the listed hosts**, so it is honored **only** from settings you or your
  administrator control: user settings, managed settings, and the `--settings` CLI flag."* `mask`
  entries, `network.tlsTerminate`, and `credentials.allowPlaintextInject` are all **ignored in a
  repository's `.claude/settings.json`.** **This is the direct fix for the CVE-2026-21852 class.**
- `deny` beats `mask` in any scope; `deny` only ever narrows.
- `onExtractFailure` defaults to `warn` (fail-open, file left readable) — `"deny"` and `"error"` are the
  fail-closed options. **The default is the insecure one.**
- **Critical caveat:** *"There is **no built-in credential deny list**, so only the files and variables
  you list are restricted."* And *"this default still allows reading credential files such as
  `~/.aws/credentials` and `~/.ssh/`."*

---

## 3. The broker pattern in Anthropic's own words

From `code.claude.com/docs/en/security`, on Claude Code on the web:

> *"**Credential protection**: Authentication is handled through a **secure proxy that uses a scoped
> credential inside the sandbox, which is then translated to your actual GitHub authentication
> token.**"*

Plus: isolated per-session VMs; git push restricted to the current working branch; audit logging;
automatic VM reclamation. And for Remote Control: *"multiple short-lived, narrowly scoped credentials,
each limited to a specific purpose and expiring independently, to limit the blast radius of any single
compromised credential."*

Engineering blog (2025-10-20):

> *"**Sensitive credentials (such as git credentials or signing keys) are never inside the sandbox with
> Claude Code.** This way, even if the code running in the sandbox is compromised, the user is kept
> safe."*

(Also claims an **84% reduction in permission prompts** from sandboxing.)

Docker MCP Gateway does the same for MCP: secrets resolved via Docker Desktop's secrets API and mounted
only into the target container at runtime.

---

## 4. Broker/proxy prior art

| # | Pattern | Key design principle |
|---|---|---|
| 1 | GitHub Actions OIDC | Inject a **ticket to request** a token, not the token |
| 2 | Docker credential helpers | Config holds a **pointer to a fetcher**, not the secret |
| 3 | git credential protocol | Stateless stdin line protocol **decouples consumer from store** |
| 4 | K8s bound SA tokens | Bind on **audience + time + object**; unbound = forgeable forever |
| 5 | Vault Agent | Separate **authentication (agent)** from **consumption (rendered file)** |
| 6 | SPIFFE/SPIRE | **Zero bootstrap secret**; kernel observes identity over a UDS |
| 7 | tailscaled | Keys stay in the **privileged daemon**; expose verbs, authorize by uid |
| 8 | CF Workers | **Write-only, platform-injected** bindings |

### 4.1 GitHub Actions OIDC
Runner injects `ACTIONS_ID_TOKEN_REQUEST_URL` + `ACTIONS_ID_TOKEN_REQUEST_TOKEN` when
`permissions: id-token: write`. `actions/toolkit`'s `oidc-utils.ts` reads exactly those two vars; the
resulting JWT is immediately `setSecret()`-redacted.

> *"With OIDC, your cloud provider issues a short-lived access token that is only valid for a single job"*
> *"responds with an automatically generated JSON web token (JWT) that is unique for each workflow job"*

`GITHUB_TOKEN` scoping, fail-closed rule: *"If you specify the access for any of these permissions, all
of those that are not specified are set to `none`."*

Secrets-in-process risk, verbatim: *"Avoid passing secrets between processes from the command line…
Command-line processes may be visible to other users (using the `ps` command)"*; *"automatic redaction
is not guaranteed."*

### 4.2 Docker credential helpers
`credsStore: "<suffix>"` → exec `docker-credential-<suffix>` on `$PATH`, operation as `argv[1]`, payload
on stdin. Without a helper, credentials are *"stored in the `config.json` file in a base64-encoded
format. This method is less secure than configuring and using a credential store."*

### 4.3 `gh auth` + git credential protocol
`gh` wraps `zalando/go-keyring`. Resolution order documented verbatim: *"searching environment
variables, general configuration, and finally encrypted storage"* — with an insecure fallback: *"will
fall back to the general insecure configuration."*

`git-credential` wire format: one attribute per line, `key=value`, terminated by a blank line.
Attributes include `password_expiry_utc` and `oauth_refresh_token` (*"Helpers must treat this attribute
as confidential like the password attribute"*).

**Decline semantics worth stealing:** *"If a helper outputs a `quit` attribute with a value of `true` or
`1`, no further helpers will be consulted, nor will the user be prompted"* and *"If it does not support
the requested operation… it should silently ignore the request."*

### 4.4 Kubernetes bound/projected SA tokens
KEP-1205. Alpha 1.10 → Beta 1.12 → **GA 1.22**. Motivation, verbatim:

> 1. *"Security: JWTs are not audience bound. Any recipient of a JWT can masquerade as the presenter to
>    anyone else."*
> 2. *"Security: …giving a service account a permission means that any component that can see that
>    service account's secrets is at least as powerful as the component."*
> 3. *"Security: JWTs are not time bound. A JWT compromised via 1 or 2, is valid for as long as the
>    service account exists."*
> 4. *"Scalability: JWTs require a Kubernetes secret per service account."*

`expirationSeconds` "Defaults to 1 hour and must be at least 10 minutes." Docs on the old style:
*"These tokens don't expire and don't rotate."*

### 4.5 Vault Agent auto-auth + response wrapping
*"Auto-auth consists of two parts: a method… and a sink."* The `wrap_ttl` placement trade-off, verbatim:

> (sink) *"If specified, the written token will be response-wrapped by the sink. **This is less secure
> than wrapping by the method**, but allows auto-auth to keep the token renewed…"*
> (method) *"**This is more secure than wrapping by sinks**, but does not allow the auto-auth to keep
> the token renewed"*

Response wrapping inserts the value "into the cubbyhole of a single-use token." Benefits: **cover,
malfeasance detection, limited lifetime** — the malfeasance-detection property (a second unwrap attempt
proves interception) is the most under-used in agent designs.

### 4.6 SPIFFE/SPIRE Workload API — the purest form
Normative, from `SPIFFE_Workload_Endpoint.md`:

> *"**The SPIFFE Workload Endpoint MUST NOT require any direct authentication of its clients.**"*
> *"Implementations SHOULD prefer Unix Domain Socket transport"*
> *"TCP transport MUST NOT be used unless the underlying network allows the Workload Endpoint server to
> strongly authenticate the workload based on source IP address"*
> every request *"MUST include the static gRPC metadata key `workload.spiffe.io` with a value of
> `true`"* — requests without it "MUST be rejected" (anti-confused-deputy guard, **not** authentication)

From spiffe.io: *"the Workload API does not require that a calling workload have any knowledge of its
own identity, or possess any authentication token when calling the API."* / *"your application need not
co-deploy any authentication secrets with the workload."* And: *"Workload attestation asks the question:
'Who is this process?'"*

### 4.7 Tailscale LocalAPI / tailscaled split
`tailscaled` (privileged) owns the WireGuard interface, `tailscaled.state`, and the machine/node keys.
The unprivileged CLI is an HTTP client over a Unix socket. Authorization is by **socket peer
credentials** — `checkConnIdentityLocked` decides read-only vs read-write by uid vs `operatorUID`.
macOS is the exception (auth token via HTTP Basic). *(That the node key never leaves `tailscaled` is
architecture inference, not a quotable doc sentence.)*

### 4.8 Cloudflare Workers
> *"Secrets are a type of binding that allow you to attach encrypted text values to your Worker."*
> *"The difference is secret values are **not visible within Wrangler or Cloudflare dashboard after you
> define them**."*

---

## 5. MCP spec — token isolation

**Current protocol revision: `2026-07-28`.** Prior revisions `2025-11-25` and `2025-06-18`.

From the 2026-07-28 authorization spec, §Token Handling:

> MCP servers… **MUST** validate access tokens as described in OAuth 2.1 Section 5.2.
> MCP servers **MUST** validate that access tokens were issued specifically for them as the intended
> audience, according to RFC 8707 Section 2.
> **MCP clients MUST NOT send tokens to the MCP server other than ones issued by the MCP server's
> authorization server.**
> **MCP servers MUST only accept tokens that are valid for use with their own resources.**
> **MCP servers MUST NOT accept or transit any other tokens.**

The 2025-06-18 revision phrased the downstream half more explicitly:

> *"If the MCP server makes requests to upstream APIs, it may act as an OAuth client to them. The access
> token used at the upstream API is a separate token… **The MCP server MUST NOT pass through the token
> it received from the MCP client.**"*

Security Best Practices, §Token Passthrough (identical in both revisions):

> *"'Token passthrough' is an anti-pattern where an MCP server accepts tokens from an MCP client without
> validating that the tokens were properly issued *to the MCP server* and passes them through to the
> downstream API."*
> *"Token passthrough is **explicitly forbidden** in the authorization specification"*

Enumerated risks: Security Control Circumvention; Accountability and Audit Trail Issues (*"a malicious
actor in possession of a stolen token can use the server as a proxy for data exfiltration"*); Trust
Boundary Issues; Future Compatibility Risk. Mitigation: *"MCP servers **MUST NOT** accept any tokens
that were not explicitly issued for the MCP server."*

**Important gap, verbatim:** *"Implementations using an **STDIO transport SHOULD NOT** follow this
specification, and instead **retrieve credentials from the environment.**"* — **the spec itself directs
local stdio servers to take secrets from env vars**, precisely the surface that env-scrubbing and
`sandbox.credentials` exist to close. **Unresolved in the spec.**

---

## 6. Plaintext secrets in AI tool config

### ⚠️ Correction: Cyata's "MCP's Quiet Crisis" contains no statistics

Full title "Whispering Secrets Loudly: Inside MCP's Quiet Crisis of Credential Exposure," 2025-04-20.
**Fetched twice with explicit "list every number" prompts. No sample size, no scan, no percentages.**
It is a qualitative teardown of Claude Desktop showing MCP servers spawned via Node `child_process.spawn`
with full user privileges and no sandbox. Quotable:

> *"Claude for Desktop runs untrusted MCP servers with full user privileges and no sandbox"*

**Do not cite it for numbers — there are none.** If you've seen a percentage attributed to Cyata, it's
misattributed.

### The strong source: Trail of Bits
"Insecure credential storage plagues MCP," Keith Hoodlet, **2025-04-30**. Observed: Claude Desktop
config `-rw-r--r--` (world-readable), a `-rw-rw-rw-` case; Cursor/Windsurf conversation logs
`-rw-r--r--`; **Figma MCP server default `0666`** (world-readable *and* world-writable). Attack paths:
local malware scanning predictable paths, arbitrary-file-read bugs in unrelated software, multi-user
systems, cloud backup sync. Defensive wrapper: `mcp-context-protector`.

### Path inventory: Netwrix (2026-05-12)
14 AI tools across three OSes. Plaintext paths named: `~/.claude/.credentials.json` ·
`~/.continue/config.json` · `~/.cursor/mcp.json` · `~/.codeium/windsurf/mcp_config.json` ·
`~/Library/Application Support/Claude/claude_desktop_config.json` · VS Code `state.vscdb` globalStorage
(Cline MCP settings, unencrypted, **synced to GitHub via Settings Sync**).

Notable: the Windows credential file mounted into WSL *"inherits the mount's default `0777` permissions
making your Claude OAuth tokens world-readable to any process on the system."*

### Quantitative claims — provenance

| Claim | Source | Status |
|---|---|---|
| 48% of 19,402 MCP implementations recommend plaintext credential storage | Trend Micro | **COULD NOT VERIFY — primary returns 403.** Most-recirculated stat in the space |
| 24,008 unique secrets in MCP config files on public GitHub; 2,117 (8.8%) live | GitGuardian 2026 | search-summary, not fetched |
| 1,862 internet-exposed MCP servers; 100% exposed tool listings without auth | Knostic | search-summary. **About network exposure, not local plaintext — don't conflate** |
| >7,000 MCP servers analyzed; "NeighborJack" 0.0.0.0 binding most common | Backslash | vendor launch marketing |
| 65% of Forbes AI 50 leaked verified secrets on GitHub | Wiz | search-summary |
| SSRF in 36.7% / 30% / 33% / 5.5% / 66% | via an SEO aggregator | **LOW-QUALITY — do not cite via the aggregator** |

### Infostealers targeting AI tool configs — confirmed
- **ACRStealer / "Amatera"** — 88 domains, ≥10 hosting platforms, impersonating Claude Code/JetBrains/
  NotebookLM. Described as the first infostealer built specifically to steal API keys from AI coding
  assistants (**Cline, Continue.dev**) rather than browsers/wallets. Per-string encryption, raw-socket
  TLS to evade EDR.
- **Malicious npm packages** targeting Cursor, Claude, Gemini CLI, Windsurf, PearAI, Eigent directories.
- **SEO poisoning / malvertising** — fake Claude Code download sites delivering Amatera (Win) / AMOS (macOS).
- **"Claude Fraud"** — trojanized VS Code extensions; macOS payload targets **Keychain**.

Adjacent: **CVE-2025-54136** (Cursor "rug pull"); **CVE-2025-49596** (MCP Inspector proxy lacks auth);
Amazon Q Developer VS Code extension — auto-loaded MCP configs from workspace files without consent →
RCE + cloud credential theft **merely from opening a malicious repo**.

**There is no CVE for the practice of plaintext config storage — correctly, since it's a design
weakness, not a vulnerability.**

---

## 7. OS keychain vs plaintext — the honest threat model

**Every mechanism here explicitly concedes it does not stop same-user code execution. It is a cost
gradient, not a boundary.**

### 7.1 macOS Keychain ACLs
API surface: `SecACLCreateWithSimpleContents`, `SecAccessCreateWithOwnerAndACL`,
`kSecACLAuthorizationDecrypt`/`ExportClear`/`ChangeACL`/`Any`, `kSecACLAuthorizationPartitionID`.
**A `NULL`/nil trusted-applications array means "no authorization required" — everyone is trusted**
(common footgun). `partitionID` gates on teamid / `apple` / cdhash.

**Why it fails against same-user code:** the ACL is a **consent UI enforced by `securityd` on the
caller's code identity**, not a kernel isolation boundary. Same-UID code can read every permissive-ACL
item, inject into or debug the trusted binary, drive the GUI to click the prompt, or wait for the user
to click "Always Allow."

Empirical proof — **Patrick Wardle, `keychainStealer`, 2017-09-25** (High Sierra launch day):

> *"Without root priveleges, if the user is logged in, I can dump and exfiltrate the keychain, including
> plaintext passwords."*

Linus Henze demonstrated a similar flaw on Mojave in 2019.

*Could not verify: current Apple keychain-ACL documentation renders title-only and sub-pages 404. ACL
semantics come from the archived OS X Lion Security API diffs plus Developer Forums thread 98182.*

### 7.2 Electron `safeStorage` — verbatim

**macOS:** *"Encryption keys are stored for your app in Keychain Access in a way that prevents other
applications from loading them **without user override**."* — deliberately hedged.

**Windows — the quotable admission:**
> *"Encryption keys are generated via DPAPI"*
> *"only a user with the same logon credential as the user who encrypted the data can typically decrypt
> the data"*

Docs state Windows protects content **"from other users on the same machine, but not from other apps
running in the same userspace."**

**Linux fallback:**
> *"if no secret store is available, items stored in using the `safeStorage` API will be **unprotected**
> as they are encrypted via **hardcoded plaintext password**"*
> *"You can detect when this happens when `safeStorage.getSelectedStorageBackend()` returns
> `basic_text`."*

Backends: `kwallet`, `kwallet5`, `kwallet6`, `gnome-libsecret`; the async API additionally supports the
Portal Secret D-Bus interface and is recommended.

*Underneath, it is a thin wrapper over Chromium's OSCrypt using **AES-128-CBC with a hard-coded IV of
16 space characters** — no authentication, and identical plaintext yields identical ciphertext under the
same master key.*

### 7.3 libsecret / gnome-keyring
Only a client library; it talks to a Secret Service implementation over **D-Bus**. Default collection is
auto-unlocked at login. **Any application on the session bus can read any secret while unlocked** —
filed as **CVE-2018-19358**.

**GNOME disputes the CVE — and the reason is the important part:** under GNOME's security model the
trust boundary is **the session bus itself**, not the Secret Service API. Untrusted apps must not be on
the bus at all (Flatpak gets filtered bus access). **Any unsandboxed process running as your user is
inside the trust boundary by design.** Locking the session does not lock the keyring.

**Net: on Linux, keychain storage is threat-model-equivalent to plaintext-with-extra-steps against
same-user code unless the consumer is sandboxed.**

### 7.4 Chrome App-Bound Encryption
Chrome Security Team, 2024-07-30. Threat model, verbatim:

> *"On Windows, Chrome uses the Data Protection API (DPAPI) which protects the data at rest from other
> users on the system or cold boot attacks"*
> *"**the DPAPI does not protect against malicious applications able to execute code as the logged in
> user - which infostealers take advantage of.**"*

**Cost-not-prevention framing:**
> *"Now, the malware has to gain system privileges, or **inject code into Chrome**, something that
> legitimate software shouldn't be doing."*
> *"App-bound encryption **increases the cost** of data theft to attackers and also makes their actions
> far **noisier** on the system."*

**Published bypasses:** `xaitax/Chrome-App-Bound-Encryption-Decryption` ("ChromElevator") — direct-syscall
reflective process hollowing; cookies, passwords, payment methods, tokens from Chrome/Edge/Brave/Avast.
**"No admin required."** Supports **Chrome 144+ via the new `IElevator2` COM interface**, tested against
144.0.7559.133 and Beta 145.0.7632.18. **Continued support through Chrome 144/145 is strong evidence
the bypass class persists ~18 months after the mitigation shipped.** CyberArk's "C4 Bomb" is a second
example (URL now redirects post-acquisition; not retrieved).

### 7.5 macOS TCC
Apple Platform Security, "Controlling app access to files" — enumerated consent-required locations,
verbatim: *"Desktop, Documents, Downloads, network volumes, and removable volumes"*, plus Full Disk
Access, per-folder protections (10.15+), Accessibility and Automation.

**The document makes no mention whatsoever of hidden dotfile directories** — no `.config`, no `.ssh`, no
`.aws`. Checked specifically.

**CONFIRMED: `~/.aws`, `~/.ssh`, `~/.config`, `~/.cursor`, `~/.claude`, `~/.codeium` are NOT
TCC-protected.** Any process running as the user reads them with a plain `open()` — no prompt, no
entitlement.

**The asymmetry: TCC protects `~/Documents` (vacation photos) but not `~/.aws/credentials` (production
cloud access). The boundary was drawn around user-visible personal content, not machine credentials.**

---

## 8. Recommended architecture

### Academic
**CapSeal** (arXiv:2604.16762, 2026-04-18). Abstract opening:

> *"Modern AI agents routinely depend on secrets such as API keys and SSH credentials, yet the dominant
> deployment model still exposes those secrets directly to the agent process through environment
> variables, local files, or forwarding sockets."*

Design: mediated access through a **trusted local broker** — capability issuance, schema-constrained
HTTP execution, broker-executed SSH actions, anti-replay session binding, policy evaluation,
tamper-evident audit. Threat model assumes the OS correctly enforces process isolation and **UDS peer
identity**; excludes local root/kernel compromise. Security goal #1: the agent must never obtain secret
plaintext **or any functional equivalent**. Framing: shifting *"from handing the model a key to granting
the model a narrowly scoped, non-exportable action capability."*

**"The Balkanization of Execution-Security Research for AI Coding Agents"** (arXiv:2607.05743,
2026-07-07). 39 papers 2023–2026 that *"are published independently and rarely cite one another."* Gaps:
no shared isolation benchmarking; **policy enforcement shows 69–98% failure rates**; TOCTOU and MCP
threats studied separately; benign out-of-scope actions at rates up to 17.1%.

Related: **Lingering Authority** (arXiv:2606.22504); **AgenticOS** (arXiv:2606.21129) — arguing
sandboxing alone can't stop *legal* capabilities being abused in combination (read → summarize → report
as exfiltration).

### Concrete guidance

**Core inversion:** the agent process must never hold a bearer credential it can also emit. **Give it a
*verb*, not a *string*.** This is CapSeal's thesis, SPIFFE's normative design, tailscaled's daemon split,
and Anthropic's *"credentials are never inside the sandbox."*

**Layer 1 — Broker process holds all durable secrets.** Separate OS process; secrets in the OS keychain
**and** in-memory only. Expose a **Unix domain socket** with `0600` in a `0700` directory. Authorize by
**kernel peer credentials** (`SO_PEERCRED` on Linux, `LOCAL_PEERPID`/`LOCAL_PEERCRED` + audit token on
macOS), not by any token the caller stores. Borrow SPIFFE's anti-confused-deputy header guard. Borrow
git's `quit` semantics so the broker can **decline** without the caller distinguishing "no credential"
from "refused."

**Layer 2 — Egress proxy is the only network path, and it attaches credentials.** Sandboxed code gets
**no direct network namespace** (Linux: drop netns, bind-mount proxy UDS in; macOS: Seatbelt permits one
localhost port; Windows: WFP `ALE_AUTH_CONNECT` block on the sandbox SID). Use the **sentinel/masking**
pattern. **Requires TLS termination**; note the documented fail-closed behavior. Without TLS termination,
hostname-only allowlists are **defeatable by domain fronting** — Anthropic says so explicitly. **Never
honor `mask`/inject configuration from repo-local or model-writable settings.**

**Layer 3 — Short-lived, audience-bound, object-bound derived credentials.** Apply KEP-1205's three axes:
**audience** (RFC 8707 `resource`), **time** (minutes), **object** (bind to task/session ID). Prefer GH
Actions' shape — hand the sandbox a **single-use ticket to ask the broker**. Consider Vault's **response
wrapping** where a secret must transit, for malfeasance detection.

**Layer 4 — Phase split (cheapest high-value control).** Codex Cloud, verbatim: *"secrets are removed
before the agent phase starts."* Do setup/auth in a trusted phase with credentials present, then drop
them before any model-directed execution. On a desktop agent: resolve and cache what you need, then
`exec` the model-facing worker with a scrubbed environment.

**Layer 5 — Env scrubbing + filesystem denial, understanding what they don't cover.** Set the equivalent
of `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`; add a **PID namespace** on Linux. **Deny-read the dotfile
credential paths explicitly** — nothing does this for you. Add `~/.cursor/mcp.json`, `~/.claude.json`,
`~/.claude/.credentials.json`, `~/.codeium`, `~/.continue/config.json`, VS Code `state.vscdb`.
**Audit every in-process tool** — env scrubbing at `fork()` is worthless if a Read/WebFetch tool runs in
the parent.

**Layer 6 — MCP hygiene.** **Never pass your user OAuth token to a local MCP server.** Sandbox MCP
servers — this is `srt`'s headline use case. Prefer broker-mediated tool invocation.

**Layer 7 — Storage, honestly scoped.** Use the OS keychain, but do not oversell it. It defeats passive
file reads, permission mistakes, backup/cloud sync, accidental repo commits, and the entire
grep-a-known-path stealer class — **exactly the class actively targeting AI tool configs right now**. It
does not defeat targeted same-user code.

**Layer 8 — Assume defeat; instrument for it.** Raise cost, make attacks noisy. Short TTLs bound blast
radius. Malfeasance detection and per-call audit turn theft into a detectable event.

---

## Could not verify

1. The exact variable list `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` scrubs.
2. Its formal default (behavior implies off/unset; no docs row states one).
3. `srt` has no documented repo-level "scrub all provider creds" switch — only per-variable
   `credentials.envVars`.
4. Any Codex CLI env-scrubbing or credential-masking feature. The permissions page is silent.
5. ChatGPT Agent — assessed from search summaries, not verbatim-fetched.
6. **Trend Micro's "48% of 19,402 MCP implementations"** — primary returns 403.
7. **Any statistics from Cyata** — the post contains zero numbers.
8. CyberArk "C4 Bomb" — URL redirects post-acquisition; content not retrieved.
9. Any Google response to the ABE bypasses.
10. Current Apple Keychain ACL documentation — renders title-only; sub-pages 404.
11. A GitHub statement that "secrets in env vars are readable by any code in the job" — no such verbatim
    sentence exists.
12. Vault "the app never sees the auth token" — accurate characterization, not a quotable string.
13. Tailscale "the node key never leaves tailscaled" — architecture inference.
14. Cloudflare "secrets never exposed in plaintext at rest" — no explicit statement located.
15. The four CVEs referenced by the Balkanization survey abstract — only CVE-2026-21852 confirmed.
16. Equixly, GitGuardian 2026 PDF, Wiz Forbes-AI-50 — search-summary only.
