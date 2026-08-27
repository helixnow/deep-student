# Wave2-E Round 3 · #03 CriticSummary 前端桥接（adapter 段）

> 角色：0824 Wave2-E 第 3 轮「CriticSummary 前端-1」。
> 约束：未跑编译/测试/CI；未 commit（由上游统一收口）。

## 目标

后端已通过 `anki_generation_event` 派发两个纯新增标签事件（旧前端安全忽略）：

- `CriticSummary`（`src-tauri/src/streaming_anki_service.rs::emit_critic_summary`，载荷来自
  `anki_critic.rs::CriticSummary`，critic opt-in 且任务收尾成功时派发）
- `GenerationStats`（`emit_generation_stats`，流式生成质量统计）

本轮让前端识别这两个标签，把归一化后的载荷 patch 进对应 `anki_cards` 块的
`toolOutput`，供后续轮次的 UI 渲染消费。**本轮不改任何 JSX 渲染。**

## 改动清单

### 1. `src/features/chat/plugins/blocks/components/ankiCardsBlockState.ts`（新增类型 + reducer）

- `AnkiCriticSummary`：`taskId? / documentId? / examined / kept / revised / flagged /
  rejectedUnknownIds / skippedOverBudget / goldReferences / goldReferencesTruncated /
  persistFailures / degraded(string|null) / routedConfigId? / routedModel? /
  routedDegraded? / receivedAt`。
  - `gold_*` 与 `routed_*` 字段后端 struct 已有（`anki_critic.rs` L290-307），事件载荷
    当前未带（`emit_critic_summary` 只发 8 个计数 + degraded）；前端类型先行覆盖，
    后端补发即自动生效，缺省时数值归 0 / optional 缺省。
- `AnkiGenerationStats`：`taskId? / documentId? / cardsGenerated / failedCards /
  duplicateCards / droppedFragments / flaggedCards / receivedAt`。
- `normalizeAnkiCriticSummary(raw)` / `normalizeAnkiGenerationStats(raw)`：
  纯函数 reducer，**同时兼容 snake_case（当前 wire 格式）与 camelCase**；
  数值容忍字符串数字，非法值归 0；非对象载荷返回 `null`（调用方丢弃）。

### 2. `src/features/chat/plugins/blocks/ankiCardsBlock.tsx`（仅接口）

`AnkiCardsBlockData` 新增两个 optional 字段（复用 ankiCardsBlockState 导出的类型）：

- `criticSummary?: AnkiCriticSummary`
- `generationStats?: AnkiGenerationStats`

JSX 渲染零改动。

### 3. `src/features/chat/adapters/TauriAdapter.ts`（仅 `handleAnkiGenerationEvent` 段）

在 `NewCard` 分支之前新增 `type === 'CriticSummary' || type === 'GenerationStats'` 分支：

- 复用函数既有的 documentId 精确路由（两个事件都携带 `document_id`，
  只会精确匹配到对应块，不走「最新活跃块」fallback）。
- 归一化后 patch 写入 `toolOutput.criticSummary` / `toolOutput.generationStats`
  （展开 `currentOutput` + `ensureDocumentId`，不覆盖 cards/progress 等既有字段）。
- **不改块 status、不写 progress、不参与 retry reconcile**
  （未加入 `retryRelevantEvent` 白名单）。终态块（success/error）同样允许 patch——
  这两个事件在任务收尾后到达属正常时序。
- 派发 `chatanki-debug-lifecycle`（phase `bridge:event`）供调试面板观测。

#### 实现取舍：为何 adapter 内联归一化而非 import reducer

文件独占约束限定本轮只能改 `handleAnkiGenerationEvent` 段，import 区属并行
agent 冲突热点，不可动。故：

- 类型安全通过 **inline `import('...').AnkiCriticSummary` 类型引用**对齐共享契约
  （编译期校验，零运行时代价，不新增顶部 import 行）；
- 归一化逻辑在函数内以局部 helper（`pickNum` / `pickStr`）实现，与
  `ankiCardsBlockState` 的导出 reducer 语义一致。
- **后续收敛**（独占解除后）：adapter 顶部补一行
  `import { normalizeAnkiCriticSummary, normalizeAnkiGenerationStats } from '../plugins/blocks/components/ankiCardsBlockState'`
  并删除函数内局部实现，消除双份逻辑。导出 reducer 本轮即为 UI/单测侧的
  规范消费入口。

## 既有分支兼容性

新分支为纯新增 early-return，位于所有既有分支之前但判定条件互斥
（`type` 精确匹配两个新标签），`NewCard` / `NewErrorCard` / `TaskStatusUpdate` /
`DocumentProcessingStarted` / `TaskCompleted` / `DocumentProcessingCompleted` /
`TaskProcessingError` / `DocumentProcessingCancelled` / `TaskFailed` /
`DocumentProcessingFailed` / `WorkflowFailed` 逐字未动；缓存段未触碰。

## 事件契约速查

| 事件 type | wire 载荷（snake_case） | toolOutput 字段 |
| --- | --- | --- |
| `CriticSummary` | `task_id, document_id, examined, kept, revised, flagged, rejected_unknown_ids, skipped_over_budget, persist_failures, degraded`（后端待补：`gold_references, gold_references_truncated, routed_config_id, routed_model, routed_degraded`） | `criticSummary` |
| `GenerationStats` | `task_id, document_id, cards_generated, failed_cards, duplicate_cards, dropped_fragments, flagged_cards` | `generationStats` |

## 未做 / 留给后续轮次

- UI 渲染（badge/摘要行）——本轮明确禁改 JSX。
- 后端 `emit_critic_summary` 补发 `gold_*` / `routed_*` 字段（前端已就绪）。
- adapter 归一化逻辑与共享 reducer 的收敛（见上「后续收敛」）。
- 单测（本轮禁跑测试；`normalizeAnki*` 已设计为纯函数便于补测）。
