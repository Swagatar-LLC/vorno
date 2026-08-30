# Headroom — Context Compression

Headroom is an optional integration that compresses the context Vorno sends to a
model, so long sessions and long workflow runs cost fewer tokens.

**Headroom is off by default, in every workspace.** Nothing on this page happens
until you turn it on, and turning it on sends nothing off your machine — see
[Privacy](#privacy-what-leaves-your-machine).

Headroom is an external open-source project ([headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom),
Apache-2.0). Vorno integrates it; Vorno does not bundle a compression engine of
its own.

## Overview

| What | Where you see it |
|------|------------------|
| Per-workspace on/off switch and options | Workspace Settings → **Headroom** |
| A badge on compressed tool output, and the original behind it | The session view |
| Measured savings, per session and per workspace | Workspace Settings → **Headroom savings**, and the session info panel |

Two things worth knowing about Headroom's shape in Vorno today:

- **Compression and memory are separate features.** The package Vorno compresses
  with has no memory API at all; Headroom's memory is a different program with
  its own prerequisites, and it is one of two providers behind Vorno's own
  memory capability. See [Memory](#memory).
- **It does not run by itself.** Compression happens in a separate local
  process you install and start yourself. See [Before it can do anything](#before-it-can-do-anything-the-local-proxy).

## Before it can do anything: the local proxy

The Headroom package Vorno depends on is an **HTTP client, not a compression
engine**. The compression itself runs in the Headroom *proxy* — a separate
program on your own machine. Vorno never starts, installs, or supervises it.

Vorno talks to the proxy at `http://localhost:8787`. That address is fixed in
Vorno's code and is not configurable from Settings.

To run the proxy:

```bash
uv tool install --python 3.13 "headroom-ai[proxy]==0.36.5"
headroom proxy
```

> **Name-collision warning.** `pip install headroom` installs **an unrelated
> package by a different author**. The project Vorno integrates is `headroom-ai`
> on both PyPI and npm.

**If the proxy is not running, nothing breaks.** Vorno's Headroom boundary treats
an unreachable proxy as an ordinary state: your context passes through untouched,
uncompressed, and no error is shown. You get exactly the behavior you would get
with Headroom switched off. The same is true if the request times out or the
proxy answers with something Vorno cannot verify.

## Turning Headroom on or off

Headroom is configured **per workspace**. Go to **Workspace Settings → Headroom**.

| Control | What it does |
|---------|--------------|
| **Enable Headroom** | Master switch. The other options have no effect while this is off. |
| **Compression engines** | Comma-separated engine ids, most preferred first. Empty means no compression. |
| **Verbosity** | Terse / Balanced / Verbose — how much detail Headroom keeps when steering context. |
| **Expose statistics** | Makes Headroom's context and token statistics available to the rest of the app. Required for the savings report. |

Every field carries a small badge reading either **Workspace override** or
**Instance default**, telling you where its current value came from. A field this
workspace sets also shows a **Clear** action, which drops the override and puts
the field back to the instance default.

Two workspaces hold completely independent Headroom settings. Turning Headroom on
in one leaves every other workspace as it was.

**A change applies to sessions started afterwards.** Headroom configuration is
read once, when a session starts, so a session already open keeps the setting it
began with. Start a new session to pick up a change.

### The defaults, and why they are what they are

| Field | Default |
|-------|---------|
| Enable Headroom | off |
| Compression engines | empty |
| Verbosity | Balanced |
| Expose statistics | off |

These are not placeholders. They were set from a benchmark against real Vorno
workloads — see [What to expect today](#what-to-expect-today).

## Seeing what was compressed, and getting the original back

When a tool output is compressed, its row in the session view carries a badge
showing the two measured sizes, like `20.0 KB → 1.0 KB`. Hovering it explains
what happened and how much was saved.

**Click the badge** to open a panel headed **Original, before compression**,
holding the byte-identical content from before compression. Vorno fetches it on
demand from the proxy, which still holds it under a retrieval handle.

Two guarantees worth knowing:

- **An uncompressed item shows nothing new.** There is no dormant badge and no
  greyed-out affordance. With Headroom off, the session view is exactly what it
  was before.
- **A failed retrieval says so.** Vorno never falls back to showing you the
  compressed text under the word "original". If the original cannot be produced,
  you get an explicit message naming the reason:

| What you see | What it means |
|--------------|---------------|
| Headroom is off for this workspace, so the original cannot be retrieved. | The workspace's switch is off now, even though the item was compressed earlier. |
| The Headroom SDK is not available in this build, so the original cannot be retrieved. | The integration is not present in this build of Vorno. |
| The Headroom service did not answer. The original was not retrieved. | The proxy is not running, or did not respond. |
| The Headroom service no longer holds this content. The original was not retrieved. | The proxy answered, but has no content under that handle any more. |
| Retrieval failed. The original was not retrieved. | The request failed for another reason. |
| Retrieving compressed originals is not available here. | You are looking at a shared session in the web viewer, which has no Headroom service behind it. |

## The savings report

**Headroom savings** reports what compression actually saved. It appears in two
places, showing the same figures at different scopes:

- **Workspace Settings → Headroom savings** — the whole workspace.
- **The session info panel** — that session's own slice under **This session**,
  above the **This workspace** total.

| Metric | Meaning |
|--------|---------|
| Tokens before | Tokens the context held before compression |
| Tokens after | Tokens it held afterwards |
| Tokens saved | The difference |
| Items compressed | How many items were compressed |
| Originals retrieved | How many times an original was fetched back |

Every figure here is read from Headroom itself. **A dash (`—`) means the figure
was not measured; a `0` always means a measured zero.** Vorno does not estimate,
interpolate, or fill in a missing number.

When there is nothing to show, the report says why in one sentence rather than
displaying a table of zeros:

| Message | Meaning |
|---------|---------|
| No statistics available. Turn on Headroom and "Expose statistics" for this workspace. | The switch or the statistics option is off. |
| Nothing has been compressed yet, so there is nothing measured to report. | Both are on, but no compression has happened. |
| Headroom is not available here, so nothing was measured. | The integration is not present in this build. |

## What to expect today

Vorno benchmarked Headroom on real local workloads before choosing the defaults.
Two measured results are worth setting your expectations by, because they explain
why the feature ships off:

- **In agent sessions, compression currently has no effect.** Vorno only accepts a
  compressed tool output if the proxy hands back a retrieval handle for the
  original. The pinned proxy issued zero handles across all 240 measured
  compression calls, so **0 of 48** tool outputs were accepted and every one
  passed through uncompressed. You are unlikely to see the compression badge
  described above until that changes upstream.
- **In workflow runs, compression is currently irreversible.** The Conductor path
  accepts compressed node context without requiring a handle, so what it
  compresses cannot be recovered. The best measured whole-corpus saving was
  **10.5%**, paid for with 47,811 bytes of node output that could not be
  retrieved back.

There is also a latency cost when compression does run: negligible at the median
(+4.4 to +13.1 ms per call), but roughly one call in twenty took
**1.4–2.1 seconds** against the local proxy.

Headroom is safe to leave off, and safe to switch on to try — the failure modes
above are about how much it helps, not about correctness of your data at rest.
Enabling it on a workflow-heavy workspace is the case to think about, because
that is the path where compressed content is not recoverable.

## Memory

**Vorno has memory, and it is not a Headroom feature.** It is a separate
capability with providers, and Headroom is one of the two.

- **Built-in (markdown)** — the default. Plain markdown files in your workspace,
  lexical search, no setup and no egress.
- **Headroom (MCP)** — semantic search, reached by running Headroom's memory MCP
  server. It needs Headroom installed plus a one-time ~86 MB embedding-model
  download.

None of this runs through the compression proxy this page describes, and the
Headroom package Vorno compresses with has no memory API — memory ships in the
matched Python half of the product as a separate stdio server. Turning Headroom
compression on does not turn memory on, and vice versa.

Memory is off by default, like compression. **See [Memory](memory.md)** for what
it stores, where it stores it, how to choose a provider, and what leaves your
machine.

## Privacy: what leaves your machine

**Nothing.** With or without Headroom enabled, turning this feature on does not
send your context, prompts, tool output, or credentials to Headroom Labs or to
any other third party.

That is a structural property of the integration, not a policy promise. It rests
on a supply-chain and network audit Vorno performed against the exact package
version it ships:

- **The package contains no vendor endpoint.** Auditing every URL literal in the
  published package's shipped code found exactly one distinct address:
  `http://localhost:8787`. There is no analytics host, no error reporter, and no
  update check anywhere in it.
- **Every request is relative to one base address**, so the destination of all
  Headroom traffic is whatever that base address is — by default, a process on
  your own machine.
- **Vorno pins that address in its own code and ignores the environment.** The
  package would otherwise honor a `HEADROOM_BASE_URL` environment variable.
  Vorno deliberately does not pass it through, because an ambient variable that
  silently redirects where your whole context is sent is not a channel worth
  honoring. There is no Settings field for the address either.
- **Vorno calls exactly three operations** — compress, retrieve, and statistics.
  The package also ships convenience helpers that would read `OPENAI_API_KEY` or
  `ANTHROPIC_API_KEY` out of your environment and forward them to the base
  address. Vorno's boundary never references those helpers, and a check in
  Vorno's build fails if any code outside that one boundary file touches the
  package at all.
- **The package does nothing on its own.** It has no install scripts, no
  background timers, no import-time side effects, and it does not read or write
  files. Every request it makes is the direct result of a call Vorno made.

Two consequences worth stating plainly:

- **The endpoints in Headroom named "telemetry" are not vendor reporting.** They
  read statistics out of the local proxy's own store. Vorno does not call them,
  and nothing in the package reports usage to Headroom Labs.
- **The one thing that could change this is the proxy you run.** Everything above
  concerns the client Vorno ships. If you were to run or point at a Headroom
  proxy that is not on your own machine, your context would go wherever you
  pointed it. Vorno's default — a fixed `localhost` address with no setting to
  change it — means that cannot happen by accident.
