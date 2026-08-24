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
| `research_plan` | 映射 HpiasStore 事件词汇表 | ✅ generative-ui `research-plan` 块 POC |

**原则**：rAF 批处理 + 终态 `toolOutput` 双通道；引用走 `BackendSourceInfo` / `Block.citations`。

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
| AI 学习简报 widget | `DesktopAgendaWidget` 同级 | 📋 Round 3 |
| Chat generative_ui 块 | blockRegistry + eventRegistry | ✅ |
| AI 仪表盘应用窗口 | 新 `AppDefinition` + agentManifest | 📋 Round 4 |

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
