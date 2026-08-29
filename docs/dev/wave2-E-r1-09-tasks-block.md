# Wave2-E 第 1 轮锚定 — 任务台与聊天块（09）

> 静态审阅记录（未编译/未跑测试）。范围：`src/features/anki-tasks/`、
> `src/features/chat/plugins/blocks/ankiCardsBlock.tsx` 及其 components、
> `TauriAdapter.handleAnkiGenerationEvent`（只读）、locale、只读边界不变量。
> 缓存段（TauriAdapter reconcile/缓存）归 A 组，本文不提任何缓存改动建议。

---

## 1. classify 互斥分类与混合态状态机

### 1.1 现状代码

```40:44:src/features/anki-tasks/types.ts
export function classify(s: DocumentSession): SessionGroup {
  if (s.failedTasks > 0) return 'attention';
  if (s.activeTasks > 0 || s.pausedTasks > 0) return 'active';
  return 'completed';
}
```

`failedTasks > 0` 无条件短路，`activeTasks` / `pausedTasks` 根本不参与判断。
一个会话同时有失败分段和仍在跑的分段（failed+running 混合态）会被互斥地归入
`attention`，「仍在运行」这一事实在分组层完全丢失。

### 1.2 混合态状态机表

| failedTasks | activeTasks | pausedTasks | classify 结果 | 真实语义 | 偏差 |
|---|---|---|---|---|---|
| 0 | 0 | 0 | completed | 已完成 | 无 |
| 0 | >0 | 任意 | active | 运行中 | 无 |
| 0 | 0 | >0 | active（StatusTag 显示"已暂停"） | 暂停 | 无 |
| >0 | 0 | 0 | attention | 有失败、已停 | 无 |
| **>0** | **>0** | 任意 | **attention** | **失败+仍在运行（混合态）** | **分错：运行事实丢失** |
| >0 | 0 | >0 | attention | 失败+暂停（混合态） | 部分丢失（暂停事实不可见） |

### 1.3 混合态（failed>0 且 active>0）的连锁后果

全部由 `classify` 的互斥结果传导，静态可证：

1. **轮询降频**：`AnkiTasksApp.load()` 第 225 行
   `nextHasActive = s.some(session => classify(session) === 'active')` ——
   混合态会话不算 active，若全部运行中会话都带失败分段，轮询从 5s 掉到 30s
   （`POLL_ACTIVE`/`POLL_IDLE`，types.ts:32-34），运行中的任务台刷新变慢 6 倍。
2. **防休眠被提前解除**：第 325-335 行 effect 依据 `groups.active.length`，
   混合态不在 active 组 → `hadActive && !hasActive` 成立 → 自动调
   `set_prevent_sleep(false)`，任务仍在跑时系统可休眠。
3. **筛选 tab 错位**：`filter='active'` tab 看不到仍在运行的混合态会话；
   它出现在「失败」tab 里且无任何运行中标识（StatusTag 只渲染 attention 样式，
   脉冲点 `wb-at-pulse-dot` 仅 `group === 'active'` 时渲染，bits.tsx:42）。
4. **进度条无运行光带**：`SessionRow` 第 253 行
   `isRunning = group === 'active' && session.activeTasks > 0` —— 混合态
   `group='attention'` → `isRunning=false`，`InlineProgress` 不显示流动光带，
   行也没有 `wb-at-row-running` 高亮。
5. **环形图口径**：混合态计入「失败」扇区（AnkiTasksApp.tsx:365-372），
   运行中扇区少计。
6. 「运行中会话置顶」（AnkiTasksApp.tsx:414-419）用的是 `s.activeTasks > 0`
   而非 classify，混合态仍会置顶 —— 这是目前唯一没被互斥分类污染的路径，
   但仅在 `filter='all'` 时生效。

### 1.4 行内操作入口是否被藏住（是）

`SessionRow` 桌面行内操作簇（304-373 行）：

| 按钮 | 显示条件 | 混合态（failed>0, active>0）下 |
|---|---|---|
| 暂停 | `group === 'active' && session.activeTasks > 0`（:313） | **藏住** —— 任务在跑却无法从行内暂停 |
| 恢复 | `session.pausedTasks > 0`（:320） | 有暂停分段时可见（未绑 group，OK） |
| 取消 | `group === 'active'`（:327） | **藏住** —— 无法从行内取消仍在跑的任务 |
| 重试失败 | `session.failedTasks > 0`（:336） | 可见（注释说明此前 `pausedTasks === 0` 附加条件已删，Step 22 前置修复） |
| 导出 / 跳聊天 / 删除 | 与 group 无关 | 可见 |

展开区（403-445 行）的暂停/取消同样绑 `group === 'active'`
（且仅 `isSmallScreen`，:415/:425），**混合态在任何入口都无法暂停/取消**。
用户所述「混合态开放项」成立；行内操作入口确实会被藏住。

---

## 2. list 与 stats：Promise.all 绑死（是）

### 2.1 调用图

```
AnkiTasksApp.load()  (AnkiTasksApp.tsx:215-241)
  ├─ Promise.all([                        ← 一荣俱荣、一损俱损
  │    invoke('list_document_sessions', { limit: 500 }),
  │    invoke('get_anki_stats'),
  │  ])
  ├─ 成功：setSessions(s) + setStats(st) + setLoadError(null)
  └─ 任一失败：catch → setLoadError(msg)；sessions/stats 都不更新（保持 stale）

触发源（全部走同一个 load）：
  首次挂载 / 5s|30s 轮询 / visibilitychange / 手动刷新按钮 / recover 后刷新

SessionRow 展开区独立链路（不受影响）：
  get_document_cards + get_all_custom_templates   (SessionRow.tsx:69-75)
  （templates 已单独 .catch 回退 []，是局部容错的先例）
```

### 2.2 stats-only failure 现状

`Promise.all` 快速失败：`get_anki_stats` 单独挂掉时，**已成功返回的
`list_document_sessions` 结果被一并丢弃**，整页进入 loadError 分支
（stale banner :667-682 或整页错误态 :767-781）。列表数据明明可得却显示
「数据可能已过时」。反向同理（list 挂、stats 活）。
generation 守卫（:216-223, :236）只防旧响应覆盖，不改变绑死语义。
GenerationStats 后端事件（见 §3.4）与此处 `get_anki_stats` 是两条完全独立的
链路，互不解耦。此项与用户所述开放项一致，仍开放。

---

## 3. 聊天块数据模型缺口（CriticSummary）

### 3.1 后端已发、前端未收

后端 `streaming_anki_service.rs`：

- `emit_critic_summary`（:3034-3058）：critic opt-in 且任务成功收尾时向
  `anki_generation_event` 派发外部标签 **`CriticSummary`**，payload 字段：
  `task_id, document_id, examined, kept, revised, flagged,
  rejected_unknown_ids, skipped_over_budget, persist_failures, degraded`。
- 注意：Rust 结构体 `CriticSummary`（anki_critic.rs:276-304）还有
  `gold_references / gold_references_truncated / routed_config_id /
  routed_model / routed_degraded`，但 **emit payload 没带**。也就是说 locale
  里 `agent.critic.goldReferences` 即便前端接了事件也无数据可填。

前端三处均为空：

1. **`AnkiCardsBlockData`**（ankiCardsBlock.tsx:125-188）没有任何
   criticSummary 字段。缺口清单（若第 3 轮接入，对应 wire 字段）：
   `examined / kept / revised / flagged / rejectedUnknownIds /
   skippedOverBudget / persistFailures / degraded`（+ task_id 归属标识；
   gold/routed 字段需后端先补 emit，本轮禁改后端，仅记录）。
2. **TauriAdapter 不消费**：`handleAnkiGenerationEvent`（:1441-1858）显式分支
   只有 `NewCard / NewErrorCard / TaskStatusUpdate / DocumentProcessingStarted /
   TaskCompleted / DocumentProcessingCompleted / TaskProcessingError /
   DocumentProcessingCancelled / TaskFailed / DocumentProcessingFailed /
   WorkflowFailed`。`CriticSummary`（以及 `GenerationStats` /
   `GenerationWarning`）会通过归一化（首 key 当 type，:1450-1455）和
   documentId 路由找到目标块、打一条 route debug 日志，然后**无分支命中、
   静默落空**，不写任何 toolOutput。
3. **grep `criticSummary|CriticSummary` 全仓（src/）零命中**，唯一命中在
   `src-tauri/`。

**结论：CriticSummary 事件在前端完全没接。** 需要澄清的是：critic 的
**卡级**结果（`llm_critic` / `llm_critic_revised`）经另一条通道到达 UI ——
后端把标记写进卡片 `extra_fields._qa_flags`，前端 `parseCardQaFlags` →
`AnkiQaFlagBadge` 展示（消费 `agent.critic.flaggedFlag/revisedFlag` 词条）。
但这不等于 summary 接入：**任务级聚合数（examined/kept/revised/flagged/
degraded）在 UI 无任何呈现**。

### 3.2 QA badge 既有语义（第 3 轮 UI 不得破坏）

- `AnkiQaFlagBadge`：单卡徽标 = button，`aria-expanded` / `aria-controls`
  （useId 防同屏重复），严重度用**形状 + 文本**双通道（Info 圆 / Warning 三角 /
  WarningOctagon 八角），点击 `stopPropagation`（卡片本体点击是翻面/编辑）；
  `data-testid="chatanki-qa-flag-badge"` + `data-severity`。
- `AnkiQaFlagsSummaryChip`：块级摘要条 `role="note"`，
  `data-testid="chatanki-qa-flags-summary"`，仅 `flaggedCardCount > 0` 渲染。
- 硬边界（AnkiQaFlagBadge.tsx 头注释 + ankiQaFlags.ts 头注释）：
  `_qa_flags` **只读结构化展示，绝不拼进 front/back 文本，不作为可编辑字段
  暴露**；`isInternalAnkiField` 负责在编辑器里隐藏内部字段。
- 渲染位置：编辑头部（:787）、模板渲染卡下方（:966）、纯文本卡（:1031）、
  块级 chip（:3096-3101，折叠/展开态均可见）。
- 第 3 轮加 CriticSummary UI 时不能：改动 badge 的 testid/aria 契约、
  把 summary 塞进 `_qa_flags` 通道、抢占 chip 的 `role="note"` 语义。

### 3.3 occlusion 预览 alt=""（:519-558）

`AnkiOcclusionCardPreview` 的 `<img alt="">`（:540）+ 占位 div
`aria-hidden`（:548）。locale 已备 `agent.occlusion.imageAlt`
（"图像遮挡卡片"）却未使用。alt="" 语义是"装饰图"，但遮挡卡图片是内容主体，
读屏用户丢失信息 —— 第 3 轮可用现成词条补齐，属纯增量。
另外 `ImageOcclusionOverlay.tsx:123` 硬编码中文
`aria-label={\`揭开遮挡区域 ${box.clozeIndex}\`}`，而
`agent.occlusion.revealBox`（"揭开遮挡区域 {{index}}"）就是为它备的，未接。

### 3.4 GenerationStats / GenerationWarning（同类缺口，记录）

后端 `emit_generation_stats`（:3009 起，payload 含 cards_generated /
failed_cards 等）与 `emit_generation_warning`（:3062-3083，丢弃残片留痕）
同样经 `anki_generation_event` 派发，前端同样零消费（grep 仅命中 cardforge
本地同名 interface `GenerationStats`，与事件无关）。与用户所述开放项一致。

---

## 4. locale 孤儿词条清单

均在 `src/locales/{zh-CN,en-US}/anki.json`（中英对称，round5 总结自述
"供接线后即取即用"——即有意预置）：

| 词条 | 状态 |
|---|---|
| `agent.critic.flaggedFlag` / `revisedFlag` | ✅ 已消费（AnkiQaFlagBadge.tsx:40-43） |
| `agent.critic.title` / `summary` / `skippedOverBudget` / `goldReferences` / `degraded` | ❌ 孤儿（grep 零命中；`goldReferences` 连 wire 数据都没有，见 §3.1） |
| `agent.occlusion.*` 全家（title / previewBadge / draftHint / imageAlt / imageUnavailable / invalidSpec / revealBox / revealedBox / revealAll / hideAll / issue.*） | ❌ 全部孤儿；`revealBox` 对应处硬编码中文（ImageOcclusionOverlay.tsx:123），`imageAlt` 对应处 alt=""（ankiCardsBlock.tsx:540） |
| `chatV2.json` `…ankiCards….occlusion.{badge,draftHint,imageAlt,imageUnavailable}`（zh:764-769） | ❌ 孤儿（与 anki.json 的 agent.occlusion 语义重复，两套都没人用） |
| 「带警告完成」 | 全仓无此字面词条。`completed_with_warnings` 仅作为状态值出现（AnkiCardsBlockData 类型 :172、TauriAdapter :1364、事件测试）；块 UI 未读取 `workflowStatus` 渲染专属文案（grep `workflowStatus` 在 ankiCardsBlock 仅类型声明一处命中）。第 3 轮若做状态呈现需**新增**词条，非复用 |

---

## 5. 只读边界 grep 证据（不变量 6/7）

- `save_to_library`：仅命中 locale 按钮文案（common.json，属错题本 UI）与
  调试插件场景名 `ca_save_to_library`（chatAnkiIntegrationTestPlugin.ts，
  测的是 anki_cards 管线的"保存到库"，非 flashcard-preview）。
  **flashcard-preview 无任何 save/persist 路径。**
- `ChatV2AnkiAdapter`：`src/` 下无该文件（Glob 零命中）。6 处文本命中全部是
  注释（"已退役/不经过"）与**守护测试**：
  `cardGenerationSurfaces.source.test.ts` 断言划词/共享文本入口源码
  `not.toMatch(/import[^;]*ChatV2AnkiAdapter/)`；
  `pdfSelectionToolbar.source.test.ts` 同类。阻塞式旧链路无复活迹象。
- `flashcard-preview`：
  - `FlashcardPreviewBlock.tsx`：纯展示组件（Card + Badge），零 action、
    零 invoke、零回写；
  - `buildFlashcardPreviewIntent.ts` 头注释明示"持久化统一由 anki_cards
    管线负责"；intent 只含展示 props；
  - `skills/builtin-tools/generative-ui.ts` 第 8 条硬约束：
    "flashcard-preview 仅用于展示；禁止添加保存 action。制卡、QA/critic
    与入库统一交给 anki_cards 管线。"

**结论：闪卡只读边界完好，无写回流。**

## 6. 双入口现状（不变量 8）

`cardAgent.startGeneration` 两个生产入口均在：

1. 划词制卡：`src/features/chat/services/selectionCardGeneration.ts:121`；
2. 共享文本入口（笔记/错题本/作文批改）：
   `src/features/anki/generateCardsFromText.ts:50`。

两者都直启后端 `start_enhanced_document_processing`，且各有单测 +
`cardGenerationSurfaces.source.test.ts` 源码级回归钉死。不变量 8 完好。

---

## 7. 第 3 轮插入点（只标位置，不动缓存段、不动产品代码）

1. **CriticSummary 数据接入**（TauriAdapter）：`handleAnkiGenerationEvent`
   在 `DocumentProcessingCancelled` 分支之前加 `type === 'CriticSummary'`
   分支，写 `toolOutput.criticSummary`（沿用 documentId 精确路由 +
   `ensureDocumentId` 既有模式，:1559-1561）。**不触碰**
   `scheduleAnkiRetryReconcile` / 缓存段（归 A）。
2. **块数据模型**：`AnkiCardsBlockData` 增 `criticSummary?: {...}`（§3.1
   字段清单），弱类型透传 + 渲染前收紧的先例是 `mediaReport` +
   `parseAnkiMediaReport`（:187, :2084），照抄该模式。
3. **块 UI**：`AnkiQaFlagsSummaryChip` 渲染点旁（:3096-3101）加
   critic 摘要条，消费孤儿词条 `agent.critic.summary` /
   `skippedOverBudget` / `degraded`；不复用 chip 的 testid，不动 badge。
4. **occlusion a11y**：`ankiCardsBlock.tsx:540` alt 接
   `agent.occlusion.imageAlt`；`ImageOcclusionOverlay.tsx:123` 接
   `agent.occlusion.revealBox`（该组件在禁改区外，但属通用组件，改动需
   核对 flashcards 复习面共用方）。
5. **任务台混合态**：若第 3 轮修 classify，最小面是把「运行中」判定与
   「需要关注」判定解耦（分组归属与操作按钮各自直接读
   `activeTasks`/`failedTasks`，不共用互斥 classify 结果）；受影响读点：
   AnkiTasksApp `load()`:225、防休眠 effect:325、donut:365、
   tab 过滤:390、SessionRow:253/:313/:327。**本轮不改。**
6. **list/stats 解耦**：`load()` 内改 `Promise.allSettled` 或对
   `get_anki_stats` 单独 `.catch`（先例：SessionRow.tsx:71 对模板加载的
   局部容错）。stats 失败时列表照常刷新、仅统计区降级。**本轮不改。**

---

## 8. 结论速览

| 问题 | 答案 |
|---|---|
| 混合态是否互斥分类错误 | **是**（failed>0 短路吞掉 running；暂停/取消行内入口被藏；轮询降频 + 防休眠误解除） |
| CriticSummary 前端是否完全没接 | **是**（事件无分支、块无字段、summary 词条无消费者；卡级 `_qa_flags` 徽标是另一条已接通道，不构成 summary 接入） |
| list/stats 是否 Promise.all 绑死 | 是，stats-only failure 会拖垮整页刷新 |
| 只读边界（不变量 6/7） | 完好，无写回流 |
| startGeneration 双入口（不变量 8） | 完好，有源码级守护测试 |
