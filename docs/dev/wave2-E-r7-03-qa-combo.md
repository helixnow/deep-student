# Wave2-E R7-03：QA×enableQaPass 组合测试

- 角色：0824 Wave2-E 第 7 轮「QA 组合测试员」（模型 claude-fable-5-thinking-high）
- 产出：`src-tauri/tests/qa_pass_critic_combo.rs`（新建集成测试，crate 名对照现有
  tests 用 `deep_student_lib`）+ 本报告
- 本轮纪律：**只写不跑**——未跑编译/测试/CI，未改产品代码，未 commit
  （由外层统一处理）。预期第 8 轮统一执行：
  `cargo test --test qa_pass_critic_combo`

## 1. 覆盖矩阵

三条 QA 留痕来源 × `enable_qa_pass` 两态（wire 缺省 = true）：

| 来源 | 产出通道（全部 pub API） | true 侧预期 | false 侧预期 |
|---|---|---|---|
| 字段规则 | `anki_qa_lint::lint_field_against_rule` + `merge_flags` | `field_rule_*` 条目落 `_qa_flags`，与 legacy `{field, rule}` 条目共存 | 不落：flag-only 写回整体丢弃；revise 写回被 sanitize 剥离 |
| 确定性 lint | `anki_qa_lint::lint_card` + `merge_flags` | lint code 落痕、按 (code, field) 去重幂等 | 不落 |
| critic relint | `anki_critic::plan_updates`（revise 内部：`llm_critic_revised` 审计 + 修订内容重跑 lint） | 审计（Info）+ relint 条目（如 `placeholder_residue` Error）落痕 | 不落，**但 `_content_provenance`（actor=llm_critic）必须存活** |

false 侧红线（台账 P0-2 / 7077075a 门控语义）：
`sanitize_plan_for_disabled_qa_pass` 只剥 `QA_FLAGS_FIELD`；溯源是事实记录
不是 QA 留痕，gold 第二道闸（`is_llm_critic_actor`）据此在 marker 被剥后
仍排除 critic 自改（污染路径 A 收口）。

## 2. 接线保真度

- 生成路径门控点（`parse_and_save_card` merge 后移除 `_qa_flags`，
  `streaming_anki_service.rs` L2146-2149）是私有函数，其三态契约已由模块内
  单测 `parse_and_save_card_honors_qa_pass_flag_persistence_contract` 锁定，
  本文件不重复。
- 本文件用 pub API 复现 **critic 收尾路径**的同一接线（`run_critic_pass`
  L987-997）：测试内 helper `plan_with_qa_gate` =
  `plan_updates` + 仅当 `StructuredOutputOptions::from_options_json(..)
  .qa_pass_enabled()` 为 false 时调 `sanitize_plan_for_disabled_qa_pass`。
- 开关轴走**真实 wire**：完整 `AnkiGenerationOptions` options JSON
  （必填 `deck_name`/`note_type`/`enable_images`/`max_cards_per_mistake`
  全给），不手搓布尔。附带锁定 fail-open 细节：残缺 options JSON
  （如只有 `{"enable_qa_pass":false}`）整体解析失败 → 回退默认开启，
  false **不生效**。

## 3. 测试清单（矩阵 10 个 + 补充 1 个，共 11 个 `#[test]`，预期全绿）

| # | 测试函数 | 矩阵格 |
|---|---|---|
| 1 | `options_wire_qa_pass_toggle_parses_explicit_default_and_malformed` | 开关轴 wire：显式 true/false、缺省、非法 JSON、残缺 JSON |
| 2 | `field_rule_violations_land_in_qa_flags_and_clean_value_stays_unflagged` | 字段规则 × true（含干净值不写键） |
| 3 | `deterministic_lint_merges_alongside_field_rule_history_and_dedupes` | 确定性 lint × true（legacy 条目共存 + 幂等去重） |
| 4 | `enabled_qa_pass_critic_flag_verdict_appends_llm_critic_entry` | critic flag × true（只追加、不打 marker、不盖戳） |
| 5 | `enabled_qa_pass_critic_revise_relints_audits_and_stamps_provenance` | critic revise/relint × 缺省开启（审计 Info + relint Error + 溯源戳） |
| 6 | `enabled_qa_pass_full_combo_keeps_all_flag_sources_coexisting_deduped` | 三来源全组合 × true（四路条目共存、relint 复报去重） |
| 7 | `disabled_qa_pass_drops_flag_only_update_even_with_field_rule_history` | 字段规则+flag × false（整体丢弃、统计照常） |
| 8 | `disabled_qa_pass_revise_strips_all_flag_sources_but_provenance_survives` | 三来源全组合 × false（`_qa_flags` 全剥、provenance 存活） |
| 9 | `disabled_qa_pass_drops_noop_revise_where_only_provenance_differs` | 空转 revise × false（溯源戳不构成落盘理由） |
| 10 | `disabled_qa_pass_output_card_still_excluded_by_provenance_gold_gate` | false 落库形态 × gold 双闸（marker 失明、provenance 命中、非用户证明） |

补充断言（第 11 个）：
`combined_flag_entries_preserve_per_source_severity`——组合落痕后各来源
严重度不串扰（字段规则 Warn / 审计 Info / relint 占位符 Error）。

## 4. fixture 设计要点

- `AnkiCard` / `FieldExtractionRule` 一律经 `serde_json::from_value` 构造
  （全字段 serde default，容忍产品侧后续加字段，与
  `gold_provenance_excludes_critic.rs` 同约定）。
- 组合卡 `combo_card_with_field_rule_and_lint_history`：correct="E" 触发
  `field_rule_allowed_values` + `field_rule_pattern`；双问号 front 触发
  `multi_concept`；空 tags 触发 `tags_empty`；revise 载荷注入
  `{{DOCUMENT_CONTENT}}` 触发 relint `placeholder_residue`——三来源在
  单卡上全命中，且 relint 对未变部位的复报天然构成去重用例。
- 全部断言只用 pub 符号：`anki_qa_lint`（`codes` 常量模块 /
  `QA_FLAGS_FIELD` / `LintSeverity`）、`anki_critic`（`plan_updates` /
  `sanitize_plan_for_disabled_qa_pass` / `CRITIC_FLAG_CODE` /
  `CRITIC_REVISED_CODE`）、`anki_gold_set`（provenance 三判定 +
  `CONTENT_PROVENANCE_FIELD` / `PROVENANCE_ACTOR_LLM_CRITIC` /
  `CRITIC_REVISED_QA_CODE`）、`anki_protocol::StructuredOutputOptions`、
  `models::{AnkiCard, FieldExtractionRule}`。无本地镜像常量，无待对齐项。

## 5. 第 8 轮执行注意

- 预期 11 个测试全绿（依赖符号均已合入：sanitize/provenance/relint 见
  7077075a、d8a606c2 及 r4 落地）；任一红即回归而非待落地。
- 测试为纯函数级，无 DB/网络/全局 registry 依赖（不触
  `document_tracker`），可与其余集成测试并行跑。
- 若 rustfmt 收口轮统一格式化，本文件无格式敏感断言（不含源码扫描类契约）。
