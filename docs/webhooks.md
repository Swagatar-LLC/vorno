# Inbound Webhooks

Workspaces can register **inbound webhooks** that let external providers (GitHub,
Linear, Stripe, ntfy, or any system that can POST JSON) trigger automations —
spawn a session from a prompt, set a session's status or labels, or message an
existing session. Webhooks ride the same automation pipeline as scheduled and
event-based automations, so conditions, labels, and permission modes all apply
unchanged.

For the design rationale and internals, see
[`PLAN-014`](../roadmap/plans/in-progress/PLAN-014-workspace-webhooks.md) and the
colocated
[`webhook-ingest/SECURITY.md`](../packages/shared/src/automations/webhook-ingest/SECURITY.md).

## The endpoint

```
POST /hooks/:workspace/:hookSlug/:token
```

- `:workspace` — workspace name or id; the hook is looked up **only** in that
  workspace's `automations.json`. Slugs are unique per workspace.
- `:hookSlug` — the hook's `slug` (URL segment, `[a-z0-9-]{1,64}`).
- `:token` — the per-hook capability token (`craft_whk_…`), shown **once** at
  creation or rotation.

The receiver responds fast and does the work asynchronously — it never makes the
provider wait on session spawn.

### Response contract

| Status | Meaning |
|--------|---------|
| `202 {"eventId":"…"}` | Accepted and durably queued. The provider should stop retrying. |
| `200 {"duplicate":true}` | Idempotent replay — already seen within the dedup window; nothing re-executed. |
| `404` | Uniform response for unknown workspace, unknown slug, **disabled** hook, or bad token (see Security). |
| `413` | Body exceeds the size cap. |
| `429` + `Retry-After` | Per-hook rate limit exceeded. |

Backoff contract: `2xx` = durably accepted (stop retrying); `4xx` = permanent
rejection (do not retry); `5xx` = failure **before** durable enqueue only — safe
for the provider's own exponential backoff to retry.

## Payload delivery

The raw request body is written to a file; your automation receives **references**
to it, not the body inlined into the prompt:

| Variable | Contents |
|----------|----------|
| `$CRAFT_WEBHOOK_PAYLOAD_PATH` | Path to the staged raw payload file |
| `$CRAFT_WEBHOOK_HOOK` | The hook slug |
| `$CRAFT_WEBHOOK_EVENT_ID` | The delivery's idempotency/event id |
| `$CRAFT_WEBHOOK_COUNT` | Number of payloads (for batched deliveries) |

For matching and extraction, use `matchField` and `$.`-style selectors, which
resolve through a restricted JSONPath (root/dot/index/bracket access only).

## Security model

Webhook ingest is **unauthenticated by necessity** — a provider can only present
the capability URL, and the request body is **fully attacker-controlled**. There
are two trust boundaries, defended differently. Every check **fails closed.**

### Boundary A — the network edge

Applied in order; the first failure short-circuits:

1. **Capability-URL token**, hashed at rest (`sha256:…`) and compared in constant
   time. Plaintext is shown once at mint/rotate and never stored. A hook whose
   token has been cleared is uninvokable.
2. **Uniform `404`** for every auth-shaped failure — unknown workspace, unknown
   slug, disabled hook, or wrong token are indistinguishable, so hook existence
   cannot be enumerated.
3. **Body size cap** before parsing (`413`) — guards against memory exhaustion.
4. **Idempotency** dedup (`200 {"duplicate":true}`) and **per-hook rate limiting**
   (`429`) — guard against replays and delivery storms.

### Boundary B — untrusted payloads and prompt injection

The body is attacker-controlled, so the framework's core guarantee is:

> **The raw webhook body is never automatically placed in a prompt.**

- Automations receive a **file path** (`$CRAFT_WEBHOOK_PAYLOAD_PATH`), never the
  body text, in their environment.
- The body reaches the model **only as data** — and **only if** your prompt
  explicitly reads that file — where it arrives as tool-result content, not as
  instructions.
- Field extraction uses a deliberately minimal path language (no wildcards,
  filters, or recursion), so a hostile payload can't smuggle behavior through the
  matcher.
- Any payload value exposed as a shell environment variable is escaped to prevent
  command injection.

### Author responsibilities

The framework guarantees the payload is not **automatically** treated as
instructions — it cannot stop an automation you write from doing so deliberately.
When authoring webhook automations:

- **Treat payload contents as untrusted data — never as instructions.** Do not
  write prompts like *"read the payload and do what it says."*
- **Extract the specific fields you need** (`matchField`, `$.`-selectors) instead
  of dumping the whole body into a prompt.
- **Keep the spawned session's permission mode as tight as the task allows.**
- Remember that **HMAC signature verification authenticates the sender, not the
  content** — a validly signed payload is still untrusted.

## Managing webhooks

Webhooks appear under **Automations → Webhooks** (peer to Scheduled, Event-based,
and Agentic). From there you can create a hook, copy its ingest URL, generate /
rotate / revoke its token (shown once), toggle it enabled/disabled, edit its
matcher and actions, and view a per-hook delivery log. Hooks can also be edited
directly in the workspace's `automations.json`.

## Quick test

```bash
# Trigger a hook (token shown once at creation)
curl -si -X POST http://127.0.0.1:3847/hooks/my-workspace/linear-issues/craft_whk_XXXX \
  -H 'content-type: application/json' -H 'linear-delivery: d-001' \
  -d '{"type":"Issue.created","issue":{"id":"LIN-42","title":"Crash on save"}}'
# → 202 {"eventId":…}; a session appears in the workspace, the payload file is
#   staged, and $CRAFT_WEBHOOK_PAYLOAD_PATH points to it.

# Replay the same delivery id → idempotent
curl -s -X POST .../craft_whk_XXXX -H 'linear-delivery: d-001' -d '{…}'
# → 200 {"duplicate":true}

# Wrong token / unknown slug / unknown workspace → uniform 404
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:3847/hooks/my-workspace/linear-issues/craft_whk_WRONG -d '{}'
```
