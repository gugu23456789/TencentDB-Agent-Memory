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

All adapters connect to TDAI through the Gateway HTTP API. There is no need to
link against or import any TDAI TypeScript/Python SDK — a simple HTTP client is
sufficient.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/recall` | POST | Recall memory context for a query |
| `/capture` | POST | Capture a conversation turn |
| `/search/memories` | POST | Search structured memories |
| `/search/conversations` | POST | Search conversation history |
| `/session/end` | POST | End a session and flush buffers |
| `/health` | GET | Health check |

### Authentication

If `GATEWAY_API_KEY` is configured, include it as a Bearer token:

```
Authorization: Bearer <api_key>
```

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

Extend the existing `HostAdapter` interface from `src/core/types.ts`.
~40-85 lines per adapter.

```
adapter → HostAdapter → TdaiCore (in-process)
```

### Pattern C: MemoryPlatformAdapter (custom interface)

Used by: PR #359 (coder-mtj)

Define your own adapter interface and implement it for each platform.
~20-50 lines per platform + shared infrastructure.

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

For TypeScript adapters using HostAdapter, see `src/adapters/claude-code/`
(PR #385) as a reference — ~59 lines for a complete adapter.
For HTTP-based adapters, see `src/adapters/codex/gateway-client.ts`
(PR #378) as a reference — ~191 lines.

## License

This integration guide is provided under the MIT License,
consistent with the upstream TencentDB-Agent-Memory project.
