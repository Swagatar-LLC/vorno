---
id: ADR-0034
title: Decision settings follow the executing host
status: accepted
date: 2026-10-02
supersedes: []
superseded-by: []
---

# ADR-0034: Decision settings follow the executing host

## Context

The decision model resolves configuration and provider credentials in the host process that runs a session. These settings and vault entries are host-global, not workspace-scoped. With upstream v0.13.6's local-only Electron routing, the settings UI for a remote workspace edits the desktop's configuration while its sessions use the remote host's configuration. Upstream v0.14.0 makes all seven decision RPCs remote-eligible.

Routing is not authorization. The shared RPC registry already registers these handlers on the headless server. Its authenticated token or WebUI cookie represents owner-wide access, not per-workspace roles. The handlers ignore workspace context, as do comparable host-global LLM connection controls. Keeping a channel local-only in Electron does not block a direct remote RPC caller.

## Decision

Adopt upstream's remote-eligible routing for all seven `decisions:*` RPCs. Settings and credential operations address the host running the selected workspace's sessions. Authenticated remote users administer that host's decision layer across all its workspaces.

Jeff explicitly approved this policy on 2026-10-02. Do not infer workspace-level credential isolation or introduce a role system through a routing change.

Preserve the fork's existing protections: reused keys bind to provider endpoints, per-call tests cannot redirect stored credentials to an unsaved endpoint, and local-server probes use the saved URL without following redirects. Decision audit records must not persist arbitrary state, free-form error text, or caller-supplied identifiers in plaintext.

## Consequences

### Positive

- Remote settings address the same configuration and vault that remote sessions use.
- Connection selection and decision settings use the same host.

### Negative

- A remote settings change affects all workspaces on that host. The current authentication model does not provide tenant or workspace-specific administration.

### Neutral

- The model layer and new automatic features remain opt-in. This routing decision does not enable them.
- Restricting remote configuration access would require a separate server-side authorization design, not a return to local Electron routing.

## Alternatives considered

- Keep local-only routing and call remote decision configuration unsupported. Rejected because it retains the host mismatch without reducing direct remote RPC authority.
- Add per-workspace roles and credential isolation in this merge. Rejected as a separate architecture change beyond the upstream integration.

## References

- [Upstream compatibility audit](../upstream/compatibility.md).
- Upstream v0.14.0, `73bd9c2a`.
- PR #230 credential and audit safeguards.
- `packages/shared/src/protocol/routing.ts`, `packages/server-core/src/handlers/rpc/decisions.ts`, and `packages/shared/src/decisions/resolve.ts`.
