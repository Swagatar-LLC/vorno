# @craft-agent/viewer — the session viewer and its share backend

The web viewer for shared Vorno sessions, plus the Cloudflare Worker that stores
them. Front-end in `src/`, backend in `worker/`.

Both live here because the SPA fetches `/s/api/{id}` **relative** (`src/App.tsx`),
so the API and the bundle must be served from one origin. See
[ADR-0024](../../roadmap/decisions/0024-vorno-hosts-its-own-shared-sessions.md)
and [PLAN-035](../../roadmap/plans/in-progress/PLAN-035-vorno-hosted-session-shares.md).

## The share API

Called from the four `${VIEWER_URL}/s/api` call sites in
`packages/server-core/src/sessions/SessionManager.ts`.

| Route | Auth | Notes |
|---|---|---|
| `POST /s/api` | none, rate-limited | → `{ id, url, editToken }`, 201 |
| `GET /s/api/:id` | none | always `application/json` + `nosniff` + `no-store` |
| `PUT /s/api/:id` | `Bearer <editToken>` | replaces; resets lifecycle age |
| `DELETE /s/api/:id` | `Bearer <editToken>` | revokes |

Everything else is the SPA: `/s/assets/*` → `/assets/*` and `/s/{id}` →
`/index.html`, mirroring `public/_redirects` (which is what Cloudflare Pages
applied when upstream hosted this).

**The edit token is the point.** Upstream authenticates `PUT`/`DELETE` on the
share id alone — and the id is in the URL the user forwards to other people, so
any recipient can overwrite or delete the share. Create mints a token that never
appears in the share URL. Forwarding a link grants read and only read.

**Reads are always inert JSON**, whatever was uploaded. That is what stops an
unauthenticated `POST` endpoint from being used as a free CDN or a phishing host
on a `vorno.ai` domain.

### Things that will bite you

- **10ms CPU per invocation** on the Workers free plan. Bodies stream straight
  into R2 and are never parsed — a multi-megabyte `JSON.parse` blows that budget
  and would fail on exactly the large sessions people most want to share. Do not
  add JSON shape validation here.
- **The size cap is enforced on the stream**, not on `Content-Length`. The header
  is a client claim; it is checked first only as a cheap early reject.
- **Retention is a bucket lifecycle rule, not code.** Objects are deleted N days
  after they are written. If the rule is missing, shares live forever and nothing
  fails visibly.

## Develop

```bash
bun run dev            # Vite on :5174, /s/api proxied to production
bunx wrangler dev      # local Worker + local R2, then point the proxy at :8787
bun test worker/       # strict in CI (validate-pr.yml → "Test share Worker")
```

## Deploy

Requires the provisioning in PLAN-035 → *What Jeff must create*: the
`vorno-shares` R2 bucket with its lifecycle rule, the `share.vorno.ai` custom
domain, and a `CLOUDFLARE_API_TOKEN`.

```bash
bun run build          # → dist/, built with base '/s/'
bunx wrangler deploy
```

Deploying does not build. `bunx wrangler deploy` publishes whatever is in `dist/`.

**Never add a Redirect Rule to the `vorno.ai` zone for this host.** Redirect
Rules run *before* Workers and silently shadow them.

### After every deploy, verify over real HTTP

A green deploy is not evidence of a correct service — the failure shape of
LEARNING-048. The shell's `curl` is aliased to a missing binary; use
`/usr/bin/curl`.

```bash
BASE=https://share.vorno.ai
OUT=$(/usr/bin/curl -s -X POST "$BASE/s/api" -H 'content-type: application/json' \
      -d '{"id":"smoke","messages":[]}')
ID=$(echo "$OUT" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
TOKEN=$(echo "$OUT" | sed -n 's/.*"editToken":"\([^"]*\)".*/\1/p')

/usr/bin/curl -s -o /dev/null -w 'read          %{http_code}\n' "$BASE/s/api/$ID"
/usr/bin/curl -s -o /dev/null -w 'viewer shell  %{http_code}\n' "$BASE/s/$ID"
/usr/bin/curl -s -o /dev/null -w 'unauth PUT    %{http_code} (want 401)\n' \
  -X PUT "$BASE/s/api/$ID" -d '{}'
/usr/bin/curl -s -o /dev/null -w 'authed DELETE %{http_code}\n' \
  -X DELETE "$BASE/s/api/$ID" -H "authorization: Bearer $TOKEN"
/usr/bin/curl -s -o /dev/null -w 'after revoke  %{http_code} (want 404)\n' "$BASE/s/api/$ID"
```

The `401` and the final `404` are the two that matter: they are write auth and
revocation, and both fail silently in a way no build step catches.
