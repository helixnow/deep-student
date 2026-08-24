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
| Chat 块 HPIAS Tauri E2E | `generativeUIChatBlockHpiasRuntime.integration.test.tsx` | ✅ Round 23 |

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
| **真实检索/LLM pipeline** | VFS retriever + subagent 编排 | ⏳ 待实现 |
| Tauri 应用级 E2E | 桌面手动 / Playwright | ⏳ 待实现 |

## 测试门禁

| 门禁 | 命令 / 文件 | 状态 |
|------|-------------|------|
| generative-ui vitest | `npm run test -- tests/vitest/generative-ui/` | ✅ 190+ |
| SOTA 静态验收 | `generativeUISotaAcceptance.contract.test.ts` | ✅ |
| 全模块 integration contract | `generativeUIModuleIntegration.contract.test.ts` | ✅ |
| Rust hpias 单测 | `cargo test hpias` | ⏳ 需 GTK + stable Rust CI |

## 距 SOTA 完整态剩余项

1. **真实 HPIAS 研究 pipeline** — 替换 `StubHpiasResearchService`，接入 VFS retrieval + LLM synthesis
2. **Tauri 桌面 E2E** — Chat 中触发 `render_generative_ui` + 观察 live 面板（非 vitest mock）
3. **PR Ready for Review** — 人工 review 后合并 main

进度详见 [PROGRESS.md](./PROGRESS.md)
