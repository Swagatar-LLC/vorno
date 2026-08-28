---
title: Headroom TypeScript SDK — supply-chain vetting report
plan: PLAN-040
suv: SUV-0014
direction: DIR-05
author: jh
created: 2026-08-26
subject: headroom-ai@0.36.5
verdict: cleared-to-pin
---

# Headroom TypeScript SDK — supply-chain vetting report

**Subject:** `headroom-ai@0.36.5` (npm)
**Date of audit:** 2026-08-26
**Scope:** license/NOTICE findings, network and telemetry behavior, version
pinning and update cadence.

Per PLAN-040, this is **not** a go/no-go evaluation — the decision to integrate
is made. This report answers *how safely*, and records the facts that downstream
SUVs must design against.

> **Verdict: cleared to pin.** No telemetry, no vendor endpoint, no install
> scripts, no filesystem writes, zero runtime dependencies. Three findings
> (F1–F3) require action; none blocks the pin, but **F3 is load-bearing for
> SUV-0015** and F1 must be closed before Vorno ships a build containing this
> package.

---

## 1. Identity and provenance

The plan named the GitHub repository but not an npm package. Establishing the
package identity was the first task, because the npm namespace around Headroom
is crowded with third-party plugins (`headroom-opencode`, `headroom-openclaw`,
`acp-headroom-pi`, and others) plus a large set of unrelated packages sharing
the "headroom" name (`headroom.js`, `react-headroom`, `headroom-cms`).

| Fact | Value |
|---|---|
| Repository | [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) |
| Repo license | Apache-2.0 (`LICENSE`, confirmed by file contents) |
| Stars / activity | 67,714; pushed 2026-08-27 (active) |
| npm package | `headroom-ai` |
| Version pinned | `0.36.5` |
| npm license field | `Apache-2.0` |
| Maintainers | `chopratejas`, `devanshivyas` |
| Runtime dependencies | **none** |
| Peer dependencies | `@ai-sdk/provider`, `@anthropic-ai/sdk`, `ai`, `openai` — **all optional** |
| Install scripts | **none** (no `pre/post/install`, no `prepare`) |
| Node engine | `>=18.0.0` |

**Identity is confirmed, not inferred.** The repo's `sdk/typescript/package.json`
declares `"name": "headroom-ai"`, `"version": "0.36.5"` — matching the npm
package exactly. The third-party plugin packages independently carry version
`0.36.5`, consistent with a single coordinated release train.

### Verification chain

The artifact audited is provably the artifact pinned:

```
tarball sha512 (computed locally) = ZV/zZH79tNARgry3oOG42albpFrRWAGGMXx28kddp8+
                                    tqzhkAAKjaRpqeUVWFn9i7vLfJtX4gbzcGiv2jpLxYQ==
bun.lock integrity               = sha512-ZV/zZH79tNARgry3oOG42albpFrRWAGGMXx28
                                    kddp8+tqzhkAAKjaRpqeUVWFn9i7vLfJtX4gbzcGiv2jpLxYQ==
```

Identical. Every claim below was read out of the exact bytes `bun.lock` pins.

### Finding F2 — no npm provenance attestation

`https://registry.npmjs.org/-/npm/v1/attestations/headroom-ai@0.36.5` returns
**404**. The package is published without npm provenance, so there is no
cryptographic link from the tarball back to a CI build of the public repo. The
published `package.json` also omits a `repository` field, so the
package→repo link is by naming convention only.

*Impact:* moderate-low. It does not make the artifact untrustworthy, but it means
"the npm tarball matches the GitHub source" is an assumption, not a verified
fact. *Mitigation, already in force:* the `bun.lock` integrity hash pins the
exact bytes, so the artifact cannot change under us without the lockfile
changing. The cadence procedure (§5) makes re-auditing the diff an explicit step
rather than a trust assumption. Requesting provenance is a reasonable upstream
ask (`security@headroomlabs.ai`).

---

## 2. License and NOTICE findings

Headroom is **Apache-2.0** — permissive, compatible with Vorno's own Apache-2.0
licensing, and imposing no copyleft obligation on Vorno's source.

The repository carries a proper `NOTICE` file:

```
Headroom
Copyright 2025 Headroom Contributors

This product includes software developed by the Headroom Contributors.

Third-Party Licenses
====================
tiktoken   — Copyright (c) 2022 OpenAI, Shantanu Jain — MIT
Pydantic   — Copyright (c) 2017-present Pydantic Services Inc. — MIT
...
```

Note the NOTICE covers the *whole* project including the Python/Rust core. The
npm package ships **only** the TypeScript SDK's `dist/`, which has zero runtime
dependencies — so the third-party entries above are not vendored into anything
Vorno redistributes via this package.

### Finding F1 — the npm tarball ships neither LICENSE nor NOTICE

The published `package.json` declares:

```json
"files": ["dist", "README.md", "LICENSE"]
```

but the tarball's 38 files contain **no `LICENSE` and no `NOTICE`** — only
`README.md`, `package.json`, and `dist/`. The `LICENSE` entry in `files` does not
resolve, because no `LICENSE` file exists in `sdk/typescript/`; the repo's
license lives at the repository root.

*Why it matters:* Apache-2.0 §4(a) requires redistributors to give recipients a
copy of the License, and §4(d) requires carrying forward the NOTICE text.
Vorno redistributes bundled dependencies inside the packaged Electron app — so
**this obligation lands on us, and the package as published does not discharge
it for us.**

*Action (not this SUV):* whichever SUV first ships a build containing
`headroom-ai` must ensure the Apache-2.0 text and Headroom's NOTICE are included
in Vorno's third-party attributions. This is cheap and mechanical, but it is a
real compliance gap and is easy to miss precisely because `files` *claims* the
LICENSE is there. Worth an upstream issue as well — it is a one-line fix for
them and benefits every consumer.

---

## 3. Network and telemetry audit

This is the section PLAN-040 cares most about: Headroom sits in the token path
and sees all context. The standard the plan sets is *"nothing leaves the machine
without explicit opt-in."*

**Result: the SDK meets that standard, and does so structurally rather than by
policy.**

### 3.1 Every hardcoded URL

Scanning all 12 non-sourcemap `.js`/`.cjs` files in `dist/` for URL literals
yields exactly one distinct value:

```
http://localhost:8787
```

That is `DEFAULT_BASE_URL`. **There is no vendor endpoint, analytics host, error
reporter, or update check anywhere in the package.**

### 3.2 Every network call

There are exactly **four** literal `fetch(` call sites, all inside two private
helpers (`rawFetch` and `_fetch`) that are duplicated across the ESM and CJS
builds — i.e. two logical helpers. There are **no** other network primitives:
no `XMLHttpRequest`, no `WebSocket`, no `sendBeacon`, no `node:http`/`https`/
`net`/`dgram`/`tls`/`dns` imports.

Every API method routes through those helpers using a **relative path** against
`baseUrl`:

```js
const url = `${this.baseUrl}${path}`
```

The full path inventory: `/v1/compress`, `/v1/retrieve`, `/v1/retrieve/stats`,
`/v1/retrieve/tool_call`, `/v1/chat/completions`, `/v1/messages`, `/health`,
`/stats`, `/stats-history`, `/metrics`, `/debug/memory`, `/cache/clear`,
`/v1/telemetry`, `/v1/telemetry/export`, `/v1/telemetry/import`,
`/v1/telemetry/tools`, `/v1/feedback`, `/v1/toin/stats`, `/v1/toin/patterns`.

Because every one is relative, **the destination of all traffic is whatever
`baseUrl` resolves to** — by default, a process on `localhost`.

> **The `/v1/telemetry*` endpoints are not what the name suggests.** They are
> **reads from the local Headroom proxy's own stats store** (`GET` for
> `/v1/telemetry`, `/export`, `/tools`; the one `POST` is `/import`, which
> *uploads into* the local proxy). They are a local observability API, not an
> outbound reporting channel. Nothing in this package sends usage data to
> Headroom Labs.

### 3.3 Base URL resolution

```js
this.baseUrl = (options.baseUrl ?? getEnv("HEADROOM_BASE_URL") ?? DEFAULT_BASE_URL)
                 .replace(/\/+$/, "")
```

Precedence: explicit constructor option → `HEADROOM_BASE_URL` env → localhost.

### 3.4 Environment variables read

Six, in total:

| Variable | Purpose |
|---|---|
| `HEADROOM_BASE_URL` | proxy base URL |
| `HEADROOM_API_KEY` | auth to the proxy (`Authorization: Bearer`) |
| `OPENAI_API_KEY` | **provider key fallback — see F3** |
| `ANTHROPIC_API_KEY` | **provider key fallback — see F3** |
| `HOME` / `USERPROFILE` | home-dir fallback for tilde path expansion |

`HOME`/`USERPROFILE` are only consumed by `expandTilde()`/`joinPath()`, which
compute config **path strings**. There are **no `readFileSync`, `writeFileSync`,
or any other `fs` calls in `dist/`** — the SDK does not read or write files.

### 3.5 Passive behavior

No `setInterval`, no `setTimeout`, no `process.on(...)`, no `addEventListener`,
no `queueMicrotask` anywhere in `dist/`. **There are no background timers and no
import-time side effects** — importing the package starts nothing. All network
activity is a direct consequence of an explicit method call by the caller.

### 3.6 What leaves the machine, and the control

| Condition | What leaves the machine |
|---|---|
| Package imported but not called | **Nothing.** No import-time I/O. |
| Default config (`baseUrl` unset) | **Nothing leaves the machine.** Traffic goes to `http://localhost:8787`; if no proxy is running, `fetch` throws `HeadroomConnectionError`. |
| `baseUrl` / `HEADROOM_BASE_URL` set to a remote host | Everything the caller passes: full message content, tool outputs, and — for the `chat`/`messages` helpers — the provider API key (F3). |

**The opt-in that controls egress is `baseUrl` (or `HEADROOM_BASE_URL`).** It is
a single, explicit, greppable value with a localhost default. That is a good
control surface: it is impossible for context to leave the machine unless
someone deliberately points the client off-box.

### Finding F3 — two convenience paths auto-read provider API keys from the environment

`chat.completions.create()` and `messages.create()` do this:

```js
const providerKey = this.client.providerApiKey ?? getEnv("OPENAI_API_KEY")
if (providerKey) headers["Authorization"] = `Bearer ${providerKey}`
```

```js
const providerKey = this.client.providerApiKey ?? getEnv("ANTHROPIC_API_KEY")
if (providerKey) headers["x-api-key"] = providerKey
```

These are the "SDK proxies your LLM call for you" helpers. They silently fall
back to ambient environment credentials and forward them to `baseUrl`.

*Why it matters for Vorno specifically:* Vorno keeps provider credentials in an
encrypted credential store, deliberately **not** in ambient env
(`packages/shared/src/credentials/`, and the shared package's standing rule
against ad-hoc secret storage). A code path that reaches into `process.env` for
an API key and forwards it to a configurable URL is exactly the shape that rule
exists to prevent. Combined with a misconfigured remote `baseUrl`, it is a
credential-egress path.

*Mitigation for SUV-0015 (recommended, not implemented here):* the boundary
module should use **only** the compression/retrieval surface — `compress()`,
`retrieve()`, `stats()` — and must **not** use `client.chat` or
`client.messages`. Vorno already owns its provider calls; routing them through
Headroom would duplicate that ownership and drag credentials through a third
party. Constraining the boundary module's public surface makes this
unreachable-by-construction rather than a rule someone has to remember.

### Finding F4 (architectural, not a risk) — this SDK is a proxy client, not an in-process library

Worth stating plainly because it contradicts a planning assumption. PLAN-040 §I1
biases toward *"the TypeScript SDK **in-process**"*, with the proxy as a
fallback. **The TypeScript SDK does not compress in-process.** It has zero
runtime dependencies and no compression engine; `compress()` is an HTTP POST to
`/v1/compress` on the Headroom proxy. The compression logic lives in the
Python/Rust core. The SDK's local-only exports are format helpers
(`detectFormat`, `toOpenAI`, `parseSSE`, `deepCamelCase`, …).

*Consequence:* "adopt the TS SDK" and "run the proxy" are the **same** decision,
not alternatives — adopting the SDK entails a Headroom proxy process being
available at `baseUrl`. This directly informs PLAN-040 **open question 1**
(TS SDK vs proxy vs MCP), and it means SUV-0015's no-op fallback must handle
"proxy not running" (`HeadroomConnectionError`) as the *expected* default state,
not an error condition. Recording it here as evidence; per ADR-0028 the
architectural decision itself belongs in an ADR, which is out of this SUV's
scope.

*Note:* the SDK has a built-in `fallback` option, defaulting to `true`, which
returns the messages unmodified when compression fails. That is a useful
primitive for SUV-0015's graceful-degradation requirement.

---

## 4. Summary of findings

| ID | Finding | Severity | Owner / disposition |
|---|---|---|---|
| F1 | npm tarball ships no LICENSE/NOTICE despite `files` claiming LICENSE | Compliance | Close before shipping a build containing the package; file upstream issue |
| F2 | No npm provenance attestation; no `repository` field | Moderate-low | Mitigated by lockfile integrity pin + cadence review (§5) |
| F3 | `chat`/`messages` helpers auto-read `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` from env and forward to `baseUrl` | **Material** | SUV-0015 must exclude these surfaces from the boundary module |
| F4 | SDK is a thin proxy client, not in-process compression | Architectural | Informs PLAN-040 open question 1 and SUV-0015's fallback design |

No finding blocks the pin.

---

## 5. Version pinning and update cadence

### The pin

`headroom-ai` is pinned to the exact version **`0.36.5`** in
[`packages/shared/package.json`](../../../packages/shared/package.json).

**Placement rationale:** `packages/shared` owns the agent session loop and
Conductor-adjacent code that SUV-0015's boundary module will live beside, and it
already establishes exact-pin precedent for runtime-critical SDKs
(`@earendil-works/pi-agent-core: "0.80.6"`).

**No range, no dist-tag** — per LEARNING-062, which cost this repo a
CI-red-on-every-branch outage when `"@types/bun": "latest"` resolved to a newly
published version. A dependency that sits in the token path and sees all context
is the last one that should float.

That reasoning is not left to memory: `packages/shared/src/__tests__/headroom-pin.test.ts`
fails the build if the spec ever acquires a `^`, `~`, `*`, or dist-tag, if the
lockfile drifts from the manifest, or if a production source file imports the
package before SUV-0015 lands.

### Why a deliberate cadence is needed here

Publish history shows a **very** high release velocity:

| Version | Published |
|---|---|
| 0.1.0 | 2026-03-27 |
| 0.22.4 | 2026-06-03 |
| 0.36.0 | 2026-08-20 |
| 0.36.1 | 2026-08-21 |
| 0.36.2 | 2026-08-21 |
| 0.36.3 | 2026-08-21 |
| 0.36.4 | 2026-08-22 |
| 0.36.5 | 2026-08-22 |

Five patch releases in roughly three days, and the project is pre-1.0 — so
semver minor bumps may carry breaking changes. Auto-updating would be actively
hazardous; equally, never updating strands us on a stale version of a
fast-moving dependency.

### Cadence

**Trigger — when the pin is bumped.** Three triggers, and no others:

1. **Scheduled review — monthly.** Check for a newer release; bump if the diff
   review passes. A month is chosen against the observed velocity: frequent
   enough to avoid a large accumulated diff, infrequent enough that we are not
   chasing same-day patch releases.
2. **Security advisory** affecting `headroom-ai` or the proxy — reviewed
   immediately, out of cycle. Upstream reporting channel:
   `security@headroomlabs.ai` (their `SECURITY.md`).
3. **A needed fix or feature** — an upstream change that unblocks Vorno work.
   Bump on demand, same review.

Version bumps are **never** taken as a side effect of an unrelated
`bun install`; the guard test makes an accidental range change fail CI.

**Procedure — how the pin is bumped.**

1. Read the upstream release notes / `CHANGELOG.md` between the pinned version
   and the candidate.
2. Re-run the network/telemetry audit against the new tarball (§7 reproduces it
   in full; it is a ~2-minute mechanical check). **This is the step that
   compensates for F2** — absent provenance, we re-verify rather than trust.
   Specifically re-check: the hardcoded-URL set is still localhost-only; no new
   `fetch`/socket/`fs`/`child_process` primitives; no install scripts; no new
   env reads; runtime dependency count still zero.
3. Update the exact version in `packages/shared/package.json`, run
   `bun install`, and confirm `bun.lock` records a new integrity hash.
4. Update this report: the subject version, the verification chain hashes, and
   any changed findings.
5. Land as its own PR — **never bundled with feature work**, so the dependency
   diff is reviewable in isolation.

**Reviewer — who reviews the diff.**

`jh` (Jeff Hampton), as PLAN-040 owner, reviews and approves every bump. Where a
review surfaces a *new* egress path, a new runtime dependency, or any change to
the F3 credential-handling surface, that is escalated as a finding in this
report and the bump does not land until it is dispositioned — a bump is never a
rubber stamp on a version number.

---

## 6. Acceptance mapping (SUV-0014)

| Acceptance item | Where satisfied |
|---|---|
| Vetting report in `roadmap/evidence/` covering license/NOTICE and network/telemetry, incl. what leaves the machine and the opt-in | This document — §2 (license/NOTICE, F1), §3 (network/telemetry), §3.6 (egress table + `baseUrl` opt-in) |
| SDK in a package manifest at an exact version; `bun.lock` resolves it; no `latest`/caret/tilde | `packages/shared/package.json` → `"headroom-ai": "0.36.5"`; `bun.lock` line 2354; guarded by `headroom-pin.test.ts` |
| Report documents update cadence: how/when bumped, who reviews | §5 — trigger, procedure, reviewer |
| No production source imports the SDK yet | Verified by grep and by the `is imported by no production source file` guard test |

---

## 7. Reproduction

Every claim above is re-derivable with these commands.

```bash
# Identity, license, deps, install scripts
curl -s https://registry.npmjs.org/headroom-ai | python3 -m json.tool | less
curl -s https://raw.githubusercontent.com/headroomlabs-ai/headroom/main/sdk/typescript/package.json

# Provenance (F2): returns 404
curl -s https://registry.npmjs.org/-/npm/v1/attestations/headroom-ai@0.36.5

# Fetch the exact pinned artifact and verify it against bun.lock
mkdir -p /tmp/hr-audit && cd /tmp/hr-audit
curl -sL -o pkg.tgz https://registry.npmjs.org/headroom-ai/-/headroom-ai-0.36.5.tgz
openssl dgst -sha512 -binary pkg.tgz | openssl base64 -A   # compare to bun.lock integrity
tar xzf pkg.tgz

# F1: no LICENSE/NOTICE in the tarball
tar tzf pkg.tgz | grep -iE 'license|notice'   # -> no matches

# Install scripts: none
python3 -c "import json;print(json.load(open('package/package.json')).get('scripts'))"

# §3.1 every hardcoded URL -> only http://localhost:8787
cd package/dist
files=$(find . -type f \( -name '*.js' -o -name '*.cjs' \) ! -name '*.map')
grep -oEh "https?://[a-zA-Z0-9._~:/?#@!$&'()*+,;=%-]+" $files | sort | uniq -c

# §3.2 / §3.4 / §3.5 network, process, fs, timer primitives
grep -oEh "\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|child_process|execSync" $files | sort | uniq -c
grep -rnE "readFileSync|writeFileSync|readFile" $files          # -> none
grep -rnE "setInterval|setTimeout|process\.on\(|addEventListener" $files  # -> none
grep -oEh 'getEnv\("[A-Z_]+"\)' $files | sort -u

# Repo-side: the pin, the lockfile, and the guards
cd /path/to/craft-agents-oss
grep -n '"headroom-ai"' packages/shared/package.json bun.lock
bun install --frozen-lockfile
cd packages/shared && bun test src/__tests__/headroom-pin.test.ts

# Acceptance item 4: no production import
grep -rn "headroom-ai" apps/ packages/ --include=*.ts --include=*.tsx \
  | grep -v node_modules | grep -v __tests__
```
