# Craft Agents HTTP Trigger Server

A dual-transport server that exposes Craft Agent sessions via both **REST + SSE** (Server-Sent Events) and **WebSocket** on a single port. Designed for external integrations — webhooks, scripts, CI/CD pipelines, and programmatic clients — while remaining compatible with the upstream WebSocket protocol used by the CLI and Electron app.

## Architecture

```
                          ┌─────────────────────────────────┐
                          │     Bun.serve() — Single Port   │
                          │         (default: 3847)         │
                          ├────────────────┬────────────────┤
                          │  HTTP Router   │  WS Upgrade    │
                          │  /api/*        │  /ws or /rpc   │
                          ├────────────────┴────────────────┤
                          │                                 │
  ┌───────────────────────┼─────────────────────────────────┤
  │                       │                                 │
  ▼                       ▼                                 ▼
REST API             SSE Streams            WebSocket Transport
POST /api/sessions   GET .../events         MessageEnvelope protocol
POST .../messages    text/event-stream      Handshake + RPC + Push
DELETE .../           30s keepalive          30s heartbeat (ping/pong)
  │                       │                                 │
  └───────────┬───────────┘                                 │
              │                                             │
              ▼                                             ▼
        ┌───────────────────────────────────────────────────┐
        │              Shared Services                      │
        │  SessionPool · EventBus · ClientRegistry          │
        │                                                   │
        │  ┌─────────────┐  ┌──────────┐  ┌─────────────┐  │
        │  │ AgentSession │  │ EventBus │  │  Client     │  │
        │  │ (CraftAgent  │  │ pub/sub  │  │  Registry   │  │
        │  │  lifecycle)  │  │ per-     │  │  WS + SSE   │  │
        │  │             │  │ session  │  │  tracking   │  │
        │  └─────────────┘  └──────────┘  └─────────────┘  │
        └───────────────────────────────────────────────────┘
                          │
                          ▼
                  ~/.craft-agent/
                  (shared filesystem with Electron app)
```

### Transport Comparison

| Aspect | HTTP/SSE | WebSocket |
|--------|----------|-----------|
| **Path** | `/api/*` | `/ws` or `/rpc` |
| **Auth** | `Authorization: Bearer <api_key>` header per-request | API key in handshake `token` field |
| **Request model** | Stateless REST | Persistent bidirectional RPC |
| **Event streaming** | SSE (`text/event-stream`) | Push events (`MessageEnvelope`) |
| **Keep-alive** | 30s SSE comments | 30s ping/pong heartbeat |
| **Best for** | Webhooks, curl, simple scripts, browser `fetch`/`EventSource` | CLI clients, long-lived connections, upstream protocol compat |

Both transports share the same session pool, event bus, and client registry — a session created via HTTP can receive events via WebSocket and vice versa.

## Quick Start

### 1. Configure

The server reads `~/.craft-agent/server-config.json`:

```json
{
  "enabled": true,
  "port": 3847,
  "host": "127.0.0.1",
  "apiKeys": [],
  "rateLimits": {
    "requestsPerMinute": 30,
    "concurrentSessions": 5
  }
}
```

Or enable it via the Electron app: **Settings → Remote Access**.

### 2. Generate an API Key

API keys are generated via the Electron UI or programmatically:

```typescript
import { generateApiKey, addApiKey, loadServerConfig } from './src/config';

const { fullKey, stored } = generateApiKey('my-integration', {
  workspaceIds: [],        // empty = access all workspaces
  permissionPolicy: 'allow-safe',
  maxConcurrentSessions: 3,
});

const config = loadServerConfig();
addApiKey(config, stored);

console.log('API Key (save this — shown once):', fullKey);
// craft_sk_...
```

### 3. Start the Server

```bash
# From monorepo root
bun run apps/server/src/index.ts

# Or with hot-reload
bun run --watch apps/server/src/index.ts
```

Output:
```
Craft Agents server running at http://127.0.0.1:3847
  Health:     http://127.0.0.1:3847/health
  REST API:   http://127.0.0.1:3847/api/
  WebSocket:  ws://127.0.0.1:3847/ws
```

## HTTP/SSE Transport

### Authentication

All `/api/*` routes require a Bearer token:

```bash
curl -H "Authorization: Bearer craft_sk_..." http://localhost:3847/api/sessions
```

API keys are stored as SHA-256 hashes — the server never stores plaintext keys.

### Endpoints

#### Health Check

```bash
GET /health
# No auth required

# Response:
{
  "status": "ok",
  "version": "0.4.0",
  "uptime": 3600,
  "activeSessions": 2,
  "transports": {
    "http": "active",
    "websocket": "active",
    "wsClients": 1,
    "sseClients": 0
  }
}
```

#### Sessions

**Create a session:**
```bash
POST /api/sessions
Content-Type: application/json

{
  "workspaceId": "My Workspace",
  "model": "claude-sonnet-4-6",
  "permissionPolicy": "allow-safe",
  "enabledSources": ["github", "linear"],
  "workingDirectory": "/path/to/project"
}

# Response (201):
{
  "sessionId": "abc123",
  "workspaceId": "My Workspace",
  "permissionPolicy": "allow-safe",
  "status": "idle"
}
```

**List sessions:**
```bash
GET /api/sessions
# Returns sessions owned by this API key
```

**Get session detail:**
```bash
GET /api/sessions/:id
```

**Delete session:**
```bash
DELETE /api/sessions/:id
```

#### Send Message (SSE Response)

```bash
POST /api/sessions/:id/messages
Content-Type: application/json

{"content": "What files are in the current directory?"}

# Response: text/event-stream
event: text_delta
data: {"type":"text_delta","text":"Let me check"}

event: tool_start
data: {"type":"tool_start","tool":"bash","input":"ls -la"}

event: tool_result
data: {"type":"tool_result","tool":"bash","output":"..."}

event: text_delta
data: {"type":"text_delta","text":"Here are the files:"}

event: complete
data: {"type":"complete"}
```

The response is an SSE stream — each event is an `AgentEvent` with the event type as the SSE event name.

#### Persistent Event Stream

```bash
GET /api/sessions/:id/events

# Opens a long-lived SSE connection for all session events.
# Receives a "connected" event immediately, then all AgentEvents.
# 30-second keepalive comments prevent connection timeouts.
```

This is useful when you create the session via one request and want to stream events separately.

#### Permissions

```bash
# Get pending permission requests
GET /api/sessions/:id/pending

# Respond to a permission request
POST /api/sessions/:id/permissions
{"requestId": "req_abc", "decision": "allow"}
```

#### Abort

```bash
POST /api/sessions/:id/abort
# Cancels the current generation
```

#### Workspaces

```bash
GET /api/workspaces
GET /api/workspaces/:id/sources
```

### Example: Full Conversation with curl

```bash
API_KEY="craft_sk_..."
BASE="http://localhost:3847"

# 1. Create a session
SESSION=$(curl -s -X POST "$BASE/api/sessions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"My Workspace"}' | jq -r '.sessionId')

echo "Session: $SESSION"

# 2. Send a message and stream the response
curl -N -X POST "$BASE/api/sessions/$SESSION/messages" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello! What can you help me with?"}'

# 3. Clean up
curl -X DELETE "$BASE/api/sessions/$SESSION" \
  -H "Authorization: Bearer $API_KEY"
```

### Example: JavaScript/TypeScript Client

```typescript
const API_KEY = 'craft_sk_...';
const BASE = 'http://localhost:3847';

// Create session
const session = await fetch(`${BASE}/api/sessions`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ workspaceId: 'My Workspace' }),
}).then(r => r.json());

// Send message and stream events
const response = await fetch(`${BASE}/api/sessions/${session.sessionId}/messages`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ content: 'List the files in /tmp' }),
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const text = decoder.decode(value);
  // Parse SSE events
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      const event = JSON.parse(line.slice(6));
      console.log(`[${event.type}]`, event.text ?? event.tool ?? '');
    }
  }
}
```

## WebSocket Transport

The WebSocket transport speaks the same `MessageEnvelope` protocol as the upstream headless server (`packages/server/`). This means the CLI (`apps/cli/`) and Electron app can connect to this server too.

### Connection

Connect to `/ws` or `/rpc`:

```
ws://localhost:3847/ws
ws://localhost:3847/rpc
```

### Handshake

After the WebSocket connection opens, the client must send a handshake within 5 seconds:

```json
{
  "id": "<uuid>",
  "type": "handshake",
  "protocolVersion": "1.0",
  "token": "craft_sk_...",
  "workspaceId": "optional-workspace-id",
  "clientCapabilities": ["sessions:event"]
}
```

The server responds with a `handshake_ack`:

```json
{
  "id": "<same-uuid>",
  "type": "handshake_ack",
  "protocolVersion": "1.0",
  "clientId": "<server-assigned-uuid>",
  "registeredChannels": [
    "sessions:create",
    "sessions:get",
    "sessions:delete",
    "sessions:sendMessage",
    "sessions:cancel",
    "sessions:respondToPermission",
    "sessions:event"
  ]
}
```

### RPC Requests

Send a request and receive a correlated response:

```json
// Request
{
  "id": "<uuid>",
  "type": "request",
  "channel": "sessions:create",
  "args": [{"workspaceId": "My Workspace", "model": "claude-sonnet-4-6"}]
}

// Response
{
  "id": "<same-uuid>",
  "type": "response",
  "channel": "sessions:create",
  "result": {
    "sessionId": "abc123",
    "workspaceId": "My Workspace",
    "permissionPolicy": "deny-all",
    "status": "idle"
  }
}
```

### RPC Channels

| Channel | Args | Description |
|---------|------|-------------|
| `sessions:create` | `[{workspaceId, model?, permissionPolicy?, enabledSources?, workingDirectory?}]` | Create a new session |
| `sessions:get` | `[]` | List sessions for this API key |
| `sessions:delete` | `[sessionId]` | Delete a session |
| `sessions:sendMessage` | `[{sessionId, content, attachments?}]` | Send message (events via push) |
| `sessions:cancel` | `[sessionId]` | Abort current generation |
| `sessions:respondToPermission` | `[{sessionId, requestId, allowed}]` | Respond to permission request |

### Push Events

After `sessions:sendMessage`, agent events are pushed to the client:

```json
{
  "id": "<uuid>",
  "type": "event",
  "channel": "sessions:event",
  "args": ["<sessionId>", {"type": "text_delta", "text": "Hello!"}],
  "serverId": "http-trigger"
}
```

Clients are automatically subscribed to a session's events when they create the session or send the first message.

### Error Responses

```json
{
  "id": "<request-uuid>",
  "type": "response",
  "channel": "sessions:create",
  "error": {
    "code": "HANDLER_ERROR",
    "message": "workspaceId is required"
  }
}
```

Error codes: `HANDLER_ERROR`, `AUTH_FAILED`, `CHANNEL_NOT_FOUND`, `SESSION_NOT_IDLE`, `PROTOCOL_VERSION_UNSUPPORTED`.

### Heartbeat

The server pings every 30 seconds. Clients that miss 2 consecutive pongs are disconnected. Any message from the client resets the alive counter.

## Shared Services

### SessionPool

Manages `AgentSession` instances with lifecycle management:

- **Concurrency limits** per API key (configurable)
- **Idle eviction** — sessions idle for 30 minutes are automatically disposed
- **Graceful shutdown** — all sessions are aborted and disposed on `SIGINT`/`SIGTERM`

### EventBus

In-process pub/sub for routing `AgentEvent`s to subscribers:

- Sessions can have multiple subscribers (e.g., both an SSE stream and a WS client)
- Subscriber errors are isolated — one bad subscriber doesn't break others
- Subscribers auto-clean on session deletion

### ClientRegistry

Unified tracking for both WebSocket and SSE clients:

- Supports `PushTarget` routing: push to all, to workspace, to specific client, or to session subscribers
- Tracks transport kind (WS vs SSE), API key, workspace, and session subscriptions
- Health endpoint reports client counts by transport

## Relationship to Other Servers

This project coexists with two other servers in the monorepo:

| Server | Package | Transport | Purpose |
|--------|---------|-----------|---------|
| **Headless Server** | `packages/server/` | WebSocket only | Upstream's primary server for Electron thin-client and CLI |
| **HTTP Trigger Server** | `apps/server/` (this) | HTTP/SSE + WebSocket | External integrations, webhooks, scripts |
| **Server Core** | `packages/server-core/` | — (library) | Shared infrastructure: `WsRpcServer`, `SessionManager`, codec, handlers |

The HTTP trigger server depends on `@craft-agent/server-core` for the `MessageEnvelope` codec (serialization/deserialization) and protocol types, ensuring wire-format compatibility with the upstream WebSocket protocol.

The key architectural difference: the headless server uses upstream's `SessionManager` (6000+ lines, UI-aware, multi-client state tracking), while the HTTP trigger server uses a lightweight `AgentSession` wrapper designed for headless/API usage with simpler lifecycle management.

## Configuration

### Server Config (`~/.craft-agent/server-config.json`)

```typescript
interface ServerConfig {
  enabled: boolean;           // Must be true to start
  port: number;               // Default: 3847
  host: string;               // Default: '127.0.0.1'
  apiKeys: StoredApiKey[];    // SHA-256 hashed keys
  rateLimits: {
    requestsPerMinute: number;  // Per API key, default: 30
    concurrentSessions: number; // Global max, default: 5
  };
}
```

### API Key Permissions

Each API key has scoped permissions:

```typescript
interface ApiKeyPermissions {
  workspaceIds: string[];       // Empty = access all
  permissionPolicy: 'deny-all' | 'allow-safe' | 'allow-all';
  maxConcurrentSessions: number;
}
```

- `deny-all` — Agent cannot execute tools without explicit permission
- `allow-safe` — Agent can execute safe tools (read operations)
- `allow-all` — Agent can execute all tools autonomously

The effective policy is `min(apiKey.permissionPolicy, requested)` — a key scoped to `allow-safe` cannot be escalated to `allow-all` even if the session requests it.

## Development

```bash
# Run with hot-reload
bun run dev

# Run tests (132 tests)
bun test

# Run tests in watch mode
bun run test:watch
```

### Test Structure

```
tests/
├── unit/
│   ├── auth.test.ts              # API key validation, rate limiting
│   ├── config.test.ts            # Config load/save, key generation
│   ├── event-bus.test.ts         # Pub/sub, subscriber isolation
│   ├── session-pool.test.ts      # Pool lifecycle, eviction
│   ├── client-registry.test.ts   # Push targeting, transport tracking
│   └── ws-transport.test.ts      # WS handler, protocol roundtrips
└── integration/
    ├── auth.test.ts              # End-to-end auth flows
    ├── health.test.ts            # Health endpoint
    ├── mock-agent.test.ts        # Session with mock agent
    ├── session-lifecycle.test.ts # Create/message/delete flows
    └── dual-transport.test.ts    # WS + HTTP on same port
```
