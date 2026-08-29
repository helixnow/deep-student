//! # QA×enableQaPass 组合矩阵：字段规则 + 确定性 lint + critic relint（Wave2-E 第 7 轮 #03）
//!
//! ## 只写不跑（本轮纪律）
//!
//! 本文件由第 7 轮「QA 组合测试员」编写，**本轮禁止编译/运行**。
//! 预期执行命令（第 8 轮统一跑）：
//!
//! ```text
//! cargo test --test qa_pass_critic_combo
//! ```
//!
//! ## 覆盖矩阵
//!
//! 三条 QA 留痕来源 × `enable_qa_pass` 两态（wire 缺省 = true）：
//!
//! | 来源 | 产出通道（pub API） | enable_qa_pass=true | enable_qa_pass=false |
//! | --- | --- | --- | --- |
//! | 字段规则 | `anki_qa_lint::lint_field_against_rule` + `merge_flags` | `field_rule_*` 落 `_qa_flags` | 不落（flag-only 写回整体丢弃 / revise 写回被剥） |
//! | 确定性 lint | `anki_qa_lint::lint_card` + `merge_flags` | lint code 落 `_qa_flags`，与既有条目共存去重 | 不落 |
//! | critic relint | `anki_critic::plan_updates`（revise 内部重跑 lint + `llm_critic_revised` 审计） | 审计 + relint 条目落 `_qa_flags` | 不落，**但 `_content_provenance` 仍落**（溯源非留痕） |
//!
//! false 侧红线（对应台账 P0-2 / 7077075a 门控语义）：
//! `sanitize_plan_for_disabled_qa_pass` **只剥 `QA_FLAGS_FIELD`**——
//! `_content_provenance`（actor=llm_critic）必须存活，gold 第二道闸
//! （`is_llm_critic_actor`）据此在 marker 被剥后仍能排除 critic 自改。
//!
//! ## 接线保真度说明
//!
//! 生成路径的门控点（`parse_and_save_card` 在 merge 后移除 `_qa_flags`）是
//! 私有函数，其三态契约由模块内单测锁定；本文件用 pub API 复现 critic 收尾
//! 路径的同一接线（`run_critic_pass` L987-997 的语义）：
//! `StructuredOutputOptions::from_options_json(..).qa_pass_enabled()` 为 false
//! 时对 `plan_updates` 产物调 `sanitize_plan_for_disabled_qa_pass`。
//! 开关解析走真实 wire（完整 `AnkiGenerationOptions` options JSON），
//! 不手搓布尔——组合的两个轴都是产品语义而非 fixture 语义。
//!
//! ## 红绿预期（留给第 8 轮核对，本轮不跑）
//!
//! 全部依赖符号已落地（sanitize/provenance/relint 分别在 r1 基线与 7077075a、
//! d8a606c2 中合入），**10 个测试预期全绿**；任一红即为回归而非待落地。

use serde_json::{json, Value};
use std::collections::HashMap;

use deep_student_lib::anki_critic::{
    plan_updates, sanitize_plan_for_disabled_qa_pass, CardVerdict, CriticPlan, RevisedFields,
    Verdict, CRITIC_FLAG_CODE, CRITIC_REVISED_CODE,
};
use deep_student_lib::anki_gold_set::{
    has_critic_revision_marker, is_llm_critic_actor, is_user_proven_edit, parse_content_provenance,
    CONTENT_PROVENANCE_FIELD, CRITIC_REVISED_QA_CODE, PROVENANCE_ACTOR_LLM_CRITIC,
};
use deep_student_lib::anki_protocol::StructuredOutputOptions;
use deep_student_lib::anki_qa_lint::{
    codes, lint_card, lint_field_against_rule, merge_flags, CardLintInput, LintConfig,
    LintSeverity, QA_FLAGS_FIELD,
};
use deep_student_lib::models::{AnkiCard, FieldExtractionRule};

// ============================================================================
// fixture 构造
// ============================================================================

/// 经 serde 构造 `AnkiCard`（serde 全字段 default，容忍产品侧新增字段）。
fn card_from_json(id: &str, front: &str, back: &str, tags: &[&str], extras: Value) -> AnkiCard {
    serde_json::from_value(json!({
        "id": id,
        "task_id": "task-combo",
        "front": front,
        "back": back,
        "tags": tags,
        "created_at": "2026-08-24T00:00:00Z",
        "updated_at": "2026-08-24T01:00:00Z",
        "extra_fields": extras,
    }))
    .expect("AnkiCard JSON fixture 必须反序列化成功")
}

/// 真实 wire 形态的 options JSON：`AnkiGenerationOptions` 的必填字段全给，
/// `enable_qa_pass` 按场景注入或省略（省略 = 默认开启）。
fn options_json(enable_qa_pass: Option<bool>) -> String {
    let mut v = json!({
        "deck_name": "默认牌组",
        "note_type": "Basic",
        "enable_images": false,
        "max_cards_per_mistake": 5,
    });
    if let Some(b) = enable_qa_pass {
        v["enable_qa_pass"] = json!(b);
    }
    v.to_string()
}

/// 复现 `run_critic_pass` 的门控接线（anki_critic.rs L987-997 语义）：
/// 裁决落地照常，仅当 options JSON 解析出 `enable_qa_pass=false` 时收口。
fn plan_with_qa_gate(
    cards: &[AnkiCard],
    verdicts: &[CardVerdict],
    options_json: &str,
) -> CriticPlan {
    let mut plan = plan_updates(cards, verdicts);
    if !StructuredOutputOptions::from_options_json(options_json).qa_pass_enabled() {
        sanitize_plan_for_disabled_qa_pass(&mut plan, cards);
    }
    plan
}

/// 选择题 correct 字段的模板规则（allowed A-D + 模式 ^[A-D]$）。
/// 经 serde 构造，必填键显式给出，其余走 `#[serde(default)]`。
fn correct_field_rule() -> FieldExtractionRule {
    serde_json::from_value(json!({
        "field_type": "Text",
        "is_required": true,
        "default_value": null,
        "validation_pattern": "^[A-D]$",
        "description": "正确选项",
        "min_length": 1,
        "max_length": 1,
        "allowed_values": ["A", "B", "C", "D"],
    }))
    .expect("FieldExtractionRule JSON fixture 必须反序列化成功")
}

/// 解出 `_qa_flags` JSON 数组（键缺失 → 空列表；非法 JSON 直接 panic 暴露污染）。
fn qa_entries(extras: &HashMap<String, String>) -> Vec<Value> {
    match extras.get(QA_FLAGS_FIELD) {
        None => Vec::new(),
        Some(raw) => serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|v| v.as_array().cloned())
            .expect("_qa_flags 必须是合法 JSON 数组"),
    }
}

/// `_qa_flags` 中全部结构化 code（字段规则校验的 legacy `{field, rule}` 条目无 code，不计入）。
fn qa_codes(extras: &HashMap<String, String>) -> Vec<String> {
    qa_entries(extras)
        .iter()
        .filter_map(|e| e.get("code").and_then(Value::as_str).map(str::to_string))
        .collect()
}

fn flag_verdict(card_id: &str) -> CardVerdict {
    CardVerdict {
        card_id: card_id.to_string(),
        verdict: Verdict::Flag,
        reasons: vec!["与同批卡片重复".to_string()],
        revised: None,
    }
}

fn revise_verdict(card_id: &str, back: &str) -> CardVerdict {
    CardVerdict {
        card_id: card_id.to_string(),
        verdict: Verdict::Revise,
        reasons: vec!["答案与源材料不符".to_string()],
        revised: Some(RevisedFields {
            front: None,
            back: Some(back.to_string()),
            text: None,
        }),
    }
}

/// 组合卡：三条留痕来源在 critic 送审前已就位两条——
/// 字段规则违规（correct="E"）+ 确定性 lint 违规（双问号 multi_concept、
/// 空 tags → tags_empty）——第三条（critic relint）由 revise 裁决触发。
fn combo_card_with_field_rule_and_lint_history() -> AnkiCard {
    let mut card = card_from_json(
        "c-combo",
        "什么是惯性？惯性是什么？",
        "物体保持原有运动状态不变的性质",
        &[],
        json!({ "correct": "E" }),
    );
    let field_issues = lint_field_against_rule("correct", "E", &correct_field_rule());
    merge_flags(&mut card.extra_fields, &field_issues);
    let lint_issues = lint_card(
        &CardLintInput {
            front: &card.front,
            back: &card.back,
            text: card.text.as_deref(),
            tags: &card.tags,
            extra_fields: &card.extra_fields,
        },
        &LintConfig::default(),
    );
    merge_flags(&mut card.extra_fields, &lint_issues);
    card
}

// ============================================================================
// 轴 0：enable_qa_pass 的 wire 解析（组合矩阵的开关轴必须是产品语义）
// ============================================================================

/// 开关轴走真实 wire：显式 false / 显式 true / 缺省 / 非法 JSON / 残缺 JSON。
/// 残缺 JSON（缺 `deck_name` 等必填字段）解析失败回退默认 = QA 开启——
/// 这是「fail-open 保持既有行为」的 wire 细节，组合测试必须锁住。
#[test]
fn options_wire_qa_pass_toggle_parses_explicit_default_and_malformed() {
    let off = StructuredOutputOptions::from_options_json(&options_json(Some(false)));
    assert_eq!(off.enable_qa_pass, Some(false));
    assert!(!off.qa_pass_enabled(), "显式 false 必须关闭 QA 留痕");

    let on = StructuredOutputOptions::from_options_json(&options_json(Some(true)));
    assert!(on.qa_pass_enabled());

    let default = StructuredOutputOptions::from_options_json(&options_json(None));
    assert_eq!(default.enable_qa_pass, None);
    assert!(default.qa_pass_enabled(), "缺省必须等价于开启（既有行为）");

    assert!(
        StructuredOutputOptions::from_options_json("not-json").qa_pass_enabled(),
        "非法 JSON 回退默认 = 开启"
    );
    assert!(
        StructuredOutputOptions::from_options_json(r#"{"enable_qa_pass":false}"#).qa_pass_enabled(),
        "残缺 options（缺必填字段）整体解析失败 → 回退默认开启，false 不生效"
    );
}

// ============================================================================
// enable_qa_pass=true 侧：三条来源逐一落痕、共存、去重
// ============================================================================

/// 字段规则（true 侧基线）：违规值产出 `field_rule_*` 条目落 `_qa_flags`；
/// 合法值零违规且 `merge_flags` 不写键（干净卡不被污染）。
#[test]
fn field_rule_violations_land_in_qa_flags_and_clean_value_stays_unflagged() {
    let rule = correct_field_rule();

    let issues = lint_field_against_rule("correct", "E", &rule);
    let mut extras: HashMap<String, String> = HashMap::new();
    merge_flags(&mut extras, &issues);
    let codes_seen = qa_codes(&extras);
    assert!(codes_seen.contains(&codes::FIELD_RULE_ALLOWED_VALUES.to_string()));
    assert!(codes_seen.contains(&codes::FIELD_RULE_PATTERN.to_string()));
    assert!(
        qa_entries(&extras)
            .iter()
            .all(|e| e.get("field").and_then(Value::as_str) == Some("correct")),
        "字段规则条目必须落在违规字段名上"
    );

    let mut clean: HashMap<String, String> = HashMap::new();
    merge_flags(&mut clean, &lint_field_against_rule("correct", "A", &rule));
    assert!(
        !clean.contains_key(QA_FLAGS_FIELD),
        "合法值不得写入 _qa_flags 键"
    );
}

/// 确定性 lint（true 侧）：lint 条目与既有字段规则校验的 legacy
/// `{field, rule, message}` 条目共存不覆盖；重复 merge 幂等去重。
#[test]
fn deterministic_lint_merges_alongside_field_rule_history_and_dedupes() {
    let mut extras: HashMap<String, String> = HashMap::new();
    // 模拟 streaming 服务字段规则校验已写入的 legacy 形态条目（无 code 键）
    extras.insert(
        QA_FLAGS_FIELD.to_string(),
        r#"[{"field":"correct","rule":"allowed_values","message":"值 E 不在允许值列表中"}]"#
            .to_string(),
    );

    let tags: Vec<String> = Vec::new();
    let inner: HashMap<String, String> = HashMap::new();
    let issues = lint_card(
        &CardLintInput {
            front: "什么是惯性？惯性是什么？",
            back: "物体保持原有运动状态不变的性质",
            text: None,
            tags: &tags,
            extra_fields: &inner,
        },
        &LintConfig::default(),
    );
    merge_flags(&mut extras, &issues);
    merge_flags(&mut extras, &issues); // 重复 merge 必须幂等

    let entries = qa_entries(&extras);
    assert_eq!(
        entries[0].get("rule").and_then(Value::as_str),
        Some("allowed_values"),
        "legacy 字段规则条目必须保留在首位"
    );
    let codes_seen = qa_codes(&extras);
    assert!(codes_seen.contains(&codes::MULTI_CONCEPT.to_string()));
    assert!(codes_seen.contains(&codes::TAGS_EMPTY.to_string()));
    assert_eq!(
        codes_seen
            .iter()
            .filter(|c| *c == codes::MULTI_CONCEPT)
            .count(),
        1,
        "同 (code, field) 重复 merge 不得产生重复条目"
    );
}

/// critic flag 裁决（true 侧）：`llm_critic` 条目追加落痕，
/// 既有字段规则 + lint 留痕原样保留，统计入 flagged 桶。
#[test]
fn enabled_qa_pass_critic_flag_verdict_appends_llm_critic_entry() {
    let card = combo_card_with_field_rule_and_lint_history();
    let history_len = qa_entries(&card.extra_fields).len();

    let plan = plan_with_qa_gate(
        std::slice::from_ref(&card),
        &[flag_verdict("c-combo")],
        &options_json(Some(true)),
    );

    assert_eq!(plan.flagged, 1);
    assert_eq!(
        plan.updates.len(),
        1,
        "flag 裁决在 QA 开启时必须产生留痕写回"
    );
    let updated = &plan.updates[0];
    let entries = qa_entries(&updated.extra_fields);
    assert_eq!(entries.len(), history_len + 1, "只追加一条 llm_critic 条目");
    assert!(qa_codes(&updated.extra_fields).contains(&CRITIC_FLAG_CODE.to_string()));
    assert!(
        !has_critic_revision_marker(&updated.extra_fields),
        "flag 裁决不改内容，不得打 revised marker"
    );
    assert!(
        parse_content_provenance(&updated.extra_fields).is_none(),
        "flag 裁决不写内容，不得盖溯源戳"
    );
}

/// critic revise 裁决（true 侧，enable_qa_pass 缺省 = 开启）：修订内容重跑
/// 确定性 lint（revise 引入的占位符必须被 relint 抓到）、`llm_critic_revised`
/// 审计条目（Info）落痕、`_content_provenance` 盖 actor=llm_critic 戳。
#[test]
fn enabled_qa_pass_critic_revise_relints_audits_and_stamps_provenance() {
    let card = card_from_json(
        "c-revise",
        "什么是惯性？",
        "物体保持原有运动状态不变的性质",
        &["物理"],
        json!({}),
    );
    let plan = plan_with_qa_gate(
        std::slice::from_ref(&card),
        &[revise_verdict("c-revise", "请参考 {{DOCUMENT_CONTENT}}")],
        &options_json(None), // 缺省 = 开启：默认路径必须留痕
    );

    assert_eq!(plan.revised, 1);
    assert_eq!(plan.updates.len(), 1);
    let updated = &plan.updates[0];
    assert_eq!(
        updated.back, "请参考 {{DOCUMENT_CONTENT}}",
        "修订内容必须写回"
    );
    assert_eq!(updated.id, "c-revise", "主键永不变更");

    let entries = qa_entries(&updated.extra_fields);
    let audit = entries
        .iter()
        .find(|e| e.get("code").and_then(Value::as_str) == Some(CRITIC_REVISED_CODE))
        .expect("必须携带 llm_critic_revised 审计条目");
    assert_eq!(audit.get("severity").and_then(Value::as_str), Some("info"));
    let relint = entries
        .iter()
        .find(|e| e.get("code").and_then(Value::as_str) == Some(codes::PLACEHOLDER_RESIDUE))
        .expect("relint 必须抓到 revise 引入的模板占位符");
    assert_eq!(relint.get("field").and_then(Value::as_str), Some("back"));
    assert_eq!(
        relint.get("severity").and_then(Value::as_str),
        Some("error")
    );

    assert!(has_critic_revision_marker(&updated.extra_fields));
    let prov = parse_content_provenance(&updated.extra_fields)
        .expect("revise 必须盖 _content_provenance 溯源戳");
    assert_eq!(prov.actor, PROVENANCE_ACTOR_LLM_CRITIC);
    assert_eq!(prov.code.as_deref(), Some(CRITIC_REVISED_QA_CODE));
}

/// 全组合（true 侧）：字段规则 + 确定性 lint + critic 审计 + relint 四路条目
/// 在同一 `_qa_flags` 数组共存，且按 (code, field) 去重——relint 复报的
/// 既有违规（multi_concept / tags_empty）不得翻倍。
#[test]
fn enabled_qa_pass_full_combo_keeps_all_flag_sources_coexisting_deduped() {
    let card = combo_card_with_field_rule_and_lint_history();
    let plan = plan_with_qa_gate(
        std::slice::from_ref(&card),
        &[revise_verdict("c-combo", "请参考 {{DOCUMENT_CONTENT}}")],
        &options_json(Some(true)),
    );

    assert_eq!(plan.updates.len(), 1);
    let updated = &plan.updates[0];
    let codes_seen = qa_codes(&updated.extra_fields);
    for expected in [
        codes::FIELD_RULE_ALLOWED_VALUES, // 来源 1：字段规则
        codes::FIELD_RULE_PATTERN,
        codes::MULTI_CONCEPT, // 来源 2：确定性 lint（送审前）
        codes::TAGS_EMPTY,
        CRITIC_REVISED_CODE,        // 来源 3a：critic 审计
        codes::PLACEHOLDER_RESIDUE, // 来源 3b：critic relint
    ] {
        assert!(
            codes_seen.contains(&expected.to_string()),
            "组合留痕缺少 {}: {:?}",
            expected,
            codes_seen
        );
    }
    // relint 对未变的 front（双问号）与空 tags 会复报同 code 同 field → 必须去重
    for dedup_code in [codes::MULTI_CONCEPT, codes::TAGS_EMPTY] {
        assert_eq!(
            codes_seen.iter().filter(|c| *c == dedup_code).count(),
            1,
            "{} 在 relint 复报后必须保持单条",
            dedup_code
        );
    }
    assert!(is_llm_critic_actor(&updated.extra_fields));
}

// ============================================================================
// enable_qa_pass=false 侧：不落 `_qa_flags`，但 provenance 仍落
// ============================================================================

/// false × flag 裁决：flag-only 写回（即便原卡带字段规则历史留痕）整体丢弃，
/// 不产生任何落盘；裁决统计（flagged）照常——观测不受门控影响。
#[test]
fn disabled_qa_pass_drops_flag_only_update_even_with_field_rule_history() {
    let card = combo_card_with_field_rule_and_lint_history();
    let plan = plan_with_qa_gate(
        std::slice::from_ref(&card),
        &[flag_verdict("c-combo")],
        &options_json(Some(false)),
    );

    assert!(
        plan.updates.is_empty(),
        "关 QA 留痕后 flag-only 更新必须整体丢弃（不空写回、不删历史留痕）"
    );
    assert_eq!(plan.flagged, 1, "裁决统计不受门控影响");
}

/// false × revise 全组合：内容修订保留写回，但字段规则 + 确定性 lint +
/// critic 审计 + relint 的 `_qa_flags` 全量剥离；`_content_provenance`
/// （actor=llm_critic）必须存活——溯源是事实记录，不在门控剥离范围。
#[test]
fn disabled_qa_pass_revise_strips_all_flag_sources_but_provenance_survives() {
    let card = combo_card_with_field_rule_and_lint_history();
    let plan = plan_with_qa_gate(
        std::slice::from_ref(&card),
        &[revise_verdict("c-combo", "请参考 {{DOCUMENT_CONTENT}}")],
        &options_json(Some(false)),
    );

    assert_eq!(plan.revised, 1);
    assert_eq!(
        plan.updates.len(),
        1,
        "有实质内容差异的 revise 必须保留写回"
    );
    let updated = &plan.updates[0];
    assert_eq!(updated.back, "请参考 {{DOCUMENT_CONTENT}}");
    assert!(
        !updated.extra_fields.contains_key(QA_FLAGS_FIELD),
        "false 侧不得落任何 _qa_flags（字段规则/lint/审计/relint 一律剥）"
    );
    let prov =
        parse_content_provenance(&updated.extra_fields).expect("溯源戳必须随内容修订一并落盘");
    assert_eq!(prov.actor, PROVENANCE_ACTOR_LLM_CRITIC);
    assert_eq!(prov.code.as_deref(), Some(CRITIC_REVISED_QA_CODE));
}

/// false × 空转 revise：修订内容与原卡逐字相同（模型「revise」了个寂寞）——
/// 剥掉 `_qa_flags` 后与原卡无内容差异，且溯源戳自身不构成落盘理由，
/// 更新必须整体丢弃（不触发 CAS、不递增 local_version、不进同步链路）。
#[test]
fn disabled_qa_pass_drops_noop_revise_where_only_provenance_differs() {
    let card = card_from_json(
        "c-noop",
        "什么是惯性？",
        "物体保持原有运动状态不变的性质",
        &["物理"],
        json!({ "note": "保持不变的业务扩展字段" }),
    );
    let plan = plan_with_qa_gate(
        std::slice::from_ref(&card),
        // revised.back 与原卡逐字相同 → 套用后内容零变化
        &[revise_verdict("c-noop", "物体保持原有运动状态不变的性质")],
        &options_json(Some(false)),
    );

    assert_eq!(plan.revised, 1, "裁决统计照常（critic 观测不受门控影响）");
    assert!(
        plan.updates.is_empty(),
        "内容零变化的 revise 在 false 侧必须丢弃——溯源戳不是落盘理由"
    );
}

/// false 侧落库形态 × gold 闸门（污染路径 A 的组合收口）：marker 已随
/// `_qa_flags` 被剥（第一道闸失明），但 provenance 第二道闸必须仍然命中——
/// critic 自改在任何开关组合下都不得被洗白成「用户编辑」。
#[test]
fn disabled_qa_pass_output_card_still_excluded_by_provenance_gold_gate() {
    let card = card_from_json(
        "c-gate",
        "什么是熵？",
        "系统混乱程度的度量",
        &["热学"],
        json!({}),
    );
    let plan = plan_with_qa_gate(
        std::slice::from_ref(&card),
        &[revise_verdict("c-gate", "熵是系统微观状态数的对数度量")],
        &options_json(Some(false)),
    );
    assert_eq!(plan.updates.len(), 1);
    let landed = &plan.updates[0];

    assert!(
        !has_critic_revision_marker(&landed.extra_fields),
        "第一道闸（_qa_flags marker）在 false 侧确已失明——这正是需要第二道闸的场景"
    );
    assert!(
        is_llm_critic_actor(&landed.extra_fields),
        "第二道闸（provenance actor=llm_critic）必须命中"
    );
    assert!(
        !is_user_proven_edit(&landed.extra_fields),
        "critic 自改绝不构成用户编辑证明"
    );
    assert!(
        landed.extra_fields.contains_key(CONTENT_PROVENANCE_FIELD),
        "溯源键必须在落库形态中存活"
    );
}

// ============================================================================
// 严重度语义在组合下保持（true 侧补充断言）
// ============================================================================

/// 组合落痕后各来源的严重度语义不串扰：字段规则 Warn、审计 Info、
/// relint 占位符 Error——前端 QA 面板按 severity 分层展示依赖此不变量。
#[test]
fn combined_flag_entries_preserve_per_source_severity() {
    let field_issues = lint_field_against_rule("correct", "E", &correct_field_rule());
    assert!(
        field_issues
            .iter()
            .all(|i| i.severity == LintSeverity::Warn),
        "字段规则违规恒为 Warn（不丢卡）"
    );

    let card = combo_card_with_field_rule_and_lint_history();
    let plan = plan_with_qa_gate(
        std::slice::from_ref(&card),
        &[revise_verdict("c-combo", "请参考 {{DOCUMENT_CONTENT}}")],
        &options_json(Some(true)),
    );
    let entries = qa_entries(&plan.updates[0].extra_fields);
    let severity_of = |code: &str| -> Option<String> {
        entries
            .iter()
            .find(|e| e.get("code").and_then(Value::as_str) == Some(code))
            .and_then(|e| e.get("severity").and_then(Value::as_str))
            .map(str::to_string)
    };
    assert_eq!(
        severity_of(codes::FIELD_RULE_ALLOWED_VALUES).as_deref(),
        Some("warn")
    );
    assert_eq!(severity_of(CRITIC_REVISED_CODE).as_deref(), Some("info"));
    assert_eq!(
        severity_of(codes::PLACEHOLDER_RESIDUE).as_deref(),
        Some("error")
    );
}
