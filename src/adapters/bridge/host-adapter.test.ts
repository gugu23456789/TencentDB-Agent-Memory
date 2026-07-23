/**
 * Tests for BridgeHostAdapter — validates runtime context, logger, LLM runner,
 * session-level context, and data directory resolution.
 */

import { describe, it, expect, vi } from "vitest";
import { BridgeHostAdapter } from "./host-adapter.js";
import type { Logger } from "../../core/types.js";

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("BridgeHostAdapter", () => {
  it("getRuntimeContext returns correct defaults", () => {
    const logger = createMockLogger();
    const adapter = new BridgeHostAdapter({ logger, dataDir: "/tmp/tdai" });
    const ctx = adapter.getRuntimeContext();

    expect(ctx.dataDir).toBe("/tmp/tdai");
    expect(ctx.workspaceDir).toBe("/tmp/tdai");
    expect(ctx.platform).toBe("gateway");
    expect(typeof ctx.userId).toBe("string");
    expect(ctx.sessionId).toBe("");
  });

  it("getLogger returns the injected logger", () => {
    const logger = createMockLogger();
    const adapter = new BridgeHostAdapter({ logger });
    expect(adapter.getLogger()).toBe(logger);
  });

  it("getLLMRunnerFactory returns error-throwing factory when llmConfig is omitted", async () => {
    const logger = createMockLogger();
    const adapter = new BridgeHostAdapter({ logger, dataDir: "/tmp" });
    const factory = adapter.getLLMRunnerFactory();
    const runner = factory.createRunner();

    await expect(runner.run({ messages: [] })).rejects.toThrow(
      "LLM not configured",
    );
  });

  it("getLLMRunnerFactory returns configured factory when llmConfig is provided", () => {
    const logger = createMockLogger();
    const adapter = new BridgeHostAdapter({
      logger,
      dataDir: "/tmp",
      llmConfig: { baseUrl: "http://localhost:11434", apiKey: "test", model: "test-model" },
    });
    const factory = adapter.getLLMRunnerFactory();
    const runner = factory.createRunner();
    expect(runner).toBeDefined();
    expect(typeof runner.run).toBe("function");
  });

  it("buildRuntimeContextForSession merges session key and id", () => {
    const logger = createMockLogger();
    const adapter = new BridgeHostAdapter({ logger, dataDir: "/tmp/tdai" });

    const ctx = adapter.buildRuntimeContextForSession("session-1", "conv-42");
    expect(ctx.sessionKey).toBe("session-1");
    expect(ctx.sessionId).toBe("conv-42");
    expect(ctx.dataDir).toBe("/tmp/tdai");
    expect(ctx.platform).toBe("gateway");
  });

  it("buildRuntimeContextForSession defaults sessionId to empty string", () => {
    const logger = createMockLogger();
    const adapter = new BridgeHostAdapter({ logger, dataDir: "/tmp/tdai" });

    const ctx = adapter.buildRuntimeContextForSession("session-2");
    expect(ctx.sessionKey).toBe("session-2");
    expect(ctx.sessionId).toBe("");
  });

  it("getDataDir returns the resolved data directory", () => {
    const logger = createMockLogger();
    const adapter = new BridgeHostAdapter({ logger, dataDir: "/custom/path" });
    expect(adapter.getDataDir()).toBe("/custom/path");
  });

  it("hostType is standalone", () => {
    const logger = createMockLogger();
    const adapter = new BridgeHostAdapter({ logger });
    expect(adapter.hostType).toBe("standalone");
  });
});
