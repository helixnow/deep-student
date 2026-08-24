# Generative UI 模块集成路线图

> 合并 Round 1 子代理 #4 / #7 / #8 结论

## 学习模块（#4 题库 / Anki / Learning Hub）

| 场景 | blocks | action handlers |
|------|--------|-----------------|
| 复习概览 | stat-card + progress + list | `start-review` → `fsrsReviewStore.startDueSession` |
| 错题诊断 | mistake-analysis + list | `open-qbank` → qbankDriver |
| 闪卡预览 | flashcard-preview（已落地） | `save-to-library` → `saveCardsToLibrary` ✅ |

**原则**：不重写 `anki_cards` 专用块；generative-ui 做轻量摘要入口。

## Research / Translation（#7）

| 建议块 | 协议 | 状态 |
|--------|------|------|
| `paper_digest` | NDJSON 快照（参照 `paperSave.tsx`） | ✅ generative-ui `paper-digest` 块 POC |
| `research_report` | 流式 markdown + citation `[类型-N]` | ✅ generative-ui `research-report` 块 POC |
| `research_plan` | 映射 HpiasStore 事件词汇表 | ✅ generative-ui `research-plan` 块 POC + **HpiasStore 实时接线** Round 14 |

**原则**：rAF 批处理 + 终态 `toolOutput` 双通道；引用走 `BackendSourceInfo` / `Block.citations`。

| 场景 | 落点 | 状态 |
|------|------|------|
| 翻译会话简报 | `TranslationContentView` | ✅ Round 15 |
| 流式翻译简报 | `translationStreamBridge` + `streamKey` | ✅ Round 17 |
| HPIAS Chat 实时研究 | `generative_ui` 块 + `hpias_event` | ✅ Round 16 |
| Research action handlers | `copy-report` / `export-plan` Chat+HPIAS | ✅ Round 18 |
| 全模块 integration contract | mount/bridge/handler 静态验证 | ✅ Round 19 |
| Rust HPIAS emit POC | `hpias::HpiasEventEmitter` + executor 接线 | ✅ Round 20 |
| Rust HPIAS pipeline orchestrator | `HpiasPipelineOrchestrator` + payloads 生命周期 | ✅ Round 21 |
| HPIAS 可替换后端 + 运行时验收 | `HpiasResearchBackend` + lifecycle contract + runtime test | ✅ Round 22 |
| 14 块全量 runtime + Chat HPIAS E2E | `generativeUIAllBlocksRuntime` + `generativeUIChatBlockHpiasRuntime` | ✅ Round 23 |
| VFS retrieval HPIAS backend | `RetrievalHpiasResearchService` + env `retrieval` | ✅ Round 24 |
| HPIAS LLM synthesis | `hpias/synthesis.rs` + Model2 Markdown 综合 | ✅ Round 25 |
| SOTA acceptance contract | 15 项集成要求静态验收 | ✅ Round 20 |
| 18 块 + Intent v1.1 + telemetry + fallback | markdown/chart/steps/table + coercePartialIntent + undo | ✅ Round 40/41 |

## 安全 / HITL（#8）

| riskLevel | UX | 状态 |
|-----------|-----|------|
| low | 直接执行 | ✅ |
| medium | 二次点击确认 | ✅ |
| high | `DsAlertDialog` | ✅ |
| 有效级别 | `max(模型, handler)` | ✅ |
| AI 标记 | `AiContentLabel` | ✅ |

## Workbench（#5 仪表盘）

| 场景 | 落点 | 状态 |
|------|------|------|
| AI 学习简报 widget | `DesktopAgendaWidget` 同级 | ✅ |
| Chat generative_ui 块 | blockRegistry + eventRegistry | ✅ |
| AI 仪表盘应用窗口 | 新 `AppDefinition` + agentManifest | ✅ Round 13 |

## 流式管道（#9）

| 项 | 状态 |
|----|------|
| Rust SSE → Tauri 事件 → chunkBuffer | 既有 Chat V2 管道 |
| `plugins/events/generativeUI.ts` | ✅ |
| 块级增量 parser（闭合 block 提交 + last-good） | ✅ |
| 后端 emit `generative_ui` 事件 | ✅ |

## Notes（#3）

| 项 | 规范 |
|----|------|
| 首选宿主 | `NotesContextPanel` 只读摘要 |
| 写入 | 仅 `canvas:ai-edit-request` + OCC |
| 全文 | `getFullMarkdown()` / DSTU |
| 详情 | `NOTES_INTEGRATION.md` |
