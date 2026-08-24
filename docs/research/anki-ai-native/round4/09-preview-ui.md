# Round 4 #9 — 前端预览块展示 `_qa_flags`、transform 结果、mediaReport

> 状态：已交付（本文档对应实现 + 28 个前端测试）
> 范围：纯前端（chat 预览块），零 Rust 改动

## 背景与目标

Round 3 在后端落了两条结构化留痕协议，但前端预览块此前完全不消费：

1. **`_qa_flags`**（Round 3 #3，`src-tauri/src/anki_qa_lint.rs`）：确定性质检
   把违规以 JSON 数组字符串写进卡片 `extra_fields["_qa_flags"]`，条目两种形态——
   - lint 条目：`{code, field, message, severity}`（severity: `info|warn|error`）
   - 旧字段规则条目：`{field, rule, message}`（无 severity）
   backend 遇到不可解析旧值会包装为 `{code: "legacy_flags_unparsed"}` 保留原文。
2. **`mediaReport`**（Round 3 #8，`src-tauri/src/apkg_importer_service.rs`）：APKG
   媒体导入报告，camelCase 序列化
   `{declared, imported, skipped, skips: [{reason, count, filenames}], mediaDir}`；
   无媒体包时后端不序列化该字段。已知 skip reason 共 8 个
   （`media_import_disabled / manifest_unparsed / media_dir_unavailable /
   unsafe_filename / entry_missing / entry_oversized / io_error / orphan_entry`）。

本轮目标：把这两条协议在聊天预览块里"做满"——卡片可见 QA 摘要、进度/完成态
可见媒体跳过原因，同时守住三条红线：**不把 `_qa_flags` 拼进 back**、
**空/错误/cancelled 态不回归**、**无障碍不只靠颜色**。

## 实现

### 1. 类型化解析层（新增，纯函数，单测友好）

- `src/features/chat/plugins/blocks/components/ankiQaFlags.ts`
  - `parseCardQaFlags(card)`：容忍 JSON 字符串 / 原生数组 / 坏数据；
    旧条目 `rule` 归一化为 `code`、缺失 severity 归一化为 `warn`；
    不可解析字符串包装为 `legacy_flags_unparsed`（对齐后端行为）。
  - `summarizeQaFlags(cards)` → `{flaggedCardCount, totalFlagCount, maxSeverity}`。
  - `isInternalAnkiField(name)`：下划线前缀字段视为内部协议字段。
- `src/features/chat/plugins/blocks/components/ankiMediaReport.ts`
  - `parseAnkiMediaReport(raw)`：弱类型 tool_output → 结构化报告；
    全零且无 skips 返回 `null`（不渲染噪音）；坏 skip 条目丢弃不炸。
  - `MEDIA_SKIP_REASON_KEYS`：8 个已知 reason → i18n key 后缀，未知 reason
    回退展示原文（协议演进容错）。

### 2. 卡片级 QA 徽标（`AnkiQaFlagBadge.tsx`）

- 徽标 = 图标 + 文本计数 + 最高严重度文字（如 `质检 2 · 错误`），
  点击展开详情列表（严重度文本 + 字段名 + 后端 message；旧 rule 条目无
  message 时回退 `qaFlags.rules.*` i18n）。
- 无障碍：
  - 严重度用**图标形状**区分（圆形 Info / 三角 Warning / 八角 WarningOctagon），
    颜色只是叠加信号；
  - 徽标是 `<button aria-expanded aria-controls>`，`aria-label` 完整播报
    "第 N 张卡片有 M 条质检标记，最高严重度 X"；详情是语义化 `<ul>`。
- 挂载位置（`ankiCardsBlock.tsx` 的 `InlineCardItem`）三处：
  模板渲染卡下方、纯文本回退卡内容区、编辑态头部（编辑时也能复查）。
  点击徽标 `stopPropagation`，不与翻面/进入编辑冲突。
- 块级摘要 `AnkiQaFlagsSummaryChip`（`role="note"`）：
  折叠/展开态均可见，复用既有 i18n `qaFlags.flaggedCards` + `qaFlags.hint`
  （"N 张卡片带质检标记 · 建议人工复查后再导出"）。

### 3. `_qa_flags` 永不进 back / 编辑字段

`resolveEditableFields` 此前把 `extra_fields` 的所有 key 变成可编辑字段——
`_qa_flags` 会以原始 JSON 出现在编辑器里（并可能被用户改坏）。
现在 `isInternalAnkiField` 在候选字段过滤阶段剔除全部 `_` 前缀字段：
既不渲染、不可编辑，同时 `handleSave` 的 `nextExtraFields` 基于原
`extra_fields` 拷贝，标记在编辑保存后**原样保留**（不丢失留痕）。

### 4. mediaReport 展示（`AnkiMediaReportView.tsx`）

- 挂在 `ChatAnkiProgressCompact` 内（warnings 之后）：摘要行
  "媒体：导入 imported/declared，跳过 skipped" + 逐 reason 明细
  （本地化 reason × count + 前 3 个样例文件名）。
- 有跳过 → Warning 图标 + warning 边框；全部导入成功 → 中性图标样式
  （图标 + 文本双通道，不只靠颜色）。
- `ankiCardsBlock.tsx`：`shouldShowChatAnkiProgress` 增加
  `mediaReport !== null`——**只有媒体报告、没有 progress/ankiConnect 时
  也能展示**（如 Agent 直接走 `chatanki_import_apkg` 的 tool_output）。

### 5. 事件层修复（`events/ankiCards.ts`）

`onStart` 的两条幂等复用路径（重放/重连触发的重复 start）此前手工枚举
字段重建 toolOutput，会静默丢掉 `mediaReport`、`deletedCardIds` 等未列出
字段。改为 `...existingData` 展开保留全部既有字段后再套用 payload 覆盖。
`onChunk` patch 合并与 `onEnd` result 合并本就是展开语义，`mediaReport`
天然流通（新增测试锁死该契约）。

### 6. i18n

- `anki.json`（zh-CN/en-US）`qaFlags`：新增 `cardBadge / severity.* /
  showDetails / hideDetails / cardFlagsAria`，复用既有
  `label / flaggedCards / hint / fieldLabel / rules.*`。
- `chatV2.json`（zh-CN/en-US）`blocks.ankiCards.progress.media`：
  `summary / skipReasonLine / filenamesSample / reasons.*`（8 个已知原因）。

## 测试（28 个新增/修复，全部通过）

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `tests/vitest/chat-v2/plugins/blocks/ankiQaFlags.test.ts` | 10 | 解析契约：lint+旧条目、坏数据、legacy_flags_unparsed、severity 归一化、摘要统计、内部字段判定、mediaReport 契约/容错/空报告 |
| `tests/vitest/chat-v2/plugins/blocks/AnkiCardsQaMedia.test.tsx` | 12 | 徽标文本+severity+aria-label、展开/收起 aria-expanded/aria-controls、`_qa_flags` 不进 back/编辑字段、旧 rule i18n 回退、块级摘要 chip、进度/完成态媒体明细、仅 mediaReport 也渲染、干净报告无 skip 列表、未知 reason 回退、空/错误/cancelled 态回归 |
| `tests/vitest/chat-v2/plugins/events/ankiCardsMediaReport.test.ts` | 4 | patch/onEnd 的 mediaReport 合并、重放 start 不丢字段、`_qa_flags` 流式透传 |
| `AnkiCardsBlock.test.tsx`（修复既有失败） | +2 dict | 该文件的 i18n mock 不支持插值导致 `cardsValue` 断言一直红；补插值后 31/31 绿 |

回归：`tests/vitest/chat-v2/plugins/**` 除 `McpToolBlock.test.tsx` 的 3 个
**先在失败**（HEAD~1 复现，与 anki 无关，属其他任务域）外全部通过；
`tsc --noEmit` 除既有 `@/version` 生成文件缺失外无错误。

## 验证方式说明

云端环境无浏览器，未做人工浏览器验证；以 vitest（jsdom + Testing Library）
覆盖全部可测交互（徽标展开/收起、编辑态字段过滤、进度/完成/取消态渲染）。
桌面布局风险面：新增元素均为独立行内 chip / 独立行（不改既有 flex/grid
结构），列表/网格双布局的卡片渲染路径未动。

## 遗留与后续建议

- QA 面板级"按 code 过滤/批量修复"入口（Round 3 #3 文档设想）仍未做，
  当前只到"卡片可见 + 块级摘要"。
- `transform 结果`（Round 3 #1 transform script）目前经 `warnings` /
  `progress.messageKey` 通道展示，未加独立分区；若后端后续把 transform
  统计写成结构化字段，可复用本轮 parse→view 的分层直接接。
- `McpToolBlock.test.tsx` 3 个先在失败需由对应任务域跟进。
