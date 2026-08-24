# Generative UI SOTA 验收清单

> 分支 `Generative-UI-0824` · Round 41/42/43 · 对照目标态「结构化意图 + 组件注册表」

## 架构核心

| 要求 | 证据 | 状态 |
|------|------|------|
| Zod schema 校验层 | `src/features/generative-ui/schema.ts` | ✅ |
| 组件注册表 | `registry.ts` + `blocks/index.ts` | ✅ |
| 18 种内置块 | `generativeUIModuleIntegration.contract.test.ts` | ✅ Round 40 |
| 18 块运行时渲染 | `generativeUIAllBlocksRuntime.test.tsx` | ✅ Round 40 |
| 流式 parser + chunkBuffer | `parser.ts` + `generativeUIStreamRegistry` | ✅ |
| actionHandlers 确定性副作用 | `handlers/` + HITL riskLevel | ✅ |
| Intent v1.1 layout | `schema.ts` layout.mode stack/grid | ✅ Round 40 |
| Rust v1.1 version/layout 契约 | `generative_ui_executor.rs` + e2e | ✅ Round 41 |
| 18 块宿主接线 | Exam/Memory/Index/Hub/Notes/Translation/HPIAS/Dashboard | ✅ Round 41 |
| 渲染隔离 | `GenerativeBlockSlot` memo + ErrorBoundary | ✅ Round 41 |
| Markdown XSS 消毒 | `sanitizeGenerativeMarkdown` | ✅ Round 41 |
| 流式 last-good 恢复 | `coercePartialIntent` + Renderer fallback | ✅ Round 40 |
| Action telemetry + undo | `actionTelemetry.ts` / `actionUndoStack.ts` | ✅ Round 40 |
| A11y landmarks | `generativeUIA11y.contract.test.tsx` | ✅ Round 40/41 |
| 移动端 compact | `useGenerativeUICompact` 窄屏强制 stack | ✅ Round 42 |
| i18n 完整合同 | `generativeUiI18n.parity.contract.test.ts` | ✅ Round 42 |
| 18 块 testid 合同 | `data-generative-block` | ✅ Round 42 |
| v1 → v1.1 migrate | `migrateIntentToV11` | ✅ Round 42 |
| export | `buildResearchExportMarkdown` / 通用 intent 导出合同 | ⏳ Round 43 进行中 |
| reduced-motion | `prefers-reduced-motion` 流式/图表/过渡降级 | ⏳ Round 43 进行中 |
| normalize | `normalizeIntent` 公开契约 | ⏳ Round 43 进行中 |
| color contract | 宪法 §4 语义色 / 禁裸 hex | ⏳ Round 43 进行中 |
| buffer cap | `parser.ts` `MAX_BUFFER_BYTES` 上限合同 | ⏳ Round 43 进行中 |

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
| Learning Hub (Exam/Memory/IndexStatus) | `*GenerativeBriefing` + table/chart/steps/markdown | ✅ Round 41 |
| Workbench | `DesktopAiBriefingWidget` + AiDashboard | ✅ Round 41 接入新块 |
| Notes | `NotesContextPanel` + edit suggestion + 新块 | ✅ Round 41 |
| Translation | 会话 + 流式简报 + 新块 | ✅ Round 41 |
| Research | plan/report/digest + HPIAS 面板 + 新块 | ✅ Round 41 |
| Mindmap | mindmap-embed E2E | ✅ |

## Round 42 补洞

| 项 | 证据 / 落点 | 状态 |
|----|-------------|------|
| 移动端 compact | `useGenerativeUICompact` 窄屏强制 stack | ✅ |
| migrateToV11 | `migrateIntentToV11` | ✅ |
| i18n 完整合同 | zh-CN / en-US 243 key 对齐 | ✅ |
| 宿主新块测试 | `hostBriefingNewBlocks.runtime.test.tsx` | ✅ |
| ActionBar 键盘 | `actionBarKeyboard.test.tsx` | ✅ |
| 18 块 testid 合同 | `data-generative-block` | ✅ |
| Chat 块新 type 路径 | `generativeUIChatBlock.newTypes.test.tsx` | ✅ |
| Widget 回归 | DesktopAiBriefing / AiDashboard chart\|table | ✅ |
| last-good 持久化 | `generativeUIStreamPersistence` | ✅ |
| SOTA 文档补洞 | 本清单 + ARCHITECTURE / ROADMAP / PROGRESS | ✅ |

## Round 43 进行中

| 项 | 证据 / 落点 | 状态 |
|----|-------------|------|
| export | `buildResearchExportMarkdown` / 通用 intent 导出合同 | ⏳ |
| reduced-motion | `prefers-reduced-motion` 流式/图表/过渡降级 | ⏳ |
| normalize | `normalizeIntent` 公开契约 | ⏳ |
| color contract | 宪法 §4 语义色 / 禁裸 hex | ⏳ |
| buffer cap | `parser.ts` `MAX_BUFFER_BYTES` 上限合同 | ⏳ |

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
| generative-ui vitest | `npx vitest run tests/vitest/generative-ui` | ✅ 以 vitest generative-ui 套件为准 |
| Frontend licenses | `npm run licenses:check`（Round 31 zod 同步） | ✅ |
| SOTA 静态验收 | `generativeUISotaAcceptance.contract.test.ts` | ✅ |
| 全模块 integration contract | `generativeUIModuleIntegration.contract.test.ts` | ✅ |
| Rust fmt | `cargo fmt --check`（Round 30 修复） | ✅ |
| Rust hpias 单测 | `cargo test hpias` | ⏳ 需 GTK + stable Rust CI |

## 距 SOTA 完整态剩余项

1. ~~**PR Ready for Review**~~ — ✅ Round 27 已转 Ready（[#214](https://github.com/helixnow/deep-student/pull/214)）
2. **合并 main** — 待 CI 绿 + 人工 approve（仍 ⏳，Goal 未标 complete）
3. ~~**Round 42 补洞**~~ — ✅ 本地完成（未 push，保护 CI）
4. **Round 43 契约加固** — export / reduced-motion / normalize / color contract / buffer cap（⏳ 进行中）
5. **桌面手动 smoke**（可选）— 见 [TAURI_E2E.md](./TAURI_E2E.md)

## Goal 完成度（2026-08-24）

| 目标项 | 证据 | 状态 |
|--------|------|------|
| 结构化意图 + 组件注册表落地 | `schema.ts` / `registry.ts` / 18 blocks + 宿主/隔离/消毒/v1.1 Rust | ✅ 分支真实态（Round 41/42） |
| 多轮迭代至 SOTA | Round 6–43；R43 export/reduced-motion/normalize/color/buffer 未收口 | ⏳ 进行中（不标 complete） |
| 方案与进度持续记录 | ARCHITECTURE / PROGRESS / ROADMAP / TAURI_E2E / SOTA | ✅ |
| 合入 main | PR #214 | ⏳ 待 merge（未合入 main） |

进度详见 [PROGRESS.md](./PROGRESS.md)
