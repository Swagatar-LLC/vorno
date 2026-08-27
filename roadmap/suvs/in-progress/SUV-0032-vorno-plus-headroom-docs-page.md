---
id: SUV-0032
title: Vorno + Headroom docs page
status: in-progress
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-27
related:
  - SUV-0027-in-app-headroom-savings-and-stats-report-view.md (the report view the page documents)
  - SUV-0029-adopt-headroom-multi-layer-memory-for-sessions-and-workflows.md (the memory behavior the page documents)
blocked-by:
  - SUV-0014-vet-and-pin-headroom-for-adoption.md (the telemetry audit the privacy section must not outrun)
  - SUV-0017-workspace-settings-ui-for-headroom.md (the enable/disable toggle the page documents)
  - SUV-0026-user-visible-retrieval-of-compressed-originals.md (the view-original affordance)
  - SUV-0027-in-app-headroom-savings-and-stats-report-view.md (the report view)
  - SUV-0029-adopt-headroom-multi-layer-memory-for-sessions-and-workflows.md (the memory behavior)
---

# SUV-0032 — Vorno + Headroom docs page

## Goal

Publish the `vorno.ai/docs` page explaining what Headroom does in Vorno, how
to toggle it, and what leaves the machine (nothing without opt-in).

## Scope

- One docs page covering: what compression/token stats/memory do in Vorno,
  the workspace settings toggle (SUV-0017), viewing originals and the report
  view (SUV-0026/0027), memory behavior (SUV-0029), and the privacy posture
  grounded in the SUV-0014 telemetry audit.
- Written against shipped behavior — this SUV lands late, once the surfaces it
  describes exist.
- Deliberately out: developer/contributor docs for the extension interface
  (the SUV-0030 design doc serves that audience).

## Acceptance

- [x] A page exists in the `vorno.ai/docs` content source covering what Headroom does in Vorno, how to enable/disable it per workspace, and how to view originals and the savings report. → `apps/electron/resources/docs/headroom.md`.
- [x] The privacy section states what leaves the machine and under what opt-in, consistent with the SUV-0014 telemetry audit findings — no claim the audit does not support. → page §"Privacy: what leaves your machine", every bullet traced to `headroom-vetting-report.md` §3.1–§3.6 + F3.
- [x] Every UI element the page references (toggle, report view, view-original affordance) exists in the app as described at time of merge. → 26 quoted strings asserted against the shipped `en.json` by `packages/shared/src/docs/__tests__/headroom-doc.test.ts`.

## Status log

- `2026-08-26` — created in `planned/`
- `2026-08-26` — `blocked-by:` populated. The plan's `related-suvs:` annotated this
  SUV "last — documents shipped surfaces", but the edge list was empty, so the
  plan-level task compiled it as a ROOT node that would start in parallel with
  SUV-0014 and document surfaces that do not exist yet. Edges drawn from this
  SUV's own acceptance list (toggle, view-original, report view, telemetry
  audit) plus the memory behavior named in `related:`. Prose annotations are not
  machine-readable; the frontmatter edge is the one the compiler reads.
- `2026-08-27` — **implemented** on `plan/plan-040`; `planned/` → `in-progress/`
  (unmerged, no PR cut — matching SUV-0017/0023/0024/0025/0026's state on this
  branch). Page landed at `apps/electron/resources/docs/headroom.md`.

  **Which tree is "the `vorno.ai/docs` content source".** `apps/electron/resources/docs/`,
  not `docs/`. It holds exactly the 17 guides the site publishes verbatim from a
  git tag, `docs/` is developer/deployment material the site does not carry, and
  the Astro Starlight site itself lives in the separate `vorno-site` repo — out
  of reach of this SUV's one-branch rule. `packages/shared/src/docs/index.ts`
  auto-discovers the folder, so there is no manifest to register the page in; it
  syncs to `~/.vorno-agent/docs/` on the next launch with no further wiring.

  **All five blockers were satisfiable after all — the orientation's status table
  was stale.** Folder status lags the branch here: SUV-0014's audit is fully
  written up (`roadmap/evidence/PLAN-040/headroom-vetting-report.md`, acceptance
  all `[x]`) while its file still sits in `planned/`, and SUV-0017/0026's UI is
  implemented and green in `in-progress/`. Verified by reading the shipped code
  and locale rather than the SUV prose: `HeadroomSettingsSection.tsx`,
  `HeadroomReportSection.tsx` (mounted at `WorkspaceSettingsPage.tsx:746/749` and
  `SessionInfoPopover.tsx:160`), `packages/ui/.../headroom-retrieval.ts` +
  `TurnCard.tsx:939/956`, and the 37 `headroom*` values in `en.json`.

  **The page documents measured behavior, including the unflattering parts.**
  SUV-0025's benchmark (landed `9a984876`, same branch) found session compression
  **inert** — 0 of 48 tool outputs accepted, because `compressToolOutput` requires
  a retrieval handle and the pinned proxy issued zero across 240 calls — and
  Conductor compression **irreversible** for the same reason. A page promising a
  compression badge users will not see would have been a claim the evidence
  contradicts, so §"What to expect today" states both, plus the p95 latency cost.
  §"Before it can do anything" documents F4: the npm package is an HTTP client,
  so the user must install and run the proxy themselves (`headroom-ai[proxy]`),
  and carries the `pip install headroom` name-collision warning.

  **Memory: documented as absent, not omitted.** The SUV's scope line names
  "memory behavior (SUV-0029)", but SUV-0029 is `blocked/` on a premise failure —
  `headroom-ai@0.36.5` has no memory API at all. Silently dropping the section
  would have been a unilateral scope cut; writing a how-to would have documented
  a feature that does not exist. §"Memory" instead states plainly that it is not
  available in Vorno and why, which is the shipped behavior.

  **Privacy section, claim by claim.** Every sentence traces to the vetting
  report: one distinct URL literal in the package (§3.1), all paths relative to
  one base address (§3.2), no install scripts / timers / import-time side effects
  / fs access (§3.5, §1), the `/v1/telemetry*` endpoints being local proxy reads
  rather than vendor reporting (§3.2 blockquote), and F3's `OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` credential path being unreachable because the boundary
  never references `chat`/`messages`. The one claim the audit does *not* make —
  and the page does not either — is that a remote `baseUrl` is impossible: the
  page says Vorno pins `localhost`, ignores `HEADROOM_BASE_URL`, and exposes no
  setting for it, then names the proxy you run as the one thing that could change
  the answer. That matches §3.6's egress table exactly.

  **Test — 33 assertions, red-then-green verified twice.**
  `packages/shared/src/docs/__tests__/headroom-doc.test.ts` exists because a docs
  page is the one artifact where nothing fails when it rots. It asserts 26 quoted
  UI strings are *both* present in the page and real values in `en.json`, and
  pins the privacy section's load-bearing facts to their sources
  (`DEFAULT_HEADROOM_BASE_URL`, `HEADROOM_CONFIG_DEFAULTS`).
  - Red 1 — page removed (copied to `/tmp`, restored; no `git stash`, ever, in
    this repo): 0 pass / 1 fail / 1 error.
  - Red 2, the behavioural one — renamed two shipped labels in `en.json`
    (`Expose statistics` → `Show statistics`, `Headroom savings` → `Compression
    savings`): **31 pass / 2 fail**, each failing test naming the exact stale
    string. That is the real failure mode: a control renamed under a page still
    describing it by its old name.
  - Restored: 33 pass / 0 fail.

  **Gates, all run and green:** `bun run typecheck:ci`, `bun run test:shared`
  (3644 pass / 20 skip / 0 fail), `bun run test:server` (196/0),
  `bun run test:webui` (359/0), `bun run test:doc-tools` (19 OK),
  `bun run lint:i18n:parity` (6 locales, 1992 keys), `lint:i18n:sorted`,
  `lint:i18n:coverage` (2097 callsites), `bun run scripts/check-branding.ts`,
  `bun run scripts/check-headroom-boundary.ts`, and the `apps/server` build
  check. `lint:i18n:coverage` — red during SUV-0026 on four `headroomReport*`
  keys — is green now that SUV-0027 has landed. No locale keys were added: a
  docs page uses none.

  Deliberately out and untouched: developer/contributor docs for the extension
  interface (SUV-0030's design doc serves that audience), and any app code — the
  page describes surfaces, it does not add them.

  **Two notes for whoever cuts the PR.** (1) The page names the proxy version
  `0.36.5` in its install command, matching the SUV-0014 pin; the monthly bump
  cadence in that report's §5 should add this page to its update checklist.
  (2) Nothing on this branch has written to
  `apps/electron/resources/release-notes/next.md`, though PLAN-040 has shipped
  user-visible surfaces across SUV-0017/0026/0027. One consolidated Headroom
  entry at PR time is better than fifteen partial ones; flagged rather than
  half-written here.

- `2026-08-27` — **re-verified against primary sources; three evidence defects in
  the page found and corrected.** The prior entry's claims were re-run rather
  than trusted, and the page's every factual assertion re-traced to its source.
  Two of the three defects were interpolated figures — a number typed into prose
  that appears nowhere in the evidence it cites:

  1. **Whole-corpus saving was wrong.** The page claimed *"around 12.5%"*.
     `headroom-benchmark-report.md:47` measures **10.5%** (`balanced`, the best
     of four profiles), at a cost of 47,811 bytes of unrecoverable node output.
     `12.5%` appears nowhere in the report. Corrected, and the byte cost added —
     the saving without its price is the misleading half of that finding.
  2. **The p95 latency range was wrong.** The page claimed *"1.3–1.8 seconds"*.
     The report (§4, `:259`) says *"roughly one call in twenty takes
     **1.4–2.1 seconds**"*. Corrected, and the p50 (`+4.4 to +13.1 ms`) added so
     "negligible at the median" carries its own figure.
  3. **The privacy section overstated the audit's scope.** It said every URL
     literal *"in the published package"* was audited; §3.1 scanned the **12
     non-sourcemap `.js`/`.cjs` files in `dist/`**, and the tarball has 38 files
     (§F1). Narrowed to "the published package's shipped code" — the strongest
     claim §3.1 actually supports. This is the one A2 defect: a sentence the
     audit did not fully support.

  **The guard was extended so an interpolated figure cannot recur.** The test now
  pins the page's measured figures **to the benchmark report** rather than to
  literals — each of `10.5%`, `1.4–2.1 seconds`, `0 of 48`, `240` must appear
  verbatim in *both* documents, plus a negative assertion that neither document
  contains `12.5%` or `1.3–1.8 seconds`. Pinning page→source means a re-benchmark
  that moves a number reds the page too, which a literal assertion would not.

  **Red-then-green, both observed in this session** (not carried over):
  - New guards against the uncorrected page: **33 pass / 5 fail** — all five new
    tests failing, naming `10.5%`, `1.4–2.1 seconds`, `0 of 48`, `240`, and the
    negative check. After correcting the page: **38 pass / 0 fail**, 83 expects.
  - Behavioural red re-run (`en.json` copied to `/tmp`, two shipped labels
    renamed `Expose statistics`→`Show statistics`, `Headroom savings`→
    `Compression savings`; restored by file copy — no `git stash`, ever, in this
    repo): **36 pass / 2 fail**, each failure naming the exact stale string.
    Restored, `git status` clean, **38 pass / 0 fail**.

  **Vorno-side claims verified in code, not from the SUV prose.** The page asserts
  things the vetting report cannot cover, because they are about Vorno:
  `createSdkClient` (`sdk-adapter.ts:357-366`) always passes `baseUrl` explicitly
  (`options.baseUrl ?? DEFAULT_HEADROOM_BASE_URL`), so the SDK's
  `HEADROOM_BASE_URL` env fallback is unreachable by construction, not by policy;
  `DEFAULT_HEADROOM_BASE_URL = 'http://localhost:8787'` (`:66`); the settings
  section exposes exactly four fields (`enabled`, `compressionEngines`,
  `verbosity`, `exposeStats`) and **no base-URL field**; all four carry a
  `SourceBadge` (`HeadroomSettingsSection.tsx:197/214/230/250`) and a
  `ClearOverrideButton` present only while overridden (`:86-102`); config is read
  once into a `readonly` field at agent construction (`base-agent.ts:345`), which
  is what makes "a change applies to sessions started afterwards" true. Mounts
  confirmed at `WorkspaceSettingsPage.tsx:746/749` and `SessionInfoPopover.tsx:160`.
  No `.chat`/`.messages` call site exists in the boundary (F3 unreachable), and
  the boundary gate reports `headroom-ai` imported only by `sdk-adapter.ts`.

  **Gates — actually run this session, output as observed:** `typecheck:ci` clean;
  `test:shared` **3650 pass / 20 skip / 0 fail** (211 files); `test:server`
  **196/0**; `test:webui` **362/0** (45 files); `apps/viewer` share Worker
  **23/0**; `test:doc-tools` **19 OK**; `lint:i18n:parity` (6 locales, 1992 keys),
  `lint:i18n:sorted`, `lint:i18n:coverage` (2097 callsites) all OK;
  `check-branding.ts` ✓ (with a pre-existing stale-allowlist warning for
  `apps/viewer/vite.config.ts`, unrelated); `check-headroom-boundary.ts` ✓;
  server build check bundled 3403 modules. Ten for ten.

  **Two corrections to the prior entry's own numbers,** since this pass exists to
  make the evidence reproducible: it reported the test as *"33 assertions"* (the
  count is now 38 tests / 83 expects) and `test:shared` as *"3644 pass"*. My
  observed 3650 minus the 5 tests added here implies **3645** before this commit,
  one more than the prior entry claimed. Both figures were restated from an
  actual run rather than carried forward.

  Diff is two files — the page and its guard. No app code, no locale keys, no
  other SUV's surface; the out-of-scope developer/extension-interface docs remain
  SUV-0030's.
