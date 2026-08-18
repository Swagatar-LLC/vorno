# Microsoft Teams

**Read [microsoft.md](./microsoft.md) first.** Microsoft OAuth requires the
`MICROSOFT_OAUTH_CLIENT_ID` environment variable and an Entra app registration —
neither is set up by default, and the source cannot authenticate without them.

Teams has the most organizational friction of any service here. Read the *Gotchas*
before telling the user this will work.

## config.json

```json
{
  "type": "api",
  "name": "Microsoft Teams",
  "slug": "teams",
  "provider": "microsoft",
  "icon": "https://statics.teams.cdn.office.net/evergreen-assets/icons/favicon.ico",
  "tagline": "Chats, channels, and messages in {user's Teams}",
  "api": {
    "baseUrl": "https://graph.microsoft.com/v1.0/",
    "authType": "oauth",
    "microsoftService": "teams",
    "testEndpoint": { "method": "GET", "path": "me" }
  }
}
```

## Scopes

Vorno's `teams` set: `Chat.ReadWrite`, `ChannelMessage.Send`, `User.Read`,
`offline_access`.

| Delegated permission | Grants |
|---|---|
| `Chat.Read` | Read the user's 1:1 and group chat messages |
| `Chat.ReadWrite` | Read and send chat messages |
| `ChannelMessage.Read.All` | Read channel messages in teams the user is in |
| `ChannelMessage.Send` | Post to channels |
| `Team.ReadBasic.All` | List the user's teams |
| `Channel.ReadBasic.All` | List channels in those teams |

Note that Vorno's default set can **send** to channels but cannot **read** them —
`ChannelMessage.Send` without `ChannelMessage.Read.All`. If the user wants to
search or summarize channel history, that permission has to be added explicitly,
and it needs admin consent.

Read-only across chats and channels:

```json
"scopes": [
  "https://graph.microsoft.com/Chat.Read",
  "https://graph.microsoft.com/ChannelMessage.Read.All",
  "https://graph.microsoft.com/Team.ReadBasic.All",
  "https://graph.microsoft.com/Channel.ReadBasic.All"
]
```

## Authenticate

```
mcp__session__source_microsoft_oauth_trigger({ sourceSlug: "teams" })
```

## permissions.json (Explore mode)

```json
{
  "allowedMcpPatterns": [],
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests are read-only" }
  ]
}
```

## Useful endpoints

- `me/joinedTeams`
- `teams/{team-id}/channels`
- `teams/{team-id}/channels/{channel-id}/messages`
- `me/chats?$expand=members`
- `chats/{chat-id}/messages`

## Gotchas

- **`ChannelMessage.Read.All` requires tenant admin consent.** In most managed
  organizations the user cannot grant it themselves. Establish whether they are a
  tenant admin, or whether they have someone who will approve it, *before*
  building the source — otherwise auth appears to succeed and every channel read
  returns 403.
- **If a 403 mentions "Protected API access… in application-only context",** that is
  Microsoft's separate protected-API approval gate. It applies to *application*
  permissions, not the delegated permissions Vorno uses — so seeing it means
  something is running app-only, not as the signed-in user. Delegated access does
  not go through the request form; it goes through admin consent.
- There is **no cross-team message search** in Graph the way Slack has search.
  Finding a message means enumerating teams → channels → messages, which is slow
  and rate-limited. Set expectations: Teams is much weaker than Slack at "find that
  thing someone said."
- Message bodies are HTML with Teams-specific markup (mentions, attachments as
  `<attachment>` references). Render via `html-preview` rather than pasting.
- Graph throttles Teams message endpoints aggressively. Expect `429` with a
  `Retry-After` header on any bulk read, and honor it.

## Consider the browser instead

For one-off Teams tasks — grab a thread, post one message, check a channel — the
in-app browser avoids admin consent entirely. Given the consent friction, offer this
first unless the user needs repeatable automation.

---

_Verified 2026-08-17 against Microsoft Graph permissions reference, Microsoft Learn's
Teams protected-APIs documentation, and Vorno's `MICROSOFT_SERVICE_SCOPES`._
