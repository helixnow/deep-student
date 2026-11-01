//! 跨轮前缀快照测试（SOTA prompt-cache 遥测厚工单，2026-08）
//!
//! Provider 的 prompt cache 以「请求前缀字节完全一致」为命中条件：
//! system 是 input 第 0 位，tools 紧随其后（Anthropic 把 tools 纳入缓存
//! 前缀）。本模块用已有的 pub(crate) helper 做跨轮字节级快照回归：
//!
//! 1. system 稳定：todos / canvas / 检索命中 / 画像逐轮变化时，
//!    `PromptBuilder::build_split` 产出的 stable_system 字节逐轮相等；
//! 2. tools 已发出部分不变：`freeze_tool_schema_order_for_prompt_cache` +
//!    `merge_frozen_tool_schema_order_baseline` 维护的会话基线（经
//!    session.metadata JSON 持久化往返）保证已发出 tools 的序列化字节
//!    是后续轮次的严格前缀，新工具只追加末尾；
//! 3. todos / canvas 变化不进 system：动态块只允许出现在 turn-volatile
//!    （注入当前 user 消息的 `<injected_context>`），system 内不得残留。
//!
//! 本模块由 `pipeline.rs` 的 `#[cfg(test)] mod prefix_snapshot_tests;`
//! 声明，仅在测试构建时编译。

use serde_json::{json, Value};

use super::tool_loop::{
    freeze_tool_schema_order_for_prompt_cache, merge_frozen_tool_schema_order_baseline,
    tool_schema_sort_key,
};
use crate::chat_v2::prompt_builder::{CanvasNoteInfo, PromptBuilder, SystemPromptParts};
use crate::chat_v2::types::SourceInfo;

// ============================================================================
// 测试构件
// ============================================================================

/// 模拟第 `round` 轮的 prompt 构建：稳定输入不变，
/// todos / canvas / 检索命中 / 画像 / hints 全部随轮次漂移。
fn build_round(round: usize) -> SystemPromptParts {
    let rag = vec![SourceInfo {
        title: Some(format!("第{}轮命中文档", round)),
        url: None,
        snippet: Some(format!("第{}轮检索命中内容", round)),
        score: Some(0.9),
        metadata: None,
    }];
    let canvas = CanvasNoteInfo::new(
        "note_1".to_string(),
        format!("第{}轮笔记", round),
        format!("第{}轮笔记内容", round),
    );
    let hints = vec![format!("- <hint_round_{}>", round)];
    PromptBuilder::new(Some("你是稳定前缀测试助手"))
        .with_user_append(Some("回答保持简洁"))
        .with_rag_sources(Some(&rag))
        .with_user_profile(Some(format!("第{}轮画像", round)))
        .with_active_todos(Some(format!("1. 第{}轮待办", round)))
        .with_canvas_note(Some(canvas))
        .with_context_type_hints(Some(&hints))
        .build_split()
}

/// OpenAI function 格式的工具 schema（与 tool_loop 实际发出的形态一致）。
fn tool_schema(name: &str, description: &str) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": { "type": "object", "properties": {} }
        }
    })
}

/// 模拟会话基线经 session.metadata（frozenToolSchemaOrder，JSON 数组）
/// 的持久化往返——覆盖进程重启后基线从库里载回的路径。
fn persist_roundtrip(baseline: &[String]) -> Vec<String> {
    let raw = serde_json::to_string(baseline).expect("serialize frozen baseline");
    serde_json::from_str(&raw).expect("deserialize frozen baseline")
}

/// 序列化 tools 数组为发出请求时的 JSON 字节。
fn tools_bytes(tools: &[Value]) -> Vec<u8> {
    serde_json::to_vec(tools).expect("serialize tools array")
}

// ============================================================================
// 1. system 稳定 + todos/canvas 变化不进 system
// ============================================================================

#[test]
fn system_prefix_bytes_identical_across_rounds_while_volatile_inputs_change() {
    let rounds: Vec<SystemPromptParts> = (1..=3).map(build_round).collect();

    // system 字节逐轮相等（检索命中 / todos / canvas / 画像 / hints 变化均不影响）
    for window in rounds.windows(2) {
        assert_eq!(
            window[0].stable_system.as_bytes(),
            window[1].stable_system.as_bytes(),
            "system 前缀必须跨轮字节稳定，否则整段历史缓存报废"
        );
    }

    // 变化必须全部落在 turn-volatile（进当前 user 的 <injected_context>）
    for (index, parts) in rounds.iter().enumerate() {
        let round = index + 1;
        let volatile = parts
            .turn_volatile
            .as_deref()
            .expect("动态输入非空时必须产出 turn-volatile 块");
        assert!(volatile.contains(&format!("1. 第{}轮待办", round)));
        assert!(volatile.contains(&format!("第{}轮笔记", round)));
        assert!(volatile.contains(&format!("第{}轮检索命中内容", round)));
        assert!(volatile.contains(&format!("第{}轮画像", round)));
    }
    assert_ne!(rounds[0].turn_volatile, rounds[1].turn_volatile);
}

#[test]
fn todos_and_canvas_never_leak_into_stable_system() {
    let parts = build_round(1);

    for tag in [
        "<active_todos>",
        "<canvas_note>",
        "<user_profile>",
        "<learner_profile>",
        "<context>",
        "<user_message_format_guide>",
    ] {
        assert!(
            !parts.stable_system.contains(tag),
            "turn-volatile 标签 {} 泄漏进了 stable system",
            tag
        );
    }
    // 内容级双保险：具体动态文本也不得出现在 system
    assert!(!parts.stable_system.contains("第1轮待办"));
    assert!(!parts.stable_system.contains("第1轮笔记"));

    let volatile = parts.turn_volatile.expect("volatile blocks present");
    assert!(volatile.contains("<active_todos>"));
    assert!(volatile.contains("<canvas_note>"));
}

// ============================================================================
// 2. tools 已发出部分不变（跨轮 + 跨进程持久化往返）
// ============================================================================

#[test]
fn emitted_tools_serialization_is_strict_byte_prefix_of_later_rounds() {
    // ===== 第 1 轮：字母序建立基线并「发出」 =====
    let mut session_baseline: Vec<String> = Vec::new();
    let mut round1_local = session_baseline.clone();
    let mut round1_tools = vec![
        tool_schema("zeta_tool", "Z"),
        tool_schema("alpha_tool", "A"),
    ];
    freeze_tool_schema_order_for_prompt_cache(&mut round1_tools, &mut round1_local);
    merge_frozen_tool_schema_order_baseline(&mut session_baseline, &round1_local);
    let round1_bytes = tools_bytes(&round1_tools);

    // ===== 第 2 轮：进程重启（基线 JSON 持久化往返）+ 来源顺序打乱 +
    // 环内 load_skills 渐进披露 beta_tool（字母序落在已发出两工具中间）=====
    let mut round2_local = persist_roundtrip(&session_baseline);
    let mut round2_tools = vec![
        tool_schema("beta_tool", "B"),
        tool_schema("alpha_tool", "A"),
        tool_schema("zeta_tool", "Z"),
    ];
    freeze_tool_schema_order_for_prompt_cache(&mut round2_tools, &mut round2_local);
    merge_frozen_tool_schema_order_baseline(&mut session_baseline, &round2_local);
    let round2_bytes = tools_bytes(&round2_tools);

    // 已发出 tools 的序列化字节必须是第 2 轮的严格前缀（去掉数组闭括号）
    let round1_prefix = &round1_bytes[..round1_bytes.len() - 1];
    assert!(
        round2_bytes.starts_with(round1_prefix),
        "第 1 轮已发出的 tools 字节必须原样作为第 2 轮前缀，新工具只能追加末尾"
    );
    let names: Vec<&str> = round2_tools.iter().map(tool_schema_sort_key).collect();
    assert_eq!(names, vec!["alpha_tool", "zeta_tool", "beta_tool"]);

    // ===== 第 3 轮：再次持久化往返，无新工具 → 字节完全相同（幂等）=====
    let mut round3_local = persist_roundtrip(&session_baseline);
    let mut round3_tools = vec![
        tool_schema("zeta_tool", "Z"),
        tool_schema("beta_tool", "B"),
        tool_schema("alpha_tool", "A"),
    ];
    freeze_tool_schema_order_for_prompt_cache(&mut round3_tools, &mut round3_local);
    let round3_bytes = tools_bytes(&round3_tools);
    assert_eq!(
        round3_bytes, round2_bytes,
        "工具面未变时，第 3 轮 tools 字节必须与第 2 轮逐字节一致"
    );
}

// ============================================================================
// 3. 组合快照：system + tools 拼成请求前缀，跨轮只允许尾部追加
// ============================================================================

#[test]
fn combined_request_prefix_only_grows_at_the_tail_across_rounds() {
    let mut session_baseline: Vec<String> = Vec::new();

    // 第 1 轮：system（含逐轮变化的 volatile 输入）+ 初始工具面
    let parts1 = build_round(1);
    let mut local1 = session_baseline.clone();
    let mut tools1 = vec![
        tool_schema("builtin-web_search", "搜索"),
        tool_schema("builtin-todo_update", "待办"),
    ];
    freeze_tool_schema_order_for_prompt_cache(&mut tools1, &mut local1);
    merge_frozen_tool_schema_order_baseline(&mut session_baseline, &local1);
    let mut prefix1 = parts1.stable_system.clone().into_bytes();
    prefix1.extend_from_slice(&tools_bytes(&tools1));

    // 第 2 轮：todos/canvas/检索全变 + 中途 skill_install 新增工具
    let parts2 = build_round(2);
    let mut local2 = persist_roundtrip(&session_baseline);
    let mut tools2 = vec![
        tool_schema("builtin-anki_generate", "制卡"), // 字母序最靠前的新工具
        tool_schema("builtin-todo_update", "待办"),
        tool_schema("builtin-web_search", "搜索"),
    ];
    freeze_tool_schema_order_for_prompt_cache(&mut tools2, &mut local2);
    merge_frozen_tool_schema_order_baseline(&mut session_baseline, &local2);
    let mut prefix2 = parts2.stable_system.clone().into_bytes();
    prefix2.extend_from_slice(&tools_bytes(&tools2));

    // 请求前缀（system + tools）跨轮只允许尾部追加：
    // 第 1 轮前缀去掉 tools 数组闭括号后必须是第 2 轮前缀的严格前缀
    let comparable = &prefix1[..prefix1.len() - 1];
    assert!(
        prefix2.starts_with(comparable),
        "system+tools 请求前缀出现中段字节漂移，provider 前缀缓存将整段失效"
    );
}
