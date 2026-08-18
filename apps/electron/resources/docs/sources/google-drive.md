# Google Drive

**Read [google.md](./google.md) first** — the OAuth client, the console walkthrough,
and the 7-day refresh-token trap are shared across all Google services.

Enable the **Google Drive API** in the Google Cloud project.

## config.json

```json
{
  "type": "api",
  "name": "Google Drive",
  "slug": "google-drive",
  "provider": "google",
  "icon": "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png",
  "tagline": "File search and access in {user's Drive}",
  "api": {
    "baseUrl": "https://www.googleapis.com/drive/v3/",
    "authType": "oauth",
    "googleService": "drive",
    "googleOAuthClientId": "….apps.googleusercontent.com",
    "googleOAuthClientSecret": "GOCSPX-…",
    "testEndpoint": { "method": "GET", "path": "about?fields=user" }
  }
}
```

## Scopes — this is the service where narrowing matters most

Vorno's `googleService: "drive"` default is the **full** `drive` scope, which Google
classifies as **restricted**. Drive has the widest spread between "what the default
grants" and "what the task needs" of any service here.

| Scope | Class | Grants |
|---|---|---|
| `https://www.googleapis.com/auth/drive.file` | **Non-sensitive** | Only files the user opens with this app |
| `https://www.googleapis.com/auth/drive.appdata` | Non-sensitive | The app's own hidden config folder |
| `https://www.googleapis.com/auth/drive.metadata.readonly` | Restricted | File metadata only — names, IDs, dates; no content |
| `https://www.googleapis.com/auth/drive.readonly` | Restricted | View and download **all** Drive files |
| `https://www.googleapis.com/auth/drive` | Restricted | View and manage **all** Drive files |

**Reach for `drive.file` first.** It is the only non-sensitive option, Google
recommends it, and it covers the common "work on these documents with me" workflow
without granting access to the user's entire Drive. Its limitation is real and worth
stating to the user: the app cannot *search* Drive, only act on files explicitly
opened with it.

If the user genuinely needs "search my whole Drive", that requires `drive.readonly`
or `drive` — restricted scopes. Say plainly what that means: the credential can read
every file in the account. Get an explicit yes.

Read-only over the whole Drive:

```json
"googleScopes": [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email"
]
```

Metadata-only — good for "what's in here / find the file called X / what's stale"
without granting content access:

```json
"googleScopes": [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/userinfo.email"
]
```

## Authenticate

```
mcp__session__source_google_oauth_trigger({ sourceSlug: "google-drive" })
```

## permissions.json (Explore mode)

```json
{
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests are read-only" }
  ]
}
```

## Gotchas

- **Google-native files cannot be downloaded directly.** A Doc, Sheet, or Slide has
  no bytes to `files.get?alt=media`. Use `files/{id}/export?mimeType=…` instead
  (e.g. `text/plain`, `application/pdf`). Binary uploads (PDFs, images) use the
  normal download path. Getting this wrong returns a confusing `fileNotDownloadable`.
- Shared drives are not included by default. Pass `includeItemsFromAllDrives=true`
  **and** `supportsAllDrives=true` on list calls, or the user's team files are
  invisible and it looks like a permissions problem.
- Search uses Drive's own `q` query language (`name contains 'budget' and trashed = false`),
  not free text. Look it up rather than guessing the syntax.
- `about?fields=user` is a good `testEndpoint` — the Drive API rejects requests with
  no `fields` parameter on `about`.

---

_Verified 2026-08-17 against Google's Drive API scope reference (`api-specific-auth`),
which is the source of the sensitivity classifications above._
