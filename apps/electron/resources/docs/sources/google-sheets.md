# Google Sheets

**Read [google.md](./google.md) first** — the OAuth client, the console walkthrough,
and the 7-day refresh-token trap are shared across all Google services.

Enable the **Google Sheets API** in the Google Cloud project. To *find* spreadsheets
rather than open known ones, enable the **Drive API** too — the Sheets API has no
search.

## config.json

```json
{
  "type": "api",
  "name": "Google Sheets",
  "slug": "google-sheets",
  "provider": "google",
  "icon": "https://ssl.gstatic.com/docs/spreadsheets/favicon3.ico",
  "tagline": "Read and write spreadsheet data",
  "api": {
    "baseUrl": "https://sheets.googleapis.com/v4/",
    "authType": "oauth",
    "googleService": "sheets",
    "googleOAuthClientId": "….apps.googleusercontent.com",
    "googleOAuthClientSecret": "GOCSPX-…",
    "testEndpoint": { "method": "GET", "path": "spreadsheets/{a known sheet id}" }
  }
}
```

Like Docs, there is no account-level endpoint — `testEndpoint` needs a real
spreadsheet ID. Ask the user for one.

## Scopes

| Scope | Class | Grants |
|---|---|---|
| `https://www.googleapis.com/auth/drive.file` | **Non-sensitive** (Google-recommended) | Only spreadsheets opened with this app |
| `https://www.googleapis.com/auth/spreadsheets.readonly` | Sensitive | See all spreadsheets |
| `https://www.googleapis.com/auth/spreadsheets` | Sensitive | See, edit, create, delete all spreadsheets |

Vorno's `googleService: "sheets"` default is the full `spreadsheets` scope.

Read-only:

```json
"googleScopes": [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/userinfo.email"
]
```

Prefer `drive.file` when the user works with a known set of sheets — it is
non-sensitive and cannot reach anything they did not open with the app.

## Authenticate

```
mcp__session__source_google_oauth_trigger({ sourceSlug: "google-sheets" })
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

- **A1 notation is the whole interface.** Reads are
  `spreadsheets/{id}/values/{range}` where range is `Sheet1!A1:D100`. A sheet name
  containing a space or an apostrophe must be quoted: `'Q3 Budget'!A1:D100`.
  Unquoted names with spaces fail with a parse error that does not say so.
- **`valueRenderOption` changes what you get.** The default returns formatted
  strings (`"$1,234.00"`); pass `valueRenderOption=UNFORMATTED_VALUE` when doing
  arithmetic, or every number arrives as text.
- Writes: `values/{range}?valueInputOption=USER_ENTERED` interprets input the way a
  person typing would (formulas work, dates parse); `RAW` stores strings literally.
  Choosing `RAW` for a formula stores the formula text as a visible string.
- Empty trailing cells are **omitted** from the response — rows come back ragged,
  not padded to equal length. Code that indexes by column position must handle short rows.
- Spreadsheet IDs come from the URL: `docs.google.com/spreadsheets/d/<ID>/edit`.
- For anything the user wants to keep, consider having Vorno render a `spreadsheet`
  block instead — a downloadable `.xlsx` may be what they actually wanted.

---

_Verified 2026-08-17 against Google's Sheets API scope reference, which is the source
of the sensitivity classifications above._
