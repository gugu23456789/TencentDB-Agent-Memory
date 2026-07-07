/**
 * OTLP pipeline verification script.
 *
 * Usage:
 *   TDAI_OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *   npx tsx scripts/otlp-verify.ts
 *
 * Prerequisites:
 *   - Jaeger running on localhost:4318 (OTLP HTTP)
 *   - npm packages installed (@opentelemetry/api, etc.)
 */

import { initObservabilityBackend, getObservabilityBackend } from "../src/core/report/factory.js";

async function main() {
  console.log("[verify] Initializing OTLP observability backend...");
  await initObservabilityBackend({
    type: "otlp",
    otel: {
      enabled: true,
      endpoint: "http://localhost:4318",
      serviceName: "bridge-mcp",
    },
  });

  const backend = getObservabilityBackend();
  console.log(`[verify] Backend type: ${backend.type}`);
  console.log(`[verify] Backend initialized: ${backend.isInitialized?.() ?? "unknown"}`);

  // Report a test trace
  console.log("[verify] Reporting test trace...");
  backend.trace.report("test.verify_pipeline", {
    tdai_audit_result: "pass",
    tdai_audit_reason: "OTLP pipeline verification",
    tdai_audit_timestamp: Date.now(),
  });

  console.log("[verify] Trace reported. Waiting for export...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Shutdown to flush pending spans
  console.log("[verify] Shutting down...");
  await backend.shutdown();

  console.log("[verify] Done. Check http://localhost:16686 for trace 'test.verify_pipeline'");
}

main().catch((err) => {
  console.error("[verify] Failed:", err);
  process.exit(1);
});
