# Google services — shared setup

Read this before Gmail, Google Calendar, Drive, Docs, or Sheets. One Google Cloud
OAuth client covers all five; the per-service guides only cover base URLs and scopes.

## The credential is the user's, not Vorno's

Vorno ships no Google OAuth client. The user creates one in their own Google Cloud
project and puts it in the source config:

```json
{
  "type": "api",
  "provider": "google",
  "api": {
    "baseUrl": "…",
    "authType": "oauth",
    "googleService": "gmail",
    "googleOAuthClientId": "….apps.googleusercontent.com",
    "googleOAuthClientSecret": "GOCSPX-…"
  }
}
```

This is the OSS-friendly design — no shared client ID, no rate-limit pool shared
with strangers — but it means **setup starts in the Google Cloud Console** and
takes a few minutes. Tell the user that up front.

## Creating the OAuth client

1. <https://console.cloud.google.com/> → create or select a project.
2. **Enable the API** the service needs (each service guide names it). Without
   this, auth succeeds and every call returns `403 SERVICE_DISABLED` — an
   unhelpfully late failure.
3. **APIs & Services → OAuth consent screen** → configure. User type **Internal**
   if they are on Google Workspace and only they will use it; otherwise
   **External**.
4. **APIs & Services → Credentials** (<https://console.cloud.google.com/apis/credentials>)
   → Create credentials → **OAuth client ID** → application type **Desktop app**.
5. Copy the client ID and client secret into the source config.

Desktop app type is correct: Vorno runs a local callback server and Google requires
a client secret for Desktop clients even though the flow uses PKCE.

## The 7-day expiry trap — check this first

**A project whose OAuth consent screen is External and whose publishing status is
"Testing" issues refresh tokens that expire 7 days after consent.** The source works
perfectly, then fails with `invalid_grant` about a week later and the user has to
re-authorize. This is the single most common Google source complaint and it looks
like a Vorno bug.

Check at <https://console.cloud.google.com/auth/audience>. Three ways out:

- **Internal user type** (Google Workspace accounts only) — not subject to the
  7-day rule or the 100-test-user cap. Best option when available.
- **Publish to Production** — refresh tokens stop expiring on a timer. Expect
  verification, and for sensitive or restricted scopes a security review.
- **Accept it** and tell the user they will re-authorize weekly. Legitimate for a
  short-lived experiment; unacceptable for anything scheduled.

Say which of these applies **while setting the source up**, not after it breaks.

Other expiry causes, even in Production: the token is unused for 6 months, the user
revokes access, the user changes their password while Gmail scopes are granted, or
the per-client refresh-token cap is exceeded (oldest tokens are invalidated
silently).

## Scopes — narrow them deliberately

Vorno's built-in per-service scope sets are **broad read/write defaults**:

| `googleService` | Default scopes |
|---|---|
| `gmail` | `gmail.modify`, `gmail.compose`, `userinfo.email` |
| `calendar` | `calendar` (full), `userinfo.email` |
| `drive` | `drive` (full), `userinfo.email` |
| `docs` | `documents` (full), `userinfo.email` |
| `sheets` | `spreadsheets` (full), `userinfo.email` |

**Override them with `googleScopes` whenever the user asked for less.**
`googleScopes` takes precedence over `googleService`:

```json
"api": {
  "authType": "oauth",
  "googleScopes": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email"
  ]
}
```

Google classifies scopes as non-sensitive, sensitive, or restricted, and the class
drives how much verification a Production app needs. Narrower is both safer for the
user and cheaper to publish. Per-service tables are in the service guides.

`https://www.googleapis.com/auth/drive.file` is the recurring escape hatch: it is
**non-sensitive**, and it grants access only to files the user explicitly opens with
the app. Google recommends it over the broad Drive/Docs/Sheets scopes. It is the
right answer more often than it looks — reach for it when the workflow is "work on
these specific files" rather than "search my whole Drive".

Keep `userinfo.email` in every set; Vorno uses it to label which account is connected.

## Authenticate

```
mcp__session__source_google_oauth_trigger({ sourceSlug: "{slug}" })
```

Endpoints used: `https://accounts.google.com/o/oauth2/v2/auth` and
`https://oauth2.googleapis.com/token`. The redirect is a local callback server;
nothing to register beyond the Desktop app client type.

## Gotchas

- `baseUrl` needs a **trailing slash**; `testEndpoint.path` must have **no leading
  slash**.
- Enable each API separately. A client that works for Gmail returns
  `SERVICE_DISABLED` for Calendar until the Calendar API is enabled in the same project.
- One project can back all five sources. Reuse the client ID rather than creating
  five projects — but note each source authorizes separately and stores its own tokens.
- Tokens generated in Google's OAuth Playground are revoked after 24 hours. Not a
  substitute for the real flow.

---

_Verified 2026-08-17 against Google Identity OAuth 2.0 documentation and Vorno's
`packages/shared/src/auth/google-oauth.ts`._
