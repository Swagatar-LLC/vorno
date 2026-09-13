---
id: SUV-0061
title: Brand and publish Pages documentation
status: in-progress
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-13
related: [SUV-0057, SUV-0060, SUV-0063]
blocked-by: []
---

# SUV-0061 — Brand and publish Pages documentation

## Goal

Ship one accurate Vorno Pages guide to bundled and online documentation, with
branding, prompt, and release-note checks that catch imported Craft defaults.

## Scope

- Rewrite the bundled Pages guide for actual Vorno settings, grant management,
  callbacks, sharing, CSP limits, privacy/retention disclosure, and compatibility
  names that must remain unchanged.
- Replace Craft-owned default domains with the Vorno Pages endpoint and remove
  wrong `~/.craft-agent` paths from LLM-visible descriptions using `DOC_REFS`.
- Extend Pages-specific branding scans to bundled markdown, server-core Pages
  paths, and config-directory references; preserve the existing narrow scan
  boundaries.
- Own Pages Settings/navigation empty states, while SUV-0060 owns the public
  Worker shell. Keep bundled docs as online-doc source and add an attributed
  Pages release-note entry after SUV-0063's site manifest prerequisite lands.

## Acceptance

- [x] No Pages default points at Craft infrastructure; immutable bridge/env/store
      identifiers are preserved and documented as compatibility contracts.
- [x] The bundled guide syncs under `~/.vorno-agent/docs/pages.md`, and system
      prompts/tool descriptions direct agents to that actual guide.
- [x] Branding tests fail for an upstream URL in Pages docs or Pages server-core
      code and for a forbidden `.craft-agent` tool-description path.
- [x] Pages Settings and navigation empty states are Vorno-branded, describe the
      off-by-default/workspace-capability state accurately, and have i18n parity,
      sorted, and coverage checks.
- [x] Documentation states the actual host consent, activation experiment,
      callbacks, sharing, privacy/retention, public-action, and
      no-scripted-network-egress limits without overclaiming.
- [ ] The bundled source publishes the Pages guide and attributed changelog after
      SUV-0063's independently owned site manifest prerequisite is merged.

## Status log

- `2026-09-10` — created in `planned/`; shares online-doc prerequisites with
  SUV-0063 but owns the Vorno repository documentation PR.
- `2026-09-13` — moved from `planned` to `in-progress`. Five of six acceptance
  items close in this PR; the sixth is held open on purpose and is not this
  SUV's to close alone — see below.

  **What the guide now states, and what it deliberately does not.** The bundled
  guide gained the availability contract it never had: Pages is a persisted
  per-workspace capability defaulting to off, `PAGES_DISABLED` means the host
  refused rather than that the call should be retried, cleanup survives the
  switch being turned back off, and sharing is a *second* gate (build flag plus
  a configured Vorno endpoint) that a default install does not satisfy. Grant
  expiry was wrong and is corrected against `pages/storage.ts`: 7 days default
  and 30 maximum for `api`/`mcp`, 24 hours and 7 days for the privileged
  `script`/`session` kinds — the old text stated a flat 30 days. Activation is
  described as the host-minted, lease- and digest-bound, ≤10s single-use ticket
  it actually is, matching SUV-0065's recorded finding that no browser signal
  attributes a gesture to the frame. The sharing section names
  `pages.vorno.ai`, the public shell's "published by a Vorno user, not by
  Vorno" disclaimer, the per-document CSP, the 5/2/10 MB limits, and the
  8-character password floor. The claim stays **no scripted network egress**
  with frame self-navigation named as a residual, because the weaker true claim
  is the one an agent can repeat to a user without misleading them.

  **Retention is stated as approved policy, not as deployed behavior.** Jeff's
  decision — content retained at most 30 days from its last **successful
  content or password update**, unpublish and revocation immediate, physical
  deletion immediate/best-effort with retry, operational logs at most 90 days —
  is now disclosed in the guide. Jeff clarified on `2026-09-13` that setting,
  changing, or clearing the viewer password is a real update and restarts the
  full window; the guide says so explicitly rather than leaving a user to infer
  that only republished content counts. The Worker will re-put retained content
  and snapshot on a password change so physical object age matches the stated
  window, which is SUV-0069's to implement. The guide
  does **not** say the service enforces it, because no deployment has happened
  and TTL enforcement is SUV-0069's. A reader is pointed back at the
  availability check as the authority on what is reachable today.

  **Compatibility names are documented as contracts rather than quietly left
  looking stale.** `craft-pages/v1`, `pages/{slug}/`, the `CRAFT_*` run
  environment, `CRAFT_PAGES_SHARE_API_URL`, and
  `@craft-agent/shared/pages/data-store` get a table saying they stay
  Craft-named on purpose. Without it the next agent or contributor reads them as
  a missed rebrand and "fixes" a wire contract.

  **The dead config-dir path, and the one the gate found.** Two LLM-visible
  strings named `~/.craft-agent/docs/pages.md`, a directory that does not exist
  in a Vorno install. `session-tools-core` cannot import `DOC_REFS` (shared
  depends on it), so the base strings now name the guide without a path and
  `shared/agent/session-scoped-tools.ts` appends `DOC_REFS.pages` for the Claude
  path, reusing the existing `config_validate`/`skill_validate` enrichment
  pattern; the MCP/Pi path resolves it through the system prompt's
  Configuration Documentation table, which already carried `DOC_REFS.pages`.
  Adding the rule immediately surfaced a third occurrence nobody had reported —
  `handlers/mermaid-validate.ts` was telling agents to consult
  `~/.craft-agent/docs/mermaid.md` on every parse failure — fixed the same way.

  **The gate is now mutation-tested, because a passing gate proves nothing.**
  `check-branding.ts` gained `TARGETED_SCANS`: named surfaces the general pass
  deliberately cannot reach (`.md` is not a scanned extension, `server-core` is
  out of `SCAN_ROOTS`, and `apps/electron/resources/` carries a blanket
  allowlist entry). None of those general exclusions were widened. A targeted
  rule is exempted only by an allowlist entry naming its rule id, so the blanket
  resources entry cannot silently disarm the scan of the bundled guide, while
  `publisher.ts`'s reviewed `upstream-domain` exception still holds. A missing
  targeted path now fails the gate rather than disarming it. `scanFile` is
  exported and `scripts/check-branding.test.ts` (13 tests, wired into the
  branding CI job) injects the exact strings the rules exist to catch and
  asserts the compatibility identifiers are still *not* caught.

  **Navigation empty state.** Routing to Pages with the capability off rendered
  an empty `Panel` — indistinguishable from a broken screen. It now uses the
  same `EntityListEmptyScreen` as its sibling navigators, names the workspace
  switch, and links to Workspace settings. Three keys across seven locales;
  parity, sort, and coverage gates green. No `docKey`/"Learn more" button was
  added: `vorno.ai/docs/pages` does not exist until SUV-0063's site manifest
  lands, and shipping a button to a 404 is the overclaim this SUV exists to
  remove.

  **Verified at runtime, not by build:** with a throwaway `CRAFT_CONFIG_DIR`,
  `initializeDocs()` writes the rewritten guide to `<CONFIG_DIR>/docs/pages.md`
  — the exact string `DOC_REFS.pages` resolves to — and the generated MCP JSON
  schema plus the Claude-path description were read back to confirm the dead
  path is gone and the resolved path is present.

  **Held open deliberately.** Acceptance item 6 stays unticked: the attributed
  release-note entry lands here, but publication of the Pages guide and
  changelog to `vorno.ai` needs SUV-0063's site manifest, which is independently
  owned and unmerged. Claiming it now would be the overclaim this SUV removes
  everywhere else.

  **Review round (PR #209, Greptile 4/5 → 5/5).** Five findings, all verified
  against the code before anything changed; none were rebutted. One was a P1 my
  own design created: the base tool descriptions deferred to the system prompt's
  documentation table, and `packages/session-mcp-server` ships **no system
  prompt** — so removing the dead `~/.craft-agent` path left a Codex or external
  MCP agent pointed at something it can never read. Fixed at the root rather
  than per-consumer: the base text names the guide without pointing anywhere,
  and one exported renderer (`pagesGuideReference`) appends the resolved path on
  all three paths — Claude and Pi via `DOC_REFS`, the standalone server via the
  config dir it already resolves for its feedback writer — so the three cannot
  drift. The other four: the inherited "1 mutating action at a time" was wrong
  (`PAGE_ACTION_MAX_CONCURRENT_MUTATING_PER_LEASE` is **2**, with a bounded
  queue of 4 and per-page/per-workspace start ceilings the old text omitted
  entirely); the refactor had started utf8-decoding every file under the scan
  roots before `scanFile` discarded it by extension, including an 11 MB `.tiff`
  (extension filtering moved back ahead of the read; the gate runs in 0.15s);
  markdown handling skipped only the line opening an HTML comment, so a legacy
  endpoint commented out across several lines would have failed CI for invisible
  text (replaced with a comment-span strip, which is also right in the other
  direction — visible text sharing a line with a comment is still scanned); and
  the new empty state flashed "Pages is off" on every workspace where it is on,
  because `pagesEnabled` starts `false` and the capability lookup is async
  (`usePages` now reports `pagesCapabilityResolved`, and a *failed* lookup counts
  as resolved-and-unavailable — the host is the authority and it did not say
  yes). CI 12/12 green on `305cc36f`.

  **Residual for the policy owner, not folded in:** `ADR-0033` §7, PLAN-052's
  Owner gate, and `workers/pages/README.md` item 5 still record retention as
  *pending Jeff* under the older proposal (retain until unpublish, logs ≤30
  days). The approved policy differs on both counts. Those are governance and
  deployment-gate records owned by the policy/deployment SUVs (0063 and 0069),
  and SUV-0069's branch will rewrite the Worker README item; editing them from
  the documentation SUV would be scope creep with a guaranteed conflict.
