# Wave2-E 第 3 轮 #04 — CriticSummary 前端横幅（critic-ui）

角色：0824 Wave2-E R3「CriticSummary 前端-2」。本轮只写代码与文档，未跑编译/测试/CI，未 commit。

## 交付物

| 文件 | 动作 |
| --- | --- |
| `src/features/chat/plugins/blocks/components/AnkiCriticSummaryBanner.tsx` | 新建：任务级 critic 摘要横幅 + 宽松解析器 `parseAnkiCriticSummary` |
| `src/features/chat/plugins/blocks/ankiCardsBlock.tsx` | 仅 1 行 import + 1 行挂载（未动 `AnkiCardsBlockData`、未动 QA badge 逻辑） |
| `src/locales/zh-CN/anki.json` / `src/locales/en-US/anki.json` | `agent.critic.persistFailures` 双语新增（旧词条全部保留） |
| `tests/vitest/chat-v2/plugins/blocks/AnkiCriticSummaryBanner.test.tsx` | 新建测试（按要求只写不跑） |

## 挂载点

`ankiCardsBlock.tsx` 底部操作区（`FullWidthCardWrapper.chatanki-bottom-actions`）内、
`AnkiQaFlagsSummaryChip`（质检标记块级摘要）**之前**：

```tsx
<AnkiCriticSummaryBanner criticSummary={(data as { criticSummary?: unknown } | undefined)?.criticSummary} />
```

选这里的理由：

- 与 `AnkiQaFlagsSummaryChip` / `ChatAnkiProgressCompact` 同区，折叠/展开态均可见，
  语义同为「导出前的任务级提示」；
- `AnkiCardsBlockData` 尚无 `criticSummary` 字段（后端 `emit_critic_summary` 事件也还没有
  前端消费方），按任务约定挂载处用 `(data as { criticSummary?: unknown }).criticSummary`
  宽松透传，**未改** `AnkiCardsBlockData` 接口；
- 无数据时组件内部直接返回 `null`，挂载处无需条件包裹，保持单行。

## 数据契约（宽松解析）

后端 wire 格式为 snake_case（`streaming_anki_service.rs` 的 `emit_critic_summary`：
`examined / kept / revised / flagged / rejected_unknown_ids / skipped_over_budget /
persist_failures / degraded`；`anki_critic.rs::CriticSummary` 还带 `gold_references`）。
`parseAnkiCriticSummary(raw: unknown)`：

- 兼容 snake_case 与 camelCase 两种键名；
- 非对象 / 数组 / 负数 / NaN / 非数字一律收紧为 0；空白 `degraded` 视为未降级；
- 全零且未降级 → 返回 `null`（横幅不渲染）。

## 呈现规则

- **正常态**（灰调 `role="note"`，`data-testid="chatanki-critic-summary"`）：
  `agent.critic.title` + `agent.critic.summary`（examined/kept/revised/flagged 插值），
  按需追加明细行 `agent.critic.skippedOverBudget`（>0）、`agent.critic.goldReferences`（>0）。
- **写回失败**：`persistFailures > 0` 时追加 `agent.critic.persistFailures` 行并整体转警示色。
- **降级态**：`degraded` 非空 → 警示色 + `agent.critic.degraded` 文案，
  不再展示统计句（降级时全部视同 keep，统计无意义），`data-degraded="true"`。

## 使用的 locale key（`anki` 命名空间）

已有：`agent.critic.title`、`agent.critic.summary`、`agent.critic.skippedOverBudget`、
`agent.critic.goldReferences`、`agent.critic.degraded`。

本轮新增（双语）：`agent.critic.persistFailures` —
zh「{{count}} 张卡的终审修订写回失败，展示内容可能与已保存版本不一致」/
en「{{count}} card revisions from the final review failed to write back; what you see may differ from the saved version」。

## 与 AnkiQaFlagBadge 的边界

未触碰 `AnkiQaFlagBadge.tsx`。单卡 `_qa_flags` 徽标继续负责
`agent.critic.flaggedFlag` / `agent.critic.revisedFlag` 的卡级展示；本横幅只做任务级
聚合统计，两者共用 `agent.critic.*` 词条前缀但互不依赖。

## 后续接线（不在本轮范围）

- 事件层把 `anki_generation_event` 的 `CriticSummary` 载荷 patch 进块的
  `toolOutput.criticSummary`（届时可把该字段正式收进 `AnkiCardsBlockData`，
  本横幅无需改动即可消费）；
- 若要展示 Sidekick 路由观测（`routed_config_id / routed_model / routed_degraded`），
  可补 `agent.critic.routed*` 词条并在横幅追加一行。
