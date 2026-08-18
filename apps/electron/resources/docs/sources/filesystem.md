# Filesystem

**Recommended:** Vorno's native `local` source type. Do not add an MCP server for
this — the app already has one, and the agent already has `Read`, `Write`, `Grep`,
`Glob`, and `Bash`.

## config.json

```json
{
  "type": "local",
  "name": "Obsidian Vault",
  "slug": "obsidian",
  "provider": "obsidian",
  "icon": "📓",
  "tagline": "Personal notes vault — markdown, daily notes, project pages",
  "local": {
    "path": "/Users/me/Documents/ObsidianVault"
  }
}
```

`path` must be absolute. `~` is not expanded — write the full path.

Name the source after **what the folder is**, not after "filesystem". A source
called `obsidian` with a tagline describing the vault gives the agent far more to
work with in future sessions than one called `local-files`.

## Validate

```
mcp__session__source_test({ sourceSlug: "obsidian" })
```

This checks the path exists and is readable. There is no auth step.

## permissions.json (Explore mode)

```json
{
  "allowedBashPatterns": [
    { "pattern": "^(ls|cat|head|tail|grep|find|tree|wc|file|stat)\\s", "comment": "Read-only commands" }
  ]
}
```

Add only what the user's workflow needs. `rg` and `fd` are worth adding if
installed — they are read-only and much faster on large trees.

## Gotchas

- **A `local` source is a labelled pointer, not a sandbox.** It tells the agent
  "this folder matters and here is what it contains"; it does not prevent access to
  the rest of the disk. Explore-mode permission rules are the actual boundary. Do
  not describe it to the user as a restriction.
- **macOS TCC will block some paths silently-ish.** Desktop, Documents, and
  Downloads are protected: the first access triggers a system permission prompt,
  and if the user dismissed it once, later reads fail with a bare `EPERM` and no new
  prompt. Fix in System Settings → Privacy & Security → Files and Folders. iCloud
  Drive paths (`~/Library/Mobile Documents/…`) additionally may not be downloaded
  locally yet — a file can exist as a stub with no contents.
- **Write a real `guide.md`.** For a local source this matters more than for any
  other type, because there is no tool schema to describe the contents. Say what
  the folder holds, how it is organized, what the file naming means, and what not
  to touch.
- If the user wants a folder **searchable but not writable**, that is entirely a
  `permissions.json` decision plus running in Explore mode. There is no read-only
  flag on the source itself.

## When to use the MCP filesystem server instead

Almost never. `@modelcontextprotocol/server-filesystem` (currently versioned
calendar-style, e.g. `2026.7.4`) is the reference server and takes explicit allowed
directories as arguments:

```json
{
  "type": "mcp",
  "provider": "filesystem",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents/Vault"],
    "authType": "none"
  }
}
```

The one case where this is worth it: the user explicitly wants filesystem access
constrained by a process boundary rather than by permission rules. Otherwise it
duplicates built-in tools with a slower, more brittle path.

---

_Verified 2026-08-17 against the `modelcontextprotocol/servers` repository (package
still actively released) and Vorno's `local` source schema in `../sources.md`._
