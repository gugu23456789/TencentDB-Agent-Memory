# OTLP Pipeline Setup

This document describes how to set up the OTLP observability pipeline
for local development and how it's verified in CI across 3 platforms.

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

| Component | Status | Notes |
|-----------|--------|-------|
| `@opentelemetry/api` 1.x | ✅ | npm dependency |
| `@opentelemetry/sdk-node` 0.54.x | ✅ | npm dependency |
| `@opentelemetry/exporter-trace-otlp-http` | ✅ | npm dependency |
| `@opentelemetry/resources` 1.30.x | ✅ | npm dependency |
| `@opentelemetry/semantic-conventions` | ✅ | npm dependency |
| Jaeger all-in-one v2.19.0 | ✅ | See platform-specific steps below |

> **Note about OTel version:** v1.0.0 tag shipped with `@opentelemetry/resources@^2.7.1` (v2.x SDK) but the code uses `new Resource()` (v1.x API). This breaks OTel silently. The r3-v1 branch fixes this — details in issue #420.

## Step 1: Download Jaeger

### Option A: Docker (Linux / macOS with Docker Desktop)

```bash
docker run -d --name jaeger \
  -p 4317:4317 -p 4318:4318 -p 16686:16686 \
  jaegertracing/all-in-one:latest
```

### Option B: Binary download (Cross-platform)

Download from [jaegertracing.io/download](https://www.jaegertracing.io/download/) v2.19.0:

```bash
# Linux (amd64)
wget https://download.jaegertracing.io/v2.19.0/jaeger-2.19.0-linux-amd64.tar.gz
tar -xzf jaeger-2.19.0-linux-amd64.tar.gz
cd jaeger-2.19.0-linux-amd64

# macOS (arm64)
wget https://download.jaegertracing.io/v2.19.0/jaeger-2.19.0-darwin-arm64.tar.gz
tar -xzf jaeger-2.19.0-darwin-arm64.tar.gz
cd jaeger-2.19.0-darwin-arm64

# Windows (amd64) via PowerShell
Invoke-WebRequest -Uri "https://download.jaegertracing.io/v2.19.0/jaeger-2.19.0-windows-amd64.tar.gz" -OutFile "jaeger-2.19.0-windows-amd64.tar.gz"
tar -xzf jaeger-2.19.0-windows-amd64.tar.gz
cd jaeger-2.19.0-windows-amd64
```

## Step 2: Start Jaeger

```bash
# All platforms: use the all-in-one binary or docker container
./jaeger --config=all-in-one.yaml
```

Create `all-in-one.yaml`:

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

```bash
# Enable OTel SDK
export TDAI_OTEL_ENABLED=true

# Point to local Jaeger OTLP HTTP endpoint
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# Service name for Jaeger UI
export OTEL_SERVICE_NAME=bridge-mcp
```

## Step 4: Verify the Pipeline

### 4.1 Check Jaeger is running

```bash
curl http://localhost:16686/api/services
# Expected: {"data":[],"total":0} (empty before first trace)
```

### 4.2 Start Gateway

```bash
npx tsx src/gateway/server.ts
```

### 4.3 Send a capture to generate traces

```bash
curl -X POST http://localhost:8420/capture \
  -H "Authorization: Bearer test-key" \
  -H "Content-Type: application/json" \
  -d '{"session_key":"test","user_content":"hello","assistant_content":"world"}'
```

### 4.4 Check traces in Jaeger UI

Open http://localhost:16686, select service `bridge-mcp`, click "Find Traces".

## CI Verification (3 Platforms)

The OTLP pipeline is automatically verified in CI on every push:

| Platform | Jaeger method | Step | Status |
|:---------|:-------------|:-----|:-------|
| Linux (ubuntu-latest) | Docker container | Start → Wait → Push trace → Verify receipt | ✅ |
| macOS (macos-latest) | Binary download | Download → Start → Check port → Push → Verify | ✅ |
| Windows (windows-latest) | Binary download | Download → Start → Check port → Push → Verify | ✅ |

The CI job (`OTLP Verify`) runs these steps:
1. `npx tsx scripts/repro-l2-timer-bug.ts` — #416 31-unit regression suite
2. `npx tsx scripts/verify-l2-pipeline-mock.ts` — L2/L3 full pipeline mock test
3. `npm pack` + install from tarball — build artifact verification
4. `pip wheel` + install — Python SDK build verification
5. Start Jaeger + wait for readiness
6. Run OTLP trace push script
7. Verify trace received by Jaeger API

Latest CI results: https://github.com/gugu23456789/TencentDB-Agent-Memory/actions/runs/28919026006

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
| Connection refused on :4318 | Jaeger not running | Start jaeger binary/docker |
| No `bridge-mcp` service | No traces sent yet | Run a tool call first |
| OTLP endpoint mismatch | Protocol mismatch | Use `http/protobuf` for HTTP |
| v1.0.0 tag: `Resource is not a constructor` | OTel SDK version mismatch | Align to `resources@^1.30.1` + `sdk-node@^0.54.0` (see issue #420) |
