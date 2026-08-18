# PLAN-034 — Public docs + changelog, published on release

**Status:** in-progress
**Owner:** Jeff (agent lanes)
**Started:** 2026-08-17
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

- [ ] `Dockerfile.server` `COPY apps/docs-site/package.json apps/docs-site/` references a
      path in **no** git tree (ours or upstream's) and is not gitignored — the server
      image build should fail on a clean checkout. Remove it and the matching
      `.dockerignore` stanza. Verify with an actual `docker build` (daemon required;
      no CI job builds this image, which is why it slipped).
- [ ] `scripts/install-app.sh` / `install-app.ps1` are upstream's installers, fully
      Craft-branded, now pointing at `thecraftagents.com`. Vorno is macOS-arm64-only and
      ships `scripts/install-vorno.sh` + `vrno.io/dl`. **Recommendation: delete both.**
      They are non-functional for Vorno and actively misleading (`install-app.ps1` is
      Windows). Accept the recurring deleted-by-us merge conflict, as with `craft-cli.md`.
- [ ] Branding gate coverage: `scripts/` is not a `SCAN_ROOT` and `.sh`/`.ps1` are not
      scanned extensions, so the above was invisible. Add the root and the extensions;
      allowlist what is genuinely upstream-internal. Consider root-level files
      (`Dockerfile*`, `.dockerignore`, `README.md`) — scope to what does not flood.

### Lane B — docs + changelog site (`Swagatar-LLC/vorno-site`)

Publish to the **existing** `vorno-site` Cloudflare Worker (account
`c3e447a3c0a726801eeb9a1148ff09de`, zone `2725363d3a92fd613c937ec791ffab9a`, free tier).
No new DNS, no new Worker.

- [ ] `/docs` — generated from `apps/electron/resources/docs/*.md` **fetched at the
      release tag** from the public `Swagatar-LLC/vorno` repo, so published docs are
      exactly the docs that shipped. Generator: Astro Starlight (search, nav, dark mode
      out of the box — do not hand-roll a docs framework). Light brand pass via CSS vars;
      do not fork the visual identity.
- [ ] `/changelog` — generated from `apps/electron/resources/release-notes/*.md` at the
      same tag: an index plus a page per version. Replaces the hand-written page that is
      three minor versions stale. Each entry links to the GitHub release for binaries.
- [ ] Existing hand-written marketing pages (`/`, `/download`, `/links`, `/blog`) are
      untouched. The Worker keeps `run_worker_first: true` and its `www`→apex and
      OS-aware `/download` logic.
- [ ] **Every page keeps the two required footer lines verbatim** — the Craft Docs Ltd.
      non-affiliation disclaimer and "Powered by Claude" (vorno-site README guardrail).

### Lane C — shortener + release dispatch

- [ ] `vrno.io` slugs → `LINKS` map in `~/dev/vrno-shortener/worker/index.js` + redeploy
      (curated slugs are git-reviewable; the KV namespace is for ad-hoc only):
      `/docs` → `https://vorno.ai/docs`, `/changelog` → `https://vorno.ai/changelog`.
- [ ] Push `vrno-shortener` to GitHub (long-standing open thread; authorized 2026-08-17).
- [ ] `release.yml` (vorno) fires a `repository_dispatch` to `vorno-site` after a
      successful publish, carrying the version; `vorno-site` builds at that tag and
      deploys.
- [ ] **Human-gated:** the dispatch needs a GitHub token secret in `vorno`, and
      `vorno-site` needs `CLOUDFLARE_API_TOKEN`. An agent must not mint or install those.
      Until Jeff adds them, publication is a documented one-liner
      (`bunx wrangler deploy`) run from the release session — the pipeline is built and
      tested, the last mile is manual.

### Lane D — flip + release

- [ ] `packages/core/src/branding.ts`: `DOCS_URL = 'https://vorno.ai/docs'` (independent
      of `SERVICE_BASE_URL`); delete `DOCS_MCP_URL` (no consumers since v0.12.0).
      `DOCS_SHARING_URL` must resolve to a page that exists in *our* docs — either write
      the sharing guide or repoint it at the docs index. Do not ship a link to a
      Craft-only path.
- [ ] `apps/electron/resources/docs/sources.md` — two hardcoded `thecraftagents.com`
      references (bundled agent doc; the gate does not scan `.md`).
- [ ] Verify the branding gate and full CI, then cut **v0.17.0** per
      `[skill:release-and-version]` (a `feat:` lands → minor). Attach the `ntfy` source to
      the release session.
- [ ] Release verification adds two checks to the existing five:
      `vorno.ai/docs` serves the current docs, and `vorno.ai/changelog` lists the new
      version. Per ADR-0023 these fail *silently* — a green deploy is not evidence of a
      correct site, the same shape as LEARNING-048.

## Ordering

Lane D's flip must not merge before Lane B is live, or `DOCS_URL` points at a 404 in a
shipped build. Verify `https://vorno.ai/docs` returns 200 over real HTTP (`/usr/bin/curl`
— the shell's `curl` is aliased to a missing binary) before merging the flip.

## Out of scope

`SERVICE_BASE_URL` itself. Session sharing and all source OAuth stay Craft-hosted; that
migration is open thread #2 and needs its own decision, its own OAuth-app
re-registration, and its own test of the Slack flow. Bundling it here would put every
user's source credentials behind a docs change.
