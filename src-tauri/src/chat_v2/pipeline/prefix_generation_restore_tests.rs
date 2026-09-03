//! Wave2-A 第 2 轮 #6：tools 前缀代际「恢复」反例测试（只写不跑）。
//!
//! ⚠️ 本文件为测试源码交付物：**只落盘、不执行**（本轮铁律禁止 cargo /
//! 任何测试执行）。模块声明（`#[cfg(test)] mod prefix_generation_restore_tests;`）
//! 由父代理在 `pipeline.rs` 接线。
//!
//! ## 预期覆盖（对应 r1-multi-variant-design.md §4 方案 A）
//!
//! 1. **跨进程恢复**：内存 HashMap（`helpers.rs:1017-1081` 的
//!    `frozen_tool_schema_orders`，值型将升级为带 generation 的快照）被清空
//!    （模拟桌面 App 重启）后，从 session.metadata 恢复的
//!    `ToolFacePrefixSnapshot` 必须与清空前 **generation + order 逐项一致**
//!    ——provider 侧 prompt cache 跨进程存活，禁止按字母序冷重建、禁止
//!    generation 归零回退。
//! 2. **并发首建收敛**：两个调用同时内存 miss 时必须收敛到**同一条**
//!    generation=0 基线（先写 wins、后写 append-only merge 不 bump），
//!    禁止双写各自建 generation / 各建各的 entry。
//! 3. **无变更跳过写库**（逻辑级）：advance 在 generation、order、digest
//!    三者均无变化时必须跳过写库且**不视为切代**（不推 `updated_at`，
//!    metadata 字节原样）。
//!
//! ## 生产类型对齐说明
//!
//! `ToolFacePrefixSnapshot` 与三个 metadata 键常量（`toolFacePrefixGeneration`
//! / `frozenToolSchemaOrder` / `toolSchemaDigest`）直接 import #4 已落地的
//! `types.rs` 生产定义；append-only 合并原语直接复用生产
//! `tool_loop::merge_frozen_tool_schema_order_baseline`——测试与生产语义
//! 永不漂移。仍保留两处 DB-free 的**逻辑级契约副本**（生产版需要 SQLite
//! `Connection`，本模块按任务卡要求做纯逻辑推演）：
//!
//! | 本文件契约副本 | 对齐的生产项（#4 已落地） |
//! | --- | --- |
//! | `snapshot_from_metadata` | `repo.rs:96` `tool_face_prefix_from_metadata`（经 `get_session_tool_face_prefix(_with_conn)` 暴露；缺代际键 generation 视为 0、order 回退 `frozenToolSchemaOrder`、三键全缺 None） |
//! | `advance_snapshot_into_metadata` | `repo.rs:2977` `advance_session_tool_face_prefix_with_conn`（IMMEDIATE、多键同事务、无变更跳过、不推 `updated_at`） |
//! | `locked_refill_baseline` | #1 席位待交付的 `helpers::load_session_tool_face_prefix` 加锁回填段（现有 `helpers.rs:1038-1046` 的 `entry().or_default()` + append-only merge 语义，值型升级为快照）；落地后应改调生产函数，断言原样保留 |

use std::collections::HashMap;

use serde_json::{json, Value};

use super::tool_loop::merge_frozen_tool_schema_order_baseline;
use crate::chat_v2::types::{
    ToolFacePrefixSnapshot, FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY,
    TOOL_FACE_PREFIX_GENERATION_METADATA_KEY, TOOL_SCHEMA_DIGEST_METADATA_KEY,
};

// ============================================================================
// 逻辑级契约副本（DB-free，对齐关系见文件头表格）
// ============================================================================

/// 契约副本：`repo::tool_face_prefix_from_metadata` 的读路径。
///
/// 语义（与 repo.rs:96-113 逐条对齐）：缺 `toolFacePrefixGeneration` 键时
/// generation 视为 0（旧会话兼容）；order 回退既有 `frozenToolSchemaOrder`
/// 键；digest 缺键为 None；三个来源全缺返回 None（会话首轮语义）。
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
/// 镜像（本测试不触库，返回 `true` = 生产实现会执行写库）。
///
/// 语义（与 repo.rs:2977-3031 逐条对齐）：
/// - order 走 append-only merge（复用生产 `merge_frozen_tool_schema_order_baseline`，
///   长度不变即无新增）；
/// - generation 只前进不回退（取持久化值与入参的 max；advance 本身绝不
///   +1，切代判定只属于 converge 收敛点）；
/// - digest 仅在快照携带时更新，快照无 digest 不抹掉已持久化值；
/// - **三者皆无变化时跳过写库**（返回 `false` 且 metadata 一个字节不动，
///   自然也不推 `updated_at`）；
/// - 写库时只 merge 本簇键，authority / plan / branchedFrom 等其他键
///   原样保留。
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
        // 无变更：跳过写库，不推 updated_at，不视为切代
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

/// 契约副本：内存 miss 后的加锁回填段（#1 落地
/// `helpers::load_session_tool_face_prefix` 后应改调生产函数）。
///
/// 语义（对应现有 `helpers.rs:1038-1046`，值型升级为快照）：
/// - `entry().or_default()`——**先写 wins**：entry 已存在时绝不覆盖、
///   绝不重排既有 order（放锁读库期间并行调用可能已建基线）；
/// - 后写只做 append-only merge（只补缺失名）；
/// - generation 只单调采纳（`max`），后写**不 bump**——并发首建双方都
///   带 generation=0，合并后仍是 0，禁止「各建各的代际」；
/// - digest 只填空位，不覆盖已建立值。
fn locked_refill_baseline(
    map: &mut HashMap<String, ToolFacePrefixSnapshot>,
    session_id: &str,
    persisted: &ToolFacePrefixSnapshot,
) -> ToolFacePrefixSnapshot {
    let entry = map.entry(session_id.to_string()).or_default();
    merge_frozen_tool_schema_order_baseline(&mut entry.order, &persisted.order);
    entry.generation = entry.generation.max(persisted.generation);
    if entry.schema_digest.is_none() {
        entry.schema_digest = persisted.schema_digest.clone();
    }
    entry.clone()
}

// ============================================================================
// 1. 清内存 HashMap 后从 metadata 恢复同一 generation + order
// ============================================================================

#[test]
fn cleared_memory_map_restores_same_generation_and_order_from_metadata() {
    const SESSION_ID: &str = "sess_restore_after_restart";

    // ===== 重启前：会话已推进到 generation=3、非字母序基线（zeta 在最前，
    // 还原顺序全靠持久化，字母序冷重建必然打碎） =====
    let before = ToolFacePrefixSnapshot {
        generation: 3,
        order: vec![
            "zeta_tool".to_string(),
            "alpha_tool".to_string(),
            "beta_tool".to_string(),
        ],
        schema_digest: Some("digest_v3".to_string()),
    };
    let mut memory_map: HashMap<String, ToolFacePrefixSnapshot> = HashMap::new();
    memory_map.insert(SESSION_ID.to_string(), before.clone());

    // 持久化进 session.metadata（与 authority 等既有键共存）
    let mut metadata = Some(json!({
        "authorityMode": "plan",
        "workspace_id": "ws_1",
    }));
    assert!(
        advance_snapshot_into_metadata(&mut metadata, &before),
        "首次持久化必须写库"
    );

    // ===== 模拟桌面 App 重启：进程内存 HashMap 清空，只剩 DB =====
    memory_map.clear();
    assert!(memory_map.is_empty(), "重启后内存基线必须为空（前置条件）");

    // ===== 恢复路径：内存 miss → 读 metadata → 加锁回填 =====
    let persisted = snapshot_from_metadata(metadata.as_ref())
        .expect("持久化过的会话必须能从 metadata 还原快照");
    let restored = locked_refill_baseline(&mut memory_map, SESSION_ID, &persisted);

    // 核心断言：恢复快照与清空前逐项一致
    assert_eq!(
        restored.generation, before.generation,
        "恢复的 generation 必须与重启前一致，禁止归零回退（否则收敛点误判切代）"
    );
    assert_eq!(
        restored.order, before.order,
        "恢复的 order 必须与重启前逐项一致，禁止字母序冷重建"
    );
    assert_eq!(restored, before, "整快照（含 digest）必须恢复原值");
    assert_eq!(
        memory_map.get(SESSION_ID),
        Some(&before),
        "恢复后内存 entry 必须回填为重启前快照"
    );
    // 字节级双保险：order 序列化字节逐字相等（provider 缓存以字节为准）
    assert_eq!(
        serde_json::to_vec(&restored.order).expect("serialize restored order"),
        serde_json::to_vec(&before.order).expect("serialize order before restart"),
        "恢复的 tools 序字节必须与重启前逐字节一致"
    );

    // ===== 生产 struct 的 JSON 往返（types::ToolFacePrefixSnapshot，
    // 兼作 VariantMeta::tool_face_prefix 重放快照的 wire 形态回归） =====
    let raw = serde_json::to_string(&before).expect("serialize snapshot");
    let roundtripped: ToolFacePrefixSnapshot =
        serde_json::from_str(&raw).expect("deserialize snapshot");
    assert_eq!(
        roundtripped, before,
        "ToolFacePrefixSnapshot 必须经 JSON 往返无损（generation + order + digest）"
    );
    assert!(
        raw.contains("\"schemaDigest\""),
        "快照 serde 走 camelCase（rename_all），digest 字段 wire 名为 schemaDigest"
    );

    // ===== metadata 键名合同 + 其他键共存 =====
    let object = metadata
        .as_ref()
        .and_then(Value::as_object)
        .expect("metadata 应为 JSON 对象");
    assert_eq!(
        object
            .get(TOOL_FACE_PREFIX_GENERATION_METADATA_KEY)
            .and_then(Value::as_u64),
        Some(3),
        "代际必须落在 toolFacePrefixGeneration 键"
    );
    assert_eq!(
        object
            .get(FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY)
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(3),
        "order 必须落在既有 frozenToolSchemaOrder 键（旧读路径不丢序）"
    );
    assert_eq!(
        object.get("authorityMode").and_then(Value::as_str),
        Some("plan"),
        "advance 只 merge 本簇键，authority 等其他 metadata 键必须原样保留"
    );
    assert_eq!(
        object.get("workspace_id").and_then(Value::as_str),
        Some("ws_1")
    );

    // ===== 旧会话兼容：缺代际键时 generation 视为 0、order 回退旧键 =====
    let legacy_metadata = json!({
        FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY: ["zeta_tool", "alpha_tool"],
    });
    let legacy = snapshot_from_metadata(Some(&legacy_metadata))
        .expect("有旧键 frozenToolSchemaOrder 的会话必须能还原快照");
    assert_eq!(
        legacy.generation, 0,
        "缺 toolFacePrefixGeneration 键的旧会话 generation 必须视为 0"
    );
    assert_eq!(
        legacy.order,
        vec!["zeta_tool".to_string(), "alpha_tool".to_string()],
        "旧会话 order 必须回退到既有 frozenToolSchemaOrder 键（不丢首见序）"
    );

    // 三键全缺 = 会话首轮语义（None，由首次 freeze 建立基线）
    assert_eq!(
        snapshot_from_metadata(Some(&json!({ "authorityMode": "chat" }))),
        None,
        "从未冻结过 tools 状态的会话必须解析为 None（首轮语义）"
    );
}

// ============================================================================
// 2. 并发首建：两个调用同时 miss 必须收敛同一 generation=0 基线
// ============================================================================

/// 确定性模拟两个调用的并发首建竞态窗口：
/// 双方都在对方回填前完成内存 miss 判定 + 读库（拿到同一 `persisted`），
/// 随后按 `first_writer_is_a` 指定的顺序串行进入加锁回填段——
/// 「先写 wins / 后写 append-only merge 不 bump」，不必真起线程。
fn simulate_concurrent_first_load(
    persisted: &ToolFacePrefixSnapshot,
    first_writer_is_a: bool,
) -> (
    HashMap<String, ToolFacePrefixSnapshot>,
    ToolFacePrefixSnapshot,
    ToolFacePrefixSnapshot,
) {
    const SESSION_ID: &str = "sess_concurrent_first_build";
    let mut map: HashMap<String, ToolFacePrefixSnapshot> = HashMap::new();

    // 竞态窗口前置：双方检查内存均 miss（对应 helpers.rs:1018-1025 提前
    // 返回未命中），随后各自无锁读库拿到同一 persisted 快照
    assert!(!map.contains_key(SESSION_ID), "调用 A 必须内存 miss");
    assert!(!map.contains_key(SESSION_ID), "调用 B 必须内存 miss");

    let first_result = locked_refill_baseline(&mut map, SESSION_ID, persisted);
    let second_result = locked_refill_baseline(&mut map, SESSION_ID, persisted);
    let (result_a, result_b) = if first_writer_is_a {
        (first_result, second_result)
    } else {
        (second_result, first_result)
    };
    (map, result_a, result_b)
}

#[test]
fn concurrent_first_build_converges_to_single_generation_zero_baseline() {
    // ===== 场景 1：全新会话（metadata 无任何冻结键 → None → 默认空基线）
    // 双调用同时 miss =====
    let fresh_persisted =
        snapshot_from_metadata(Some(&json!({ "authorityMode": "chat" }))).unwrap_or_default();
    assert_eq!(fresh_persisted.generation, 0, "全新会话基线代际必须是 0");
    assert!(fresh_persisted.order.is_empty());

    for first_writer_is_a in [true, false] {
        let (map, result_a, result_b) =
            simulate_concurrent_first_load(&fresh_persisted, first_writer_is_a);

        assert_eq!(
            map.len(),
            1,
            "并发首建只允许收敛出一条会话 entry，禁止双写各建各的"
        );
        let converged = map.values().next().expect("唯一 entry").clone();
        assert_eq!(
            converged.generation, 0,
            "并发首建必须收敛到 generation=0 基线，后写 merge 不 bump"
        );
        assert_eq!(
            result_a, result_b,
            "两个调用必须拿到同一快照（先写 wins，后写 merge 后与先写一致）"
        );
        assert_eq!(result_a, converged, "调用返回值必须等于收敛后的共享 entry");
    }

    // ===== 场景 2：重启后旧会话（persisted 有 order、缺代际键 → generation 0）
    // 双调用同时 miss：两种加锁先后序必须收敛到完全相同的终态 =====
    let legacy_persisted = snapshot_from_metadata(Some(&json!({
        FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY: ["zeta_tool", "alpha_tool"],
    })))
    .expect("旧会话必须能还原快照");
    assert_eq!(legacy_persisted.generation, 0);

    let (map_a_first, a1, b1) = simulate_concurrent_first_load(&legacy_persisted, true);
    let (map_b_first, a2, b2) = simulate_concurrent_first_load(&legacy_persisted, false);

    let converged_a_first = map_a_first
        .values()
        .next()
        .expect("A 先写：唯一 entry")
        .clone();
    let converged_b_first = map_b_first
        .values()
        .next()
        .expect("B 先写：唯一 entry")
        .clone();
    assert_eq!(
        converged_a_first, converged_b_first,
        "加锁先后序（完成竞态序）不得影响收敛终态——恢复必须确定性"
    );
    assert_eq!(
        converged_a_first.generation, 0,
        "两次 merge 同一 persisted 基线绝不产生代际 bump"
    );
    assert_eq!(
        converged_a_first.order,
        vec!["zeta_tool".to_string(), "alpha_tool".to_string()],
        "后写 merge 必须幂等：不重复追加、不重排持久化首见序"
    );
    assert_eq!(a1, b1, "A 先写时两调用快照一致");
    assert_eq!(a2, b2, "B 先写时两调用快照一致");
    assert_eq!(a1, a2, "跨交错序两调用快照也必须一致");
}

// ============================================================================
// 3. advance 无变更跳过写库（逻辑级）：不写库、不切代
// ============================================================================

#[test]
fn advance_skips_write_when_generation_order_digest_unchanged() {
    // 建立已持久化态：generation=2 + 双工具 order + digest
    let persisted_snapshot = ToolFacePrefixSnapshot {
        generation: 2,
        order: vec!["zeta_tool".to_string(), "alpha_tool".to_string()],
        schema_digest: Some("digest_v2".to_string()),
    };
    let mut metadata = Some(json!({
        "authorityMode": "plan",
        "plan": { "batchId": "batch_1" },
    }));
    assert!(
        advance_snapshot_into_metadata(&mut metadata, &persisted_snapshot),
        "首次落库必须写"
    );
    let bytes_after_first_write =
        serde_json::to_string(&metadata).expect("serialize metadata after first write");

    // ===== 核心：generation、order、digest 三者均无变化 → 跳过写库 =====
    let wrote = advance_snapshot_into_metadata(&mut metadata, &persisted_snapshot);
    assert!(
        !wrote,
        "无变更（generation + order + digest 全同）必须跳过写库——发送热路径每个稳定窗口都会调用"
    );
    assert_eq!(
        serde_json::to_string(&metadata).expect("serialize metadata after skip"),
        bytes_after_first_write,
        "跳过写库时 metadata 必须一个字节都不动（自然不推 updated_at）"
    );
    assert_eq!(
        snapshot_from_metadata(metadata.as_ref())
            .expect("已持久化会话必须能还原快照")
            .generation,
        2,
        "无变更绝不视为切代：generation 必须原地不动"
    );

    // 子集写回（并行调用带旧的 order 前缀子集）同样视为无变更：
    // append-only merge 后 order 无新增 → 跳过
    let subset = ToolFacePrefixSnapshot {
        generation: 2,
        order: vec!["zeta_tool".to_string()],
        schema_digest: Some("digest_v2".to_string()),
    };
    assert!(
        !advance_snapshot_into_metadata(&mut metadata, &subset),
        "order 子集 merge 后无新增，必须同样跳过写库"
    );

    // 快照不带 digest（单变体路径尚未启用字节冻结）也不构成变更：
    // 不得抹掉已持久化 digest，更不得触发写库
    let digestless = ToolFacePrefixSnapshot {
        generation: 2,
        order: vec!["zeta_tool".to_string(), "alpha_tool".to_string()],
        schema_digest: None,
    };
    assert!(
        !advance_snapshot_into_metadata(&mut metadata, &digestless),
        "快照无 digest 时沿用已持久化值，无其他变化必须跳过写库"
    );
    assert_eq!(
        snapshot_from_metadata(metadata.as_ref())
            .and_then(|snap| snap.schema_digest)
            .as_deref(),
        Some("digest_v2"),
        "无 digest 的写回绝不抹掉已持久化 digest"
    );

    // ===== 对照组 1：纯前缀扩展（追加新名）→ 写库但不 bump generation =====
    let extended = ToolFacePrefixSnapshot {
        generation: 2,
        order: vec![
            "zeta_tool".to_string(),
            "alpha_tool".to_string(),
            "beta_tool".to_string(),
        ],
        schema_digest: Some("digest_v2".to_string()),
    };
    assert!(
        advance_snapshot_into_metadata(&mut metadata, &extended),
        "order 追加新名属于变更，必须写库"
    );
    let after_extend = snapshot_from_metadata(metadata.as_ref()).expect("扩展后必须能还原快照");
    assert_eq!(
        after_extend.generation, 2,
        "纯前缀扩展绝不 bump generation——切代判定只属于 converge 收敛点"
    );
    assert_eq!(
        after_extend.order,
        vec![
            "zeta_tool".to_string(),
            "alpha_tool".to_string(),
            "beta_tool".to_string(),
        ],
        "扩展只追加末尾，已发出前缀不重排"
    );

    // ===== 对照组 2：仅 digest 变化 → 写库但 generation 仍不动 =====
    let digest_changed = ToolFacePrefixSnapshot {
        generation: 2,
        order: after_extend.order.clone(),
        schema_digest: Some("digest_v3".to_string()),
    };
    assert!(
        advance_snapshot_into_metadata(&mut metadata, &digest_changed),
        "digest 变化属于变更，必须写库"
    );
    let after_digest =
        snapshot_from_metadata(metadata.as_ref()).expect("digest 更新后必须能还原快照");
    assert_eq!(
        after_digest.generation, 2,
        "digest 变化本身不等于切代（单变体路径记录意图即可，不盲目 +1）"
    );
    assert_eq!(after_digest.schema_digest.as_deref(), Some("digest_v3"));

    // ===== 全程：其他 metadata 键必须原样共存 =====
    let object = metadata
        .as_ref()
        .and_then(Value::as_object)
        .expect("metadata 应为 JSON 对象");
    assert_eq!(
        object.get("authorityMode").and_then(Value::as_str),
        Some("plan"),
        "advance 全程只 merge 本簇键，authority 键不得被覆盖"
    );
    assert_eq!(
        object
            .get("plan")
            .and_then(|plan| plan.get("batchId"))
            .and_then(Value::as_str),
        Some("batch_1")
    );
}
