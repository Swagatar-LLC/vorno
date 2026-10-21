# HTTP Trigger Server — Protocol Reference

This document covers the wire protocols, event model, and client-server interaction patterns for the HTTP trigger server (`apps/server/`). For quick start and API reference, see [`apps/server/README.md`](../apps/server/README.md).

## Event Model

All transports stream the same `AgentEvent` union type (defined in `packages/core/src/types/message.ts`). These are the events a client receives during a conversation:

### Streaming Events

| Event Type | Key Fields | Description |
|-----------|------------|-------------|
| `text_delta` | `text` | Incremental text token from the model |
| `text_complete` | `text` | Full text block (sent after all deltas for a block) |
| `tool_start` | `tool`, `input` | Agent is invoking a tool |
| `tool_result` | `tool`, `output` | Tool execution completed |
| `thinking_delta` | `text` | Extended thinking token (when thinking is enabled) |
| `thinking_complete` | `text` | Full thinking block |

### Lifecycle Events

| Event Type | Key Fields | Description |
|-----------|------------|-------------|
| `complete` | — | Generation finished successfully |
| `error` | `message` | Generation failed |
| `typed_error` | `error` (AgentError) | Structured error with code, title, details |
| `cancelled` | — | Generation was aborted |

### Session Events

| Event Type | Key Fields | Description |
|-----------|------------|-------------|
| `permission_request` | `requestId`, `tool`, `input` | Agent needs permission to execute a tool |
| `source_activated` | `source` | Source @mention detected, source loading |
| `task_backgrounded` | `taskId` | Long-running task moved to background |

## HTTP/SSE Protocol

### Request Flow

```
Client                              Server
  │                                    │
  │  POST /api/sessions                │
  │  {"workspaceId": "..."}            │
  │ ──────────────────────────────────►│
  │                                    │  Create AgentSession
  │◄────────────────────────────────── │  Initialize CraftAgent
  │  201 {"sessionId": "abc"}          │
  │                                    │
  │  POST /api/sessions/abc/messages   │
  │  {"content": "Hello"}             │
  │ ──────────────────────────────────►│
  │                                    │  Start async chat()
  │◄─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │  SSE stream opens
  │  event: text_delta                 │
  │  data: {"type":"text_delta",...}   │
  │  event: tool_start                 │
  │  data: {"type":"tool_start",...}   │
  │  event: tool_result                │
  │  data: {"type":"tool_result",...}  │
  │  event: text_delta                 │
  │  data: {"type":"text_delta",...}   │
  │  event: complete                   │
  │  data: {"type":"complete"}         │
  │◄ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│  Stream closes
  │                                    │
```

### SSE Wire Format

Each event follows the [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) specification:

```
event: <AgentEvent.type>\n
data: <JSON-serialized AgentEvent>\n
\n
```

The persistent event stream (`GET /events`) also sends keepalive comments:

```
: keepalive\n
\n
```

### Error Responses

HTTP errors return JSON:

```json
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{"error": "Invalid API key"}
```

| Status | Meaning |
|--------|---------|
| 400 | Invalid request body or missing required fields |
| 401 | Missing or invalid API key |
| 403 | API key lacks access to the requested workspace |
| 404 | Session or workspace not found |
| 409 | Session is already processing (send message while busy) |
| 429 | Rate limit or concurrent session limit exceeded |

### Rate Limiting

Requests are rate-limited per API key using a sliding window (default: 30 requests/minute). Rate-limited responses include:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
X-RateLimit-Remaining: 0

{"error": "Rate limit exceeded", "retryAfterSeconds": 60}
```

## WebSocket Protocol

The WebSocket transport uses the `MessageEnvelope` wire protocol defined in `packages/shared/src/protocol/types.ts`. This is the same protocol spoken by the upstream headless server (`packages/server/`).

### Connection Lifecycle

```
Client                              Server
  │                                    │
  │  GET /ws (Upgrade: websocket)      │
  │ ──────────────────────────────────►│
  │◄────────────────────────────────── │  101 Switching Protocols
  │                                    │
  │  {type:"handshake",                │  Client has 5s to handshake
  │   protocolVersion:"1.0",           │
  │   token:"craft_sk_..."}           │
  │ ──────────────────────────────────►│
  │                                    │  Validate API key
  │◄────────────────────────────────── │  Assign clientId
  │  {type:"handshake_ack",            │  Register in ClientRegistry
  │   clientId:"<uuid>",              │
  │   registeredChannels:[...]}        │
  │                                    │
  │         ◄── heartbeat ──►          │  ping/pong every 30s
  │                                    │
  │  {type:"request",                  │
  │   channel:"sessions:create",       │
  │   args:[{workspaceId:"..."}]}      │
  │ ──────────────────────────────────►│
  │◄────────────────────────────────── │
  │  {type:"response",                 │
  │   result:{sessionId:"abc"}}        │
  │                                    │
  │  {type:"request",                  │  Returns immediately
  │   channel:"sessions:sendMessage",  │  Events pushed async
  │   args:[{sessionId,content}]}      │
  │ ──────────────────────────────────►│
  │◄────────────────────────────────── │
  │  {type:"response",                 │
  │   result:{started:true}}           │
  │                                    │
  │◄────────────────────────────────── │  Push: text_delta
  │  {type:"event",                    │
  │   channel:"sessions:event",        │
  │   args:["abc",{type:"text_delta",  │
  │          text:"Hello!"}]}          │
  │                                    │
  │◄────────────────────────────────── │  Push: complete
  │  {type:"event",                    │
  │   channel:"sessions:event",        │
  │   args:["abc",{type:"complete"}]}  │
  │                                    │
```

### MessageEnvelope Schema

```typescript
interface MessageEnvelope {
  id: string;              // UUID, correlates request↔response
  type: MessageType;       // 'handshake' | 'handshake_ack' | 'request'
                           // | 'response' | 'event' | 'error'
  channel?: string;        // RPC channel name
  args?: unknown[];        // Request args or event payload
  result?: unknown;        // Response payload
  error?: WireError;       // Error details
  protocolVersion?: string;// '1.0' (handshake only)
  token?: string;          // API key (handshake only)
  workspaceId?: string;    // Workspace scope (handshake only)
  clientId?: string;       // Server-assigned (handshake_ack only)
  serverId?: string;       // 'http-trigger' on events
  registeredChannels?: string[]; // Available channels (handshake_ack)
  clientCapabilities?: string[]; // Client features (handshake)
}

interface WireError {
  code: ErrorCode;
  message: string;
  data?: unknown;
}
```

### Binary Data Encoding

`Uint8Array` values in args/result are encoded as:

```json
{"__craftRpcType": "u8", "base64": "<base64-encoded-bytes>"}
```

The codec (`@craft-agent/server-core/transport`) handles this transparently via `serializeEnvelope()` / `deserializeEnvelope()`.

### Close Codes

| Code | Meaning |
|------|---------|
| 4001 | Handshake timeout (5s) |
| 4002 | Invalid message format (bad JSON) |
| 4003 | Expected handshake as first message |
| 4004 | Protocol version unsupported |
| 4005 | Authentication failed |

## Dual-Transport Event Routing

The `ClientRegistry` provides unified push routing across both transports.

### How Events Flow

1. **Agent generates events** — `AgentSession.chat()` yields `AgentEvent` objects
2. **Events hit the EventBus** — published per-session to all subscribers
3. **Subscribers forward to clients** — SSE subscribers encode as SSE lines, WS subscribers encode as `MessageEnvelope` frames
4. **ClientRegistry enables cross-transport push** — `pushToSession(sessionId, ...)` reaches all clients subscribed to that session, regardless of transport

### Session Subscription

- **HTTP/SSE**: Subscribers are created when `POST /messages` or `GET /events` is called. SSE subscribers auto-unsubscribe when the stream closes.
- **WebSocket**: Clients auto-subscribe when they create a session or send the first message via `sessions:sendMessage`.

### Push Targeting

The registry supports multiple targeting modes (matching upstream's `PushTarget`):

```typescript
// Push to all connected clients
registry.push('sessions:event', { to: 'all' });

// Push to all clients in a workspace
registry.push('sessions:event', { to: 'workspace', workspaceId: 'ws-1' });

// Push to a specific client
registry.push('sessions:event', { to: 'client', clientId: 'abc-123' });

// Push to all clients subscribed to a session (most common)
registry.pushToSession('session-123', 'sessions:event', sessionId, event);
```

## Security Model

### API Key Authentication

- Keys use the `craft_sk_` prefix and are 32 random bytes (base64url-encoded)
- Only SHA-256 hashes are stored — plaintext keys are shown once at creation
- Keys are scoped to specific workspaces and permission levels
- Rate limiting is per-key using a sliding window

### Permission Policy Capping

The effective permission policy is always `min(apiKey.maxPolicy, requestedPolicy)`:

```
Key: allow-safe, Request: allow-all → Effective: allow-safe
Key: allow-all, Request: deny-all  → Effective: deny-all
Key: deny-all, Request: allow-all  → Effective: deny-all
```

### Session Isolation

- Sessions are scoped to the API key that created them
- One API key cannot list, access, or modify another key's sessions: every `/api/sessions/:id` route (GET, DELETE, `messages`, `abort`, `events`, `pending`, `permissions`) answers `404 Session '<id>' not found` for a session another key owns
- Concurrent session limits are enforced per-key and globally

### Idle Session Eviction

Sessions idle for 30 minutes are automatically disposed (every 5-minute sweep). This prevents resource leaks from abandoned sessions. A session routed to the desktop app (below) is only detached from the REST API on eviction or server stop; it stays in the desktop app.

## Running API sessions in the desktop app

By default `POST /api/sessions` creates a headless session inside the server's own pool. The desktop app can instead create it through its own session manager, so the session has the browser tool, skills and sources, and shows up in the desktop UI.

- Setting: Settings → Remote Access → "Run API sessions in the desktop app". Persisted as `routeSessionsToDesktop` in `server-config.json`. Default off. Desktop app only; the standalone server always uses its own pool.
- It applies to new sessions without a restart. Existing sessions keep the path they were created on.
- The response shape does not change. The request may also carry `projectId`, `name` and `llmConnection` (below). Auth, workspace access, the per-key concurrency limit and the policy cap all run before routing.

### Creating a session in a project

`POST /api/sessions` accepts an optional `projectId` (a project id such as `proj_6d91a3f0`, not a slug). The session is affiliated with that project exactly like a desktop session created in it: `projectId` is written to the session header, and the project's working directory is inherited when the request has no `workingDirectory`.

- An unknown `projectId` returns 400 and creates nothing.
- `projectId` needs the setting above. Without it (headless pool, standalone server) the request returns 400, because pool sessions are not persisted.
- Omitted, behaviour is unchanged.

### Naming a session and choosing its LLM connection

`POST /api/sessions` also accepts two optional fields, both needing the setting above (the headless pool returns 400 naming `routeSessionsToDesktop`):

- `name`: the session's title in the desktop list. A non-empty string, trimmed, at most 200 characters; otherwise 400. Omitted, the title stays `API · <key name>`.
- `llmConnection`: a connection slug such as `claude-max` or `chatgpt-plus`. An unknown slug returns 400 listing the valid slugs. Omitted, the workspace default connection applies, then the global default.

`model` is checked against the resolved connection (the given `llmConnection`, else the workspace default, else the global default). A model id the connection does not offer returns 400 naming the model, the connection and its available model ids, instead of silently running on the connection's default model. The tier hints `fast` and `default` are always accepted. Connections with a dynamic model list are not checked.

### Policy mapping

The effective policy (the requested policy capped by the key) maps to the desktop session's permission mode:

| REST policy | Desktop mode | Permission requests |
|-------------|--------------|---------------------|
| `allow-all` | allow-all | Approved automatically |
| `allow-safe` | ask | Safe commands (`ls`, `cat`, `grep`, ...) approved automatically; anything else is held as pending. A command counts as safe only if its first word is on the safe list and it contains none of `; | & $ ( ) \` < >` or a newline |
| `deny-all` | safe (read-only) | Always held as pending |

A pending request is sent on the SSE stream as a `permission_request` event and listed by `GET /api/sessions/:id/pending` (`requestId`, `toolName`, `command`, `description`, `permissionType`).

The REST client can only deny a pending request. `POST /api/sessions/:id/permissions` with `{"requestId": "...", "decision": "deny"}` works. With `"decision": "allow"` on a session whose policy is not `allow-all`, it returns 403 `Approving this request exceeds this API key's permission policy` and the request stays pending; the WebSocket `sessions:respondToPermission` call refuses the same way. The desktop user can still approve or deny it in the app: that is the desktop owner's authority, not the key's. A request nobody answers within 5 minutes is denied. An unknown `requestId` returns 404. Abort, delete and the end of the turn deny whatever is still pending.

Eviction (idle or deleted in the desktop) and server stop only detach the REST API from the desktop session. They do not delete it and do not stop its running turn. If the session is deleted in the desktop app, a running stream ends with an `error` event and the session is evicted.

### Ownership and deletion

The session is owned by the key that created it (see Session Isolation) and is labelled in the desktop app with that key's name. `DELETE /api/sessions/:id` removes it from the desktop app too, and so does the WebSocket `sessions:delete` call.

### Manual check

```bash
export VORNO_KEY='<your-craft_sk_-key>'   # from Settings → Remote Access; never commit it
curl -s -X POST http://127.0.0.1:3847/api/sessions \
  -H "Authorization: Bearer $VORNO_KEY" -H 'Content-Type: application/json' \
  -d '{"workspaceId":"<workspace-id>","permissionPolicy":"allow-safe"}'
curl -N -X POST http://127.0.0.1:3847/api/sessions/<session-id>/messages \
  -H "Authorization: Bearer $VORNO_KEY" -H 'Content-Type: application/json' \
  -d '{"content":"Open https://example.com with the browser tool and tell me the page title."}'
```

Expect the session in the desktop app's session list, named for the key. With the setting on, the browser tool opens the page and the stream reports its title. With the setting off, the tool fails with "Browser window controls are not available".

## Upstream Protocol Compatibility

The WebSocket transport is designed to be wire-compatible with the upstream headless server. Key compatibility points:

| Feature | Upstream (`packages/server/`) | HTTP Trigger (`apps/server/`) |
|---------|-------------------------------|-------------------------------|
| Protocol version | `1.0` | `1.0` |
| MessageEnvelope | Full support | Full support |
| Binary encoding | `__craftRpcType: 'u8'` | Same (shared codec) |
| Handshake | Token + version + capabilities | Same (API key in token field) |
| Heartbeat | 30s ping, 2 missed = disconnect | Same |
| Reliable delivery | `seq`, `lastSeq`, `sequence_ack`, reconnect | Not yet (planned) |

The main gap is **reliable delivery** — upstream v0.7.7+ added per-client sequence numbers, event buffering, and reconnect replay. The HTTP trigger server does not yet implement this; events are fire-and-forget. This is acceptable for the current use case (short-lived API calls) but should be added for long-lived WebSocket connections.
