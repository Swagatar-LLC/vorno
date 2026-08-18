# Slack

Slack is the hardest of the common services to set up. Read this whole page before
promising the user anything — both available paths have a real prerequisite, and
neither works from a stock install with no preparation.

## Path A — the built-in Slack OAuth flow (`source_slack_oauth_trigger`)

**Blocked unless Vorno was launched with `SLACK_OAUTH_CLIENT_ID` and
`SLACK_OAUTH_CLIENT_SECRET` set.** There is no per-source config field for these —
unlike Google, where the user can put their own client ID in `config.json`. Without
the environment variables the trigger returns "Slack OAuth not configured".

Check before offering this path. If the variables are absent, say so plainly rather
than starting a flow that cannot finish.

Why it works this way: **Slack requires an HTTPS redirect URI and rejects
`http://localhost`**, so this flow cannot use the local callback server the way
Google and Microsoft do. It routes through a hosted HTTPS relay that bounces back
to the local port. That relay is upstream-hosted infrastructure, which is a second
reason to prefer Path B where possible.

Built-in scope sets, if you do use this path (`slackService` in the source config):

| Set | Scopes |
|---|---|
| `messaging` | `chat:write` |
| `channels` | `channels:read`, `channels:history`, `groups:read`, `groups:history` |
| `users` | `users:read`, `users:read.email` |
| `files` | `files:read`, `files:write` |
| `full` | all of the above plus `reactions:read`, `reactions:write`, `im:read`, `im:history`, `im:write`, `mpim:read`, `mpim:history`, `search:read` |

`full` is the default when no service is named. **Do not accept the default
silently** — it grants DM history and workspace search. Name the set that matches
what the user asked for.

## Path B — Slack's official remote MCP server

Slack shipped an official MCP server, generally available since 17 February 2026:

- **URL:** `https://mcp.slack.com/mcp`
- **Transport:** JSON-RPC 2.0 over Streamable HTTP
- **Auth:** user-token OAuth. Authorization endpoint
  `https://slack.com/oauth/v2_user/authorize`, token exchange
  `https://slack.com/api/oauth.v2.user.access`.

```json
{
  "type": "mcp",
  "name": "Slack",
  "slug": "slack",
  "provider": "slack",
  "icon": "https://a.slack-edge.com/80588/marketing/img/meta/favicon-32.png",
  "tagline": "Workspace search, channels, and messages",
  "mcp": {
    "url": "https://mcp.slack.com/mcp",
    "authType": "oauth"
  }
}
```

**The real prerequisite:** Slack requires a *registered Slack app with a fixed app
ID*, and only directory-published apps or internal apps may use MCP. Workspace
admins approve and manage MCP client connections, and see which MCP server domains
each app requests. So this is not a "click approve in the browser" flow the way
Linear is — an admin has to have allowed it.

Practical consequence: **verify with the user whether their workspace admin has
approved an MCP client** before building the source. If not, that is an
organizational step, not something the agent can do. Say so and offer the in-app
browser as an immediate fallback for one-off tasks.

Known client-side snag: some MCP clients send no `scope` parameter, which
`mcp.slack.com` rejects. If authorization fails with a scope error, that is the
cause.

## Scopes (Path B), per tool

These are user-token scopes. Request the row you need, not the table.

| Tool | Scopes |
|---|---|
| Search messages / channels | `search:read.public`, `search:read.private`, `search:read.mpim`, `search:read.im` |
| Search files | `search:read.files` |
| Read files | `files:read` |
| Search emoji | `emoji:read` |
| Search users | `search:read.users` |
| Send message | `chat:write` |
| Read channel / thread | `channels:history`, `groups:history`, `mpim:history`, `im:history` |
| Create conversation | `channels:write` (public), `groups:write` (private), `im:write` (DM), `mpim:write` (group DM) |
| Add reactions | `reactions:write` |
| Canvas read / write | `canvases:read`, `canvases:write` |
| User profile / email | `users:read`, `users:read.email` |
| List channel members | `channels:read`, `groups:read`, `mpim:read` |

Slack derives the available tool set from the scopes granted at install, so a
read-only grant produces a read-only tool list — a good default for a first
rollout.

**Public channels only is a real, narrower option.** `search:read.public` +
`channels:history` + `channels:read` covers "find things in our team channels"
without touching DMs or private groups. Offer it before anything with `im:` or
`groups:` in it.

## Gotchas

- **A bot token (`xoxb`) cannot search messages.** Message search requires a user
  token (`xoxp`) with the `search:read.*` scopes. This is the most common
  first-time surprise.
- Canvases require a paid Slack plan. The MCP server itself is free; capability
  follows the workspace's plan.
- The agent acts as the authorizing user and can read exactly what that user can
  read — no more, and no less. Say this out loud when a user asks whether it can
  see private channels.

## When to skip the source entirely

If the user wants one export, one message, or one search and Slack auth is not
already working, use the in-app browser. Slack setup has more moving parts than
almost any other service here and it is often not worth it for a one-off.

---

_Verified 2026-08-17 against Slack's developer docs (`docs.slack.dev/ai/slack-mcp-server/`)
and against Vorno's own `packages/shared/src/auth/slack-oauth.ts` for the built-in flow's
requirements._
