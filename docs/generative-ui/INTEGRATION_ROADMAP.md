# Generative UI 模块集成路线图

> 合并 Round 1 子代理 #4 / #7 / #8 结论

## 学习模块（#4 题库 / Anki / Learning Hub）

| 场景 | blocks | action handlers |
|------|--------|-----------------|
| 复习概览 | stat-card + progress + list | `start-review` → `fsrsReviewStore.startDueSession` |
| 错题诊断 | mistake-analysis + list | `open-qbank` → qbankDriver |
| 闪卡预览 | flashcard-preview（已落地） | `save-to-library` → chat/anki 管线 |

**原则**：不重写 `anki_cards` 专用块；generative-ui 做轻量摘要入口。

## Research / Translation（#7）

| 建议块 | 协议 |
|--------|------|
| `paper_digest` | NDJSON 快照（参照 `paperSave.tsx`） |
| `research_report` | 流式 markdown + citation `[类型-N]` |
| `research_plan` | 映射休眠 HpiasStore 事件词汇表 |

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
| 后端 emit `generative_ui` 事件 | 📋 Rust 侧待补 |
