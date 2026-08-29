//! Wave2-A 第 7 轮 #8：Anthropic 缓存断点四槽守卫与工具 marker 透传测试（只写不跑）。
//!
//! ⚠️ 本文件为测试源码交付物：**只落盘、不执行**（本轮铁律禁止 cargo /
//! 任何测试执行）。模块声明（`#[cfg(test)] mod wave2_a_anthropic_budget_tests;`）
//! 由父代理在 `providers/mod.rs` 接线——本轮不改 mod.rs。
//!
//! ## 被测生产项（均在 `providers/mod.rs`）
//!
//! | 生产项 | 位置 | 语义 |
//! | --- | --- | --- |
//! | `ANTHROPIC_CACHE_BREAKPOINT_BUDGET` | mod.rs:2923 | Anthropic 硬上限：一个请求最多 4 个 cache_control 断点 |
//! | `enforce_anthropic_cache_breakpoint_budget` | mod.rs:2930 | 四槽预算守卫（ROUND-05 P2）：顶层 automatic 恒占 1 槽，块级（tools + system）合计不得超 3 槽，超载按 prompt 序（tools 先于 system、靠前先剥）从最靠前的 marker 剥除 |
//! | `convert_tool_definition` | mod.rs:3302 | OpenAI 形状 tools[] → AnthropicTool，透传条目顶层 `cache_control`（ROUND-05 P2，此前恒 None 静默丢弃） |
//! | `convert_openai_to_anthropic` | mod.rs:2256 | 端到端转换：tools 尾/system 尾保险断点（ROUND-02 P2-11）+ 四槽守卫 |
//!
//! ## 覆盖面（对 mod.rs 既有 ROUND-05 用例做增量补位，不重复）
//!
//! 1. **守卫直调单元测试**：既有用例只经 convert 端到端路径触发守卫，
//!    本文件直接驱动 `enforce_anthropic_cache_breakpoint_budget`——
//!    tools=None / 空 vec / 纯 tools 超载 / 剥除跨过 tools→system 边界 /
//!    marker 载荷（如带 ttl 的扩展形态）原样保留 / 剥除后 Option 归 None
//!    （序列化不得残留 `cache_control: null`）。
//! 2. **透传契约端到端**：marker 在非尾工具上的位置保持；扩展载荷逐字节
//!    透传；marker 必须打在 tools[] 条目顶层（嵌进 `function` 对象不算）；
//!    非 function 条目被丢弃时其 marker 既不抑制尾部保险断点也不占预算。
//! 3. **守卫×保险断点交互**：自动追加的 tools 尾断点同样参与预算，
//!    超载时先于调用方 system marker 被剥。

use serde_json::{json, Value};

use super::{
    enforce_anthropic_cache_breakpoint_budget, AnthropicAdapter, AnthropicTool,
    ANTHROPIC_CACHE_BREAKPOINT_BUDGET,
};

// ============================================================================
// 测试构件
// ============================================================================

/// 普通 ephemeral marker（与生产尾部保险断点同形）。
fn ephemeral() -> Value {
    json!({ "type": "ephemeral" })
}

/// 带 ttl 的扩展 marker：守卫与透传都不得改写载荷，只能整体保留或整体剥除。
fn ephemeral_with_ttl() -> Value {
    json!({ "type": "ephemeral", "ttl": "1h" })
}

fn make_tool(name: &str, cache_control: Option<Value>) -> AnthropicTool {
    AnthropicTool {
        name: name.to_string(),
        description: None,
        input_schema: json!({ "type": "object", "properties": {} }),
        cache_control,
    }
}

fn system_block(text: &str, cache_control: Option<Value>) -> Value {
    let mut block = json!({ "type": "text", "text": text });
    if let Some(marker) = cache_control {
        block["cache_control"] = marker;
    }
    block
}

fn tool_marker_count(tools: &[AnthropicTool]) -> usize {
    tools
        .iter()
        .filter(|tool| tool.cache_control.is_some())
        .count()
}

fn system_marker_count(blocks: &[Value]) -> usize {
    blocks
        .iter()
        .filter(|block| block.get("cache_control").is_some())
        .count()
}

// ============================================================================
// 1. 四槽守卫：直调单元测试
// ============================================================================

/// 预算常量锚定 Anthropic 硬上限 4：常量漂移会让下面所有边界用例
/// 静默失去意义，先钉死。
#[test]
fn budget_constant_matches_anthropic_hard_limit() {
    assert_eq!(ANTHROPIC_CACHE_BREAKPOINT_BUDGET, 4);
}

/// 块级 marker 恰在 3 槽预算内（tools 1 + system 2）时守卫必须零改动：
/// 已标块原样保留，未标块不得被凭空打点。
#[test]
fn guard_noop_when_block_markers_within_budget() {
    let mut tools = vec![
        make_tool("alpha", None),
        make_tool("beta", Some(ephemeral())),
    ];
    let mut system = vec![
        system_block("s1", Some(ephemeral())),
        system_block("s2", None),
        system_block("s3", Some(ephemeral())),
    ];

    enforce_anthropic_cache_breakpoint_budget(Some(&mut tools), &mut system);

    assert!(tools[0].cache_control.is_none(), "未标工具不得被打点");
    assert_eq!(tools[1].cache_control, Some(ephemeral()));
    assert_eq!(system[0]["cache_control"], ephemeral());
    assert!(system[1].get("cache_control").is_none(), "未标块不得被打点");
    assert_eq!(system[2]["cache_control"], ephemeral());
}

/// tools=None（请求不带工具）时守卫只看 system：3 个 marker 恰满预算，
/// 全部保留且不 panic（`Option<&mut Vec<_>>` 的 None 路径）。
#[test]
fn guard_without_tools_keeps_system_markers_within_budget() {
    let mut system = vec![
        system_block("s1", Some(ephemeral())),
        system_block("s2", Some(ephemeral())),
        system_block("s3", Some(ephemeral())),
    ];

    enforce_anthropic_cache_breakpoint_budget(None, &mut system);

    assert_eq!(system_marker_count(&system), 3);
}

/// tools=None、system 5 个 marker（超载 2）：从最靠前的 system marker
/// 剥起，尾部 3 个（覆盖前缀最长、命中价值最高）保留。
#[test]
fn guard_without_tools_strips_earliest_system_markers_on_overflow() {
    let mut system = vec![
        system_block("s1", Some(ephemeral())),
        system_block("s2", Some(ephemeral())),
        system_block("s3", Some(ephemeral())),
        system_block("s4", Some(ephemeral())),
        system_block("s5", Some(ephemeral())),
    ];

    enforce_anthropic_cache_breakpoint_budget(None, &mut system);

    assert!(system[0].get("cache_control").is_none());
    assert!(system[1].get("cache_control").is_none());
    assert_eq!(system[2]["cache_control"], ephemeral());
    assert_eq!(system[3]["cache_control"], ephemeral());
    assert_eq!(system[4]["cache_control"], ephemeral());
}

/// 纯 tools 超载（4 个 marker、system 无 marker）：剥最靠前 1 个，
/// 尾部 3 个保留——尾部 tool marker 覆盖的工具定义前缀最长。
/// 剥除后 Option 必须归 None：序列化不得残留 `cache_control: null`。
#[test]
fn guard_strips_earliest_tool_markers_and_leaves_no_null_on_serialize() {
    let mut tools = vec![
        make_tool("t1", Some(ephemeral())),
        make_tool("t2", Some(ephemeral())),
        make_tool("t3", Some(ephemeral())),
        make_tool("t4", Some(ephemeral())),
    ];
    let mut system: Vec<Value> = vec![system_block("s1", None)];

    enforce_anthropic_cache_breakpoint_budget(Some(&mut tools), &mut system);

    assert!(tools[0].cache_control.is_none());
    assert_eq!(tool_marker_count(&tools), 3);
    assert_eq!(tools[3].cache_control, Some(ephemeral()));

    // skip_serializing_if 契约：被剥工具序列化后完全没有 cache_control 键，
    // 而不是 null——Anthropic 对 null 载荷会 400。
    let stripped = serde_json::to_value(&tools[0]).expect("tool serialize");
    assert!(stripped.get("cache_control").is_none());
    let kept = serde_json::to_value(&tools[3]).expect("tool serialize");
    assert_eq!(kept["cache_control"], ephemeral());
}

/// 剥除跨过 tools→system 边界：tools 1 + system 4 = 5（超载 2）→
/// 先剥掉唯一的 tools marker，再剥 system 最靠前 1 个，system 尾部
/// 3 个保留。既有端到端用例只覆盖「全落在 tools 内」的剥除，
/// 本用例钉死跨来源的续剥顺序。
#[test]
fn guard_overflow_crosses_from_tools_into_system() {
    let mut tools = vec![make_tool("t1", Some(ephemeral()))];
    let mut system = vec![
        system_block("s1", Some(ephemeral())),
        system_block("s2", Some(ephemeral())),
        system_block("s3", Some(ephemeral())),
        system_block("s4", Some(ephemeral())),
    ];

    enforce_anthropic_cache_breakpoint_budget(Some(&mut tools), &mut system);

    assert_eq!(
        tool_marker_count(&tools),
        0,
        "tools marker 先于 system 被剥"
    );
    assert!(
        system[0].get("cache_control").is_none(),
        "续剥 system 最靠前块"
    );
    assert_eq!(system[1]["cache_control"], ephemeral());
    assert_eq!(system[2]["cache_control"], ephemeral());
    assert_eq!(system[3]["cache_control"], ephemeral());
}

/// 守卫只做整体剥除，不改写幸存 marker 的载荷：带 ttl 的扩展形态
/// 在超载剥除后仍逐字节保留（不得被归一成裸 ephemeral）。
#[test]
fn guard_preserves_surviving_marker_payload_verbatim() {
    let mut tools = vec![
        make_tool("t1", Some(ephemeral())),
        make_tool("t2", Some(ephemeral_with_ttl())),
    ];
    let mut system = vec![
        system_block("s1", Some(ephemeral())),
        system_block("s2", Some(ephemeral_with_ttl())),
    ];

    // 块级 4 > 3，剥最靠前的 t1 一个。
    enforce_anthropic_cache_breakpoint_budget(Some(&mut tools), &mut system);

    assert!(tools[0].cache_control.is_none());
    assert_eq!(tools[1].cache_control, Some(ephemeral_with_ttl()));
    assert_eq!(system[0]["cache_control"], ephemeral());
    assert_eq!(system[1]["cache_control"], ephemeral_with_ttl());
}

/// 空输入健壮性：Some(空 vec) + 空 system 切片不 panic、零改动
/// （overflow 计算全程 saturating，无下溢路径）。
#[test]
fn guard_handles_empty_inputs_without_panic() {
    let mut tools: Vec<AnthropicTool> = Vec::new();
    let mut system: Vec<Value> = Vec::new();

    enforce_anthropic_cache_breakpoint_budget(Some(&mut tools), &mut system);

    assert!(tools.is_empty());
    assert!(system.is_empty());
}

// ============================================================================
// 2. 工具 marker 透传：端到端契约
// ============================================================================

/// 透传保持位置与载荷：marker 打在 3 个工具的中间那个（非尾）上，
/// 转换后必须仍在中间且载荷（含 ttl 扩展字段）逐字节一致；
/// has_marker 命中 → 首尾工具都不得被追加保险断点。
#[test]
fn anthropic_tool_marker_passthrough_keeps_position_and_payload() {
    let adapter = AnthropicAdapter::new();
    let body = json!({
        "messages": [{ "role": "user", "content": "hi" }],
        "tools": [
            {
                "type": "function",
                "function": { "name": "alpha_tool", "parameters": { "type": "object" } }
            },
            {
                "type": "function",
                "cache_control": { "type": "ephemeral", "ttl": "1h" },
                "function": { "name": "beta_tool", "parameters": { "type": "object" } }
            },
            {
                "type": "function",
                "function": { "name": "gamma_tool", "parameters": { "type": "object" } }
            }
        ]
    });

    let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
    let request_json = serde_json::to_value(request).expect("serialize");

    // 顶层 automatic 槽恒在（透传不影响 automatic 注入）。
    assert_eq!(request_json["cache_control"], ephemeral());

    let tools = request_json["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 3);
    assert!(tools[0].get("cache_control").is_none());
    assert_eq!(tools[1]["cache_control"], ephemeral_with_ttl());
    assert!(
        tools[2].get("cache_control").is_none(),
        "调用方已打 marker → 尾部保险断点不得追加"
    );
}

/// marker 位置契约：必须打在 tools[] 条目顶层。嵌进 `function` 对象里的
/// `cache_control` 不是透传形态——不被提升、不算 has_marker，
/// 转换后走无 marker 路径：尾工具追加**裸 ephemeral** 保险断点
/// （载荷是裸形态而非嵌套的 ttl 形态，反证嵌套字段没有被提升）。
#[test]
fn anthropic_marker_nested_in_function_object_is_not_a_tool_marker() {
    let adapter = AnthropicAdapter::new();
    let body = json!({
        "messages": [{ "role": "user", "content": "hi" }],
        "tools": [{
            "type": "function",
            "function": {
                "name": "alpha_tool",
                "cache_control": { "type": "ephemeral", "ttl": "1h" },
                "parameters": { "type": "object" }
            }
        }]
    });

    let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
    let request_json = serde_json::to_value(request).expect("serialize");

    let tools = request_json["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 1);
    assert_eq!(
        tools[0]["cache_control"],
        ephemeral(),
        "应为自动追加的裸 ephemeral 尾断点，而非被提升的嵌套 ttl 载荷"
    );
}

/// 非 function 条目（convert_tool_definition 返回 None 被丢弃）上的
/// marker 不得产生任何副作用：既不抑制幸存工具的尾部保险断点
/// （has_marker 只统计转换后的条目），也不占四槽预算。
#[test]
fn anthropic_dropped_tool_entry_marker_has_no_side_effects() {
    let adapter = AnthropicAdapter::new();
    let body = json!({
        "messages": [{ "role": "user", "content": "hi" }],
        "tools": [
            {
                "type": "custom",
                "cache_control": { "type": "ephemeral" },
                "function": { "name": "dropped_tool", "parameters": { "type": "object" } }
            },
            {
                "type": "function",
                "function": { "name": "alpha_tool", "parameters": { "type": "object" } }
            }
        ]
    });

    let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
    let request_json = serde_json::to_value(request).expect("serialize");

    let tools = request_json["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 1, "非 function 条目应被丢弃");
    assert_eq!(tools[0]["name"], json!("alpha_tool"));
    assert_eq!(
        tools[0]["cache_control"],
        ephemeral(),
        "被丢弃条目的 marker 不算 has_marker，尾部保险断点照常追加"
    );
}

/// tools[] 全部无效（非 function）时转换结果为空 → 请求不带 tools 键
/// （filter 掉空 vec），tools 尾断点自然不存在；system 尾保险断点与
/// 顶层 automatic 不受影响。
#[test]
fn anthropic_all_invalid_tools_yield_no_tools_key() {
    let adapter = AnthropicAdapter::new();
    let body = json!({
        "messages": [
            { "role": "system", "content": "stable instructions" },
            { "role": "user", "content": "hi" }
        ],
        "tools": [{
            "type": "custom",
            "cache_control": { "type": "ephemeral" },
            "function": { "name": "dropped_tool", "parameters": { "type": "object" } }
        }]
    });

    let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
    let request_json = serde_json::to_value(request).expect("serialize");

    assert!(request_json.get("tools").is_none(), "空 tools 不得序列化");
    assert_eq!(request_json["cache_control"], ephemeral());
    let system = request_json["system"].as_array().expect("system array");
    assert_eq!(system[0]["cache_control"], ephemeral());
}

// ============================================================================
// 3. 守卫 × 保险断点交互
// ============================================================================

/// 自动追加的 tools 尾保险断点同样参与四槽预算：system 3 个调用方
/// marker（抑制 system 尾自动打点）+ tools 尾自动断点 = 块级 4 > 3
/// → 按 prompt 序先剥 tools 尾自动断点，3 个 system marker 全保留。
/// 自动断点没有豁免权，超载时最先让位给调用方显式标注。
#[test]
fn anthropic_auto_tools_tail_breakpoint_yields_to_caller_system_markers() {
    let adapter = AnthropicAdapter::new();
    let body = json!({
        "messages": [
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": "s1",
                        "cache_control": { "type": "ephemeral" }
                    },
                    {
                        "type": "text",
                        "text": "s2",
                        "cache_control": { "type": "ephemeral" }
                    },
                    {
                        "type": "text",
                        "text": "s3",
                        "cache_control": { "type": "ephemeral" }
                    }
                ]
            },
            { "role": "user", "content": "hi" }
        ],
        "tools": [
            {
                "type": "function",
                "function": { "name": "alpha_tool", "parameters": { "type": "object" } }
            },
            {
                "type": "function",
                "function": { "name": "beta_tool", "parameters": { "type": "object" } }
            }
        ]
    });

    let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
    let request_json = serde_json::to_value(request).expect("serialize");

    // automatic 顶层槽不参与剥除。
    assert_eq!(request_json["cache_control"], ephemeral());

    // tools 尾自动断点被剥（且不残留 null 键）。
    let tools = request_json["tools"].as_array().expect("tools array");
    assert!(tools[0].get("cache_control").is_none());
    assert!(tools[1].get("cache_control").is_none());

    // 调用方 system marker 全保留（恰好用满剩余 3 槽）。
    let system = request_json["system"].as_array().expect("system array");
    assert_eq!(system[0]["cache_control"], ephemeral());
    assert_eq!(system[1]["cache_control"], ephemeral());
    assert_eq!(system[2]["cache_control"], ephemeral());
}

/// 透传 marker 在预算内时安然通过守卫：tools 透传 1（ttl 扩展载荷）
/// + system 尾自动断点 1 = 块级 2 ≤ 3，守卫零改动，载荷逐字节保留。
#[test]
fn anthropic_passthrough_marker_survives_budget_guard_within_budget() {
    let adapter = AnthropicAdapter::new();
    let body = json!({
        "messages": [
            { "role": "system", "content": "stable instructions" },
            { "role": "user", "content": "hi" }
        ],
        "tools": [{
            "type": "function",
            "cache_control": { "type": "ephemeral", "ttl": "1h" },
            "function": { "name": "alpha_tool", "parameters": { "type": "object" } }
        }]
    });

    let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
    let request_json = serde_json::to_value(request).expect("serialize");

    assert_eq!(request_json["cache_control"], ephemeral());
    let tools = request_json["tools"].as_array().expect("tools array");
    assert_eq!(tools[0]["cache_control"], ephemeral_with_ttl());
    let system = request_json["system"].as_array().expect("system array");
    assert_eq!(system[0]["cache_control"], ephemeral());
}
