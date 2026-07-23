/**
 * Gateway E2E test — starts a local Gateway instance, exercises the v2 API
 * (L0 conversation capture + query), and verifies the BridgeHostAdapter works
 * through the full stack.
 *
 * This test demonstrates that the full pipeline is functional:
 *   1. Gateway starts and listens on a local port
 *   2. L0 conversation capture stores messages
 *   3. L0 query retrieves stored messages
 *   4. BridgeHostAdapter provides correct runtime context
 *
 * LLM-dependent features (L1 extraction, L2 scene, L3 persona) are not tested
 * here — they require an external LLM endpoint. This test covers L0 only.
 *
 * Run: npx vitest run --config vitest.e2e.config.ts src/gateway/gateway-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TdaiGateway } from "./server.js";
import { BridgeHostAdapter } from "../adapters/bridge/host-adapter.js";
import type { Logger } from "../core/types.js";

const TEST_PORT = 18420;
const BASE_DIR = ".tdai-e2e-test";

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: (...args: unknown[]) => console.error("[E2E]", ...args),
  debug: () => {},
};

describe("Gateway E2E", () => {
  let gateway: TdaiGateway;
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  beforeAll(async () => {
    gateway = new TdaiGateway({
      deployMode: "standalone",
      server: {
        port: TEST_PORT,
        host: "127.0.0.1",
        apiKey: "test-key",
        corsOrigins: [],
      },
      data: { baseDir: BASE_DIR },
      stateBackend: "local",
    });

    await gateway.start();
  }, 30_000);

  afterAll(async () => {
    if (gateway) {
      await gateway.stop();
    }
  });

  it("Gateway starts and health endpoint responds", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.ok).toBe(true);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBeDefined();
  });

  it("v2 API captures and queries L0 conversation", async () => {
    const sessionId = `e2e-test-${Date.now()}`;

    const addRes = await fetch(`${baseUrl}/v2/conversation/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
        "x-tdai-service-id": "e2e-test-service",
      },
      body: JSON.stringify({
        session_id: sessionId,
        messages: [
          { role: "user", content: "E2E message 1" },
          { role: "assistant", content: "E2E response 1" },
        ],
      }),
    });
    expect(addRes.ok).toBe(true);
    const addBody = await addRes.json() as { data?: { total_count?: number } };
    expect(addBody.data?.total_count).toBe(2);

    const queryRes = await fetch(`${baseUrl}/v2/conversation/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
        "x-tdai-service-id": "e2e-test-service",
      },
      body: JSON.stringify({ session_id: sessionId, limit: 10 }),
    });
    expect(queryRes.ok).toBe(true);
    const queryBody = await queryRes.json() as { data?: { total?: number; messages?: unknown[] } };
    expect(queryBody.data?.total).toBeGreaterThanOrEqual(2);
    expect(queryBody.data?.messages?.length).toBeGreaterThanOrEqual(2);
  });

  it("BridgeHostAdapter provides valid runtime context", () => {
    const adapterLogger: Logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    const adapter = new BridgeHostAdapter({
      logger: adapterLogger,
      dataDir: BASE_DIR,
    });

    const ctx = adapter.getRuntimeContext();
    expect(ctx.dataDir).toBe(BASE_DIR);
    expect(ctx.platform).toBe("gateway");
    expect(typeof ctx.userId).toBe("string");
    expect(adapter.getLogger()).toBe(adapterLogger);
    expect(adapter.getDataDir()).toBe(BASE_DIR);

    const sessionCtx = adapter.buildRuntimeContextForSession("test-session", "test-id");
    expect(sessionCtx.sessionKey).toBe("test-session");
    expect(sessionCtx.sessionId).toBe("test-id");
    expect(sessionCtx.dataDir).toBe(BASE_DIR);
  });
});
