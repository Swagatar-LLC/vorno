# Brave Search

**Recommended:** Brave's own MCP server, `@brave/brave-search-mcp-server`, over stdio
with an API key.

## The package name changed — do not use the old one

Configs and tutorials widely recommend `@modelcontextprotocol/server-brave-search`.
**That is the retired reference implementation.** It was moved out of the
`modelcontextprotocol/servers` repository when search vendors took ownership of
their own servers, and it is no longer the maintained path. Brave's package is
`@brave/brave-search-mcp-server`, and it has a much larger tool surface.

## config.json

```json
{
  "type": "mcp",
  "name": "Brave Search",
  "slug": "brave-search",
  "provider": "brave",
  "icon": "https://brave.com/static-assets/images/brave-favicon.png",
  "tagline": "Web, news, image, video, and local search",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
    "env": {
      "BRAVE_API_KEY": "…"
    },
    "authType": "none"
  }
}
```

`authType` is `none` because the credential travels in the environment, not through
an auth flow. Nothing to trigger after `source_test`.

## Getting an API key

1. <https://brave.com/search/api/> → **Get API Key**
2. Create an account or sign in, and select a plan. The free plan allows
   **2,000 queries/month**; some tools are Pro-only.
3. Copy the key from <https://api-dashboard.search.brave.com/app/keys>

Alternatives to putting the key in `env`: `BRAVE_API_KEY_FILE` (a path to a file
containing the key — it takes precedence, and is the better choice if the user
would rather not have the key sitting in `config.json`), or the
`--brave-api-key` flag.

## Tools

`brave_web_search`, `brave_local_search`, `brave_news_search`, `brave_image_search`,
`brave_video_search`, `brave_place_search`, `brave_summarizer`, `brave_llm_context`.

## permissions.json (Explore mode)

```json
{
  "allowedMcpPatterns": [
    { "pattern": "search", "comment": "All search operations" },
    { "pattern": "summarizer", "comment": "Summarization is read-only" },
    { "pattern": "llm_context", "comment": "Context retrieval is read-only" }
  ]
}
```

Every tool this server exposes is read-only, so it is safe to allow the full
surface in Explore mode.

## Gotchas

- **Ask whether the user needs this at all.** Vorno already has `WebSearch` and
  `WebFetch`, plus in-app browser tools. Brave is worth adding when the user wants a
  specific search index, structured result objects they can post-process, news or
  image or local-business verticals, or a quota they control. It is not a general
  upgrade over the built-in tools.
- The free tier's 2,000 queries/month is easy to burn through in agent loops. Say
  so if the user plans automated use.
- `--transport stdio` is the default but stating it explicitly avoids ambiguity if
  the user later copies the config somewhere expecting HTTP.
- If run in HTTP mode instead, `BRAVE_MCP_HOST` defaults to `127.0.0.1`. It only
  needs `0.0.0.0` inside a container — do not set that on a desktop.
- Requires `npx` on PATH. Check `node --version` before writing the config.

---

_Verified 2026-08-17 against the `brave/brave-search-mcp-server` README and the
`modelcontextprotocol/servers` repository (which confirms the old package's removal)._
