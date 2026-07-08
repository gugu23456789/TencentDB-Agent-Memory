# Adapter Integration Guide

This document describes how third-party adapters integrate with the TDAI platform.
It covers the connection model, available shared infrastructure, and integration patterns.

## Architecture Overview

```
Third-party adapter (PR #359, #372, #378, #385, ...)
       │
       │  HTTP (REST) or MCP (stdio/SSE)
       ▼
┌─────────────────────────────────────┐
│  TDAI Gateway (:8420)               │
│  ┌──────────┐ ┌──────────────────┐  │
│  │ REST API │ │ Gates (shared):  │  │
│  │ /recall  │ │  - rate-limit    │  │
│  │ /capture │ │  - circuit-break │  │
│  │ /search  │ │  - audit         │  │
│  └──────────┘ └──────────────────┘  │
│  ┌──────────────────────────┐       │
│  │ Observability (shared):  │       │
│  │  - IObservabilityBackend │       │
│  │  - OTLP export           │       │
│  └──────────────────────────┘       │
└──────────────────┬──────────────────┘
                   │
                   ▼
              TdaiCore
            (memory engine)
```

## Connection Model

All adapters connect to TDAI through the Gateway HTTP API, or through MCP stdio.
There is no need to link against or import any TDAI TypeScript/Python SDK — a
simple HTTP client or one-line MCP config is sufficient.

### Option 1: HTTP (REST) — for programmatic access

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/recall` | POST | Recall memory context for a query |
| `/capture` | POST | Capture a conversation turn |
| `/search/memories` | POST | Search structured memories |
| `/search/conversations` | POST | Search conversation history |
| `/session/end` | POST | End a session and flush buffers |
| `/health` | GET | Health check |

**Authentication:** If `GATEWAY_API_KEY` is configured, include it as a Bearer token:

```
Authorization: Bearer <api_key>
```

### Option 2: MCP stdio — for any MCP-compatible client

One-line IDE/config integration. No code to write.

```json
{
  "mcpServers": {
    "bridge-mcp": {
      "command": "python",
      "args": ["-m", "bridge.mcp.server"],
      "env": {
        "TDAI_ENDPOINT": "http://127.0.0.1:8420",
        "TDAI_API_KEY": "<your-key>"
      }
    }
  }
}
```

See `bridge/mcp/INTEGRATION.md` for multi-platform MCP configs.

> **For Dify, Coze, LangFlow etc.:** If the platform supports MCP tools,
> use Option 2 (MCP stdio) — it's the simplest integration path.
> Otherwise, wrap the HTTP REST API (Option 1) as a platform tool.
> Pattern A below is designed exactly for this use case.

All adapters in the current active PRs use this same auth model.

## Integration Patterns

### Pattern A: Direct HTTP Client (simplest)

Used by: PR #372, PR #378

Connect directly to Gateway REST endpoints. No TDAI code dependency.
~100-200 lines of adapter code.

```
adapter → HTTP client → Gateway (:8420) → TdaiCore
```

### Pattern B: HostAdapter (TypeScript native)

Used by: PR #385 (rainforest888)

Extend the `HostAdapter` interface from `src/core/types.ts`.
~60-80 lines per adapter.

See `src/adapters/standalone/host-adapter.ts` for the reference template.

```
adapter → HostAdapter → TdaiCore (in-process)
```

### Pattern C: MemoryPlatformAdapter (custom interface)

Used by: PR #359 (coder-mtj). This is a PR-specific pattern — for new
adapters, prefer Pattern A or D.

```
adapter → PlatformAdapter → GatewayClient → Gateway → TdaiCore
```

### Pattern D: TdaiAdapter (cross-language)

Used by: r3-v1 (our bridge)

Python SDK uses `TdaiAdapter` ABC. TypeScript side offers equivalent interface
for cross-language parity.

```
Python: adapter → TdaiAdapter → Gateway → TdaiCore
TS:     adapter → TdaiAdapter → TdaiCore (or Gateway)
```

## Shared Infrastructure (r3-v1)

The following infrastructure is available on the `r3-v1` branch for adapters
that wish to use it:

| Component | Location | Description |
|-----------|----------|-------------|
| Rate-limit gate | `src/core/gates/gate-rate-limit.ts` | Token bucket rate limiting |
| Circuit-breaker gate | `src/core/gates/gate-circuit-breaker.ts` | 3-state circuit breaker |
| Audit gate | `src/core/gates/gate-audit.ts` | Audit event logging |
| Observability | `src/core/report/` | IObservabilityBackend with OTLP export |
| MemoryAdapter interface | `src/core/types.ts` | TS adapter contract |

These are **opt-in**. Adapters do not need to use any of them.

## Gate Transparency

When an adapter calls the Gateway, the gates execute transparently:

```
adapter → Gateway → [rate-limit → circuit-breaker → audit] → TdaiCore
```

The adapter does not need to configure or interact with the gates.
If a gate blocks a request (rate limit exceeded, circuit open), the Gateway
returns an appropriate HTTP error code:

| Gate | Triggered | HTTP Status |
|------|-----------|-------------|
| rate-limit | Too many requests | 429 Too Many Requests |
| circuit-breaker | Circuit open | 503 Service Unavailable |
| audit | Always | 200 (non-blocking) |

## Observability

When audit events pass through the Gateway, they are automatically captured by
`AuditGate._flush()` and sent to the configured observability backend:

| Backend | Description | Configuration |
|---------|-------------|---------------|
| noop (default) | No-op, zero overhead | None |
| console | stdout JSON lines | `OBSERVABILITY_TYPE=console` |
| otlp | OpenTelemetry OTLP/HTTP | `OTEL_EXPORTER_OTLP_ENDPOINT` |

Adapters do not need to instrument anything. The observability layer captures
all audit events from the Gateway automatically.

## Compatibility with Active PRs

| PR | Author | Pattern | Works with r3-v1? | Changes needed |
|:---|:-------|:--------|:-----------------|:---------------|
| #339 | gugu23456789 | D (TdaiAdapter) | ✅ Native | None |
| #359 | coder-mtj | C (MemoryPlatformAdapter) | ✅ Via Gateway | None |
| #372 | WHUTcjh-2024 | A (HTTP client) | ✅ Via Gateway | None |
| #378 | Ricky-7-Yan | A (HTTP client) | ✅ Via Gateway | None |
| #385 | rainforest888 | B (HostAdapter) | ✅ Via TdaiCore | None |

All adapters work with r3-v1 without code changes. The Gateway API contract
is stable across both 0.3.x (upstream main) and v1.0.0 (r3-v1).

## Adding a New Adapter

1. Choose a pattern (A-D above)
2. Implement your adapter against the Gateway API
3. Test against a running Gateway instance
4. (Optional) Add your adapter's tests to the shared CI

For TypeScript adapters using HostAdapter, see `src/adapters/standalone/host-adapter.ts`
as a reference template — ~97 lines for a complete adapter.
For HTTP-based adapters, see `src/adapters/codex/gateway-client.ts`
(PR #378) as a reference — ~191 lines.

## Community Adapter Program

**Want to add TDAI support for your favorite IDE/agent framework?** Here's what you need:

| Entry Point | Code | Best for | Status |
|:------------|:----:|:---------|:------:|
| HTTP REST (Pattern A) | ~100-200 lines in any language | Dify, Coze, custom platforms, non-TS tools | ✅ Ready |
| MCP stdio (no code) | One config line | Any MCP-compatible IDE (Trae, Cursor, Claude Code, etc.) | ✅ Ready |
| Python TdaiAdapter (Pattern D) | `bridge_adapter/` ~500 lines | Python agents (LangChain, CrewAI, etc.) | ✅ Ready |
| TypeScript HostAdapter (Pattern B) | ~60-80 lines | TypeScript/Node.js environments | ✅ Template ready |

**How to contribute:**
1. Fork the repo
2. Add your adapter following the pattern above
3. Open a PR — we'll review within 48h
4. Your adapter appears in the ecosystem list

**Quick recommendation by platform:**
| Platform | Suggested path | Difficulty |
|:---------|:--------------|:----------:|
| Trae IDE, Cursor, Claude Code | MCP stdio (zero code) | 🟢 Easy |
| Dify, Coze, LangFlow | HTTP REST (Pattern A) | 🟢 Easy |
| Any Python framework | TdaiAdapter (Pattern D) | 🟢 Easy |
| Any TypeScript framework | HostAdapter (Pattern B) | 🟡 Medium |

## License

This integration guide is provided under the MIT License,
consistent with the upstream TencentDB-Agent-Memory project.
