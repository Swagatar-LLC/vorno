---
id: PLAN-034
title: Public docs + changelog, published on release
status: documented
direction: DIR-04
owner: jh
created: 2026-08-17
updated: 2026-08-22
related:
  - ADR-0023
blocked-by: []
---

# PLAN-034 — Public docs + changelog, published on release

**Decision:** [ADR-0023](../../decisions/0023-vorno-owns-its-documentation-endpoint.md)

## Problem

Vorno has no public documentation. Upstream v0.12.0 deleted the built-in
`craft-agents-docs` MCP source and replaced it with "fetch the docs site with web tools,"
so the fork's only doc-discovery path points at Craft's documentation for Craft's
product. Separately, `vorno.ai/changelog` is hand-maintained and **stale at v0.13.0**
while shipping 0.16.0 — release notes exist in-repo and on the GitHub release feed, but
nothing publishes them to our own web presence.

Content is not the bottleneck: `apps/electron/resources/docs/*.md` is 18 Vorno-written
guides (~200KB) that already ship with the app. The gap is publication.

## Shape

One body of work, four lanes. Lanes A–C run in parallel; D closes.

```
A. repo hygiene ────────────┐
B. docs+changelog site ─────┼──> D. DOCS_URL flip + release v0.17.0
C. shortener + dispatch ────┘
```

### Lane A — repo hygiene (`Swagatar-LLC/vorno`)

Fallout from the v0.12.0 merge that PR #152 deliberately left alone.

- [x] `Dockerfile.server` `COPY apps/docs-site/package.json apps/docs-site/` references a
      path in **no** git tree (ours or upstream's) and is not gitignored — the server
      image build should fail on a clean checkout. Remove it and the matching
      `.dockerignore` stanza. Verify with an actual `docker build` (daemon required;
      no CI job builds this image, which is why it slipped).
- [x] `scripts/install-app.sh` / `install-app.ps1` are upstream's installers, fully
      Craft-branded, now pointing at `thecraftagents.com`. Vorno is macOS-arm64-only and
      ships `scripts/install-vorno.sh` + `vrno.io/dl`. **Recommendation: delete both.**
      They are non-functional for Vorno and actively misleading (`install-app.ps1` is
      Windows). Accept the recurring deleted-by-us merge conflict, as with `craft-cli.md`.
- [x] Branding gate coverage: `scripts/` is not a `SCAN_ROOT` and `.sh`/`.ps1` are not
      scanned extensions, so the above was invisible. Add the root and the extensions;
      allowlist what is genuinely upstream-internal. Consider root-level files
      (`Dockerfile*`, `.dockerignore`, `README.md`) — scope to what does not flood.

### Lane B — docs + changelog site (`Swagatar-LLC/vorno-site`)

Publish to the **existing** `vorno-site` Cloudflare Worker (Swagatar account, free tier;
IDs are not recorded in this public repo). No new DNS, no new Worker.

- [x] `/docs` — generated from `apps/electron/resources/docs/*.md` **fetched at the
      release tag** from the public `Swagatar-LLC/vorno` repo, so published docs are
      exactly the docs that shipped. Generator: Astro Starlight (search, nav, dark mode
      out of the box — do not hand-roll a docs framework). Light brand pass via CSS vars;
      do not fork the visual identity.
- [x] `/changelog` — generated from `apps/electron/resources/release-notes/*.md` at the
      same tag: an index plus a page per version. Replaces the hand-written page that is
      three minor versions stale. Each entry links to the GitHub release for binaries.
- [x] Existing hand-written marketing pages (`/`, `/download`, `/links`, `/blog`) are
      untouched. The Worker keeps `run_worker_first: true` and its `www`→apex and
      OS-aware `/download` logic.
- [x] **Every page keeps the two required footer lines verbatim** — the Craft Docs Ltd.
      non-affiliation disclaimer and "Powered by Claude" (vorno-site README guardrail).

### Lane C — shortener + release dispatch

- [x] `vrno.io` slugs → `LINKS` map in `~/dev/vrno-shortener/worker/index.js` + redeploy
      (curated slugs are git-reviewable; the KV namespace is for ad-hoc only):
      `/docs` → `https://vorno.ai/docs/`, `/changelog` → `https://vorno.ai/changelog/`
      (the latter was already correct). Deployed via the Cloudflare REST API —
      `wrangler` holds no credentials on this machine. Both verified live.
      The `/docs` comment promised a repoint at `docs.vorno.ai`, a host ADR-0023
      **rejected** and that has no DNS record; the comment was replaced, not just the
      value, so it stops misdirecting the next maintainer.
- [x] Push `vrno-shortener` to GitHub (long-standing open thread; authorized 2026-08-17)
      → public `Swagatar-LLC/vrno-shortener`.
- [x] `release.yml` (vorno) fires a `repository_dispatch` to `vorno-site` after a
      successful publish, carrying the version; `vorno-site` builds at that tag and
      deploys. **PR #165** (sender) + `vorno-site@main` (receiver:
      `.github/workflows/publish.yml`, `build/verify-live.mjs`). The receiver lives on
      the default branch because GitHub only honours `repository_dispatch` /
      `workflow_dispatch` there — on a PR branch it would be untriggerable and so
      untestable. It also carries a `workflow_dispatch` tag input, so the whole
      pipeline is runnable by hand without cutting a release.
      Dispatching is not enough on its own: the API returns 204 as soon as the event
      is queued, so both sides verify the *live site* over HTTP afterwards.
- [x] **Human-gated:** an agent must not mint or install these.
      - `VORNO_SITE_DISPATCH_TOKEN` in `vorno` — installed and proven by the v0.18.0
        release dispatch.
      - `CLOUDFLARE_API_TOKEN` in **`vorno-site`** — installed with the deployment
        permission required by the receiver workflow. The v0.18.0
        `repository_dispatch` run built, deployed, and verified the live site
        successfully (run `32427249451`).

### Lane D — flip + release

- [x] `packages/core/src/branding.ts`: `DOCS_URL = 'https://vorno.ai/docs'` (independent
      of `SERVICE_BASE_URL`); delete `DOCS_MCP_URL` (no consumers since v0.12.0).
      `DOCS_SHARING_URL` must resolve to a page that exists in *our* docs — either write
      the sharing guide or repoint it at the docs index. Do not ship a link to a
      Craft-only path.
- [x] `apps/electron/resources/docs/sources.md` — two hardcoded `thecraftagents.com`
      references (bundled agent doc; the gate does not scan `.md`).
- [x] Verify the branding gate and full CI, then cut **v0.17.0** per
      `[skill:release-and-version]` (a `feat:` lands → minor). Attach the `ntfy` source to
      the release session.
- [x] Release verification adds two checks to the existing five:
      `vorno.ai/docs` serves the current docs, and `vorno.ai/changelog` lists the new
      version. Per ADR-0023 these fail *silently* — a green deploy is not evidence of a
      correct site, the same shape as LEARNING-048.

## Ordering

Lane D's flip must not merge before Lane B is live, or `DOCS_URL` points at a 404 in a
shipped build. Verify `https://vorno.ai/docs` returns 200 over real HTTP (`/usr/bin/curl`
— the shell's `curl` is aliased to a missing binary) before merging the flip.

## Status log

- `2026-08-17` — created in `in-progress/`; Lanes A–C began in parallel.
- `2026-08-22` — moved from in-progress to done: all lanes merged; v0.17.0 shipped Vorno-owned docs and changelog, and v0.18.0 proved automatic release publication end to end.
- `2026-08-22` — moved from done to documented: verified `vorno.ai/docs` publishes the v0.18.0 bundled guides and `vorno.ai/changelog` lists v0.18.0 through v0.11.2; release workflow run `32427249451` built, deployed, and verified the live site. Docs touched: this plan.

## Out of scope

`SERVICE_BASE_URL` itself. Session sharing and all source OAuth stay Craft-hosted; that
migration is open thread #2 and needs its own decision, its own OAuth-app
re-registration, and its own test of the Slack flow. Bundling it here would put every
user's source credentials behind a docs change.
