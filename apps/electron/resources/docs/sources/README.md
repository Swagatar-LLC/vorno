# Service setup guides

Service-specific guides for creating sources. Read the one matching the service
**before** creating the source — each records the current auth surface, the
narrowest useful scopes, and the gotchas that fail at credential time.

`../sources.md` is the general workflow (config schema, permissions, `source_test`).
These files only cover what is service-specific.

| Service | File | Recommended path |
|---|---|---|
| GitHub | [github.md](./github.md) | Official remote MCP + PAT |
| Linear | [linear.md](./linear.md) | Official remote MCP + OAuth |
| Slack | [slack.md](./slack.md) | Official remote MCP (see caveats) |
| Craft (documents) | [craft.md](./craft.md) | Official remote MCP + OAuth |
| Gmail | [gmail.md](./gmail.md) | API source + Google OAuth |
| Google Calendar | [google-calendar.md](./google-calendar.md) | API source + Google OAuth |
| Google Drive | [google-drive.md](./google-drive.md) | API source + Google OAuth |
| Google Docs | [google-docs.md](./google-docs.md) | API source + Google OAuth |
| Google Sheets | [google-sheets.md](./google-sheets.md) | API source + Google OAuth |
| Outlook | [outlook.md](./outlook.md) | API source + Microsoft OAuth |
| Microsoft Calendar | [microsoft-calendar.md](./microsoft-calendar.md) | API source + Microsoft OAuth |
| Microsoft Teams | [teams.md](./teams.md) | API source + Microsoft OAuth |
| SharePoint | [sharepoint.md](./sharepoint.md) | API source + Microsoft OAuth |
| Filesystem | [filesystem.md](./filesystem.md) | Native `local` source |
| Brave Search | [brave-search.md](./brave-search.md) | Official stdio MCP + API key |
| Memory | [memory.md](./memory.md) | Reference stdio MCP, no auth |

Two shared prerequisite guides, linked from the service pages:

- [google.md](./google.md) — one Google Cloud OAuth client covers all five Google services.
- [microsoft.md](./microsoft.md) — one Entra app registration covers all four Microsoft services. **Read this first; Microsoft OAuth needs an environment variable that is not set by default.**

## If the service has no guide here

Fall back to the research procedure in `../sources.md` step 0. Establish, with web
tools and in this order: whether an official MCP server exists, what the auth
scheme is and where the credential is created, and what prerequisites the service
assumes. Do not build the source from memory — endpoints and scopes change.

## Standing rules these guides assume

- **Prefer an official MCP server over a hand-rolled REST source.** It ships its own
  tool schemas and the vendor keeps it current.
- **Scope the credential to the task, not to the user's whole account.** Ask what the
  user actually wants to do, then request the narrowest scope that does it. Several
  services offer a dedicated read-only endpoint — use it when the answer is "just
  let me look at things."
- **Always `source_test` before declaring done**, then trigger the auth flow named in
  the guide.

---

_Written for Vorno. Endpoints and scopes verified 2026-08-17; re-verify with web tools
if a setup fails at credential time — that is the symptom of a guide that has aged._
