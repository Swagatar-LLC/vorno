# Memory

The reference knowledge-graph memory server — a local, persistent store of
entities, relations, and observations. No auth, no account, no network.

## Ask first whether this is the right tool

Vorno already has durable memory: `MEMORY.md` plus per-memory files under the
workspace, loaded into context each session, and project memory for
project-scoped facts. That is usually what a user means by "remember this."

The memory MCP server is worth adding when the user wants a **structured graph** —
entities with typed relations they intend to query and traverse — rather than
prose facts. It is a different shape of storage, not a better one. If the user
says "remember that I prefer X", the built-in memory files are the right answer;
if they say "track which people work on which projects and who reports to whom",
the graph is.

## config.json

```json
{
  "type": "mcp",
  "name": "Memory",
  "slug": "memory",
  "provider": "memory",
  "icon": "🧠",
  "tagline": "Knowledge graph of entities, relations, and observations",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"],
    "authType": "none"
  }
}
```

To control where the graph is stored, set `MEMORY_FILE_PATH` in `env` to an
absolute path. **Do this.** The default location is inside the npx package cache,
which means the user's memory graph can be silently discarded by a cache clear or a
package update:

```json
  "env": { "MEMORY_FILE_PATH": "/Users/me/.vorno-agent/memory-graph.json" }
```

## Validate

```
mcp__session__source_test({ sourceSlug: "memory" })
```

No auth step follows.

## permissions.json (Explore mode)

```json
{
  "allowedMcpPatterns": [
    { "pattern": "read", "comment": "Read the graph" },
    { "pattern": "search", "comment": "Search nodes" },
    { "pattern": "open", "comment": "Open nodes" }
  ]
}
```

Creation and deletion tools stay blocked in Explore mode, which is correct — a
read-only session should not be silently mutating the user's knowledge graph.

## Gotchas

- **The package is still maintained**, but versioning is now calendar-style
  (`2026.7.4`), not semver. A config pinning `0.6.x` is years stale.
- The store is a **single local JSON file**. It is not synced, not backed up, and
  not shared between machines. Tell the user that before they put anything
  important in it.
- Nothing reads this graph automatically. The agent must be told to consult it, so
  the source's `guide.md` should state when to read and when to write — otherwise
  it accumulates entries nobody ever looks at.
- Requires `npx` on PATH.

---

_Verified 2026-08-17 against the `modelcontextprotocol/servers` repository, which
confirms `@modelcontextprotocol/server-memory` is among the actively released
reference servers._
