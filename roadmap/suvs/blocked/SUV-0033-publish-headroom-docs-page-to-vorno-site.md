---
id: SUV-0033
title: Publish the Headroom docs page to vorno.ai/docs
status: blocked
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-27
updated: 2026-08-28
related:
  - SUV-0032-vorno-plus-headroom-docs-page.md (authors the page this SUV publishes)
  - SUV-0029-memory-provider-seam-with-headroom-and-builtin-markdown-providers.md (the memory behaviour and the embedder-fetch disclosure the page must carry)
blocked-by:
  - SUV-0032-vorno-plus-headroom-docs-page.md (the page must exist in the in-app docs tree before it can be published)
  - jh (owner gate: publishing to vorno.ai is an outward-facing release step Jeff coordinates with site and social timing — the content is ready, the publish is his call)
---

# SUV-0033 — Publish the Headroom docs page to vorno.ai/docs

## Goal

Get SUV-0032's Headroom page actually rendering at `vorno.ai/docs`, through the
`vorno-site` build gate, so PLAN-040's acceptance item 7 is discharged on the
web and not merely on disk.

## Why this is its own SUV

SUV-0032 landed the content at `apps/electron/resources/docs/headroom.md` and
closed its own acceptance honestly — but PLAN-040's item says **`vorno.ai/docs`**,
and the Astro Starlight site builds from a git tag in the separate `vorno-site`
repo. SUV-0032 correctly recorded the publish step as "real and unowned". This
SUV owns it.

**On the one-branch rule.** That rule keeps a *single unit of work* coherent on a
single branch; it is not a prohibition on work that spans repositories. Reading
it as a bar to publishing would mean Vorno can never ship public documentation,
which is plainly not its intent. A cross-repo unit is cut as its own SUV — this
one — and carries its own branch in `vorno-site`. The rule is satisfied by
*each* unit being one branch, not by the plan touching only one repo.

## Scope

- Publish the Headroom page into `vorno-site`'s content tree so it renders at
  `vorno.ai/docs`, matching how the other 17 in-app guides are carried.
- **Publish the memory page alongside it (added 2026-08-28).** SUV-0029/0040
  landed `apps/electron/resources/docs/memory.md`, and the Headroom page's
  Memory section now *links to it*. Publishing one without the other would ship
  a dangling cross-reference on the live site — so the two pages are one
  publishing unit, not two. The memory page also carries the privacy claim that
  most needs to be right in public: the built-in provider sends nothing, and the
  ~86 MB embedder fetch belongs to the Headroom provider alone.
- **Exercise the `vorno-site` build gate as part of this loop**, not after it.
  This is the whole point of the SUV: a guide written for a filesystem stays
  valid on disk and breaks on the web. The PLAN-034 arc is the precedent — that
  gate caught a stale `thecraftagents.com` link and **36 filesystem-relative
  hrefs** that would have 404'd. Any link, image, or anchor rewriting the gate
  demands is in scope here.
- Reconcile drift between the in-app copy and the published copy, in whichever
  direction the gate forces. If a fix belongs in the in-app source of truth, it
  lands there and re-syncs rather than being patched only on the site.
- Confirm the page carries the **embedder-fetch disclosure** required by
  ADR-0029 (C1): the one-time ~86 MB HuggingFace model download on first enable
  is the sole exception to "nothing leaves the machine", documented rather than
  gated behind a consent prompt (owner decision, 2026-08-27).

## Acceptance

- [ ] The Headroom page renders at `vorno.ai/docs` and is reachable from the docs navigation.
- [ ] The memory page renders there too, and the Headroom page's link to it resolves on the web rather than only on disk.
- [ ] The `vorno-site` build gate passes on the branch that publishes it, with any link/href findings fixed rather than suppressed — and the fixes landed in the in-app source of truth where that is where they belong.
- [ ] Published content and `apps/electron/resources/docs/{headroom,memory}.md` agree; any divergence forced by the gate is recorded in this SUV's status log with its reason.
- [ ] The privacy section names the one-time embedder model fetch explicitly, so "nothing leaves the machine without opt-in" is stated with its actual carve-out rather than as an overclaim — and attributes it to the `headroom-mcp` provider specifically, since the default provider has no such fetch.

## Status log

- `2026-08-27` — created in `planned/`. Cut in response to PLAN-040's acceptance
  item 7 being only partly discharged by SUV-0032: the in-app page exists, the
  web page does not, and no SUV on `plan/plan-040` could own the `vorno-site`
  half. Item 7 is re-scoped in the plan to name both SUVs. Spans repositories by
  design; see *Why this is its own SUV* on why that is compatible with the
  one-branch rule rather than an exception to it.

- `2026-08-28` — **scope widened to two pages; still `planned/`, and deliberately
  not executed.** SUV-0029/0040 shipped memory and with it
  `apps/electron/resources/docs/memory.md`, which the Headroom page now links
  to — so publishing Headroom alone would put a dangling link on the live site.
  Both pages are in the repo, written, and tested; what remains is the publish.

  **Left for the owner on purpose, not overlooked.** Publishing to `vorno.ai` is
  outward-facing and effectively irreversible once indexed, and site changes are
  timed against announcements. Recorded as an explicit `blocked-by` so the state
  is "waiting on a decision" rather than "nobody got to it" — the distinction the
  `blocked/` conventions exist to preserve. Everything upstream of the publish is
  done; this SUV is one branch in `vorno-site` away from closing, whenever that
  is the right week.
