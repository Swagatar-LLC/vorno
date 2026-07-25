# Vorno Roadmap

This is the curated public roadmap for **Vorno**, a macOS desktop app for AI-native
workflows. It is a high-level summary meant for readers, not a task tracker.

The working plan system — vision, strategic directions, decision records, and the
individual feature plans that drive day-to-day work — lives in [`roadmap/`](roadmap/).
That folder is the source of truth; this file distills it.

Dates and ordering here are **directional, not commitments**. Priorities shift as we
learn. Items move between sections as work ships.

Vorno is a fork of [Craft Agents](https://github.com/lukilabs/craft-agents-oss).
It stays wire-compatible with upstream and versions independently. See
[Relationship to upstream](#relationship-to-upstream) below.

---

## Vision

We are building an **open, extensible shell for AI-native dynamic workspaces** — a
paradigm shell that replaces siloed apps with an open canvas of pluggable modalities,
AI agents, and novel UI. It is multimodal, cross-platform, local-first, and
agent-orchestrated. We start from Craft Agents, an excellent AI-native workflow chat
surface, and grow it toward that paradigm rather than rebuilding from zero.

The bet is a shift in how agentic work is represented. Today even good AI tools treat
conversations as transcripts and tool calls as opaque functions. We believe a session
is a workspace, not a transcript — tool calls, results, and reasoning are first-class
spatial artifacts the user can rearrange, fork, annotate, and zoom into. Skills become
the unit of malleable software: third parties ship not just instructions but new
shapes, tools, and views composed on the same canvas. Agents become observable rather
than opaque — a live, multi-perspective view of agentic work that turns operators into
conductors.

Two principles anchor how we get there. **Local-first by default**: workspaces travel
across devices, work continues offline, and sync is a data structure rather than a
server round-trip. And **strictly additive**: new paradigms enter behind feature flags
as opt-in surfaces alongside the existing chat UX, never as wholesale replacements.
Portable improvements are contributed back upstream. The full statement lives in
[`roadmap/VISION.md`](roadmap/VISION.md).

---

## Long-term directions

Three layered bets, each independently shippable, each enabling the next. Full
statements are in [`roadmap/directions/`](roadmap/directions/).

### The Canvas Session

A session is currently rendered as a vertical scroll of messages, but its underlying
data is already a graph of causally-linked artifacts. Projecting that same event
stream onto a canvas makes every event a shape and every causal link an edge, turning
the conversation into malleable spatial data the user can drag, fork, annotate, and
zoom into. The first version is read-only spectator mode alongside the existing chat,
built by reusing the current event stream rather than rebuilding it. See
[`roadmap/directions/01-canvas-session.md`](roadmap/directions/01-canvas-session.md).

### Skills as Contribution Points

Today a skill is an instruction file; it can inform the agent but cannot extend the
shell. Modeled on VS Code's contribution points, we extend the skill manifest so a
skill can register custom canvas shapes, agent tools, app views, and render blocks —
opening a third-party modality ecosystem without a fork-the-shell tax. The first
increment proves the loop with a single contribution point (custom shapes), then
expands to tools and views with proper sandboxing and capability scoping. See
[`roadmap/directions/02-skill-contributions.md`](roadmap/directions/02-skill-contributions.md).

### The Live Observatory

A dedicated surface that renders in-flight work across all sessions and clients as a
live spatial graph, so agents become something you watch and conduct rather than only
talk to. Sessions appear as swim-lanes, tool calls light up as nodes, and permission
requests float out where you can act on them — synced across devices so you can leave
your desk mid-run and keep watching. It builds directly on the shared shape vocabulary
from the first two directions and the existing multi-client push transport. See
[`roadmap/directions/03-observatory.md`](roadmap/directions/03-observatory.md).

---

## Recently shipped

Feature-framed highlights. Plan references point into the public [`roadmap/`](roadmap/)
folder for detail.

- **Token-usage indicator with thresholds** — a live token-usage display plus
  configurable warning thresholds surfaced in workspace settings (PLAN-002, PLAN-003).
- **Per-session fast mode** — a per-session toggle to trade model depth for speed
  without changing workspace defaults (PLAN-006).
- **Automations reliability** — durable outcome records, missed-fire detection, and
  `onFailure` handling so scheduled automations are observable and recoverable
  (PLAN-017).
- **Workspace inbound webhooks** — per-workspace inbound webhooks backed by an HTTP
  trigger server, letting external systems start and drive work (PLAN-014).
- **Tray server supervision** — the menu-bar tray supervises the background server
  process, with lifecycle visibility and controls (PLAN-012).
- **Production logging and advanced settings** — structured production logging plus an
  advanced-settings surface for operational configuration (PLAN-015).
- **Configurable update feed** — the auto-update feed is configurable, alongside a
  port-0 health-check fix for the local server (PLAN-018).
- **Projects as first-class navigation** — projects are a first-class navigation
  concept, with sessions bound to their project (PLAN-021).
- **WebUI remote access** — reach a workspace from a browser or phone: autostart, tray,
  and port controls; a single-port WebSocket proxy; a clear connection-error screen;
  bind-address control; and a secure Tailscale tunnel for private remote access
  (PLAN-020, PLAN-022, PLAN-005).
- **Headless / Docker server deployment path** — run the server without the desktop
  shell as a standalone deployment unit, including containerized deployment
  (PLAN-013).

---

## In progress / next

- **Hosted workspace server** — a self-hosted server instance that hosts workspaces
  centrally, with the desktop app acting as a thin client and phones connecting via the
  WebUI. Includes server-side source authentication and a non-technical, one-command
  setup path so a single person can stand up their own instance. Tracked as PLAN-023.
- **Protocol evolution** — additive `vorno:*` namespaces layered on top of the
  maintained Craft wire protocol, so fork-specific capabilities extend the contract
  without breaking compatibility with upstream clients.
- **Multi-workspace git-sync conventions** — conventions for syncing workspaces through
  git, GitHub-first with a pluggable design that can extend to GitLab and other
  providers.
- **Continued upstream tracking** — regular syncs from upstream, folding in notable
  features while preserving wire compatibility.

---

## Relationship to upstream

Vorno tracks [lukilabs/craft-agents-oss](https://github.com/lukilabs/craft-agents-oss)
as its upstream. Upstream syncs bring features in, not version numbers; the mapping
between a Vorno version and the last-merged upstream tag is recorded in
[`roadmap/upstream/`](roadmap/upstream/).

Vorno stays **wire-compatible** with upstream — the message-envelope protocol is a
contract, and every sync includes a compatibility audit. Fork-specific capabilities are
added additively rather than by forking the protocol.

Vorno **versions independently** of upstream from 0.11.2 onward. A Vorno version is a
promise about Vorno's own releases, not a mirror of upstream's tags. The rationale is
recorded in
[`roadmap/decisions/0010-independent-vorno-versioning.md`](roadmap/decisions/0010-independent-vorno-versioning.md).
