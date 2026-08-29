//! Wave2-A 第 7 轮 #2：tools 前缀分叉「终局稳态」反例测试（只写不跑）。
//!
//! ⚠️ 本文件为测试源码交付物：**只落盘、不执行**（本轮铁律禁止 cargo /
//! 任何测试执行）。模块声明（`#[cfg(test)] mod prefix_generation_fork_finale_tests;`）
//! 由父代理在 `pipeline.rs` 接线。不改产品逻辑。
//!
//! ## 与第 2 轮 `prefix_generation_fork_tests.rs` 的分工
//!
//! 第 2 轮覆盖的是**分叉瞬间**：A 追加 X、B 追加 Y → join 收敛点按变体
//! 索引序合并 + generation 0 → 1。本文件覆盖分叉之后的**终局稳态**：
//!
//! 1. **后轮同现**：轮 T 收敛并持久化后，轮 T+1 fan-out 的两个变体都
//!    必须看见 X 和 Y（工具面同现，非各见各的），发出字节逐字节一致，
//!    收敛 Δg = 0、advance 跳过写库 —— generation 稳定在 1。
//! 2. **多轮不漂移**：T+1..T+4 连续空轮 + 变体索引洗牌，generation
//!    恒为 1、order 字节恒等 —— 稳态一旦建立不得因轮数或索引分配抖动。
//! 3. **跨进程稳态**：轮 T 与轮 T+1 之间桌面 App 重启（内存清空），
//!    从 metadata 恢复后两变体依然同现 X+Y、generation 依然是 1。
//! 4. **迟到写回免疫**：收敛后一个掉队变体把分叉前的旧快照
//!    （generation=0, B̂+[Y]）写回 —— advance 必须跳过写库，稳态的
//!    generation 与 order 一个字节都不能回退。
//!
//! ## 预期红绿
//!
//! 旧行为（`multi_variant.rs` 变体内各自 load + 中途 store、无 generation
//! 概念）下会红：测试 1/2 —— 旧路径轮 T 合并序由完成竞态抽签，轮 T+1
//! 两变体读到的基线序不可复现，「同现 X+Y 且字节一致」无法保证，更没有
//! 任何 generation 信号可言。方案 A（fan-out 统一快照 + join 索引序收敛 +
//! 真分叉切代 + advance 无变更跳过）下四条全绿。
//!
//! ## 契约副本说明
//!
//! 与同目录 `prefix_generation_fork_tests.rs` / `prefix_generation_restore_tests.rs`
//! 同源的 DB-free 契约副本（各测试模块私有，无法互相 import）：
//!
//! | 本文件契约副本 | 对齐的生产项 |
//! | --- | --- |
//! | `converge_orders_by_variant_index` | #1 席位待交付 `helpers::converge_session_tool_face_prefix`（ROUND-02 切代规则 + 设计稿 4.2 收敛伪码）；落地后改调生产函数，断言原样保留 |
//! | `snapshot_from_metadata` | `repo.rs` `tool_face_prefix_from_metadata`（缺代际键 generation 视 0、order 回退 `frozenToolSchemaOrder`、三键全缺 None） |
//! | `advance_snapshot_into_metadata` | `repo.rs` `advance_session_tool_face_prefix_with_conn`（append-only merge、generation 只 max 不 bump、无变更跳过写库） |
//!
//! append-only 合并原语直接复用生产 `tool_loop::merge_frozen_tool_schema_order_baseline`，
//! 快照类型直接用生产 `types::ToolFacePrefixSnapshot` —— 测试与生产语义不漂移。

use serde_json::{json, Value};

use super::tool_loop::{
    freeze_tool_schema_order_for_prompt_cache, merge_frozen_tool_schema_order_baseline,
    tool_schema_sort_key,
};
use crate::chat_v2::types::{
    ToolFacePrefixSnapshot, FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY,
    TOOL_FACE_PREFIX_GENERATION_METADATA_KEY, TOOL_SCHEMA_DIGEST_METADATA_KEY,
};

// ============================================================================
// 契约副本（对齐关系见文件头表格）
// ============================================================================

/// 契约副本：join 收敛点按变体索引序合并 + 真分叉切代判定
/// （产品落地后改为调用 `helpers::converge_session_tool_face_prefix`）。
///
/// 返回 `(Δg, 收敛后 order)`：收敛 order 从空表出发按变体索引序做
/// append-only 合并；只要存在一个变体的本地 order 不是收敛 order 的
/// 前缀（真分叉）则 Δg = 1，否则 Δg = 0。
fn converge_orders_by_variant_index(baselines: &[Vec<String>]) -> (u64, Vec<String>) {
    let mut converged: Vec<String> = Vec::new();
    for local_order in baselines {
        merge_frozen_tool_schema_order_baseline(&mut converged, local_order);
    }
    let true_fork = baselines
        .iter()
        .any(|local_order| !converged.starts_with(local_order.as_slice()));
    let generation_bump = if true_fork { 1 } else { 0 };
    (generation_bump, converged)
}

/// 契约副本：`repo::tool_face_prefix_from_metadata` 的读路径。
fn snapshot_from_metadata(metadata: Option<&Value>) -> Option<ToolFacePrefixSnapshot> {
    let generation = metadata
        .and_then(|meta| meta.get(TOOL_FACE_PREFIX_GENERATION_METADATA_KEY))
        .and_then(Value::as_u64);
    let schema_digest = metadata
        .and_then(|meta| meta.get(TOOL_SCHEMA_DIGEST_METADATA_KEY))
        .and_then(Value::as_str)
        .map(str::to_string);
    let order: Vec<String> = metadata
        .and_then(|meta| meta.get(FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY))
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if generation.is_none() && schema_digest.is_none() && order.is_empty() {
        return None;
    }
    Some(ToolFacePrefixSnapshot {
        generation: generation.unwrap_or(0),
        order,
        schema_digest,
    })
}

/// 契约副本：`repo::advance_session_tool_face_prefix_with_conn` 的逻辑级
/// 镜像（不触库，返回 `true` = 生产实现会执行写库）。
///
/// - order 走 append-only merge（长度不变即无新增）；
/// - generation 只前进不回退（max，advance 本身绝不 +1）；
/// - digest 仅在快照携带时更新；
/// - 三者皆无变化时跳过写库（metadata 一个字节不动）。
fn advance_snapshot_into_metadata(
    metadata: &mut Option<Value>,
    snapshot: &ToolFacePrefixSnapshot,
) -> bool {
    let persisted = snapshot_from_metadata(metadata.as_ref());
    let persisted_generation = persisted.as_ref().map_or(0, |snap| snap.generation);
    let persisted_digest = persisted
        .as_ref()
        .and_then(|snap| snap.schema_digest.clone());
    let mut merged_order = persisted.map(|snap| snap.order).unwrap_or_default();
    let merged_len_before = merged_order.len();
    merge_frozen_tool_schema_order_baseline(&mut merged_order, &snapshot.order);
    let next_generation = persisted_generation.max(snapshot.generation);
    let next_digest = snapshot.schema_digest.clone().or(persisted_digest.clone());

    if next_generation == persisted_generation
        && merged_order.len() == merged_len_before
        && next_digest == persisted_digest
    {
        return false;
    }

    let mut object = match metadata.take() {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    object.insert(
        TOOL_FACE_PREFIX_GENERATION_METADATA_KEY.to_string(),
        Value::from(next_generation),
    );
    object.insert(
        FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY.to_string(),
        Value::Array(merged_order.into_iter().map(Value::String).collect()),
    );
    if let Some(digest) = next_digest {
        object.insert(
            TOOL_SCHEMA_DIGEST_METADATA_KEY.to_string(),
            Value::String(digest),
        );
    }
    *metadata = Some(Value::Object(object));
    true
}

// ============================================================================
// 测试构件（与 prefix_generation_fork_tests.rs 同风格）
// ============================================================================

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

/// 序列化 tools 数组为发出请求时的 JSON 字节。
fn tools_bytes(tools: &[Value]) -> Vec<u8> {
    serde_json::to_vec(tools).expect("serialize tools array")
}

/// 已收敛的会话基线 B̂ = [read_file, search]（分叉前两轮状态）。
fn established_baseline() -> Vec<String> {
    let mut baseline: Vec<String> = Vec::new();
    let mut tools = vec![
        tool_schema("search", "检索"),
        tool_schema("read_file", "读文件"),
    ];
    freeze_tool_schema_order_for_prompt_cache(&mut tools, &mut baseline);
    assert_eq!(
        baseline,
        vec!["read_file".to_string(), "search".to_string()]
    );
    baseline
}

/// 模拟一个变体从 fan-out 入口快照出发披露（或不披露）新工具，
/// 返回 (该变体本地 order, 该变体本轮实际发出的 tools 字节)。
fn variant_discloses(snapshot_baseline: &[String], disclosed: &[&str]) -> (Vec<String>, Vec<u8>) {
    let mut local_order = snapshot_baseline.to_vec();
    let mut tools: Vec<Value> = snapshot_baseline
        .iter()
        .map(|name| tool_schema(name, "基线工具"))
        .chain(
            disclosed
                .iter()
                .map(|name| tool_schema(name, "披露技能工具")),
        )
        .collect();
    freeze_tool_schema_order_for_prompt_cache(&mut tools, &mut local_order);
    let emitted_names: Vec<&str> = tools.iter().map(tool_schema_sort_key).collect();
    assert_eq!(
        emitted_names,
        local_order.iter().map(String::as_str).collect::<Vec<_>>(),
        "变体发出的 tools 名字序必须与其本地冻结基线逐位一致"
    );
    (local_order, tools_bytes(&tools))
}

/// 复演轮 T 分叉全程（A 追加 X=quiz_gen、B 追加 Y=anki_export → 收敛 →
/// 持久化），返回 (收敛后快照, 持久化后的 session.metadata)。
///
/// X 的字母序刻意**晚于** Y —— 稳态断言才能区分「轮 T 索引序收敛结果」
/// 与字母序 / 竞态序两种错误血统。
fn fork_round_t_converged_and_persisted() -> (ToolFacePrefixSnapshot, Option<Value>) {
    let session_baseline = established_baseline();
    let (variant_a_order, _) = variant_discloses(&session_baseline, &["quiz_gen"]);
    let (variant_b_order, _) = variant_discloses(&session_baseline, &["anki_export"]);

    let (generation_bump, converged_order) =
        converge_orders_by_variant_index(&[variant_a_order, variant_b_order]);
    assert_eq!(
        generation_bump, 1,
        "轮 T 前提：X ≠ Y 真分叉必须切代（第 2 轮已覆盖）"
    );
    assert_eq!(
        converged_order,
        vec!["read_file", "search", "quiz_gen", "anki_export"],
        "轮 T 前提：收敛序 = 基线 + 变体 0 尾部 X + 变体 1 尾部 Y"
    );

    let converged_snapshot = ToolFacePrefixSnapshot {
        // 分叉前 generation = 0，真分叉 Δg = 1 → 新代号 1
        generation: generation_bump,
        order: converged_order,
        schema_digest: Some("digest_g1".to_string()),
    };
    let mut metadata = Some(json!({ "authorityMode": "chat" }));
    assert!(
        advance_snapshot_into_metadata(&mut metadata, &converged_snapshot),
        "轮 T 收敛结果首次持久化必须写库"
    );
    (converged_snapshot, metadata)
}

// ============================================================================
// 1. 终局主线：轮 T+1 两变体同现 X+Y，字节一致，generation 稳定在 1
// ============================================================================

#[test]
fn after_fork_next_round_both_variants_see_x_and_y_with_stable_generation() {
    // ===== 轮 T：A 追加 X、B 追加 Y → 收敛 (g=1, B_1) 并持久化 =====
    let (converged, mut metadata) = fork_round_t_converged_and_persisted();
    let metadata_bytes_after_round_t =
        serde_json::to_string(&metadata).expect("serialize metadata after round T");

    // ===== 轮 T+1 fan-out：入口统一快照——从持久化态读回，两变体拿到
    // **同一份** (g=1, B_1)，不是各自的轮 T 本地尾部 =====
    let snapshot_t_plus_1 =
        snapshot_from_metadata(metadata.as_ref()).expect("轮 T 持久化过的会话必须能还原快照");
    assert_eq!(snapshot_t_plus_1.generation, 1, "T+1 入口快照代际 = 1");
    assert_eq!(
        snapshot_t_plus_1.order, converged.order,
        "T+1 入口基线 = 轮 T 收敛 order"
    );

    let (variant_a_order, variant_a_bytes) = variant_discloses(&snapshot_t_plus_1.order, &[]);
    let (variant_b_order, variant_b_bytes) = variant_discloses(&snapshot_t_plus_1.order, &[]);

    // ===== 核心：同现——A 看得见 B 轮 T 披露的 Y，B 看得见 A 披露的 X =====
    assert!(
        variant_a_order.iter().any(|name| name == "anki_export"),
        "变体 A 在 T+1 必须看见 B 轮 T 披露的 Y=anki_export（同现，非各见各的）"
    );
    assert!(
        variant_b_order.iter().any(|name| name == "quiz_gen"),
        "变体 B 在 T+1 必须看见 A 轮 T 披露的 X=quiz_gen（同现，非各见各的）"
    );
    assert_eq!(
        variant_a_order, variant_b_order,
        "T+1 两变体工具面逐位一致（都含 X+Y，序同）"
    );
    assert_eq!(
        variant_a_order,
        vec!["read_file", "search", "quiz_gen", "anki_export"],
        "T+1 工具面序 = 轮 T 索引序收敛血统（X 先于 Y），不是字母序"
    );
    assert_eq!(
        variant_a_bytes, variant_b_bytes,
        "T+1 两变体 tools 请求字节必须逐字节一致——同 provider/key 互蹭同一条缓存血统"
    );

    // ===== 稳态：收敛 Δg = 0，generation 稳定在 1 =====
    let (generation_bump, converged_t_plus_1) =
        converge_orders_by_variant_index(&[variant_a_order, variant_b_order]);
    assert_eq!(
        generation_bump, 0,
        "T+1 两变体尾部全等（皆空）→ 非真分叉，不切代"
    );
    assert_eq!(
        converged.generation + generation_bump,
        1,
        "generation 稳定在 1：分叉只发生一次，稳态轮绝不再 bump"
    );
    assert_eq!(
        converged_t_plus_1, converged.order,
        "T+1 收敛 order = 轮 T 基线（无变化）"
    );

    // ===== 稳态写回：advance 无变更必须跳过写库，metadata 字节不动 =====
    let steady_writeback = ToolFacePrefixSnapshot {
        generation: converged.generation,
        order: converged_t_plus_1,
        schema_digest: converged.schema_digest.clone(),
    };
    assert!(
        !advance_snapshot_into_metadata(&mut metadata, &steady_writeback),
        "T+1 无变更写回必须跳过写库（稳态热路径每轮都会走到）"
    );
    assert_eq!(
        serde_json::to_string(&metadata).expect("serialize metadata after T+1"),
        metadata_bytes_after_round_t,
        "稳态轮 metadata 必须一个字节不动（自然不推 updated_at）"
    );
}

// ============================================================================
// 2. 多轮 + 索引洗牌：generation 恒 1、order 字节恒等，稳态不随轮数漂移
// ============================================================================

#[test]
fn steady_state_survives_many_rounds_and_variant_index_shuffles() {
    let (converged, _) = fork_round_t_converged_and_persisted();
    let baseline_bytes = {
        let (_, bytes) = variant_discloses(&converged.order, &[]);
        bytes
    };

    let mut generation = converged.generation;
    let mut baseline = converged.order.clone();

    // T+1..T+4 连续四轮空轮：偶数轮按 [A, B] 索引序收敛、奇数轮洗牌成
    // [B, A]——稳态下两变体 order 全等，索引分配怎么抖收敛结果都不变。
    for round in 1..=4u64 {
        let (variant_a_order, variant_a_bytes) = variant_discloses(&baseline, &[]);
        let (variant_b_order, variant_b_bytes) = variant_discloses(&baseline, &[]);
        assert_eq!(
            variant_a_bytes, baseline_bytes,
            "第 T+{round} 轮变体 A 字节必须与稳态基线字节逐字节一致"
        );
        assert_eq!(
            variant_b_bytes, baseline_bytes,
            "第 T+{round} 轮变体 B 字节必须与稳态基线字节逐字节一致"
        );

        let inputs = if round % 2 == 0 {
            [variant_a_order, variant_b_order]
        } else {
            [variant_b_order, variant_a_order]
        };
        let (generation_bump, converged_order) = converge_orders_by_variant_index(&inputs);
        assert_eq!(
            generation_bump,
            0,
            "第 T+{round} 轮（索引洗牌={}）不得切代",
            round % 2 != 0
        );
        generation += generation_bump;
        assert_eq!(
            converged_order, baseline,
            "第 T+{round} 轮收敛 order 必须与稳态基线逐位一致"
        );
        baseline = converged_order;
    }

    assert_eq!(generation, 1, "四轮空轮 + 索引洗牌后 generation 仍恒为 1");
    assert_eq!(
        baseline,
        vec!["read_file", "search", "quiz_gen", "anki_export"],
        "四轮后 order 仍是轮 T 收敛血统，X+Y 同现且序不漂移"
    );
}

// ============================================================================
// 3. 跨进程稳态：轮 T 与 T+1 之间重启，恢复后两变体依然同现 X+Y、g=1
// ============================================================================

#[test]
fn restart_between_fork_and_next_round_preserves_xy_visibility_and_generation() {
    use std::collections::HashMap;

    const SESSION_ID: &str = "sess_fork_finale_restart";

    // 轮 T 收敛 + 持久化后，内存 HashMap 里有热 entry
    let (converged, metadata) = fork_round_t_converged_and_persisted();
    let mut memory_map: HashMap<String, ToolFacePrefixSnapshot> = HashMap::new();
    memory_map.insert(SESSION_ID.to_string(), converged.clone());

    // ===== 模拟桌面 App 重启：进程内存清空，只剩 DB =====
    memory_map.clear();
    assert!(memory_map.is_empty(), "重启后内存基线必须为空（前置条件）");

    // 恢复路径：内存 miss → 读 metadata（provider 侧 prompt cache 跨进程
    // 存活，禁止字母序冷重建、禁止 generation 归零）
    let restored = snapshot_from_metadata(metadata.as_ref())
        .expect("轮 T 持久化过的会话重启后必须能从 metadata 还原快照");
    assert_eq!(
        restored.generation, 1,
        "恢复的 generation 必须仍是 1，禁止归零回退"
    );
    assert_eq!(
        restored.order, converged.order,
        "恢复的 order 必须与轮 T 收敛结果逐项一致（X 先于 Y 的索引序血统）"
    );
    assert_ne!(
        restored.order,
        vec!["anki_export", "quiz_gen", "read_file", "search"],
        "禁止按字母序冷重建——那会打碎已发出的缓存前缀"
    );
    memory_map.insert(SESSION_ID.to_string(), restored.clone());

    // ===== 重启后的 T+1：两变体从恢复快照出发，同现 X+Y、字节一致、不切代 =====
    let (variant_a_order, variant_a_bytes) = variant_discloses(&restored.order, &[]);
    let (variant_b_order, variant_b_bytes) = variant_discloses(&restored.order, &[]);
    assert!(
        variant_a_order.iter().any(|name| name == "quiz_gen")
            && variant_a_order.iter().any(|name| name == "anki_export"),
        "重启后变体 A 依然同现 X+Y"
    );
    assert_eq!(
        variant_a_order, variant_b_order,
        "重启后两变体工具面仍逐位一致"
    );
    assert_eq!(
        variant_a_bytes, variant_b_bytes,
        "重启后两变体字节仍逐字节一致"
    );

    let (generation_bump, converged_after_restart) =
        converge_orders_by_variant_index(&[variant_a_order, variant_b_order]);
    assert_eq!(generation_bump, 0, "重启不是分叉：恢复后的稳态轮不得切代");
    assert_eq!(
        restored.generation + generation_bump,
        1,
        "跨进程 generation 稳定在 1"
    );
    assert_eq!(converged_after_restart, converged.order);
}

// ============================================================================
// 4. 迟到写回免疫：分叉前旧快照写回不得回退稳态
// ============================================================================

#[test]
fn stale_pre_fork_writeback_cannot_regress_steady_state() {
    let (converged, mut metadata) = fork_round_t_converged_and_persisted();
    let steady_bytes = serde_json::to_string(&metadata).expect("serialize steady-state metadata");

    // 掉队变体 B 在收敛完成后才写回它轮 T 的本地快照：generation 还是
    // 分叉前的 0，order 是 B̂ + [Y]（收敛 order 的**子集**，Y 已在稳态
    // 基线里）。这是 join 收敛与迟到 store 的天然竞态窗口。
    let stale = ToolFacePrefixSnapshot {
        generation: 0,
        order: vec![
            "read_file".to_string(),
            "search".to_string(),
            "anki_export".to_string(),
        ],
        schema_digest: None,
    };
    assert!(
        !converged.order.starts_with(stale.order.as_slice()),
        "前提：旧快照不是稳态 order 的前缀（Y 在稳态里排 X 之后），但名字全是子集"
    );
    assert!(
        !advance_snapshot_into_metadata(&mut metadata, &stale),
        "迟到写回：generation 取 max(1,0)=1 不回退、order merge 无新增、digest 不抹——三者皆无变化必须跳过写库"
    );
    assert_eq!(
        serde_json::to_string(&metadata).expect("serialize metadata after stale writeback"),
        steady_bytes,
        "迟到写回后稳态 metadata 必须一个字节不动"
    );

    // 稳态未被污染：下一轮 fan-out 两变体照常同现 X+Y、g=1
    let after = snapshot_from_metadata(metadata.as_ref()).expect("稳态快照仍可还原");
    assert_eq!(after.generation, 1, "迟到写回绝不把 generation 拉回 0");
    assert_eq!(
        after.order,
        vec!["read_file", "search", "quiz_gen", "anki_export"],
        "迟到写回绝不重排稳态 order（X 仍先于 Y）"
    );
    let (variant_a_order, variant_a_bytes) = variant_discloses(&after.order, &[]);
    let (variant_b_order, variant_b_bytes) = variant_discloses(&after.order, &[]);
    assert_eq!(
        variant_a_order, variant_b_order,
        "后轮两变体仍同现 X+Y，序一致"
    );
    assert_eq!(
        variant_a_bytes, variant_b_bytes,
        "后轮两变体字节仍逐字节一致"
    );
    let (generation_bump, _) =
        converge_orders_by_variant_index(&[variant_a_order, variant_b_order]);
    assert_eq!(
        generation_bump, 0,
        "稳态延续：generation 稳定在 1，不再切代"
    );
}
