# Linear

**Recommended:** the official Linear remote MCP server with OAuth. This one works
cleanly end to end — no environment variables, no relay, no PAT.

## config.json

```json
{
  "type": "mcp",
  "name": "Linear",
  "slug": "linear",
  "provider": "linear",
  "icon": "https://linear.app/static/favicon.svg",
  "tagline": "Issue tracking, projects, and cycles",
  "mcp": {
    "url": "https://mcp.linear.app/mcp",
    "authType": "oauth"
  }
}
```

**If the user wants read-only access, use the read-only endpoint instead:**

```json
  "mcp": { "url": "https://mcp.linear.app/mcp/readonly", "authType": "oauth" }
```

Linear enforces this server-side, which is strictly stronger than Vorno's
`permissions.json` (that only gates Explore mode). Ask which one they want before
writing the config — switching later means re-authorizing.

## Authenticate

```
mcp__session__source_oauth_trigger({ sourceSlug: "linear" })
```

Linear supports OAuth 2.1 with dynamic client registration, so there is nothing to
register in Linear first — the browser opens, the user approves, done. Vorno's MCP
OAuth flow uses a `http://localhost:<port>/callback` redirect, which Linear accepts.

Alternatively the server accepts a Linear API key or OAuth token passed directly as
`Authorization: Bearer <token>`. Use that only for non-interactive setups; the
interactive flow is better because the grant is revocable from Linear's side.

Requesting only the `read` OAuth scope against the standard `/mcp` endpoint is
equivalent to using `/mcp/readonly`.

## Tools

Find, create, and update issues, projects, comments, project milestones, project
updates, project labels, initiatives, and initiative updates. Issues carry a
`branchName` field — useful when the user wants a branch checked out for an issue.

The MCP server is available on **every** Linear plan, including free, and mirrors
the permissions of the authorizing account.

## permissions.json (Explore mode)

```json
{
  "allowedMcpPatterns": [
    { "pattern": "list", "comment": "List operations" },
    { "pattern": "get", "comment": "Get/read operations" },
    { "pattern": "search", "comment": "Search operations" },
    { "pattern": "find", "comment": "Find operations" }
  ]
}
```

## Gotchas

- **Do not use `https://mcp.linear.app/sse`.** It is a deprecated fallback for
  clients without Streamable HTTP support. Vorno supports Streamable HTTP; use
  `/mcp`. Configs copied from the original May 2025 announcement point at `/sse`.
- **Do not use `https://mcp.linear.app` bare.** Include the `/mcp` path.
- **Multi-workspace:** one authorization binds one workspace. Reconnecting does
  not switch workspaces. A user who needs two Linear workspaces needs two sources
  with different slugs, authorized separately.
- Community servers (`jerhadf/linear-mcp-server` and similar) are deprecated;
  their own authors point at the official endpoint.

---

_Verified 2026-08-17 against Linear's official docs at `linear.app/docs/mcp`._
