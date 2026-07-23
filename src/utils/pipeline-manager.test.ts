/**
 * Tests for MemoryPipelineManager — focuses on the flushSession mechanism
 * (PR #507: replace L1 idle polling with explicit flushSession).
 *
 * Verifies:
 * - flushSession enqueues L1 when there is pending work
 * - flushSession is a no-op when session has nothing pending
 * - getQueueSizes reflects L1 activity after flush
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { PipelineConfig, L1Runner, CapturedMessage } from "./pipeline-manager.js";
import type { Logger } from "../core/types.js";

const TEST_CONFIG: PipelineConfig = {
  everyNConversations: 5,
  enableWarmup: false,
  l1: { idleTimeoutSeconds: 600 },
  l2: {
    delayAfterL1Seconds: 90,
    minIntervalSeconds: 900,
    maxIntervalSeconds: 3600,
    sessionActiveWindowHours: 24,
  },
};

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeMessage(role: "user" | "assistant" = "user", content = "hello"): CapturedMessage {
  return { role, content, timestamp: new Date().toISOString() };
}

describe("MemoryPipelineManager — flushSession", () => {
  let manager: MemoryPipelineManager;
  let mockL1Runner: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockL1Runner = vi.fn().mockResolvedValue({ processedCount: 1 });

    manager = new MemoryPipelineManager(TEST_CONFIG, createMockLogger());
    manager.setL1Runner(mockL1Runner as unknown as L1Runner);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it("flushSession enqueues L1 when there are buffered messages", async () => {
    // Simulate a conversation notification
    manager.notifyConversation("session-1", [makeMessage(), makeMessage()]);

    const before = manager.getQueueSizes();
    expect(before.l1Idle).toBe(true);

    // Flush the session
    await manager.flushSession("session-1");

    // After flush, L1 should have been enqueued — idle should be false
    // (the mock runner resolves instantly, so by the time flushSession
    //  returns, the queue may already be idle again)
    const after = manager.getQueueSizes();
    expect(after.l1).toBe(0); // mock runner runs synchronously
    expect(after.l1Pending).toBe(false);

    // The mock runner should have been called
    expect(mockL1Runner).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "session-1" }),
    );
  });

  it("flushSession is a no-op when session has no pending work", async () => {
    // No conversation notified for this session
    const queueBefore = manager.getQueueSizes();

    await manager.flushSession("unknown-session");

    const queueAfter = manager.getQueueSizes();
    expect(queueAfter.l1).toBe(queueBefore.l1);
    expect(queueAfter.l1Pending).toBe(queueBefore.l1Pending);
    expect(mockL1Runner).not.toHaveBeenCalled();
  });

  it("flushSession triggers L1 even when messages array is empty but conversation_count > 0", async () => {
    // notifyConversation with empty messages still increments conversation_count
    manager.notifyConversation("session-2", []);

    // Wait briefly so the mock runner can process if enqueued
    await manager.flushSession("session-2");

    // Mock runner should have been called because conversation_count > 0
    expect(mockL1Runner).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "session-2" }),
    );
  });

  it("multiple sessions can be flushed independently", async () => {
    manager.notifyConversation("session-a", [makeMessage()]);
    manager.notifyConversation("session-b", [makeMessage()]);

    await manager.flushSession("session-a");
    expect(mockL1Runner).toHaveBeenCalledTimes(1);

    await manager.flushSession("session-b");
    expect(mockL1Runner).toHaveBeenCalledTimes(2);
  });

  it("flushSession on an already-idle session does not re-enqueue L1", async () => {
    manager.notifyConversation("session-3", [makeMessage()]);
    await manager.flushSession("session-3");
    expect(mockL1Runner).toHaveBeenCalledTimes(1);

    // Flush again — no new L1 work pending
    await manager.flushSession("session-3");
    // The count should NOT increase (no new work)
    expect(mockL1Runner).toHaveBeenCalledTimes(1);
  });

  it("destroyed manager is a no-op for flushSession", async () => {
    await manager.destroy();
    // After destroy, notify + flush should be no-ops
    manager.notifyConversation("session-destroyed", [makeMessage()]);
    await manager.flushSession("session-destroyed");
    expect(mockL1Runner).not.toHaveBeenCalled();
  });
});
