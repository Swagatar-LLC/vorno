---
id: SUV-0061
title: Brand and publish Pages documentation
status: planned
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
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

- [ ] No Pages default points at Craft infrastructure; immutable bridge/env/store
      identifiers are preserved and documented as compatibility contracts.
- [ ] The bundled guide syncs under `~/.vorno-agent/docs/pages.md`, and system
      prompts/tool descriptions direct agents to that actual guide.
- [ ] Branding tests fail for an upstream URL in Pages docs or Pages server-core
      code and for a forbidden `.craft-agent` tool-description path.
- [ ] Pages Settings and navigation empty states are Vorno-branded, describe the
      off-by-default/workspace-capability state accurately, and have i18n parity,
      sorted, and coverage checks.
- [ ] Documentation states the actual host consent, activation experiment,
      callbacks, sharing, privacy/retention, public-action, and
      no-scripted-network-egress limits without overclaiming.
- [ ] The bundled source publishes the Pages guide and attributed changelog after
      SUV-0063's independently owned site manifest prerequisite is merged.

## Status log

- `2026-09-10` — created in `planned/`; shares online-doc prerequisites with
  SUV-0063 but owns the Vorno repository documentation PR.
