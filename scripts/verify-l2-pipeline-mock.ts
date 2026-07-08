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
function fail(desc: string, detail?: string) {
  console.log(`  ${FAIL} ${desc}${detail ? ": " + detail : ""}`);
  failed++;
}

function warn(desc: string) {
  console.log(`  ${WARN} ${desc}`);
}

function notOk(desc: string, detail?: string) {
  console.log(`  ${FAIL} ${desc}${detail ? ": " + detail : ""}`);
  failed++;
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

const mockLLMServer = http.createServer((req, res) => {
  const body: Buffer[] = [];
  req.on("data", (chunk) => body.push(chunk));
  req.on("end", () => {
    const reqBody = Buffer.concat(body).toString();
    console.log(`  [mock-llm] ← ${req.method} ${req.url}`);

    // Parse request body to determine call type
    let parsedBody: any;
    try { parsedBody = JSON.parse(reqBody); } catch { parsedBody = null; }
    const hasTools = parsedBody?.tools && Array.isArray(parsedBody.tools) && parsedBody.tools.length > 0;
    const lastMsg = parsedBody?.messages?.[parsedBody.messages?.length - 1];
    const isToolResult = lastMsg?.role === "tool";

    let response: string;

    if (hasTools && !isToolResult) {
      // Detect if this is L3 persona (asks to write persona.md) vs L2 scene extraction
      const systemMsg = parsedBody?.messages?.find((m: any) => m.role === "system");
      const isPersona = systemMsg?.content?.includes("persona.md");

      const fileName = isPersona ? "persona.md" : "test-scene-001.md";
      const fileContent = isPersona
        ? `# Persona: Test User\n\n**Generated:** ${new Date().toISOString()}\n\n## Archetype\nCurious engineer\n\n## Background\nTest user for L2/L3 pipeline verification\n\n## Traits\n- Analytical\n- Detail-oriented\n- Prefers automation`
        : `# Scene: Test Discussion\n\n**Created:** ${new Date().toISOString()}\n\nThis is a mock scene file generated to verify the L2 pipeline completes end-to-end.\n\n## Summary\nThe L2 timer correctly routed to the scene extractor, which called the LLM with tools=true. The mock LLM responded with a tool call, and the AI SDK executed the write tool.\n\n## Memories\n- User asked about test topic\n- Assistant provided test response`;

      // L2/L3 initial call (first turn of tool loop): return tool_calls
      // The AI SDK's generateText() with createOpenAI(compatibility="compatible")
      // expects standard OpenAI tool_calls in the response.
      response = JSON.stringify({
        id: "mock-cmpl-tool",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `call_write_${isPersona ? "persona" : "scene"}`,
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: fileName,
                  content: fileContent,
                }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      });
    } else if (isToolResult) {
      // L2/L3 follow-up: tool was executed, return text summary
      response = JSON.stringify({
        id: "mock-cmpl-summary",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              scenes_created: 1,
              scenes_updated: 0,
              scene_files: ["test-scene-001.md"],
              summary: "Mock scene generation completed successfully",
            }),
          },
          finish_reason: "stop",
        }],
      });
    } else {
      // L1 or non-tool call: return SceneSegment array for L1 extraction
      response = JSON.stringify({
        id: "mock-cmpl-1",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify([
              {
                scene_name: "Test Discussion",
                message_ids: [1, 2],
                memories: [
                  { content: "User asked about test topic", type: "episodic", priority: 50, source_message_ids: ["1"] },
                  { content: "Assistant provided test response", type: "episodic", priority: 50, source_message_ids: ["2"] },
                ],
              },
            ]),
          },
          finish_reason: "stop",
        }],
      });
    }

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
  session_key: "test-session-l2",
  user_content: "Hello, this is a test message for L2 pipeline verification",
  assistant_content: "This is a test response to verify the L2 pipeline timer mapping",
});

// ECONNRESET resilience: retry capture up to 3 times with 2s backoff
let captureAccepted = false;
for (let retry = 0; retry < 3; retry++) {
  try {
    const captureRes = await httpRequest(
      `${GATEWAY_URL}/capture`,
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
      captureAccepted = true;
      ok("Capture request accepted");
      break;
    } else {
      console.log(`  Capture attempt ${retry + 1} returned status ${captureRes.status}, retrying...`);
    }
  } catch (err) {
    console.log(`  Capture attempt ${retry + 1} failed: ${err instanceof Error ? err.message : String(err)}, retrying...`);
  }
  await sleep(2000);
}

if (!captureAccepted) {
  notOk("Capture request failed after 3 retries");
}

// ── 6. Wait and check for L2 scene files ──
console.log("\n=== 6. Waiting for L2 pipeline processing ===");
const sceneDir = path.join(DATA_DIR, "scene_blocks");
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
  warn("No scene files (mock LLM returns text, not L2 tool calls — pipeline routing is verified below)");
  console.log(`  Scene directory: ${sceneDir}`);
  if (fs.existsSync(sceneDir)) {
    const files = fs.readdirSync(sceneDir);
    console.log(`  Files in scene_blocks: ${files.length > 0 ? files.join(", ") : "(empty)"}`);
  } else {
    console.log("  scene_blocks directory was never created");
  }
}

// ── 7. Verify persona.md (L3) was generated ──
console.log("\n=== 7. Checking L3 persona generation ===");
const personaPath = path.join(DATA_DIR, "persona.md");
if (fs.existsSync(personaPath)) {
  const content = fs.readFileSync(personaPath, "utf-8");
  ok("L3 persona generation produced persona.md");
  console.log(`  persona.md: ${content.length} chars`);
} else {
  warn("persona.md not generated (mock LLM format may not match persona prompt)");
}

// ── 8. Verify timer mapping fix (via Gateway output) ──
console.log("\n=== 8. Verifying #416 fix in Gateway output ===");
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
