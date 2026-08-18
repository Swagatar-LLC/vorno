# SharePoint

**Read [microsoft.md](./microsoft.md) first.** Microsoft OAuth requires the
`MICROSOFT_OAUTH_CLIENT_ID` environment variable and an Entra app registration —
neither is set up by default, and the source cannot authenticate without them.

## config.json

```json
{
  "type": "api",
  "name": "SharePoint",
  "slug": "sharepoint",
  "provider": "microsoft",
  "icon": "https://www.microsoft.com/favicon.ico",
  "tagline": "Sites, document libraries, and lists in {user's tenant}",
  "api": {
    "baseUrl": "https://graph.microsoft.com/v1.0/",
    "authType": "oauth",
    "microsoftService": "sharepoint",
    "testEndpoint": { "method": "GET", "path": "me" }
  }
}
```

## Scopes

Vorno's `sharepoint` set: `Sites.ReadWrite.All`, `User.Read`, `offline_access`.

| Delegated permission | Grants |
|---|---|
| `Sites.Read.All` | Read items in all site collections the user can access |
| `Sites.ReadWrite.All` | Read and write items in all accessible site collections |
| `Sites.Selected` | Access **only** specifically granted sites — the narrow option |
| `Files.Read.All` | Read files across sites and OneDrive |
| `Files.ReadWrite.All` | Read and write those files |

Read-only:

```json
"scopes": [
  "https://graph.microsoft.com/Sites.Read.All"
]
```

**`Sites.Selected` is the scope to reach for when the user works in one or two
sites.** The `.All` scopes reach every site collection the user can access, which in
a large tenant is an enormous surface. `Sites.Selected` grants nothing until an
administrator explicitly assigns per-site permissions — more setup, dramatically
less exposure. Offer it when the user names specific sites.

Note the `.All` suffix does *not* mean the app exceeds the user's own access: with
delegated permissions, the app can only reach what the signed-in user can reach.
It means "all sites **that user** can access", which is still a lot.

## Admin consent

**`Sites.Read.All`, `Sites.ReadWrite.All`, and `Sites.Selected` all require tenant
admin consent.** SharePoint is the service most likely to be blocked in a managed
organization. Confirm the user can get consent before building the source.

## Authenticate

```
mcp__session__source_microsoft_oauth_trigger({ sourceSlug: "sharepoint" })
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

- `sites?search=marketing` — find a site by name
- `sites/root` — the tenant root site
- `sites/{hostname}:/sites/{site-path}` — address a site by URL path, e.g.
  `sites/contoso.sharepoint.com:/sites/Marketing`
- `sites/{site-id}/drives` — document libraries
- `sites/{site-id}/drive/root/children` — files in the default library
- `sites/{site-id}/lists` and `sites/{site-id}/lists/{list-id}/items?$expand=fields`

## Gotchas

- **Site IDs are composite**: `{hostname},{siteCollectionId},{siteId}` — a
  comma-joined triple, not a plain GUID. Truncating it to the first GUID is a
  common error. Get the whole string from `sites?search=` and pass it intact.
- **A document library is a `drive`.** Once you have the drive ID, everything is the
  ordinary Graph file API — the same shapes as OneDrive. Do not look for a separate
  SharePoint file API.
- **List items need `$expand=fields`** or you get item metadata with no actual column
  values, which looks like an empty list.
- List column names in `fields` are *internal* names, which often differ from the
  display names in the UI (spaces become `_x0020_`). Read one item first and look at
  the keys before filtering on them.
- Site search (`sites?search=`) only matches site names, not document content.
  Content search is a different, more involved API.

---

_Verified 2026-08-17 against Microsoft Graph permissions reference and Vorno's
`MICROSOFT_SERVICE_SCOPES`._
