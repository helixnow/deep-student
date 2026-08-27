# Wave2-E 第 3 轮审阅 · 事件链兼容性（08）

- 审阅角色：审阅员-事件链（0824 Wave2-E r3）
- 审阅对象（以工作区当前最新代码为准，可能仍在被改）：
  - `src-tauri/src/streaming_anki_service.rs`：`emit_generation_stats`（L3030）、`emit_critic_summary`（L3055）、`emit_generation_warning`（L3083）、`complete_task_successfully` / `TaskCompleted`（L3107–3140）、成功收尾编排（L665–701）
  - `src/features/chat/adapters/TauriAdapter.ts`：`handleAnkiGenerationEvent`（L1441–1859）
  - `src/features/chat/plugins/blocks/ankiCardsBlock.tsx`：`AnkiCardsBlockData`（L125–188）
  - 其余 `anki_generation_event` 监听方：`CardAgent.ts`、`ankiCompletionNotifier.ts`、`ankiTaskSource.ts`、debug 面板插件
- 约束遵守：未改产品代码、未跑测试、未 commit。

## 结论速览

**兼容阻断：无。** 新增的 `GenerationStats` / `CriticSummary`（以及此前已加的 `GenerationWarning`）是纯新增外部标签事件，走既有 `anki_generation_event` 通道，所有前端监听方对未知标签均安全忽略，不打断旧前端、不写错 block、documentId snake/camel 双解已覆盖。

## 1. 新事件的线格式与既有契约一致

后端既有事件由 serde 默认外部标签序列化（`{ "NewCard": {...} }`，见 `models.rs` L1683–1686 注释）。两个新事件用 `json!` 手工构造，形状与之完全一致——单 key 外部标签包一个 snake_case 字段对象：

```3037:3047:src-tauri/src/streaming_anki_service.rs
        let payload = json!({
            "GenerationStats": {
                "task_id": task_id,
                "document_id": document_id,
                "cards_generated": stats.card_count,
                "failed_cards": stats.failed_cards,
                "duplicate_cards": stats.duplicate_cards,
                "dropped_fragments": stats.dropped_fragments,
                "flagged_cards": stats.flagged_cards,
            }
        });
        if let Err(e) = window.emit("anki_generation_event", &payload) {
```

`CriticSummary`（L3062–3075）同构，字段为 `examined/kept/revised/flagged/rejected_unknown_ids/skipped_over_budget/persist_failures/degraded`，均带 `task_id` + `document_id`。两者都不外裹 `StreamEvent { payload }`，与 `TaskCompleted` 等直接 emit `StreamedCardPayload` 的路径一致；`handleAnkiGenerationEvent` 首行 `raw = payload.payload ?? payload`（L1442）两种包装都能解。

## 2. 是否打断旧前端 —— 逐个监听方核对

### 2.1 TauriAdapter `handleAnkiGenerationEvent`（主消费方）

- 归一化逻辑（L1445–1455）：非 `{type,data}` 形状时取对象首个 key 作 type。`GenerationStats`/`CriticSummary` 均为单 key 对象，归一化正确得到 type 与 data。
- 未知 type 的流转路径：提取 documentId → owner 守卫（带 documentId 的事件直接放行，同既有行为）→ `findBlockByDocumentId` 精确匹配（L1492–1499）。之后进入分支匹配：`NewCard/NewErrorCard`（L1663）、`TaskStatusUpdate/DocumentProcessingStarted`（L1720）、`TaskCompleted`（L1752）、`DocumentProcessingCompleted`（L1762）、`TaskProcessingError`（L1794）、`DocumentProcessingCancelled`（L1800）、`TaskFailed/DocumentProcessingFailed/WorkflowFailed`（L1828）——新标签一个都不命中，函数自然走完返回，**零 `updateBlock` / 零 `updateBlockStatus` 调用**。
- 分支前的公共代码无副作用：`retryRelevantEvent` 白名单（L1562–1571）不含新标签 → `isRetryFlow` 为 false → 不会往 `retryingAnkiDocumentIds` 添加条目；`ensureDocumentId` 只在各分支的 `updateBlock` 内展开，未命中分支就不会写入。唯一动作是派发 `chatanki-debug-lifecycle` 的 route 调试事件（L1544–1557），debug-only 且 try/catch 包裹。
- `cardData` 提取（L1461）会把 stats 对象误当 `AnkiCard` 赋值，但该变量仅在 `NewCard/NewErrorCard` 分支使用，不会被消费。

### 2.2 CardAgent（cardforge 旧引擎）

`handleBackendEvent`（L1054 起）按已知 key 逐一 `if (payload.NewCard) ... if (payload.TaskCompleted) ...` 判断，无 else 抛错分支；`BackendStreamedCardPayload` 接口（L99–133）不含新标签 → 新事件全部 fall-through，无崩溃。注意：cardforge 自己有一个同名但无关的本地 `GenerationStats` 类型（`cardforge/types/index.ts` L79），仅命名巧合，不构成冲突。

### 2.3 ankiCompletionNotifier / ankiTaskSource / TaskDashboard

- 通知器只按 `DocumentProcessingStarted` / `DocumentProcessingCompleted` 两个 variant 名提取（L25–45），其他标签返回 null 直接忽略。
- `ankiTaskSource` 的 `hubListen('anki_generation_event', ...)`（L104）对 payload 完全不敏感，任何事件都只触发一次 `list_document_sessions` 对账刷新。新事件每任务多触发 1–2 次刷新 IPC，量级可忽略。
- debug 面板插件为展示性消费，未知标签按原样显示。

## 3. 是否写错 block

不会。两个新事件都携带 `document_id`，在 adapter 里走「有 documentId 只精确匹配、禁止回退最新活跃块」的 P1 止血路径（L1509–1517）：匹配到块也不写（无命中分支），匹配不到就静默 drop（L1518–1531）。串块的前提（无 documentId + fallback）对新事件不成立。

## 4. snake/camel 是否双解

- adapter 的 documentId 提取（L1462–1467）依次尝试 `data.document_id` → `data.documentId` → `card.document_id` → 顶层 `document_id/documentId`，snake/camel 双解齐全；新事件发 snake_case，命中第一条。
- 新事件的业务字段（`cards_generated`、`examined` 等）目前**前端无任何消费者**，不存在解析歧义；将来加消费者时按后端 snake_case 读即可（与 `NewCard.card.template_id` 等既有约定一致）。
- `AnkiCardsBlockData` 未新增 stats/critic 字段，新事件不落块数据 → 块持久化 schema 无变化，旧会话回放不受影响。

## 5. 事件时序核对（成功收尾链）

L665–701 的顺序为：`emit_generation_stats` → critic pass（opt-in，默认关闭，永不 Err）→ `emit_critic_summary` → `complete_task_successfully`（先 `update_task_status(Completed)` 再 emit `TaskCompleted`）。要点：

- `TaskCompleted` 在 critic 的 DB 写回**之后**发出，前端 `TaskCompleted` 分支的 `scheduleAnkiRetryReconcile`（L1756–1758）对账时能拿到 revise 后的卡片；`ankiCards.ts` 的 `mergeFinalCardsWithCurrent` 也已按 `updated_at` 采纳 critic CAS 新版本（L235–264）。时序自洽。
- 新事件插在 NewCard 流与 TaskCompleted 之间，不改变任何既有事件的相对顺序。

## 6. 非阻断观察项

1. **信息目前无人消费**：`GenerationStats` / `CriticSummary` 前端零消费者（全仓 grep 仅命中 cardforge 的同名无关类型），属"先发后用"的预埋。若本轮其他人正在加前端消费，需按 snake_case 读且不要把它加进 `retryRelevantEvent` 白名单（否则会误触 retry reconcile）。
2. **critic 开启时 TaskCompleted 延迟**：critic pass 是批量 LLM 调用，串在 stats 与 TaskCompleted 之间。opt-in 关闭时无影响；开启后若模型慢，前端块会在 `streaming` 阶段多停留一段（`chatanki_wait` 超时预算需覆盖该延迟）。行为性风险，非契约破坏。
3. **stats 先于 critic 发出**：`flagged_cards` 等计数反映 critic 前的状态，与 `CriticSummary.flagged` 语义不同源，将来消费方展示时勿混用。

## 最终判定

- 兼容阻断：**无**。
- 一句风险：新事件本身零消费者且全链路安全忽略，唯一实际风险是 critic 开启后 `TaskCompleted` 被批量 LLM 裁决拖后，可能顶到前端 `chatanki_wait` 的等待预算。
