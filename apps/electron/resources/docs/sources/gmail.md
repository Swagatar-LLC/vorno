# Gmail

**Read [google.md](./google.md) first** — the OAuth client, the console walkthrough,
and the 7-day refresh-token trap are shared across all Google services.

Enable the **Gmail API** in the Google Cloud project.

## config.json

```json
{
  "type": "api",
  "name": "Gmail",
  "slug": "gmail",
  "provider": "google",
  "icon": "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico",
  "tagline": "Read, search, and send mail for {user's address}",
  "api": {
    "baseUrl": "https://gmail.googleapis.com/gmail/v1/users/me/",
    "authType": "oauth",
    "googleService": "gmail",
    "googleOAuthClientId": "….apps.googleusercontent.com",
    "googleOAuthClientSecret": "GOCSPX-…",
    "testEndpoint": { "method": "GET", "path": "profile" }
  }
}
```

## Scopes

Vorno's `googleService: "gmail"` default is `gmail.modify` + `gmail.compose` —
read, trash, label, mark read/unread, and create and send drafts. All Gmail scopes
below are **restricted**, Google's strictest class: publishing to Production with
any of them requires a security assessment.

| Scope | Grants |
|---|---|
| `https://www.googleapis.com/auth/gmail.metadata` | Labels and headers only — **no message bodies** |
| `https://www.googleapis.com/auth/gmail.readonly` | View messages and settings |
| `https://www.googleapis.com/auth/gmail.modify` | Read, trash, label, mark read/unread |
| `https://www.googleapis.com/auth/gmail.compose` | Create and send drafts |

Override with `googleScopes` when the user asked for less. Read-only:

```json
"googleScopes": [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email"
]
```

`gmail.metadata` is worth offering explicitly for triage and analytics workflows
("how many unread from my manager", "what threads are stale") — it answers those
without granting body access at all.

## Authenticate

```
mcp__session__source_google_oauth_trigger({ sourceSlug: "gmail" })
```

## permissions.json (Explore mode)

```json
{
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests are read-only" }
  ]
}
```

Do **not** allow `POST` broadly here — in the Gmail API, sending, trashing, and
modifying are all POST.

## Gotchas

- Message bodies are **base64url-encoded** in `payload.parts[].body.data`. To show
  an HTML email to the user, decode it with `transform_data`, write it to a file,
  and render an `html-preview` block. Do not paste raw base64 into the reply.
- `users/me/` in the base URL resolves to the authorized account. Keeping it in
  `baseUrl` means every path is relative to the right mailbox.
- Password changes revoke refresh tokens when Gmail scopes are granted — expect
  re-auth after the user changes their Google password.
- Gmail auth is one of the two flows (with Microsoft) most likely to be brittle in
  practice. For a genuinely one-off task, the in-app browser is often faster than
  finishing setup.

---

_Verified 2026-08-17 against Google's OAuth 2.0 scope reference and Vorno's
`GOOGLE_SERVICE_SCOPES`._
