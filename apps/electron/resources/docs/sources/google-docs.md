# Google Docs

**Read [google.md](./google.md) first** — the OAuth client, the console walkthrough,
and the 7-day refresh-token trap are shared across all Google services.

Enable the **Google Docs API** in the Google Cloud project. If the user also wants
to *find* documents rather than open known ones, enable the **Drive API** too and
see [google-drive.md](./google-drive.md) — the Docs API has no search.

## config.json

```json
{
  "type": "api",
  "name": "Google Docs",
  "slug": "google-docs",
  "provider": "google",
  "icon": "https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico",
  "tagline": "Read and edit Google Docs documents",
  "api": {
    "baseUrl": "https://docs.googleapis.com/v1/",
    "authType": "oauth",
    "googleService": "docs",
    "googleOAuthClientId": "….apps.googleusercontent.com",
    "googleOAuthClientSecret": "GOCSPX-…",
    "testEndpoint": { "method": "GET", "path": "documents/{a known doc id}" }
  }
}
```

There is no `me`-style endpoint on the Docs API, so `testEndpoint` needs a real
document ID. Ask the user for one document they are happy to use as the health
check — or add `userinfo.email` to the scopes and point `testEndpoint` at the
userinfo endpoint on a separate source. Asking for a doc ID is simpler.

## Scopes

| Scope | Class | Grants |
|---|---|---|
| `https://www.googleapis.com/auth/drive.file` | **Non-sensitive** (Google-recommended) | Only documents opened with this app |
| `https://www.googleapis.com/auth/documents.readonly` | Sensitive | See all Docs documents |
| `https://www.googleapis.com/auth/documents` | Sensitive | See, edit, create, delete all Docs documents |

Vorno's `googleService: "docs"` default is the full `documents` scope.

**`drive.file` is the right answer more often than it looks.** If the user's workflow
is "help me edit these specific documents", `drive.file` covers it, is non-sensitive,
and never grants access to documents they did not name. Google's own documentation
recommends it as the narrowest option.

Read-only:

```json
"googleScopes": [
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/userinfo.email"
]
```

## Authenticate

```
mcp__session__source_google_oauth_trigger({ sourceSlug: "google-docs" })
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

- **The Docs API is a structured-document API, not a text API.** Reading a document
  returns a nested `body.content` tree of structural elements; the text lives in
  `paragraph.elements[].textRun.content`. There is no "give me the plain text" call —
  walk the tree.
- **Edits go through `documents/{id}:batchUpdate`** with a request list, using
  index-based ranges. Indexes shift as you apply requests, so a batch that inserts
  and then deletes by pre-computed indexes will corrupt the document. Apply one
  logical change per batch, or build the requests back-to-front.
- Document IDs come from the URL: `docs.google.com/document/d/<ID>/edit`.
- To *find* a document by name you need the Drive API — the Docs API can only fetch
  by ID.

---

_Verified 2026-08-17 against Google's Docs API authorization reference, which is the
source of the sensitivity classifications above._
