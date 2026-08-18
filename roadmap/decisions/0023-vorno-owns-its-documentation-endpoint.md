---
id: ADR-0023
title: Vorno owns its documentation endpoint; DOCS_URL splits from SERVICE_BASE_URL
status: proposed
date: 2026-08-17
supersedes: []
superseded-by: []
---

# ADR-0023 — Vorno owns its documentation endpoint; `DOCS_URL` splits from `SERVICE_BASE_URL`

## Context

Since the fork began, every Craft-hosted endpoint has hung off a single constant in
`packages/core/src/branding.ts`:

```ts
export const SERVICE_BASE_URL = 'https://agents.craft.do';
export const VIEWER_URL = SERVICE_BASE_URL;
export const DOCS_URL = `${SERVICE_BASE_URL}/docs`;
export const OAUTH_RELAY_CALLBACK_URL = `${SERVICE_BASE_URL}/auth/callback`;
export const SLACK_OAUTH_RELAY_CALLBACK_URL = `${SERVICE_BASE_URL}/auth/slack/callback`;
```

That single constant was the right call for PLAN-018/019: it made the rebrand a one-line
flip and gave the branding gate one thing to guard. But it conflates four *different*
dependencies that have nothing in common except their historical host:

| Constant | What it is | Can Vorno own it? |
|---|---|---|
| `DOCS_URL` | Product documentation for humans + agents | **Yes — content is already ours** |
| `VIEWER_URL` | Shared-session backend (`/s/api`, Craft-hosted R2) | Only by building a share backend |
| `OAUTH_RELAY_CALLBACK_URL` | OAuth redirect relay for source auth | Only by running a relay + re-registering every OAuth app |
| `SLACK_OAUTH_RELAY_CALLBACK_URL` | Same, Slack-specific | Same |

Upstream v0.12.0 forced the question. It **deleted the built-in `craft-agents-docs` MCP
source** and replaced it with a system-prompt instruction to fetch the docs site with web
tools. The practical effect on the fork: Vorno's only doc-discovery path now points at a
competitor's documentation, describing a product our users did not install, and the
prompt line that does it named "Craft Agents" out loud until we caught it in PR #152.

Meanwhile the content problem is largely already solved. Vorno ships ~200KB of
**Vorno-written** agent guides in `apps/electron/resources/docs/*.md` (18 files;
`automations.md` alone is 48.9KB). They are bundled into the app, referenced by
`DOC_REFS` in the system prompt, and authoritative today. What does not exist is a
*public* rendering of them for humans, for agents that have web tools but no local
bundle (WebUI, hosted workspaces per PLAN-023), and for search engines.

## Decision

**Split `DOCS_URL` out of `SERVICE_BASE_URL` and point it at infrastructure Swagatar
owns.** `DOCS_URL` becomes `https://vorno.ai/docs`, served by the existing `vorno-site`
Cloudflare Worker. The other three constants stay on `SERVICE_BASE_URL` and remain
Craft-hosted; migrating them is a separate decision with a separate cost (see
*Consequences*).

Concretely:

1. `SERVICE_BASE_URL` keeps its current value and its current meaning, narrowed: *the
   upstream-hosted service endpoints the fork still rides.*
2. `DOCS_URL` is redefined as an independent constant, `https://vorno.ai/docs`, no longer
   derived from `SERVICE_BASE_URL`.
3. `DOCS_MCP_URL` is deleted. Upstream removed the docs MCP server; the constant has no
   consumer.
4. Docs are published to `/docs` on the **existing** `vorno.ai` Worker — not a new
   `docs.vorno.ai` host. No new DNS record, no new Worker, no new deploy pipeline, and
   the URL shape (`<base>/docs`) matches what every consumer already assumes.
5. Publication is **tied to the release tag**: the site builds documentation from
   `apps/electron/resources/docs/*.md` *at the tag being released*, so what is published
   is exactly what shipped. See PLAN-034.

## Why `vorno.ai/docs` and not `docs.vorno.ai`

A subdomain is the conventional choice and was the obvious first instinct. Rejected for
this round because it buys nothing here and costs real moving parts: a second Worker, a
second deploy target, a second custom-domain binding, and a second thing to forget on
release day. `vorno.ai/docs` reuses a Worker that is already live, already free-tier,
already has the brand shell and the required trademark footer, and already hosts
`/changelog` — which this same work makes real. `docs.vorno.ai` can be added later as a
redirect without breaking `DOCS_URL`, because the constant is what consumers read.

## Consequences

**Good.** Vorno's agents and users read Vorno's documentation. The fork stops
advertising the upstream product inside its own system prompt. Doc-discovery no longer
depends on a domain the upstream can retire — which it just demonstrated it will do,
twice in one release (`agents.craft.do` → `thecraftagents.com`, and the MCP server
deleted outright). The bundled guides gain a public, linkable, searchable rendering at
no additional hosting cost.

**The remaining exposure is now explicit, not hidden.** After this ADR,
`SERVICE_BASE_URL` means one thing: *Craft-hosted infrastructure Vorno still depends
on.* That is session sharing (four `${VIEWER_URL}/s/api` call sites in
`SessionManager.ts`, which POST session content to Craft-hosted R2) and all source OAuth.
For a fork whose charter leads with privacy and independence, that is a live thread —
tracked as open thread #2, deliberately **not** resolved here. Bundling an auth-path
migration into a documentation decision would make both harder to review and would put
every user's source credentials behind a change that only needed to move a docs link.

**Cost of being wrong is low and reversible.** If `vorno.ai/docs` proves to be the wrong
home, `DOCS_URL` is one constant behind a branding gate that now (post-PR #152) actually
catches hardcoded drift.

**New obligation.** Documentation becomes a release artifact. If the publish step breaks,
`DOCS_URL` points at stale or missing pages — a user-visible failure with no build
failure, the same silent-failure shape as LEARNING-048 (`vrno.io/dl`). PLAN-034 therefore
adds docs + changelog verification to the release checklist alongside the existing feed
checks, rather than trusting that a green deploy means a correct site.

## Alternatives considered

- **Keep `DOCS_URL` on upstream's domain.** Zero work, and it "works" today via a 308
  redirect. Rejected: it points Vorno users at documentation for a different product,
  and the redirect is explicitly transitional — upstream promises only that old links
  work "during the transition."
- **Ship no public docs; rely on the bundled markdown.** The bundled guides stay
  authoritative regardless, so this is tempting. Rejected: it leaves nothing for humans
  evaluating Vorno, nothing for search, and nothing for agents in WebUI/hosted contexts
  that have web tools but not the local resource bundle (PLAN-023).
- **Migrate all four constants to Swagatar infrastructure at once.** Rejected as scope:
  the OAuth relay requires re-registering every OAuth application and a hosted redirect
  service; the share backend requires an object store and a public viewer API. Both are
  real projects. Docs are ready now.
