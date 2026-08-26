# Wave2-E 第 6 轮 · 复核 04：gold 溯源复核 + UI 编辑 user 戳补丁

- 角色：gold 复核员（0824 Wave2-E R6）
- 模型：claude-fable-5-thinking-high
- 纪律：只写不跑（未编译/未测试/未 CI），未 commit，未切枝
- 依据：`docs/dev/wave2-E-r2-06-gold.md`（落地）、其 §8 遗留清单第 1 条（本轮补丁对象）
- 独占文件：`src-tauri/src/anki_gold_set.rs`、`src-tauri/src/anki_critic.rs`、
  `src-tauri/src/cmd/enhanced_anki.rs`（仅 `update_anki_card` 处理函数）、
  `src-tauri/src/enhanced_anki_service.rs`（仅 `update_anki_card`）
- 红线：不改 `database/mod.rs`，不改 `chatanki_executor` 其它逻辑

## 结论先行

**复核项全部通过，零缺陷**：`classify_candidate` 的 provenance 三分支
（llm_critic 排除 / 非 user 保守 Unlabeled / user 放行修正对）与 r2-06 文档
逐条一致；`sanitize_plan_for_disabled_qa_pass` 确认只剥 `QA_FLAGS_FIELD`，
`_content_provenance` 存活且有回归锁。

**补丁（本轮唯一改动）**：UI 编辑命令 `update_anki_card` 此前不打溯源戳
（r2-06 §8 遗留），UI 编辑在新闸门下一律被挖成"缺编辑者证明"的 Unlabeled，
只损失挖掘量但方向安全。本轮在 `EnhancedAnkiService::update_anki_card`
成功写库前统一盖 `_content_provenance` actor=user 戳，与
`chatanki_update_library_card` 对称。**改后 UI 编辑打 user 戳。**

## 1. 复核：provenance 三分支（`anki_gold_set.rs::classify_candidate`）

| 分支 | 代码位置 | 核对结果 |
|---|---|---|
| a. 来源排除 | 第 1 通道：`c.critic_revised \|\| c.edit_actor == Some("llm_critic")` → `Unlabeled` | ✅ marker（`_qa_flags` 派生）与 provenance actor 双闸任一命中即排除，reason 含 `llm_critic_revised`；测试 `critic_revised_content_is_never_mined_as_user_gold`、`llm_critic_actor_is_excluded_even_without_qa_flags_marker` 锁定 |
| b. 编辑闸门 | 编辑通道：`original != current` 且 `edit_actor != Some("user")` → `Unlabeled`（reason 含"缺编辑者证明"） | ✅ None（旧卡）/ import / sync / 未知 actor 一律 fail-closed；测试 `edited_content_without_actor_proof_is_unlabeled`、`non_user_actors_never_enter_edited_buckets` 锁定 |
| c. 编辑放行 | `edit_actor == Some("user")` → 按距离比分 `EditedMinor` / `EditedMajor`，携带 `RepairPair` | ✅ 阈值语义未变（0.25）；测试 `minor_edit_yields_repair_pair_with_ratio`、`major_rewrite_yields_edited_major` 均已带 user 戳 |

外围核对：

- `KeptUnedited`（original == current）不看 actor，无归因问题——
  `user_actor_proof_keeps_kept_unedited_channel_untouched` 回归锁在位；
- 读 helper `parse_content_provenance` / `is_user_proven_edit` /
  `is_llm_critic_actor` 全部 fail-closed（非法 JSON / 非对象 / 缺 actor →
  None / false），`content_provenance_malformed_values_are_fail_closed` 锁定；
- `insert_content_provenance` last-writer-wins（与 `_original_generation`
  首写幂等相反），wire 契约 camelCase + 未知字段忽略，均有测试；
- `GoldCandidate.edit_actor` 为 `#[serde(default)] Option<String>`，旧 JSON
  零迁移（`gold_candidate_old_json_without_edit_actor_deserializes`）。

## 2. 复核：sanitize 只剥 qa_flags（`anki_critic.rs`）

`sanitize_plan_for_disabled_qa_pass`：

- 对 card 本体唯一的 `remove` 是
  `card.extra_fields.remove(anki_qa_lint::QA_FLAGS_FIELD)`——
  `_content_provenance` **不在剥离范围**（7077075a 切分边界：门控只关
  "留痕"不关"溯源"）；
- `CONTENT_PROVENANCE_FIELD` 仅从**比较副本**（`card_extra` / `orig_extra`
  的 clone）中移除，用于"溯源戳自身不构成落盘理由"的差异判定；有实质
  内容差异的 revise 写回携带溯源戳落盘；
- 回归锁 `disabled_qa_pass_never_strips_content_provenance` 在位：
  sanitize 后 `_qa_flags` 必须消失、provenance 必须存活且 actor=llm_critic。

结论：与 r2-06 §3.2 描述一致，无漂移。

## 3. 补丁：UI `update_anki_card` 盖 user 戳

### 3.1 缺口

改前生产代码仅两处写 provenance：critic revise（actor=llm_critic）与
`chatanki_update_library_card`（actor=user）。UI 编辑走
`cmd::update_anki_card` → `EnhancedAnkiService::update_anki_card` →
`Database::update_anki_card_rows`，全程无戳——用户在卡片浏览器里的真实
修正被分支 b 保守挡在金标之外（方向安全但白白损失最主要的修正对来源）。

### 3.2 改动（`enhanced_anki_service.rs::update_anki_card`，唯一改动点）

```rust
pub fn update_anki_card(&self, mut card: AnkiCard) -> Result<(), AppError> {
    crate::anki_gold_set::insert_content_provenance(
        &mut card.extra_fields,
        &crate::anki_gold_set::ContentProvenance::user("update_anki_card"),
    );
    match self.db.update_anki_card_rows(&card) { /* 原有分支不变 */ }
}
```

设计核对（与 `chatanki_update_library_card` 逐点对称）：

- **后端统一覆盖**：不信任前端 payload 可能自带的 `_content_provenance`
  （防伪造 / 防陈旧戳残留），last-writer-wins；
- **戳与内容同一条 UPDATE 落盘**：`update_anki_card_rows` 的
  `extra_fields_json = ?9` 与 front/back 同语句写入；NotFound（0 行命中，
  含软删卡 / 软删父任务）与 DB 错误路径不产生任何写入，自然无戳；
- **盖在 service 层而非 cmd 层**：service `update_anki_card` 的生产调用方
  仅 `cmd::update_anki_card` 一处（其余命中皆为测试），盖在写库前最后一站
  可覆盖未来复用该 service 方法的写入方；cmd 处理函数零改动
  （校验逻辑 `validate_anki_card_update` 在盖戳之前已由 cmd 层执行）；
- **code 取命令名 `update_anki_card`**：与 `chatanki_update_library_card`
  的 code 取工具名同构，审计时可区分写入路径。

### 3.3 对挖掘语义的影响

- UI 编辑后的卡片：`edit_actor = Some("user")` → 分支 c 放行，
  按距离比进 `EditedMinor` / `EditedMajor` 修正对；
- critic 修订后用户再经 UI 编辑：戳变回 user（last-writer-wins 刻意如此，
  r2-06 §1 已论证），该卡若仍带 `_qa_flags` marker 则被第一道闸排除；
  marker 被剥的场景归 append-only 修订历史遗留项（见 §5）；
- `KeptUnedited` 桶不受影响：UI 保存未改内容的卡时 original == current，
  分支不看 actor（且该路径 updated_at 变化本就不影响 original 在场的判定）。

## 4. 红线自查

- `database/mod.rs` 零改动（仅只读核对 UPDATE 语句持久化 `extra_fields_json`）；
- `chatanki_executor.rs` 零改动；`anki_gold_set.rs` / `anki_critic.rs`
  本轮复核后确认无需改动，零 diff；
- `cmd/enhanced_anki.rs` 零改动（盖戳收敛在 service 层单点）；
- gold 各桶语义、lint 门槛、sanitize 语义均未触碰。

## 5. 遗留（延续 r2-06 §8，本轮不做）

- anki_connect 保存路径（`update_anki_card_rows_for_document`）的 user 戳：
  非本轮独占文件；
- APKG 导入对 `_` 前缀机器字段的剥离：归 APKG 角色；
- critic 修订后用户再编辑的精确回收（append-only 修订历史）：超出范围。

## 6. 问答

**UI 编辑是否打 user 戳？** 改前**不打**（r2-06 遗留缺口，UI 编辑全部
保守 Unlabeled）；本轮改后**打**——`EnhancedAnkiService::update_anki_card`
写库前统一盖 `_content_provenance` `{actor:"user", code:"update_anki_card",
at:<rfc3339>}`，与 `chatanki_update_library_card` 对称，UI 编辑自此可作为
可证明的用户修正对进入 gold 挖掘。
