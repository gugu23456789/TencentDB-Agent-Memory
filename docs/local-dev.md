# Local Bridge Development Environment

This document describes how to run the Bridge MCP server locally for development and testing.

## Prerequisites

| Dependency | Version | Check |
|------------|---------|-------|
| Python | >= 3.9 | `python --version` |
| pip | latest | `python -m pip --version` |

## Quick Start

### 1. Install dependencies

```bash
# Bridge server dependencies
pip install mcp httpx

# Bridge adapter (editable install)
pip install -e bridge_adapter/

# For running tests
pip install pytest
```

### 2. Verify import

```bash
python -c "import bridge.mcp.server; print('OK')"
```

### 3. Start a mock Gateway (for testing)

The Bridge adapter connects to TDAI Gateway via HTTP. For local development
without a real Gateway, use the built-in mock Gateway in the E2E test fixture.

```bash
# Run E2E tests (starts mock Gateway automatically)
python -m pytest bridge/mcp/tests/test_e2e.py -v
```

### 4. Run the Bridge server

The server reads a single JSON-RPC request from stdin and writes the
response to stdout.

**Initialize:**
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | \
  python -m bridge.mcp.server
```

**List tools:**
```bash
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | \
  python -m bridge.mcp.server
```

**Call a tool (requires Gateway at :8420 or TDAI_ENDPOINT set):**
```bash
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call",\
  "params":{"name":"tdai_health","arguments":{}}}' | \
  python -m bridge.mcp.server
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TDAI_ENDPOINT` | `http://127.0.0.1:8420` | TDAI Gateway URL |
| `TDAI_API_KEY` | `""` | Gateway API key |
| `MCP_BRIDGE_API_KEY` | `""` | Bridge MCP API key (loopback if empty) |
| `TDAI_SERVICE_ID` | `mem-rkgqhd5z` | Service/Space ID |

## Running Tests

```bash
# All Python tests (includes E2E)
python -m pytest bridge/mcp/tests/ -v

# E2E only (8 tests, ~8s)
python -m pytest bridge/mcp/tests/test_e2e.py -v

# All TS tests
npx vitest run
```

## MCP Integration (IDE)

To connect Trae IDE (or any MCP client) to the Bridge server, configure
the MCP client to run:

```json
{
  "mcpServers": {
    "bridge-mcp": {
      "command": "python",
      "args": ["-m", "bridge.mcp.server"],
      "env": {
        "TDAI_ENDPOINT": "http://127.0.0.1:8420"
      }
    }
  }
}
```

## Architecture

```
MCP Client (Trae IDE)
  │
  ▼  stdin/stdout (JSON-RPC)
bridge/mcp/server.py
  ├── Gate 0: Input validation
  ├── Gate 1: API Key
  ├── Gate 2: Rate limit
  ├── Gate 3: Circuit breaker
  └── Gate 4: Audit
  │
  ▼  HTTP
BridgeAdapter → TdaiHttpClient → TDAI Gateway (:8420)
                                    │
                                    ▼
                                 TdaiCore
```
