//! # Gold 溯源反例矩阵：critic 修订卡不得进 grounded reference（Wave2-E 第 2 轮 #07）
//!
//! ## 只写不跑（本轮纪律）
//!
//! 本文件由第 2 轮「gold 测试员」编写，**本轮禁止编译/运行**。
//! 预期执行命令（第 8 轮统一跑）：
//!
//! ```text
//! cargo test --test gold_provenance_excludes_critic
//! ```
//!
//! ## 核心预期（验收红线，对应台账 P0-2 / r1-04 §5.5）
//!
//! **critic 修订卡（无论 marker 在不在）必须 0 条 grounded reference。**
//! 即：`gold_references_from_cards` 对任何带 `llm_critic_revised` `_qa_flags`
//! 标记、或带 `_content_provenance.actor=llm_critic` 的卡，一律不产出
//! `ReferenceCard`；`classify_candidate` 对这类候选不得给出 `Edited*` 标签。
//!
//! ## 与落地符号的对齐约定（待第 8 轮与落地符号对齐）
//!
//! 编写时 `_content_provenance` / `edit_actor` 尚未落地（gold 落地员按
//! r1-04 §5 方案在 `anki_gold_set.rs` / `anki_critic.rs` 内实现，模块内单测
//! 归落地员）。本文件刻意**不引用未落地符号**，只用当前已 pub 的 API：
//!
//! - `deep_student_lib::anki_critic::{gold_references_from_cards, CriticConfig, ReferenceCard}`
//! - `deep_student_lib::anki_gold_set::{classify_candidate, mine_gold_set,
//!   select_grounded_reference_pairs, has_critic_revision_marker, gold_lint_config,
//!   GoldCandidate, GoldLabel, GoldMiningConfig, CRITIC_REVISED_QA_CODE,
//!   ORIGINAL_GENERATION_FIELD}`
//! - `deep_student_lib::anki_qa_lint::QA_FLAGS_FIELD`
//! - `deep_student_lib::models::AnkiCard`
//!
//! 未落地的键名/wire 值以本地 fixture 常量先行（见下方 `CONTENT_PROVENANCE_FIELD`
//! 等），逐字对齐 r1-04 §5.1 约定；若落地员最终导出了同义 pub 常量，第 8 轮
//! 应把本地常量替换为产品符号（此为唯一预期的对齐改动点）。
//!
//! `AnkiCard` / `GoldCandidate` 一律经 `serde_json::from_value` 构造：
//! serde 默认忽略未知字段、`#[serde(default)]` 兜底缺失字段，因此落地员给
//! `GoldCandidate` 加 `edit_actor: Option<EditActor>` 后，本文件无需改动即可
//! 编译；JSON 里前置写入的 `"edit_actor": "user"` 等值在落地前被忽略、落地后
//! 自动生效（wire 小写枚举按 r1-04 §5.1："user" | "llm_critic" | "import" | "sync"）。
//!
//! ## 各测试的红绿预期（留给第 8 轮核对，本轮不跑）
//!
//! | 测试 | 依赖落地员闸门 | 落地前预期 | 落地后预期 |
//! | --- | --- | --- | --- |
//! | qa_marker_critic_revised_card_yields_zero_grounded_references | 否（既有 marker 过滤） | 绿 | 绿 |
//! | whitewashed_provenance_actor_llm_critic_yields_zero_references | 是（收集器 provenance 过滤） | 红 | 绿 |
//! | legacy_card_without_marker_or_provenance_is_conservatively_excluded | 是（旧卡保守策略） | 红 | 绿 |
//! | user_actor_minor_edit_yields_grounded_reference_pair | 否（正向不误伤） | 绿 | 绿 |
//! | import_actor_card_is_never_user_gold | 是（actor≠user 排除） | 红 | 绿 |
//! | marker_or_provenance_any_hit_excludes_only_tainted_cards | 是（provenance-only 变体） | 红 | 绿 |
//! | classify_critic_revised_candidate_never_gets_edited_label | 否（既有第 1 通道） | 绿 | 绿 |
//! | classify_user_actor_minor_edit_is_edited_minor | 否 | 绿 | 绿 |
//! | classify_content_diff_without_actor_proof_is_unlabeled | 是（标注层闸门） | 红 | 绿 |
//! | classify_import_actor_never_gets_edited_label | 是（标注层闸门） | 红 | 绿 |
//! | marker_helper_hits_only_structured_stable_code | 否 | 绿 | 绿 |

use serde_json::{json, Value};

use deep_student_lib::anki_critic::{gold_references_from_cards, CriticConfig, ReferenceCard};
use deep_student_lib::anki_gold_set::{
    classify_candidate, gold_lint_config, has_critic_revision_marker, mine_gold_set,
    select_grounded_reference_pairs, GoldCandidate, GoldLabel, GoldMiningConfig,
    CRITIC_REVISED_QA_CODE, ORIGINAL_GENERATION_FIELD,
};
use deep_student_lib::anki_qa_lint::QA_FLAGS_FIELD;
use deep_student_lib::models::AnkiCard;

// ============================================================================
// 本地 fixture 常量（待第 8 轮与落地符号对齐）
// ============================================================================

/// 待第 8 轮与落地符号对齐：落地员应在 `anki_gold_set` 导出
/// `CONTENT_PROVENANCE_FIELD`；此处按 r1-04 §5.1 约定字面量先行。
const CONTENT_PROVENANCE_FIELD: &str = "_content_provenance";

/// provenance wire actor 值（r1-04 §5.1，小写）。落地后若产品侧导出枚举/常量，
/// 第 8 轮替换为产品符号。
const ACTOR_USER: &str = "user";
const ACTOR_LLM_CRITIC: &str = "llm_critic";
const ACTOR_IMPORT: &str = "import";
/// 方案里预留的第四个 actor；本矩阵未单列 sync 反例（与 import 同为
/// 「非 user 即排除」语义），保留常量供第 8 轮扩展。
/// 待第 8 轮与落地符号对齐。
#[allow(dead_code)]
const ACTOR_SYNC: &str = "sync";

// ============================================================================
// fixture 构造（全部走 serde JSON，容忍落地员新增 #[serde(default)] 字段）
// ============================================================================

/// `_content_provenance` 值（二次编码 JSON 字符串，r1-04 §5.1 形状）。
fn provenance_value(actor: &str) -> String {
    json!({
        "actor": actor,
        "code": if actor == ACTOR_LLM_CRITIC { Some(CRITIC_REVISED_QA_CODE) } else { None },
        "at": "2026-08-24T12:00:00Z",
    })
    .to_string()
}

/// 带 `llm_critic_revised` 结构化条目的 `_qa_flags` 值。
fn critic_marker_flags() -> String {
    json!([
        { "code": "answer_leak", "field": "front" },
        { "code": CRITIC_REVISED_QA_CODE, "field": "card" },
    ])
    .to_string()
}

/// `_original_generation` 值（二次编码 JSON 字符串）。
fn original_snapshot(front: &str, back: &str) -> String {
    json!({ "front": front, "back": back }).to_string()
}

/// 经 serde 构造 `AnkiCard`：`extra_fields` 为 String→String 映射。
/// 不用结构体字面量——落地员如需给 `AnkiCard` 加 `#[serde(default)]` 字段，
/// 本 fixture 零改动。
fn card_from_json(id: &str, front: &str, back: &str, extras: Value) -> AnkiCard {
    serde_json::from_value(json!({
        "id": id,
        "task_id": "task-sibling",
        "front": front,
        "back": back,
        "created_at": "2026-08-01T00:00:00Z",
        "updated_at": "2026-08-01T01:00:00Z",
        "extra_fields": extras,
    }))
    .expect("AnkiCard JSON fixture 必须反序列化成功（全字段 serde default）")
}

/// 经 serde 构造 `GoldCandidate`。JSON 里可前置携带 `edit_actor`：
/// 落地前 serde 忽略未知字段，落地后自动填充新字段（待第 8 轮与落地符号对齐）。
fn candidate_from_json(v: Value) -> GoldCandidate {
    serde_json::from_value(v)
        .expect("GoldCandidate JSON fixture 必须反序列化成功（旧 JSON 兼容是落地方案硬约束）")
}

/// 编辑通道候选的基础 JSON：original ≠ current、内容干净、无删除/错误卡信号。
/// `edit_actor` 由调用方按场景注入或省略。
fn edited_candidate_json(card_id: &str, edit_actor: Option<&str>) -> Value {
    let mut v = json!({
        "card_id": card_id,
        "current": { "front": "什么是惯性？", "back": "物体保持原有运动状态不变的性质" },
        // 与 current 仅差一个问号 → 编辑距离比远小于 0.25（EditedMinor 区间）
        "original": { "front": "什么是惯性？？", "back": "物体保持原有运动状态不变的性质" },
        "created_at_ms": 1_000_000,
        "updated_at_ms": 2_000_000,
        "review_count": 0,
        "again_count": 0,
        "was_error_card": false,
        "is_error_card": false,
        "critic_revised": false,
    });
    if let Some(actor) = edit_actor {
        v["edit_actor"] = json!(actor);
    }
    v
}

/// 收集入口：当前任务固定为 `task-current`，兄弟卡 task_id 为 `task-sibling`。
fn mine_references(cards: &[AnkiCard]) -> Vec<ReferenceCard> {
    gold_references_from_cards(cards, "task-current", &CriticConfig::default())
}

// ============================================================================
// 卡片层反例矩阵（gold_references_from_cards）
// ============================================================================

/// 覆盖 1（卡片层）：`_qa_flags` 带 `llm_critic_revised` 结构化条目的卡，
/// 即使内容 ≠ `_original_generation` 快照且金标端 lint-clean，
/// 也必须 0 条 grounded reference。
#[test]
fn qa_marker_critic_revised_card_yields_zero_grounded_references() {
    let card = card_from_json(
        "c-marker",
        "什么是惯性？",
        "物体保持原有运动状态不变的性质",
        json!({
            ORIGINAL_GENERATION_FIELD:
                original_snapshot("什么是惯性？答案是保持运动状态。", "保持运动状态"),
            QA_FLAGS_FIELD: critic_marker_flags(),
        }),
    );

    let refs = mine_references(&[card]);
    assert!(
        refs.is_empty(),
        "critic 修订卡（marker 在场）必须 0 条 reference，实际 {} 条",
        refs.len()
    );
}

/// 覆盖 2（洗白路径 A，r1-04 §2）：`enable_qa_pass=false` 下
/// `sanitize_plan_for_disabled_qa_pass` 剥掉整个 `_qa_flags`（连 marker），
/// 但 `_content_provenance` 是事实记录、不在剥离范围（落地方案跨人契约 #2）。
/// 落库形态：内容 ≠ 快照、**无** `_qa_flags`、有 `actor=llm_critic` provenance。
/// 该卡必须同样被排除——模型自改不得洗白成用户金标。
#[test]
fn whitewashed_provenance_actor_llm_critic_yields_zero_references() {
    let card = card_from_json(
        "c-whitewash",
        "什么是惯性？",
        "物体保持原有运动状态不变的性质",
        json!({
            ORIGINAL_GENERATION_FIELD:
                original_snapshot("什么是惯性？答案是保持运动状态。", "保持运动状态"),
            // 刻意不写 QA_FLAGS_FIELD：模拟 sanitize 剥离后的落库形态
            CONTENT_PROVENANCE_FIELD: provenance_value(ACTOR_LLM_CRITIC),
        }),
    );

    let refs = mine_references(&[card]);
    assert!(
        refs.is_empty(),
        "洗白路径 A：marker 已被剥但 provenance.actor=llm_critic，必须 0 条 reference，实际 {} 条",
        refs.len()
    );
}

/// 覆盖 3（卡片层，旧卡保守策略，r1-04 §5.3）：内容 ≠ 快照、无 marker、
/// 无 provenance——历史污染卡与真实用户旧编辑不可区分，一律不进 gold。
#[test]
fn legacy_card_without_marker_or_provenance_is_conservatively_excluded() {
    let card = card_from_json(
        "c-legacy",
        "什么是惯性？",
        "物体保持原有运动状态不变的性质",
        json!({
            ORIGINAL_GENERATION_FIELD:
                original_snapshot("什么是惯性？答案是保持运动状态。", "保持运动状态"),
        }),
    );

    let refs = mine_references(&[card]);
    assert!(
        refs.is_empty(),
        "无编辑者证明的旧卡必须保守排除（宁可少挖不可污染），实际 {} 条",
        refs.len()
    );
}

/// 覆盖 4（卡片层）：`actor=user` 的小幅编辑卡是唯一合法的修正对来源，
/// 新闸门不得误伤真用户。同时充当矩阵的阳性对照：证明其余测试的空结果
/// 来自过滤而非挖掘管线整体哑火。
#[test]
fn user_actor_minor_edit_yields_grounded_reference_pair() {
    let card = card_from_json(
        "c-user",
        "什么是惯性？",
        "物体保持原有运动状态不变的性质",
        json!({
            ORIGINAL_GENERATION_FIELD:
                original_snapshot("什么是惯性？答案是保持运动状态。", "保持运动状态"),
            CONTENT_PROVENANCE_FIELD: provenance_value(ACTOR_USER),
        }),
    );

    let refs = mine_references(&[card]);
    assert_eq!(refs.len(), 1, "actor=user 修正对必须正常入选");
    assert_eq!(refs[0].front, "什么是惯性？", "edited → 金标问题面");
    assert_eq!(
        refs[0].back, "物体保持原有运动状态不变的性质",
        "edited → 金标答案面"
    );
    assert_eq!(
        refs[0].degraded_front.as_deref(),
        Some("什么是惯性？答案是保持运动状态。"),
        "original → 劣化问题面"
    );
    assert_eq!(refs[0].degraded_back.as_deref(), Some("保持运动状态"));
}

/// 覆盖 5（卡片层）：`actor=import` 的卡（APKG 导入合并等）不是用户编辑，
/// 不得当作用户金标——外部包可自带伪造 `_original_generation`
/// （台账 P0-2 洞 3 的间接 prompt 注入面）。
#[test]
fn import_actor_card_is_never_user_gold() {
    let card = card_from_json(
        "c-import",
        "什么是加速度？",
        "速度对时间的变化率",
        json!({
            ORIGINAL_GENERATION_FIELD:
                original_snapshot("什么是加速度？答案是速度变化率。", "速度变化率"),
            CONTENT_PROVENANCE_FIELD: provenance_value(ACTOR_IMPORT),
        }),
    );

    let refs = mine_references(&[card]);
    assert!(
        refs.is_empty(),
        "actor=import 不得当作用户金标，实际 {} 条",
        refs.len()
    );
}

/// 覆盖 6：`has_critic_revision_marker` 与 provenance 两道闸任一命中即排除。
/// 同批四张卡：marker-only / provenance-only / 双命中 / user 对照，
/// 只有 user 对照可入选。
#[test]
fn marker_or_provenance_any_hit_excludes_only_tainted_cards() {
    let marker_only = card_from_json(
        "c-m",
        "什么是熵？",
        "系统混乱程度的度量",
        json!({
            ORIGINAL_GENERATION_FIELD:
                original_snapshot("什么是熵？答案是混乱度。", "混乱度"),
            QA_FLAGS_FIELD: critic_marker_flags(),
        }),
    );
    let provenance_only = card_from_json(
        "c-p",
        "什么是队列？",
        "先进先出的线性数据结构",
        json!({
            ORIGINAL_GENERATION_FIELD:
                original_snapshot("什么是队列？答案是先进先出。", "先进先出"),
            CONTENT_PROVENANCE_FIELD: provenance_value(ACTOR_LLM_CRITIC),
        }),
    );
    let both_hit = card_from_json(
        "c-b",
        "什么是哈希冲突？",
        "不同键映射到同一槽位的现象",
        json!({
            ORIGINAL_GENERATION_FIELD:
                original_snapshot("什么是哈希冲突？答案是键碰撞。", "键碰撞"),
            QA_FLAGS_FIELD: critic_marker_flags(),
            CONTENT_PROVENANCE_FIELD: provenance_value(ACTOR_LLM_CRITIC),
        }),
    );
    let user_control = card_from_json(
        "c-u",
        "什么是惯性？",
        "物体保持原有运动状态不变的性质",
        json!({
            ORIGINAL_GENERATION_FIELD:
                original_snapshot("什么是惯性？答案是保持运动状态。", "保持运动状态"),
            CONTENT_PROVENANCE_FIELD: provenance_value(ACTOR_USER),
        }),
    );

    let refs = mine_references(&[marker_only, provenance_only, both_hit, user_control]);
    assert_eq!(
        refs.len(),
        1,
        "四卡批次只有 user 对照可入选，实际 {} 条",
        refs.len()
    );
    assert_eq!(
        refs[0].front, "什么是惯性？",
        "入选的必须是 user 对照卡而非任何污染卡"
    );
}

// ============================================================================
// 标注层反例矩阵（classify_candidate / mine_gold_set / select）
// ============================================================================

/// 覆盖 1（标注层）：`critic_revised=true` 的候选不得拿到任何 `Edited*` 标签，
/// 不产 repair_pair；且经完整 mine → select 链后 0 对入选。
#[test]
fn classify_critic_revised_candidate_never_gets_edited_label() {
    let mut v = edited_candidate_json("cand-critic", None);
    v["critic_revised"] = json!(true);
    let candidate = candidate_from_json(v);

    let cfg = GoldMiningConfig::default();
    let sample = classify_candidate(&candidate, &cfg);
    assert_ne!(sample.label, GoldLabel::EditedMinor, "critic 自改不得 EditedMinor");
    assert_ne!(sample.label, GoldLabel::EditedMajor, "critic 自改不得 EditedMajor");
    assert_eq!(sample.label, GoldLabel::Unlabeled);
    assert!(sample.repair_pair.is_none(), "不得产出修正对");

    let samples = mine_gold_set(std::slice::from_ref(&candidate), &cfg);
    let picked = select_grounded_reference_pairs(&samples, &gold_lint_config(), 10);
    assert!(picked.is_empty(), "critic 修订候选经全链后必须 0 对入选");
}

/// 覆盖 4（标注层）：`edit_actor=user` 的小幅编辑 → `EditedMinor`
/// （若落地员最终采用其他标签名，第 8 轮据实调整断言——当前按既有
/// `GoldLabel::EditedMinor` 语义锁定），并携带修正对。
#[test]
fn classify_user_actor_minor_edit_is_edited_minor() {
    let candidate = candidate_from_json(edited_candidate_json("cand-user", Some(ACTOR_USER)));

    let sample = classify_candidate(&candidate, &GoldMiningConfig::default());
    assert_eq!(sample.label, GoldLabel::EditedMinor, "真用户小幅编辑不得被新闸门误伤");
    let pair = sample.repair_pair.expect("必须携带修正对");
    assert!(
        pair.distance_ratio > 0.0 && pair.distance_ratio < 0.25,
        "距离比 {} 应落在 EditedMinor 区间",
        pair.distance_ratio
    );
    assert_eq!(pair.edited.front, "什么是惯性？");
}

/// 覆盖 3（标注层，旧卡保守）：内容 ≠ original 但无任何编辑者证明
/// （无 `edit_actor`、无 marker）→ `Unlabeled`，不产修正对。
/// 注意：这是 r1-04 §5.2 闸门 2 的目标语义；落地前的现实现会给 EditedMinor
/// （即本测试落地前红），红转绿即闸门生效的证据。
#[test]
fn classify_content_diff_without_actor_proof_is_unlabeled() {
    let candidate = candidate_from_json(edited_candidate_json("cand-legacy", None));

    let sample = classify_candidate(&candidate, &GoldMiningConfig::default());
    assert_eq!(
        sample.label,
        GoldLabel::Unlabeled,
        "无编辑者证明的内容差异必须保守 Unlabeled，实际 {:?}（reason: {}）",
        sample.label,
        sample.reason
    );
    assert!(sample.repair_pair.is_none());
    assert!(!sample.reason.is_empty(), "Unlabeled 必须给出不入桶原因");
}

/// 覆盖 5（标注层）：`edit_actor=import` 不得拿到 `Edited*` 标签——
/// 导入合并不是用户修正。
#[test]
fn classify_import_actor_never_gets_edited_label() {
    let candidate = candidate_from_json(edited_candidate_json("cand-import", Some(ACTOR_IMPORT)));

    let cfg = GoldMiningConfig::default();
    let sample = classify_candidate(&candidate, &cfg);
    assert_ne!(sample.label, GoldLabel::EditedMinor, "import 不得 EditedMinor");
    assert_ne!(sample.label, GoldLabel::EditedMajor, "import 不得 EditedMajor");
    assert!(sample.repair_pair.is_none(), "import 候选不得产出修正对");

    let samples = mine_gold_set(std::slice::from_ref(&candidate), &cfg);
    let picked = select_grounded_reference_pairs(&samples, &gold_lint_config(), 10);
    assert!(picked.is_empty(), "import 候选经全链后必须 0 对入选");
}

// ============================================================================
// helper 层（has_critic_revision_marker 语义锁定）
// ============================================================================

/// 覆盖 6 补充：marker 判定只认结构化稳定 code——
/// `message` 字段里出现同名字符串、非法 JSON、非数组形状均不算命中；
/// 结构化 `code=llm_critic_revised` 必须命中。
#[test]
fn marker_helper_hits_only_structured_stable_code() {
    use std::collections::HashMap;

    let hit: HashMap<String, String> = HashMap::from([(
        QA_FLAGS_FIELD.to_string(),
        critic_marker_flags(),
    )]);
    assert!(has_critic_revision_marker(&hit), "结构化 code 必须命中");

    let message_only: HashMap<String, String> = HashMap::from([(
        QA_FLAGS_FIELD.to_string(),
        json!([{ "message": CRITIC_REVISED_QA_CODE }]).to_string(),
    )]);
    assert!(
        !has_critic_revision_marker(&message_only),
        "message 字段里的同名字符串不算命中"
    );

    let not_json: HashMap<String, String> =
        HashMap::from([(QA_FLAGS_FIELD.to_string(), "not-json".to_string())]);
    assert!(!has_critic_revision_marker(&not_json), "非法 JSON 保守不命中");

    let not_array: HashMap<String, String> = HashMap::from([(
        QA_FLAGS_FIELD.to_string(),
        json!({ "code": CRITIC_REVISED_QA_CODE }).to_string(),
    )]);
    assert!(!has_critic_revision_marker(&not_array), "非数组形状保守不命中");

    assert!(
        !has_critic_revision_marker(&HashMap::new()),
        "无 _qa_flags 不命中（marker 缺失场景交由 provenance 闸门兜底）"
    );
}
