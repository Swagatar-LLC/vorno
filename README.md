# Vorno

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Vorno is a macOS desktop app for working with AI coding and knowledge agents. It provides a multi-session inbox, a document-centric (rather than terminal-centric) workflow, and no-fluff connections to APIs, MCP servers, and local files — so you can run many agent sessions in parallel, connect them to the tools you already use, and keep long-running work organized. Vorno runs Claude (via the Claude Agent SDK) and other providers side by side, and adds server/headless deployment, remote access, inbound webhooks, and automation reliability features on top of its upstream foundation. It is developed by Swagatar LLC.

## Relationship to Craft Agents

Vorno is an independent fork of [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss) by Craft Docs Ltd. The core application — the agent runtime, session model, sources system, and much of the UI — comes from their open-source work, and we're grateful for it.

Vorno is maintained by Swagatar LLC as a long-term fork with its own feature roadmap. It deliberately maintains **wire compatibility** with upstream: key prefixes (`craft_sk_*`), RPC namespaces (`craft-fork:*`), environment variables (`CRAFT_*`), and on-disk migration paths (`~/.craft-agent`) are kept identical on purpose, and are never renamed. Vorno tracks upstream and pulls in improvements over time; where a fix is relevant to upstream, we aim to contribute it back.

Vorno is not affiliated with or endorsed by Craft Docs Ltd. See [TRADEMARK.md](TRADEMARK.md).

## Installation

Vorno is distributed as a signed DMG on GitHub Releases.

1. Go to the [Vorno releases page](https://github.com/Swagatar-LLC/vorno-releases/releases).
2. Download the latest `.dmg`.
3. Open it and drag Vorno to your Applications folder.

**Requirements:** macOS on Apple Silicon (arm64). That is the only supported platform for now.

## Features

Vorno inherits the core Craft Agents feature set and adds several areas of its own.

### Core (from upstream)

- **Multi-session inbox** — desktop app with session management, status workflow, and flagging
- **Streaming agent experience** — streaming responses, tool visualization, real-time updates
- **Multiple LLM connections** — Anthropic, Google AI Studio, ChatGPT Plus (Codex OAuth), GitHub Copilot, OpenAI, and any OpenAI-/Anthropic-compatible endpoint (OpenRouter, Ollama, etc.)
- **Sources** — connect MCP servers, REST APIs (Google, Slack, Microsoft), and local filesystems, often just by asking the agent to add them
- **Permission modes** — three-level system (Explore, Ask to Edit, Auto) with customizable rules
- **Skills** — specialized agent instructions stored per-workspace
- **Dynamic status system** — customizable session workflow states
- **File attachments** — drag-drop images, PDFs, and Office documents with auto-conversion
- **Themes** — cascading themes at app and workspace levels
- **Multi-file diff** — VS Code-style view of all file changes in a turn

### Added in Vorno

- **Inbound webhooks + HTTP trigger server** — trigger sessions and automations from external HTTP requests
- **Headless / Docker server deployment** — run Vorno as a server on a remote machine, with the desktop app as a thin client
- **WebUI remote access** — a single-port proxy plus optional Tailscale tunnel for reaching your server from anywhere
- **Tray server supervision** — start, stop, and monitor a local server from the system tray
- **Automations reliability** — outcome records and missed-fire detection so scheduled and event-driven automations are auditable and don't silently drop
- **Production logging** — structured, persistent logs suitable for server deployments
- **Projects-first navigation** — organize work around projects
- **Per-session fast mode** — trade thoroughness for speed on a per-session basis
- **Token-usage indicators** — see token consumption as you work

## Building from Source

Vorno is a Bun-based monorepo.

**Prerequisites:** [Bun](https://bun.sh/), and Node.js 18+ for some tooling.

```bash
git clone https://github.com/Swagatar-LLC/vorno.git
cd vorno
bun install
bun run electron:start      # build and launch the desktop app
```

For hot-reload development:

```bash
bun run electron:dev
```

Type-checking across all packages:

```bash
bun run typecheck:all
```

Some OAuth integrations (Slack, Microsoft) require credentials baked into the build. Copy `.env.example` to `.env` and fill in what you need. Google OAuth credentials are provided per-source by the user rather than baked in.

## Configuration

Configuration is stored at `~/.craft-agent/` (this path is retained from upstream for on-disk compatibility):

```
~/.craft-agent/
├── config.json              # Main config (workspaces, LLM connections)
├── credentials.enc          # Encrypted credentials (AES-256-GCM)
├── preferences.json         # User preferences
├── theme.json               # App-level theme
└── workspaces/
    └── {id}/
        ├── config.json      # Workspace settings
        ├── sessions/        # Session data (JSONL)
        ├── sources/         # Connected sources
        ├── skills/          # Custom skills
        └── statuses/        # Status configuration
```

## Roadmap

Vorno's direction and planned work live in [ROADMAP.md](ROADMAP.md), with supporting material (visions, decisions, and detailed plans) in the [`roadmap/`](roadmap/) directory.

## License

Vorno is licensed under the Apache License 2.0 — see the [LICENSE](LICENSE) file for details.

This project uses the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which is subject to [Anthropic's Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms).

## Trademark

"Vorno" and the Vorno logo are used by Swagatar LLC to identify this project. "Craft" and "Craft Agents" are trademarks of Craft Docs Ltd. (upstream). See [TRADEMARK.md](TRADEMARK.md) for details.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

To report a security vulnerability, see [SECURITY.md](SECURITY.md).

## Support

Questions or issues? Contact support@swagatar.co or open an issue on GitHub.
