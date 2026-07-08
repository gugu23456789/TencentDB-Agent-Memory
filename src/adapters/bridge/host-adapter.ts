/**
 * BridgeHostAdapter — HostAdapter for Bridge MCP users.
 *
 * A minimal reference HostAdapter for desktop/local use via the Bridge.
 * Environment-driven: reads TDAI_ENDPOINT, TDAI_API_KEY, TDAI_SERVICE_ID.
 *
 * This is the TS-side counterpart to the Python BridgeAdapter (bridge_adapter/)
 * and the MCP stdio server (bridge/mcp/server.py).
 *
 * To add a new platform adapter, copy this file, rename the class, and
 * fill in the three HostAdapter methods. ~60 lines is all you need.
 *
 * Community: https://github.com/TencentCloud/TencentDB-Agent-Memory
 */

import { StandaloneLLMRunnerFactory } from "../standalone/llm-runner.js";
import type { StandaloneLLMConfig } from "../standalone/llm-runner.js";
import type {
  HostAdapter,
  RuntimeContext,
  Logger,
  LLMRunnerFactory,
} from "../../core/types.js";

// ============================
// Options
// ============================

export interface BridgeHostAdapterOptions {
  /** Logger instance. */
  logger: Logger;
  /** Data directory (default: env TDAI_DATA_DIR or system tmp). */
  dataDir?: string;
  /** Default user ID (default: env USERNAME or "bridge_user"). */
  defaultUserId?: string;
  /** LLM configuration (optional — skipped if not needed). */
  llmConfig?: StandaloneLLMConfig;
}

// ============================
// BridgeHostAdapter
// ============================

export class BridgeHostAdapter implements HostAdapter {
  readonly hostType = "standalone" as const;

  private logger: Logger;
  private dataDir: string;
  private defaultUserId: string;
  private runnerFactory: StandaloneLLMRunnerFactory | null = null;

  constructor(opts: BridgeHostAdapterOptions) {
    this.logger = opts.logger;
    this.dataDir = opts.dataDir ?? process.env.TDAI_DATA_DIR ?? ".";
    this.defaultUserId = opts.defaultUserId ?? process.env.USERNAME ?? "bridge_user";

    if (opts.llmConfig) {
      this.runnerFactory = new StandaloneLLMRunnerFactory({
        config: opts.llmConfig,
        logger: opts.logger,
      });
    }
  }

  getRuntimeContext(): RuntimeContext {
    return {
      userId: this.defaultUserId,
      sessionId: "",
      sessionKey: process.env.TDAI_SERVICE_ID ?? "",
      platform: "gateway",
      workspaceDir: this.dataDir,
      dataDir: this.dataDir,
    };
  }

  getLogger(): Logger {
    return this.logger;
  }

  getLLMRunnerFactory(): LLMRunnerFactory {
    // If no LLM config provided, return a minimal factory that errors
    if (!this.runnerFactory) {
      return {
        createRunner: () => ({
          run: async () => {
            throw new Error("LLM not configured. Provide llmConfig in BridgeHostAdapterOptions.");
          },
          shutdown: async () => {},
        }),
      };
    }
    return this.runnerFactory;
  }
}
