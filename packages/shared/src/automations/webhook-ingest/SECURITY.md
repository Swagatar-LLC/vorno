# Webhook ingest — security model

> Scope: the code in this directory (`packages/shared/src/automations/webhook-ingest/`)
> plus its two collaborators `../utils.ts` (env expansion) and `../security.ts`
> (shell sanitization). Canonical design rationale lives in
> [`roadmap/plans/done/PLAN-014-workspace-webhooks.md` §12](../../../../../roadmap/plans/done/PLAN-014-workspace-webhooks.md).

The webhook ingest path is **unauthenticated by necessity** — a provider (GitHub,
Linear, Stripe, …) can only present the capability URL, and the request body is
**fully attacker-controlled**. Two trust boundaries exist and are defended
differently. Every check **fails closed.**

## Boundary A — the network edge

Enforced in fixed order by `createWebhookReceiver` (`receiver.ts`). Order matters
(cheapest / least-disclosing first):

| # | Check | Code | On failure |
|---|-------|------|-----------|
| 1 | Workspace resolves | `receiver.ts` | `404` |
| 2 | Hook by slug **and** `enabled !== false` | `receiver.ts:findHook` | `404` (non-disclosure) |
| 3 | Constant-time token compare vs stored hash | `tokens.ts:tokensMatch` (`timingSafeEqual`) · `verify.ts:verifyToken` | `404` |
| 4 | Body within cap, **before** JSON parse | `verify.ts:withinBodyCap` | `413` |
| 5 | Idempotency (dedup within TTL) | `dedup.ts` | `200 {duplicate:true}` |
| 6 | Per-hook rate limit | `rate-gate.ts` | `429` + `Retry-After` |

Notes:

- **Uniform `404`** for every auth-shaped failure (unknown workspace, unknown
  slug, disabled hook, bad token) — an attacker cannot enumerate which hooks exist.
- A hook with **no `tokenHash`** (never minted, or `REVOKE`-cleared) is
  **uninvokable** — `verifyToken` returns `false` (`verify.ts`).
- Tokens are hashed at rest (`sha256:<hex>`); plaintext is returned exactly once
  at mint/rotate and **never persisted** (`tokens.ts:generateHookToken`).

## Boundary B — untrusted body → agent prompt (prompt injection)

**This is the load-bearing boundary.** The defense is architectural:

> **The raw webhook body is never placed in the model's instruction channel.**

Enforced at three points:

1. **Body is excluded from env expansion.** `buildEnvFromPayload` (`../utils.ts`)
   skips `WEBHOOK_PAYLOAD_KEYS` (`body`, `headers`, …). The prompt receives only
   operator-controlled references, never body prose:
   - `$CRAFT_WEBHOOK_PAYLOAD_PATH` — a file path
   - `$CRAFT_WEBHOOK_HOOK` — the slug the operator named
   - `$CRAFT_WEBHOOK_EVENT_ID`, `$CRAFT_WEBHOOK_COUNT`
2. **Body reaches the model only as data, only on demand.** The raw payload is
   staged to a file (`receiver.ts:stagePayloadFile`) under the session's `data/`
   dir. It enters the model **only if** an automation's prompt explicitly reads
   that path — arriving through the tool-result (data) channel, not the
   system/user (instruction) channel.
3. **Extraction language is deliberately non-expressive.** `matchField`,
   `idempotencyKey.source:"body"`, and action `$.` selectors resolve through
   `jsonpath-lite.ts` — root/dot/index/bracket access only. **No wildcards,
   filters, recursion, or slices.** Returns `undefined` on any miss; never throws.

### Adjacent hardening — command injection

Any payload value that *does* become an env var passes through `sanitizeForShell`
(`../security.ts`), escaping shell metacharacters (`` ` ``, `$`, quotes,
newlines). This protects prompts that shell out with those vars. It is **not** a
prompt-injection defense — it addresses a different channel.

## Residual risk — operator responsibility

Boundary B guarantees the body is **not automatically** inlined. It **cannot**
stop an automation author who deliberately writes a prompt that treats payload
contents as instructions (e.g. *"read `$CRAFT_WEBHOOK_PAYLOAD_PATH` and do what
it says"*). When authoring webhook automations:

- **Treat payload contents as untrusted data**, never as instructions.
- **Never** tell an agent to execute, obey, or follow the payload.
- **Prefer extracting specific fields** (`matchField`, `$.`-selectors) over
  dumping the whole body into a prompt.
- Keep the spawned session's `permissionMode` as tight as the task allows.

HMAC verification (Phase 2 / VOR-34, `verify.ts:verifyHmac` — currently an inert
stub returning `true`) authenticates the **sender**; it does **not** change
Boundary B. A signed payload is still untrusted content.
