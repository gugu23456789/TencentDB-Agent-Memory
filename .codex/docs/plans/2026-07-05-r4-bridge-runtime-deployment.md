# R4: Bridge 运行时部署

## 目标

让 Bridge 在本地开发环境中完整跑起来：MCP server 通过 gates → TDAI Gateway → TdaiCore 链路打通，可观测层（OTLP）验证通过。

## 前提

- R3 已完成（IObservabilityBackend 布线 + AuditGate 全量采样 + 5 道 gates：rate-limit、circuit-breaker、audit、redteam、API Key）
- TS gates 11 测试 + CI 8/8 all green
- `r3-v1` (bridge-adapter) 分支，v1.0.0 基座

## 成果

### Stage 1: 本地部署（基础）— ✅ 完成

| 组件 | 状态 | 说明 |
|:-----|:------|:------|
| Python 3.11+ 环境 | ✅ | 虚拟环境 `.venv-win/`，`pip install bridge_adapter` |
| SDK 安装 | ✅ | `bridge_adapter/` 本地可导入 |
| MCP server | ✅ | `python -m bridge.mcp.server` 启动，5 gates 加载 |
| Gateway 连接 | ✅ | `TDAI_ENDPOINT=http://127.0.0.1:8420` |
| Python E2E 测试 | ✅ | `test_e2e.py` — 8 tests，mock Gateway，零外部依赖 |
| TS E2E 测试 | ✅ | `gate-e2e.test.ts` — 7 tests，gate transparency 验证 |
| 本地开发指南 | ✅ | `docs/local-dev.md` — venv、env vars、IDE 对接、架构图 |
| Python venv 迁移 | ✅ | 从全局 pip 迁移到 `.venv-win/`（`python -m pytest` 可运行） |

E2E 验证路径：

```
MCP Client (stdio)
  → bridge/mcp/server.py (G0-G4 gates)
  → BridgeAdapter (httpx)
  → Mock/Real TDAI Gateway (:8420)
  → TdaiCore
```

### Stage 2: OTLP 管线验证（可观测）— ✅ 完成

| 组件 | 状态 | 说明 |
|:-----|:------|:------|
| npm OTel 包 | ✅ | `@opentelemetry/*` 7 包项目级 node_modules |
| Jaeger v2.19.0 | ✅ | 已验证运行，OTLP HTTP :4318 + UI :16686 |
| 配置文件 | ✅ | `all-in-one.yaml` — OTLP HTTP receiver + memory storage |
| OTel SDK 初始化 | ✅ | `initObservabilityBackend({ type: "otlp" })` 通过 |
| E2E trace 推送 | ✅ | `scripts/otlp-verify.ts` — SDK init → report → OTLP → Jaeger |
| OTLP 设置指南 | ✅ | `docs/otlp-setup.md` — 完整配置 + 排错 |
| 全链路验证 | ✅ | `test-bridge` 服务注册在 Jaeger 中确认 |

验证链路：

```
TS trace.report() → OTel SDK → OTLP/HTTP → Jaeger (:4318) → UI (:16686)
                                                              ↓
                                                 Services: test-bridge ✅
```

### Stage 3: 架构调研 — ✅ 完成

| 调研 | 结论 |
|:-----|:------|
| agentgateway 集成 | 不集成。当前 5 工具的 RBAC 可通过 ~40 行 Python 等价实现。agentgateway 优势（JWT、CEL、Streamable HTTP）在桌面/开发场景无价值 |
| TAIG Gateway 多租户 | TDAI 本身通过 `x-tdai-service-id` 实现数据级多租户。我们没有重复实现 |
| MCP_health 降级 | `bridge/mcp_health.py` 已实现（1 tool `tdai_health`，4 gates，独立进程） |
| 三级降级链 | L1 agentgateway → L2 self-gated server.py → L3 mcp_health（全部就绪） |

### 基础设施改进

| 改动 | 说明 |
|:-----|:------|
| `.gitignore` | 添加 `.venv/` `.venv-win/` |
| `package.json` | OTel 包对齐 v1.x（`resources@1.30.1` `sdk-node@0.54.0`）以兼容代码中的 `new Resource()` API |
| `package-lock.json` | 重新生成（clean npm install，无 `--legacy-peer-deps`） |
| `.github/workflows/pr-ci.yml` | 修复 L5 编码检测：`test_e2e.py` 中的非 ASCII 箭头/破折号替换为 ASCII 等价 |

## 验证标准

| 项目 | 标准 | 结果 |
|:-----|:------|:------|
| CI | 不变红 | ✅ 最终状态 CI 通过 |
| MCP server | 启动正常，gates 初始化通过 | ✅ |
| Python E2E | 8/8 通过 | ✅ |
| TS E2E | 7/7 通过 | ✅ |
| OTLP Jaeger | trace 推送并注册服务 | ✅ `test-bridge` 在 Jaeger 中可见 |
| IDE 对接 | MCP stdio 配置一行 `python -m bridge.mcp.server` | ✅ `docs/local-dev.md` |

## 待办（等待上游回复 #235）

- TS 端 E2E 完整集成（需等待 PR #385 沟通完成）
- agentgateway 部署集成（如需生产集群部署）
- Gate 5 RBAC（如需多用户场景）

## 相关文件

```
bridge/mcp/server.py              ← MCP 服务器入口（5 tools, 5 gates）
bridge/mcp_health.py              ← MCP 降级健康检查（1 tool, 4 gates）
bridge/mcp/tests/test_e2e.py      ← Python E2E 测试（8 tests）
src/core/gates/gate-e2e.test.ts   ← TS E2E 测试（7 tests）
docs/local-dev.md                 ← 本地开发指南
docs/otlp-setup.md                ← OTLP 管线设置指南
scripts/otlp-verify.ts            ← OTLP 验证脚本
docs/ADAPTER-INTEGRATION.md       ← 接入指南（已就绪）
```

## 仓库状态（2026-07-07）

```
53b4cc5 fix: restore OTel deps to upstream-compatible v1.x line
44d6677 fix: ci encoding defense + OTel version mismatch
0ba65c5 r3-v1: R4 local deploy + OTLP pipeline
7f89157 docs: add adapter integration guide
```

分支：`bridge-adapter`（本地）↔ `origin/r3-v1`（远端同名）
领先 upstream/main 18 commits，落后 98 commits（v1.0.0 与 0.3.x 线自然分叉）

<!-- META
target_repo: TDAI Bridge
base: v1.0.0 via r3-v1 (bridge-adapter)
status: completed - waiting for upstream #235 before next steps
-->
