# Wave2-E 第 2 轮 · 落地 06：gold 溯源（_content_provenance）

- 角色：gold 落地员（0824 Wave2-E R2）
- 模型：claude-fable-5-thinking-high
- 纪律：只写不跑（未编译/未测试/未 CI），未 commit，未切枝
- 依据：`docs/dev/wave2-E-r1-04-critic-gold.md` §5 最小加法方案、
  `docs/dev/wave2-E-r1-02-apkg-gold-qbank.md` §四清单 1/2/5
- 独占文件：`src-tauri/src/anki_gold_set.rs`、`src-tauri/src/anki_critic.rs`、
  `src-tauri/src/chat_v2/tools/chatanki_executor.rs`（仅
  `execute_update_library_card` 函数体）

## 结论先行

r1-04 认定的 **P0 污染路径 A**（`enable_qa_pass=false` 时
`sanitize_plan_for_disabled_qa_pass` 剥掉 `_qa_flags` 连带洗掉
`llm_critic_revised` marker，critic 自改被后续任务挖成"用户修正对"回灌
grounded prompt）已按方案收口：溯源从 QA 留痕中解耦为独立字段
`_content_provenance`，挖掘侧从"排除已知黑名单"改为"**只认可证明的用户编辑**"。
旧卡（无 provenance）保守 Unlabeled，宁可漏挖不可污染。

## 1. 字段契约

| 项 | 值 |
|---|---|
| 键名 | `CONTENT_PROVENANCE_FIELD = "_content_provenance"`（`anki_gold_set.rs`，与 `ORIGINAL_GENERATION_FIELD` 并列导出） |
| 值形状 | 二次编码 JSON：`{"actor":"user"\|"llm_critic"\|"import"\|"sync","code":"...","at":"<rfc3339>"}`，serde camelCase，未知字段忽略，`code`/`at` 可缺省 |
| actor 类型 | `String` + `PROVENANCE_ACTOR_USER / _LLM_CRITIC / _IMPORT / _SYNC` 常量（非 enum：未知 actor 必须可解析且 fail-closed 不算用户证明） |
| 写语义 | `insert_content_provenance` = **last-writer-wins 覆盖**（与 `_original_generation` 的首写幂等相反：记录"最后一次内容写入者"） |
| 读 helper | `parse_content_provenance`（非法 JSON/非对象/缺 actor → None）、`is_user_proven_edit`（仅 actor=user）、`is_llm_critic_actor`（仅 actor=llm_critic） |
| 与 `_qa_flags` 关系 | **完全解耦**。provenance 是事实记录不是 QA 留痕，不受 `enable_qa_pass` 门控；`has_critic_revision_marker`（marker 第一道闸）原样保留，provenance 是第二道闸，两者任一命中即排除 |

构造 helper：`ContentProvenance::user(code)`（code 空串省略）、
`ContentProvenance::llm_critic_revision()`（code 固定 `llm_critic_revised`，
复用 `CRITIC_REVISED_QA_CODE` 常量，`at` 为写入时刻 RFC3339）。

## 2. `GoldCandidate` 与 `classify_candidate` 三分支

`GoldCandidate` 新增 `#[serde(default)] pub edit_actor: Option<String>`——
旧 fixture / 离线脚本 JSON（无该字段）零迁移反序列化为 None
（有单测 `gold_candidate_old_json_without_edit_actor_deserializes` 锁定）。

决策树变化（其余通道不动）：

| 分支 | 条件 | 结果 |
|---|---|---|
| a（来源通道，第 1 步） | `critic_revised == true`（marker 派生）**或** `edit_actor == Some("llm_critic")` | `Unlabeled`，reason 含 `llm_critic_revised`。**绝不** EditedMinor/Major |
| b（编辑通道闸门） | `original != current` 但 `edit_actor != Some("user")`（None = 旧卡；import/sync/未知 actor 同判） | `Unlabeled`，reason 含"缺编辑者证明"。旧卡保守：无证明不进 gold 修正对 |
| c（编辑通道放行） | `original != current` 且 `edit_actor == Some("user")` | 维持既有编辑距离规则：ratio < 0.25 → `EditedMinor`，否则 `EditedMajor`，携带 `RepairPair` |

红线核对：`KeptUnedited`（original == current，无归因问题）、`DeletedEarly`、
`ErrorCardRepaired`、留存信号路径**均未改动**；lint 门槛
（`select_grounded_reference_pairs` / `gold_lint_config`）未放宽；
有单测 `user_actor_proof_keeps_kept_unedited_channel_untouched` 锁定
KeptUnedited 不看 actor。

## 3. anki_critic.rs 三处改动

1. **`plan_updates` Revise 分支**：在 `llm_critic_revised` 审计条目之后、
   relint 之前写入 `_content_provenance`（actor=llm_critic,
   code=llm_critic_revised）。flag 裁决不改内容，**不**盖戳（不覆盖既有溯源）。
   relint 规则核对：provenance 值为纯 JSON 元数据，不含
   `{{UPPER}}`/TODO/xxx/空括号模式，不会被 `check_placeholder`（唯一遍历全部
   extra_fields 的内容规则）误报。
2. **`sanitize_plan_for_disabled_qa_pass`：仍然只剥 `QA_FLAGS_FIELD`**。
   `_content_provenance` 天然存活（这正是与 7077075a 门控语义的切分边界：
   门控只关"留痕"不关"溯源"）。差异判定同步微调：比较副本中双侧忽略
   `_content_provenance`（如同既有的 `_qa_flags` 忽略），使"内容无实质变化"
   的更新保持既有整体丢弃行为——溯源戳自身不构成落盘理由，revise-to-identical
   的卡不会因盖戳被改判出 KeptUnedited 桶；有实质 diff 的 revise 写回则携带
   溯源戳落盘（只从比较副本移除，不动 card 本体）。
   7077075a 语义不回退：`enable_qa_pass=false` 仍不落 `_qa_flags`，既有三个
   `disabled_qa_pass_*` 测试原样保留，另加回归锁
   `disabled_qa_pass_never_strips_content_provenance`。
3. **`gold_references_from_cards`**：
   - marker 过滤（`has_critic_revision_marker`，保留兜底历史数据）之后新增
     provenance 过滤：`actor` 存在且 ≠ `user` → 剔除；无 provenance 放行到
     `classify_candidate` 的分支 b 保守兜底；
   - 原 `critic_revised: false` 硬编码改为
     `has_critic_revision_marker(..) || is_llm_critic_actor(..)` 真值计算，
     并填充 `edit_actor`——即便未来 filter 顺序被改动，`classify_candidate`
     第 1 通道仍是独立的第二道防线（r1-02 §四清单第 5 条）。

## 4. chatanki_update_library_card（最小改动）

`execute_update_library_card` 在 patch 应用、内容校验通过之后、CAS 写库之前，
后端统一覆盖写入 `_content_provenance`（actor=`user`,
code=`chatanki_update_library_card`）——不信任调用方 payload 自带的
provenance，戳与内容同一次 `update_anki_card_if_version_for_library` 落盘；
CAS 冲突 / NotFound 路径不产生任何写入，自然无戳。该文件其余逻辑零改动。

## 5. 新增/调整测试清单（只写不跑）

`anki_gold_set.rs`（`#[cfg(test)]`）：

- 新增：`llm_critic_actor_is_excluded_even_without_qa_flags_marker`（路径 A
  标注层复现）、`edited_content_without_actor_proof_is_unlabeled`（旧卡保守，
  reason 含"缺编辑者证明"）、`non_user_actors_never_enter_edited_buckets`
  （import/sync/未知 actor）、`user_actor_proof_keeps_kept_unedited_channel_untouched`、
  `gold_candidate_old_json_without_edit_actor_deserializes`、
  `content_provenance_round_trips_via_extras`、
  `content_provenance_is_last_writer_wins`、
  `content_provenance_uses_camel_case_and_ignores_unknown_fields`、
  `content_provenance_malformed_values_are_fail_closed`、
  `provenance_detection_does_not_depend_on_qa_flags`。
- 调整（编辑通道现要求 user 证明）：`minor_edit_yields_repair_pair_with_ratio`、
  `major_rewrite_yields_edited_major`、`mine_gold_set_buckets_and_stats` 补
  `edit_actor = Some("user")`。

`anki_critic.rs`（`#[cfg(test)]`）：

- 新增：`plan_revise_stamps_llm_critic_provenance`、
  `plan_flag_does_not_stamp_provenance`、
  `disabled_qa_pass_never_strips_content_provenance`（sanitize 只剥 qa_flags
  回归锁）、`critic_revision_with_disabled_qa_pass_never_reenters_gold_references`
  （路径 A 端到端：plan → sanitize → 落库形态 → 收集器 0 对）、
  `gold_references_exclude_provenance_critic_cards_without_marker`（marker 被
  前端重建冲掉的洗白变体）、`gold_references_exclude_legacy_edits_without_provenance`、
  `gold_references_exclude_import_and_sync_actors`。
- 调整（挖掘正例需 user 证明）：`gold_references_from_cards_mines_sibling_edits`、
  `gold_references_exclude_current_task_and_error_cards`、
  `gold_references_reject_dirty_gold_side`、`gold_references_capped_by_config`
  经新 helper `stamp_user_provenance` 补戳。
- 既有关键测试零改动仍应绿：`gold_references_exclude_critic_revised_cards`、
  `critic_revised_content_is_never_mined_as_user_gold`、
  `disabled_qa_pass_drops_flag_only_updates`、
  `disabled_qa_pass_keeps_revision_content_without_qa_flags`、
  `disabled_qa_pass_ignores_legacy_flags_when_diffing`。

## 6. 与先行测试文件的符号对齐

第 2 轮 gold 测试员先行编写的
`src-tauri/tests/gold_provenance_excludes_critic.rs`（红绿矩阵）所依赖的落地
语义已全部就位：键名 `_content_provenance`、actor wire 小写四值、
`edit_actor` 经 serde 注入（`Option<String>` 直接吃 `"user"` 等 JSON 字符串）、
收集器 provenance 过滤、标注层编辑者闸门。其表格中"落地前红"的 5 个测试
（whitewashed / legacy / import / provenance-only / classify 闸门）按本实现
预期转绿；第 8 轮可把该文件的本地常量替换为
`anki_gold_set::{CONTENT_PROVENANCE_FIELD, PROVENANCE_ACTOR_*}` 产品符号。

## 7. 红线自查

- 未改 `streaming_anki_service.rs` / `apkg_*` / `anki_connect` /
  `anki_image_occlusion` / coordinator / 前端；
- `chatanki_executor.rs` 只动 `execute_update_library_card` 函数体；
- gold 其它桶（KeptUnedited / DeletedEarly / ErrorCardRepaired / 留存信号）
  语义未变；lint 门槛（lossless）未放宽；未新增任何闪卡写回流；
- `enable_qa_pass=false` 仍不落 `_qa_flags`（7077075a 不回退）。

## 8. 遗留（本轮刻意不做，与 r1-04 §5.3/§5.4 一致）

- 用户 UI 编辑命令（`cmd::update_anki_card` / `enhanced_anki_service`）与
  anki_connect 保存路径的 user 戳：非本轮独占文件，留给对应角色（无戳编辑
  在新闸门下保守 Unlabeled，方向安全，只损失挖掘量）；
- APKG 导入/导出对 `_` 前缀机器字段的剥离（r1-02 清单 3/4）：归 APKG 角色；
- critic 修订后用户再编辑的回收（需 append-only 修订历史）：超出 P0-2 范围。
