# Container Architecture for Self-Hosted Multi-Tenant Agent Deployment

Research document for containerizing the Vorno system -- currently an Electron desktop app
with all logic in the main process -- for self-hosted, multi-tenant remote deployment.

**Version:** 0.1 (Research Draft)
**Date:** 2026-02-06

---

## Table of Contents

1. [Current Architecture Overview](#1-current-architecture-overview)
2. [Container Isolation Models](#2-container-isolation-models)
3. [Bash/Tool Execution Sandboxing](#3-bashtool-execution-sandboxing)
4. [Per-Tenant Filesystem and Network Isolation](#4-per-tenant-filesystem-and-network-isolation)
5. [Session Storage in Containerized Environments](#5-session-storage-in-containerized-environments)
6. [MCP Server Connectivity from Containers](#6-mcp-server-connectivity-from-containers)
7. [Container Orchestration Patterns](#7-container-orchestration-patterns)
8. [Existing Open-Source Agent Sandboxing Solutions](#8-existing-open-source-agent-sandboxing-solutions)
9. [Monorepo Structure for Server and Container Images](#9-monorepo-structure-for-server-and-container-images)
10. [Recommended Architecture](#10-recommended-architecture)

---

## 1. Current Architecture Overview

The Vorno system is a monorepo with these key packages:

```
vorno/
  packages/
    core/         # Shared TypeScript types (Workspace, Session, Message, AgentEvent)
    shared/       # Core business logic: CraftAgent, MCP, sessions, config, headless mode
    ui/           # React UI components
    mermaid/      # Diagram rendering
  apps/
    electron/     # Desktop app (Electron main + renderer)
    viewer/       # Web viewer
```

### Key Runtime Components

- **CraftAgent** (`packages/shared/src/agent/craft-agent.ts`): Wraps `@anthropic-ai/claude-agent-sdk`.
  Manages MCP connections, tool permissions, session lifecycle.
- **SessionManager** (`apps/electron/src/main/sessions.ts`): Manages active sessions, config
  watchers, MCP server building, and agent lifecycle from the Electron main process.
- **HeadlessRunner** (`packages/shared/src/headless/runner.ts`): Non-interactive execution mode.
  Already supports streaming events, permission policies, and session resume. This is the most
  natural extraction point for containerization.
- **Session Storage**: Files at `~/.craft-agent/workspaces/{id}/sessions/{sessionId}/session.jsonl`
  with subdirectories for attachments, plans, downloads, and long responses.
- **Source/MCP Config**: Stored at `~/.craft-agent/workspaces/{id}/sources/{slug}/config.json`.
  Supports `stdio` (local subprocess), `http`, and `sse` transports.
- **Credentials**: AES-256-GCM encrypted at `~/.craft-agent/credentials.enc`.

### What Needs to Run in a Container

```
+------------------------------------------------------------------+
|  API Gateway / Load Balancer                                      |
+------------------------------------------------------------------+
         |                    |                    |
   +----------+        +----------+        +----------+
   | Session  |        | Session  |        | Session  |
   | Worker   |        | Worker   |        | Worker   |
   |          |        |          |        |          |
   | CraftAgent        | CraftAgent        | CraftAgent
   | MCP clients       | MCP clients       | MCP clients
   | Bash exec         | Bash exec         | Bash exec
   | File I/O          | File I/O          | File I/O
   +----------+        +----------+        +----------+
         |                    |                    |
   +--------------------------------------------------+
   |  Shared Storage (workspace configs, sessions)     |
   +--------------------------------------------------+
```

---

## 2. Container Isolation Models

### 2.1 Model Comparison

| Aspect | Container-per-Session | Container-per-User | Shared Container (Pool) |
|--------|----------------------|--------------------|-----------------------|
| **Isolation** | Best: each session gets its own filesystem, network, PID namespace | Good: sessions for one user share a container but are isolated from other users | Weakest: multiple users share a container, rely on process-level isolation |
| **Resource efficiency** | Worst: one container per active session; idle sessions consume memory | Moderate: amortized across sessions per user | Best: fewer containers, higher utilization |
| **Startup latency** | 1-5s per new session (container start) | Warm for subsequent sessions (container already running) | Near-zero (process fork within existing container) |
| **Scaling** | Linear with sessions; can be hundreds of containers | Linear with users; typically 10-100x fewer containers | Fixed pool; scale by adding workers to pool |
| **Blast radius** | Minimal: compromised session affects nothing else | Moderate: compromised container exposes all user sessions | Large: compromised container exposes all users |
| **Complexity** | High: orchestration overhead, storage management | Moderate: lifecycle tied to user activity | Low: traditional web server scaling |
| **Cost** | Highest: memory and compute per session | Moderate | Lowest |

### 2.2 Container-per-Session (Recommended for Agent Workloads)

This model creates a fresh container for every agent session. It is the gold standard for
AI agent platforms because:

1. **Arbitrary code execution demands strong isolation.** An agent session running `bash` commands
   can do anything within its sandbox. If session A runs `rm -rf /`, only session A's container is
   affected.

2. **Sessions are naturally ephemeral.** Agent sessions last minutes to hours, map cleanly to
   container lifecycles.

3. **Resource limits are per-session.** You can cap CPU, memory, disk, and network per session,
   preventing one runaway agent from affecting others.

4. **Clean slate guarantees.** Each session starts from a known-good base image. No state leakage
   between sessions (important for security and reproducibility).

**Startup latency mitigation strategies:**

- **Pre-warmed container pool:** Keep N containers pre-created and ready. When a session starts,
  assign a pre-warmed container instead of creating one from scratch. Replenish the pool
  asynchronously.
- **Checkpoint/restore (CRIU):** Snapshot a container after initialization (dependencies installed,
  Node.js runtime warm) and restore from checkpoint in <500ms.
- **Slim base images:** Use distroless or Alpine-based images. A Node.js Alpine image with
  pre-installed dependencies can start in <2s.
- **Container reuse with reset:** Instead of destroying and recreating, reset a container's
  filesystem (overlay reset) and reuse it.

### 2.3 Hybrid Model: Container-per-User with Session Isolation

A practical compromise for self-hosted deployments where container counts need to stay low:

```
+-----------------------+
| User Container        |
| +-------------------+ |
| | Session 1 (nsjail)| |  <-- Process-level sandbox per session
| +-------------------+ |
| +-------------------+ |
| | Session 2 (nsjail)| |  <-- Separate mount namespace, PID ns
| +-------------------+ |
| +-------------------+ |
| | MCP Sidecar       | |  <-- Shared MCP connections for user
| +-------------------+ |
+-----------------------+
```

Each user gets a long-lived container. Within it, each session runs in a lightweight sandbox
(nsjail, bubblewrap, or seccomp profile). This gives:

- Container-level isolation between users (strong)
- Process-level isolation between sessions (moderate, but fast)
- Shared MCP connections (efficient)
- Near-zero startup latency for new sessions

### 2.4 Decision Framework

```
Do you need to run arbitrary bash commands?
  YES --> Do you trust the users?
    NO (public/unknown users) --> Container-per-Session with gVisor
    YES (internal team) --> Container-per-User with nsjail per session
  NO (read-only agent) --> Shared Container with process isolation
```

---

## 3. Bash/Tool Execution Sandboxing

The Vorno system uses the Claude Agent SDK's Bash tool for arbitrary command execution.
This is the single highest-risk component in a multi-tenant deployment. Below is a thorough
comparison of sandboxing technologies.

### 3.1 Technology Comparison

| Technology | Isolation Level | Startup Time | Memory Overhead | Complexity | Kernel Required | Best For |
|-----------|----------------|--------------|-----------------|------------|-----------------|----------|
| **gVisor (runsc)** | High (user-space kernel) | ~150ms | ~20-50MB | Medium | Linux only | Production multi-tenant |
| **Firecracker** | Highest (microVM) | ~125ms | ~5MB + guest OS | High | Linux + KVM | AWS-scale multi-tenant |
| **Sysbox** | High (enhanced containers) | ~1-2s | ~10MB | Low | Linux 5.12+ | Docker-in-Docker |
| **nsjail** | Medium-High (namespaces + seccomp) | <10ms | <1MB | Low | Linux only | Per-command sandboxing |
| **bubblewrap (bwrap)** | Medium (namespaces) | <10ms | <1MB | Low | Linux only | Lightweight sandboxing |
| **Docker-in-Docker** | Low-Medium | ~2-5s | ~50MB | Low | Linux | CI/CD pipelines |
| **seccomp-bpf only** | Low (syscall filter) | <1ms | 0 | Medium | Linux only | Syscall restriction |

### 3.2 gVisor (runsc)

gVisor intercepts application syscalls in user-space via its Sentry kernel. The application
thinks it is talking to a Linux kernel, but gVisor handles (or denies) each syscall.

**Architecture:**
```
+-------------------+
| Agent Process     |
| (Node.js + bash)  |
+-------------------+
        | syscalls
+-------------------+
| gVisor Sentry     |  <-- User-space kernel
| (Go application)  |
+-------------------+
        | limited syscalls
+-------------------+
| Host Linux Kernel |
+-------------------+
```

**Pros:**
- Strong syscall-level isolation without hardware virtualization
- Compatible with OCI runtime (drop-in replacement for runc)
- Battle-tested at Google (used for Google Cloud Run, App Engine)
- Works with Docker and Kubernetes (RuntimeClass)
- Network filtering via netstack (user-space TCP/IP stack)

**Cons:**
- Some syscall incompatibilities (older programs, specific ioctls)
- ~5-15% performance overhead for I/O-heavy workloads
- Not all filesystem operations are fully supported
- Linux only (no macOS development)

**Suitability for Vorno:** Excellent. Agent bash commands are typically short-lived
processes (ls, grep, git, npm). gVisor handles these well. The overhead is acceptable for the
security guarantee.

### 3.3 Firecracker MicroVMs

Firecracker creates lightweight VMs using KVM hardware virtualization. Each microVM has its own
kernel, making it the strongest isolation boundary short of separate physical machines.

**Architecture:**
```
+-------------------+
| Agent Process     |
| (full Linux guest)|
+-------------------+
| Guest Kernel      |
+-------------------+
| Firecracker VMM   |  <-- Minimal virtual machine monitor
+-------------------+
| KVM               |
+-------------------+
| Host Kernel       |
+-------------------+
```

**Pros:**
- Strongest isolation (hardware-enforced)
- ~125ms boot time (with minimal kernel)
- ~5MB memory overhead for VMM (guest OS adds more)
- Used by AWS Lambda and Fargate
- Each VM gets its own kernel -- full syscall compatibility

**Cons:**
- Requires KVM (not available on all cloud instances, not on macOS)
- Guest OS adds memory overhead (~30-128MB per VM depending on distro)
- More complex orchestration (not OCI-compatible, separate API)
- Network setup requires tap devices and bridge configuration
- No native Docker/K8s integration (needs custom tooling or Kata Containers)

**Suitability for Vorno:** Strong but potentially over-engineered for most self-hosted
deployments. Best for operators who need absolute isolation guarantees (financial, healthcare)
or who are running on bare-metal Linux with KVM available.

### 3.4 Sysbox

Sysbox is an OCI runtime that enhances container isolation to allow running system-level
workloads (systemd, Docker, Kubernetes) inside containers without privileged mode.

**Pros:**
- Enables Docker-in-Docker without `--privileged`
- Uses user namespaces, shifted filesystem IDs
- OCI-compatible (works with Docker and K8s)
- Lower complexity than Firecracker

**Cons:**
- Designed for system containers, not minimal sandboxing
- Requires Linux 5.12+ with specific kernel features
- Heavier than nsjail for simple command sandboxing
- Maintained by Nestybox (acquired by Docker Inc.)

**Suitability for Vorno:** Good if agents need Docker-in-Docker capabilities (e.g.,
agent builds and runs containers as part of its work). Otherwise, overkill.

### 3.5 nsjail

nsjail is a lightweight process isolation tool using Linux namespaces, cgroups, and seccomp-bpf.
It can sandbox individual command executions with minimal overhead.

**Architecture:**
```
+----------------------------------+
| Container                        |
|  +----------------------------+  |
|  | nsjail sandbox             |  |
|  | - PID namespace (isolated) |  |
|  | - Mount namespace (tmpfs)  |  |
|  | - Network namespace (none) |  |
|  | - cgroup limits            |  |
|  | - seccomp filter           |  |
|  |                            |  |
|  | > bash -c "user command"   |  |
|  +----------------------------+  |
+----------------------------------+
```

**Pros:**
- Near-zero overhead (<10ms startup, <1MB memory)
- Per-command sandboxing (wrap each bash invocation)
- Fine-grained control: mount points, network, cgroups, rlimits, seccomp
- Proven at Google (used for CTF challenges, build systems)
- Can be used INSIDE containers for defense-in-depth

**Cons:**
- Linux only
- Requires CAP_SYS_ADMIN or user namespaces enabled
- Configuration is per-execution (JSON/protobuf config files)
- Less mature ecosystem than Docker/gVisor

**Suitability for Vorno:** Excellent for per-command sandboxing. The agent's Bash tool
could wrap every command execution in nsjail, providing isolation even within a shared container.
This is the recommended approach for the hybrid model.

### 3.6 bubblewrap (bwrap)

bubblewrap is a simpler alternative to nsjail, originally created for Flatpak. Uses unprivileged
user namespaces for sandboxing.

**Pros:**
- Works without root (unprivileged user namespaces)
- Very simple command-line interface
- Used by Flatpak (well-maintained)
- Minimal dependencies

**Cons:**
- Less feature-rich than nsjail (no cgroup limits, limited seccomp)
- No built-in resource limiting (need external cgroup management)
- Less suitable for complex sandboxing requirements

**Suitability for Vorno:** Suitable for lightweight sandboxing on systems where nsjail
is not available. Not recommended as primary sandboxing for untrusted code execution due to
limited resource controls.

### 3.7 Docker-in-Docker (DinD)

Running Docker daemon inside a container, allowing the agent to create its own containers.

**Pros:**
- Familiar Docker API
- Each agent command runs in a fresh sub-container
- Good ecosystem tooling

**Cons:**
- Historically required `--privileged` flag (security nightmare)
- Sysbox mitigates this but adds complexity
- Nested container overhead is significant
- Storage driver issues (overlay-in-overlay)
- Startup time for inner containers adds latency

**Suitability for Vorno:** Generally not recommended. The overhead and complexity do not
justify the benefits for typical agent command execution. If agents need to build Docker images,
use Sysbox or kaniko instead.

### 3.8 Recommended Sandboxing Stack

```
Tier 1 (Container boundary):  gVisor runtime (runsc) or standard runc
Tier 2 (Per-command sandbox):  nsjail wrapping each bash execution
Tier 3 (Syscall filtering):   seccomp-bpf profile (deny dangerous syscalls)
Tier 4 (Capability dropping): Drop all capabilities except CAP_NET_RAW if needed
```

For the Vorno Bash tool integration, the recommended approach is to modify the command
execution path to wrap commands:

```typescript
// Instead of:
exec(`bash -c "${command}"`)

// Use:
exec(`nsjail --config /etc/nsjail/agent-sandbox.cfg -- bash -c "${command}"`)
```

---

## 4. Per-Tenant Filesystem and Network Isolation

### 4.1 Filesystem Isolation Strategies

#### Overlay Filesystems

Overlay filesystems (OverlayFS) provide copy-on-write semantics, allowing each session to have
its own writable layer on top of a shared read-only base.

```
+---------------------------+
| Session writable layer    |  <-- Per-session tmpfs or volume
|  (user modifications)     |
+---------------------------+
| Workspace config layer    |  <-- Per-user/workspace (read-only)
|  (sources, permissions)   |
+---------------------------+
| Base image layer          |  <-- Shared across all sessions
|  (OS, Node.js, tools)     |
+---------------------------+
```

**Implementation options:**

1. **Docker's built-in overlay:** Each container automatically gets its own overlay. Container
   destruction cleans up the writable layer. Simple and effective.

2. **Explicit OverlayFS mounts inside container:** For the hybrid model (container-per-user),
   use OverlayFS to create per-session filesystems:
   ```bash
   mount -t overlay overlay \
     -o lowerdir=/base,upperdir=/sessions/$SID/upper,workdir=/sessions/$SID/work \
     /sessions/$SID/merged
   ```

3. **tmpfs for ephemeral sessions:** Mount a tmpfs for the session's working directory. Fast,
   RAM-backed, automatically cleaned up. Good for sessions that do not need persistence:
   ```yaml
   # docker-compose
   tmpfs:
     - /workspace:size=1G
   ```

#### Vorno Filesystem Layout in Container

```
/app/                              # Application code (read-only)
  packages/shared/                 # Shared package
  node_modules/                    # Dependencies

/home/agent/.craft-agent/          # Agent config directory
  config.json                      # Mounted from host/shared storage
  credentials.enc                  # Mounted per-tenant (encrypted)
  workspaces/{id}/                 # Workspace configs
    sources/{slug}/config.json     # MCP server configurations
    sessions/{sid}/                # Session data
      session.jsonl                # Conversation history
      attachments/                 # File attachments
      plans/                       # Safe Mode plans
      downloads/                   # Downloaded files

/workspace/                        # Agent's working directory (per-session)
  (cloned repos, created files)    # Ephemeral or volume-backed
```

#### Volume Strategy by Lifecycle

| Data Type | Lifecycle | Storage Strategy |
|-----------|-----------|-----------------|
| Application code | Immutable per version | Baked into image |
| Workspace config | Per-user, mutable | Named volume or PVC |
| Session data | Per-session, append-only | Named volume (persist) or tmpfs (ephemeral) |
| Working directory | Per-session, ephemeral | tmpfs or ephemeral volume |
| Credentials | Per-user, sensitive | Secret mount (K8s Secret, Docker Secret) |
| MCP source configs | Per-workspace, mutable | Named volume shared with config |

### 4.2 Network Isolation

#### Container Network Policies

```
+-----------+     +-----------+     +-----------+
| Session A |     | Session B |     | Session C |
| (net: A)  |     | (net: B)  |     | (net: C)  |
+-----+-----+     +-----+-----+     +-----+-----+
      |                 |                 |
      |   NO LATERAL    |   NO LATERAL    |
      |   TRAFFIC       |   TRAFFIC       |
      |                 |                 |
+-----+-----------------+-----------------+-----+
|            Gateway / Proxy Network             |
+-----+-----------------+-----------------+-----+
      |                 |                 |
+-----+-----+     +-----+-----+     +-----+-----+
| MCP Proxy |     | Anthropic |     | External  |
| Service   |     | API       |     | APIs      |
+-----------+     +-----------+     +-----------+
```

**Docker Compose approach:**
```yaml
services:
  session-worker:
    networks:
      - session-internal    # No inter-container access
      - api-gateway         # Access to API proxy only
    dns:
      - 10.0.0.2            # Internal DNS only

networks:
  session-internal:
    internal: true          # No external access
    driver_opts:
      com.docker.network.bridge.enable_icc: "false"  # No inter-container
  api-gateway:
    driver: bridge
```

**Kubernetes approach:**
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: session-isolation
spec:
  podSelector:
    matchLabels:
      app: session-worker
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api-gateway
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: mcp-proxy
    - to:                     # Allow Anthropic API
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - port: 443
          protocol: TCP
```

#### Network Isolation per Session (within a container)

For the hybrid model, use Linux network namespaces per session:

```bash
# Create isolated network namespace for session
ip netns add session-$SID
# Only allow traffic to specific endpoints via veth pair
ip link add veth-$SID type veth peer name veth-$SID-ns
ip link set veth-$SID-ns netns session-$SID
# Run command in isolated network namespace
ip netns exec session-$SID bash -c "$COMMAND"
```

Or delegate this to nsjail which handles network namespace creation automatically:

```protobuf
# nsjail config
mount { src: "/workspace" dst: "/workspace" is_bind: true }
clone_newnet: true     # Isolate network
clone_newpid: true     # Isolate PID space
clone_newns: true      # Isolate mount namespace
```

### 4.3 DNS Isolation

Prevent sessions from resolving internal hostnames that they should not access:

```
# Per-container /etc/resolv.conf
nameserver 10.0.0.2        # Internal DNS that filters queries
search session.internal     # Restrict search domain
options ndots:1 timeout:5
```

Use CoreDNS (in Kubernetes) or dnsmasq (in Docker Compose) to filter DNS queries per tenant,
allowing only pre-approved external domains plus required services (Anthropic API, configured
MCP servers).

---

## 5. Session Storage in Containerized Environments

### 5.1 Current Storage Model

The Vorno app and its Claude Agent SDK dependency store session data at:

```
~/.craft-agent/workspaces/{workspaceId}/sessions/{sessionId}/
  session.jsonl          # Header (line 1) + messages (lines 2+)
  attachments/           # User-uploaded files
  plans/                 # Safe Mode execution plans
  long_responses/        # Summarized tool results (full copies)
  downloads/             # Binary files from API sources
```

Key code paths:
- `getSessionPath()` in `packages/shared/src/sessions/storage.ts` constructs the path
- `sessionPersistenceQueue` provides debounced async writes (500ms)
- Sessions use JSONL format (append-friendly, crash-recoverable)

### 5.2 Challenges in Ephemeral Containers

1. **Container destruction loses session data** unless externally persisted
2. **Concurrent access**: If multiple containers need to read the same workspace config
3. **Session resume**: The HeadlessRunner supports `sessionResume` which requires access to
   previous session files
4. **Credential access**: `credentials.enc` must be available but protected

### 5.3 Storage Strategies

#### Strategy A: Volume-per-Workspace (Recommended for Docker Compose)

```yaml
services:
  session-worker:
    volumes:
      # Workspace config (shared, read-mostly)
      - workspace-${WORKSPACE_ID}:/home/agent/.craft-agent/workspaces/${WORKSPACE_ID}
      # Ephemeral working directory
      - type: tmpfs
        target: /workspace
        tmpfs:
          size: 2147483648    # 2GB

volumes:
  workspace-abc123:
    driver: local
```

**Pros:** Simple, all session data persists. Each workspace's data stays together.
**Cons:** Volume naming requires dynamic management. Cannot easily share volumes across nodes.

#### Strategy B: Shared NFS/Object Storage (Recommended for Kubernetes)

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: craft-agent-storage
spec:
  accessModes:
    - ReadWriteMany       # NFS, EFS, or CephFS
  resources:
    requests:
      storage: 100Gi
  storageClassName: nfs-csi
---
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: session-worker
      volumeMounts:
        - name: agent-storage
          mountPath: /home/agent/.craft-agent
          subPath: tenants/${TENANT_ID}
  volumes:
    - name: agent-storage
      persistentVolumeClaim:
        claimName: craft-agent-storage
```

**Pros:** Shared across nodes, sessions survive container migration, central backup.
**Cons:** NFS performance (especially for many small JSONL appends), complexity.

#### Strategy C: Database-Backed Session Store (Recommended for Scale)

Replace filesystem-based session storage with a database backend:

```
+-------------------+     +------------------+
| Session Worker    | --> | PostgreSQL /     |
| (ephemeral)       |     | Redis / SQLite   |
+-------------------+     +------------------+
                               |
                          +----+----+
                          | Object  |
                          | Storage |  <-- Attachments, downloads
                          | (S3/R2) |
                          +---------+
```

This requires refactoring `packages/shared/src/sessions/storage.ts` to use a pluggable
storage backend:

```typescript
// Proposed interface
interface SessionStorageBackend {
  // Session CRUD
  createSession(workspaceId: string, config: SessionConfig): Promise<string>;
  loadSession(workspaceId: string, sessionId: string): Promise<StoredSession>;
  appendMessage(workspaceId: string, sessionId: string, message: StoredMessage): Promise<void>;
  listSessions(workspaceId: string): Promise<SessionMetadata[]>;

  // Attachments
  saveAttachment(sessionId: string, file: Buffer, name: string): Promise<string>;
  loadAttachment(sessionId: string, path: string): Promise<Buffer>;
}

// Implementations
class FileSystemBackend implements SessionStorageBackend { /* current behavior */ }
class PostgresBackend implements SessionStorageBackend { /* for scale */ }
class S3Backend implements SessionStorageBackend { /* for attachments */ }
```

**Pros:** Scales horizontally, no shared filesystem needed, structured queries.
**Cons:** Significant refactoring, more infrastructure.

#### Strategy D: Sidecar Persistence Agent

Run a sidecar container that syncs session data from the ephemeral container to durable storage:

```
+-------------------+  local   +------------------+  remote  +----------+
| Session Worker    | <------> | Persistence      | -------> | S3/NFS/  |
| (tmpfs /sessions) |  inotify | Sidecar          |  sync    | Database |
+-------------------+          +------------------+          +----------+
```

The sidecar watches for file changes and syncs to durable storage. On session resume, it
pre-loads session data from durable storage into the local tmpfs.

**Pros:** No changes to existing file-based storage code. Transparent persistence.
**Cons:** Complexity, potential data loss window between writes and sync.

### 5.4 Credential Handling

Credentials (`~/.craft-agent/credentials.enc`) require special treatment:

```yaml
# Kubernetes Secret approach
apiVersion: v1
kind: Secret
metadata:
  name: tenant-credentials-${TENANT_ID}
type: Opaque
data:
  credentials.enc: <base64-encoded-encrypted-credentials>
---
# Mount as file in pod
volumeMounts:
  - name: credentials
    mountPath: /home/agent/.craft-agent/credentials.enc
    subPath: credentials.enc
    readOnly: true
volumes:
  - name: credentials
    secret:
      secretName: tenant-credentials-${TENANT_ID}
```

For Docker Compose, use Docker Secrets:
```yaml
services:
  session-worker:
    secrets:
      - tenant_credentials
secrets:
  tenant_credentials:
    file: ./secrets/${TENANT_ID}/credentials.enc
```

### 5.5 Recommended Approach by Deployment Scale

| Scale | Sessions | Storage Strategy |
|-------|----------|-----------------|
| Single machine (Docker Compose) | 1-50 | Volume-per-workspace (Strategy A) |
| Small cluster (K8s, 1-5 nodes) | 50-500 | Shared NFS (Strategy B) |
| Large cluster (K8s, 5+ nodes) | 500+ | Database + Object Storage (Strategy C) |

---

## 6. MCP Server Connectivity from Containers

### 6.1 MCP Transport Types in Vorno

The codebase (`packages/shared/src/sources/server-builder.ts`) supports three MCP transports:

```typescript
export type McpServerConfig =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };
```

Each type has different containerization challenges:

| Transport | How It Works | Container Challenge |
|-----------|-------------|-------------------|
| `http` | HTTPS to remote server | Straightforward; needs network egress |
| `sse` | Server-Sent Events to remote | Straightforward; needs long-lived connection |
| `stdio` | Local subprocess (stdin/stdout) | **Hard**: subprocess must run somewhere |

### 6.2 HTTP/SSE MCP Servers (Remote)

Remote MCP servers are the simplest to handle. The session container makes outbound HTTPS
requests to the MCP server URL.

```
+-------------------+       HTTPS        +------------------+
| Session Container | -----------------> | Remote MCP       |
| (CraftMcpClient)  |   (with auth)     | Server           |
+-------------------+                    +------------------+
```

**Requirements:**
- Network egress to MCP server URLs (configure in network policy)
- Auth tokens/headers available in container (from credentials mount)
- DNS resolution for MCP server hostnames

**No architectural changes needed** -- the existing `CraftMcpClient` works as-is from containers.

### 6.3 stdio MCP Servers (Local Subprocess)

stdio MCP servers are launched as child processes. The MCP client communicates via stdin/stdout
pipes. This is the most common type for development tools (filesystem, git, database).

**Problem:** In a containerized deployment, the MCP server binary must be available inside the
container, and its execution must be sandboxed.

**Option A: Bundle MCP servers in session image**

```dockerfile
FROM node:22-alpine
# Install common MCP servers
RUN npm install -g @modelcontextprotocol/server-filesystem
RUN npm install -g @modelcontextprotocol/server-github
# ... more servers
COPY . /app
```

Pros: Simple, self-contained. Cons: Image bloat, can't add servers without rebuild.

**Option B: Sidecar MCP containers**

Run each stdio MCP server as its own sidecar container, connected via Unix socket or TCP:

```
+-------------------+     socket     +-------------------+
| Session Container | ------------> | MCP Server        |
| (CraftMcpClient)  |              | Container (stdio) |
+-------------------+               +-------------------+

+-------------------+     socket     +-------------------+
| Session Container | ------------> | MCP Server        |
| (CraftMcpClient)  |              | Container (git)   |
+-------------------+               +-------------------+
```

This requires a stdio-to-socket adapter that:
1. Accepts connections on a Unix socket or TCP port
2. Launches the MCP server process
3. Bridges socket I/O to the process's stdin/stdout

**Option C: MCP Proxy Service**

A shared MCP proxy that manages stdio MCP server processes and exposes them as HTTP/SSE:

```
+-------------------+    HTTP/SSE    +-------------------+    stdio    +--------+
| Session Container | ------------> | MCP Proxy         | ---------> | MCP    |
| (HTTP MCP client) |              | Service           |            | Server |
+-------------------+               +-------------------+            +--------+
                                          |
                                          | stdio    +--------+
                                          +--------> | MCP    |
                                                     | Server |
                                                     +--------+
```

The MCP Proxy:
- Receives HTTP/SSE requests from session containers
- Maps requests to stdio MCP server processes (one per session or shared)
- Handles process lifecycle (start, stop, restart)
- Provides authentication and access control
- Can pool MCP server processes across sessions

**This is the recommended approach.** It cleanly separates MCP server management from session
container management.

**Option D: Streamable HTTP (MCP spec evolution)**

The MCP specification has been evolving toward HTTP-native transports. The newer "Streamable HTTP"
transport replaces SSE with a more standard HTTP-based streaming approach. If all MCP servers
support HTTP transport, the stdio problem disappears. Monitor the MCP spec for this direction.

### 6.4 MCP Proxy Architecture

```
+------------------------------------------------------------------+
|                        MCP Proxy Service                          |
|                                                                   |
|  +-------------------+  +-------------------+  +--------------+  |
|  | Router            |  | Process Manager   |  | Auth Layer   |  |
|  | - path-based      |  | - spawn/kill      |  | - per-tenant |  |
|  | - per-source slug |  | - health check    |  | - token pass |  |
|  +-------------------+  | - pool/reuse      |  +--------------+  |
|                         +-------------------+                     |
|                                                                   |
|  +----------------------------+  +----------------------------+  |
|  | MCP Server: filesystem     |  | MCP Server: github         |  |
|  | (stdio process)            |  | (stdio process)            |  |
|  +----------------------------+  +----------------------------+  |
+------------------------------------------------------------------+
         ^                ^                ^
         | HTTP           | HTTP           | HTTP
+--------+--+    +--------+--+    +--------+--+
| Session A  |    | Session B  |    | Session C  |
+------------+    +------------+    +------------+
```

**API design:**
```
POST /mcp/{tenant-id}/{source-slug}/messages
  --> Routes to appropriate MCP server process
  --> Returns MCP JSON-RPC response

GET /mcp/{tenant-id}/{source-slug}/sse
  --> Opens SSE stream to MCP server
```

**Integration with Vorno:** The `SourceServerBuilder` currently returns `McpServerConfig`
objects. For containerized deployment, override stdio configs with HTTP configs pointing to the
MCP proxy:

```typescript
// Before (desktop):
{ type: 'stdio', command: 'npx', args: ['@modelcontextprotocol/server-filesystem', '/path'] }

// After (container):
{ type: 'http', url: 'http://mcp-proxy:8080/mcp/tenant-123/filesystem', headers: { 'Authorization': 'Bearer ...' } }
```

### 6.5 Service Mesh Considerations

For Kubernetes deployments, a service mesh (Istio, Linkerd) can handle:

- **mTLS between session containers and MCP proxy:** Automatic encryption
- **Rate limiting:** Prevent a single session from overwhelming an MCP server
- **Circuit breaking:** Handle MCP server failures gracefully
- **Observability:** Trace MCP requests across services

However, a service mesh adds significant complexity and is not recommended for initial deployment.
Start with simple NetworkPolicies and add a service mesh only when operational needs demand it.

---

## 7. Container Orchestration Patterns

### 7.1 Docker Compose (Self-Hosted, Single Machine)

Target: Small teams (1-10 users), single server, simple setup.

```yaml
version: "3.9"

services:
  # API Gateway - routes requests to session workers
  api-gateway:
    image: craft-agents/gateway:latest
    ports:
      - "8080:8080"
    environment:
      - SESSION_POOL_SIZE=10
      - MAX_SESSIONS_PER_USER=3
    depends_on:
      - session-manager
      - mcp-proxy
    networks:
      - frontend
      - backend

  # Session Manager - creates/destroys session worker containers
  session-manager:
    image: craft-agents/session-manager:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # Controls Docker
      - workspace-data:/data/workspaces
    environment:
      - WORKER_IMAGE=craft-agents/session-worker:latest
      - MAX_CONCURRENT_SESSIONS=20
      - SESSION_TIMEOUT_MINUTES=120
      - CONTAINER_MEMORY_LIMIT=1g
      - CONTAINER_CPU_LIMIT=1.0
    networks:
      - backend

  # MCP Proxy - manages stdio MCP servers, exposes as HTTP
  mcp-proxy:
    image: craft-agents/mcp-proxy:latest
    volumes:
      - workspace-data:/data/workspaces:ro
    environment:
      - MAX_MCP_PROCESSES=50
    networks:
      - backend
      - mcp-internal

  # Session Worker (template - dynamically created by session-manager)
  # NOT started by compose directly; session-manager creates these
  # Shown here for reference:
  # session-worker:
  #   image: craft-agents/session-worker:latest
  #   runtime: sysbox-runc  # or runsc for gVisor
  #   mem_limit: 1g
  #   cpus: 1.0
  #   tmpfs:
  #     - /workspace:size=2G
  #   volumes:
  #     - workspace-data:/home/agent/.craft-agent:ro
  #   networks:
  #     - backend
  #     - mcp-internal

  # Redis - session metadata, pub/sub for events
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    networks:
      - backend

volumes:
  workspace-data:
  redis-data:

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
    internal: true
  mcp-internal:
    driver: bridge
    internal: true
```

### 7.2 Session Worker Lifecycle

```
Client Request
      |
      v
+-------------+     1. Find/create session    +------------------+
| API Gateway | ---------------------------->  | Session Manager  |
+-------------+                                +------------------+
      |                                              |
      |  2. WebSocket to worker                      | 3. docker create
      |                                              |    + docker start
      v                                              v
+------------------+                          +------------------+
| Session Worker   | <--- 4. Assigned ------- | Container Pool   |
| (container)      |                          | (pre-warmed)     |
+------------------+                          +------------------+
      |
      | 5. HeadlessRunner.runStreaming()
      | 6. Stream events back via WebSocket
      | 7. On completion/timeout: container recycled
      v
```

### 7.3 Kubernetes (Scalable Deployment)

Target: Larger teams (10-1000+ users), multi-node clusters, production SLA.

**Core Resources:**

```yaml
# Session Worker as a Job (one per session)
apiVersion: batch/v1
kind: Job
metadata:
  name: session-${SESSION_ID}
  labels:
    app: session-worker
    tenant: ${TENANT_ID}
    session: ${SESSION_ID}
spec:
  ttlSecondsAfterFinished: 300
  activeDeadlineSeconds: 7200    # 2 hour max
  template:
    spec:
      runtimeClassName: gvisor   # Use gVisor for isolation
      serviceAccountName: session-worker
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: worker
          image: craft-agents/session-worker:latest
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
          env:
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: anthropic-api-keys
                  key: ${TENANT_ID}
            - name: MCP_PROXY_URL
              value: "http://mcp-proxy.craft-agents.svc:8080"
            - name: SESSION_ID
              value: ${SESSION_ID}
            - name: WORKSPACE_ID
              value: ${WORKSPACE_ID}
          volumeMounts:
            - name: workspace-config
              mountPath: /home/agent/.craft-agent/workspaces/${WORKSPACE_ID}
              readOnly: true
            - name: session-data
              mountPath: /home/agent/.craft-agent/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}
            - name: workspace-dir
              mountPath: /workspace
      volumes:
        - name: workspace-config
          persistentVolumeClaim:
            claimName: workspace-${WORKSPACE_ID}
        - name: session-data
          emptyDir:
            sizeLimit: 2Gi
        - name: workspace-dir
          emptyDir:
            sizeLimit: 5Gi
      restartPolicy: Never
```

**Alternative: Session Workers as Pods managed by a Custom Controller**

For long-running interactive sessions, a Kubernetes Job is not ideal (Jobs are for batch
workloads). A better pattern is a custom controller (Operator) that manages session Pods:

```
+-------------------+     watch      +-------------------+
| Session Operator  | <------------- | Session CRD       |
| (Go controller)   |               | (custom resource)  |
+-------------------+                +-------------------+
        |
        | create/delete pods
        v
+-------------------+  +-------------------+  +-------------------+
| Session Pod A     |  | Session Pod B     |  | Session Pod C     |
| (tenant-1)        |  | (tenant-2)        |  | (tenant-1)        |
+-------------------+  +-------------------+  +-------------------+
```

Custom Resource Definition:
```yaml
apiVersion: craft-agents.io/v1
kind: AgentSession
metadata:
  name: session-abc123
spec:
  tenantId: tenant-1
  workspaceId: ws-xyz
  model: claude-sonnet-4-20250514
  permissionPolicy: allow-safe
  timeout: 2h
  resources:
    memory: 1Gi
    cpu: "1"
status:
  phase: Running        # Pending, Running, Completed, Failed
  podName: session-abc123-pod
  startedAt: "2026-02-06T10:00:00Z"
  lastActivityAt: "2026-02-06T10:15:00Z"
```

### 7.4 Health Checks

```yaml
# Session worker health check
livenessProbe:
  httpGet:
    path: /health
    port: 8081
  initialDelaySeconds: 5
  periodSeconds: 30
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /ready
    port: 8081
  initialDelaySeconds: 2
  periodSeconds: 10

# Custom activity check for long-running sessions
# Session manager polls this to detect idle sessions
startupProbe:
  httpGet:
    path: /health
    port: 8081
  failureThreshold: 30
  periodSeconds: 2
```

The session worker should expose:
- `GET /health` -- process is alive
- `GET /ready` -- agent is initialized, MCP servers connected
- `GET /activity` -- returns last activity timestamp (for idle timeout)

### 7.5 Init Containers

```yaml
initContainers:
  # 1. Clone workspace repository (if applicable)
  - name: workspace-init
    image: alpine/git
    command: ["git", "clone", "--depth=1", "$(REPO_URL)", "/workspace"]
    volumeMounts:
      - name: workspace-dir
        mountPath: /workspace

  # 2. Install workspace-specific dependencies
  - name: deps-install
    image: craft-agents/session-worker:latest
    command: ["npm", "install"]
    workingDir: /workspace
    volumeMounts:
      - name: workspace-dir
        mountPath: /workspace

  # 3. Verify MCP server connectivity
  - name: mcp-check
    image: craft-agents/session-worker:latest
    command: ["node", "/app/scripts/verify-mcp.js"]
    env:
      - name: MCP_PROXY_URL
        value: "http://mcp-proxy.craft-agents.svc:8080"
```

### 7.6 Autoscaling

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: session-manager-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: session-manager
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: Object
      object:
        metric:
          name: pending_sessions
        describedObject:
          apiVersion: v1
          kind: Service
          name: session-manager
        target:
          type: Value
          value: "5"     # Scale up when >5 pending sessions per manager
```

For the KEDA (Kubernetes Event-Driven Autoscaling) approach:
```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: session-worker-scaler
spec:
  scaleTargetRef:
    name: session-worker-pool
  minReplicaCount: 2          # Pre-warmed pool
  maxReplicaCount: 100
  triggers:
    - type: redis-streams
      metadata:
        address: redis.craft-agents.svc:6379
        stream: session-requests
        consumerGroup: workers
        lagThreshold: "1"     # Scale on queue lag
```

---

## 8. Existing Open-Source Agent Sandboxing Solutions

### 8.1 E2B (e2b.dev)

**What it is:** Cloud sandboxes specifically designed for AI agents. Provides isolated Linux
environments that agents can use for code execution.

**Architecture:**
- Based on Firecracker microVMs
- Each sandbox is a full Linux environment with its own filesystem, network, and processes
- Sandboxes boot in ~150-300ms
- Provides a Python/TypeScript SDK for managing sandboxes
- Includes a filesystem API, process management, and code execution

**Key features:**
- Pre-built templates (with languages, tools pre-installed)
- Persistent sandboxes (survive disconnection)
- Snapshot and restore
- Real-time streaming of stdout/stderr
- Network access (controllable)

**Relevance to Vorno:**
- E2B's model validates the container-per-session approach
- Their Firecracker-based architecture is the gold standard for security
- The SDK pattern (create sandbox, run commands, destroy) maps well to HeadlessRunner
- **Trade-off:** E2B is a hosted service. For self-hosted deployment, you would need to
  replicate the Firecracker orchestration layer. Consider E2B as a managed option for teams
  that do not want to manage infrastructure.

**Open source status:** The SDK is open source. The orchestration layer is proprietary.
However, the `e2b-dev/infra` repo provides the open-source infrastructure components.

### 8.2 Daytona (daytona.io)

**What it is:** Open-source development environment manager. Creates standardized, reproducible
dev environments from configuration.

**Architecture:**
- Server component manages workspace lifecycle
- Supports multiple providers (Docker, AWS, GCP, Azure, Fly.io)
- Workspaces are full development environments (IDE, terminal, tools)
- Uses devcontainer spec for configuration

**Key features:**
- Multi-provider support (run on Docker locally or cloud VMs)
- Git integration (auto-clone repos into workspaces)
- IDE integration (VS Code, JetBrains)
- API for programmatic workspace management
- Workspace templates and prebuilds

**Relevance to Vorno:**
- Daytona's workspace model maps to Vorno's workspace concept
- The provider abstraction is valuable for supporting Docker Compose and K8s
- Git clone + environment setup pattern useful for agent workspaces
- **Trade-off:** Daytona is designed for human developers, not AI agents. It is heavier than
  needed for ephemeral agent sessions (full IDE support, SSH, etc.).

**Open source status:** Fully open source (Apache 2.0).

### 8.3 Devcontainers (VS Code Dev Containers Spec)

**What it is:** An open specification for defining development container configurations.
Originally from VS Code, now an independent spec.

**Architecture:**
- `devcontainer.json` defines container configuration
- Features system for composable tool installation
- Lifecycle hooks (onCreate, postCreate, postStart, postAttach)
- Supports Docker Compose and Kubernetes

**Key features:**
- Standardized environment definition
- Feature marketplace (install tools declaratively)
- Multi-container support via Docker Compose
- Port forwarding and mount configuration
- Pre-build support (GitHub Codespaces, Coder, etc.)

**Relevance to Vorno:**
- Could define the agent session container as a devcontainer
- Features system useful for installing MCP server dependencies
- Lifecycle hooks map to init container patterns
- **Trade-off:** The spec is designed for interactive development, not headless agent sessions.
  The lifecycle model (attach, detach) does not perfectly map to agent session lifecycle.

**Open source status:** Fully open specification, reference implementation open source.

### 8.4 Modal

**What it is:** Serverless container platform. Run any code in the cloud with zero infrastructure
management.

**Architecture:**
- Containers are defined as Python functions with decorators
- Images are built from specifications (not Dockerfiles, though Dockerfiles are supported)
- Containers start in ~100ms (proprietary optimization, likely gVisor + CRIU-like)
- Automatic scaling from zero to thousands
- GPU support

**Key features:**
- Sub-second cold start
- Pay-per-second billing
- Volume mounts (persistent, shared)
- Secrets management
- Scheduled execution (cron)
- Web endpoints
- Queue-based execution

**Relevance to Vorno:**
- Modal's fast container starts validate the pre-warmed pool approach
- Their image specification model (declarative, not Dockerfile) is interesting
- Volume mount semantics map to workspace data needs
- **Trade-off:** Proprietary platform. Useful as a deployment target but not something you can
  self-host. The patterns are worth studying.

### 8.5 Fly.io Machines

**What it is:** Fast-starting VMs (Firecracker-based) with a simple API.

**Architecture:**
- Each Machine is a Firecracker microVM
- Boots in ~300ms
- Can be stopped and started (not destroyed)
- Persistent volumes available
- Anycast networking (global load balancing)

**Key features:**
- Simple REST API for machine management
- Auto-stop on idle (scale to zero)
- Auto-start on request
- Persistent volumes (single-attach)
- Private networking between machines
- GPU machines available

**Relevance to Vorno:**
- Fly Machines' lifecycle (start, stop, destroy) maps well to agent sessions
- Auto-stop on idle solves the "session timeout" problem elegantly
- The private networking model simplifies MCP proxy connectivity
- **Trade-off:** Fly.io is a platform, not self-hostable. The architectural patterns (fast VMs
  with stop/start semantics) are valuable for understanding what is possible.

### 8.6 Additional Solutions

#### Coder (coder.com)
- Open-source remote development platform
- Templates define workspace infrastructure (Terraform)
- Supports Docker, Kubernetes, AWS, GCP, Azure
- Agent-based architecture (coder agent runs in workspace)
- **Relevance:** Strong workspace lifecycle management, but oriented toward human developers

#### Gitpod
- Cloud development environments
- Prebuilds from Git commits
- Based on custom workspace images
- **Relevance:** Prebuild concept useful for agent workspaces with dependencies

#### Kata Containers
- OCI-compatible runtime using lightweight VMs (Firecracker, QEMU, cloud-hypervisor)
- Integrates with Docker and Kubernetes via RuntimeClass
- **Relevance:** Drop-in replacement for runc that provides VM-level isolation.
  Excellent middle ground between gVisor and raw Firecracker.

#### Kubernetes Virtual Kubelet + ACI/Fargate
- Run pods on serverless container infrastructure
- No node management
- **Relevance:** Could run session workers on ACI/Fargate for infinite scale without managing nodes

### 8.7 Comparison Matrix

| Solution | Self-Hostable | Isolation Level | Startup Time | Complexity | Agent-Oriented |
|----------|:------------:|:---------------:|:------------:|:----------:|:--------------:|
| E2B | Partial | Highest (Firecracker) | ~200ms | Low (SDK) | Yes |
| Daytona | Yes | High (container/VM) | ~5-30s | Medium | No (dev-focused) |
| Devcontainers | Yes | Medium (container) | ~5-30s | Low (spec) | No (dev-focused) |
| Modal | No | High (proprietary) | ~100ms | Low (SDK) | Partial |
| Fly.io Machines | No | Highest (Firecracker) | ~300ms | Low (API) | Partial |
| Coder | Yes | High (Terraform) | ~30-120s | High | No (dev-focused) |
| Kata Containers | Yes | Highest (VM) | ~500ms | Medium | No (general) |

---

## 9. Monorepo Structure for Server and Container Images

### 9.1 Current Monorepo Structure

```
craft-agents-oss/
  packages/
    core/             # Types and utilities
    shared/           # Business logic, agent, sessions, MCP
    ui/               # React components
    mermaid/          # Diagram rendering
  apps/
    electron/         # Desktop app
    viewer/           # Web viewer
```

### 9.2 Proposed Structure with Server and Container Images

```
craft-agents-oss/
  packages/
    core/             # Types and utilities (unchanged)
    shared/           # Business logic (unchanged, but with pluggable storage)
    ui/               # React components (unchanged)
    mermaid/          # Diagram rendering (unchanged)
    storage/          # NEW: Pluggable storage backends
      src/
        filesystem.ts     # Current file-based storage
        postgres.ts       # PostgreSQL backend
        s3.ts             # S3 for attachments
        index.ts          # Backend selection
  apps/
    electron/         # Desktop app (unchanged)
    viewer/           # Web viewer (unchanged)
    server/           # NEW: HTTP API server
      src/
        index.ts          # Express/Hono server
        routes/
          sessions.ts     # Session CRUD
          messages.ts     # Send message, stream response
          workspaces.ts   # Workspace management
        middleware/
          auth.ts         # Tenant authentication
          rate-limit.ts   # Per-tenant rate limiting
      Dockerfile          # Server image
    session-worker/   # NEW: Session execution container
      src/
        index.ts          # Worker entry point
        health.ts         # Health/ready/activity endpoints
        executor.ts       # HeadlessRunner wrapper
      Dockerfile          # Worker image
    mcp-proxy/        # NEW: MCP stdio-to-HTTP proxy
      src/
        index.ts          # Proxy server
        process-pool.ts   # MCP process management
        router.ts         # Tenant/source routing
      Dockerfile          # Proxy image
  docker/
    base/
      Dockerfile          # Shared base image
    compose/
      docker-compose.yml          # Single-machine deployment
      docker-compose.dev.yml      # Development overrides
      docker-compose.prod.yml     # Production overrides
    k8s/
      kustomization.yaml
      base/
        session-worker.yaml
        mcp-proxy.yaml
        api-gateway.yaml
        redis.yaml
      overlays/
        dev/
        production/
    nsjail/
      agent-sandbox.cfg          # nsjail configuration for bash execution
  scripts/
    build-images.ts              # Build all Docker images
    push-images.ts               # Push to registry
```

### 9.3 Multi-Stage Dockerfile Pattern

#### Shared Base Image

```dockerfile
# docker/base/Dockerfile
FROM node:22-alpine AS base

# Install runtime dependencies needed by agent sessions
RUN apk add --no-cache \
    git \
    bash \
    curl \
    jq \
    python3 \
    make \
    gcc \
    g++

# Create non-root user
RUN addgroup -g 1000 agent && \
    adduser -D -u 1000 -G agent agent

# Set up agent home directory
RUN mkdir -p /home/agent/.craft-agent && \
    chown -R agent:agent /home/agent

WORKDIR /app
```

#### Session Worker Image

```dockerfile
# apps/session-worker/Dockerfile
FROM craft-agents/base:latest AS deps

# Copy workspace package files for dependency installation
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY apps/session-worker/package.json apps/session-worker/

# Install dependencies
RUN bun install --frozen-lockfile --production

# Build stage
FROM deps AS build

# Copy source
COPY packages/core/ packages/core/
COPY packages/shared/ packages/shared/
COPY apps/session-worker/ apps/session-worker/

# Build
RUN bun run --cwd apps/session-worker build

# Production stage
FROM craft-agents/base:latest AS production

# Copy built application and dependencies
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/session-worker/dist ./apps/session-worker/dist

# Install nsjail for bash sandboxing
RUN apk add --no-cache nsjail
COPY docker/nsjail/agent-sandbox.cfg /etc/nsjail/

USER agent
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8081/health || exit 1

CMD ["node", "apps/session-worker/dist/index.js"]
```

### 9.4 Build and Caching Strategy

```typescript
// scripts/build-images.ts
const IMAGES = [
  { name: 'base', context: '.', dockerfile: 'docker/base/Dockerfile' },
  { name: 'session-worker', context: '.', dockerfile: 'apps/session-worker/Dockerfile' },
  { name: 'mcp-proxy', context: '.', dockerfile: 'apps/mcp-proxy/Dockerfile' },
  { name: 'server', context: '.', dockerfile: 'apps/server/Dockerfile' },
];

// Build with cache
for (const image of IMAGES) {
  await $`docker build \
    --tag craft-agents/${image.name}:${version} \
    --tag craft-agents/${image.name}:latest \
    --file ${image.dockerfile} \
    --cache-from craft-agents/${image.name}:latest \
    --build-arg BUILDKIT_INLINE_CACHE=1 \
    ${image.context}`;
}
```

**Layer caching strategy:**

1. **Base image:** Rarely changes. Cache aggressively.
2. **Dependencies layer:** Changes when `package.json` or `bun.lock` changes.
   Use `COPY package.json` before `COPY source` to maximize cache hits.
3. **Source layer:** Changes frequently. Should be the last layer.
4. **Use BuildKit:** `DOCKER_BUILDKIT=1` enables parallel builds and better caching.

**CI/CD pipeline:**

```yaml
# .github/workflows/build-images.yml
name: Build Container Images
on:
  push:
    branches: [main]
    paths:
      - 'packages/**'
      - 'apps/session-worker/**'
      - 'apps/mcp-proxy/**'
      - 'apps/server/**'
      - 'docker/**'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build base image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/base/Dockerfile
          push: true
          tags: ghcr.io/craft-agents/base:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Build session-worker
        uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/session-worker/Dockerfile
          push: true
          tags: ghcr.io/craft-agents/session-worker:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            BASE_IMAGE=ghcr.io/craft-agents/base:${{ github.sha }}
```

---

## 10. Recommended Architecture

### 10.1 Overview

Based on the research above, here is the recommended architecture for containerizing Vorno
for self-hosted multi-tenant deployment.

```
+------------------------------------------------------------------+
|                         CLIENT LAYER                              |
|  Browser (Vorno Web UI)  |  CLI  |  API Integration        |
+------------------------------------------------------------------+
                         |
                    HTTPS/WSS
                         |
+------------------------------------------------------------------+
|                     API GATEWAY                                    |
|  - Authentication (tenant API keys, OAuth)                        |
|  - Rate limiting (per-tenant)                                     |
|  - WebSocket management (session streaming)                       |
|  - Request routing                                                |
+------------------------------------------------------------------+
          |                    |                    |
     +----+----+         +----+----+         +----+----+
     | Session |         | Session |         | Session |
     | Manager |         | Manager |         | Manager |
     | (HA)    |         | (HA)    |         | (HA)    |
     +---------+         +---------+         +---------+
          |                    |                    |
   +------+------+     +------+------+     +------+------+
   | Session     |     | Session     |     | Session     |
   | Worker      |     | Worker      |     | Worker      |
   | Container   |     | Container   |     | Container   |
   | [gVisor]    |     | [gVisor]    |     | [gVisor]    |
   |             |     |             |     |             |
   | CraftAgent  |     | CraftAgent  |     | CraftAgent  |
   | +nsjail     |     | +nsjail     |     | +nsjail     |
   | bash sandbox|     | bash sandbox|     | bash sandbox|
   +------+------+     +------+------+     +------+------+
          |                    |                    |
          +--------------------+--------------------+
                               |
              +----------------+----------------+
              |                |                |
       +------+------+  +-----+-----+  +-------+------+
       | MCP Proxy   |  | Redis     |  | PostgreSQL / |
       | Service     |  | (pubsub,  |  | Shared       |
       |             |  |  metadata)|  | Storage      |
       +------+------+  +-----------+  +--------------+
              |
       +------+------+
       | MCP Server  |
       | Processes   |
       | (stdio)     |
       +-------------+
```

### 10.2 Component Responsibilities

| Component | Role | Scaling Model |
|-----------|------|---------------|
| **API Gateway** | Auth, routing, WebSocket termination | Horizontal (stateless) |
| **Session Manager** | Create/destroy/monitor session workers | Horizontal (with leader election) |
| **Session Worker** | Run CraftAgent + HeadlessRunner in isolated container | One per session (auto-scaled) |
| **MCP Proxy** | Expose stdio MCP servers as HTTP, manage process pool | Horizontal (shard by tenant) |
| **Redis** | Session metadata, pub/sub for streaming events, pre-warm pool coordination | Single or Redis Cluster |
| **PostgreSQL** | Session history, workspace configs (optional; can use filesystem) | Single or HA pair |

### 10.3 Phased Implementation Plan

#### Phase 1: Headless Server (Weeks 1-4)

**Goal:** Extract the headless execution path into a standalone HTTP server that can run in a
single Docker container.

**Tasks:**
1. Create `apps/server/` with HTTP API (Hono or Express)
2. Expose endpoints: `POST /sessions`, `GET /sessions/:id/stream` (WebSocket)
3. Wrap `HeadlessRunner` with HTTP request handling
4. Single Docker image with all components (no isolation yet)
5. Docker Compose file for single-container deployment

**Deliverable:** `docker compose up` starts a working agent server.

#### Phase 2: Session Isolation (Weeks 5-8)

**Goal:** Run each session in its own container with filesystem and process isolation.

**Tasks:**
1. Create `apps/session-worker/` extracted from the server
2. Session Manager service that creates/destroys worker containers via Docker API
3. Pre-warmed container pool (configurable size)
4. Volume mounting for workspace configs
5. tmpfs for ephemeral session working directories
6. nsjail integration for bash command sandboxing

**Deliverable:** Multi-session deployment with container-per-session isolation.

#### Phase 3: MCP Proxy (Weeks 9-12)

**Goal:** Support stdio MCP servers in containerized deployment.

**Tasks:**
1. Create `apps/mcp-proxy/` service
2. stdio-to-HTTP bridge for MCP servers
3. Process pool management (start, stop, health check)
4. Per-tenant routing and authentication
5. Update `SourceServerBuilder` to support proxy mode

**Deliverable:** Full MCP server support in containers.

#### Phase 4: Kubernetes + Production Hardening (Weeks 13-16)

**Goal:** Production-ready Kubernetes deployment.

**Tasks:**
1. Kubernetes manifests (or Helm chart)
2. gVisor RuntimeClass for session workers
3. NetworkPolicy for session isolation
4. Horizontal pod autoscaling
5. Monitoring and alerting (Prometheus metrics)
6. Pluggable session storage backend (PostgreSQL)

**Deliverable:** Production Kubernetes deployment with autoscaling and monitoring.

### 10.4 Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Isolation model** | Container-per-session | Strongest isolation for arbitrary code execution; clean lifecycle mapping |
| **Container runtime** | gVisor (production), runc (development) | gVisor for multi-tenant security; runc for local development speed |
| **Bash sandboxing** | nsjail inside container | Defense-in-depth; sub-millisecond overhead per command |
| **MCP stdio handling** | MCP Proxy service | Clean separation; avoid bundling all MCP servers in worker image |
| **Session storage** | Filesystem (Phase 1-2), PostgreSQL (Phase 4) | Start simple, refactor for scale |
| **Orchestration** | Docker Compose (small), Kubernetes (scale) | Meet users where they are |
| **Extraction point** | HeadlessRunner | Already supports non-interactive execution, streaming, permission policies |
| **Inter-service comm** | Redis pub/sub + HTTP | Redis for real-time streaming; HTTP for request/response |
| **Base image** | Node.js 22 Alpine | Small image, fast pulls, matches current Bun/Node.js runtime |

### 10.5 Security Checklist

- [ ] Each session runs in its own container (PID, mount, network namespace isolation)
- [ ] gVisor runtime for session workers in production
- [ ] nsjail wrapping all bash command executions within containers
- [ ] No `--privileged` flag on any container
- [ ] Non-root user in all containers (UID 1000)
- [ ] Read-only root filesystem where possible
- [ ] seccomp profile applied (RuntimeDefault or custom)
- [ ] Network policies preventing inter-session communication
- [ ] Credentials mounted as read-only secrets (never baked into images)
- [ ] API keys and tokens never logged or exposed in error messages
- [ ] Resource limits (CPU, memory, disk, PID count) on all session containers
- [ ] Session timeout enforcement (2 hour default, configurable)
- [ ] Rate limiting per tenant at API gateway
- [ ] Audit logging for all session creation/destruction events

### 10.6 Performance Targets

| Metric | Target | Approach |
|--------|--------|----------|
| Session start (cold) | <3s | Slim Alpine image, pre-installed deps |
| Session start (warm) | <500ms | Pre-warmed container pool |
| Bash command overhead | <50ms | nsjail (not container creation per command) |
| MCP server connection | <1s | MCP Proxy keeps processes warm |
| Concurrent sessions | 50+ per node | Resource limits, efficient base image |
| Memory per session | <512MB typical | Alpine + Node.js + agent |

### 10.7 Monitoring and Observability

```
Session Worker Metrics (Prometheus):
  craft_agent_session_duration_seconds      # Histogram
  craft_agent_session_tokens_total          # Counter (input, output, cache)
  craft_agent_session_tool_calls_total      # Counter by tool name
  craft_agent_session_errors_total          # Counter by error type
  craft_agent_bash_execution_seconds        # Histogram
  craft_agent_mcp_request_seconds           # Histogram by server

Session Manager Metrics:
  craft_agent_active_sessions               # Gauge
  craft_agent_pool_available                # Gauge (pre-warmed containers)
  craft_agent_session_start_seconds         # Histogram
  craft_agent_session_queue_depth           # Gauge

MCP Proxy Metrics:
  craft_agent_mcp_processes_active          # Gauge
  craft_agent_mcp_request_total             # Counter by source slug
  craft_agent_mcp_error_total               # Counter
```

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **Session** | A single agent conversation. Maps 1:1 with a CraftAgent instance and an SDK session. |
| **Workspace** | A collection of sources, sessions, and configurations. Stored at `~/.craft-agent/workspaces/{id}/`. |
| **Source** | An external data connection (MCP server, API, or local filesystem). |
| **MCP** | Model Context Protocol. Standard for connecting AI models to tools and data sources. |
| **Tenant** | A user or organization in a multi-tenant deployment. |
| **Session Worker** | A container running a single agent session. |
| **Session Manager** | A service that creates, monitors, and destroys session workers. |
| **MCP Proxy** | A service that bridges stdio MCP servers to HTTP for container access. |

## Appendix B: Reference Configurations

### nsjail Configuration for Agent Bash Sandbox

```protobuf
# docker/nsjail/agent-sandbox.cfg
name: "agent-bash-sandbox"
description: "Sandbox for agent bash command execution"

mode: ONCE
hostname: "sandbox"
cwd: "/workspace"

time_limit: 300          # 5 minute max per command
max_cpus: 1

rlimit_as_type: SOFT
rlimit_as: 1024          # 1GB address space
rlimit_cpu_type: SOFT
rlimit_cpu: 60           # 60 seconds CPU time
rlimit_fsize_type: SOFT
rlimit_fsize: 512        # 512MB max file size
rlimit_nofile_type: SOFT
rlimit_nofile: 256       # 256 open files
rlimit_nproc_type: SOFT
rlimit_nproc: 64         # 64 processes

clone_newnet: false      # Use container's network (already isolated)
clone_newpid: true       # Isolate PID namespace
clone_newns: true        # Isolate mount namespace
clone_newuts: true       # Isolate hostname

mount {
  src: "/workspace"
  dst: "/workspace"
  is_bind: true
  rw: true
}

mount {
  src: "/usr"
  dst: "/usr"
  is_bind: true
  rw: false
}

mount {
  src: "/bin"
  dst: "/bin"
  is_bind: true
  rw: false
}

mount {
  src: "/lib"
  dst: "/lib"
  is_bind: true
  rw: false
}

mount {
  dst: "/tmp"
  fstype: "tmpfs"
  rw: true
  options: "size=256m"
}

mount {
  dst: "/dev"
  fstype: "tmpfs"
  rw: true
}

mount {
  dst: "/proc"
  fstype: "proc"
  rw: false
}

seccomp_string: "ALLOW {"
seccomp_string: "  read, write, open, close, stat, fstat, lstat,"
seccomp_string: "  poll, lseek, mmap, mprotect, munmap, brk,"
seccomp_string: "  ioctl, access, pipe, select, sched_yield,"
seccomp_string: "  mremap, msync, mincore, madvise, dup, dup2,"
seccomp_string: "  nanosleep, getpid, socket, connect, sendto,"
seccomp_string: "  recvfrom, sendmsg, recvmsg, shutdown, bind,"
seccomp_string: "  listen, getsockname, getpeername, socketpair,"
seccomp_string: "  clone, fork, vfork, execve, exit, wait4,"
seccomp_string: "  kill, uname, fcntl, flock, fsync, fdatasync,"
seccomp_string: "  truncate, ftruncate, getdents, getcwd, chdir,"
seccomp_string: "  rename, mkdir, rmdir, link, unlink, symlink,"
seccomp_string: "  readlink, chmod, chown, umask, gettimeofday,"
seccomp_string: "  getuid, getgid, geteuid, getegid, getppid,"
seccomp_string: "  getpgrp, setsid, setpgid, getgroups,"
seccomp_string: "  rt_sigaction, rt_sigprocmask, rt_sigreturn,"
seccomp_string: "  sigaltstack, arch_prctl, set_tid_address,"
seccomp_string: "  set_robust_list, futex, epoll_create,"
seccomp_string: "  epoll_ctl, epoll_wait, clock_gettime,"
seccomp_string: "  exit_group, openat, newfstatat, pread64,"
seccomp_string: "  pwrite64, getdents64, pipe2, dup3,"
seccomp_string: "  epoll_create1, eventfd2, getrandom,"
seccomp_string: "  memfd_create, statx, io_uring_setup,"
seccomp_string: "  io_uring_enter, io_uring_register,"
seccomp_string: "  clone3, close_range, openat2, faccessat2"
seccomp_string: "}"
seccomp_string: "DEFAULT KILL"
```

### Docker Compose Quick Start

```yaml
# docker/compose/docker-compose.yml
#
# Quick start:
#   docker compose up
#
# This starts a single-machine deployment suitable for small teams.

version: "3.9"

services:
  gateway:
    image: craft-agents/gateway:latest
    ports:
      - "8080:8080"
    environment:
      REDIS_URL: redis://redis:6379
      SESSION_MANAGER_URL: http://session-manager:8082
    depends_on:
      redis:
        condition: service_healthy
    networks:
      - frontend
      - backend
    restart: unless-stopped

  session-manager:
    image: craft-agents/session-manager:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - agent-data:/data
    environment:
      REDIS_URL: redis://redis:6379
      WORKER_IMAGE: craft-agents/session-worker:latest
      MCP_PROXY_URL: http://mcp-proxy:8083
      MAX_CONCURRENT_SESSIONS: 20
      PRE_WARM_POOL_SIZE: 3
      SESSION_TIMEOUT_MINUTES: 120
      CONTAINER_MEMORY_LIMIT: 1g
      CONTAINER_CPU_LIMIT: "1.0"
    depends_on:
      redis:
        condition: service_healthy
    networks:
      - backend
    restart: unless-stopped

  mcp-proxy:
    image: craft-agents/mcp-proxy:latest
    volumes:
      - agent-data:/data:ro
    environment:
      MAX_MCP_PROCESSES: 50
      PROCESS_IDLE_TIMEOUT: 300
    networks:
      - backend
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - backend
    restart: unless-stopped

volumes:
  agent-data:
    driver: local
  redis-data:
    driver: local

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
    internal: true
```

---

*This document is a living research artifact. Update it as implementation progresses and
architectural decisions are validated or revised.*
