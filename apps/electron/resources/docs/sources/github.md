# GitHub

**Recommended:** the official GitHub remote MCP server with a Personal Access Token.

## Prerequisite: check for the `gh` CLI first

Before creating the source, check whether the user already has the GitHub CLI
installed and authenticated:

```bash
gh auth status
```

If that succeeds, say so and ask whether they want the source at all. Much
day-to-day GitHub work (PRs, issues, releases, API calls via `gh api`) is already
available through Bash with no new credential, no new token to rotate, and no
scope decision. Create the MCP source when the user wants GitHub tools available
to the model as structured tools, or wants GitHub reachable from automations that
do not run shell commands.

If `gh` is missing and the user wants it: `brew install gh && gh auth login`.

## config.json

```json
{
  "type": "mcp",
  "name": "GitHub",
  "slug": "github",
  "provider": "github",
  "icon": "https://github.githubassets.com/favicons/favicon.svg",
  "tagline": "Repositories, issues, and pull requests",
  "mcp": {
    "url": "https://api.githubcopilot.com/mcp/",
    "authType": "bearer"
  }
}
```

**Use `authType: "bearer"`, not `"oauth"`.** The endpoint advertises OAuth, but
Vorno's dynamic-client-registration flow does not complete against it — the
source will sit in `needs_auth`. A PAT works reliably.

## Authenticate

```
mcp__session__source_credential_prompt({ sourceSlug: "github", mode: "bearer" })
```

The token is sent as `Authorization: Bearer <PAT>`.

## Narrow the surface

GitHub exposes the surface three ways. Prefer the narrowest that does the job:

| Want | URL |
|---|---|
| Read-only, everything | `https://api.githubcopilot.com/mcp/readonly` |
| One toolset | `https://api.githubcopilot.com/mcp/x/issues` |
| One toolset, read-only | `https://api.githubcopilot.com/mcp/x/issues/readonly` |

Toolset names seen in GitHub's docs include `issues`, `pull_requests`, `repos`,
and `users`. A path segment takes exactly one toolset — to combine several, keep
the base URL and send the `X-MCP-Toolsets` header with a comma-separated list.
`X-MCP-Readonly: true` is equivalent to the `/readonly` path.

If the user said "read-only exploration", point `mcp.url` at `.../mcp/readonly`
**and** scope the PAT down. Two independent limits are better than one.

## PAT scopes

GitHub's own documentation does not publish a scope list for the MCP server —
it says only to "create a PAT with the necessary scopes for the access you want
to grant." Treat any specific list (including this one) as a starting point to
confirm against what the tools actually return, not as vendor-published fact.

Create at **Settings → Developer settings → Personal access tokens**
(<https://github.com/settings/personal-access-tokens>).

- **Fine-grained tokens are the better default.** They are scoped to selected
  repositories, so a token for one project cannot read the rest of the account.
  Grant repository permissions matching the task — typically *Contents: Read*,
  *Issues: Read/Write*, *Pull requests: Read/Write*, *Metadata: Read* (mandatory).
- **Classic tokens** are broader and account-wide. If one is needed, `repo`
  covers private repository access and `read:org` covers org/team lookups. A
  classic token with `repo` can read and write **every** repository the user can
  reach — only use it when fine-grained genuinely does not cover the case.

Organization policy can restrict PATs independently. If tools return 403 on a
repo the user can see in the browser, check whether the org requires fine-grained
token approval.

## permissions.json (Explore mode)

```json
{
  "allowedMcpPatterns": [
    { "pattern": "list", "comment": "List operations" },
    { "pattern": "get", "comment": "Get/read operations" },
    { "pattern": "search", "comment": "Search operations" }
  ]
}
```

## Gotchas

- Trailing slash on the URL: `https://api.githubcopilot.com/mcp/`.
- Connectivity check without touching the source: `curl -I https://api.githubcopilot.com/mcp/_ping` → expect `200`.
- The remote server has tools the local/Docker server does not. Prefer the remote
  endpoint unless the user is air-gapped or has a policy against it.
- The remote server also works for GitHub Enterprise Cloud.

---

_Verified 2026-08-17 against GitHub's `github/github-mcp-server` docs and GitHub Docs
("Setting up the GitHub MCP Server"). PAT scope mapping is inferred — GitHub does not
publish one._
