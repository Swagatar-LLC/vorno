# Craft Agents: Architecture & Remote/Mobile Enablement Analysis

## Table of Contents

- [Current Architecture](#current-architecture)
- [Mobile App Requirements](#mobile-app-requirements)
- [Self-Hostable Remote System](#self-hostable-remote-system)
- [Implementation Phasing](#implementation-phasing)
- [Key Risks & Considerations](#key-risks--considerations)
- [What's Already Well-Positioned](#whats-already-well-positioned)

---

## Current Architecture

Craft Agents is a **Claude-powered desktop agent app** built as a Bun monorepo with Electron:

```
apps/electron/          # Electron desktop app (main + preload + renderer)
apps/viewer/            # Read-only web session viewer (static site)
packages/core/          # Types & utilities (no implementation)
packages/shared/        # Business logic (agent, auth, config, sessions, sources)
packages/ui/            # Reusable React components (SessionViewer, TurnCard, etc.)
packages/mermaid/       # Custom diagram rendering (SVG, no mermaid.js dependency)
```

### Key Architectural Properties

- **No server tier** - All logic runs in the Electron main process (Node.js)
- **Event-driven agent** - `CraftAgent.chat()` returns an async generator of typed `AgentEvent[]`
- **IPC transport** - Events flow from main process to renderer via Electron IPC (~100 channels in `ipc.ts`)
- **JSONL persistence** - Sessions stored as `session.jsonl` files on local disk (append-only, compacted as needed)
- **Per-session isolation** - Each session gets its own agent instance, permission state, MCP connections
- **Headless mode exists** - `HeadlessRunner` in `packages/shared/src/headless/` already runs agents without a UI
- **Local-only credentials** - AES-256-GCM encrypted at `~/.craft-agent/credentials.enc`

### Core Components

#### CraftAgent (`packages/shared/src/agent/craft-agent.ts`)

The central agent class wrapping the Claude Agent SDK. Key responsibilities:
- MCP server connection management
- Permission system via PreToolUse/PostToolUse hooks
- Large result summarization (60KB+ auto-summarized with Haiku)
- Session continuity and recovery
- Event transformation and streaming

Returns an async generator of `AgentEvent` - a discriminated union type defined in `packages/core/src/types/message.ts`:

```typescript
type AgentEvent =
  | { type: 'text_delta'; text: string; turnId?: string; parentToolUseId?: string }
  | { type: 'text_complete'; text: string; isIntermediate?: boolean; turnId?: string }
  | { type: 'tool_start'; toolName: string; toolUseId: string; input: Record<string, unknown>; ... }
  | { type: 'tool_result'; toolUseId: string; result: string; isError: boolean; ... }
  | { type: 'task_backgrounded'; toolUseId: string; taskId: string; ... }
  | { type: 'complete'; usage?: AgentEventUsage }
  | { type: 'typed_error'; error: TypedError }
  | { type: 'source_activated'; sourceSlug: string; originalMessage: string }
  // ... and more
```

#### SessionManager (`apps/electron/src/main/sessions.ts`)

Manages the lifecycle of agent sessions in the Electron main process:

```typescript
class SessionManager {
  private agents = new Map<string, ManagedSession>()

  async createSession(workspaceId: string): Promise<Session>
  async sendMessage(sessionId: string, content: string, options?: SendMessageOptions)
  async stopGeneration(sessionId: string)
}
```

Each `ManagedSession` tracks:
- `agent: CraftAgent` - The agent instance
- `session: Session` - Metadata (id, workspace, timestamps)
- `messages: Message[]` - Conversation history
- `isGenerating: boolean` - Whether the agent is currently running
- `pendingTools: Map<string, string>` - Tools awaiting permission
- `backgroundTasks: Map<string, BackgroundTaskInfo>` - Background operations

#### Permission System

Three-level permission isolation:
- **Session-scoped** - Each session has independent permission mode (`safe` | `ask` | `allow-all`)
- **Workspace-level** - `permissions.json` with blocked tools, allowed Bash patterns, write paths
- **Source-level** - Per-source `permissions.json` auto-scoped to source tools

#### Source Architecture

Unified abstraction over three source types:
- **MCP servers** - HTTP/SSE + stdio transport
- **REST APIs** - Dynamically converted to MCP tools at runtime
- **Local filesystems** - Direct file access

Each source carries its own auth state (OAuth, bearer, API key), connection status, and permissions.

#### Session Persistence

JSONL format at `~/.craft-agent/workspaces/{id}/sessions/{id}/session.jsonl`:
- Line 1 = header (session metadata)
- Lines 2+ = `StoredMessage` records
- Debounced 500ms persistence queue prevents I/O storms
- Atomic writes (temp file + rename)

#### Credential Management

- AES-256-GCM encryption with file-based backend
- Per-credential type-safe IDs (`CredentialId`)
- OAuth token refresh with rate limiting (max 1 per source per 5 seconds)
- OAuth secrets baked at build time via esbuild `--define`

---

## Mobile App Requirements

### The Core Challenge

The agent logic (`packages/shared`) is well-decoupled from Electron, but the app has **no server**. The Electron main process IS the backend. Mobile requires a client-server split.

### What Already Works for Mobile

1. **`packages/ui`** - React components (SessionViewer, TurnCard, markdown rendering) are framework-agnostic React. They could render in React Native Web or be adapted.
2. **`packages/shared`** - Agent orchestration, session storage, auth, config - all pure Node.js/TypeScript with no Electron imports. This is server-side code.
3. **`packages/core`** - Types and utilities, fully portable.
4. **Event-based contract** - `CraftAgent` emits typed events via async generator. Any transport (WebSocket, SSE, HTTP polling) can consume these.
5. **Headless runner** - Already demonstrates running the agent without a UI.

### What Would Be Required

#### Layer 1: Server Extraction (Medium effort)

Extract the Electron main process logic into a standalone server:

| Current (Electron Main Process) | Future (Server) |
|---|---|
| `apps/electron/src/main/sessions.ts` (SessionManager) | HTTP/WebSocket service managing agent lifecycles |
| `apps/electron/src/main/ipc.ts` (~3200 lines, ~100 IPC handlers) | REST API endpoints + WebSocket event stream |
| Local filesystem (`~/.craft-agent/`) | Database-backed storage (sessions, config, credentials) |
| Electron IPC channels | WebSocket channels or SSE streams |

Key files to refactor:
- `packages/shared/src/sessions/storage.ts` - Replace JSONL file I/O with database adapter
- `packages/shared/src/credentials/` - Replace local AES file with server-side secret management
- `packages/shared/src/config/` - Replace filesystem watchers with database/API config

#### Layer 2: API Surface (Medium effort)

Create REST + realtime API endpoints:

```
POST   /api/sessions                    # Create session
GET    /api/sessions                    # List sessions
GET    /api/sessions/:id                # Get session with messages
DELETE /api/sessions/:id                # Delete session
POST   /api/sessions/:id/messages       # Send message (returns stream)
POST   /api/sessions/:id/abort          # Abort current generation
POST   /api/sessions/:id/permissions    # Respond to permission request
GET    /api/sessions/:id/events         # SSE stream for real-time events
POST   /api/workspaces                  # CRUD workspaces
GET    /api/sources                     # List available sources
POST   /api/auth/oauth/:provider        # Initiate OAuth flow
```

The realtime event stream would carry the same `AgentEvent` types already defined in `packages/core/src/types/`.

#### Layer 3: Mobile Client (High effort)

Two viable approaches:

**Option A: React Native**
- Reuse `packages/ui` components where possible (some use web-only APIs like Shiki syntax highlighting)
- Rewrite input/navigation for mobile paradigms
- Native WebSocket client for event streaming
- Push notifications for background session updates

**Option B: WebView/PWA**
- Adapt the existing React renderer for mobile web
- Wrap in Capacitor or similar for native shell
- Less native feel, but much faster to ship
- Could reuse ~70% of existing renderer code

#### Layer 4: Mobile-Specific Concerns

- **Push notifications** for background agent completions
- **Offline support** - Queue messages, sync when connected
- **Permission UX** - Bash/tool approval flows need mobile-friendly UI
- **File attachments** - Camera, photo library, document picker integration
- **Authentication** - Mobile OAuth flows (deep links instead of localhost callback server)
- **Bandwidth** - Streaming events over cellular; consider batching/compression

---

## Self-Hostable Remote System

This is the more transformative change. Here's what a full architecture would look like:

### Target Architecture

```
                    +-----------------------+
                    |    Load Balancer /     |
                    |    Reverse Proxy       |
                    +----------+------------+
                               |
              +----------------+----------------+
              |                                 |
     +--------v--------+            +-----------v-----------+
     |   API Server     |            |   WebSocket Server    |
     |  (REST + Auth)   |            |  (Event Streaming)    |
     +--------+---------+            +-----------+-----------+
              |                                  |
              +----------------+-----------------+
                               |
                    +----------v-----------+
                    |   Agent Service       |
                    |  (CraftAgent pool)    |
                    |  - Session lifecycle  |
                    |  - Tool execution     |
                    |  - MCP connections    |
                    +----------+-----------+
                               |
              +----------------+----------------+
              |                |                 |
     +--------v------+  +-----v-------+  +------v--------+
     |  Session Store |  | Credential  |  |  Config/State |
     |  (Postgres /   |  | Vault       |  |  Store        |
     |   SQLite)      |  | (encrypted) |  |  (DB/Redis)   |
     +---------------+  +-------------+  +---------------+

Clients:
  - Web app (React SPA - adapt existing renderer)
  - Mobile app (React Native or PWA)
  - CLI (extend existing headless runner)
  - API consumers (programmatic access)
```

### Component Breakdown

#### 1. Agent Service (Core - Medium-High effort)

The heart of the system. Wraps `packages/shared` agent logic in a long-running service.

**What exists today:**
- `CraftAgent` class - Already transport-agnostic, emits `AgentEvent` via async generator
- `HeadlessRunner` - Demonstrates non-interactive execution with configurable permission policies
- Session-scoped tool system - Callbacks for auth, permissions, plans
- `ModeManager` - Per-session permission mode tracking

**What's needed:**
- **Agent pool manager** - Multiple concurrent agents across sessions/users
- **Process isolation** - Agent tool execution (especially Bash) needs sandboxing for multi-tenant
- **Resource limits** - Per-user/session token budgets, concurrent session limits
- **Graceful shutdown** - Drain active sessions before restart
- **Health checks** - Agent liveness, MCP connection health

**Critical security concern:** The current permission model assumes a trusted local user. Multi-tenant requires:
- Sandboxed tool execution (containers, VMs, or restricted shells per session)
- No shared filesystem access between users
- Network isolation for MCP server connections
- Rate limiting and abuse prevention

#### 2. Session Persistence (Medium effort)

**Current:** JSONL files at `~/.craft-agent/workspaces/{id}/sessions/{id}/session.jsonl`
- Line 1 = header (metadata), Lines 2+ = messages
- Atomic writes (temp file + rename)
- Debounced 500ms persistence queue

**Required changes:**
- Replace `SessionPersistenceQueue` with database writes
- Replace `listSessions()` file scanning with database queries
- Store attachments in object storage (S3/MinIO) instead of local filesystem
- Keep the `StoredMessage` schema - it's already well-structured for DB columns
- Add user ownership and access control to session records

**Session resume architecture:**
- SDK session files (at `~/.claude/projects/`) need per-user isolation
- `sdkSessionId` mapping must be durable across server restarts
- Consider: SDK sessions are filesystem-based; may need SDK changes or a workaround for cloud deployment

#### 3. Authentication & Multi-Tenancy (High effort)

**Current:** Single-user, local credentials, no user identity concept

**Required:**
- **User authentication** - JWT/session tokens, OAuth login (Google, GitHub, etc.)
- **User isolation** - Workspaces, sessions, credentials all scoped to user
- **API keys** - For programmatic/CI access
- **RBAC** - Admin vs user roles for self-hosted deployments
- **Credential vault** - Per-user encrypted credential storage (replace local `credentials.enc`)
- **OAuth proxy** - Server-side OAuth for sources (Slack, Google, etc.) instead of localhost callbacks

#### 4. Realtime Communication (Medium effort)

**Current:** Electron IPC (synchronous-feeling, reliable, local)

**Required:**
- **WebSocket server** for bidirectional streaming (agent events down, user messages/interrupts up)
- **SSE fallback** for environments where WebSocket isn't available
- **Connection recovery** - Reconnect and replay missed events
- **Event ordering guarantees** - Sequence numbers on events
- **Multiplexing** - Single connection serving multiple session streams

The `AgentEvent` type system in `packages/core/src/types/` is already well-suited for wire serialization - it's plain JSON-serializable objects.

#### 5. Web Client (Medium effort)

**Current renderer** (`apps/electron/src/renderer/`) is a React + Jotai + Tailwind app that communicates via IPC.

**Adaptation path:**
- Replace IPC calls (`window.api.*`) with HTTP/WebSocket client
- Replace Electron-specific features (native file dialogs, deep links, window management)
- The React components, Jotai atoms, event processor, and UI are ~80% reusable
- Add: login/signup, connection status indicators, mobile-responsive layout

The `event-processor/` (pure functions: `processEvent(state, event) -> ProcessResult`) is 100% reusable as-is.

#### 6. CLI Client (Low effort)

**Already mostly built:**
- `HeadlessRunner` in `packages/shared/src/headless/` supports text, JSON, and stream-json output
- Configurable permission policies: `deny-all`, `allow-safe`, `allow-all`
- Session management: fresh, explicit ID, or resume last
- Add: remote server connection (HTTP client), authentication, session selection
- Could become a `craft-agent` CLI similar to `claude` CLI

#### 7. Infrastructure & Deployment (Medium-High effort)

**For self-hosting:**
- **Docker Compose** for single-machine deployment (API + DB + Redis)
- **Helm chart** for Kubernetes deployment
- **Configuration** via environment variables (12-factor app)
- **Database migrations** (sessions, users, workspaces, credentials)
- **Reverse proxy** config (nginx/caddy) with WebSocket support
- **TLS termination** at proxy layer
- **Logging & monitoring** (structured logs, metrics, health endpoints)

**For tool execution sandboxing:**
- Container-per-session for Bash execution
- Or: remote code execution service (like E2B, Modal)
- File system mounts per user/session
- Network policies for MCP server access

See [CONTAINER-ARCHITECTURE.md](./CONTAINER-ARCHITECTURE.md) for detailed container architecture research.

---

## Implementation Phasing

### Phase 1: Server Extraction (Foundation)
- Extract session management into standalone Node.js server
- REST API for session CRUD + message sending
- SSE/WebSocket for event streaming
- SQLite for initial persistence (easy self-hosting)
- Single-user (no auth yet)
- **Enables:** Web client, CLI client, basic remote access

### Phase 2: Web Client
- Adapt existing React renderer for browser
- Replace IPC with HTTP/WebSocket client
- Mobile-responsive layout
- **Enables:** Browser-based access, basic mobile web

### Phase 3: Authentication & Multi-Tenancy
- User accounts, JWT auth, API keys
- Per-user session/workspace isolation
- Server-side OAuth for sources
- Credential vault per user
- **Enables:** Multi-user deployments, shared infrastructure

### Phase 4: Sandboxed Execution
- Container-based tool execution
- Per-user filesystem isolation
- Network policies
- Resource limits
- **Enables:** Safe multi-tenant self-hosting

### Phase 5: Mobile Native (Optional)
- React Native app or Capacitor wrapper
- Push notifications
- Native file/camera integration
- Offline queuing
- **Enables:** First-class mobile experience

---

## Key Risks & Considerations

### 1. Claude Agent SDK Coupling
The SDK stores session transcripts on the local filesystem (`~/.claude/projects/`). A server deployment needs either per-user SDK directories or SDK changes for pluggable storage. The `sdkSessionId` mapping in `Session` objects ties sessions to filesystem state.

### 2. MCP Server Locality
Stdio-based MCP servers (local processes) won't work remotely. Only HTTP/SSE MCP servers work in a server deployment. Users with local MCP servers would need an MCP proxy or bridge. The source system currently supports both transport types - remote deployment would restrict to HTTP/SSE only, or require a sidecar proxy pattern.

### 3. Bash Tool in Multi-Tenant
The biggest security concern. The agent executes arbitrary Bash commands via the SDK. Multi-tenant deployment requires strong sandboxing:
- Container-per-session isolation
- Restricted filesystem access
- Network policy enforcement
- Resource limits (CPU, memory, disk)
- Consider whether to support Bash at all in hosted mode, or only in self-hosted single-user deployments

### 4. Credential Management
Moving from local encrypted file to server-side vault is a significant security surface change. Currently uses AES-256-GCM with file backend. Multi-user requires:
- Per-user encryption keys or server-side secret management
- Secure OAuth token storage with proper access controls
- API key rotation and revocation
- Audit logging for credential access

### 5. Streaming Reliability
WebSocket connections drop. Need event replay, sequence numbers, and reconnection logic. The current IPC model never drops events. Solutions:
- Event sequence numbers per session
- Server-side event buffer for replay on reconnect
- Client-side gap detection and re-sync

### 6. Cost/Resource Management
Multi-user means multiple concurrent Claude API calls. Need:
- Per-user token budgets
- Concurrent session limits
- Queue management for API rate limits
- Usage tracking and billing integration

### 7. OAuth Secret Distribution
Currently OAuth client secrets are baked into the Electron binary at build time via esbuild `--define`. A server deployment moves these to environment variables or secret management, which is cleaner but requires different distribution.

---

## What's Already Well-Positioned

The codebase has several architectural strengths for this transition:

| Strength | Details |
|---|---|
| **CraftAgent is transport-agnostic** | Returns async generator of events, no IO awareness |
| **Event types are well-defined** | `AgentEvent` union type in `packages/core` is JSON-serializable |
| **Event processor is pure** | `processEvent()` has zero side effects, fully reusable |
| **Business logic is in `packages/shared`** | Not in Electron-specific code |
| **Headless mode exists** | `HeadlessRunner` proves the agent can run without a UI |
| **UI components are in `packages/ui`** | Separated from Electron renderer, reusable in web/mobile |
| **Session format is structured** | `StoredMessage` schema maps cleanly to DB columns |
| **Permission system is session-scoped** | `ModeManager` already isolates per-session, no global state |
| **Source abstraction is unified** | MCP, API, and local sources share one interface |
| **Viewer app exists** | `apps/viewer/` demonstrates rendering sessions outside Electron |
