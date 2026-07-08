/**
 * #416 L2 pipeline integration test with mock LLM server.
 *
 * Validates that the full L2 extraction pipeline routes correctly:
 *   L2_schedule timer → executeL2 → scene file creation
 *
 * Uses a mock LLM HTTP server (no real AI model needed).
 *
 * Usage:
 *   npx tsx scripts/verify-l2-pipeline-mock.ts
 *
 * Environment:
 *   TDAI_DATA_DIR      — temp dir for Gateway state (auto-created if absent)
 *   TDAI_GATEWAY_PORT  — Gateway HTTP port (default: 18420)
 *   MOCK_LLM_PORT      — mock LLM server port (default: 21999)
 *
 * Prerequisites:
 *   - npm ci completed
 *   - Ports 18420 and 21999 available
 */

import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Config ──
const GATEWAY_PORT = parseInt(process.env.TDAI_GATEWAY_PORT ?? "18420", 10);
const MOCK_LLM_PORT = parseInt(process.env.MOCK_LLM_PORT ?? "21999", 10);
const DATA_DIR = process.env.TDAI_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "tdai-l2-test-"));
const GATEWAY_URL = `http://localhost:${GATEWAY_PORT}`;

const PASS = "\x1b[32m✅\x1b[0m";
const FAIL = "\x1b[31m❌\x1b[0m";
const WARN = "\x1b[33m⚠️\x1b[0m";

let passed = 0;
let failed = 0;

function ok(desc: string) {
  passed++;
  console.log(`  ${PASS} ${desc}`);
}
function notOk(desc: string, detail?: string) {
  failed++;
  console.log(`  ${FAIL} ${desc}${detail ? ": " + detail : ""}`);
}

// ── Helpers ──
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpRequest(
  url: string,
  options: http.RequestOptions = {},
  body?: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, data })
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── 1. Start mock LLM server ──
console.log("\n=== 1. Starting mock LLM server ===");
const mockLLMResponses = {
  // L1 extraction response: returns fake extracted memories
  "/v1/chat/completions": JSON.stringify({
    id: "mock-cmpl-1",
    object: "chat.completion",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: JSON.stringify({
          memories: [
            { id: "mem-1", text: "User asked about test topic", timestamp: Date.now() },
            { id: "mem-2", text: "Assistant provided test response", timestamp: Date.now() },
          ],
          scenes: [
            { id: "scene-1", title: "Test Discussion", description: "A test conversation about testing", timestamp: Date.now() },
          ]
        }),
      },
      finish_reason: "stop",
    }],
  }),
  // L2 scene generation response
  "/v1/scenes": JSON.stringify({
    scenes: [
      { id: "scene-gen-1", title: "Generated Test Scene", summary: "Auto-generated scene from mock", confidence: 0.95 },
    ],
  }),
};

const mockLLMServer = http.createServer((req, res) => {
  // Log the request path for debugging
  const body: Buffer[] = [];
  req.on("data", (chunk) => body.push(chunk));
  req.on("end", () => {
    const reqBody = Buffer.concat(body).toString();
    console.log(`  [mock-llm] ← ${req.method} ${req.url}`);

    // Match the response based on URL path
    const response = mockLLMResponses[req.url ?? ""] ?? JSON.stringify({ choices: [{ message: { content: "{}" } }] });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(response);
    console.log(`  [mock-llm] → 200 (${response.length} bytes)`);
  });
});

mockLLMServer.listen(MOCK_LLM_PORT);
console.log(`  Mock LLM listening on :${MOCK_LLM_PORT}`);

// ── 2. Start Gateway process (no config file, all via env vars) ──
console.log("\n=== 2. Starting TDAI Gateway ===");
const gatewayEnv = {
  ...process.env,
  TDAI_DATA_DIR: DATA_DIR,
  TDAI_GATEWAY_API_KEY: "test-gateway-key",
  TDAI_GATEWAY_PORT: String(GATEWAY_PORT),
  TDAI_LLM_BASE_URL: `http://localhost:${MOCK_LLM_PORT}`,
  TDAI_LLM_API_KEY: "sk-mock",
  TDAI_LLM_MODEL: "mock-model",
  TDAI_LLM_MAX_TOKENS: "256",
  SCANNER_INTERVAL_MS: "500",
  WORKER_POLL_MS: "200",
  // Skip observability setup
  TDAI_OTEL_ENABLED: "false",
};

const gatewayProcess = spawn("npx", ["tsx", "src/gateway/server.ts"], {
  cwd: process.cwd(),
  env: gatewayEnv,
  stdio: ["ignore", "pipe", "pipe"],
  shell: true,
});

let gatewayOutput = "";
gatewayProcess.stdout?.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  gatewayOutput += text;
  process.stdout.write(`  [gateway] ${text}`);
});
gatewayProcess.stderr?.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  gatewayOutput += text;
  process.stderr.write(`  [gateway:err] ${text}`);
});

// ── 4. Wait for Gateway readiness ──
console.log("\n=== 4. Waiting for Gateway to be ready ===");
let gatewayReady = false;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  try {
    const res = await httpRequest(`${GATEWAY_URL}/health`);
    if (res.status === 200) {
      gatewayReady = true;
      console.log(`  Gateway ready after ${i + 1}s`);
      break;
    }
  } catch {
    // not ready yet
  }
}

if (!gatewayReady) {
  console.error(`  ${FAIL} Gateway did not start within 30s`);
  console.error(`  Last output: ${gatewayOutput.slice(-500)}`);
  cleanup(gatewayProcess, mockLLMServer, DATA_DIR);
  process.exit(1);
}
ok("Gateway started and /health responded");

// ── 5. Send capture ──
console.log("\n=== 5. Sending capture request ===");
const captureBody = JSON.stringify({
  sessionId: "test-session-l2",
  instanceId: "test-instance",
  messages: [
    { role: "user", content: "Hello, this is a test message for L2 pipeline verification" },
    { role: "assistant", content: "This is a test response to verify the L2 pipeline timer mapping" },
  ],
});

try {
  const captureRes = await httpRequest(
    `${GATEWAY_URL}/api/v1/capture`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-gateway-key",
      },
    },
    captureBody
  );
  console.log(`  Capture response: ${captureRes.status} — ${captureRes.data.slice(0, 200)}`);
  if (captureRes.status === 200 || captureRes.status === 201 || captureRes.status === 202) {
    ok("Capture request accepted");
  } else {
    notOk(`Capture returned ${captureRes.status}`);
  }
} catch (err) {
  notOk("Capture request failed", String(err));
}

// ── 6. Wait and check for L2 scene files ──
console.log("\n=== 6. Waiting for L2 pipeline processing ===");
const sceneDir = path.join(DATA_DIR, "storage", "scene_blocks");
let sceneFilesFound = false;

for (let i = 0; i < 30; i++) {
  await sleep(1000);
  if (fs.existsSync(sceneDir)) {
    const files = fs.readdirSync(sceneDir);
    if (files.length > 0) {
      sceneFilesFound = true;
      console.log(`  Scene files detected after ~${i + 1}s:`);
      for (const f of files.slice(0, 5)) {
        const stat = fs.statSync(path.join(sceneDir, f));
        console.log(`    ${f} (${stat.size} bytes)`);
      }
      break;
    }
  }
}

if (sceneFilesFound) {
  ok("L2 pipeline produced scene files");
} else {
  notOk("No scene files produced within timeout",
    `Check ${sceneDir} and Gateway logs above`);
}

// ── 7. Verify timer mapping fix (via Gateway output) ──
console.log("\n=== 7. Verifying #416 fix in Gateway output ===");
if (gatewayOutput.includes("offload-l2") && !gatewayOutput.includes("L2_schedule→offload-l2")) {
  console.log(`  ${WARN} Gateway may have used offload-l2 path (check logs)`);
}
if (gatewayOutput.includes("L2") && gatewayOutput.includes("enqueued L2 task")) {
  ok("Gateway enqueued L2 tasks (timer mapping correct)");
} else {
  notOk("No L2 tasks enqueued — timer may still route incorrectly",
    "Check if #416 fix is applied");
}

// ── Summary ──
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log(`\n${WARN} ${failed} failure(s) — see above`);
}

// ── Cleanup ──
console.log("\n=== Cleanup ===");
cleanup(gatewayProcess, mockLLMServer, DATA_DIR).then(() => {
  process.exit(failed > 0 ? 1 : 0);
}).catch(() => process.exit(1));

// ── Cleanup helper ──
async function cleanup(
  gw: ChildProcess,
  mock: http.Server,
  dataDir: string
): Promise<void> {
  // Stop Gateway
  if (gw && !gw.killed) {
    gw.kill("SIGTERM");
    await sleep(2000);
    if (!gw.killed) gw.kill("SIGKILL");
  }
  // Stop mock server
  mock.close();
  // Clean data dir (only if we created it)
  if (dataDir !== process.env.TDAI_DATA_DIR) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log("  Cleanup complete");
}
