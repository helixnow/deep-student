# Wave2-E 第 6 轮 #05 — CriticSummary 前端链路复核（critic-ui）

角色：0824 Wave2-E R6「CriticSummary 复核」。本轮为静态复核 + 当轮补缺口，
按任务约定**未跑编译/测试/CI，未 commit**。未改 `streaming_anki_service.rs`。

独占范围：`AnkiCriticSummaryBanner.tsx`、`ankiCardsBlockState.ts`、
`TauriAdapter.ts`（仅 `handleAnkiGenerationEvent` 段）。

## 结论速览

**前端确认接到 `gold_references`。** 全链路核实如下：

1. 后端 `anki_critic.rs::CriticSummary`（struct，`#[derive(Serialize)]`，无 rename）
   带 `gold_references: u32`（无 `skip_serializing_if`，恒上 wire）；
2. `streaming_anki_service.rs::build_critic_summary_event` 对 struct 整体做 serde
   序列化再 merge `task_id` / `document_id`，外部标签 `{"CriticSummary": {...}}`
   经 `anki_generation_event` 派发（本轮只读核对，未改）；
3. `TauriAdapter.handleAnkiGenerationEvent`（第 1667–1740 行）消费 `CriticSummary`
   标签，`pickNum('gold_references', 'goldReferences')` 归一化为
   `criticSummary.goldReferences`，patch 进 `block.toolOutput.criticSummary`；
4. `AnkiCriticSummaryBanner.parseAnkiCriticSummary` 再次宽松解析
   （`gold_references` / `goldReferences` 双兼容），`goldReferences > 0` 时渲染
   `agent.critic.goldReferences` 明细行（`data-testid="chatanki-critic-gold"`）。

后端单测（`streaming_anki_service.rs` 第 5333 行起，既有、未跑）也断言了
载荷中 `gold_references` / `gold_references_truncated` 的取值与全零缺省态。

## 复核项逐条核实

### 1. 事件消费

- 监听：`TauriAdapter` 第 545 行 `listen('anki_generation_event')` →
  `handleAnkiGenerationEvent`。
- 外部标签解包：`{"CriticSummary": inner}` 走「首 key 为 type、值为 data」分支，
  与 `{type, data}` 双形态兼容。
- 路由：inner 已 merge `document_id` → 按 documentId **精确匹配**块（不限状态，
  终态块允许 patch —— CriticSummary 在任务收尾后到达属正常时序）；无匹配块
  静默丢弃并发 debug 事件，不写脏数据。非 owner adapter 且无 documentId 直接丢弃。
- patch 策略：只写 `toolOutput.criticSummary`（含 `ensureDocumentId` 回填），
  不动 `status` / `progress` / `cards`，不参与 retry reconcile。✅

### 2. snake_case / camelCase

三层全部双兼容：

| 层 | 位置 | 机制 |
| --- | --- | --- |
| 适配器 | `TauriAdapter.ts` 内联 `pickNum` / `pickStr` | `obj[snake] ?? obj[camel]`，字符串数字容错 |
| 归一化契约 | `ankiCardsBlockState.ts::normalizeAnkiCriticSummary` | 同上（契约参考实现，见「已知取舍」） |
| 横幅 | `AnkiCriticSummaryBanner.tsx::parseAnkiCriticSummary` | `readCount(snake, camel)`，负数/NaN 收紧为 0 |

字段覆盖核对（对照 Rust struct）：`examined` / `kept` / `revised` / `flagged` /
`rejected_unknown_ids` / `skipped_over_budget` / `gold_references` /
`gold_references_truncated` / `persist_failures` / `degraded` / `routed_config_id` /
`routed_model` / `routed_degraded` —— 适配器与归一化契约全量覆盖，无遗漏。✅

### 3. 无数据不渲染

- `parseAnkiCriticSummary`：非对象 / 数组 / null → `null`；
  全零且 `degraded` 为空（或空白字符串）→ `null`；组件 `if (!summary) return null`。
- 适配器侧：`dataObj` 非对象直接 return，不写 patch。
- 挂载处（`ankiCardsBlock.tsx` 第 3110 行）单行透传，无条件包裹，
  组件自行决定不渲染。✅

### 4. 不破坏 QA badge

- 横幅与 `AnkiQaFlagBadge`（单卡 `_qa_flags` 徽标）、`AnkiQaFlagsSummaryChip`
  （块级质检摘要）互不依赖：横幅只读 `toolOutput.criticSummary`，
  未触碰 `qaFlagsSummary` 计算与卡片 `_qa_flags` 字段。
- 共用词条 `agent.critic.flaggedFlag` / `revisedFlag` 在 zh-CN / en-US
  两份 `anki.json` 中完好（第 1092–1093 行），本轮未动 i18n。
- 挂载顺序不变：横幅在 `AnkiQaFlagsSummaryChip` 之前、同属
  `chatanki-bottom-actions` 底部操作区。✅

### 5. i18n 词条

`agent.critic.title / summary / skippedOverBudget / goldReferences / degraded /
persistFailures` 在 zh-CN / en-US 双语齐备（`anki.json` 第 1089–1098 行）。✅

## 本轮补掉的缺口

**`AnkiCriticSummaryBanner.tsx` 头注释过时**（本轮唯一代码改动，独占范围内）：

- 旧注释声称「AnkiCardsBlockData 尚未正式声明该字段」——实际
  `ankiCardsBlock.tsx` 第 195 行已声明 `criticSummary?: AnkiCriticSummary`
  （类型来自 `ankiCardsBlockState`）；
- 旧注释的 wire 字段清单漏了 `rejected_unknown_ids` /
  `gold_references_truncated` / `routed_*`；
- 已改写为：完整字段清单 + 说明适配器归一化路径 + 横幅保留 `unknown`
  入参的理由（历史会话持久化数据与序列化策略调整的防御边界）+
  横幅只渲染用户相关子集的分工说明。

纯注释改动，不影响运行行为与既有测试
（`tests/vitest/.../AnkiCriticSummaryBanner.test.tsx`，按历史约定只写未跑）。

## 已知取舍（复核认可，不改）

1. **适配器内联归一化 vs `normalizeAnkiCriticSummary`**：
   `TauriAdapter.handleAnkiGenerationEvent` 内联了 `pickNum` / `pickStr`，
   未直接调用 `ankiCardsBlockState` 的归一化函数——R3 的刻意选择
   （经 inline `import()` 类型引用对齐，避免改动 TauriAdapter import 区，
   见适配器第 1663–1666 行注释）。本轮逐字段比对两处逻辑**完全一致**
   （number 有限性校验、字符串数字容错、空串 degraded 归 null、
   routedDegraded 仅收 boolean），无漂移。若后续放开 import 区限制，
   建议收敛为单一实现。
2. **横幅不展示 `rejectedUnknownIds` / `goldReferencesTruncated` / `routed_*`**：
   观测字段走调试面板（`chatanki-debug-lifecycle` 事件已带全量 patch），
   横幅保持用户视角的最小信息量，符合 R3 设计。
3. **挂载区门控**：横幅位于底部操作区，外层条件含 `cards.length > 0` ——
   理论上「0 卡且 critic 降级」的摘要不会展示，但 critic 仅在有卡收尾时运行，
   该分支实际不可达，不做处理。

## 交付物

| 文件 | 动作 |
| --- | --- |
| `src/features/chat/plugins/blocks/components/AnkiCriticSummaryBanner.tsx` | 头注释修正（唯一代码改动，无行为变化） |
| `docs/dev/wave2-E-r6-05-critic-ui.md` | 本复核文档 |

`ankiCardsBlockState.ts`、`TauriAdapter.ts`（handleAnkiGenerationEvent 段）
复核通过，无需改动；`streaming_anki_service.rs` 只读核对，未动。
