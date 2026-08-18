# Microsoft services — shared setup

Read this before Outlook, Microsoft Calendar, Teams, or SharePoint. One Entra app
registration covers all four.

## Check this first — Microsoft OAuth is off by default

**`source_microsoft_oauth_trigger` fails unless Vorno was launched with the
`MICROSOFT_OAUTH_CLIENT_ID` environment variable set.** The error is
"Microsoft OAuth not configured. Set MICROSOFT_OAUTH_CLIENT_ID environment variable."

Unlike Google — where the user drops `googleOAuthClientId` straight into
`config.json` — **there is no per-source config field for the Microsoft client ID.**
It is read from the process environment at startup, and nothing else.

So the honest sequence is:

1. Tell the user this up front, before building anything. A Microsoft source is a
   restart-required setup, not a click-through.
2. Have them register the Entra app (below) and get the Application (client) ID.
3. Have them relaunch Vorno with `MICROSOFT_OAUTH_CLIENT_ID=<client-id>` in the
   environment.
4. Then create the source and authenticate.

If the user wants a Microsoft task done *now* and does not want to restart, use the
in-app browser instead. Microsoft is the single most common case where browser-first
is the right call.

## Registering the Entra app

1. <https://portal.azure.com/> → **Microsoft Entra ID** → **App registrations** →
   **New registration**.
2. Name it (e.g. "Vorno"). Choose the supported account types the user needs —
   single-tenant if this is one organization, or the multitenant/personal option if
   they use a personal Microsoft account.
3. Leave **Redirect URI empty at registration**. Microsoft's own guidance is to add
   it afterward on the Authentication blade.
4. **Manage → Authentication → Add a platform → Mobile and desktop applications.**
   Add the redirect URI:

   ```
   http://localhost/callback
   ```

   **The port is deliberately omitted, and that is correct.** Per RFC 8252, Entra
   ignores the port when matching a `localhost` redirect URI — `http://localhost/callback`
   matches `http://localhost:53219/callback` and every other port. Vorno's callback
   server picks an ephemeral port, so a registered URI with a fixed port would fail
   on most launches with `AADSTS50011`.

   Two rules that bite here:
   - **Do not register several localhost URIs differing only by port.** Entra picks
     one arbitrarily and applies its platform type to all of them.
   - **The path is case-sensitive and *is* matched.** It must be `/callback`.

5. **Manage → API permissions → Add a permission → Microsoft Graph → Delegated
   permissions.** Add the ones the service guide names. Delegated means the app
   acts as the signed-in user and can reach only what that user can reach — this is
   what you want. Application permissions are tenant-wide and need admin consent.
6. **Overview → Application (client) ID** — this is the value for
   `MICROSOFT_OAUTH_CLIENT_ID`.

**No client secret is needed.** A public client/native registration uses PKCE.

## config.json shape

```json
{
  "type": "api",
  "provider": "microsoft",
  "api": {
    "baseUrl": "https://graph.microsoft.com/v1.0/",
    "authType": "oauth",
    "microsoftService": "outlook",
    "testEndpoint": { "method": "GET", "path": "me" }
  }
}
```

`https://graph.microsoft.com/v1.0/me` is a good `testEndpoint` for every Microsoft
service — it is covered by `User.Read`, which every scope set includes.

## Scopes

Vorno's built-in `microsoftService` sets are **read/write by default**:

| `microsoftService` | Scopes |
|---|---|
| `outlook` | `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access` |
| `microsoft-calendar` | `Calendars.ReadWrite`, `User.Read`, `offline_access` |
| `onedrive` | `Files.ReadWrite`, `User.Read`, `offline_access` |
| `teams` | `Chat.ReadWrite`, `ChannelMessage.Send`, `User.Read`, `offline_access` |
| `sharepoint` | `Sites.ReadWrite.All`, `User.Read`, `offline_access` |

Override with a custom `scopes` array when the user asked for read-only; the
service guides list the read-only equivalents. `User.Read` and `offline_access` are
force-added to any custom set, so you do not need to include them (and including
them is harmless).

Drop `offline_access` only if you *want* the connection to die when the access token
expires — it is what enables refresh.

## Gotchas

- Admin consent: `Sites.ReadWrite.All` and several other Graph permissions require a
  tenant administrator to consent. In a managed organization the user often cannot
  self-approve. Check before promising it will work.
- The scopes are requested as full URIs (`https://graph.microsoft.com/Mail.Read`),
  not bare names, in Vorno's config.
- Vorno authenticates against the `common` tenant endpoint, which accepts both work
  or school accounts and personal Microsoft accounts. If the registration is
  single-tenant, a personal account will be rejected at sign-in.
- `AADSTS50011` always means redirect-URI mismatch. Check the path and the platform
  type before anything else.

---

_Verified 2026-08-17 against Microsoft Learn's "Redirect URI (reply URL) best practices
and limitations" (the source of the localhost port-matching rule) and Vorno's
`packages/shared/src/auth/microsoft-oauth.ts`._
