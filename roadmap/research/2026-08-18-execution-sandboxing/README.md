# Execution Sandboxing — Research Dossier

**Research date:** 2026-08-18 · **Session:** `260818-early-heron` · **Vorno version at time of research:** 0.17.0

> **This is not a decision and it is not a plan.**
>
> No ADR has been written and no work has been scheduled off the back of this. The
> "recommended sequence" in [`00-synthesis.md`](00-synthesis.md) §8 is the author's reading
> of the evidence, not an accepted roadmap. Windows support in particular is **explicitly
> out of scope for any decision at this time** — the Windows material here is recorded
> because it was researched, not because it is planned.
>
> Decisions go to [`../../decisions/`](../../decisions/). Work goes to
> [`../../plans/`](../../plans/).

## Why this exists

Vorno executes model-authored code on the user's machine (`script_sandbox`, `transform_data`,
bundled document CLIs, Bash) and spawns local MCP servers as child processes. The isolation
layer in `packages/session-tools-core/src/runtime/` supports exactly three backends —
`sandbox-exec`, `bwrap`, `firejail` — and nothing else.

This dossier asks: what does the rest of the field actually do, what primitives exist per
platform, and how does our implementation compare when read line by line?

## Reading order

| # | Document | What it covers |
|---|---|---|
| 00 | [`00-synthesis.md`](00-synthesis.md) | **Start here.** Cross-cutting read + five findings against our own source + a proposed sequence |
| 01 | [`01-coding-agent-harnesses.md`](01-coding-agent-harnesses.md) | Per-OS mechanism matrix for Claude Code, Codex CLI, Gemini CLI, Zed, Cursor, OpenHands, Goose, Aider, Cline, Continue |
| 02 | [`02-os-sandbox-primitives.md`](02-os-sandbox-primitives.md) | Windows (AppContainer, restricted tokens, Job Objects, WSL2, WDAG), macOS Seatbelt status, Linux Landlock/seccomp/bwrap/firejail |
| 03 | [`03-portable-runtimes.md`](03-portable-runtimes.md) | Pyodide, WASI, QuickJS, Deno/Node/Bun permission models, containers, microVMs, hosted sandboxes |
| 04 | [`04-frameworks-and-adversarial.md`](04-frameworks-and-adversarial.md) | MCP server isolation, framework defaults, and the CVE record against command-approval gating |
| 05 | [`05-credential-isolation.md`](05-credential-isolation.md) | Broker/proxy prior art, OS keychain threat models, sentinel masking, env scrubbing |
| 06 | [`06-prompt-injection-to-rce.md`](06-prompt-injection-to-rce.md) | Named incidents, the defenses-don't-hold literature, in-the-wild status |
| 07 | [`07-standards-and-regulatory.md`](07-standards-and-regulatory.md) | OWASP, NIST, NCSC, Five Eyes, CISA/ENISA, EU AI Act, ISO/IEC |

## What is actually established

Two claims survived every lane and are safe to build on:

1. **No detection-based or model-level prompt-injection defense currently holds.** Eight
   defenses broken at >50% ASR (arXiv:2503.00061); twelve more at >90% (arXiv:2510.09023);
   most reported near-zero ASR under static testing first. OWASP LLM01:2026 now states it
   normatively: *"no reliable prevention mechanism exists today… Defense is therefore
   architectural rather than interceptive."* **Boundaries must be OS-enforced.**
2. **Sandboxing only the code-execution path is defeated by any unsandboxed sibling tool.**
   CVE-2026-25592 is the proof: the code executor *was* containerized; the escape came
   through a different in-process tool used as a file-write primitive.

## What is contested *within* this dossier

Recorded honestly rather than smoothed over, because it matters:

- **Pyodide as a sandbox.** Document 03 recommends it for `transform_data`; document 04
  refutes it with the January 2026 archival of LangChain Sandbox and Pydantic's
  `mcp-run-python`, and Pydantic's own postmortem (*"Python code running in pyodide can run
  arbitrary javascript"*). **The synthesis resolves this against 03** — see `00-synthesis.md`
  §5.1. `quickjs-emscripten` survives the objection; Pyodide does not.
- **MCP spec revision.** Document 05 establishes the current revision as `2026-07-28`;
  earlier lanes cite `2025-06-18`. The token-passthrough prohibition is verbatim-identical in
  both.
- **CVSS scores** for several Cursor and Claude Code CVEs differ between vendor GHSA records,
  NVD, and press. Where they conflict, the document says so.

## Findings against our own code

Five, all verified by reading source rather than inferred. Detail in `00-synthesis.md` §2.

| # | Finding | Severity |
|---|---|---|
| 2.1 | `script_sandbox` **fails closed** when isolation is unavailable | ✅ ahead of most of the field |
| 2.2 | `transform_data` has **no isolation on any platform**, macOS included | ⚠️ live gap |
| 2.3 | Seatbelt profile is `(allow file-read*)` — all reads permitted, incl. `~/.ssh`, `~/.aws` | ⚠️ industry default, but load-bearing |
| 2.4 | firejail is setuid-root w/ escape CVEs; bwrap silently fails on Ubuntu 24.04; no Landlock | ⚠️ |
| 2.5 | Credential store derives its key from a machine ID readable by any same-user process | 🔴 |

Two audits were run and **both passed**: bailout paths fail closed (§10.1), and the Seatbelt
profile is `(deny default)` rather than the inverted `(allow default)` that produced a
published escape elsewhere (§10.2).

## Method and its limits

Four parallel research agents, fanning out to depth 5, ~430k subagent tokens total. Sources
were fetched directly where possible; several publishers (iso.org, pyodide.org, genai.owasp.org,
openai.com) return HTTP 403 to automated fetchers, and those gaps are marked in each document.

One sub-agent failed and two exhausted their web-search budgets; the affected scope is named
in the relevant documents. Treat negative findings ("no such feature exists") as weaker than
positive ones throughout.
