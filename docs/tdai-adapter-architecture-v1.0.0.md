# TDAI Adapter Architecture (v1.0.0)

## System Overview

TDAI exposes a memory engine through a layered architecture. External adapters
(Python, TypeScript, MCP, HTTP) connect to the Gateway, which routes requests
through defense gates before reaching TdaiCore.

```
                          +----------------------------------------+
                          |        TDAI Gateway (:8420)            |
                          |  +----------+  +-------------------+   |
                          |  | REST API |  | Gates (inline):   |   |
                          |  | /recall  |  |  rate-limit       |   |
                          |  | /capture |  |  circuit-breaker  |   |
                          |  | /search  |  |  audit            |   |
                          |  +----------+  +-------------------+   |
                          |  +---------------------------------+   |
                          |  | Observability (IObservability   |   |
                          |  | Backend - OTLP export)          |   |
                          |  +---------------------------------+   |
                          +-----------------+---------------------+
                                            |
                                     TdaiCore (memory engine)
                              L0 conv / L1 memories / L2 / L3
```

## Three Entry Points

### 1. Python SDK -- `bridge_adapter/`

```python
from bridge_adapter import BridgeAdapter
adapter = BridgeAdapter()
adapter.initialize()
result = adapter.recall("user query", 5)
```

- **Transport:** HTTP -> Gateway REST endpoints
- **Dependencies:** `httpx`, zero TDAI infra import
- **Use case:** Python agents (LangChain, CrewAI), backend services
- **See:** `bridge_adapter/README.md`

### 2. TypeScript SDK -- `src/core/`

```typescript
import { TdaiHttpClient } from "./tdai-http-client";
const client = new TdaiHttpClient({ endpoint: "http://...", apiKey: "sk-..." });
```

- **Transport:** HTTP -> Gateway REST endpoints (or in-process via TdaiCore)
- **Dependencies:** TypeScript 5.x, zero TDAI infra import for HTTP mode
- **Use case:** TypeScript/Node.js agents, IDE plugins (HostAdapter)
- **See:** `src/core/types.ts`, `src/adapters/`

### 3. MCP stdio -- `bridge/mcp/server.py`

```json
{
  "mcpServers": {
    "tdai_memory": {
      "command": "python",
      "args": ["-m", "bridge.mcp.server"]
    }
  }
}
```

- **Transport:** stdio (JSON-RPC 2.0) -- one-line config, zero code
- **Dependencies:** Python 3.10+, `mcp>=1.0.0`, `httpx>=0.27.0`
- **Use case:** Any MCP-compatible IDE (Trae, Cursor, Claude Code, CodeBuddy, etc.)
- **Gates:** 5-layer defense built in (G0-G4)

## MCP Server Architecture

The MCP server is the primary entry point for IDE integration. It runs as a
local stdio subprocess with two independent processes forming a graceful
degradation chain:

```
Primary:   python -m bridge.mcp.server   (5 tools, 5 gates)
Fallback:  python -m bridge.mcp_health    (1 tool: tdai_health, 4 gates)
```

### Process: `bridge/mcp/server.py`

| Aspect | Detail |
|--------|--------|
| Exposed tools | `tdai_health`, `tdai_recall`, `tdai_capture`, `tdai_memory_search`, `tdai_conversation_search` |
| Gates active | G0 (input validation) + G1 (API key) + G2 (rate limit) + G3 (circuit breaker) + G4 (audit) |
| Transport | stdio, JSON-RPC 2.0, MCP protocol 2025-03-26 |
| Initialization | Lazy-import `BridgeAdapter` on first tool call |
| Location | `bridge/mcp/server.py` (~270 lines) |

### Process: `bridge/mcp_health.py`

| Aspect | Detail |
|--------|--------|
| Exposed tool | `tdai_health` only |
| Gates active | G1 (API key) + G2 (rate limit) + G3 (circuit breaker) + G4 (audit) |
| Independence | Separate process, no shared state with `server.py` |
| Use case | Last-resort health check when `server.py` is unavailable |
| Location | `bridge/mcp_health.py` (~316 lines) |

### Gate Pipeline

Every `tools/call` request passes through gates sequentially:

```
Request
  |
  v
[G0: JSON-RPC validation]  --> rejected -> -32600
  |
  v
[G1: API Key (HMAC)]        --> rejected -> -32001
  |                                  ^
  |                          Also checks: MCP_BRIDGE_API_KEY
  |                                     TDAI_API_KEY (fallback)
  |                                     loopback (empty, desktop only)
  v
[G2: Rate limit (sliding)]  --> rejected -> -32029
  |                         (60 calls / 60s, self-fallback: 3 failures -> open 30s)
  v
[G3: Circuit breaker]       --> rejected -> -32050
  |                         (10 failures -> 60s cooldown, exponential backoff -> max 300s)
  v
[G4: Audit log]             --> always passes (10% sample rate, non-blocking)
  |
  v
Tool handler -> TdaiAdapter -> Gateway -> TdaiCore
```

**Gate transparency:** Adapters do not interact with gates directly.
Gates are enforced at the server boundary. See `docs/ADAPTER-INTEGRATION.md` for
the error codes returned when a gate triggers.

### Graceful Fallback Chain

```
Level 1: bridge/mcp/server.py  (5 tools, 5 gates, full TDAI access)
  |-- if process crashes / unavailable --->
Level 2: bridge/mcp_health.py   (1 tool: tdai_health, 4 gates, health only)
```

- No shared state between levels
- Same `MCP_BRIDGE_API_KEY` env var for consistent auth
- Same `bridge_adapter.BridgeAdapter.mcp_health()` backend
- Level 2 is a manual switch (client reconfigures the MCP server entry point)

## Observability Pipeline

When the audit gate captures an event, it flows to the configured observability backend:

### Configuration

```typescript
// TypeScript-side initialization (in Gateway bootstrap)
import { initObservabilityBackend } from "./report/factory.js";
initObservabilityBackend({ type: "otlp" });
```

| Backend type | Behavior | Configuration |
|:-------------|:---------|:--------------|
| `noop` (default) | Zero-cost, no-op | None |
| `console` | stdout JSON lines | `OBSERVABILITY_TYPE=console` |
| `otlp` | OpenTelemetry OTLP/HTTP | `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` |

### Trace Flow

```
AuditGate._flushBuffer()
  |
  v
getObservabilityBackend().trace.report(event.action, {
  tdai_audit_result: event.result,
  tdai_audit_reason: event.reason,
  tdai_audit_timestamp: event.timestamp,
})
  |
  v (if backend type = "otlp")
OTel SDK -> OTLP/HTTP -> Jaeger / SigNoz / Grafana
```

**OTel version note:** v1.0.0 code uses `new Resource()` (v1.x API) but `package.json`
shipped with `@opentelemetry/resources@^2.7.1` (v2.x). This API mismatch ([#420](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/420))
breaks observability silently — `new Resource()` throws `TypeError`, the outer
catch swallows it into `console.warn`, and no trace data ever leaves the process.
The v1.x SDK line (`@opentelemetry/resources@^1.30.1`,
`@opentelemetry/sdk-node@^0.54.0`) restores compatibility.
See `docs/otlp-setup.md` for full setup.

## Configuration Model

All three entry points share a unified configuration namespace.

### Environment Variables

| Variable | Default | Purpose |
|:---------|:--------|:--------|
| `TDAI_ENDPOINT` | `http://127.0.0.1:8420` | Gateway URL |
| `TDAI_API_KEY` | `""` (loopback) | API authentication |
| `TDAI_SERVICE_ID` | `mem-rkgqhd5z` | Multi-tenant isolation |
| `TDAI_TIMEOUT` | `30` | Request timeout (seconds) |
| `TDAI_RETRY_ATTEMPTS` | `3` | Retry count |
| `MCP_BRIDGE_API_KEY` | `""` (loopback) | MCP-specific key override |
| `MCP_BRIDGE_API_KEY_ALLOW_EMPTY` | `True` | Allow loopback mode |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OTLP collector URL |

### API Key Resolution (MCP server)

```
1. MCP_BRIDGE_API_KEY (MCP-specific override)
2. TDAI_API_KEY (shared SDK key)
3. Empty string -> loopback mode (no auth required, desktop only)
```

### Multi-Tenant Isolation

TDAI v2 Gateway uses `x-tdai-service-id` header for tenant isolation.
The MCP server and SDKs pass this through from the `TDAI_SERVICE_ID` env var.
Each `TDAI_SERVICE_ID` maps to an independent SQLite database.

## Deployment Options

| Mode | MCP server | Gates | Auth | Use case |
|:-----|:-----------|:-----:|:----|:---------|
| Desktop (loopback) | `server.py` | G0-G4 | None (localhost) | Development, single project |
| Desktop (keyed) | `server.py` | G0-G4 | HMAC API key | Shared team desktop |
| Health (fallback) | `mcp_health.py` | G1-G4 | HMAC API key | Last-resort diagnosis |

No external proxy or agentgateway required. The gates are self-sufficient
for desktop and mid-scale deployments. For high-volume deployments, add
external rate-limiting at the Gateway HTTP layer.

## File Layout

```
bridge/
|-- mcp/
|   |-- server.py              MCP server (5 tools, 5 gates)
|   |-- mcp_health.py          MCP health (1 tool, 4 gates, independent process)
|   |-- INTEGRATION.md         Multi-platform MCP configs
|   |-- REDTEAM_FINDINGS.md    Security assessment
|   |-- tests/
|       |-- test_e2e.py        E2E tests (8 tests, mock Gateway)
|       |-- test_protocol.py   JSON-RPC compliance (14 tests)
|       |-- test_redteam.py    Security tests (13 tests)
|       |-- test_offensive.py  Stress tests (22 tests)
|       |-- test_ghost_attacks.py  Architecture tests (10 tests)
|-- bridge_adapter/
    |-- __init__.py
    |-- base_adapter.py        TdaiAdapter ABC
    |-- bridge_adapter.py      BridgeAdapter implementation
    |-- README.md

src/core/
|-- gates/
|   |-- gate-rate-limit.ts     TS rate-limit gate
|   |-- gate-circuit-breaker.ts TS circuit-breaker gate
|   |-- gate-audit.ts          TS audit gate
|   |-- gate-e2e.test.ts       TS gate E2E tests (7 tests)
|-- report/
    |-- factory.ts             IObservabilityBackend factory
    |-- otlp-backend.ts        OTLP backend
    |-- types.ts               Observability types

docs/
|-- ADAPTER-INTEGRATION.md     Community adapter guide + integration patterns
|-- local-dev.md               Local dev setup guide
|-- otlp-setup.md              OTLP / Jaeger setup guide
```

## Dependencies

### Python

```
mcp>=1.0.0           MCP protocol Python SDK
httpx>=0.27.0        HTTP client for Gateway
```

### TypeScript

```
@opentelemetry/api@^1.9.1
@opentelemetry/resources@^1.30.1
@opentelemetry/sdk-node@^0.54.0
@opentelemetry/exporter-trace-otlp-http@^0.54.0
@opentelemetry/sdk-trace-base@^1.30.1
@opentelemetry/sdk-trace-node@^1.30.1
@opentelemetry/instrumentation-http@^0.54.0
```

## License

This architecture document is provided under the MIT License,
consistent with the upstream TencentDB-Agent-Memory project.
