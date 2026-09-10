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

Ship one accurate Vorno Pages guide to both bundled docs and vorno.ai, with
branding, prompt, and release-note checks that catch imported Craft defaults.

## Scope

- Rewrite the bundled Pages guide for actual Vorno settings, callbacks,
  sharing, CSP limits, privacy/retention disclosure, and compatibility names
  that must remain unchanged.
- Replace Craft-owned default domains with the Vorno Pages endpoint and remove
  wrong `~/.craft-agent` paths from LLM-visible descriptions using `DOC_REFS`.
- Extend Pages-specific branding scans to bundled markdown, server-core Pages
  paths, and config-directory references; preserve the existing narrow scan
  boundaries.
- Keep bundled docs as the source for online docs and make an ungrouped shipped
  guide a vorno-site build failure; add an attributed Pages release-note entry.

## Acceptance

- [ ] No Pages default points at Craft infrastructure; immutable bridge/env/store
      identifiers are preserved and documented as compatibility contracts.
- [ ] The bundled guide syncs under `~/.vorno-agent/docs/pages.md`, and system
      prompts/tool descriptions direct agents to that actual guide.
- [ ] Branding tests fail for an upstream URL in Pages docs or Pages server-core
      code and for a forbidden `.craft-agent` tool-description path.
- [ ] i18n parity/sorted/coverage pass for Pages and workspace-setting strings.
- [ ] vorno-site fails a build for an ungrouped shipped guide and publishes the
      Pages guide/changelog from the tagged source after SUV-0063 lands.
- [ ] Documentation states the actual activation, callback, privacy, retention,
      public-action, and no-scripted-network-egress limits without overclaiming.

## Status log

- `2026-09-10` — created in `planned/`; shares online-doc prerequisites with
  SUV-0063 but owns the Vorno repository documentation PR.
