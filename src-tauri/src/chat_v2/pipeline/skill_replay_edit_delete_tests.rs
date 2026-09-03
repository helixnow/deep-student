//! Wave2-A 第 7 轮 #4：技能「编辑 / 删除」全生命周期重放反例测试（只写不跑）。
//!
//! ⚠️ 本文件为测试源码交付物：**只落盘、不执行**（本轮铁律禁止 cargo /
//! 任何测试执行）。模块声明（`#[cfg(test)] mod skill_replay_edit_delete_tests;`）
//! 由父代理在 `pipeline.rs` 接线。
//!
//! ## 与既有测试面的分工
//!
//! - `skill_replay_digest_tests.rs`（r3 #5，本轮 #3 席位另行强化）：以
//!   **契约副本**固化 digest 门禁语义，落地前可独立编译；
//! - `history.rs` 内联 `mod skill_replay_gate_tests`（r3 #3）：门禁四分支
//!   与信号去重的最小单元断言；
//! - **本文件**：直接打生产入口
//!   `history::rebuild_anchored_skill_messages_gated_with_signal`（r5 #8 落地
//!   形态，`history.rs:898` 起），覆盖**编辑 / 删除两条用户动作的完整
//!   生命周期**——锚定 → meta JSON 持久化 → 反序列化 → 门禁重放 → 信号
//!   聚合 → 插入层收尾——并以反例钉死当前生产的两个已留档缺口
//!   （见下）。不改产品逻辑，只写预期。
//!
//! ## 钉死的生产契约（r3 门禁 + r5 信号 + r6 #4 二检确认口径）
//!
//! 1. **编辑（digest mismatch）→ skip + 进切代信号**：锚点有 digest、当轮
//!    正文存在但字节漂移，绝不把新正文伪装成旧历史；skill_id 追加进
//!    `mismatched_skill_ids`（按 id 去重，跨 turn 级 / tool 级锚点共享）。
//! 2. **删除（正文缺失）→ warn+skip、不进信号**：r5 表格明示的刻意收窄
//!    （缺正文 digest 无从比较）。r6 #4 留档观察 1 指出这是**残余缺口**
//!    ——有 digest 即证明锚定时正文存在，缺失同为确定性前缀漂移却不换代。
//!    本文件以反例测试记录该现状（若后续语义扩展收口，对应断言应翻转）。
//! 3. **删除但 replay 快照仍携旧正文 → 照常重建**：三个消费点
//!    （history.rs:164/:333/:365）正文取
//!    `replay_skill_contents.or(skill_contents)`，快照优先；本文件传入的
//!    正文映射即扮演该合并结果。
//! 4. **编辑后回滚 → 前缀自愈**：正文改回锚定字节，digest 重新命中，
//!    重放与 live 逐字节相等且不再产生新信号。
//! 5. **旧锚点（无 digest）+ 已编辑正文 → 盲取新正文（向后兼容档反例）**：
//!    记录兼容行为的代价——旧锚点无从发现编辑，会把新字节当旧历史输出。
//! 6. **全部 skip → 插入层零残留**：`insert_transient_skill_messages` 对
//!    空重建列表 no-op，连 `<request_context>` 锚壳也不插
//!    （r6 #4 §5 确认口径）。
//!
//! ## 可观测口径（与 digest_tests 文件头文档约定一致）
//!
//! 生产 skip 分支落 `log::warn!`；测试不捕获、不解析日志文本——skip 语义
//! 以返回值断言，信号以 `mismatched_skill_ids` 出参断言。字节比较统一走
//! `llm_visible_bytes`（role + content + metadata 的确定性序列化；
//! `timestamp` 由 `Utc::now()` 生成、不进 provider 出站字节，不参与比较）。

use std::collections::HashMap;

use serde_json::json;

use super::helpers::{
    insert_transient_skill_messages, is_transient_skill_message, make_empty_message,
    make_transient_skill_message,
};
use super::history::{
    rebuild_anchored_skill_messages, rebuild_anchored_skill_messages_gated,
    rebuild_anchored_skill_messages_gated_with_signal,
};
use super::LegacyChatMessage;
use crate::chat_v2::types::{skill_body_digest, SkillInjectionAnchors, ToolAnchoredSkills};

// ============================================================================
// 测试构件
// ============================================================================

/// LLM 可见字节：role + content + metadata 的确定性序列化。
fn llm_visible_bytes(msg: &LegacyChatMessage) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "role": msg.role,
        "content": msg.content,
        "metadata": msg.metadata,
    }))
    .expect("serialize llm-visible fields")
}

fn contents_map(entries: &[(&str, &str)]) -> HashMap<String, String> {
    entries
        .iter()
        .map(|(id, content)| (id.to_string(), content.to_string()))
        .collect()
}

/// 锚定期构造：对「渲染注入消息所用的同一正文」取 digest（与生产两个
/// 锚点生产点 tool_loop.rs 的取材纪律同源：digest 与发出字节严格同体）。
fn anchors_for_turn(entries: &[(&str, &str)]) -> SkillInjectionAnchors {
    SkillInjectionAnchors {
        turn_skill_ids: entries.iter().map(|(id, _)| id.to_string()).collect(),
        before_turn_user: true,
        skill_content_digests: entries
            .iter()
            .map(|(id, body)| (id.to_string(), skill_body_digest(id, body)))
            .collect(),
        ..Default::default()
    }
}

// ============================================================================
// 1. 编辑生命周期全链：锚定 → meta JSON 落库 → 反序列化 → 门禁 skip + 信号
// ============================================================================

/// 轮 1：用 v1 渲染注入并锚定（digest 随助手消息 meta 落库为 JSON）；
/// 轮 N：技能已被用户编辑为 v2 → 反序列化出的锚点驱动门禁 skip，
/// skill_id 进切代信号；任何路径都不得输出 v2 字节冒充轮 1 历史。
/// 隐私红线顺带钉死：锚点 JSON 只含 digest，不含正文。
#[test]
fn edit_lifecycle_anchor_persist_reload_gate_skips_edited_body_and_signals() {
    let v1 = "步骤一：审题。\n步骤二：列方程。\n";
    let v2 = "步骤一：审题。\n步骤二：列方程并验根。\n"; // 用户编辑后的新正文

    // —— 轮 1（live）：实际发出 v1，锚点在锚定时刻取同一正文的 digest
    let live_turn1 = make_transient_skill_message("solve-equation", v1);
    assert!(is_transient_skill_message(&live_turn1));
    let anchors_live = anchors_for_turn(&[("solve-equation", v1)]);

    // —— 持久化：锚点随助手消息 meta 落库（JSON 容器整体序列化）
    let persisted = serde_json::to_string(&anchors_live).expect("serialize anchors");
    assert!(
        !persisted.contains("列方程"),
        "隐私红线：锚点 JSON 只存 digest，正文字节不得落库"
    );
    assert!(
        persisted.contains("skillContentDigests"),
        "digest 字段必须随 meta 持久化，否则重放侧退化为旧锚点盲取"
    );

    // —— 轮 N（replay）：反序列化锚点；当轮请求只带得到编辑后的 v2
    let anchors: SkillInjectionAnchors =
        serde_json::from_str(&persisted).expect("deserialize anchors");
    assert_eq!(anchors, anchors_live, "锚点经落库往返不失真");
    let contents_after_edit = contents_map(&[("solve-equation", v2)]);

    let mut signal: Vec<String> = Vec::new();
    let restored = rebuild_anchored_skill_messages_gated_with_signal(
        &anchors.turn_skill_ids,
        Some(&contents_after_edit),
        Some(&anchors),
        &mut signal,
    );

    // 核心断言：一条都不许重建 —— 编辑后的正文不得被当成旧历史输出
    assert!(
        restored.is_empty(),
        "digest mismatch 必须 skip，不得用编辑后正文伪造历史"
    );
    assert_eq!(
        signal,
        vec!["solve-equation".to_string()],
        "编辑是确定性前缀漂移证据，必须进切代信号"
    );

    // 前提自证：v2 渲染字节 ≠ 轮 1 实际发出的字节 —— 盲取只会伪造
    let forged_with_v2 = make_transient_skill_message("solve-equation", v2);
    assert_ne!(
        llm_visible_bytes(&forged_with_v2),
        llm_visible_bytes(&live_turn1),
        "v2 渲染字节必须与轮 1 live 字节不同（门禁存在的意义）"
    );

    // 信号出参不改变 skip 结果：丢信号兼容入口输出一致（同为空）
    assert!(rebuild_anchored_skill_messages_gated(
        &anchors.turn_skill_ids,
        Some(&contents_after_edit),
        Some(&anchors),
    )
    .is_empty());
}

// ============================================================================
// 2. 编辑后回滚：digest 重新命中 → 前缀自愈、不再产生信号
// ============================================================================

/// 编辑（v1→v2）触发一次 mismatch 信号后，用户把正文改回 v1：
/// digest 重新命中，重放与轮 1 live 逐字节相等，且回滚轮不追加新信号
/// ——门禁只认字节，不记「曾经改过」的仇。
#[test]
fn edit_then_revert_heals_replay_byte_identical_without_new_signal() {
    let v1 = "校对规则：先查错别字，再查标点。";
    let v2 = "校对规则：只查错别字。"; // 中途编辑
    let anchors = anchors_for_turn(&[("proofread", v1)]);
    let live_turn1 = make_transient_skill_message("proofread", v1);

    let mut signal: Vec<String> = Vec::new();

    // 编辑期的某一轮：mismatch → skip + 信号
    let while_edited = rebuild_anchored_skill_messages_gated_with_signal(
        &anchors.turn_skill_ids,
        Some(&contents_map(&[("proofread", v2)])),
        Some(&anchors),
        &mut signal,
    );
    assert!(while_edited.is_empty());
    assert_eq!(signal, vec!["proofread".to_string()]);

    // 回滚后的下一轮：同一共享信号聚合器继续用（模拟调用方跨趟复用）
    let after_revert = rebuild_anchored_skill_messages_gated_with_signal(
        &anchors.turn_skill_ids,
        Some(&contents_map(&[("proofread", v1)])),
        Some(&anchors),
        &mut signal,
    );
    assert_eq!(after_revert.len(), 1, "回滚后 digest 命中，恢复重建");
    assert_eq!(
        llm_visible_bytes(&after_revert[0]),
        llm_visible_bytes(&live_turn1),
        "回滚 → 重放与轮 1 live 逐字节相等（前缀自愈）"
    );
    assert_eq!(
        signal,
        vec!["proofread".to_string()],
        "命中轮不得追加新信号（信号只收当趟确定性漂移证据）"
    );
}

// ============================================================================
// 3. 删除：正文缺失 → warn+skip，且**不进信号**（残余缺口反例留档）
// ============================================================================

/// 技能被删除/停用：锚点仍带 digest（证明锚定时正文存在），但当轮
/// 请求携带不到正文 → skip 不阻塞其余锚点。
///
/// 📌 反例留档（r6 #4 观察 1，r5 表格刻意收窄）：删除与编辑同为确定性
/// 前缀漂移，但当前生产**只有编辑进切代信号**——删除路径 warn+skip 后
/// 代际层不知情。本测试按现状断言 `signal` 为空；若后续语义扩展把
/// 「有 digest 但正文缺失」也计入信号，最后两条断言应翻转。
#[test]
fn deleted_skill_skips_without_signal_documenting_residual_gap() {
    let alive = "存活技能正文";
    let anchors = anchors_for_turn(&[
        ("alive-skill", alive),
        ("deleted-skill", "锚定时存在、之后被删除的正文"),
    ]);
    // 当轮请求（replay 快照与 live 目录合并后）只带得到存活技能
    let contents = contents_map(&[("alive-skill", alive)]);

    let mut signal: Vec<String> = Vec::new();
    let restored = rebuild_anchored_skill_messages_gated_with_signal(
        &anchors.turn_skill_ids,
        Some(&contents),
        Some(&anchors),
        &mut signal,
    );

    assert_eq!(restored.len(), 1, "删除锚点被 skip，不阻塞存活锚点");
    assert_eq!(
        llm_visible_bytes(&restored[0]),
        llm_visible_bytes(&make_transient_skill_message("alive-skill", alive)),
    );
    // 残余缺口现状：删除不进信号（前缀漂移但代际层不知情）
    assert!(
        signal.is_empty(),
        "现状：正文缺失不进切代信号（r5 刻意收窄；语义扩展收口时本断言应翻转）"
    );

    // 正文映射整体缺席（None）：全 skip、零重建、同样零信号
    let mut signal_none: Vec<String> = Vec::new();
    assert!(rebuild_anchored_skill_messages_gated_with_signal(
        &anchors.turn_skill_ids,
        None,
        Some(&anchors),
        &mut signal_none,
    )
    .is_empty());
    assert!(signal_none.is_empty());
}

/// 删除的另一半真相：技能从 live 目录删除，但会话 replay 快照
/// （`replay_skill_contents`，消费点取 `.or(skill_contents)` 快照优先）
/// 仍携锚定时的旧正文 → digest 命中，历史照常按旧字节重建。
/// 删除动作只影响「快照也没有」的会话——本文件传入的正文映射即扮演
/// 消费点合并后的结果。
#[test]
fn deleted_live_skill_with_replay_snapshot_still_replays_old_bytes() {
    let frozen_body = "冻结在会话快照里的正文（live 目录已删）";
    let anchors = anchors_for_turn(&[("archived-skill", frozen_body)]);
    let live_turn1 = make_transient_skill_message("archived-skill", frozen_body);

    // replay 快照仍携旧正文（live skill_contents 已无此 id，合并结果如下）
    let merged = contents_map(&[("archived-skill", frozen_body)]);

    let mut signal: Vec<String> = Vec::new();
    let restored = rebuild_anchored_skill_messages_gated_with_signal(
        &anchors.turn_skill_ids,
        Some(&merged),
        Some(&anchors),
        &mut signal,
    );
    assert_eq!(restored.len(), 1, "快照携旧正文 → 删除不影响历史重建");
    assert_eq!(
        llm_visible_bytes(&restored[0]),
        llm_visible_bytes(&live_turn1),
        "digest 命中 → 与轮 1 live 逐字节相等"
    );
    assert!(signal.is_empty(), "命中不产生信号");
}

// ============================================================================
// 4. 编辑 + 删除 + 完好混排：逐锚点独立判定、保序、信号只收编辑
// ============================================================================

/// 同一轮锚点里三种命运共存：完好 → 重建；编辑 → skip+信号；
/// 删除 → skip 无信号。skip 不阻塞、不换序；turn 级与 tool 级锚点
/// 共查同一 digest map，同一 skill 跨两级重复 mismatch 时信号按 id 去重，
/// 且共享聚合器里既有条目原样保留（跨消费点聚合契约）。
#[test]
fn mixed_edit_delete_intact_judged_per_anchor_with_deduped_signal() {
    let intact = "技能 A 正文（未动）";
    let edited_v1 = "技能 B 正文 v1";
    let edited_v2 = "技能 B 正文 v2（被改）";

    // 锚点：turn 级三个 + tool 级批次再次锚定被编辑的 skill-b
    let mut anchors = anchors_for_turn(&[
        ("skill-a", intact),
        ("skill-b", edited_v1),
        ("skill-c", "锚定后被删除的正文"),
    ]);
    anchors.tool_anchored = vec![ToolAnchoredSkills {
        tool_call_id: "call_load_skills_1".to_string(),
        skill_ids: vec!["skill-b".to_string()],
    }];

    // 当轮合并正文：a 未动、b 已编辑、c 已删除（缺席）
    let contents = contents_map(&[("skill-a", intact), ("skill-b", edited_v2)]);

    // 共享聚合器带既有条目（模拟同趟更早消息已检出的 mismatch）
    let mut signal: Vec<String> = vec!["earlier-skill".to_string()];

    // —— turn 级消费点
    let restored_turn = rebuild_anchored_skill_messages_gated_with_signal(
        &anchors.turn_skill_ids,
        Some(&contents),
        Some(&anchors),
        &mut signal,
    );
    assert_eq!(restored_turn.len(), 1, "只有完好的 skill-a 重建");
    assert_eq!(
        llm_visible_bytes(&restored_turn[0]),
        llm_visible_bytes(&make_transient_skill_message("skill-a", intact)),
        "完好锚点保序原样重建，与 live 同字节"
    );
    assert_eq!(
        signal,
        vec!["earlier-skill".to_string(), "skill-b".to_string()],
        "信号只收编辑（skill-b）；删除（skill-c）不进；既有条目保留"
    );

    // —— tool 级消费点：同一 skill-b 再次 mismatch → 去重不重复累计
    let restored_tool = rebuild_anchored_skill_messages_gated_with_signal(
        &anchors.tool_anchored[0].skill_ids,
        Some(&contents),
        Some(&anchors),
        &mut signal,
    );
    assert!(restored_tool.is_empty(), "tool 级锚点同样被门禁 skip");
    assert_eq!(
        signal,
        vec!["earlier-skill".to_string(), "skill-b".to_string()],
        "同一 skill 跨 turn 级 / tool 级锚点重复 mismatch，信号按 id 去重"
    );
}

// ============================================================================
// 5. 旧锚点（无 digest）+ 已编辑正文：盲取新正文（向后兼容档反例留档）
// ============================================================================

/// 📌 反例留档：第 2 轮及更早持久化的锚点没有 digest 字段（旧 JSON
/// 反序列化为空 map），门禁按向后兼容契约「有正文就重建」——旧锚点
/// **无从发现编辑**，会把编辑后的新字节当旧历史输出。这是兼容档的
/// 已知代价（r3 契约明文），非 bug；本测试钉死其行为边界：
/// 只要锚点带上 digest，同样输入立刻转为 skip。
#[test]
fn legacy_anchor_without_digest_blindly_replays_edited_body() {
    let v1 = "旧会话锚定时的正文";
    let v2 = "之后被编辑的新正文";
    let live_turn1 = make_transient_skill_message("legacy-skill", v1);
    let contents_after_edit = contents_map(&[("legacy-skill", v2)]);

    // 旧 JSON：无 skillContentDigests / skillContentRev 字段
    let legacy: SkillInjectionAnchors =
        serde_json::from_str(r#"{"turnSkillIds": ["legacy-skill"], "beforeTurnUser": true}"#)
            .expect("old-format anchors must stay parseable");
    assert!(legacy.skill_content_digests.is_empty());
    assert_eq!(legacy.content_digest_for("legacy-skill"), None);

    let mut signal: Vec<String> = Vec::new();
    let restored = rebuild_anchored_skill_messages_gated_with_signal(
        &legacy.turn_skill_ids,
        Some(&contents_after_edit),
        Some(&legacy),
        &mut signal,
    );

    // 兼容档现状：盲取新正文重建（输出的正是「新正文当旧历史」字节）
    assert_eq!(
        restored.len(),
        1,
        "旧锚点无 digest → 有正文就重建（兼容契约）"
    );
    assert_eq!(
        llm_visible_bytes(&restored[0]),
        llm_visible_bytes(&make_transient_skill_message("legacy-skill", v2)),
        "兼容档输出 v2 字节（反例：旧锚点无从发现编辑）"
    );
    assert_ne!(
        llm_visible_bytes(&restored[0]),
        llm_visible_bytes(&live_turn1),
        "输出的不是轮 1 真实历史字节 —— 兼容档的已知代价"
    );
    assert!(signal.is_empty(), "无 digest 的旧锚点永不产生切代信号");

    // 二参兼容入口（anchors=None）与旧锚点行为一致
    let ungated =
        rebuild_anchored_skill_messages(&legacy.turn_skill_ids, Some(&contents_after_edit));
    assert_eq!(ungated.len(), 1);
    assert_eq!(
        llm_visible_bytes(&ungated[0]),
        llm_visible_bytes(&restored[0]),
    );

    // 边界钉死：同样输入，锚点一旦带上 digest 立刻转为 skip + 信号
    let gated_anchors = anchors_for_turn(&[("legacy-skill", v1)]);
    let mut gated_signal: Vec<String> = Vec::new();
    assert!(rebuild_anchored_skill_messages_gated_with_signal(
        &gated_anchors.turn_skill_ids,
        Some(&contents_after_edit),
        Some(&gated_anchors),
        &mut gated_signal,
    )
    .is_empty());
    assert_eq!(gated_signal, vec!["legacy-skill".to_string()]);
}

// ============================================================================
// 6. 插入层收尾：全部 skip → 零残留（连 request anchor 锚壳也不插）
// ============================================================================

/// 编辑/删除把某轮锚点全部 skip 后，重建列表为空——插入层必须 no-op：
/// 历史消息一条不动、不产生 `<request_context>` 锚壳（r6 #4 §5 确认
/// 口径：全部 skip 时不插入，与「该位置前缀已漂移」语义一致）。
/// 对照组：只要有一条重建命中且插在头部，锚壳照常出现。
#[test]
fn all_anchors_skipped_leaves_history_untouched_including_request_anchor() {
    let anchors = anchors_for_turn(&[("edited-skill", "锚定正文 v1")]);
    // 编辑后的正文 → 门禁全 skip → 重建列表为空
    let restored = rebuild_anchored_skill_messages_gated(
        &anchors.turn_skill_ids,
        Some(&contents_map(&[("edited-skill", "编辑后的正文 v2")])),
        Some(&anchors),
    );
    assert!(restored.is_empty());

    let mut history = vec![
        make_empty_message("user", "第一轮 user".to_string()),
        make_empty_message("assistant", "第一轮回复".to_string()),
    ];
    let before: Vec<Vec<u8>> = history.iter().map(llm_visible_bytes).collect();

    // 全 skip：插入头部（index 0）也必须零残留
    insert_transient_skill_messages(&mut history, 0, restored);
    assert_eq!(history.len(), 2, "空重建列表 → 不插入任何消息");
    let after: Vec<Vec<u8>> = history.iter().map(llm_visible_bytes).collect();
    assert_eq!(before, after, "历史消息字节一条不动（无锚壳残留）");

    // 对照组：命中一条且插在头部 → request anchor 锚壳 + 技能消息共两条
    let hit = rebuild_anchored_skill_messages_gated(
        &anchors.turn_skill_ids,
        Some(&contents_map(&[("edited-skill", "锚定正文 v1")])),
        Some(&anchors),
    );
    assert_eq!(hit.len(), 1);
    insert_transient_skill_messages(&mut history, 0, hit);
    assert_eq!(history.len(), 4, "命中路径：锚壳 + 技能消息插入头部");
    assert!(
        !is_transient_skill_message(&history[0]),
        "头部第一条是 request anchor 锚壳，非技能消息"
    );
    assert!(is_transient_skill_message(&history[1]));
    assert_eq!(
        llm_visible_bytes(&history[1]),
        llm_visible_bytes(&make_transient_skill_message("edited-skill", "锚定正文 v1")),
        "插入的技能消息与 live 渲染同字节"
    );
}
