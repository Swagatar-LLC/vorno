# Craft (documents)

This guide is for **Craft, the document and note-taking app** at
[craft.do](https://www.craft.do) — a third-party product a user may connect as a
source, in the same way they connect Linear or Notion. It has no relationship to
Vorno beyond being one integration among many.

**Recommended:** Craft's official remote MCP server with OAuth.

## config.json

```json
{
  "type": "mcp",
  "name": "Craft",
  "slug": "craft",
  "provider": "craft",
  "icon": "https://www.craft.do/favicon.ico",
  "tagline": "Documents, daily notes, and collections in {user's space}",
  "mcp": {
    "url": "https://mcp.craft.do/my/mcp",
    "authType": "oauth"
  }
}
```

## Authenticate

```
mcp__session__source_oauth_trigger({ sourceSlug: "craft" })
```

A browser window opens on Craft's authorization page. **The user picks which space
to connect and approves.** The grant is space-scoped, so the choice made in that
browser window is the real permission boundary — walk the user through it rather
than letting them click past it.

Connections are managed afterwards from Craft's **Connections** tab, where the user
can see and revoke what has been shared.

## Capabilities

- Search across documents, with tag and date filtering
- Advanced search: regex, timezone-aware date filters
- Daily notes and tasks
- Create, update, and delete documents
- Collections, including schema creation and editing

## permissions.json (Explore mode)

```json
{
  "allowedMcpPatterns": [
    { "pattern": "list", "comment": "List operations" },
    { "pattern": "get", "comment": "Get/read operations" },
    { "pattern": "search", "comment": "Search operations" }
  ]
}
```

Craft's MCP server exposes create, update, and delete tools, so a permissive Explore
config here is a genuine write risk. Keep the read-only patterns above.

## Gotchas

- **`mcp.craft.io` is a different company's product.** Craft.io is a
  product-management tool; its MCP server is `https://mcp.craft.io/mcp` and needs an
  Editor seat plus a personal access key. If the user says "Craft", ask which one
  they mean before building anything — the two are unrelated and easy to confuse.
- **A per-document REST API also exists**, addressed through a share link:
  `https://connect.craft.do/links/{LINK_ID}/api/v1`, enabled per document via
  **Share → Enable API**. Prefer the MCP server; it is the supported, space-scoped,
  officially documented path. Use the REST API only if the user specifically wants
  one shared document exposed without granting space access.
- **The REST API has no official public documentation.** Community projects that
  wrap it report undocumented behaviors — rate limits, inconsistent payload keys,
  silent handling of unanchored inserts. If you must use it, verify each endpoint
  against live behavior and treat any third-party description as unverified.
- `connect.craft.do` is a **production endpoint against real user data.** There is no
  sandbox. Restrict any exploratory calls to reversible operations.

---

_Verified 2026-08-17 against Craft's own MCP documentation
(`support.craft.do/en/integrate/mcp` and `craft.do/imagine/guide/mcp/mcp`). The REST
API notes are from community sources and are **not** vendor-verified — treated as
unconfirmed above._
