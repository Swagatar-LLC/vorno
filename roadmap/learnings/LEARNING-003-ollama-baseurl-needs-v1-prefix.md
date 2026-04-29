---
id: LEARNING-003
title: Ollama-compatible LLM connections need `/v1` in baseUrl
date: 2026-04-29
status: active
component: agent / config
related-plans: []
related-decisions: []
---

# LEARNING-003 — Ollama-compatible LLM connections need `/v1` in baseUrl

## Signal

User configures an LLM connection pointing at a local Ollama install (`http://localhost:11434`) with `customEndpoint.api = 'openai-completions'`. Sending a message produces:

```
2026-04-29T05:21:23.796Z INFO   [session] [pi] [subprocess stderr] [pi-server] API error in message_end: 404 404 page not found
2026-04-29T05:21:23.796Z WARN   [session] Session 260429-focal-thunder completed without assistant response - possible context overflow or API issue
```

The exact body `404 page not found` is the Go HTTP server's default 404 response — Ollama is written in Go.

## Root cause

The OpenAI Node SDK (used by `@mariozechner/pi-ai`'s `openai-completions` provider) appends `/chat/completions` directly to the user-provided `baseURL`:

```
fetch(`${baseURL}/chat/completions`, ...)
```

If `baseURL = 'http://localhost:11434'`, the SDK calls `http://localhost:11434/chat/completions`. **Ollama does not expose that path.** Ollama's OpenAI-compatible endpoint is at `/v1/chat/completions` — the `/v1/` prefix is required.

Verification:

```
http://localhost:11434/chat/completions    → 404 page not found
http://localhost:11434/v1/chat/completions → 200 (with valid body)
```

## Fix

Set the connection's `baseUrl` to include `/v1`:

```jsonc
// ~/.craft-agent-swagatar/config.json
{
  "llmConnections": [
    {
      "slug": "anthropic-api",
      "baseUrl": "http://localhost:11434/v1",   // <-- include /v1
      "customEndpoint": { "api": "openai-completions" },
      ...
    }
  ]
}
```

Or via the UI: edit the connection's Base URL field to end with `/v1`.

This applies to **any OpenAI-compatible local server**: Ollama, llama.cpp's server, LocalAI, vLLM, LM Studio's API server, etc. They all expose OpenAI-compat at a `/v1/...` path.

## Recurrence

- **Will hit any user** who configures Ollama via the UI without knowing to add `/v1`.
- The Anthropic-Messages variant (`customEndpoint.api = 'anthropic-messages'`) probably doesn't need `/v1` (Anthropic's path is `/v1/messages` and pi-ai may handle that path differently — needs confirmation).
- Other OpenAI-compat servers behave the same way (`/v1` is the OpenAI convention; the SDK doesn't add it).

## Prevention

Multiple layers possible — pick one or stack them:

1. **Auto-detect in the UI**: when the user enters a baseUrl that doesn't end with `/v1` for an `openai-completions` endpoint, append it (or surface a warning).
2. **Probe on Test Connection**: when the user clicks "Test Connection" in the LLM connection wizard, try both `${baseUrl}` and `${baseUrl}/v1` and surface a clear error. Currently the test silently calls and reports a generic failure.
3. **Documentation**: the LLM connection's Base URL field could show inline help: *"For Ollama / LocalAI / llama.cpp, end with `/v1`."*
4. **Default for known hosts**: when baseUrl is `http://localhost:11434`, `127.0.0.1:11434`, or any host where a GET `/api/tags` returns valid Ollama JSON, auto-append `/v1`.

These are good upstream contribution candidates — the issue is generic to anyone using Ollama with upstream Craft Agents too.

## References

- pi-agent-server's `registerCustomEndpointModels` at `packages/pi-agent-server/src/index.ts:420` — registers the model with `baseUrl` as-given
- pi-ai's `openai-completions` provider — uses `new OpenAI({ baseURL })` from the official OpenAI Node SDK
- The OpenAI SDK's path construction is in `node_modules/openai/` — the SDK appends `/chat/completions` literally
- Ollama OpenAI-compat docs: <https://github.com/ollama/ollama/blob/main/docs/openai.md>
- LEARNING-002 — sibling fork-isolation issue surfaced today; this learning was hit immediately after isolating the fork's config dir, when the user re-onboarded and re-entered Ollama settings
