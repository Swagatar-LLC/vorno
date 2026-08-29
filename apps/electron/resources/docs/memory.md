# Memory — Durable Facts Across Sessions

Memory lets Vorno carry a small number of durable facts from one session into
the next — a preference you stated, a decision you made, a constraint about your
project — without you repeating them.

**Memory is off by default, in every workspace.** The switch is in **Workspace
Settings → Memory**. Nothing on this page happens until you turn it on, and with
it off the prompt Vorno assembles is byte-identical to what it would be if this
feature did not exist.

Memory in Vorno is a **capability with providers**, not a feature of any one
vendor. Two providers ship today: a built-in markdown store (the default) and
Headroom's memory server. Which one answers is a setting; nothing else changes.

## What memory actually does

Two things happen, both **host-invoked** — Vorno performs them at fixed points
in a turn's lifecycle. They do not happen because the model decided to call a
tool, and there is no memory tool in the model's tool list.

| When | What happens |
|------|--------------|
| **Before every turn**, once your message is composed | Vorno searches memory using **your message as the query** and splices what it finds into that turn's context, under a `<memory>` block. |
| **After every turn**, once the reply is finished | Vorno asks a small model to extract at most **three durable facts** from the exchange and saves them. |

Two consequences worth knowing:

- **The search query is your message, verbatim.** Vorno cannot know what a turn
  will need before the turn runs, and inventing a richer query would mean
  guessing. Short or vague messages retrieve little.
- **The save runs after the reply, and is not waited on.** It costs one small
  model call per turn. "Nothing was worth remembering" is the common outcome and
  is not a failure — the extraction prompt explicitly allows the model to answer
  with nothing at all.

Retrieved memories are added as context, not as quotations. The block tells the
model to use them and not to cite them unless asked. A single memory is
truncated at 1,000 characters, and the whole block is capped at 8,000
characters, so memory can never crowd out your actual request.

**Automatically saved memories are unscoped**, which is what makes them useful:
a fact saved in one session is findable from every later session in that
workspace. (The scope machinery exists — a memory can be pinned to a session,
agent, or turn — but the automatic path deliberately does not use it, because a
session-scoped memory would only ever be found by the session that wrote it.)

## The two providers

|  | **Built-in (markdown)** | **Headroom (MCP)** |
|--|-------------------------|--------------------|
| Setup | None | Install Headroom, then a one-time model download |
| Search | **Lexical** — words, tags, recency | **Semantic** — embeddings |
| Scoping | user / session / agent / turn | user only |
| Reads | Structured records | Formatted text |
| Decay + archive | Yes | No |
| Retrieval log | Yes | No |
| What leaves your machine | Nothing | A one-time ~86 MB model download |

### Built-in (markdown) — the default

Plain markdown files with frontmatter, under your workspace's `memory/` folder.
Browsable in Finder, greppable from a shell, editable by hand. **No Python, no
downloads, no keys, and no network access at any point in its lifecycle** — it
uses `node:fs` and nothing else.

**Its retrieval is lexical, not semantic, and that is the deal.** There is no
embedding index and there will not be one. It scores a memory by what fraction
of your query's distinct words it accounts for, with tag matches worth more than
body matches and a bonus for containing your query verbatim. Words shorter than
two characters and a short list of English stop words are dropped.

Concretely: ask it *"what did we decide about branching?"* and it will **not**
find a memory that reads *"one topic branch per plan"*. `branching` and `branch`
are different tokens, `decide` appears in neither, and nothing else overlaps. A
semantic index would catch that paraphrase; this one cannot. If that matters to
you more than zero setup does, the Headroom provider is the alternative.

A memory also has to clear a minimum match score before it appears at all,
however fresh or important it is. Without that floor, a query that matched
nothing well would still promote *irrelevant* memories into your context, and a
memory system whose failure mode is confidently supplying the wrong context is
worse than one that supplies none.

### Headroom (MCP)

Semantic search over Headroom's own local store, reached by running Headroom's
memory MCP server as a subprocess. It has real prerequisites:

```bash
uv tool install headroom-ai
```

Vorno looks for Headroom's interpreter under
`~/.local/share/uv/tools/headroom-ai/bin/`, or at whatever you set
`VORNO_HEADROOM_PYTHON` to.

Installing is not enough. The embedder needs a model (~86 MB) fetched once from
HuggingFace, and Vorno runs the server with offline mode on, so it will not
fetch it for you. Run `headroom memory stats` once with network access to pull
it down.

> **Name-collision warning.** `pip install headroom` installs **an unrelated
> package by a different author**. The project Vorno integrates is `headroom-ai`.

Two limits of this surface, reported by the provider itself rather than
discovered by you:

- **Scoping collapses to a single user layer.** Vorno's memory interface can
  express four layers; this surface writes only the user layer, so memories are
  not separated per session, agent, or turn.
- **Reads come back as text, not records.** Results arrive as formatted lines
  like `1. [relevance=0.50] <content>`, so tags, timestamps, and importance are
  **not available on reads** — only the content and a relevance number.

Any single operation that takes longer than 20 seconds is treated as
unavailable.

## The three provider states

A provider reports one of three states, and the distinction between the last two
is the whole reason there are three:

| State | What it means | What to do |
|-------|---------------|------------|
| **Ready** | The provider works. | Nothing. |
| **Installed, but not set up** | The software is present and starts correctly, but calls into it fail because a setup step is missing. | Finish the setup step — do not reinstall. |
| **Not available** | The software is missing on this machine. | Install it, or pick the other provider. |

"Installed but not set up" is shown separately because collapsing it into "not
available" produces actively bad advice. Headroom's memory server in that state
starts, completes its handshake, and advertises both of its tools — while every
call fails for want of the embedding model. Telling someone that is "not
available" sends them to reinstall a thing that is already installed and
working, and the reinstall will not fix it.

Vorno distinguishes the two by actually calling the provider once, not by
checking whether it launched. A capability check that stopped at "the server
advertised its tools" would report *ready* for a provider on which everything
fails.

The built-in provider **cannot** occupy the middle state. There is nothing to
provision. That is the entire argument for it being the default.

## Settings

Memory is configured **per workspace**, at **Workspace Settings → Memory**.

| Setting | Config field | Default | What it does |
|---------|--------------|---------|--------------|
| Enable memory | `enabled` | **off** | Master switch. Nothing else has any effect while this is off. |
| Provider | `provider` | `builtin-markdown` | `builtin-markdown` or `headroom-mcp`. |
| Results per search | `topK` | `5` | How many memories a search may return. 1–50. |
| Search memory automatically | `autoLoad` | on | Whether Vorno searches memory and splices results into context at the start of a turn. Off means memory accumulates but nothing reads it automatically. |
| Save after each turn | `autoSave` | on | Whether Vorno mines finished turns for durable facts. |
| Memory half-life (days) | `decayHalfLifeDays` | `60` | Recency weighting, for providers that support decay. 1–3650. |
| Include archived | `includeArchived` | off | Whether searches reach into cold storage. |

`autoLoad` and `autoSave` default **on** underneath the master switch, on
purpose. A memory feature whose reads and writes were separately off by default
would be enabled-but-inert, and "enabled did nothing" is a worse first
experience than "enabled did something you can turn off".

`includeArchived` defaults **off**, and that default is load-bearing rather than
merely conservative: an archive that still loads is not an archive, it is a
rename.

The panel also shows the selected provider's **state** — ready, installed but
not set up, or not available — alongside the provider's own notes about what it
can and cannot do. Those notes come from the provider itself rather than from a
list maintained beside it, so they cannot quietly go out of date.

Like the Headroom section, every field carries a small badge reading either
**Workspace override** or **Instance default**, telling you where its current
value came from, and a field this workspace sets also offers a **Clear** action
that drops the override and reverts to the instance default. Two workspaces hold
completely independent memory settings.

Underneath the panel these are two ordinary config layers, editable by hand:

- **Per workspace** — `<workspace>/config.json`, under `defaults.memory`.
- **Instance-wide base** — the app's `config.json`, under `memory`.

A workspace value wins over the instance value, field by field; anything neither
layer sets falls through to the defaults in the table above.

Two rules about how these files are read, both of which can surprise you:

- **A layer with a bad value is discarded whole.** A wrong type, an unknown
  provider name, or a number outside its range rejects that entire layer rather
  than half-trusting a file we know is corrupt. Memory then falls through to the
  layer below — ultimately, to off.
- **An unknown key is ignored, and the layer still works.** A key written by a
  newer build must not disable the feature on an older one.

**A change applies to sessions started afterwards.** Memory configuration is
read once, when a session starts.

## How the built-in store works on disk

Inside your workspace:

```
<workspace>/memory/
  entries/*.md          hot — searched by default
  archive/*.md          cold storage — reached only on purpose
  retrieval-log.jsonl   one line per retrieval
```

These directories are created on the first save, not when you select the
provider, so merely choosing it does not scatter empty folders through your
workspace.

### A memory file

```markdown
---
id: 20260828T193000-a1b2c3d4
created: 2026-08-28T19:30:00.000Z
updated: 2026-08-28T19:30:00.000Z
importance: 0.5
tags: [roadmap, headroom]
citations: 3
last-cited: 2026-08-29T08:00:00.000Z
---

Jeff runs upstream Craft stable side-by-side with Vorno, so the fork must keep
its own branding and config directory.
```

Every field is optional except `id` — a key with no value is omitted rather than
written empty, so a file says only what is true about it. A file the parser
cannot read is skipped, not fatal: one bad file must never take out every search
in the workspace.

`importance` is a 0–1 hint. Facts saved automatically get `0.5`; you can edit it
by hand. `tags` are indexed and weighted more heavily than body text, which
makes hand-tagging a memory a genuinely effective way to make it findable — the
automatic path does not add tags.

`citations` and `last-cited` are written by retrieval, not by you. Being read is
not being edited, so retrieval updates `last-cited` and leaves `updated` alone.

A file's directory is the authority on whether it is archived, not its
frontmatter. Moving a file by hand between `entries/` and `archive/` does the
right thing.

### Decay: how memories age

Each memory has a decay score of `0.5 ^ (age / half-life)`. At exactly one
half-life it is 0.5; at zero age it is 1.0. Age is measured from the **most
recent** of the memory's `updated` and `last-cited` stamps, falling back to
`created`.

Three things follow, and they are the whole model:

- **Importance changes the half-life, not the score.** Importance at or above
  `0.7` **doubles** the effective half-life; at or below `0.3` it **halves** it.
  An important memory decays slower *forever*, rather than merely starting from
  a higher number.
- **Importance at or above `0.9` is pinned** and never decays or archives at
  all. "This matters indefinitely" is a different statement from "this matters
  twice as long", so it gets a different mechanism.
- **Being retrieved resets the clock.** Every memory a search returns has its
  `last-cited` stamp refreshed and its citation count bumped. A memory that
  keeps earning its place stays fresh; one nobody has wanted in a year ages out
  honestly. (Archived memories are exempt: a deliberate lookup into cold storage
  does not quietly resurrect what it found.)

Below a score of 0.25 — two half-lives, so about 120 days at the default for an
ordinary memory — a memory becomes an archive candidate. Decay and importance
also nudge ranking among results that match your query comparably well, but they
have floors: they *reorder* comparable matches, they never suppress a strong one
entirely.

### Archiving: never deleting

When a memory decays out, its file **moves** from `entries/` to `archive/`. It
is not deleted. Nothing in this feature deletes a memory file, ever.

The sweep that does this runs when a memory is saved, not when one is searched —
a save is already a write, and sweeping on every search would make retrieval get
slower as your store grows.

An archived file carries a banner as the first line of its body:

```markdown
> **⚠️ From cold storage — this was true at one time, but it may not be true now.**
> Archived 2026-08-28T19:30:00.000Z; unverified since. Reason: decayed out (score 0.198 after 141d).
```

That banner is mandatory and it travels with the content everywhere it goes,
including into the model's context, where an archived memory is prefixed with
its own cold-storage warning. Cold content may never be restated as a current
fact: it was true at one time, and nothing has verified it since.

Archived memories are excluded from searches unless `includeArchived` is on.

### The retrieval log

`memory/retrieval-log.jsonl` gets one JSON line per search:

```json
{"ts":"2026-08-28T19:31:00.000Z","query":"branching policy","provider":"builtin-markdown","target":{"scope":{},"destination":"main-context"},"loaded":42,"trimmed":39,"kept":["20260828T193000-a1b2c3d4"]}
```

It records the timestamp, the query, how many memories were loaded, how many
were trimmed, and the **ids** of the ones kept. It **never records memory
content** — a log that duplicated the corpus would be a second copy of it with
none of its archiving discipline.

It exists so that "what did memory put in front of the model, and when" is
answerable from a file you can read, without instrumenting the app.

## Privacy: what leaves your machine

**With the built-in provider: nothing.** Not your memories, not your queries,
not your prompts.

That is a structural property, not a policy promise. Every byte of I/O the
built-in provider performs lives in one file, and that file imports `node:fs`
and nothing else — no HTTP client, no subprocess, no dynamic import, no
environment variable that could redirect it. There is no address to configure
because there is no request to send.

**With the Headroom provider: one disclosed exception.** Enabling it downloads
an embedding model (~86 MB) from HuggingFace, once. That is the whole of it:
after the model is present, memory operations run against a local subprocess and
a local store. Vorno starts that subprocess with offline mode set explicitly
rather than inherited, so which state you are in is a property of Vorno's
invocation and not of whatever happened to be in your shell.

Your memory content is not exempt from the ordinary rule that context goes to
whichever model you are talking to. Memory splices facts into the prompt — that
is what it is for — so anything you let it remember will be sent to your model
provider on turns where it matches. If a fact should never reach a model, it
should not be in memory. Delete or edit the file; it is plain markdown.

## Turning memory off

Turn off **Enable memory** in **Workspace Settings → Memory** (or set `enabled`
to `false` by hand). From the next session onward, nothing is searched and
nothing is saved, and the assembled prompt goes back to being byte-identical to
what it would be with the feature absent.

**Your existing memories are untouched.** The files stay exactly where they are,
under `<workspace>/memory/`, and are still browsable, greppable, and editable.
Turning memory back on picks up right where it left off. If you want a memory
gone, delete its file — that is the only thing that removes one.
