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

待办：高风险 handler 走后端 tool 审批管道；`BlockingInteractionBar` 新 kind。
