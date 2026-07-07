# OTLP Pipeline Setup

This document describes how to set up the OTLP observability pipeline
for local development.

## Architecture

```
Bridge server (TS) ──OTLP/HTTP──► Jaeger (all-in-one)
  │                                   │
  │  AuditGate._flush()               │ OTLP receiver (:4318)
  │  getObservabilityBackend()        │ Query UI (:16686)
  │  .trace.report()                  │
  └───────────────────────────────────┘
```

## Prerequisites

| Component | Status | Install |
|-----------|--------|---------|
| `@opentelemetry/api` | ✅ Done | `npm install @opentelemetry/api` |
| `@opentelemetry/sdk-node` | ✅ Done | `npm install @opentelemetry/sdk-node` |
| `@opentelemetry/exporter-trace-otlp-http` | ✅ Done | via npm |
| `@opentelemetry/resources` | ✅ Done | via npm |
| `@opentelemetry/semantic-conventions` | ✅ Done | via npm |
| Jaeger all-in-one | ✅ v2.19.0 | `C:\Users\HP\Downloads\jaeger-2.19.0-windows-amd64\jaeger-2.19.0-windows-amd64\jaeger.exe` |

## Step 1: Download Jaeger

### Option A: Use existing local copy

```powershell
# Already downloaded at:
C:\Users\HP\Downloads\jaeger-2.19.0-windows-amd64\jaeger-2.19.0-windows-amd64\jaeger.exe
```

### Option B: Download binary

```powershell
# Windows
Invoke-WebRequest -Uri "https://download.jaegertracing.io/v2.19.0/jaeger-2.19.0-windows-amd64.tar.gz" -OutFile "tools\jaeger\jaeger-2.19.0-windows-amd64.tar.gz"

# Extract (requires 7zip or tar)
tar -xzf tools\jaeger\jaeger-2.19.0-windows-amd64.tar.gz -C tools\jaeger\
```

### Option B: Install via winget

```powershell
winget install --id=jaegertracing.jaeger -e
```

### Option C: Docker

```bash
docker run -d --name jaeger \
  -p 4317:4317 -p 4318:4318 -p 16686:16686 \
  jaegertracing/all-in-one:latest
```

## Step 2: Start Jaeger

```powershell
# Navigate to jaeger directory
cd C:\Users\HP\Downloads\jaeger-2.19.0-windows-amd64\jaeger-2.19.0-windows-amd64

# Start with all-in-one config (validated working)
.\jaeger.exe --config=all-in-one.yaml
```

The config file (`all-in-one.yaml`):

```yaml
service:
  extensions: [jaeger_storage, jaeger_query]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [jaeger_storage_exporter]
extensions:
  jaeger_query:
    storage:
      traces: some_storage
  jaeger_storage:
    backends:
      some_storage:
        memory:
          max_traces: 100000
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
processors:
  batch:
exporters:
  jaeger_storage_exporter:
    trace_storage: some_storage
```

**Verified ports:**
| Port | Service | Status |
|:----:|---------|:------:|
| 4318 | OTLP HTTP receiver | ✅ |
| 16686 | Jaeger Query UI | ✅ |

Jaeger UI: http://localhost:16686

## Step 3: Configure Environment

Set these environment variables before starting the Bridge server:

```powershell
# Enable OTel SDK in TS codebase
$env:TDAI_OTEL_ENABLED = "true"

# Point to local Jaeger OTLP HTTP endpoint
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
$env:OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"

# Service name for Jaeger UI
$env:OTEL_SERVICE_NAME = "bridge-mcp"
```

## Step 4: Verify the Pipeline

### 4.1 Check Jaeger is running

```powershell
curl.exe http://localhost:16686/api/services
```
Expected: `{"data":[],"total":0}` (empty before first trace).

### 4.2 Run the Bridge server

The AuditGate will call `getObservabilityBackend().trace.report()`
on each flush interval (default: 5s). With `TDAI_OTEL_ENABLED=true`,
the OTLP backend exports spans to the Jaeger collector.

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call",\
  "params":{"name":"tdai_health","arguments":{}}}' | \
  python -m bridge.mcp.server
```

### 4.3 Check traces in Jaeger UI

Open http://localhost:16686 in a browser.

1. Select service `bridge-mcp` from the dropdown
2. Click "Find Traces"
3. Audit events should appear as spans

## Configuration Reference

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `TDAI_OTEL_ENABLED` | `false` | Enable OTel SDK |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP collector address |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` | Transport: `grpc` or `http/protobuf` |
| `OTEL_SERVICE_NAME` | `core` | Service name in traces |
| `OBSERVABILITY_TYPE` | `noop` | Observability backend: `noop`, `console`, `otlp` |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No traces in Jaeger | OTel SDK not enabled | Set `TDAI_OTEL_ENABLED=true` |
| Connection refused on :4318 | Jaeger not running | Start jaeger.exe |
| No `bridge-mcp` service | No traces sent yet | Run a tool call first |
| OTLP endpoint mismatch | Protocol mismatch | Use `http/protobuf` for HTTP |
