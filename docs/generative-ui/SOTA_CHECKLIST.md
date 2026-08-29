# Generative UI SOTA 验收清单

> 分支 `Generative-UI-0824` · Round 41–49 + Wrap-up · 对照目标态「结构化意图 + 组件注册表」

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
| export | `buildIntentExportMarkdown` + research 导出 | ✅ Round 43 |
| reduced-motion | `prefers-reduced-motion` 流式/图表/过渡降级 | ✅ Round 43 |
| normalize | `normalizeGenerativeUIIntent` 公开契约 | ✅ Round 43 |
| color contract | 宪法 §4 语义色 / 禁裸 hex | ✅ Round 43 |
| buffer cap | `streamBufferGuard` 256KB 硬上限 | ✅ Round 43 |
| 禁裸 px 合同 | 宪法 §3 字号禁裸 px | ✅ Round 44 |
| overflow UX | `MAX_GENERATIVE_UI_BLOCKS` + `data-blocks-truncated` | ✅ Round 44 |
| intent fingerprint | `fingerprintGenerativeUIIntent` | ✅ Round 44 |
| 文本字段消毒 | `sanitizeGenerativeText` 进 `validateBlockProps` | ✅ Round 44 |
| 明暗主题合同 | `themeToken.contract` | ✅ Round 44 |
| action timeout / rate-limit | `wrapActionWithTimeout` + `wrapActionWithRateLimit` | ✅ Round 45 |
| action live region | ActionBar `aria-live` + 未注册标记 | ✅ Round 45 |
| forced-colors / print | `generative-ui.css` | ✅ Round 45 |
| URL 消毒 | `sanitizeGenerativeUrl` | ✅ Round 45 |
| intent lint / JSON Schema | `lintGenerativeUIIntent` / `exportGenerativeUIJsonSchema` | ✅ Round 45 |

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

## Round 43（本地完成）

| 项 | 证据 / 落点 | 状态 |
|----|-------------|------|
| export | `buildIntentExportMarkdown` | ✅ |
| reduced-motion | chrome / progress / chart | ✅ |
| normalize | `normalizeGenerativeUIIntent` | ✅ |
| color contract | 禁裸 hex | ✅ |
| buffer cap | 256KB 硬上限 | ✅ |

## Round 44（本地完成）

| 项 | 证据 / 落点 | 状态 |
|----|-------------|------|
| 禁裸 px 合同 | `fontSizeToken.contract` | ✅ |
| overflow UX | `data-blocks-truncated` | ✅ |
| intent fingerprint | 稳定 16 hex | ✅ |
| 文本字段消毒 | `sanitizeGenerativeText` | ✅ |
| 明暗主题合同 | `themeToken.contract` | ✅ |
| focus-visible | `--ring` 语义环 | ✅ |
| intent diff | `diffGenerativeUIIntent` | ✅ |
| 新块流式 parser | markdown/chart/steps/table last-good | ✅ |
| recipe i18n | Style Lab `demo.recipes.*` | ✅ |
| SOTA 文档对齐 | 本清单 + PROGRESS | ✅ |

## Round 45

| 项 | 证据 / 落点 | 状态 |
|----|-------------|------|
| action timeout | `wrapActionWithTimeout` 15s | ✅ |
| action rate-limit | `wrapActionWithRateLimit` 400ms | ✅ |
| action live region | `[data-action-live]` | ✅ |
| forced-colors / print | CSS 合同 | ✅ |
| URL 消毒 | `sanitizeGenerativeUrl` | ✅ |
| intent lint | `lintGenerativeUIIntent` | ✅ |
| JSON Schema 导出 | `exportGenerativeUIJsonSchema` | ✅ |
| 稳定 block id | `assignStableBlockIds` | ✅ |
| locale 数字 | `formatGenerativeStatValue` | ✅ |
| telemetry ring | 最近 50 条 | ✅ |
| live timeout / rate-limit | ActionBar 区分错误码 | ✅ Round 46 |
| prefers-contrast | `usePrefersContrast` + CSS | ✅ Round 46 |
| dir=auto | Text / Markdown | ✅ Round 46 |
| skip-to-actions / fingerprint | Renderer | ✅ Round 46 |
| parse error codes | `classifyGenerativeUIParseErrors` | ✅ Round 46 |
| Style Lab lint | Demo Tab 诊断面板 | ✅ Round 46 |

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
3. ~~**Round 42–44 补洞**~~ — ✅ 本地完成
4. ~~**Round 45 守卫 / 导出 / a11y**~~ — ✅ 本地完成
5. ~~**Round 46 可观测 / 对比度 / 导出**~~ — ✅ 本地完成
6. ~~**Round 47 locale / skill / 引用键盘**~~ — ✅ 本地完成
7. ~~**Round 48 Chat 接线 / Rust 32 / 宿主 i18n**~~ — ✅ 本地完成
8. ~~**Round 49 快照 diff / 流式 / HPIAS**~~ — ✅ 本地完成
9. ~~**Wrap-up 收尾审查**~~ — ✅ 本地完成（leftover `cursor/*` 已覆盖，不 merge 旧 tip）
10. **桌面手动 smoke**（可选）— 见 [TAURI_E2E.md](./TAURI_E2E.md)

## Goal 完成度（2026-08-24）

| 目标项 | 证据 | 状态 |
|--------|------|------|
| 结构化意图 + 组件注册表落地 | `schema.ts` / `registry.ts` / 18 blocks + 宿主/隔离/消毒/v1.1 Rust | ✅ 分支真实态（Round 41–45） |
| 多轮迭代至 SOTA | Round 6–49 + Wrap-up 本地完成；合入 main 仍待 CI | ⏳ 进行中（不标 complete） |
| 方案与进度持续记录 | ARCHITECTURE / PROGRESS / ROADMAP / TAURI_E2E / SOTA | ✅ |
| 合入 main | PR #214 | ⏳ 待 merge（未合入 main） |

进度详见 [PROGRESS.md](./PROGRESS.md)
