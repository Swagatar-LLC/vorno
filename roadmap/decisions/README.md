# Decisions

Architecture Decision Records (ADRs). Numbered, immutable once accepted, superseded by new ADRs.

## When to write one

- A load-bearing architectural commitment we'd need to revisit deliberately.
- A choice between two or more viable options that future contributors should understand the *why* of.
- A protocol/wire commitment that has external implications (e.g., upstream compatibility).

## Format

`NNNN-short-kebab-title.md` — four-digit zero-padded ID, kebab-case slug.

Use [`_template.md`](_template.md) as a starting point.

## Lifecycle

```
proposed ──▶ accepted ──▶ (superseded by NNNN)
                │
                └──▶ rejected
```

Status is in frontmatter. **Never edit an `accepted` ADR's substance** — supersede with a new one. Cosmetic fixes (typos, broken links) are fine.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](0001-fork-relationship-with-upstream.md) | Fork relationship with upstream | accepted |
| [0002](0002-roadmap-folder-status-workflow.md) | Roadmap-as-files, plans-as-folder-status | accepted |
| [0003](0003-canvas-as-paradigm-direction.md) | Canvas as the paradigm direction | accepted |
| [0004](0004-sessionevent-extensible-union-and-renderer-mirroring.md) | SessionEvent extensible union & renderer mirroring | accepted |
| [0005](0005-fork-owned-config-dir-vorno-agent.md) | Fork-owned config dir `~/.vorno-agent` + one-time copy migration | accepted |
| [0006](0006-pause-vorno-align-0.11-drop-activity-pane.md) | Pause VORNO, align to 0.11.x, drop fork Activity pane | accepted |
| [0007](0007-trigger-server-host-adapter.md) | Trigger-server host adapter — embedded Electron host, Bun standalone host | accepted |
| [0008](0008-apps-server-headless-deployment-unit.md) | apps/server is the fork's headless deployment unit; Docker primary | proposed |
| [0009](0009-vorno-rebrand-appid-release-feed-signing.md) | Vorno rebrand — appId `co.swagatar.vorno`, public update feed, parameterized signing | accepted |
| [0010](0010-independent-vorno-versioning.md) | Vorno versions independently of upstream from 0.11.2 onward | accepted |
| [0011](0011-public-repo-rename-and-internal-corpus-split.md) | Public source repo, rename to `Swagatar-LLC/vorno`, private internal corpus split | accepted |
| [0012](0012-additive-vorno-protocol-namespace.md) | Additive `vorno:*` protocol namespace atop maintained Craft wire compatibility | accepted |
| [0013](0013-hosted-workspace-authn-authz-architecture.md) | Hosted workspace server AuthN/AuthZ — single-principal now, multi-user-ready seams, three trust zones | accepted |
| [0014](0014-review-workbench-store-anchors-and-vorno-workbench-namespace.md) | Review workbench — workspace review store, quote+hash anchors, `vorno:workbench:*` namespace | accepted |
| [0015](0015-two-plane-artifact-surface-architecture.md) | Two-plane architecture — artifact plane + surface plane | accepted |
| [0016](0016-artifact-uri-scheme-and-open-type-registry.md) | Artifact plane addressing — `vorno-artifact://` URI scheme and open type registry | accepted |
| [0017](0017-standards-stack-artifact-packaging-distribution.md) | Standards stack — Agent Skills + OCI/ORAS + Sigstore | accepted |
| [0018](0018-storage-provider-seam-and-pure-admissibility.md) | Artifact storage-provider seam and pure admissibility predicate | accepted |
| [0019](0019-storage-root-config-schema-and-provider-kind-namespace.md) | Storage-root config schema and provider-kind namespace | accepted |
