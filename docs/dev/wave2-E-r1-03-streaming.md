# Wave2-E 第 1 轮锚定 — streaming_anki_service.rs 事件链现状

- 会话：0824 Wave2-E 第 1 轮「锚定员-streaming」
- 审阅对象：`src-tauri/src/streaming_anki_service.rs`（5134 行，全量读毕）
- 性质：只读静态审阅，未编译未测试，未改任何产品代码
- 行号以本次审阅时的工作区实际为准（用户给定行号已校正，见各节标注）

---

## 1. 事件序列：流式 token → persist → critic → summary → 终态

入口 `process_task_and_generate_cards_stream`（:461-725），所有前端事件统一走
`window.emit("anki_generation_event", payload)`，载荷为 serde 外部标签格式。

```
process_task_and_generate_cards_stream (:461)
│
├─ update_task_status(Processing)                 :472   → 事件 TaskStatusUpdate
├─ get_configurations (Sidekick 路由, Generator 槽) :483 / :736
├─ 解析 AnkiGenerationOptions + StructuredOutputOptions(qa_pass) :502/:522
├─ resolve_output_protocol（json_schema/json_object/delimiter）:530
├─ max_cards_per_mistake<=0 且有全局限额 → 直接 Completed 短路 :544
├─ build_prompt (:558 → :806-1038；strip_occlusion_draft_markers :1020)
├─ update_task_status(Streaming)                  :584   → 事件 TaskStatusUpdate
├─ 注册 CANCEL_SENDERS + ready_signal 回执        :594-605
│
├─ stream_cards_from_ai (:606 → :1043-1591)
│   ├─ 注入 response_format（结构化协议）:1082
│   ├─ HTTP POST（Codex 分支 :1155 / reqwest 分支 :1163）
│   ├─ 主循环 :1218-1423  tokio::select!{cancel, timeout(180s, stream.next())}
│   │   ├─ ContentChunk → buffer 累积 :1256
│   │   ├─ 结构化协议剥 wrapper 前缀 strip_wrapper_prefix :1266
│   │   ├─ extract_card_from_buffer（brace-depth 切卡器 :1615-1731）循环切卡 :1271
│   │   │   ├─ 达 max_cards_per_mistake 上限 → reached_card_limit 停切 :1274
│   │   │   ├─ Ok(card_json) → parse_and_save_card (:1286 → :1805-2105)
│   │   │   │   ├─ Ok(Some(card)) → stats.card_count++；消费 pending_occlusion_fields
│   │   │   │   │                    (:1297-1304)；→ 事件 NewCard (emit_new_card :2982)
│   │   │   │   ├─ Ok(None)（DB 唯一索引去重）→ stats.duplicate_cards++ :1312
│   │   │   │   ├─ Err(UNREADABLE_FRAGMENT) → stats.dropped_fragments++；
│   │   │   │   │        → 事件 GenerationWarning (emit_generation_warning :3062) :1317-1335
│   │   │   │   └─ Err(其他) → stats.failed_cards++；create_error_card (:2916，入库)
│   │   │   │            → 事件 NewErrorCard (emit_error_card :2995) :1336-1374
│   │   │   └─ Err(truncated)（缓冲超硬上限 1MB :1600/:1734）→ failed_cards++ + 错误卡 :1377
│   │   ├─ SafetyBlocked → 错误卡 + break :1393
│   │   └─ Done → break :1410
│   ├─ 收尾：sse_buffer.flush() 残余行 :1427
│   ├─ 收尾残留：strip_model_special_tokens → expand_wrapper_payloads (:1756-1798)
│   │   ├─ truncated 标记卡（有损修复）→ 强制错误卡 :1476-1495
│   │   ├─ 完整残留 → parse_and_save_card 同主循环四分支 :1503-1558
│   │   └─ 不像卡片的自然语言 → 丢弃 :1569
│   └─ 返回 Ok(StreamStats)
│
├─ 结构化协议被端点拒绝(400/404/422) → delimiter 回退重试一次 :626-663
│
├─ Ok(stats) 分支 :665-703
│   ├─ emit_generation_stats (:668 → :3009)      → 事件 GenerationStats
│   ├─ critic（opt-in 且 card_count>0）:676-695
│   │   ├─ collect_gold_references（同文档兄弟卡修正对）:681
│   │   ├─ run_critic_pass（永不 Err，降级=全 keep）:686
│   │   └─ emit_critic_summary (:694 → :3034)    → 事件 CriticSummary
│   └─ complete_task_successfully (:696 → :3086)
│        → 事件 TaskStatusUpdate(Completed) + TaskCompleted
├─ Err(CANCELLED_BY_USER) → 交调度层置 Paused，本层静默 :705
├─ Err(其他) → handle_task_error (:710 → :3122)
│        → 状态 Truncated（消息含"超时/截断"）或 Failed；事件 TaskProcessingError
└─ 清理 CANCEL_SENDERS :722
```

事件全景（本文件派发的全部 8 种）：
`TaskStatusUpdate`、`NewCard`、`NewErrorCard`、`GenerationStats`、`CriticSummary`、
`GenerationWarning`、`TaskCompleted`、`TaskProcessingError`。
前端 `CardAgent.ts` 的 `BackendStreamedCardPayload`（src/components/anki/cardforge/engines/CardAgent.ts:99-124）
只声明了前三个加 TaskCompleted/TaskProcessingError/DocumentProcessingStarted；
`GenerationStats`/`CriticSummary`/`GenerationWarning` 三个新增事件当前无前端消费者（安全忽略）。

## 2. token 常量表（用户给定 :45，实测 :45-51，命中）

- 本文件本地常量 `MODEL_SPECIAL_TOKENS`（:45-51）与 A 会话单源文件
  `src-tauri/src/utils/model_special_tokens.rs`（:32-38）**内容完全相同但仍是两份副本**。
  本文件未 use 该 utils 模块——A 会话的单源化未覆盖此处，无引用点可记录。
- 算法语义（归本会话）：
  - `contains_only_model_special_tokens`（:53-69）：纯 token 残片判定；
  - `strip_model_special_tokens`（:75-95）：只丢纯 token 残片、只剥完整 JSON 外侧的
    纯 token 包装，正文字面 token 保留（#268 语义）；
  - `error_content_is_repairable`（:98-102）：纯 token 错误卡不进重试。
- 调用点：:1457（收尾残留清理）、:1816（parse_and_save_card 入口丢纯 token 残片）、
  :3225（build_retry_task_for_document 过滤不可修复错误卡）。
- 注意 utils 版是带 Markdown 感知的**流式过滤器**（GLM/Qwen 路由门控），本文件是
  **整段字符串**保守清理，语义不同，合并时不能直接替换算法，只能共享常量表。

## 3. 遮挡入库断链（用户给定 :1929-2002，实测 :2006-2019，已校正）

生产链条与断点：

| 环节 | 函数 / 行号 | 现状 |
|---|---|---|
| 草稿提取 | `extract_occlusion_draft_fields`（anki_image_occlusion.rs:708-717）在 `stream_cards_from_ai` :1215 调用 | 每分段最多产出一个 `OcclusionCardFields` |
| 字段构造 | `build_card_fields(&validated, None, None)`（anki_image_occlusion.rs:716 → :429-472） | `image_file_name` 恒传 `None` → 返回的 `text` 只有 cloze 串 `{{c1::…}}`，**无 `<img>` 标签**；`extra_fields` 只含 `_occlusion`(spec JSON)（`Extra` 因 extra_note=None 不产生）；`tags=[image-occlusion]` |
| 合并入卡 | `parse_and_save_card` 的 occlusion 分支 **:2008-2019** | 只做两件事：`fields.extra_fields` entry-or_insert 合并进 `cleaned_extra_fields`；`fields.tags` 去重追加进 `cleaned_tags` |
| **断点 1** | :2008-2019 | **`fields.text` 完全未被消费**——结构体注释（anki_image_occlusion.rs:172 "`text` → `AnkiCard.text`"）承诺的接线不存在。卡片的 `text` 仍取模型输出（:2076 `cleaned_extra_fields.get("text")`），遮挡 cloze 文本丢失 |
| **断点 2** | AnkiCard 构造 :2078 | `images: Vec::new()` 硬编码空——遮挡图片引用只活在 `_occlusion` spec JSON 的 `image_ref` 里，未进 `AnkiCard.images`，前端/导出无法按常规图片渲染 |
| 消费标记 | :1297-1304（主循环）、:1515-1521（收尾残留）| 首张成功卡带 `_occlusion` 后置 `pending_occlusion_fields=None`，防复制，逻辑正确 |

结论：**遮挡入库既不写 `fields.text`，也不放 `images`；只写
`extra_fields[_occlusion]` + `image-occlusion` tag**。测试
`vlm_occlusion_draft_is_merged_into_extra_fields_without_rewriting_card`（:5095-5133）
钉住的正是这个"只合并 extra_fields/tags"的现状，第 2 轮接线 text/images 时该测试需同步扩展断言而非删除。

## 4. QA 落盘门控 enable_qa_pass（用户给定约 :2047，实测 :2047-2051，命中）

- `qa_pass_enabled` 由 `StructuredOutputOptions::from_options_json(...).qa_pass_enabled()`
  产出（:618/:650 传入），默认 true（测试 :4675 钉住）。
- 校验/lint 无论开关**照常执行**（字段规则违规 :2223 一带汇总 → :2552 写
  `extra_fields[_qa_flags]`；lint :2032 + 文档级指纹 :2041 → `merge_flags` :2045），
  关闭时仅在 :2049-2051 `remove(QA_FLAGS_FIELD)` 移除留痕，且必须在 merge_flags 之后。
- `StreamStats.flagged_cards` 依赖入库卡是否带 `_qa_flags`（:1306/:1523），
  因此 qa_pass=false 时 flagged_cards 恒为 0——统计与落盘被同一开关连坐，第 2 轮若要
  "关落盘但保留统计"需在 :2049 之前先取样。

## 5. CriticSummary 事件序列化字段表（用户给定 :2949-2974，实测 :3034-3058，已校正）

`CriticSummary` 结构体（anki_critic.rs:276-304）自带 `Serialize`（routed_* 为
`skip_serializing_if = None`），但 `emit_critic_summary`（:3034-3058）**手工 json! 重建载荷**，
产生字段漂移：

| CriticSummary 字段 | 事件里有？ |
|---|---|
| examined / kept / revised / flagged | 有（:3045-3048）|
| rejected_unknown_ids | 有（:3049）|
| skipped_over_budget | 有（:3050）|
| persist_failures | 有（:3051）|
| degraded（Option\<String\>）| 有（:3052）|
| **gold_references** | **漏**（run_critic_pass 已写入 anki_critic.rs:892）|
| **gold_references_truncated** | **漏**（anki_critic.rs:893）|
| **routed_config_id** | **漏**（note_routing_decision anki_critic.rs:313）|
| **routed_model** | **漏**（anki_critic.rs:314）|
| **routed_degraded** | **漏**（anki_critic.rs:315）|

共 5 个字段只进日志（anki_critic.rs:986-1000 的 info! 有全量）不进事件。修法建议：
:3041-3054 改为 `json!({"CriticSummary": {"task_id":…, "document_id":…,
..serde_json::to_value(summary)}})` 式合并，或直接对 struct 序列化后插入两个 id 键，
消灭手抄清单；routed_* 的 skip-None 语义可由 struct Serialize 自动保持
（anki_critic.rs 测试 :1852-1867 已钉 wire 格式）。

## 6. GenerationStats 生命周期

- 产生：`StreamStats`（:116-127）在 `stream_cards_from_ai` 栈上累积
  （card_count/failed_cards/duplicate_cards/dropped_fragments/flagged_cards）。
- 上报：任务成功收尾时 `emit_generation_stats`（:668 → :3009-3030）发一次
  `GenerationStats` 事件，字段名映射 `card_count → cards_generated`，其余同名。
- **纯内存 + 一次性事件**：
  - 不落库——无任何 DB 写入；
  - 不进任务汇总——`complete_task_successfully`（:3086）只带 `card_count`
    （事件 TaskCompleted.total_cards_generated），failed/duplicate/dropped/flagged 均丢失；
  - 任务失败/取消路径**不发**该事件（:704-719 无 emit），失败任务的部分统计彻底蒸发；
  - delimiter 回退重试时只有第二次的 stats 存活（result 被覆盖 :638）；
  - 前端无消费者：cardforge 的同名 `GenerationStats`（CardAgent.ts:391）是前端本地
    从收集到的卡片重新计算的，与后端事件无关；`BackendStreamedCardPayload` 未声明该键。
- 结论：failed_cards / dropped_fragments / duplicate_cards **只在内存**，页面刷新或
  错过事件即不可追溯。

## 7. lossless-only JSON 修复与截断残卡拒收（现状正确，供回归参照）

- 生产逻辑：`parse_and_save_card` :1830-1866——serde 失败后走
  `anki_protocol::repair_json_detailed`；`repair.truncated_string == true`（字符串中途
  截断，有损）→ 直接 Err 拒收（:1833-1841）；无损修复（尾逗号/缺闭合括号）→ 入库。
  收尾 wrapper 同语义：`expand_wrapper_payloads` :1756-1798 给最后一张卡打
  `truncated` 标记，调用方 :1476-1495 强制落错误卡。
- 测试区：
  - `parse_and_save_card_rejects_mid_string_truncation_as_error`（:4734-4766）
  - `parse_and_save_card_still_repairs_lossless_damage`（:4768-4792）
  - `expand_wrapper_payloads_marks_mid_string_truncated_last_card`（:4577-4594）
  - `expand_wrapper_payloads_expands_wrapper_and_repairs_truncation`（:4545-4575）

## 8. AnkiCard 写入字段白名单（:2070-2085）

`parse_and_save_card` 构造 `AnkiCard` 时的字段来源：

| 字段 | 来源 |
|---|---|
| id / task_id / created_at / updated_at | 本地生成 |
| front / back | `extract_fields_with_rules` + `clean_template_placeholders` |
| text | `cleaned_extra_fields.get("text")`（:2076，含 Cloze 补齐 :1986-2004）|
| tags | 规则提取 + 遮挡 tag 追加（:2014-2018）|
| **images** | **硬编码 `Vec::new()`（:2078）——全路径无人写入** |
| is_error_card / error_content | false / None（错误卡走 create_error_card :2916）|
| extra_fields | 规则提取 + 遮挡 extra_fields + `_qa_flags` + `_original_generation`（:2057 anki_gold_set 快照）|
| template_id | `resolved_template_id`（多模板解析 :1871-1910）|

入库经 `db.insert_anki_card`（:2088），DB 唯一索引负责原子去重（false → Ok(None)）。

## 9. 第 2/3 轮改动插入点

第 2 轮（接线/补漏，按预期收益排序）：

1. **遮挡 text/images 接线**——`parse_and_save_card` :2008-2019 的 occlusion 分支：
   消费 `fields.text`（建议 entry-or_insert 进 `cleaned_extra_fields["text"]`，与
   "不改写模型已产出字段"的现有取舍一致，若模型已写 text 则不覆盖）；并从
   `_occlusion` spec 的 `image_ref` 解析真实图片引用填 `AnkiCard.images`（:2078）。
   如需 `<img>` 进 Text 字段，还要在 `extract_occlusion_draft_fields`
   （anki_image_occlusion.rs:716）把 `image_file_name` 从 `None` 换成解析产物。
   同步扩展测试 :5095-5133 的断言。
2. **CriticSummary 事件补字段**——`emit_critic_summary` :3041-3054 改为 struct 序列化
   合并 task_id/document_id，补齐 gold_references / gold_references_truncated /
   routed_config_id / routed_model / routed_degraded 五个字段。
3. **GenerationStats 持久化/汇总**——最小改动：`complete_task_successfully`（:3086）
   增参携带完整 stats 进 TaskCompleted（需同步 models.rs 的 StreamedCardPayload，注意
   前端兼容）；或在 :668 之后把 stats 写任务行（DB 层新列/JSON 列，涉及 database 层，
   属跨文件改动需与禁改区协调）。失败路径 :704-719 补发 stats 事件。
4. **token 常量表单源化**——:45-51 删本地表，改引
   `crate::utils::model_special_tokens` 导出的常量（需该模块把 `MODEL_SPECIAL_TOKENS`
   从私有改 pub）；:53-102 三个算法函数留在本文件（语义与流式过滤器不同）。

第 3 轮（验证/收尾）：

- 针对 1 的端到端断言：遮挡卡的 `text` 含 cloze、`images` 非空；`pending_occlusion_fields`
  消费判定（:1297-1304 用 `OCCLUSION_FIELD` 探测）在 text 接线后依然成立，无需改。
- 针对 2 的 wire 格式测试：有/无 routed 决策两形态（参照 anki_critic.rs :1852-1867）。
- 针对 3 的前端消费者（若本 wave 含前端）：`BackendStreamedCardPayload` 补
  `GenerationStats`/`CriticSummary` 键型。
- 回归红线：lossless-only 拒收测试（§7）、qa_pass 门控测试（:4672-4730）、
  brace-depth 切卡器全套（:4139-4322）不得松动。

## 10. 禁改区确认

本轮未触碰 coordinator.rs、tool_loop、缓存链、移动 chrome、workbench 壳；
未改任何产品代码；未 commit。
