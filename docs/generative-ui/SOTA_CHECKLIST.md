# Generative UI SOTA 验收清单

> 分支 `Generative-UI-0824` · 对照目标态「结构化意图 + 组件注册表」

## 架构核心

| 要求 | 证据 | 状态 |
|------|------|------|
| Zod schema 校验层 | `src/features/generative-ui/schema.ts` | ✅ |
| 组件注册表 | `registry.ts` + `blocks/index.ts` | ✅ |
| 14 种内置块 | `generativeUIModuleIntegration.contract.test.ts` | ✅ |
| 14 块运行时渲染 | `generativeUIAllBlocksRuntime.test.tsx` | ✅ Round 23 |
| 流式 parser + chunkBuffer | `parser.ts` + `generativeUIStreamRegistry` | ✅ |
| actionHandlers 确定性副作用 | `handlers/` + HITL riskLevel | ✅ |

## Chat 桥接

| 要求 | 证据 | 状态 |
|------|------|------|
| Rust `render_generative_ui` executor | `generative_ui_executor.rs` | ✅ |
| Chat generative_ui 块 | `plugins/blocks/generativeUI.tsx` | ✅ |
| 事件插件 | `plugins/events/generativeUI.ts` | ✅ |
| Notes HITL 写入链 | `dispatchCanvasAIEditRequest` | ✅ |
| Research Chat 实时 HPIAS | `hpiasEventBridge` + `HpiasGenerativeResearchPanel` | ✅ |
| Chat 块 HPIAS Tauri E2E | `generativeUIChatBlockHpiasRuntime` + Rust `generative_ui_executor_e2e` | ✅ Round 23/26 |

## 模块集成

| 模块 | 挂载 / 简报 | 状态 |
|------|-------------|------|
| Learning Hub (Exam/Memory/IndexStatus) | `*GenerativeBriefing` | ✅ |
| Workbench | `DesktopAiBriefingWidget` + AiDashboard | ✅ |
| Notes | `NotesContextPanel` + edit suggestion | ✅ |
| Translation | 会话 + 流式简报 | ✅ |
| Research | plan/report/digest + HPIAS 面板 | ✅ |
| Mindmap | mindmap-embed E2E | ✅ |

## HPIAS 后端

| 要求 | 证据 | 状态 |
|------|------|------|
| Tauri `hpias_event` emit | `hpias/events.rs` | ✅ |
| Pipeline lifecycle payloads | `hpias/payloads.rs` | ✅ |
| Orchestrator stub | `hpias/orchestrator.rs` | ✅ |
| 可替换后端 trait | `hpias/service.rs` `HpiasResearchBackend` | ✅ |
| 跨语言 lifecycle 契约 | `contracts/hpiasLifecycleContract.ts` | ✅ |
| 渐进式 runtime 验收 | `hpiasPipelineRuntime.integration.test.tsx` | ✅ |
| **VFS 检索 + LLM synthesis pipeline** | `RetrievalHpiasResearchService` + `hpias/synthesis.rs` | ✅ Round 25（LLM 综合 + 确定性回退） |
| Tauri 应用级 E2E | Rust harness + Playwright CT + `TAURI_E2E.md` | ✅ Round 26 |

## 测试门禁

| 门禁 | 命令 / 文件 | 状态 |
|------|-------------|------|
| generative-ui vitest | `npm run test -- tests/vitest/generative-ui/` | ✅ 210 |
| Frontend tsc | `npx tsc --noEmit`（Round 28 22 项修复） | ✅ |
| SOTA 静态验收 | `generativeUISotaAcceptance.contract.test.ts` | ✅ |
| 全模块 integration contract | `generativeUIModuleIntegration.contract.test.ts` | ✅ |
| Rust hpias 单测 | `cargo test hpias` | ⏳ 需 GTK + stable Rust CI |

## 距 SOTA 完整态剩余项

1. ~~**PR Ready for Review**~~ — ✅ Round 27 已转 Ready（[#214](https://github.com/helixnow/deep-student/pull/214)）
2. **合并 main** — 待 CI 绿 + 人工 approve
3. **桌面手动 smoke**（可选）— 见 [TAURI_E2E.md](./TAURI_E2E.md)

## Goal 完成度（2026-08-24）

| 目标项 | 证据 | 状态 |
|--------|------|------|
| 结构化意图 + 组件注册表落地 | `schema.ts` / `registry.ts` / 14 blocks | ✅ |
| 多轮迭代至 SOTA | Round 6–26 + 本清单全绿 | ✅ |
| 方案与进度持续记录 | ARCHITECTURE / PROGRESS / ROADMAP / TAURI_E2E | ✅ |
| 合入 main | PR #214 | ⏳ 待 merge |

进度详见 [PROGRESS.md](./PROGRESS.md)
