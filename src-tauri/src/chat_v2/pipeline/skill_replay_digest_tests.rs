//! Wave2-A 第 3 轮 #5：技能锚定重放 digest 契约测试（只写不跑）。
//!
//! ⚠️ 本文件为测试源码交付物：**只落盘、不执行**（本轮铁律禁止 cargo /
//! 任何测试执行）。模块声明（`#[cfg(test)] mod skill_replay_digest_tests;`）
//! 由父代理在 `pipeline.rs` 接线。
//!
//! ## 背景与契约
//!
//! P1-8 技能锚定重放（`history.rs`）只在助手消息
//! `meta.skill_injection_anchors` 落库技能 **id**，不落正文（隐私约束）；
//! 重放时正文取自当轮请求的 `replay_skill_contents` / `skill_contents`，
//! 与 live 走同一渲染函数 `helpers::make_transient_skill_message`，从而
//! 跨轮 `[history][skills][userN]` live == replay **字节相等**。
//!
//! 该等式有一个隐含前提：**当轮携带的正文 == 锚定当时发出的正文**。
//! 一旦技能正文在两轮之间被用户编辑，按 id 盲取新正文重建会把
//! **从未发给过 provider 的字节**伪装成旧历史 —— 既伪造对话历史，又
//! 必然打断 prompt cache 前缀。本文件固化 digest 门禁契约：
//!
//! 1. **digest 不一致（正文被改）→ warn+skip**：绝不把新正文当旧历史输出；
//! 2. **正文缺失（技能被删且无 replay 快照）→ warn+skip**：跳过该锚点、
//!    不阻塞其余锚点与整个重放（对齐现有生产行为，见下表）；
//! 3. **digest 一致 → 输出与 live 同字节**：重建消息的 LLM 可见字节
//!    （role + content + metadata）与 live 渲染逐字节相等。
//!
//! ## 契约副本对齐说明（应对齐 `history::rebuild_anchored_skill_messages`）
//!
//! 生产 `rebuild_anchored_skill_messages`（`history.rs:809`）目前只有
//! 「正文缺失 → `log::warn!` + skip」一档；digest 门禁是本任务卡固化的
//! 扩展契约，落地时应并入同一函数（锚点结构 `SkillInjectionAnchors` /
//! `ToolAnchoredSkills` 增记 `content_digest`）。对齐表：
//!
//! | 本文件契约副本 | 对齐的生产项 |
//! | --- | --- |
//! | `contract_rebuild_anchored_skill_messages` | `history::rebuild_anchored_skill_messages`（`history.rs:809-824`；命中分支直接调用生产渲染函数 `make_transient_skill_message`，字节永不漂移） |
//! | `contract_skill_content_digest` | 待落地的锚定期正文摘要（算法可换 blake3/sha256 等；契约只约束「确定性 + 任意字节变化敏感」两个性质，见 `digest_is_deterministic_and_sensitive_to_any_byte_change`） |
//! | `ReplaySkip` 结构化跳过记录 | 生产 `log::warn!`（`history.rs:817-821`）。**文档约定**：warn 的可观测断言以本副本的结构化返回值表达，测试不捕获、不解析日志文本；生产落地后可选择返回同构审计记录或维持仅打日志，跳过语义（本文件断言的部分）必须一致 |
//!
//! 字节比较口径：`LegacyChatMessage.timestamp` 由 `Utc::now()` 生成、不进
//! provider 出站字节，比较统一走 `llm_visible_bytes`（role + content +
//! metadata 的确定性序列化）。
//!
//! ## r7 #3 终局补强（正文修改 / 删除两条终局，只写不跑）
//!
//! 上表「待落地」项自本文件首落盘后已在生产落地（`6069675e` 起）：
//!
//! - digest 门禁 → `history::rebuild_anchored_skill_messages_gated_with_signal`
//!   （生产 history 重放唯一入口；`_gated` 为丢信号薄包装，二参
//!   `rebuild_anchored_skill_messages` 为 `anchors = None` 兼容入口，
//!   专为本文件既有反例保留，见 `history.rs` 该函数 doc）；
//! - 锚定期正文摘要 → `crate::chat_v2::types::skill_body_digest(id, body)`
//!   （sha256 + `0x1f`/`0x1e` 分隔骨架，对 (id, body) 联合取摘要——比
//!   本文件 r3 契约副本的「仅正文」FNV 更强：id 换绑也会 mismatch）；
//! - 锚点 digest 载体 → `SkillInjectionAnchors.skill_content_digests`
//!   （turn 级与 tool 级锚点共用同一 map；空 map = 旧锚点 = 兼容旧行为）；
//! - mismatch 换代信号 → `mismatched_skill_ids` 出参（按 skill_id 去重），
//!   由 `record_skill_digest_prefix_generation_signal`（helpers，r5 #8）
//!   统一记录；门禁本身保持纯函数。
//!
//! 第 5 节两条终局直接对生产门禁断言（不再经契约副本），固化：
//!
//! - **正文修改终局**（`finale_modified_skill_*`）：mismatch → skip +
//!   去重信号；后续轮稳态（怎么重放都不伪造）；正文回退 v1 即恢复
//!   live 同字节且不再发信号 —— 漂移可恢复、恢复即闭环；
//! - **删除终局**（`finale_deleted_skill_*`）：缺正文 → skip 且**永不**
//!   产生换代信号（与 mismatch 严格区分）；同 id 重建仅当字节精确
//!   还原才恢复重放，字节不同则转 mismatch 档。
//!
//! 第 1-4 节 r3 契约副本测试原样保留（生产二参兼容入口即为此不动），
//! 「缺口反例」段的历史注记见各处 📌 更新说明。

use std::collections::HashMap;

use serde_json::json;

use super::helpers::{is_transient_skill_message, make_transient_skill_message};
use super::history::{
    rebuild_anchored_skill_messages, rebuild_anchored_skill_messages_gated,
    rebuild_anchored_skill_messages_gated_with_signal,
};
use super::LegacyChatMessage;
use crate::chat_v2::types::{skill_body_digest, SkillInjectionAnchors};

// ============================================================================
// 契约副本（应对齐 history::rebuild_anchored_skill_messages，对齐表见文件头）
// ============================================================================

/// 锚点携带的单个技能记录：id + 锚定当时正文的 digest。
///
/// 对齐 `SkillInjectionAnchors.turn_skill_ids` / `ToolAnchoredSkills.skill_ids`
/// 的 digest 扩展形态（生产落地时 `Vec<String>` 升级为本结构的等价物）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct AnchoredSkillDigest {
    skill_id: String,
    /// 锚定（冻结注入）当时正文的摘要，与正文本身不同：digest 可落库
    /// （不泄露正文），重放时用于校验当轮携带正文未漂移。
    content_digest: String,
}

/// 锚定期构造：live 注入冻结时对实际发出的正文取 digest。
fn anchor_skill(skill_id: &str, live_content: &str) -> AnchoredSkillDigest {
    AnchoredSkillDigest {
        skill_id: skill_id.to_string(),
        content_digest: contract_skill_content_digest(live_content),
    }
}

/// 跳过原因（结构化，替代对日志文本的依赖）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum ReplaySkipReason {
    /// 技能被删除 / 当轮请求未携带该 id 的正文
    MissingContent,
    /// 当轮携带正文与锚定期 digest 不一致（正文被修改）
    DigestMismatch {
        anchored_digest: String,
        current_digest: String,
    },
}

/// 单条跳过记录（生产侧对应 `log::warn!`，见文件头文档约定）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReplaySkip {
    skill_id: String,
    reason: ReplaySkipReason,
}

/// 契约副本：锚定期正文 digest（FNV-1a 64，十六进制 + 算法前缀）。
///
/// 生产落地可替换为任意加密摘要；契约只锁两个性质：
/// 1. 确定性 —— 同字节序列永远同 digest（跨进程 / 跨轮可比）；
/// 2. 字节敏感 —— 任意一个字节的增删改（含 CRLF/LF、尾随换行）都变。
fn contract_skill_content_digest(content: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fnv1a64:{hash:016x}")
}

/// 契约副本：带 digest 门禁的锚定重放。
///
/// 应对齐 `history::rebuild_anchored_skill_messages`（`history.rs:809`）：
/// - 保持锚点顺序逐个处理，跳过不阻塞其余锚点（与生产一致）；
/// - 正文缺失 → skip（生产：`log::warn!`；本副本：`ReplaySkip::MissingContent`）；
/// - digest 不一致 → skip（本任务卡扩展档：绝不把新正文当旧历史输出）；
/// - digest 一致 → **直接调用生产渲染函数** `make_transient_skill_message`，
///   与 live 同字节（测试与生产渲染语义永不漂移）。
fn contract_rebuild_anchored_skill_messages(
    anchors: &[AnchoredSkillDigest],
    skill_contents: Option<&HashMap<String, String>>,
) -> (Vec<LegacyChatMessage>, Vec<ReplaySkip>) {
    let mut restored = Vec::with_capacity(anchors.len());
    let mut skipped = Vec::new();
    for anchor in anchors {
        match skill_contents.and_then(|contents| contents.get(&anchor.skill_id)) {
            None => skipped.push(ReplaySkip {
                skill_id: anchor.skill_id.clone(),
                reason: ReplaySkipReason::MissingContent,
            }),
            Some(content) => {
                let current_digest = contract_skill_content_digest(content);
                if current_digest != anchor.content_digest {
                    skipped.push(ReplaySkip {
                        skill_id: anchor.skill_id.clone(),
                        reason: ReplaySkipReason::DigestMismatch {
                            anchored_digest: anchor.content_digest.clone(),
                            current_digest,
                        },
                    });
                } else {
                    restored.push(make_transient_skill_message(&anchor.skill_id, content));
                }
            }
        }
    }
    (restored, skipped)
}

// ============================================================================
// 测试构件
// ============================================================================

/// LLM 可见字节：role + content + metadata 的确定性序列化。
/// `timestamp` 由 `Utc::now()` 生成、不进 provider 出站字节，故不参与比较。
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

// ============================================================================
// 1. 正文被修改：digest 不一致 → 不得把新正文当旧历史输出
// ============================================================================

/// 轮 1 用 v1 正文注入并锚定；轮 N 重放时技能已被编辑为 v2。
/// digest 门禁必须 skip，且跳过记录携带两侧 digest（可观测、不靠日志）。
#[test]
fn modified_skill_digest_mismatch_skips_instead_of_forging_history() {
    let v1 = "步骤一：先审题。\n步骤二：列方程。\n";
    let v2 = "步骤一：先审题。\n步骤二：列方程并验根。\n"; // 用户编辑后的新正文

    // 轮 1（live）：发出 v1 并锚定其 digest
    let live_turn1 = make_transient_skill_message("solve-equation", v1);
    let anchor = anchor_skill("solve-equation", v1);

    // 轮 N（replay）：当轮请求只带得到 v2
    let replay_contents = contents_map(&[("solve-equation", v2)]);
    let (restored, skipped) =
        contract_rebuild_anchored_skill_messages(&[anchor.clone()], Some(&replay_contents));

    // 核心断言：一条都不许重建 —— 新正文不得被当成旧历史输出
    assert!(
        restored.is_empty(),
        "digest 不一致时必须 skip，不得用新正文伪造历史消息"
    );
    assert_eq!(
        skipped,
        vec![ReplaySkip {
            skill_id: "solve-equation".to_string(),
            reason: ReplaySkipReason::DigestMismatch {
                anchored_digest: contract_skill_content_digest(v1),
                current_digest: contract_skill_content_digest(v2),
            },
        }]
    );

    // 前提自证：用 v2 渲染出的字节 ≠ 轮 1 实际发出的字节 ——
    // 即便盲取新正文重建，也复现不了旧历史，只会伪造。
    let forged_with_v2 = make_transient_skill_message("solve-equation", v2);
    assert_ne!(
        llm_visible_bytes(&forged_with_v2),
        llm_visible_bytes(&live_turn1),
        "v2 渲染字节必须与轮 1 live 字节不同（否则 digest 门禁前提不成立）"
    );

    // 📌 反例（r7 更新）：本段落盘时是「生产缺口」记录；门禁现已落地
    // （见文件头 r7 节），生产重放一律走门禁版。二参入口被生产刻意保留
    // 为 `anchors = None` 兼容包装（history.rs 该函数 doc 点名本文件），
    // 本段自此转为**兼容入口语义钉子**：无锚点 digest 时按 id 盲取即
    // 输出 v2 字节 —— 恰好自证门禁必要性。门禁版的 skip 终局断言见
    // 第 5 节 `finale_modified_skill_gate_skips_signals_and_recovers_on_revert`。
    let ungated =
        rebuild_anchored_skill_messages(&["solve-equation".to_string()], Some(&replay_contents));
    assert_eq!(ungated.len(), 1);
    assert_eq!(
        llm_visible_bytes(&ungated[0]),
        llm_visible_bytes(&forged_with_v2),
        "无门禁路径输出 v2 字节（缺口反例）"
    );
    assert_ne!(
        llm_visible_bytes(&ungated[0]),
        llm_visible_bytes(&live_turn1),
        "无门禁路径输出的不是轮 1 真实历史字节"
    );
}

/// 多锚点场景：只有正文漂移的那个技能被 skip，完好技能按锚点顺序
/// 原样重建（skip 不阻塞、不换序）。
#[test]
fn multi_anchor_mismatch_skips_only_the_drifted_skill_keeping_order() {
    let intact_a = "技能 A 正文（未改）";
    let drifted_b_v1 = "技能 B 正文 v1";
    let drifted_b_v2 = "技能 B 正文 v2（被改）";
    let intact_c = "技能 C 正文（未改）";

    let anchors = vec![
        anchor_skill("skill-a", intact_a),
        anchor_skill("skill-b", drifted_b_v1),
        anchor_skill("skill-c", intact_c),
    ];
    let replay_contents = contents_map(&[
        ("skill-a", intact_a),
        ("skill-b", drifted_b_v2),
        ("skill-c", intact_c),
    ]);

    let (restored, skipped) =
        contract_rebuild_anchored_skill_messages(&anchors, Some(&replay_contents));

    assert_eq!(restored.len(), 2, "完好锚点不受漂移锚点影响");
    assert_eq!(
        llm_visible_bytes(&restored[0]),
        llm_visible_bytes(&make_transient_skill_message("skill-a", intact_a)),
        "skill-a 按锚点顺序第 1 个重建，与 live 同字节"
    );
    assert_eq!(
        llm_visible_bytes(&restored[1]),
        llm_visible_bytes(&make_transient_skill_message("skill-c", intact_c)),
        "skill-c 按锚点顺序第 2 个重建，与 live 同字节"
    );
    assert_eq!(
        skipped,
        vec![ReplaySkip {
            skill_id: "skill-b".to_string(),
            reason: ReplaySkipReason::DigestMismatch {
                anchored_digest: contract_skill_content_digest(drifted_b_v1),
                current_digest: contract_skill_content_digest(drifted_b_v2),
            },
        }],
        "只有 skill-b 被 skip"
    );
}

// ============================================================================
// 2. 技能被删除：无正文 → warn+skip（结构化记录替代日志捕获）
// ============================================================================

/// 技能被删除（当轮 skill_contents 无该 id）→ skip 该锚点、不阻塞其余
/// 锚点。warn 语义按文件头文档约定以 `ReplaySkip::MissingContent` 断言，
/// 不捕获、不解析日志。末段与生产函数对齐：同输入下生产同样只重建
/// 完好技能（`history.rs:815-821` 的 None 分支 warn+skip）。
#[test]
fn deleted_skill_missing_content_warns_and_skips_without_blocking() {
    let alive = "存活技能正文";
    let anchors = vec![
        anchor_skill("alive-skill", alive),
        // ghost-skill 锚定时有正文，之后被用户删除
        anchor_skill("ghost-skill", "已被删除的正文"),
    ];
    // 当轮请求只带得到存活技能的正文
    let replay_contents = contents_map(&[("alive-skill", alive)]);

    let (restored, skipped) =
        contract_rebuild_anchored_skill_messages(&anchors, Some(&replay_contents));

    assert_eq!(restored.len(), 1, "缺正文锚点被 skip，不阻塞存活锚点");
    assert_eq!(
        llm_visible_bytes(&restored[0]),
        llm_visible_bytes(&make_transient_skill_message("alive-skill", alive)),
    );
    assert_eq!(
        skipped,
        vec![ReplaySkip {
            skill_id: "ghost-skill".to_string(),
            reason: ReplaySkipReason::MissingContent,
        }],
        "缺正文 → 结构化 MissingContent 记录（生产为 log::warn!，见文档约定）"
    );

    // 正文映射整体缺席（None）等价于全部缺正文：全 skip、零重建
    let (restored_none, skipped_none) = contract_rebuild_anchored_skill_messages(&anchors, None);
    assert!(restored_none.is_empty());
    assert_eq!(skipped_none.len(), 2);
    assert!(skipped_none
        .iter()
        .all(|skip| skip.reason == ReplaySkipReason::MissingContent));

    // 与生产对齐：rebuild_anchored_skill_messages 同输入下也只重建存活技能
    let production = rebuild_anchored_skill_messages(
        &["alive-skill".to_string(), "ghost-skill".to_string()],
        Some(&replay_contents),
    );
    assert_eq!(production.len(), 1, "生产 None 分支同样 warn+skip 不阻塞");
    assert_eq!(
        llm_visible_bytes(&production[0]),
        llm_visible_bytes(&restored[0]),
        "契约副本与生产在缺正文场景输出同字节"
    );
    assert!(
        rebuild_anchored_skill_messages(&["ghost-skill".to_string()], None).is_empty(),
        "生产：正文映射为 None 时全 skip"
    );
}

// ============================================================================
// 3. digest 一致 → 输出与 live 同字节
// ============================================================================

/// 正文未变时，契约副本重建的消息与 live 渲染逐字节相等（role、
/// content、metadata），且与生产 `rebuild_anchored_skill_messages` 输出
/// 同字节。技能 id 含 XML 特殊字符、正文含 CRLF / 中文 / 尾随换行，
/// 钉死 `escape_xml_attr` 与渲染模板的字节形态。
#[test]
fn matching_digest_replays_byte_identical_to_live() {
    let skill_id = r#"skill "quoted" & <angled>"#;
    let content = "第一行 line1\r\ncrlf 保留\n尾行带换行\n";

    // live：轮 1 实际注入的消息
    let live = make_transient_skill_message(skill_id, content);
    assert!(is_transient_skill_message(&live));

    // 钉死渲染模板字节：escape 顺序 & → " → < → >，metadata.skillId 存原始 id
    assert_eq!(
        live.content,
        format!(
            "<skill_instructions id=\"skill &quot;quoted&quot; &amp; &lt;angled&gt;\">\n{}\n</skill_instructions>",
            content
        ),
    );
    assert_eq!(live.role, "user");
    assert_eq!(
        live.metadata,
        Some(json!({
            "kind": "skill_instruction",
            "hidden": true,
            "skillId": skill_id,
        })),
    );

    // replay：正文未变，digest 一致 → 契约副本重建与 live 同字节
    let anchors = vec![anchor_skill(skill_id, content)];
    let replay_contents = contents_map(&[(skill_id, content)]);
    let (restored, skipped) =
        contract_rebuild_anchored_skill_messages(&anchors, Some(&replay_contents));

    assert!(skipped.is_empty(), "digest 一致不得产生任何跳过记录");
    assert_eq!(restored.len(), 1);
    assert_eq!(
        llm_visible_bytes(&restored[0]),
        llm_visible_bytes(&live),
        "digest 一致 → replay 与 live 逐字节相等（role + content + metadata）"
    );

    // 与生产对齐：同输入下生产重建同字节
    let production =
        rebuild_anchored_skill_messages(&[skill_id.to_string()], Some(&replay_contents));
    assert_eq!(production.len(), 1);
    assert_eq!(
        llm_visible_bytes(&production[0]),
        llm_visible_bytes(&live),
        "生产 rebuild_anchored_skill_messages 与 live 同字节"
    );
}

// ============================================================================
// 4. digest 性质自证（支撑 1 / 3 的前提）
// ============================================================================

/// digest 契约的两个性质：确定性（同字节同 digest）与字节敏感
/// （单字符改动 / 尾随换行 / CRLF↔LF / 空串 vs 空格均不同）。
/// 生产替换摘要算法时本测试原样保留 —— 断言的是性质，不是算法。
#[test]
fn digest_is_deterministic_and_sensitive_to_any_byte_change() {
    let base = "步骤一：先审题。\n步骤二：列方程。";

    // 确定性：重复计算、不同 String 实例，digest 相同
    assert_eq!(
        contract_skill_content_digest(base),
        contract_skill_content_digest(&String::from(base)),
    );

    // 字节敏感：以下每个变体的 digest 都必须与 base 及彼此互异
    let variants = [
        "步骤一：先审题。\n步骤二：列方程！",   // 单字符改动
        "步骤一：先审题。\n步骤二：列方程。\n", // 尾随换行
        "步骤一：先审题。\r\n步骤二：列方程。", // LF → CRLF
        "",                                     // 空串
        " ",                                    // 单空格
    ];
    let mut digests = vec![contract_skill_content_digest(base)];
    for variant in variants {
        digests.push(contract_skill_content_digest(variant));
    }
    for i in 0..digests.len() {
        for j in (i + 1)..digests.len() {
            assert_ne!(
                digests[i], digests[j],
                "digest 必须对任意字节差异敏感（第 {i} 与第 {j} 个输入撞值）"
            );
        }
    }
}

// ============================================================================
// 5. r7 #3 终局：直接对生产门禁断言（不再经契约副本，背景见文件头 r7 节）
// ============================================================================

/// 生产锚点构造：live 注入冻结时按 `skill_body_digest(id, body)` 落 digest
/// （对齐 tool_loop.rs 写点：turn 级与 tool 级共用同一 map，只存 hash
/// 不存正文）。
fn production_anchors(entries: &[(&str, &str)]) -> SkillInjectionAnchors {
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

/// 正文修改终局（生产门禁）：轮 1 用 v1 注入并锚定 digest，之后用户把
/// 技能正文改成 v2。此后任意一轮重放的终局都是——
///
/// 1. mismatch → skip：门禁版一条都不重建，绝不把 v2 伪装成轮 1 历史；
/// 2. 换代信号：`mismatched_skill_ids` 收到该 skill_id，且同一 id 在
///    turn 级 + tool 级多个锚点重复 mismatch 时**去重**只记一次
///    （聚合后交 `record_skill_digest_prefix_generation_signal`，r5 #8）；
/// 3. 稳态：正文停在 v2 多少轮，重放结果恒等（skip 是终局不是瞬态）；
/// 4. 唯一恢复路径：正文逐字节回退到 v1 → 重建与轮 1 live 同字节、
///    不再产生信号 —— 除精确还原外没有第二条出路。
#[test]
fn finale_modified_skill_gate_skips_signals_and_recovers_on_revert() {
    let v1 = "步骤一：先审题。\n步骤二：列方程。\n";
    let v2 = "步骤一：先审题。\n步骤二：列方程并验根。\n"; // 用户编辑后的新正文
    let skill_id = "solve-equation";
    let ids = vec![skill_id.to_string()];

    // 轮 1（live）：发出 v1，锚点冻结 sha256 digest
    let live_turn1 = make_transient_skill_message(skill_id, v1);
    let anchors = production_anchors(&[(skill_id, v1)]);
    assert_eq!(
        anchors.content_digest_for(skill_id),
        Some(skill_body_digest(skill_id, v1).as_str()),
    );

    // 轮 N（replay）：当轮请求只带得到 v2 → mismatch 终局
    let v2_contents = contents_map(&[(skill_id, v2)]);
    let mut signal: Vec<String> = Vec::new();
    let restored = rebuild_anchored_skill_messages_gated_with_signal(
        &ids,
        Some(&v2_contents),
        Some(&anchors),
        &mut signal,
    );
    assert!(
        restored.is_empty(),
        "生产门禁：digest 不一致必须 skip，不得用 v2 伪造轮 1 历史"
    );
    assert_eq!(
        signal,
        vec![skill_id.to_string()],
        "mismatch 必须发换代信号"
    );

    // 同一 skill 的第二个锚点（tool 级共用同一 digest map）再次 mismatch：
    // skip 结果不变，信号按 skill_id 去重不重复累计
    let restored_tool_anchor = rebuild_anchored_skill_messages_gated_with_signal(
        &ids,
        Some(&v2_contents),
        Some(&anchors),
        &mut signal,
    );
    assert!(restored_tool_anchor.is_empty());
    assert_eq!(
        signal,
        vec![skill_id.to_string()],
        "同 id 多锚点 mismatch 只记一次"
    );

    // 稳态自证：正文停在 v2，后续每一轮重放终局恒等（skip + 不再增信号）
    for _later_turn in 0..3 {
        let mut steady_signal: Vec<String> = Vec::new();
        let steady = rebuild_anchored_skill_messages_gated_with_signal(
            &ids,
            Some(&v2_contents),
            Some(&anchors),
            &mut steady_signal,
        );
        assert!(steady.is_empty(), "skip 是终局：任意后续轮重放结果不变");
        assert_eq!(steady_signal, vec![skill_id.to_string()]);
    }

    // 丢信号薄包装与带信号版判定一致（生产两入口不允许分叉）
    assert!(
        rebuild_anchored_skill_messages_gated(&ids, Some(&v2_contents), Some(&anchors)).is_empty(),
        "_gated 包装与 _with_signal 的 skip 判定必须一致"
    );

    // 契约副本（r3 第 1 节）与生产门禁同判：双方都 skip，语义未漂移
    let (contract_restored, contract_skipped) =
        contract_rebuild_anchored_skill_messages(&[anchor_skill(skill_id, v1)], Some(&v2_contents));
    assert!(contract_restored.is_empty());
    assert_eq!(contract_skipped.len(), 1);

    // 唯一恢复路径：正文逐字节回退 v1 → 与轮 1 live 同字节，信号归零
    let v1_contents = contents_map(&[(skill_id, v1)]);
    let mut revert_signal: Vec<String> = Vec::new();
    let recovered = rebuild_anchored_skill_messages_gated_with_signal(
        &ids,
        Some(&v1_contents),
        Some(&anchors),
        &mut revert_signal,
    );
    assert_eq!(recovered.len(), 1, "回退到锚定字节后重放恢复");
    assert!(revert_signal.is_empty(), "digest 一致不得再发换代信号");
    assert_eq!(
        llm_visible_bytes(&recovered[0]),
        llm_visible_bytes(&live_turn1),
        "恢复终局：与轮 1 live 逐字节相等（role + content + metadata）"
    );

    // 兼容对照：旧锚点（空 digest map）对 v2 走「有正文就重建」旧行为
    // 且永不发信号 —— 门禁只凭确定性证据（有 digest 且漂移）触发
    let legacy_anchors = SkillInjectionAnchors {
        turn_skill_ids: ids.clone(),
        before_turn_user: true,
        ..Default::default()
    };
    let mut legacy_signal: Vec<String> = Vec::new();
    let legacy = rebuild_anchored_skill_messages_gated_with_signal(
        &ids,
        Some(&v2_contents),
        Some(&legacy_anchors),
        &mut legacy_signal,
    );
    assert_eq!(legacy.len(), 1, "旧锚点无 digest：兼容旧行为重建");
    assert!(legacy_signal.is_empty(), "旧锚点永不产生换代信号");
    assert_eq!(
        llm_visible_bytes(&legacy[0]),
        llm_visible_bytes(&make_transient_skill_message(skill_id, v2)),
    );
}

/// 删除终局（生产门禁）：技能被删除后当轮请求携带不到正文。终局是——
///
/// 1. 缺正文 → warn+skip，**永不**进 `mismatched_skill_ids`（缺正文时
///    digest 无从比较，r3 前旧行为不应触发换代；与 mismatch 严格区分）；
/// 2. skip 不阻塞：存活锚点原样重建、与 live 同字节；正文映射整体
///    `None` 时全 skip、依旧零信号；
/// 3. 删除与漂移同场出现时信号只含漂移者 —— 删除绝不混进换代信号；
/// 4. 恢复路径分档：同 id 重建且字节精确还原 → digest 重新命中、恢复
///    live 同字节重放；字节不同 → 转 mismatch 档（skip + 发信号）。
#[test]
fn finale_deleted_skill_gate_skips_without_signal_and_recovery_needs_exact_bytes() {
    let alive = "存活技能正文";
    let ghost_body = "已被删除的正文";
    let drifted_v1 = "第三技能正文 v1";
    let drifted_v2 = "第三技能正文 v2（被改）";

    let anchors = production_anchors(&[
        ("alive-skill", alive),
        ("ghost-skill", ghost_body),
        ("drifted-skill", drifted_v1),
    ]);
    let ids: Vec<String> = anchors.turn_skill_ids.clone();

    // 终局主体：ghost 被删（无正文）、drifted 被改（v2）、alive 完好
    let mixed_contents = contents_map(&[("alive-skill", alive), ("drifted-skill", drifted_v2)]);
    let mut signal: Vec<String> = Vec::new();
    let restored = rebuild_anchored_skill_messages_gated_with_signal(
        &ids,
        Some(&mixed_contents),
        Some(&anchors),
        &mut signal,
    );
    assert_eq!(
        restored.len(),
        1,
        "只有完好技能重建：删除与漂移都 skip 且互不阻塞"
    );
    assert_eq!(
        llm_visible_bytes(&restored[0]),
        llm_visible_bytes(&make_transient_skill_message("alive-skill", alive)),
        "存活技能与 live 同字节"
    );
    assert_eq!(
        signal,
        vec!["drifted-skill".to_string()],
        "信号只含漂移者：删除（缺正文）绝不混进换代信号"
    );

    // 正文映射整体缺席（None）＝全部缺正文：全 skip、零重建、零信号
    let mut none_signal: Vec<String> = Vec::new();
    assert!(
        rebuild_anchored_skill_messages_gated_with_signal(
            &ids,
            None,
            Some(&anchors),
            &mut none_signal,
        )
        .is_empty(),
        "正文映射 None：全 skip"
    );
    assert!(none_signal.is_empty(), "全缺正文也不得产生任何换代信号");

    // 契约副本（r3 第 2 节）同判：缺正文归 MissingContent、漂移归
    // DigestMismatch，与生产「只有漂移进信号」一一对应
    let (contract_restored, contract_skipped) = contract_rebuild_anchored_skill_messages(
        &[
            anchor_skill("alive-skill", alive),
            anchor_skill("ghost-skill", ghost_body),
            anchor_skill("drifted-skill", drifted_v1),
        ],
        Some(&mixed_contents),
    );
    assert_eq!(contract_restored.len(), 1);
    assert_eq!(
        contract_skipped
            .iter()
            .map(|skip| (
                skip.skill_id.as_str(),
                matches!(skip.reason, ReplaySkipReason::MissingContent)
            ))
            .collect::<Vec<_>>(),
        vec![("ghost-skill", true), ("drifted-skill", false)],
        "契约副本：ghost 归缺正文档、drifted 归 mismatch 档"
    );

    // 恢复档 A：同 id 重建且字节精确还原 → digest 重新命中，恢复重放
    let recreated_exact = contents_map(&[
        ("alive-skill", alive),
        ("ghost-skill", ghost_body),
        ("drifted-skill", drifted_v1),
    ]);
    let mut exact_signal: Vec<String> = Vec::new();
    let full = rebuild_anchored_skill_messages_gated_with_signal(
        &ids,
        Some(&recreated_exact),
        Some(&anchors),
        &mut exact_signal,
    );
    assert_eq!(full.len(), 3, "字节精确还原：三个锚点全部恢复重建");
    assert!(exact_signal.is_empty());
    assert_eq!(
        llm_visible_bytes(&full[1]),
        llm_visible_bytes(&make_transient_skill_message("ghost-skill", ghost_body)),
        "重建的 ghost 与锚定当时 live 同字节（顺序不换：第 2 个锚点）"
    );

    // 恢复档 B：同 id 重建但字节不同 → 删除档转 mismatch 档（skip + 信号）
    let recreated_diff = contents_map(&[
        ("alive-skill", alive),
        ("ghost-skill", "重建后的新正文"),
        ("drifted-skill", drifted_v1),
    ]);
    let mut diff_signal: Vec<String> = Vec::new();
    let partial = rebuild_anchored_skill_messages_gated_with_signal(
        &ids,
        Some(&recreated_diff),
        Some(&anchors),
        &mut diff_signal,
    );
    assert_eq!(partial.len(), 2, "字节不同的重建技能仍被 skip");
    assert_eq!(
        diff_signal,
        vec!["ghost-skill".to_string()],
        "字节不同的同 id 重建被识别为 mismatch，进换代信号"
    );
    assert_eq!(
        llm_visible_bytes(&partial[0]),
        llm_visible_bytes(&make_transient_skill_message("alive-skill", alive)),
    );
    assert_eq!(
        llm_visible_bytes(&partial[1]),
        llm_visible_bytes(&make_transient_skill_message("drifted-skill", drifted_v1)),
        "skip 不换序：drifted 恢复后按锚点顺序排第 3 → 重建列表第 2"
    );
}
