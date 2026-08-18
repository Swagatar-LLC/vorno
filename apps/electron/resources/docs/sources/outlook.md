# Outlook (Microsoft Mail)

**Read [microsoft.md](./microsoft.md) first.** Microsoft OAuth requires the
`MICROSOFT_OAUTH_CLIENT_ID` environment variable and an Entra app registration —
neither is set up by default, and the source cannot authenticate without them.

## config.json

```json
{
  "type": "api",
  "name": "Outlook",
  "slug": "outlook",
  "provider": "microsoft",
  "icon": "https://outlook.live.com/favicon.ico",
  "tagline": "Read, search, and send mail for {user's address}",
  "api": {
    "baseUrl": "https://graph.microsoft.com/v1.0/",
    "authType": "oauth",
    "microsoftService": "outlook",
    "testEndpoint": { "method": "GET", "path": "me" }
  }
}
```

## Scopes

Vorno's `outlook` set: `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`.

| Delegated permission | Grants |
|---|---|
| `Mail.Read` | Read mail in all folders |
| `Mail.ReadBasic` | Read mail **excluding** body, bodyPreview, attachments — metadata triage only |
| `Mail.ReadWrite` | Read, create, update, delete mail |
| `Mail.Send` | Send mail as the user |

Read-only:

```json
"scopes": [
  "https://graph.microsoft.com/Mail.Read"
]
```

`Mail.ReadBasic` is the narrow option worth offering for triage and analytics
("what's unread", "who emails me most", "what's stale") — it answers those without
granting body or attachment access.

Add these to the Entra registration under **API permissions → Microsoft Graph →
Delegated permissions**.

## Authenticate

```
mcp__session__source_microsoft_oauth_trigger({ sourceSlug: "outlook" })
```

## permissions.json (Explore mode)

```json
{
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests are read-only" }
  ]
}
```

## Useful endpoints

- `me/messages?$top=20&$select=subject,from,receivedDateTime,isRead`
- `me/mailFolders/inbox/messages`
- `me/messages?$search="quarterly review"`
- `me/sendMail` (POST)

## Gotchas

- **`$search` and `$orderby` cannot be combined** on messages — Graph returns a
  400. Search results come back in relevance order and that is not overridable.
- `$search` values must be **double-quoted inside the parameter**:
  `$search="budget"`. An unquoted term fails.
- Always use `$select`. Message objects are large and a bare `me/messages` will
  flood the context with fields nobody asked for.
- `$filter` on mail requires the `ConsistencyLevel: eventual` header for some
  properties, plus `$count=true`. If a filter returns an inscrutable 400, that is
  usually why.
- Personal Microsoft accounts (outlook.com, hotmail.com) and work/school accounts
  behave differently on some endpoints. Confirm which one the user has — the Entra
  registration's supported-account-types setting must match.
- Message bodies are HTML. To show one to the user, write it to a file and render
  an `html-preview` block.

---

_Verified 2026-08-17 against Microsoft Graph permissions reference and Vorno's
`MICROSOFT_SERVICE_SCOPES`._
