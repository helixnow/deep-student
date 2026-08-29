//! Anki AI-native Round 2–3 新模块跨模块集成/回归测试（Round 4 #6）。
//!
//! 覆盖面（对齐 docs/research/anki-ai-native/round4/06-integration-tests.md）：
//! 1. `chatanki_transform` ops 模式 dry_run/apply 契约（wire 解析 → 选择集 →
//!    编译 → 逐卡计划 → CAS expectedVersions 校验的全链路）；
//! 2. `chatanki_transform` script 模式 I/O 合同校验（不依赖解释器/沙箱：
//!    输入快照 → 输出合同 → 无解释器结构化拒绝路径）；
//! 3. plan_route LLM 响应解析 + 路由优先级链 + `chatanki_analyze` 输出契约
//!    （routing.routeSource 与管线同源）；
//! 4. retemplate fill_missing_llm 策略 wire 解析；
//! 5. `anki_qa_lint` 12 规则抽样 + `merge_flags` 幂等合并；
//! 6. `anki_preference_memory` 检索 token 预算装箱；
//! 7. `anki_fsrs_feedback` suggest_splits 与画像/干扰纯函数链；
//! 8. `anki_protocol` 能力探测 / schema 生成 / repair_json / wrapper 流式剥离；
//! 9. eval fixture 基线仍绿（manifest 与生产常量/清单一致性）。
//!
//! 全部测试只依赖 `deep_student_lib` 的公开 API 与 `tests/fixtures/anki-eval`
//! 夹具，不触达数据库与网络（FSRS 的 DB 路径已由 anki_fsrs_feedback.rs 覆盖）。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde_json::{json, Value};

use deep_student_lib::anki_fsrs_feedback::{
    build_interference_hints, build_profile, render_interference_section, render_profile_section,
    suggest_splits, FsrsFeedbackConfig,
};
use deep_student_lib::anki_preference_memory::{
    consolidate, estimate_tokens, extract_preferences, retrieve_preference_prompt, PreferenceStore,
    SessionObservation,
};
use deep_student_lib::anki_protocol::{
    build_cards_response_schema, detect_schema_capability, repair_json, repair_json_detailed,
    resolve_output_protocol, strip_wrapper_prefix, unwrap_cards_array, OutputProtocol,
    SchemaCapability, CARDS_WRAPPER_KEY, CARD_DELIMITER, TEMPLATE_ID_KEY,
};
use deep_student_lib::anki_qa_lint::{
    lint_card, lint_card_with_tracker, merge_flags, should_reject, CardLintInput,
    FingerprintTracker, LintConfig, LintLevel, LintSeverity, QA_FLAGS_FIELD,
};
use deep_student_lib::chat_v2::tools::chatanki_executor::{
    build_analyze_output, parse_route_plan_response, resolve_route_decision,
    ChatAnkiRetemplateStrategy, ChatAnkiRoute, RouteDecision, RoutePlan, RouteSource,
};
use deep_student_lib::chat_v2::tools::chatanki_transform::{
    apply_transform_ops, changed_field_names, check_expected_versions, compile_transform_ops,
    plan_transform_ops, select_transform_cards, transform_fields_are_valid, ChatAnkiTransformArgs,
    NormalizedTransformKind, NormalizedTransformOp, NormalizedTransformSelection,
    TransformCardPlan, TransformFields, TransformMode, TransformSelectionError,
};
use deep_student_lib::chat_v2::tools::chatanki_transform_script::{
    build_script_input, evaluate_script_output, resolve_interpreter_in_dirs,
    text_has_valid_cloze_markup, transform_sandbox_policy, ScriptOutputError,
};
use deep_student_lib::fsrs_review_service::FsrsFeedbackRow;
use deep_student_lib::models::AnkiCard;
use deep_student_lib::vfs::types::{VfsContextRefData, VfsResourceRef, VfsResourceType};

// ============================================================================
// 共享测试构造器
// ============================================================================

fn make_card(id: &str, front: &str, back: &str, text: Option<&str>, tags: &[&str]) -> AnkiCard {
    AnkiCard {
        front: front.to_string(),
        back: back.to_string(),
        text: text.map(str::to_string),
        tags: tags.iter().map(|t| t.to_string()).collect(),
        images: vec![],
        id: id.to_string(),
        task_id: "task-r4".to_string(),
        is_error_card: false,
        error_content: None,
        created_at: "2026-08-24T00:00:00Z".to_string(),
        updated_at: "2026-08-24T01:00:00Z".to_string(),
        extra_fields: Default::default(),
        template_id: None,
    }
}

fn make_ref(name: &str, resource_type: VfsResourceType) -> VfsResourceRef {
    VfsResourceRef {
        source_id: format!("src-{name}"),
        resource_hash: "hash".to_string(),
        resource_type,
        name: name.to_string(),
        resource_id: None,
        snippet: None,
        inject_modes: None,
    }
}

fn ref_data(files: usize, images: usize) -> VfsContextRefData {
    let mut refs = Vec::new();
    for i in 0..files {
        refs.push(make_ref(&format!("file-{i}"), VfsResourceType::File));
    }
    for i in 0..images {
        refs.push(make_ref(&format!("img-{i}"), VfsResourceType::Image));
    }
    VfsContextRefData {
        total_count: refs.len(),
        refs,
        truncated: false,
    }
}

fn parse_transform(
    args: Value,
) -> Result<deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformRequest, String>
{
    serde_json::from_value::<ChatAnkiTransformArgs>(args)
        .map_err(|e| e.to_string())
        .and_then(ChatAnkiTransformArgs::normalize)
}

fn make_row(
    id: &str,
    front: &str,
    lapses: i32,
    tags: &[&str],
    template: Option<&str>,
) -> FsrsFeedbackRow {
    FsrsFeedbackRow {
        anki_card_id: id.to_string(),
        front: front.to_string(),
        template_id: template.map(str::to_string),
        tags: tags.iter().map(|t| t.to_string()).collect(),
        state: 2,
        stability: Some(3.0),
        lapses,
        reps: lapses + 2,
        due_ms: 0,
        last_review_ms: Some(1_000),
    }
}

// ============================================================================
// 1. transform ops：dry_run / apply 契约（wire → 引擎 → CAS 全链路）
// ============================================================================

/// dry_run 全链路：wire JSON → normalize → 选择集 → 编译 → 逐卡计划 → 字段 diff。
#[test]
fn transform_ops_dry_run_end_to_end_produces_per_card_plans() {
    let request = parse_transform(json!({
        "documentId": "doc-r4",
        "transform": { "ops": [
            { "op": "regex_replace", "field": "back", "pattern": r"(\d+)ms", "replacement": "$1 毫秒" },
            { "op": "tag_add", "tags": ["性能"] },
        ]},
    }))
    .expect("dry_run request should normalize");
    assert_eq!(request.mode, TransformMode::DryRun);
    assert!(
        request.expected_versions.is_empty(),
        "dry_run 忽略 expectedVersions"
    );

    let cards = vec![
        make_card("card-1", "RTT 是什么？", "往返约 30ms", None, &[]),
        make_card("card-2", "无数字卡", "纯文本答案", None, &["性能"]),
    ];
    let selected =
        select_transform_cards(cards, &request.selection).expect("default live selection");
    assert_eq!(selected.len(), 2);

    let NormalizedTransformKind::Ops(ops) = &request.kind else {
        panic!("expected ops kind");
    };
    let compiled = compile_transform_ops(ops).expect("both patterns compile");
    let plans = plan_transform_ops(&compiled, &selected);
    assert_eq!(plans.len(), 2, "计划与选择集等长同序");

    let TransformCardPlan::After(after_1) = &plans[0] else {
        panic!("ops 模式永远产出 After 计划");
    };
    assert_eq!(after_1.back, "往返约 30 毫秒");
    assert_eq!(after_1.tags, vec!["性能".to_string()]);
    assert_eq!(
        changed_field_names(&TransformFields::from_card(&selected[0]), after_1),
        vec!["back", "tags"]
    );

    // 第二张卡 regex 不命中、tag 已存在 → 无变更（幂等）
    let TransformCardPlan::After(after_2) = &plans[1] else {
        panic!("ops 模式永远产出 After 计划");
    };
    assert_eq!(after_2, &TransformFields::from_card(&selected[1]));
    assert!(changed_field_names(&TransformFields::from_card(&selected[1]), after_2).is_empty());
}

/// apply 契约：expectedVersions 必填、必须与选择集精确一致（缺失/多余都拒绝）。
#[test]
fn transform_ops_apply_enforces_expected_versions_cas_contract() {
    // 缺 expectedVersions → normalize 即拒绝
    let error = parse_transform(json!({
        "documentId": "doc-r4",
        "mode": "apply",
        "transform": { "ops": [{ "op": "tag_add", "tags": ["x"] }] },
    }))
    .unwrap_err();
    assert!(error.contains("requires expectedVersions"), "{error}");

    // 携带完整映射 → normalize 通过，且与选择集精确一致才放行
    let request = parse_transform(json!({
        "documentId": "doc-r4",
        "mode": "apply",
        "selection": { "cardIds": ["card-1", "card-2"] },
        "expectedVersions": { "card-1": "v1", "card-2": "v2" },
        "transform": { "ops": [{ "op": "tag_add", "tags": ["复习"] }] },
    }))
    .expect("apply request should normalize");
    assert_eq!(request.mode, TransformMode::Apply);

    let selected_ids = vec!["card-1".to_string(), "card-2".to_string()];
    assert!(check_expected_versions(&selected_ids, &request.expected_versions).is_ok());

    // 双保险：映射多一张 / 少一张都必须结构化报告
    let mut skewed = request.expected_versions.clone();
    skewed.remove("card-2");
    skewed.insert("card-ghost".to_string(), "v9".to_string());
    let mismatch = check_expected_versions(&selected_ids, &skewed).unwrap_err();
    assert_eq!(mismatch.missing_version_ids, vec!["card-2".to_string()]);
    assert_eq!(
        mismatch.unexpected_version_ids,
        vec!["card-ghost".to_string()]
    );
}

/// 选择集语义：cardIds 命中缺失 ID 与 filter=error_only 的行为与 get_cards 对齐。
#[test]
fn transform_selection_reports_missing_ids_and_honours_filters() {
    let mut error_card = make_card("card-err", "损坏", "损坏", None, &[]);
    error_card.is_error_card = true;
    let cards = vec![make_card("card-1", "Q", "A", None, &[]), error_card];

    let missing = select_transform_cards(
        cards.clone(),
        &NormalizedTransformSelection::Cards(vec!["card-1".into(), "card-ghost".into()]),
    )
    .unwrap_err();
    assert_eq!(
        missing,
        TransformSelectionError::MissingCards(vec!["card-ghost".to_string()])
    );

    let request = parse_transform(json!({
        "documentId": "doc-r4",
        "selection": { "filter": "error_only" },
        "transform": { "ops": [{ "op": "tag_add", "tags": ["诊断"] }] },
    }))
    .unwrap();
    let errors_only = select_transform_cards(cards, &request.selection).unwrap();
    assert_eq!(errors_only.len(), 1);
    assert_eq!(errors_only[0].id, "card-err");
}

/// 非法 pattern：编译期整批拒绝并带 op 下标（不产生任何计划，不写库）。
#[test]
fn transform_ops_invalid_pattern_rejects_whole_batch_with_index() {
    let ops = vec![
        NormalizedTransformOp::TagAdd {
            tags: vec!["ok".to_string()],
        },
        NormalizedTransformOp::RegexReplace {
            field: deep_student_lib::chat_v2::tools::chatanki_transform::TransformField::Front,
            pattern: "(unclosed".to_string(),
            replacement: String::new(),
        },
    ];
    let error = compile_transform_ops(&ops).unwrap_err();
    assert_eq!(error.op_index, 1);
    assert_eq!(error.pattern, "(unclosed");
    assert!(!error.error.is_empty());
}

/// 变换后卡片有效性守卫与 apply 写库前的 card_content_is_valid 同语义。
#[test]
fn transform_validity_guard_matches_card_content_semantics() {
    let ops = vec![NormalizedTransformOp::RegexReplace {
        field: deep_student_lib::chat_v2::tools::chatanki_transform::TransformField::Back,
        pattern: ".+".to_string(),
        replacement: String::new(),
    }];
    let compiled = compile_transform_ops(&ops).unwrap();
    let before = TransformFields::from_card(&make_card("card-1", "Q", "A", None, &[]));
    let after =
        apply_transform_ops(&compiled, &before).expect("shrinking back must stay in bounds");
    assert_eq!(after.back, "");
    assert!(transform_fields_are_valid(&before));
    assert!(
        !transform_fields_are_valid(&after),
        "清空 back 的普通卡必须被拒绝"
    );

    // Cloze 卡（text 非空）允许 front/back 为空
    let cloze = TransformFields {
        front: String::new(),
        back: String::new(),
        text: Some("{{c1::挖空}}".to_string()),
        tags: vec![],
    };
    assert!(transform_fields_are_valid(&cloze));
}

// ============================================================================
// 2. transform script：I/O 合同校验（无解释器/无沙箱路径）
// ============================================================================

/// 输入快照合同：全文无截断导出 + version 取自 Rust 记录的 updated_at；
/// 脚本整对象回显（含篡改的 version）时输出评估必须无变更且忽略 version。
#[test]
fn script_io_contract_roundtrip_ignores_script_version() {
    let long_front = "边".repeat(4096);
    let cards = [make_card("card-1", &long_front, "答案", None, &["旧标签"])];
    let input = build_script_input("doc-r4", &cards);
    assert_eq!(input["documentId"], "doc-r4");
    let entry = &input["cards"][0];
    assert_eq!(
        entry["front"].as_str().unwrap().chars().count(),
        4096,
        "无 2000 字符截断视图"
    );
    assert_eq!(entry["version"], "2026-08-24T01:00:00Z");

    // 模拟脚本把输入原样回写，但篡改 version
    let mut echoed = entry.clone();
    echoed["version"] = json!("1999-01-01T00:00:00Z");
    let raw = serde_json::to_vec(&json!({ "cards": [echoed] })).unwrap();
    let evaluation = evaluate_script_output(&raw, &cards).expect("echo output is valid");
    assert!(evaluation.unknown_card_ids.is_empty());
    let plan = evaluation.card_plans[0]
        .as_ref()
        .expect("echo must be accepted");
    assert_eq!(
        plan,
        &TransformFields::from_card(&cards[0]),
        "回显 = 无变更"
    );
}

/// 输出合同 fail-closed：顶层 schema 违约整批拒绝；单卡违约逐卡拒绝不连坐；
/// v1 禁止脚本增删卡（unknown_card_ids 逐项报告）。
#[test]
fn script_output_contract_fails_closed_per_card_and_reports_unknown_ids() {
    let cards = [
        make_card("card-1", "Q1", "A1", Some("{{c1::旧}}"), &[]),
        make_card("card-2", "Q2", "A2", None, &[]),
    ];

    // 顶层违约：cards 缺失 → 整批 Schema 错误
    let error = evaluate_script_output(br#"{"stats": 1}"#, &cards).unwrap_err();
    assert!(matches!(error, ScriptOutputError::Schema(_)), "{error:?}");

    // 逐卡违约：card-1 改 text 但无合法 cloze → invalid_cloze_text；
    // card-2 携带未知键 → unknown_output_field；幽灵卡 → unknown_card_ids
    let raw = serde_json::to_vec(&json!({
        "cards": [
            { "id": "card-1", "text": "去掉了挖空标记" },
            { "id": "card-2", "front": "更新", "isErrorCard": false },
            { "id": "card-ghost", "front": "脚本试图新增" },
        ],
    }))
    .unwrap();
    let evaluation = evaluate_script_output(&raw, &cards).unwrap();
    assert_eq!(evaluation.unknown_card_ids, vec!["card-ghost".to_string()]);
    assert_eq!(
        evaluation.card_plans.len(),
        2,
        "计划与快照等长，幽灵卡不进计划"
    );
    assert_eq!(
        evaluation.card_plans[0].as_ref().unwrap_err().code,
        "invalid_cloze_text"
    );
    assert_eq!(
        evaluation.card_plans[1].as_ref().unwrap_err().code,
        "unknown_output_field"
    );
}

/// 无解释器路径：空目录集解析不到解释器（结构化 interpreter_unavailable 的前置条件），
/// 且 cloze 校验器与 database 侧语义锁定一致。
#[test]
fn script_interpreter_probe_returns_none_without_interpreter() {
    let empty_dir = tempfile::tempdir().unwrap();
    assert!(
        resolve_interpreter_in_dirs(
            &["python3", "python", "node"],
            &[empty_dir.path().to_path_buf()]
        )
        .is_none(),
        "空目录集必须解析不到解释器（触发 interpreter_unavailable 结构化拒绝）"
    );

    // cloze 语义锁定（与 database::contains_valid_anki_cloze_markup 同规则）
    assert!(text_has_valid_cloze_markup("{{c1::答案}}"));
    assert!(text_has_valid_cloze_markup("{{c12::答案::提示}}"));
    assert!(!text_has_valid_cloze_markup("{{c0::zero}}"));
    assert!(!text_has_valid_cloze_markup("{{c1::}}"));
    assert!(!text_has_valid_cloze_markup("没有挖空"));
}

/// 沙箱策略合同：网络恒禁、只有 job 目录可写（不实际执行沙箱）。
#[test]
fn script_sandbox_policy_never_allows_network_and_scopes_writes_to_job_dir() {
    let temp = tempfile::tempdir().unwrap();
    let job_dir = temp.path().join("job");
    std::fs::create_dir_all(&job_dir).unwrap();
    let policy = transform_sandbox_policy(&job_dir, std::path::Path::new("/usr/bin/python3"));
    assert!(!policy.allow_network, "script 模式网络恒禁（无豁免参数）");
    assert_eq!(policy.writable_roots, vec![job_dir.clone()]);
    assert!(policy.readable_roots.contains(&job_dir));
}

// ============================================================================
// 3. plan_route JSON 解析 + analyze 输出 routeSource 同源契约
// ============================================================================

/// plan_route 响应解析：容错 ```json 围栏与前后说明文字；
/// 非法 route / confidence 越界 / 非 JSON 一律 None（保守回退启发式）。
#[test]
fn plan_route_response_parsing_is_tolerant_but_conservative() {
    let plan = parse_route_plan_response(
        "```json\n{\"route\":\"vlm_full\",\"confidence\":0.92,\"glossaryMode\":true,\"reason\":\"扫描件\"}\n```",
    )
    .expect("fenced JSON should parse");
    assert_eq!(plan.route, ChatAnkiRoute::VlmFull);
    assert!(plan.is_confident());
    assert_eq!(plan.glossary_mode, Some(true));
    assert_eq!(plan.reason.as_deref(), Some("扫描件"));

    let with_prose = parse_route_plan_response(
        "好的，我的判断如下 {\"route\":\"simple_text\",\"confidence\":0.4} 供参考",
    )
    .expect("embedded JSON should parse");
    assert_eq!(with_prose.route, ChatAnkiRoute::SimpleText);
    assert!(!with_prose.is_confident(), "0.4 < 0.7 视为不确定");

    assert!(parse_route_plan_response("{\"route\":\"teleport\",\"confidence\":0.9}").is_none());
    assert!(parse_route_plan_response("{\"route\":\"vlm_full\",\"confidence\":1.5}").is_none());
    assert!(
        parse_route_plan_response("{\"route\":\"vlm_full\"}").is_none(),
        "缺 confidence"
    );
    assert!(parse_route_plan_response("完全不是 JSON").is_none());
}

/// 路由优先级链：forced > 高置信度 LLM 计划 > 启发式（低置信度回退）。
#[test]
fn route_decision_priority_chain_is_forced_then_llm_then_heuristic() {
    let rd = ref_data(1, 0); // 启发式应得 simple_text

    let forced = resolve_route_decision(Some(ChatAnkiRoute::VlmFull), None, &rd);
    assert_eq!(forced.source, RouteSource::Forced);
    assert_eq!(forced.route, ChatAnkiRoute::VlmFull);
    assert_eq!(forced.source.as_str(), "forced");

    let confident = RoutePlan {
        route: ChatAnkiRoute::VlmLight,
        confidence: 0.9,
        glossary_mode: Some(false),
        reason: Some("文本可读但有图".to_string()),
    };
    let llm = resolve_route_decision(None, Some(&confident), &rd);
    assert_eq!(llm.source, RouteSource::Llm);
    assert_eq!(llm.route, ChatAnkiRoute::VlmLight);
    assert_eq!(llm.confidence, Some(0.9));

    let hesitant = RoutePlan {
        confidence: 0.3,
        ..confident.clone()
    };
    let fallback = resolve_route_decision(None, Some(&hesitant), &rd);
    assert_eq!(
        fallback.source,
        RouteSource::Heuristic,
        "低置信度必须回退启发式"
    );
    assert_eq!(fallback.route, ChatAnkiRoute::SimpleText);
    assert!(fallback.confidence.is_none());

    // forced 永远压过高置信度 LLM 计划
    let forced_wins =
        resolve_route_decision(Some(ChatAnkiRoute::SimpleText), Some(&confident), &rd);
    assert_eq!(forced_wins.source, RouteSource::Forced);
    assert_eq!(forced_wins.route, ChatAnkiRoute::SimpleText);
}

/// analyze 输出契约：routing.routeSource ∈ {forced,llm,heuristic}，
/// recommended.route 与 routing.route 同源，maxCards 在 1..=100。
#[test]
fn analyze_output_carries_route_source_and_bounded_recommendations() {
    let rd = ref_data(0, 5); // 图片为主 → 启发式 vlm_full
    for (decision, expected_source) in [
        (
            resolve_route_decision(Some(ChatAnkiRoute::SimpleText), None, &rd),
            "forced",
        ),
        (
            resolve_route_decision(
                None,
                Some(&RoutePlan {
                    route: ChatAnkiRoute::VlmFull,
                    confidence: 0.95,
                    glossary_mode: None,
                    reason: None,
                }),
                &rd,
            ),
            "llm",
        ),
        (resolve_route_decision(None, None, &rd), "heuristic"),
    ] {
        let output = build_analyze_output(
            Some("备考"),
            "术语A：定义A\n术语B：定义B\n术语C：定义C",
            Some(&rd),
            &decision,
            &[],
        );
        assert_eq!(output["status"], "ok");
        assert_eq!(output["routing"]["routeSource"], json!(expected_source));
        assert_eq!(
            output["routing"]["route"], output["recommended"]["route"],
            "推荐路由必须与路由决策同源"
        );
        let max_cards = output["recommended"]["maxCards"].as_i64().unwrap();
        assert!((1..=100).contains(&max_cards), "maxCards={max_cards}");
        assert_eq!(output["metrics"]["refImages"], json!(5));
        assert!(
            output.get("warnings").is_none(),
            "无告警时不输出 warnings 键"
        );
    }
}

/// analyze 降级路径：引用解析失败的 warnings 必须透传到输出。
#[test]
fn analyze_output_propagates_degradation_warnings() {
    let rd = ref_data(1, 0);
    let decision: RouteDecision = resolve_route_decision(None, None, &rd);
    assert_eq!(decision.source, RouteSource::Heuristic);
    let warnings = vec![json!({
        "code": "analyze_refs_unresolved",
        "unresolvedIds": ["res_ghost"],
    })];
    let output = build_analyze_output(None, "内容", Some(&rd), &decision, &warnings);
    assert_eq!(
        output["warnings"][0]["code"],
        json!("analyze_refs_unresolved")
    );
    assert_eq!(
        output["routing"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("启发式"),
        true,
        "启发式决策必须自带一句话理由"
    );
}

// ============================================================================
// 4. retemplate fill_missing_llm 策略解析
// ============================================================================

/// 策略 wire 解析：三个合法值 + as_str 回环；未知值必须被 serde 拒绝。
#[test]
fn retemplate_strategy_parses_fill_missing_llm_and_rejects_unknown() {
    for (wire, expected) in [
        ("map_only", ChatAnkiRetemplateStrategy::MapOnly),
        ("fill_missing", ChatAnkiRetemplateStrategy::FillMissing),
        (
            "fill_missing_llm",
            ChatAnkiRetemplateStrategy::FillMissingLlm,
        ),
    ] {
        let parsed: ChatAnkiRetemplateStrategy = serde_json::from_value(json!(wire)).expect(wire);
        assert_eq!(parsed, expected);
        assert_eq!(parsed.as_str(), wire, "as_str 与 wire 形态必须回环一致");
    }
    assert!(
        serde_json::from_value::<ChatAnkiRetemplateStrategy>(json!("fill_all_llm")).is_err(),
        "未知策略必须被拒绝"
    );
}

// ============================================================================
// 5. qa_lint：12 规则抽样 + merge_flags
// ============================================================================

/// 规则抽样（Error 级）：front==back、空字段、cloze 破损、占位符残留、MCQ 结构。
#[test]
fn qa_lint_error_rules_sample_hits_expected_codes() {
    let cfg = LintConfig::default();
    let no_extra: HashMap<String, String> = HashMap::new();

    let codes = |input: &CardLintInput| -> HashSet<String> {
        lint_card(input, &cfg).into_iter().map(|i| i.code).collect()
    };

    // 1: front == back（归一化后）
    let identical = codes(&CardLintInput {
        front: "<b>什么是 TCP</b>",
        back: "什么是TCP？",
        text: None,
        tags: &["网络".to_string()],
        extra_fields: &no_extra,
    });
    assert!(identical.contains("front_back_identical"), "{identical:?}");

    // 2: 空字段
    let empty = codes(&CardLintInput {
        front: "   ",
        back: "",
        text: None,
        tags: &[],
        extra_fields: &no_extra,
    });
    assert!(
        empty.contains("empty_front") && empty.contains("empty_back"),
        "{empty:?}"
    );

    // 3: cloze 空挖空 + 非法序号
    let cloze = codes(&CardLintInput {
        front: "Q",
        back: "A",
        text: Some("{{c1::}} 与 {{c0::零}}"),
        tags: &["生物".to_string()],
        extra_fields: &no_extra,
    });
    assert!(
        cloze.contains("cloze_empty_answer") && cloze.contains("cloze_bad_index"),
        "{cloze:?}"
    );

    // 7: 模板占位符残留
    let placeholder = codes(&CardLintInput {
        front: "请解释 {{DOCUMENT_CONTENT}}",
        back: "……",
        text: None,
        tags: &["占位".to_string()],
        extra_fields: &no_extra,
    });
    assert!(
        placeholder.contains("placeholder_residue"),
        "{placeholder:?}"
    );

    // 11: MCQ 答案不在选项中
    let mcq_fields: HashMap<String, String> = [
        ("optionA".to_string(), "水".to_string()),
        ("optionB".to_string(), "火".to_string()),
        ("correct".to_string(), "C".to_string()),
    ]
    .into_iter()
    .collect();
    let mcq = codes(&CardLintInput {
        front: "下列哪项正确？",
        back: "C",
        text: None,
        tags: &["选择题".to_string()],
        extra_fields: &mcq_fields,
    });
    assert!(mcq.contains("mcq_answer_not_in_options"), "{mcq:?}");
}

/// 规则抽样（Warn/Info 级）：答案泄露、双概念、front 过长、tags 空、语言混杂。
#[test]
fn qa_lint_warn_info_rules_sample_hits_expected_codes_and_severities() {
    let cfg = LintConfig::default();
    let no_extra: HashMap<String, String> = HashMap::new();

    let issues = lint_card(
        &CardLintInput {
            front: "细胞膜的主要成分是磷脂双分子层吗？为什么它具有流动性？",
            back: "磷脂双分子层",
            text: None,
            tags: &[],
            extra_fields: &no_extra,
        },
        &cfg,
    );
    let by_code: HashMap<&str, LintSeverity> = issues
        .iter()
        .map(|i| (i.code.as_str(), i.severity))
        .collect();
    assert_eq!(
        by_code.get("answer_leak"),
        Some(&LintSeverity::Warn),
        "{by_code:?}"
    );
    assert_eq!(by_code.get("multi_concept"), Some(&LintSeverity::Warn));
    assert_eq!(by_code.get("tags_empty"), Some(&LintSeverity::Info));

    // 6: front 超长（阈值可配置）
    let tight_cfg = LintConfig {
        max_front_chars: 10,
        ..LintConfig::default()
    };
    let long = lint_card(
        &CardLintInput {
            front: "这是一个超过十个字符的超长正面问题文本",
            back: "短答案",
            text: None,
            tags: &["长度".to_string()],
            extra_fields: &no_extra,
        },
        &tight_cfg,
    );
    assert!(long
        .iter()
        .any(|i| i.code == "front_too_long" && i.severity == LintSeverity::Warn));

    // 12: 语言混杂只能是 Info（永不拒绝）
    let mixed = lint_card(
        &CardLintInput {
            front: "什么是 photosynthesis biological process mechanism overview 的核心步骤与调控因素说明？",
            back: "光反应与暗反应两个阶段",
            text: None,
            tags: &["生物".to_string()],
            extra_fields: &no_extra,
        },
        &cfg,
    );
    for issue in mixed.iter().filter(|i| i.code == "mixed_language") {
        assert_eq!(issue.severity, LintSeverity::Info);
    }
}

/// 规则 9 + 拒绝决策：文档级重复经 tracker 检出；
/// Flag 级永不拒绝，Reject 级只对 Error 拒绝。
#[test]
fn qa_lint_duplicate_tracking_and_reject_semantics() {
    let cfg = LintConfig::default();
    let no_extra: HashMap<String, String> = HashMap::new();
    let mut tracker = FingerprintTracker::new();

    let first = lint_card_with_tracker(
        &CardLintInput {
            front: "什么是TCP？",
            back: "传输控制协议",
            text: None,
            tags: &["网络".to_string()],
            extra_fields: &no_extra,
        },
        &cfg,
        &mut tracker,
    );
    assert!(!first.iter().any(|i| i.code == "duplicate_card"));

    let second = lint_card_with_tracker(
        &CardLintInput {
            front: "<b>什么是 tcp</b>",
            back: "一种传输层协议",
            text: None,
            tags: &["网络".to_string()],
            extra_fields: &no_extra,
        },
        &cfg,
        &mut tracker,
    );
    assert!(
        second.iter().any(|i| i.code == "duplicate_in_document"),
        "HTML/大小写/空白差异不影响指纹: {second:?}"
    );

    // Flag（默认）永不拒绝，即便存在 Error 级违规
    let error_issues = lint_card(
        &CardLintInput {
            front: "",
            back: "",
            text: None,
            tags: &[],
            extra_fields: &no_extra,
        },
        &cfg,
    );
    assert!(error_issues
        .iter()
        .any(|i| i.severity == LintSeverity::Error));
    assert!(!should_reject(&error_issues, &cfg), "Flag 级永不拒绝");
    let reject_cfg = LintConfig {
        level: LintLevel::Reject,
        ..LintConfig::default()
    };
    assert!(should_reject(&error_issues, &reject_cfg));
    assert!(
        !should_reject(&second, &reject_cfg),
        "Warn/Info 永不触发拒绝"
    );
}

/// merge_flags：保留既有字段规则条目、(code, field) 去重、重复调用幂等、
/// 干净卡不写键。
#[test]
fn qa_lint_merge_flags_is_idempotent_and_preserves_legacy_entries() {
    let cfg = LintConfig::default();
    let no_extra: HashMap<String, String> = HashMap::new();
    let issues = lint_card(
        &CardLintInput {
            front: "TODO 补充问题",
            back: "答案",
            text: None,
            tags: &["草稿".to_string()],
            extra_fields: &no_extra,
        },
        &cfg,
    );
    assert!(issues.iter().any(|i| i.code == "todo_residue"));

    // 既有 _qa_flags（字段规则校验写入的 {field, rule, message} 条目）必须保留
    let mut extra: HashMap<String, String> = HashMap::new();
    extra.insert(
        QA_FLAGS_FIELD.to_string(),
        r#"[{"field":"front","rule":"min_length","message":"过短"}]"#.to_string(),
    );
    merge_flags(&mut extra, &issues);
    let merged: Vec<Value> = serde_json::from_str(&extra[QA_FLAGS_FIELD]).unwrap();
    assert!(
        merged
            .iter()
            .any(|v| v.get("rule") == Some(&json!("min_length"))),
        "既有条目保留"
    );
    assert!(merged
        .iter()
        .any(|v| v.get("code") == Some(&json!("todo_residue"))));

    // 幂等：重复 merge 不产生重复条目
    let before = extra[QA_FLAGS_FIELD].clone();
    merge_flags(&mut extra, &issues);
    let after: Vec<Value> = serde_json::from_str(&extra[QA_FLAGS_FIELD]).unwrap();
    assert_eq!(
        serde_json::from_str::<Vec<Value>>(&before).unwrap().len(),
        after.len()
    );

    // 干净卡：无违规且原本无键 → 不写键（不污染）
    let mut clean: HashMap<String, String> = HashMap::new();
    merge_flags(&mut clean, &[]);
    assert!(!clean.contains_key(QA_FLAGS_FIELD));
}

// ============================================================================
// 6. preference memory：检索 token 预算
// ============================================================================

/// 抽取 → 巩固 → 检索全链路：token 预算装箱（超预算整行丢弃、
/// 预算为零返回空串、每 kind 最多一条）。
#[test]
fn preference_retrieve_respects_token_budget_end_to_end() {
    let mut store = PreferenceStore::default();
    let observation = SessionObservation {
        extra_requirements: Some("请用中文回答，卡片不要超过 20 张，别翻译专业术语".to_string()),
        template_used: Some("学术填空题".to_string()),
        generated_count: 10,
        ..Default::default()
    };
    let candidates = extract_preferences(&observation);
    assert!(
        candidates.len() >= 2,
        "显式要求应抽出多类偏好: {candidates:?}"
    );
    let outcome = consolidate(&mut store, &candidates, 1_000);
    assert!(!outcome.added.is_empty());

    let templates = vec!["学术填空题".to_string()];

    // 充足预算：header + 至少一行偏好
    let full = retrieve_preference_prompt(&store, "备考生物", &templates, 400);
    assert!(full.contains("【用户制卡偏好】"), "{full}");
    assert!(full.lines().count() >= 2);
    assert!(estimate_tokens(&full) <= 400, "装箱结果必须在预算内");

    // 预算刚好放不下任何一行 → 空串（半行也不注入）
    let zero = retrieve_preference_prompt(&store, "备考生物", &templates, 0);
    assert!(zero.is_empty());
    let tiny = retrieve_preference_prompt(&store, "备考生物", &templates, 1);
    assert!(
        tiny.is_empty(),
        "连 header 都放不下时必须返回空串: {tiny:?}"
    );

    // 每 kind 最多一条：同 kind 注入行数不超过 kind 数
    let lines = full.lines().skip(1).count();
    assert!(lines <= 4, "每类偏好最多一条（共 4 类）: {full}");
}

/// 模板偏好过滤：目标模板不在可用清单时跳过（不注入无效指令），
/// 模糊名称匹配（双向包含）仍能命中。
#[test]
fn preference_template_filtering_matches_available_templates() {
    let mut store = PreferenceStore::default();
    let observation = SessionObservation {
        template_used: Some("填空".to_string()),
        ..Default::default()
    };
    consolidate(&mut store, &extract_preferences(&observation), 1_000);
    assert!(!store.entries.is_empty());

    let hit = retrieve_preference_prompt(&store, "复习", &["学术填空题".to_string()], 200);
    assert!(hit.contains("填空"), "双向包含匹配应命中: {hit}");

    let miss = retrieve_preference_prompt(&store, "复习", &["选择题".to_string()], 200);
    assert!(miss.is_empty(), "模板不可用时不得注入: {miss}");
}

// ============================================================================
// 7. fsrs feedback：suggest_splits + 画像/干扰纯函数链
// ============================================================================

/// suggest_splits 三种启发式：枚举列表逐点拆、对比问句拆两卡、原子卡不拆。
#[test]
fn fsrs_suggest_splits_heuristics_cover_enumerated_comparison_and_atomic() {
    let enumerated = suggest_splits(
        "细胞呼吸的三个阶段？",
        "1. 糖酵解\n2. 柠檬酸循环\n3. 氧化磷酸化",
        10,
    );
    assert_eq!(enumerated.len(), 3);
    assert!(enumerated[0].front.contains("要点 1/3"));
    assert_eq!(enumerated[1].back, "柠檬酸循环");

    // max_suggestions 截断
    assert_eq!(
        suggest_splits("酶的特性？", "高效性；专一性；作用条件温和", 2).len(),
        2
    );

    let comparison = suggest_splits("有丝分裂与减数分裂的区别？", "染色体行为不同等", 10);
    assert_eq!(comparison.len(), 2);
    assert!(comparison[0].front.contains("有丝分裂"));
    assert!(comparison[1].front.contains("减数分裂"));

    assert!(
        suggest_splits("水的化学式？", "H2O。", 10).is_empty(),
        "原子卡不拆"
    );
    assert!(suggest_splits("", "back", 10).is_empty());
    assert!(suggest_splits("front", "back", 0).is_empty());
}

/// 画像 → 干扰 → 渲染纯函数链：高 lapse 卡进入画像与干扰预警，
/// 渲染 section 遵守字符预算且不再声称「数据仅本地/不上传」（0824 隐私收口）。
#[test]
fn fsrs_profile_and_interference_chain_respects_budgets() {
    // 干扰预警/卡片摘要属历史卡片原文，本测试验证的是预算与过滤链，显式开启外送。
    let cfg = FsrsFeedbackConfig {
        include_card_excerpts: true,
        ..FsrsFeedbackConfig::default()
    };
    let rows = vec![
        make_row("card-a", "牛顿第二定律的表达式是什么？", 6, &["力学"], None),
        make_row("card-b", "牛顿第二定律的适用条件？", 4, &["力学"], None),
        make_row(
            "card-c",
            "光合作用发生在哪里？",
            0,
            &["生物"],
            Some("cloze"),
        ),
    ];
    let profile = build_profile(&rows, 10_000, &cfg);
    assert_eq!(profile.total_cards, 3);
    assert!(!profile.is_empty());
    assert_eq!(profile.confusable_tags[0].tag, "力学");
    assert_eq!(profile.confusable_tags[0].total_lapses, 10);
    assert_eq!(
        profile.high_lapse_cards.len(),
        2,
        "lapses>=2 的卡才进入示例"
    );

    let section = render_profile_section(&profile, &cfg).expect("非空画像必须渲染");
    assert!(
        !section.contains("数据仅本地") && !section.contains("不上传"),
        "注入文本会随请求外送，不得虚假承诺: {section}"
    );
    assert!(section.chars().count() <= cfg.max_profile_chars);

    let hints = build_interference_hints(&rows, "本章讲牛顿第二定律及其应用", &cfg);
    assert!(!hints.is_empty());
    assert!(hints.iter().all(|h| h.lapses >= cfg.min_lapses_for_hint));
    assert!(
        hints.iter().all(|h| !h.front_excerpt.contains("光合作用")),
        "主题无关的卡不得进入干扰预警"
    );
    let interference = render_interference_section(&hints, &cfg).unwrap();
    assert!(interference.chars().count() <= cfg.max_interference_chars);
    assert!(interference.contains("对比卡"));

    // 空库/无关内容降级
    assert!(build_interference_hints(&[], "任意", &cfg).is_empty());
    assert!(render_interference_section(&[], &cfg).is_none());
}

// ============================================================================
// 8. anki_protocol：能力探测 / schema / repair / wrapper
// ============================================================================

/// 能力探测 × 协议决策矩阵：已知供应商升 json_schema，未知保守回退 delimiter，
/// 显式请求永远优先。
#[test]
fn protocol_capability_detection_and_resolution_matrix() {
    assert_eq!(
        detect_schema_capability("anthropic", None, None, "https://api.anthropic.com"),
        SchemaCapability::JsonSchema
    );
    assert_eq!(
        detect_schema_capability("openai", None, Some("openai"), "https://api.openai.com/v1"),
        SchemaCapability::JsonSchema
    );
    assert_eq!(
        detect_schema_capability("openai", None, Some("deepseek"), "https://api.deepseek.com"),
        SchemaCapability::JsonObjectOnly
    );
    assert_eq!(
        detect_schema_capability("openai", None, None, "https://my-gateway.example.com/v1"),
        SchemaCapability::Unknown
    );

    // auto：能力决定协议；Unknown/JsonObjectOnly 保守回退 delimiter
    assert_eq!(
        resolve_output_protocol(None, SchemaCapability::JsonSchema),
        (OutputProtocol::JsonSchema, "auto_capability")
    );
    assert_eq!(
        resolve_output_protocol(Some("auto"), SchemaCapability::Unknown),
        (
            OutputProtocol::Delimiter,
            "auto_capability_unknown_fallback"
        )
    );
    assert_eq!(
        resolve_output_protocol(None, SchemaCapability::JsonObjectOnly),
        (OutputProtocol::Delimiter, "auto_json_object_only_fallback")
    );
    // 显式请求优先（即使能力未知）
    assert_eq!(
        resolve_output_protocol(Some("json_schema"), SchemaCapability::Unknown),
        (OutputProtocol::JsonSchema, "explicit_request")
    );
    assert_eq!(
        resolve_output_protocol(Some("delimiter"), SchemaCapability::JsonSchema),
        (OutputProtocol::Delimiter, "explicit_request")
    );
    assert!(OutputProtocol::JsonSchema.is_structured());
    assert!(!OutputProtocol::Delimiter.is_structured());
}

/// 多模板 schema：oneOf 变体逐模板生成且携带 template_id 判别字段（enum 单值）。
#[test]
fn protocol_multi_template_schema_uses_one_of_with_discriminator() {
    let options_json = json!({
        "deck_name": "integration-test",
        "note_type": "Basic",
        "enable_images": false,
        "max_cards_per_mistake": 10,
        "max_cards_per_batch": 10,
        "template_fields_by_id": {
            "basic": ["front", "back", "tags"],
            "cloze": ["text", "tags"],
        },
    });
    let options: deep_student_lib::models::AnkiGenerationOptions =
        serde_json::from_value(options_json).expect("options parse");
    let schema = build_cards_response_schema(&options).expect("schema should build");

    assert_eq!(schema["required"], json!([CARDS_WRAPPER_KEY]));
    let variants = schema["properties"][CARDS_WRAPPER_KEY]["items"]["oneOf"]
        .as_array()
        .expect("multi-template must be oneOf");
    assert_eq!(variants.len(), 2);
    for variant in variants {
        let discriminator = &variant["properties"][TEMPLATE_ID_KEY];
        assert_eq!(discriminator["type"], json!("string"));
        assert_eq!(
            discriminator["enum"].as_array().unwrap().len(),
            1,
            "判别字段 enum 单值"
        );
        assert!(variant["required"]
            .as_array()
            .unwrap()
            .contains(&json!(TEMPLATE_ID_KEY)));
        assert_eq!(variant["additionalProperties"], json!(false));
    }
}

/// repair_json（无损接口）：尾逗号 / 括号未闭合（字符串已闭合）/ 尾部垃圾
/// 三类高频坏形态可修复；字符串中途截断属有损形态必须拒绝（0824 评审 #3），
/// 仅 repair_json_detailed 可修出带 truncated_string 标记的产物。
#[test]
fn protocol_repair_json_fixes_high_frequency_stream_damage() {
    let trailing_comma = repair_json(r#"{"front":"Q","back":"A",}"#).expect("trailing comma");
    assert_eq!(
        serde_json::from_str::<Value>(&trailing_comma).unwrap()["back"],
        json!("A")
    );

    // 字符串中途截断：无损接口拒绝（调用方应落错误卡）
    assert!(
        repair_json(r#"{"front":"什么是 TC"#).is_none(),
        "字符串中途截断不得被无损接口静默修复"
    );
    let detailed =
        repair_json_detailed(r#"{"front":"什么是 TC"#).expect("detailed 仍可修出合法 JSON");
    assert!(detailed.truncated_string, "必须携带截断标记");
    let value: Value = serde_json::from_str(&detailed.text).unwrap();
    assert!(value["front"].as_str().unwrap().starts_with("什么是"));

    let unclosed = repair_json(r#"{"front":"Q","tags":["网络""#).expect("unclosed brackets");
    let value: Value = serde_json::from_str(&unclosed).unwrap();
    assert_eq!(value["tags"][0], json!("网络"));

    // 结构化收尾残留 `]}`（wrapper 剥离后的典型尾巴）
    let tail_garbage = repair_json(r#"{"front":"Q","back":"A"}]}"#).expect("tail garbage");
    let value: Value = serde_json::from_str(&tail_garbage).unwrap();
    assert_eq!(value["back"], json!("A"));

    assert!(repair_json("完全没有对象").is_none());
}

/// wrapper 流式剥离：前缀跨 chunk 未完整时不动缓冲；完整到达后剥离，
/// 使 brace-depth 状态机能逐卡切出；unwrap_cards_array 处理整体形态。
#[test]
fn protocol_wrapper_streaming_strip_and_unwrap() {
    // 前缀不完整：不剥离、缓冲原样保留（可安全逐 chunk 重试）
    let mut partial = String::from("{\"ca");
    assert!(!strip_wrapper_prefix(&mut partial));
    assert_eq!(partial, "{\"ca");

    // 完整前缀（含空白变体）→ 剥离后缓冲以首卡对象开头
    let mut buffer = String::from("  { \"cards\" : [ {\"front\":\"Q1\"}");
    assert!(strip_wrapper_prefix(&mut buffer));
    assert!(buffer.trim_start().starts_with("{\"front\""), "{buffer}");

    // 非 wrapper 形态（普通单卡对象）恒不剥离
    let mut plain = String::from("{\"front\":\"Q\"}");
    assert!(!strip_wrapper_prefix(&mut plain));
    assert_eq!(plain, "{\"front\":\"Q\"}");

    let whole: Value = json!({ "cards": [{ "front": "Q" }] });
    assert_eq!(unwrap_cards_array(&whole).unwrap().len(), 1);
    assert!(unwrap_cards_array(&json!({ "data": [] })).is_none());
}

/// 跨模块链：坏 JSON → repair_json 修复 → 解析成卡 → qa_lint 质检 →
/// merge_flags 写入 extra_fields（生产 parse_and_save 的核心路径复刻）。
#[test]
fn cross_module_repair_then_lint_then_merge_chain() {
    let damaged = r#"{"front":"下列关于 TODO 的说法？","back":"答案 A","tags":["网络"],"#;
    let repaired = repair_json(damaged).expect("repairable");
    let card: Value = serde_json::from_str(&repaired).unwrap();

    let front = card["front"].as_str().unwrap();
    let back = card["back"].as_str().unwrap();
    let tags: Vec<String> = card["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap().to_string())
        .collect();

    let mut extra_fields: HashMap<String, String> = HashMap::new();
    let issues = lint_card(
        &CardLintInput {
            front,
            back,
            text: None,
            tags: &tags,
            extra_fields: &extra_fields,
        },
        &LintConfig::default(),
    );
    assert!(
        issues.iter().any(|i| i.code == "todo_residue"),
        "{issues:?}"
    );

    merge_flags(&mut extra_fields, &issues);
    let flags: Vec<Value> = serde_json::from_str(&extra_fields[QA_FLAGS_FIELD]).unwrap();
    assert!(flags.iter().any(|f| f["code"] == json!("todo_residue")));
    // 与拒绝决策联动：默认 Flag 级不拒绝
    assert!(!should_reject(&issues, &LintConfig::default()));
}

// ============================================================================
// 9. eval fixture 基线仍绿（manifest ↔ 生产常量/文件清单一致性）
// ============================================================================

fn eval_fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .join("tests/fixtures/anki-eval")
}

/// manifest 与生产协议常量一致，且每个 case 的夹具文件都在、结局取值合法。
#[test]
fn eval_fixture_manifest_stays_consistent_with_production_constants() {
    let manifest_path = eval_fixture_root().join("manifest.json");
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).expect("manifest readable"))
            .expect("manifest is valid JSON");

    assert_eq!(
        manifest["delimiter"].as_str().unwrap(),
        CARD_DELIMITER,
        "夹具分隔符必须与 anki_protocol::CARD_DELIMITER 同源"
    );

    let cases = manifest["cases"].as_array().expect("cases array");
    assert!(
        cases.len() >= 28,
        "基线至少 28 个 fixture，当前 {}",
        cases.len()
    );

    let mut seen_ids = HashSet::new();
    let allowed_outcomes: HashSet<&str> = ["parse_ok", "repair_ok", "error_card"].into();
    for case in cases {
        let id = case["id"].as_str().expect("case id");
        assert!(seen_ids.insert(id.to_string()), "case id 重复: {id}");
        assert!(
            matches!(case["set"].as_str(), Some("bad") | Some("good")),
            "case {id} 的 set 非法"
        );
        assert!(
            matches!(case["entry"].as_str(), Some("stream") | Some("direct")),
            "case {id} 的 entry 非法"
        );
        let file = case["file"].as_str().expect("case file");
        assert!(
            eval_fixture_root().join(file).is_file(),
            "case {id} 的夹具文件缺失: {file}"
        );
        for card in case["expected"]["cards"]
            .as_array()
            .expect("expected.cards")
        {
            let outcome = card["outcome"].as_str().expect("outcome");
            assert!(
                allowed_outcomes.contains(outcome),
                "case {id} 结局非法: {outcome}"
            );
        }
    }

    let bad = cases.iter().filter(|c| c["set"] == json!("bad")).count();
    let good = cases.iter().filter(|c| c["set"] == json!("good")).count();
    assert!(bad >= 22, "坏样本基线不得缩水（当前 {bad}）");
    assert!(good >= 6, "好卡对照组不得缩水（当前 {good}）");
}

/// manifest 中 repair_ok 结局的 direct 用例：生产 repair_json 必须真的能修复
/// 对应夹具中的坏 JSON 段（防止测试侧原型与生产实现漂移）。
#[test]
fn eval_fixture_repair_expectations_hold_against_production_repair_json() {
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(eval_fixture_root().join("manifest.json")).unwrap(),
    )
    .unwrap();
    let cases = manifest["cases"].as_array().unwrap();

    let mut checked = 0usize;
    for case in cases {
        if case["entry"] != json!("direct") {
            continue;
        }
        let expected: Vec<&str> = case["expected"]["cards"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["outcome"].as_str())
            .collect();
        // direct 入口 = 整段内容一次交给解析/修复路径；只验证单卡 direct 用例，
        // 多卡切分属于流式切卡器职责（vitest 回放已覆盖）。
        if expected.len() != 1 {
            continue;
        }
        let file = case["file"].as_str().unwrap();
        let content = std::fs::read_to_string(eval_fixture_root().join(file)).unwrap();
        let body = content.replace(CARD_DELIMITER, "");
        match expected[0] {
            "parse_ok" => {
                assert!(
                    serde_json::from_str::<Value>(body.trim()).is_ok(),
                    "case {} 预期 parse_ok 但原文不可解析",
                    case["id"]
                );
                checked += 1;
            }
            "repair_ok" => {
                assert!(
                    serde_json::from_str::<Value>(body.trim()).is_err(),
                    "case {} 预期 repair_ok 但原文已可直接解析（基线应升级为 parse_ok）",
                    case["id"]
                );
                assert!(
                    repair_json(&body).is_some(),
                    "case {} 预期 repair_ok 但生产 repair_json 修不动",
                    case["id"]
                );
                checked += 1;
            }
            _ => {}
        }
    }
    assert!(
        checked >= 1,
        "至少应存在一个可对照生产 repair_json 的 direct 用例"
    );
}
