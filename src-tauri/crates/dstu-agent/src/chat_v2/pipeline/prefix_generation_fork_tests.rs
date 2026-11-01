//! 反例测试：多变体 tools 前缀分叉 → fan-out 统一代际收敛（Wave2-A R2 #5）
//!
//! 依据 `docs/dev/wave2-A/r1-multi-variant-design.md` 第 1 节分叉序列与
//! `docs/dev/wave2-A/ROUND-02-TASKS.md` API 合同（方案 A，第 1 轮已裁定）。
//! 本模块由 `pipeline.rs` 的 `#[cfg(test)] mod prefix_generation_fork_tests;`
//! 声明（接线由父代理完成），仅在测试构建时编译。**只写不跑。**
//!
//! ## 预期（会红的是旧行为 / 会绿的是方案 A）
//!
//! 旧行为（`multi_variant.rs:1275` 变体内各自 load + `:1683` 中途 store，
//! 按任务完成竞态序 append-only merge，无 generation 概念）下会红：
//! - `divergent_variant_tails_x_vs_y_converge_by_variant_index_and_bump_generation`
//!   —— 旧路径合并序由完成竞态抽签（`[…,X,Y]` 或 `[…,Y,X]` 二选一，不可
//!   复现），且没有任何代际信号告知下游「前缀血统已分叉」；本测试断言
//!   收敛序由**变体索引序**唯一确定、且真分叉必须 `generation += 1`，
//!   旧行为无法同时满足这两条。
//!
//! 方案 A（fan-out 入口统一快照 + join 收敛点按变体索引序确定性合并 +
//! 真分叉切代）下三条测试全绿：
//! - 真分叉：收敛序 = 基线 + 变体 0 尾部 + 变体 1 尾部（索引序，非完成序、
//!   非字母序），generation 0 → 1；重复收敛幂等不再 bump；
//! - 单写者纯前缀扩展：永不切代，generation 保持 0；
//! - T+1 轮：全体变体从同一 generation=1 基线出发，字节一致、不再分叉、
//!   不再切代；
//! - T+2 终局（第 7 轮 #1 补强）：从分叉轮 T 起连跑完整时间线，T+2 稳态
//!   下两变体**同序同代**——generation 恒 1（整条时间线只切一次代）、
//!   order 与轮 T 收敛基线逐位一致、请求字节跨变体且跨轮（T+1 vs T+2）
//!   逐字节全等，缓存血统自 T+1 起再无任何漂移。
//!
//! ## 契约副本说明
//!
//! `converge_orders_by_variant_index` 是可静态推演的**契约副本**（纯函数，
//! 语义 = ROUND-02-TASKS.md「切代规则」+ 设计稿 4.2 收敛伪码）。
//! **产品实现落地后（#1 席位交付 `helpers.rs`），本文件应改为调用
//! `helpers::converge_session_tool_face_prefix`**（`// expected API`，
//! 配套 `types::ToolFacePrefixSnapshot` 与 `repo::advance_session_tool_face_prefix`），
//! 届时删除本副本，断言原样保留。

use serde_json::{json, Value};

use super::tool_loop::{
    freeze_tool_schema_order_for_prompt_cache, merge_frozen_tool_schema_order_baseline,
    tool_schema_sort_key,
};

// ============================================================================
// 契约副本：按变体索引序收敛 + 真分叉切代判定
// ============================================================================

/// 契约副本（产品落地后改为调用 `helpers::converge_session_tool_face_prefix`）。
///
/// 入参 `baselines`：**按变体索引序**排列的各变体本地 order（每个都是
/// 「fan-out 入口快照基线 + 本地 append-only 尾部」的完整序列）。
/// 返回 `(Δg, 收敛后 order)`：
///
/// - 收敛 order：从空表出发，按变体索引序逐个做 append-only 合并
///   （`merge_frozen_tool_schema_order_baseline` 语义：缺失名按来源顺序
///   追加末尾，绝不删除/重排）——合并序由索引序唯一确定，与任务完成
///   竞态无关；
/// - Δg ∈ {0, 1}：若每个变体的本地 order 都是收敛 order 的前缀（纯前缀
///   扩展，收敛结果对每个写者都是其已发出字节的 append-only 延伸），
///   则 Δg = 0 不切代；只要存在一个变体的本地 order 不是收敛 order 的
///   前缀（≥2 变体产生互异、不可 append-only 对齐的尾部，即真分叉），
///   则 Δg = 1。调用方以 `generation + Δg` 得新代号。
///
/// 单变体（`baselines.len() == 1`）时收敛 order 恒等于该变体本地 order，
/// 前缀检查恒真 → Δg 恒为 0，「单变体路径永不因扩展而切代」由构造保证。
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

// ============================================================================
// 测试构件（与 prefix_snapshot_tests.rs 同风格）
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

/// 已收敛的会话基线 B̂ = [read_file, search]（设计稿第 1 节的两轮前状态）。
/// 用空基线首轮 freeze 建立（G6 字母序），与产品路径同构。
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

/// 模拟一个变体在环内经 load_skills 披露新工具：从 fan-out 入口快照的
/// 基线副本出发，freeze 全量工具面（基线内按冻结序、新名追加末尾），
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

// ============================================================================
// 1. 真分叉：A 追加 X、B 追加 Y → 按变体索引序收敛 + generation 0 → 1
// ============================================================================

#[test]
fn divergent_variant_tails_x_vs_y_converge_by_variant_index_and_bump_generation() {
    // 设会话已收敛 (generation = 0, B̂ = [read_file, search])，缓存已热。
    let generation_before: u64 = 0;
    let session_baseline = established_baseline();

    // fan-out 入口统一快照：两个变体从同一字节基线出发（方案 A 前提；
    // 旧行为里 :1275 的变体内独立 load 连这一点都无法保证）。
    // 变体 A（索引 0）环内披露 X = quiz_gen；变体 B（索引 1）披露
    // Y = anki_export。刻意让 X 的字母序**晚于** Y —— 这样才能区分
    // 「变体索引序」与「字母序 / 完成竞态序」三种合并策略。
    let (variant_a_order, _) = variant_discloses(&session_baseline, &["quiz_gen"]);
    let (variant_b_order, _) = variant_discloses(&session_baseline, &["anki_export"]);
    assert_eq!(
        variant_a_order,
        vec!["read_file", "search", "quiz_gen"],
        "变体 A 本地 order = B̂ + [X]"
    );
    assert_eq!(
        variant_b_order,
        vec!["read_file", "search", "anki_export"],
        "变体 B 本地 order = B̂ + [Y]"
    );

    // ===== 反例：旧 append-only 按「完成竞态序」merge，结果由抽签决定 =====
    // A 先完成写回 → […, X, Y]；B 先完成写回 → […, Y, X]。两个竞态结局
    // 互不相等：同一份输入、两种可能输出，序不确定且跨进程固化。
    let mut race_a_first = session_baseline.clone();
    merge_frozen_tool_schema_order_baseline(&mut race_a_first, &variant_a_order);
    merge_frozen_tool_schema_order_baseline(&mut race_a_first, &variant_b_order);
    let mut race_b_first = session_baseline.clone();
    merge_frozen_tool_schema_order_baseline(&mut race_b_first, &variant_b_order);
    merge_frozen_tool_schema_order_baseline(&mut race_b_first, &variant_a_order);
    assert_eq!(
        race_a_first,
        vec!["read_file", "search", "quiz_gen", "anki_export"]
    );
    assert_eq!(
        race_b_first,
        vec!["read_file", "search", "anki_export", "quiz_gen"]
    );
    assert_ne!(
        race_a_first, race_b_first,
        "旧行为：合并序由 store 完成竞态抽签，[…,X,Y] 与 […,Y,X] 皆可能——不可复现"
    );

    // ===== 方案 A：join 收敛点按变体索引序确定性合并（A=0 先于 B=1）=====
    // expected API（#1 落地后替换）：
    //   pipeline.converge_session_tool_face_prefix(session_id, &[variant_a_order, variant_b_order])
    //     -> ToolFaceBaseline { generation, order, schema_digest }
    let (generation_bump, converged_order) =
        converge_orders_by_variant_index(&[variant_a_order.clone(), variant_b_order.clone()]);
    let generation_after = generation_before + generation_bump;

    assert_eq!(
        converged_order,
        vec!["read_file", "search", "quiz_gen", "anki_export"],
        "收敛序 = 基线 + 变体 0 尾部 X + 变体 1 尾部 Y（索引序），与完成竞态无关"
    );
    assert_ne!(
        converged_order,
        vec!["read_file", "search", "anki_export", "quiz_gen"],
        "收敛序由变体索引序决定，不是字母序也不是 B 先完成的竞态序"
    );
    assert_eq!(generation_bump, 1, "X ≠ Y 互不为前缀 → 真分叉必须切代");
    assert_eq!(generation_after, 1, "generation 从 0 bump 到 1");

    // 收敛对基线仍是 append-only：已发出前缀不吞不排。
    assert!(
        converged_order.starts_with(&session_baseline),
        "收敛结果必须保持 B̂ 为前缀（append-only 不变式不破）"
    );

    // 幂等：对已收敛结果重复收敛（两变体都持有新基线）不再 bump。
    let (rerun_bump, rerun_order) =
        converge_orders_by_variant_index(&[converged_order.clone(), converged_order.clone()]);
    assert_eq!(rerun_bump, 0, "重复收敛幂等，不得再次切代");
    assert_eq!(rerun_order, converged_order);
}

// ============================================================================
// 2. 单写者纯前缀扩展：永不切代
// ============================================================================

#[test]
fn single_variant_prefix_extension_does_not_bump_generation() {
    let generation_before: u64 = 0;
    let session_baseline = established_baseline();

    // 单变体环内披露 Z：本地 order 是基线的纯前缀扩展（单写者天然无分叉）。
    let (single_variant_order, _) = variant_discloses(&session_baseline, &["zip_export"]);
    assert_eq!(
        single_variant_order,
        vec!["read_file", "search", "zip_export"]
    );

    // expected API（#1 落地后替换）：单变体路径继续走
    //   store_session_frozen_tool_schema_order（tool_loop.rs:992 语义不变，
    //   只动 order 不动 generation）；收敛原语对单变体输入亦须为 no-bump。
    let (generation_bump, converged_order) =
        converge_orders_by_variant_index(&[single_variant_order.clone()]);
    let generation_after = generation_before + generation_bump;

    assert_eq!(generation_bump, 0, "纯前缀扩展（只 append 新名）不切代");
    assert_eq!(generation_after, 0, "单变体路径 generation 保持 0");
    assert_eq!(
        converged_order, single_variant_order,
        "单写者收敛结果 = 其本地 order 本身"
    );
    assert!(
        converged_order.starts_with(&session_baseline),
        "旧缓存（基线前缀）仍是新请求前缀，切代反而有害"
    );
}

// ============================================================================
// 3. T+1 轮：两变体都看见 X、Y，共享同一 generation 与 order（收敛后不再分叉）
// ============================================================================

#[test]
fn later_round_both_variants_see_xy_share_generation_1_order() {
    // 轮 T 收敛结果（见测试 1）：generation = 1，
    // 基线 = [read_file, search, quiz_gen, anki_export]。
    let generation_t: u64 = 1;
    let converged_baseline: Vec<String> = vec![
        "read_file".to_string(),
        "search".to_string(),
        "quiz_gen".to_string(),
        "anki_export".to_string(),
    ];

    // T+1 fan-out：入口统一快照，A′、B′ 从**同一** (g=1, B_1) 出发
    // （方案 A 收敛后状态）。两变体工具面都已含 X、Y，无新增披露。
    let (variant_a_order, variant_a_bytes) = variant_discloses(&converged_baseline, &[]);
    let (variant_b_order, variant_b_bytes) = variant_discloses(&converged_baseline, &[]);

    // 两变体本地 order 与发出字节逐位 / 逐字节一致 —— 同 provider/key
    // 变体互蹭同一条缓存血统（设计稿 4.3「T+2 起全体收敛」）。
    assert_eq!(variant_a_order, converged_baseline);
    assert_eq!(variant_b_order, converged_baseline);
    assert_eq!(
        variant_a_bytes, variant_b_bytes,
        "T+1 两变体 tools 请求字节必须逐字节一致，不得再有轮内漂移"
    );

    // expected API（#1 落地后替换）：join 收敛读回
    //   ToolFacePrefixSnapshot { generation: 1, order: B_1, schema_digest }，
    //   无新增名、无互异尾部 → advance 跳过写库、generation 不动。
    let (generation_bump, converged_order) =
        converge_orders_by_variant_index(&[variant_a_order, variant_b_order]);
    let generation_t_plus_1 = generation_t + generation_bump;

    assert_eq!(
        generation_bump, 0,
        "两变体尾部全等（皆空）→ 非真分叉，不切代"
    );
    assert_eq!(generation_t_plus_1, 1, "T+1 共享 generation 仍为 1");
    assert_eq!(
        converged_order, converged_baseline,
        "T+1 共享 order 与轮 T 收敛基线逐位一致（无变更应跳过写库）"
    );
}

// ============================================================================
// 4. 终局（第 7 轮 #1）：分叉后完整时间线 T → T+1 → T+2，
//    T+2 稳态两变体同序同代，缓存血统自 T+1 起零漂移
// ============================================================================

#[test]
fn t_plus_2_steady_state_after_fork_both_variants_share_order_and_generation() {
    // ===== 轮 T：真分叉（与测试 1 同构，此处连跑不摆拍）=====
    // generation = 0，B̂ = [read_file, search]；A 披露 X = quiz_gen，
    // B 披露 Y = anki_export → 索引序收敛 + 切代。
    let generation_t0: u64 = 0;
    let session_baseline = established_baseline();
    let (fork_a_order, _) = variant_discloses(&session_baseline, &["quiz_gen"]);
    let (fork_b_order, _) = variant_discloses(&session_baseline, &["anki_export"]);
    let (bump_t, order_after_t) = converge_orders_by_variant_index(&[fork_a_order, fork_b_order]);
    let generation_t = generation_t0 + bump_t;
    assert_eq!(generation_t, 1, "轮 T 真分叉：generation 0 → 1");
    assert_eq!(
        order_after_t,
        vec!["read_file", "search", "quiz_gen", "anki_export"],
        "轮 T 收敛序 = B̂ + X + Y（变体索引序）"
    );

    // ===== 轮 T+1：fan-out 统一快照自 (g=1, B_1)，无新增披露 =====
    let (t1_a_order, t1_a_bytes) = variant_discloses(&order_after_t, &[]);
    let (t1_b_order, t1_b_bytes) = variant_discloses(&order_after_t, &[]);
    let (bump_t1, order_after_t1) = converge_orders_by_variant_index(&[t1_a_order, t1_b_order]);
    let generation_t1 = generation_t + bump_t1;
    assert_eq!(bump_t1, 0, "T+1 无互异尾部，不切代");
    assert_eq!(order_after_t1, order_after_t, "T+1 收敛 order 不动");
    assert_eq!(t1_a_bytes, t1_b_bytes, "T+1 两变体请求字节逐字节一致");

    // ===== 轮 T+2：再次 fan-out，自 T+1 收敛状态出发 =====
    // expected API（#1 落地后替换）：入口 load ToolFacePrefixSnapshot
    //   { generation: 1, order: B_1, schema_digest }，join 收敛 advance
    //   读回原样、跳过写库。
    let (t2_a_order, t2_a_bytes) = variant_discloses(&order_after_t1, &[]);
    let (t2_b_order, t2_b_bytes) = variant_discloses(&order_after_t1, &[]);
    let (bump_t2, order_after_t2) =
        converge_orders_by_variant_index(&[t2_a_order.clone(), t2_b_order.clone()]);
    let generation_t2 = generation_t1 + bump_t2;

    // ===== 终局断言：T+2 稳态「同序同代」=====
    // 同代：整条时间线 T → T+1 → T+2 只在真分叉那一轮切过一次代。
    assert_eq!(bump_t2, 0, "T+2 不得再切代");
    assert_eq!(generation_t2, 1, "T+2 稳态 generation 恒为 1（同代）");
    assert_eq!(
        generation_t2, generation_t1,
        "T+1 与 T+2 同代：分叉只发生在轮 T，此后代号封存"
    );

    // 同序：两变体本地 order 互等，且与轮 T 收敛基线逐位一致——
    // 稳态 order 是轮 T 收敛结果的不动点。
    assert_eq!(
        t2_a_order, t2_b_order,
        "T+2 两变体本地 order 逐位一致（同序）"
    );
    assert_eq!(
        order_after_t2, order_after_t,
        "T+2 收敛 order 与轮 T 收敛基线逐位一致，稳态不动点"
    );

    // 字节层零漂移：跨变体逐字节全等，且跨轮（T+1 vs T+2）逐字节全等——
    // 同 provider/key 变体自 T+1 起互蹭同一条缓存血统，永不再暖新前缀。
    assert_eq!(t2_a_bytes, t2_b_bytes, "T+2 两变体请求字节逐字节一致");
    assert_eq!(
        t1_a_bytes, t2_a_bytes,
        "T+1 与 T+2 请求字节跨轮全等：稳态后缓存前缀零漂移"
    );

    // 幂等封底：对稳态结果再收敛一次仍是 no-bump 不动点。
    let (rerun_bump, rerun_order) =
        converge_orders_by_variant_index(&[order_after_t2.clone(), order_after_t2.clone()]);
    assert_eq!(rerun_bump, 0, "稳态重复收敛幂等，不得切代");
    assert_eq!(rerun_order, order_after_t2);
}
