//! 技能经验回放器（G09-P1：dry-run 对账 + 人工晋升，无自动行为）。
//!
//! P0（`skill_usage.rs`，迁移 V20260909）只负责"记录"：轮末零 LLM 成本检测
//! 把正例（trajectory）/反例（user_correction）候选写入 `skill_candidates`
//! （status='new'）。本模块负责"对账"：由命令显式触发候选的 dry-run 回放——
//! 重新执行 P0 写入时依赖的检测探针（消息存在性 / usage 账目锚点查询），
//! 验证该轨迹在**当下** DB 状态下是否仍然成立（环境漂移检测），并把对账
//! 结果写回候选状态机：
//!
//! ```text
//! new ──▶ screened ──▶ replaying ──▶ passed   （validated：锚点齐全且 hash 复核一致）
//!                               └─▶ failed    （drifted：任一锚点漂移 / hash 不符 / payload 损坏）
//! passed ──▶ published   （promoted：仅 chat_v2_promote_skill_candidate 显式命令）
//! published ──▶ rolled_back   （chat_v2_rollback_skill_candidate 显式命令 + 技能文件退役归档）
//! ```
//!
//! **不做任何自动行为**：回放、晋升、回滚都必须由命令显式触发；passed 候选
//! 绝不自动变 published。
//!
//! **P2 晋升成文**：promote 在状态推进的同时把 draft_payload 渲染成标准
//! SKILL.md（frontmatter：name/description/version/source=g09_candidate/
//! 来源候选 id/trace_hash 血缘），经既有安装管线
//! （`StagedSkillDirectory` 暂存 + 原子目录交换，与 workshop apply 同一条
//! 通路）落到 `~/.deep-student/skills/<skill_id>/`，并写
//! `AGENT_INSTALLED.json` 标记（source_kind='g09_candidate'）——晋升技能
//! 默认不受信，注入/脚本执行仍走 skill_trust_request 授权。版本化：技能
//! 身份 = 工作流/反例结构指纹（不含 session），同 trace_hash 重复 promote
//! 幂等返回既有文件，不同 trace_hash（新观测）落到同一技能身份时 version
//! 递增重写；先写暂存目录再原子 rename，中途失败不留半个文件，候选状态
//! 保持 passed 可重试。回滚把技能目录重命名进 `.archive/` 子目录（对技能
//! 扫描隐藏，不物理删除）。
//!
//! **隐私边界**（与 P0 同级红线）：
//! - `chat_v2_list_skill_candidates` 只返回摘要（id/kind/status/trace_hash/
//!   技能 ID/置信信号计数/时间戳），**绝不返回 draft_payload_json /
//!   evidence_refs_json**；
//! - replay / promote / rollback 的日志只落 candidate_id、状态与漂移原因码，
//!   不落任何 payload 内容；SKILL.md 正文只由统计量（工具名序列/技能 ID/
//!   计数/耗时/token）渲染，不含用户内容；
//! - trace_hash 复核不哈希任何 serde 结构体：从库存 draft_payload 解析出
//!   原始输入（工具名序列数组 / 纠错锚点 id），重新调用 P0 的
//!   [`trajectory_trace_hash`] / [`correction_trace_hash`]（Sha256 over 字符串
//!   join，天然确定性，无 HashMap 迭代序问题——AGENTS.md 红线）。
//!
//! **outcome 回流（G09-P2，实现在 skill_usage.rs）**：G07 终态 verdict 由
//! tool_loop 接线点与轮末 process_turn 双通路收敛进 skill_usage 账目；
//! 失败 run 写 trigger='outcome_failed' 的反例候选，本模块的
//! [`reconcile_correction`] 已支持其锚点复核（failed 标记仍在 → validated）。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::database::ChatV2Database;
use super::skill_usage::{
    correction_trace_hash, trajectory_trace_hash, CandidateSourceKind, CandidateStatus,
    SkillCandidateRepo, SkillCandidateRow, SkillOutcome, SkillUsageRepo,
};
use super::skills::{
    expand_path, is_portable_skill_path_component, StagedSkillDirectory, DEFAULT_AGENT_SKILLS_BASE,
};
use super::tools::skill_install_executor::AGENT_INSTALLED_MARKER;

/// list 命令的默认条数与上限（防御前端误传超大 limit 拖垮 IPC）。
const DEFAULT_LIST_LIMIT: usize = 50;
const MAX_LIST_LIMIT: usize = 500;

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ============================================================================
// 漂移原因码（稳定字符串，供前端展示与测试断言）
// ============================================================================

/// draft_payload_json 不是合法 JSON / 缺关键字段 / kind 与 source_kind 不符。
const DRIFT_PAYLOAD_UNPARSEABLE: &str = "payload_unparseable";
/// evidence_refs_json 不是合法 JSON / 缺锚点字段。
const DRIFT_EVIDENCE_UNPARSEABLE: &str = "evidence_unparseable";
/// 从 payload 原始输入重算的 trace_hash 与库存值不一致（完整性失败）。
const DRIFT_TRACE_HASH_MISMATCH: &str = "trace_hash_mismatch";
/// trajectory：证据锚定的助手消息（run）已不在库中。
const DRIFT_ANCHOR_RUN_MISSING: &str = "anchor_run_missing";
/// trajectory / edit 纠错：锚定的用户消息已不在库中。
const DRIFT_ANCHOR_USER_MESSAGE_MISSING: &str = "anchor_user_message_missing";
/// trajectory：payload 声称加载了技能，但该 run 已无任何 usage 账目行。
const DRIFT_USAGE_ROWS_MISSING: &str = "usage_rows_missing";
/// trajectory：payload 的 skills_loaded 集合与该 run 实际账目技能集合不一致。
const DRIFT_SKILLS_DIVERGED: &str = "skills_diverged";
/// trajectory：该 run 的账目行出现 user_corrected / failed 终态——
/// "成功轨迹"前提已不成立（例如之后被用户 retry 推翻）。
const DRIFT_OUTCOME_INVALIDATED: &str = "outcome_invalidated";
/// retry 纠错：被推翻 run 已无任何 usage 账目行。
const DRIFT_ANCHOR_USAGE_MISSING: &str = "anchor_usage_missing";
/// retry 纠错：usage 行仍在，但 P0 写入候选时的 user_corrected 标记已丢失。
const DRIFT_CORRECTION_MARK_MISSING: &str = "correction_mark_missing";
/// outcome_failed 反例（G09-P2）：失败 run 的 usage 行仍在，但 P2 回流写入
/// 的 failed 终态标记已丢失。
const DRIFT_FAILURE_MARK_MISSING: &str = "failure_mark_missing";

// ============================================================================
// 对账报告 / 晋升回执 / 列表摘要（命令返回类型；全部不含用户内容）
// ============================================================================

/// dry-run 对账报告（`chat_v2_replay_skill_candidate` 返回值）。
///
/// 只含 id / 状态 / 漂移原因码 / hash 复核结果——不携带 draft_payload 内容。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayReport {
    pub candidate_id: String,
    pub source_kind: CandidateSourceKind,
    pub session_id: String,
    /// 对账结论：true = validated（状态写回 passed）；false = drifted（failed）。
    pub still_valid: bool,
    /// 漂移原因码（见 DRIFT_* 常量；空 vec = 无漂移）。
    pub drift_reasons: Vec<String>,
    /// trace_hash 复核：库存值。
    pub trace_hash_stored: String,
    /// trace_hash 复核：从 payload 原始输入的重算值（payload 损坏时为 None）。
    pub trace_hash_recomputed: Option<String>,
    /// trace_hash 复核：两者是否一致。
    pub trace_hash_matches: bool,
    /// 回放前状态（new / screened）。
    pub previous_status: CandidateStatus,
    /// 对账写回后的状态（passed / failed）。
    pub resulting_status: CandidateStatus,
    pub replayed_at: String,
}

/// 人工晋升回执（`chat_v2_promote_skill_candidate` 返回值）。
///
/// `draft_payload` 是 P0 写入的统计量草稿（工具名序列/技能 ID/计数/耗时/
/// token 数），按 P0 隐私边界本就不含用户内容。P2 起 promote 同时把草稿
/// 渲染成真实 SKILL.md 落技能目录，`skill_*` 字段回传落盘结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCandidatePromotion {
    pub candidate_id: String,
    pub status: CandidateStatus,
    pub draft_payload: Value,
    pub promoted_at: String,
    /// P2：技能目录名（`learned-workflow-*` / `learned-correction-*`）。
    pub skill_id: String,
    /// P2：落盘的 SKILL.md 绝对路径。
    pub skill_file_path: String,
    /// P2：frontmatter 版本号（同一技能身份的新观测晋升递增）。
    pub skill_version: u64,
    /// P2：本次是否新写/重写了技能文件（false = 同 trace_hash 幂等命中
    /// 既有文件，未改写）。
    pub skill_file_written: bool,
}

/// 列表摘要（`chat_v2_list_skill_candidates` 返回值元素）。
///
/// **隐私红线：不含 draft_payload_json / evidence_refs_json**——只给
/// id / kind / status / trace_hash / 技能 ID / 置信信号计数 / 时间戳。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCandidateSummary {
    pub candidate_id: String,
    pub source_kind: CandidateSourceKind,
    pub status: CandidateStatus,
    pub session_id: String,
    pub trace_hash: String,
    /// 涉及的技能 ID（trajectory 取 skills_loaded；retry 纠错取
    /// corrected_skill_ids；edit 纠错无技能信息为空 vec）。
    pub skill_ids: Vec<String>,
    /// 置信信号计数（全部是从 payload 提取的统计量，无内容）。
    pub signals: CandidateSignalCounts,
    pub created_at: String,
    pub updated_at: String,
}

/// 置信信号计数（缺字段时保持 0——摘要永远可序列化，不因 payload 损坏失败）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSignalCounts {
    /// trajectory：去重后的工作流工具数（P0 的 ≥3 门槛输入）。
    pub distinct_tools: usize,
    /// trajectory：成功工具调用总数。
    pub tool_calls: i64,
    /// trajectory：失败工具调用总数。
    pub failed_tool_calls: i64,
    /// trajectory：该轮加载的技能数。
    pub skills_loaded: usize,
    /// retry 纠错：被推翻 run 涉及的技能数。
    pub corrected_skills: usize,
}

// ============================================================================
// payload 解析（只取统计字段——对账输入，不取任何内容）
// ============================================================================

/// trajectory payload 的对账输入。
struct TrajectoryReconcileInput {
    tool_sequence: Vec<String>,
    skills_loaded: Vec<String>,
}

fn parse_string_array(value: &Value) -> Option<Vec<String>> {
    let items = value.as_array()?;
    items
        .iter()
        .map(|item| item.as_str().map(str::to_string))
        .collect()
}

fn parse_trajectory_input(payload_json: &str) -> Option<TrajectoryReconcileInput> {
    let payload: Value = serde_json::from_str(payload_json).ok()?;
    if payload.get("kind").and_then(Value::as_str) != Some("trajectory") {
        return None;
    }
    Some(TrajectoryReconcileInput {
        tool_sequence: parse_string_array(payload.get("tool_sequence")?)?,
        skills_loaded: parse_string_array(payload.get("skills_loaded")?)?,
    })
}

/// user_correction payload 的对账输入。
struct CorrectionReconcileInput {
    /// P0 写入的触发信号：`edit_and_resend` / `retry`；
    /// G09-P2 补充：`outcome_failed`（G07 终态失败回流的反例）。
    trigger: String,
    /// 纠错锚点：edit → 被编辑的用户消息 id；retry / outcome_failed →
    /// 被推翻/失败 run 的 id。
    corrected_ref: String,
}

fn parse_correction_input(payload_json: &str) -> Option<CorrectionReconcileInput> {
    let payload: Value = serde_json::from_str(payload_json).ok()?;
    if payload.get("kind").and_then(Value::as_str) != Some("user_correction") {
        return None;
    }
    let trigger = payload.get("trigger").and_then(Value::as_str)?.to_string();
    let ref_key = match trigger.as_str() {
        "edit_and_resend" => "corrected_user_message_id",
        "retry" => "corrected_run_id",
        "outcome_failed" => "corrected_run_id",
        _ => return None,
    };
    let corrected_ref = payload.get(ref_key).and_then(Value::as_str)?.to_string();
    Some(CorrectionReconcileInput {
        trigger,
        corrected_ref,
    })
}

// ============================================================================
// 只读探针（环境漂移检测的 DB 访问面）
// ============================================================================

/// 消息存在性探针（chat_v2_messages；edit 锚点 / run 锚点共用）。
fn message_exists(db: &Arc<ChatV2Database>, message_id: &str) -> Result<bool, String> {
    let conn = db.get_conn().map_err(|e| e.to_string())?;
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM chat_v2_messages WHERE id = ?1",
            params![message_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("failed to probe message existence: {}", e))?;
    Ok(exists.is_some())
}

/// 从库存 payload 的原始输入重算 trace_hash（纯函数，可重入；
/// None = payload 损坏无法重算）。确定性来自 P0 哈希函数本身
/// （Sha256 over 字符串 join），不经过任何含 HashMap 的 serde 序列化。
fn recompute_trace_hash(row: &SkillCandidateRow) -> Option<String> {
    match row.source_kind {
        CandidateSourceKind::Trajectory => {
            let input = parse_trajectory_input(&row.draft_payload_json)?;
            Some(trajectory_trace_hash(&row.session_id, &input.tool_sequence))
        }
        CandidateSourceKind::UserCorrection => {
            let input = parse_correction_input(&row.draft_payload_json)?;
            Some(correction_trace_hash(
                &row.session_id,
                &input.trigger,
                &input.corrected_ref,
            ))
        }
    }
}

struct ReconcileOutcome {
    drift_reasons: Vec<String>,
    recomputed_trace_hash: Option<String>,
}

impl ReconcileOutcome {
    fn unparseable() -> Self {
        Self {
            drift_reasons: vec![DRIFT_PAYLOAD_UNPARSEABLE.to_string()],
            recomputed_trace_hash: None,
        }
    }
}

/// 对账探针总入口（只读；只有 DB 错误才返回 Err，payload/锚点问题一律
/// 记为漂移原因码）。
fn reconcile_probes(
    db: &Arc<ChatV2Database>,
    row: &SkillCandidateRow,
) -> Result<ReconcileOutcome, String> {
    match row.source_kind {
        CandidateSourceKind::Trajectory => reconcile_trajectory(db, row),
        CandidateSourceKind::UserCorrection => reconcile_correction(db, row),
    }
}

/// trajectory 正例对账：
/// 1. trace_hash 复核（payload 工具序列 → P0 哈希函数）；
/// 2. 证据锚点：run 的助手消息、用户消息仍存在于库中；
/// 3. usage 账目一致性：payload 的 skills_loaded 集合 == 该 run 实际账目
///    技能集合，且没有任何账目行被收敛为 user_corrected/failed。
fn reconcile_trajectory(
    db: &Arc<ChatV2Database>,
    row: &SkillCandidateRow,
) -> Result<ReconcileOutcome, String> {
    let recomputed = recompute_trace_hash(row);
    let Some(input) = parse_trajectory_input(&row.draft_payload_json) else {
        return Ok(ReconcileOutcome::unparseable());
    };
    let mut drift_reasons = Vec::new();
    if recomputed.as_deref() != Some(row.trace_hash.as_str()) {
        drift_reasons.push(DRIFT_TRACE_HASH_MISMATCH.to_string());
    }

    let evidence: Option<Value> = serde_json::from_str(&row.evidence_refs_json).ok();
    let run_id = evidence
        .as_ref()
        .and_then(|e| e.get("run_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let user_message_id = evidence
        .as_ref()
        .and_then(|e| e.get("user_message_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let (Some(run_id), Some(user_message_id)) = (run_id, user_message_id) else {
        drift_reasons.push(DRIFT_EVIDENCE_UNPARSEABLE.to_string());
        return Ok(ReconcileOutcome {
            drift_reasons,
            recomputed_trace_hash: recomputed,
        });
    };

    if !message_exists(db, &run_id)? {
        drift_reasons.push(DRIFT_ANCHOR_RUN_MISSING.to_string());
    }
    if !message_exists(db, &user_message_id)? {
        drift_reasons.push(DRIFT_ANCHOR_USER_MESSAGE_MISSING.to_string());
    }

    let usage_repo = SkillUsageRepo::new(db.clone());
    let usage_rows = usage_repo.list_by_run(&run_id)?;
    if !input.skills_loaded.is_empty() && usage_rows.is_empty() {
        drift_reasons.push(DRIFT_USAGE_ROWS_MISSING.to_string());
    } else {
        let actual: BTreeSet<&str> = usage_rows.iter().map(|r| r.skill_id.as_str()).collect();
        let expected: BTreeSet<&str> = input.skills_loaded.iter().map(String::as_str).collect();
        if actual != expected {
            drift_reasons.push(DRIFT_SKILLS_DIVERGED.to_string());
        }
    }
    if usage_rows.iter().any(|r| {
        matches!(
            r.outcome,
            SkillOutcome::UserCorrected | SkillOutcome::Failed
        )
    }) {
        drift_reasons.push(DRIFT_OUTCOME_INVALIDATED.to_string());
    }

    Ok(ReconcileOutcome {
        drift_reasons,
        recomputed_trace_hash: recomputed,
    })
}

/// user_correction 反例对账：
/// 1. trace_hash 复核（session + trigger + 纠错锚点 → P0 哈希函数）；
/// 2. edit_and_resend：被编辑的用户消息仍存在于库中；
/// 3. retry：被推翻 run 的 usage 账目仍在，且至少一行保持 user_corrected
///    标记（P0 写入候选时的回标未丢失）。
fn reconcile_correction(
    db: &Arc<ChatV2Database>,
    row: &SkillCandidateRow,
) -> Result<ReconcileOutcome, String> {
    let recomputed = recompute_trace_hash(row);
    let Some(input) = parse_correction_input(&row.draft_payload_json) else {
        return Ok(ReconcileOutcome::unparseable());
    };
    let mut drift_reasons = Vec::new();
    if recomputed.as_deref() != Some(row.trace_hash.as_str()) {
        drift_reasons.push(DRIFT_TRACE_HASH_MISMATCH.to_string());
    }

    match input.trigger.as_str() {
        "edit_and_resend" => {
            if !message_exists(db, &input.corrected_ref)? {
                drift_reasons.push(DRIFT_ANCHOR_USER_MESSAGE_MISSING.to_string());
            }
        }
        "retry" => {
            let usage_repo = SkillUsageRepo::new(db.clone());
            let usage_rows = usage_repo.list_by_run(&input.corrected_ref)?;
            if usage_rows.is_empty() {
                drift_reasons.push(DRIFT_ANCHOR_USAGE_MISSING.to_string());
            } else if !usage_rows
                .iter()
                .any(|r| r.outcome == SkillOutcome::UserCorrected)
            {
                drift_reasons.push(DRIFT_CORRECTION_MARK_MISSING.to_string());
            }
        }
        // outcome_failed（G09-P2 失败反例）：失败 run 的 usage 账目仍在，
        // 且至少一行保持 failed 终态标记（P2 回流标记未丢失）。
        "outcome_failed" => {
            let usage_repo = SkillUsageRepo::new(db.clone());
            let usage_rows = usage_repo.list_by_run(&input.corrected_ref)?;
            if usage_rows.is_empty() {
                drift_reasons.push(DRIFT_ANCHOR_USAGE_MISSING.to_string());
            } else if !usage_rows.iter().any(|r| r.outcome == SkillOutcome::Failed) {
                drift_reasons.push(DRIFT_FAILURE_MARK_MISSING.to_string());
            }
        }
        // parse_correction_input 已校验 trigger 枚举，正常不可达；防御性记码不 panic。
        _ => drift_reasons.push(DRIFT_PAYLOAD_UNPARSEABLE.to_string()),
    }

    Ok(ReconcileOutcome {
        drift_reasons,
        recomputed_trace_hash: recomputed,
    })
}

// ============================================================================
// 对账核心：dry-run 回放（读探针 → 原子守卫写回状态机）
// ============================================================================

/// 从回放入口状态到目标状态的合法迁移路径（复用 P0 `update_status` 的
/// 原子守卫逐步推进；调用方保证 from ∈ {new, screened}、
/// target ∈ {passed, failed}）。
fn replay_transitions(
    from: CandidateStatus,
    target: CandidateStatus,
) -> Vec<(CandidateStatus, CandidateStatus)> {
    let mut path = Vec::with_capacity(3);
    if from == CandidateStatus::New {
        path.push((CandidateStatus::New, CandidateStatus::Screened));
    }
    path.push((CandidateStatus::Screened, CandidateStatus::Replaying));
    path.push((CandidateStatus::Replaying, target));
    path
}

/// dry-run 回放单个候选（同步，可单测；命令层负责 spawn_blocking）。
///
/// 顺序不变量：**先跑完全部只读探针，再做任何状态迁移**——探针只读且
/// 幂等，先探后写保证探针阶段的 DB 错误不会把候选落在 replaying 中间态；
/// 迁移阶段的守卫失败（并发竞争）则整体报错，候选保持对方写入的状态。
pub fn replay_candidate(
    db: &Arc<ChatV2Database>,
    candidate_id: &str,
) -> Result<ReplayReport, String> {
    let repo = SkillCandidateRepo::new(db.clone());
    let row = repo
        .get(candidate_id)?
        .ok_or_else(|| format!("skill candidate not found: {}", candidate_id))?;
    // 只有"待对账"状态可回放；passed/failed/published/rolled_back 一律拒绝
    // （一次性对账语义；周期性复验属于 P2 周期任务，不在本模块）。
    if !matches!(row.status, CandidateStatus::New | CandidateStatus::Screened) {
        return Err(format!(
            "skill candidate {} is not replayable in status '{}'",
            candidate_id,
            row.status.as_str()
        ));
    }
    let previous_status = row.status;

    let outcome = reconcile_probes(db, &row)?;
    let still_valid = outcome.drift_reasons.is_empty()
        && outcome.recomputed_trace_hash.as_deref() == Some(row.trace_hash.as_str());
    let resulting_status = if still_valid {
        CandidateStatus::Passed
    } else {
        CandidateStatus::Failed
    };

    // 原子守卫推进状态机：new → screened → replaying → passed/failed。
    for (expected, next) in replay_transitions(previous_status, resulting_status) {
        if !repo.update_status(candidate_id, expected, next)? {
            return Err(format!(
                "skill candidate {} status changed concurrently during replay",
                candidate_id
            ));
        }
    }

    // 日志只落 id/状态/漂移码，不落 payload（隐私红线）。
    log::info!(
        "[G09::skill_replay] replayed: id={}, kind={}, {} -> {}, still_valid={}, drifts={:?}",
        candidate_id,
        row.source_kind.as_str(),
        previous_status.as_str(),
        resulting_status.as_str(),
        still_valid,
        outcome.drift_reasons
    );

    Ok(ReplayReport {
        candidate_id: candidate_id.to_string(),
        source_kind: row.source_kind,
        session_id: row.session_id.clone(),
        still_valid,
        drift_reasons: outcome.drift_reasons,
        trace_hash_stored: row.trace_hash.clone(),
        trace_hash_matches: outcome.recomputed_trace_hash.as_deref()
            == Some(row.trace_hash.as_str()),
        trace_hash_recomputed: outcome.recomputed_trace_hash,
        previous_status,
        resulting_status,
        replayed_at: now_rfc3339(),
    })
}

// ============================================================================
// 人工晋升（G09-P2：状态机推进 + draft_payload 落成真实技能文件）
// ============================================================================

/// G09 习得技能的 frontmatter 血缘标记值（`source: g09_candidate`）。
const G09_FRONTMATTER_SOURCE: &str = "g09_candidate";
/// 习得技能目录名前前缀（身份签名见 [`derive_learned_skill_id`]）。
const LEARNED_WORKFLOW_PREFIX: &str = "learned-workflow-";
const LEARNED_CORRECTION_PREFIX: &str = "learned-correction-";
const SKILL_FILE_NAME: &str = "SKILL.md";
/// 回滚退役的归档子目录（点号前缀 → 技能目录扫描天然跳过）。
const SKILL_ARCHIVE_SUBDIR: &str = ".archive";

/// 技能身份签名（确定性：Vec 有序 / 已排序集合，无 HashMap 序列化）。
///
/// 身份**不含 session**：同一工作流/反例结构在不同会话的观测沉淀为同一
/// 技能的新版本；trace_hash（含 session）只作幂等键写进 frontmatter 血缘。
fn learned_skill_signature(kind: &str, parts: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"g09-learned-skill\n");
    hasher.update(kind.as_bytes());
    for part in parts {
        hasher.update(b"\n");
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())[..12].to_string()
}

/// 从候选推导技能目录名（`learned-workflow-<sig12>` /
/// `learned-correction-<sig12>`；字符集恒满足技能 ID 校验）。
fn derive_learned_skill_id(row: &SkillCandidateRow) -> Result<String, String> {
    let id = match row.source_kind {
        CandidateSourceKind::Trajectory => {
            let input = parse_trajectory_input(&row.draft_payload_json).ok_or_else(|| {
                format!(
                    "skill candidate {} trajectory payload missing tool_sequence",
                    row.candidate_id
                )
            })?;
            format!(
                "{}{}",
                LEARNED_WORKFLOW_PREFIX,
                learned_skill_signature("workflow", &[input.tool_sequence.join(",")])
            )
        }
        CandidateSourceKind::UserCorrection => {
            let input = parse_correction_input(&row.draft_payload_json).ok_or_else(|| {
                format!(
                    "skill candidate {} user_correction payload missing trigger/anchor",
                    row.candidate_id
                )
            })?;
            let payload: Value = serde_json::from_str(&row.draft_payload_json)
                .map_err(|e| format!("skill candidate {} payload: {}", row.candidate_id, e))?;
            let mut skills = string_array_field(&payload, "corrected_skill_ids");
            skills.sort();
            format!(
                "{}{}",
                LEARNED_CORRECTION_PREFIX,
                learned_skill_signature("correction", &[input.trigger, skills.join(",")])
            )
        }
    };
    // 防御（派生字符集正常必过）：拒绝任何不适格目录名
    if !is_portable_skill_path_component(&id) {
        return Err(format!("derived learned skill id is not portable: {}", id));
    }
    Ok(id)
}

/// 写入 frontmatter / 正文前的值净化：剥离双引号与换行（防 frontmatter
/// 结构注入），并截断长度。工具名/技能 ID 本就是安全字符集，这里 fail-safe。
fn sanitize_inline(raw: &str, max_len: usize) -> String {
    raw.chars()
        .map(|c| match c {
            '"' => '\'',
            '\n' | '\r' => ' ',
            other => other,
        })
        .take(max_len)
        .collect::<String>()
        .trim()
        .to_string()
}

/// 晋升产物的完整草稿（技能目录名 + SKILL.md 全文）。
struct LearnedSkillDraft {
    skill_id: String,
    markdown: String,
}

/// 把候选 draft_payload 渲染为标准 SKILL.md（frontmatter 血缘 +
/// 统计量正文；绝不渲染用户内容——payload 按 P0 边界本就只有统计量）。
fn build_learned_skill_draft(
    row: &SkillCandidateRow,
    version: u64,
) -> Result<LearnedSkillDraft, String> {
    let payload: Value = serde_json::from_str(&row.draft_payload_json).map_err(|e| {
        format!(
            "skill candidate {} draft payload is unparseable: {}",
            row.candidate_id, e
        )
    })?;
    let skill_id = derive_learned_skill_id(row)?;
    let markdown = match row.source_kind {
        CandidateSourceKind::Trajectory => {
            let input = parse_trajectory_input(&row.draft_payload_json).ok_or_else(|| {
                format!(
                    "skill candidate {} trajectory payload missing tool_sequence",
                    row.candidate_id
                )
            })?;
            render_trajectory_skill(row, &payload, &skill_id, version, &input)
        }
        CandidateSourceKind::UserCorrection => {
            let input = parse_correction_input(&row.draft_payload_json).ok_or_else(|| {
                format!(
                    "skill candidate {} user_correction payload missing trigger/anchor",
                    row.candidate_id
                )
            })?;
            render_correction_skill(row, &payload, &skill_id, version, &input)
        }
    };
    Ok(LearnedSkillDraft { skill_id, markdown })
}

/// 已安装习得技能的 frontmatter 血缘（幂等/版本判定的唯一事实来源）。
#[derive(Default)]
struct InstalledLineage {
    source: Option<String>,
    trace_hash: Option<String>,
    version: Option<u64>,
}

fn frontmatter_value(frontmatter: &str, key: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let Some(rest) = line.strip_prefix(key) else {
            continue;
        };
        let Some(value) = rest.strip_prefix(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// 读取已安装技能的 frontmatter 血缘；文件不存在返回 None，
/// 无 frontmatter（外来技能）返回全 None 的 Some（由调用方判碰撞）。
fn read_installed_lineage(skill_file: &Path) -> Result<Option<InstalledLineage>, String> {
    if !skill_file.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(skill_file)
        .map_err(|e| format!("failed to read installed skill {:?}: {}", skill_file, e))?;
    let Some(frontmatter) = super::skill_requires::extract_frontmatter(&content) else {
        return Ok(Some(InstalledLineage::default()));
    };
    Ok(Some(InstalledLineage {
        source: frontmatter_value(frontmatter, "source"),
        trace_hash: frontmatter_value(frontmatter, "trace_hash"),
        version: frontmatter_value(frontmatter, "version").and_then(|v| v.parse::<u64>().ok()),
    }))
}

/// 晋升落盘结果。
struct InstalledLearnedSkill {
    skill_id: String,
    skill_file_path: String,
    version: u64,
    /// false = 同 trace_hash 幂等命中既有文件（未改写）。
    written: bool,
}

/// 经既有安装管线落技能目录：`StagedSkillDirectory` 暂存写入 → 原子目录
/// 交换发布（workshop apply 同一条通路）——中途失败清理暂存、恢复备份，
/// 不留半个文件。
///
/// 版本化语义：
/// - 目录不存在 → version 1 全新安装；
/// - 目录存在且血缘 trace_hash 相同 → 幂等命中，返回既有文件（不改写）；
/// - 目录存在且为 G09 习得技能但 trace_hash 不同 → version 递增重写；
/// - 目录存在但非 G09 习得技能（无血缘标记）→ 碰撞拒绝，绝不覆盖用户技能。
fn install_learned_skill(
    skills_base: &Path,
    row: &SkillCandidateRow,
) -> Result<InstalledLearnedSkill, String> {
    let mut version = 1u64;
    let mut draft = build_learned_skill_draft(row, version)?;
    let skill_dir = skills_base.join(&draft.skill_id);
    let skill_file = skill_dir.join(SKILL_FILE_NAME);

    if let Some(lineage) = read_installed_lineage(&skill_file)? {
        if lineage.source.as_deref() != Some(G09_FRONTMATTER_SOURCE) {
            return Err(format!(
                "skill id collision: {:?} exists but is not a G09-learned skill; refusing to overwrite",
                skill_file
            ));
        }
        if lineage.trace_hash.as_deref() == Some(row.trace_hash.as_str()) {
            return Ok(InstalledLearnedSkill {
                skill_id: draft.skill_id,
                skill_file_path: skill_file.to_string_lossy().to_string(),
                version: lineage.version.unwrap_or(1),
                written: false,
            });
        }
        version = lineage.version.unwrap_or(0).saturating_add(1).max(1);
        draft = build_learned_skill_draft(row, version)?;
    }

    let content_sha256 = hex::encode(Sha256::digest(draft.markdown.as_bytes()));
    // 与 workshop 同形的 AGENT_INSTALLED 标记（source_kind='g09_candidate'）：
    // 晋升技能默认不受信，注入/脚本执行仍走 skill_trust_request 授权链。
    let marker = serde_json::json!({
        "sourceKind": G09_FRONTMATTER_SOURCE,
        "proposalId": row.candidate_id,
        "contentSha256": content_sha256,
        "packageSha256": content_sha256, // 单文件包：包哈希即 SKILL.md 内容哈希
        "packageVersion": version,
        "files": [{
            "path": SKILL_FILE_NAME,
            "sha256": content_sha256,
            "size": draft.markdown.len(),
        }],
        "installedAt": now_rfc3339(),
        "sessionId": row.session_id,
    });
    let marker_text = serde_json::to_string_pretty(&marker)
        .map_err(|e| format!("failed to serialize agent-installed marker: {}", e))?;

    let staged = StagedSkillDirectory::new(skill_dir, true, false)?;
    staged.write_file(SKILL_FILE_NAME, draft.markdown.as_bytes())?;
    staged.write_file(AGENT_INSTALLED_MARKER, marker_text.as_bytes())?;
    let committed = staged.commit()?;
    committed.finalize();

    Ok(InstalledLearnedSkill {
        skill_id: draft.skill_id,
        skill_file_path: skill_file.to_string_lossy().to_string(),
        version,
        written: true,
    })
}

/// 把候选从 passed 推进到 published，并把 draft_payload 渲染成真实
/// SKILL.md 落技能目录（同步，可单测；`skills_base` 由命令层给
/// `~/.deep-student/skills`，测试给临时目录）。
///
/// 守卫：只有 passed（validated）候选可晋升——未回放/回放失败的候选一律
/// 拒绝；`update_status` 的 WHERE 守卫同时挡住并发双晋升。
///
/// 顺序不变量：**先落文件再推进状态**。安装失败时状态保持 passed（等价
/// "失败回滚到 passed"，无需逆向迁移）；状态守卫失败（并发双晋升）时文件
/// 安装幂等，重试走 published 幂等通路自愈。
pub fn promote_candidate_with_base(
    db: &Arc<ChatV2Database>,
    candidate_id: &str,
    skills_base: &Path,
) -> Result<SkillCandidatePromotion, String> {
    let repo = SkillCandidateRepo::new(db.clone());
    let row = repo
        .get(candidate_id)?
        .ok_or_else(|| format!("skill candidate not found: {}", candidate_id))?;
    let draft_payload: Value = serde_json::from_str(&row.draft_payload_json).map_err(|e| {
        format!(
            "skill candidate {} draft payload is unparseable: {}",
            candidate_id, e
        )
    })?;

    // 幂等通路：已发布候选重复 promote——同 trace_hash 返回既有文件；
    // 文件被外部删除则自愈重装；血缘漂移（人工改过 frontmatter）拒绝覆盖。
    if row.status == CandidateStatus::Published {
        let skill_id = derive_learned_skill_id(&row)?;
        let skill_file = skills_base.join(&skill_id).join(SKILL_FILE_NAME);
        return match read_installed_lineage(&skill_file)? {
            Some(lineage) if lineage.trace_hash.as_deref() == Some(row.trace_hash.as_str()) => {
                Ok(SkillCandidatePromotion {
                    candidate_id: candidate_id.to_string(),
                    status: CandidateStatus::Published,
                    draft_payload,
                    promoted_at: now_rfc3339(),
                    skill_id,
                    skill_file_path: skill_file.to_string_lossy().to_string(),
                    skill_version: lineage.version.unwrap_or(1),
                    skill_file_written: false,
                })
            }
            Some(_) => Err(format!(
                "skill candidate {} is published but installed skill {:?} lineage diverged \
                 (manual edit?); refusing to clobber",
                candidate_id, skill_file
            )),
            None => {
                let installed = install_learned_skill(skills_base, &row)?;
                Ok(SkillCandidatePromotion {
                    candidate_id: candidate_id.to_string(),
                    status: CandidateStatus::Published,
                    draft_payload,
                    promoted_at: now_rfc3339(),
                    skill_id: installed.skill_id,
                    skill_file_path: installed.skill_file_path,
                    skill_version: installed.version,
                    skill_file_written: installed.written,
                })
            }
        };
    }

    if row.status != CandidateStatus::Passed {
        return Err(format!(
            "skill candidate {} must be validated ('passed') before promote; current status '{}'",
            candidate_id,
            row.status.as_str()
        ));
    }

    let installed = install_learned_skill(skills_base, &row)?;
    if !repo.update_status(
        candidate_id,
        CandidateStatus::Passed,
        CandidateStatus::Published,
    )? {
        return Err(format!(
            "skill candidate {} status changed concurrently during promote",
            candidate_id
        ));
    }
    // 日志只落 id/版本，不落 draft_payload（隐私红线）。
    log::info!(
        "[G09::skill_replay] promoted: id={}, skill_id={}, version={}, file_written={}",
        candidate_id,
        installed.skill_id,
        installed.version,
        installed.written
    );
    Ok(SkillCandidatePromotion {
        candidate_id: candidate_id.to_string(),
        status: CandidateStatus::Published,
        draft_payload,
        promoted_at: now_rfc3339(),
        skill_id: installed.skill_id,
        skill_file_path: installed.skill_file_path,
        skill_version: installed.version,
        skill_file_written: installed.written,
    })
}

// ============================================================================
// 人工回滚（published → rolled_back + 技能文件退役归档，绝不物理删除）
// ============================================================================

/// 人工回滚回执（`chat_v2_rollback_skill_candidate` 返回值）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCandidateRollback {
    pub candidate_id: String,
    /// 回滚后状态（恒 `rolled_back`）。
    pub status: CandidateStatus,
    pub skill_id: String,
    /// 退役前的技能目录（None = 目录本就不存在，仅推进状态机）。
    pub retired_from: Option<String>,
    /// 归档位置（`<skills_base>/.archive/<skill_id>.rolledback-<ts>`；
    /// 点号子目录对技能扫描隐藏）。
    pub archived_to: Option<String>,
    pub rolled_back_at: String,
}

/// 把候选从 published 推进到 rolled_back，并把技能目录退役进 `.archive/`
/// （同步，可单测；目录重命名是同文件系统单原子操作）。
///
/// 顺序不变量：**先退役文件再推进状态**——反向顺序在状态推进后退役失败
/// 会留下"rolled_back 但技能仍在被加载"的破口。退役失败时状态保持
/// published，技能仍可用，语义不破。
pub fn rollback_candidate_with_base(
    db: &Arc<ChatV2Database>,
    candidate_id: &str,
    skills_base: &Path,
) -> Result<SkillCandidateRollback, String> {
    let repo = SkillCandidateRepo::new(db.clone());
    let row = repo
        .get(candidate_id)?
        .ok_or_else(|| format!("skill candidate not found: {}", candidate_id))?;
    if row.status != CandidateStatus::Published {
        return Err(format!(
            "skill candidate {} must be 'published' to rollback; current status '{}'",
            candidate_id,
            row.status.as_str()
        ));
    }
    let skill_id = derive_learned_skill_id(&row)?;
    let retired = retire_learned_skill(skills_base, &skill_id)?;
    if !repo.update_status(
        candidate_id,
        CandidateStatus::Published,
        CandidateStatus::RolledBack,
    )? {
        return Err(format!(
            "skill candidate {} status changed concurrently during rollback",
            candidate_id
        ));
    }
    log::info!(
        "[G09::skill_replay] rolled back: id={}, skill_id={}, retired={}",
        candidate_id,
        skill_id,
        retired.is_some()
    );
    let (retired_from, archived_to) = match retired {
        Some((from, to)) => (Some(from), Some(to)),
        None => (None, None),
    };
    Ok(SkillCandidateRollback {
        candidate_id: candidate_id.to_string(),
        status: CandidateStatus::RolledBack,
        skill_id,
        retired_from,
        archived_to,
        rolled_back_at: now_rfc3339(),
    })
}

/// 退役习得技能目录：重命名进 `<skills_base>/.archive/`（隐藏子目录，
/// 不物理删除）。目录本就不存在返回 None（只推进状态机）；目录存在但
/// 不是 G09 习得技能（血缘缺失/漂移）时拒绝退役，防误伤用户技能。
fn retire_learned_skill(
    skills_base: &Path,
    skill_id: &str,
) -> Result<Option<(String, String)>, String> {
    let skill_dir = skills_base.join(skill_id);
    if !skill_dir.exists() {
        return Ok(None);
    }
    match read_installed_lineage(&skill_dir.join(SKILL_FILE_NAME))? {
        Some(lineage) if lineage.source.as_deref() == Some(G09_FRONTMATTER_SOURCE) => {}
        _ => {
            return Err(format!(
                "refusing to retire non-G09 skill directory {:?} (lineage missing or diverged)",
                skill_dir
            ))
        }
    }
    let archive_root = skills_base.join(SKILL_ARCHIVE_SUBDIR);
    std::fs::create_dir_all(&archive_root).map_err(|e| {
        format!(
            "failed to create skill archive dir {:?}: {}",
            archive_root, e
        )
    })?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let archived = archive_root.join(format!("{}.rolledback-{}", skill_id, stamp));
    std::fs::rename(&skill_dir, &archived).map_err(|e| {
        format!(
            "failed to retire skill directory {:?} -> {:?}: {}",
            skill_dir, archived, e
        )
    })?;
    Ok(Some((
        skill_dir.to_string_lossy().to_string(),
        archived.to_string_lossy().to_string(),
    )))
}

// ============================================================================
// SKILL.md 渲染（统计量正文；隐私边界与 P0 同级）
// ============================================================================

/// trajectory 正例 → 习得工作流技能。
fn render_trajectory_skill(
    row: &SkillCandidateRow,
    payload: &Value,
    skill_id: &str,
    version: u64,
    input: &TrajectoryReconcileInput,
) -> String {
    let flow: Vec<String> = input
        .tool_sequence
        .iter()
        .map(|tool| sanitize_inline(tool, 40))
        .collect();
    let flow_text = flow.join(" → ");
    let steps = flow
        .iter()
        .enumerate()
        .map(|(index, tool)| format!("{}. `{}`", index + 1, tool))
        .collect::<Vec<_>>()
        .join("\n");
    let skills_text = if input.skills_loaded.is_empty() {
        "无".to_string()
    } else {
        input
            .skills_loaded
            .iter()
            .map(|id| format!("`{}`", sanitize_inline(id, 64)))
            .collect::<Vec<_>>()
            .join("、")
    };
    let tool_calls = payload
        .get("tool_call_count")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let failed_calls = payload
        .get("failed_tool_call_count")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let duration_ms = payload
        .get("duration_ms")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let total_tokens = payload
        .get("total_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let description = sanitize_inline(
        &format!(
            "G09 习得工作流：{}（成功轨迹沉淀，回放验证通过）",
            flow_text
        ),
        200,
    );
    format!(
        r#"---
name: {skill_id}
description: "{description}"
version: {version}
source: {source}
source_kind: trajectory
source_candidate_id: {candidate_id}
trace_hash: {trace_hash}
created_at: {created_at}
---

# 习得工作流：{flow_text}

> 本技能由 G09 经验管线从一次成功完成且回放对账通过的运行轨迹自动沉淀
> （候选 `{candidate_id}`）。默认不受信：技能正文注入或包内脚本执行前，
> 需经 `skill_trust_request` 审查并授权。

## 何时使用

当任务可以拆解为「{flow_text}」式的工具序列时，按本流程执行，可减少
逐步试探的轮次。

## 工作流程

{steps}

## 观测记录

- 工具调用：成功 {tool_calls} 次 / 失败 {failed_calls} 次
- 观测耗时约 {duration_ms} ms，token 消耗约 {total_tokens}
- 同轮加载技能：{skills_text}
"#,
        skill_id = skill_id,
        description = description,
        version = version,
        source = G09_FRONTMATTER_SOURCE,
        candidate_id = row.candidate_id,
        trace_hash = row.trace_hash,
        created_at = now_rfc3339(),
        flow_text = flow_text,
        steps = steps,
        tool_calls = tool_calls,
        failed_calls = failed_calls,
        duration_ms = duration_ms,
        total_tokens = total_tokens,
        skills_text = skills_text,
    )
}

/// user_correction 反例 → 习得反例技能（含 G09-P2 outcome_failed 失败反例）。
fn render_correction_skill(
    row: &SkillCandidateRow,
    payload: &Value,
    skill_id: &str,
    version: u64,
    input: &CorrectionReconcileInput,
) -> String {
    let trigger_label = match input.trigger.as_str() {
        "edit_and_resend" => "用户编辑并重发了上一条消息（上一轮回答被推翻）",
        "retry" => "用户重试了上一轮（原回答被推翻）",
        "outcome_failed" => "任务验收终态判定失败（partial/blocked）",
        _ => "运行被判定为反例",
    };
    let skills: Vec<String> = string_array_field(payload, "corrected_skill_ids");
    let skills_text = if skills.is_empty() {
        "无".to_string()
    } else {
        skills
            .iter()
            .map(|id| format!("`{}`", sanitize_inline(id, 64)))
            .collect::<Vec<_>>()
            .join("、")
    };
    let verdict = payload.get("verdict").and_then(Value::as_str).unwrap_or("");
    let verdict_line = if verdict.is_empty() {
        String::new()
    } else {
        format!("\n- 验收终态：`{}`", sanitize_inline(verdict, 32))
    };
    let description = sanitize_inline(&format!("G09 习得反例：{}——避免重蹈", trigger_label), 200);
    format!(
        r#"---
name: {skill_id}
description: "{description}"
version: {version}
source: {source}
source_kind: user_correction
source_candidate_id: {candidate_id}
trace_hash: {trace_hash}
created_at: {created_at}
---

# 习得反例（避免重蹈）

> 本技能由 G09 经验管线从一条被用户纠错或验收判定失败的运行自动沉淀
> （候选 `{candidate_id}`，反例）。默认不受信：技能正文注入或包内脚本
> 执行前，需经 `skill_trust_request` 审查并授权。

## 避免事项

- 触发信号：{trigger_label}（`{trigger}`）
- 涉及技能：{skills_text}{verdict_line}

再次处理同类任务并准备加载上述技能时，先回顾上次被推翻/失败的原因，
确认前置条件与产出验收标准，再决定是否沿用原路径。
"#,
        skill_id = skill_id,
        description = description,
        version = version,
        source = G09_FRONTMATTER_SOURCE,
        candidate_id = row.candidate_id,
        trace_hash = row.trace_hash,
        created_at = now_rfc3339(),
        trigger_label = trigger_label,
        trigger = sanitize_inline(&input.trigger, 32),
        skills_text = skills_text,
        verdict_line = verdict_line,
    )
}

// ============================================================================
// 列表摘要（只读；不含 draft_payload）
// ============================================================================

/// 状态过滤参数解析：接受 P0 状态机原名，另接受任务层别名
/// （pending→new / validated→passed / drifted→failed / promoted→published）。
fn parse_status_filter(raw: &str) -> Option<CandidateStatus> {
    match raw {
        "pending" => Some(CandidateStatus::New),
        "validated" => Some(CandidateStatus::Passed),
        "drifted" => Some(CandidateStatus::Failed),
        "promoted" => Some(CandidateStatus::Published),
        other => CandidateStatus::parse(other),
    }
}

fn count_string_array(payload: &Value, key: &str) -> usize {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map_or(0, |items| items.len())
}

fn string_array_field(payload: &Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(parse_string_array)
        .unwrap_or_default()
}

fn summary_from_row(row: &SkillCandidateRow) -> SkillCandidateSummary {
    // payload 损坏不影响列表：信号计数降级为 0，摘要永远可序列化。
    let payload: Option<Value> = serde_json::from_str(&row.draft_payload_json).ok();
    let mut signals = CandidateSignalCounts::default();
    let mut skill_ids: Vec<String> = Vec::new();
    if let Some(payload) = payload.as_ref() {
        signals.distinct_tools = count_string_array(payload, "tool_sequence");
        signals.tool_calls = payload
            .get("tool_call_count")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        signals.failed_tool_calls = payload
            .get("failed_tool_call_count")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        signals.skills_loaded = count_string_array(payload, "skills_loaded");
        signals.corrected_skills = count_string_array(payload, "corrected_skill_ids");
        skill_ids = match row.source_kind {
            CandidateSourceKind::Trajectory => string_array_field(payload, "skills_loaded"),
            CandidateSourceKind::UserCorrection => {
                string_array_field(payload, "corrected_skill_ids")
            }
        };
    }
    SkillCandidateSummary {
        candidate_id: row.candidate_id.clone(),
        source_kind: row.source_kind,
        status: row.status,
        session_id: row.session_id.clone(),
        trace_hash: row.trace_hash.clone(),
        skill_ids,
        signals,
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

/// 列出候选摘要（同步，可单测）。status=None 列出全部状态（创建时间升序）。
pub fn list_candidate_summaries(
    db: &Arc<ChatV2Database>,
    status: Option<CandidateStatus>,
    limit: usize,
) -> Result<Vec<SkillCandidateSummary>, String> {
    let rows = SkillCandidateRepo::new(db.clone()).list_filtered(status, limit)?;
    Ok(rows.iter().map(summary_from_row).collect())
}

// ============================================================================
// Tauri 命令（照 G09-P0 chat_v2_record_skill_activation 同款注册路径）
// ============================================================================

/// 列出技能经验候选摘要（不含 draft_payload 全文）。
#[tauri::command]
pub async fn chat_v2_list_skill_candidates(
    status: Option<String>,
    limit: Option<u32>,
    db: tauri::State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<SkillCandidateSummary>, String> {
    let status = match status.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(
            parse_status_filter(raw)
                .ok_or_else(|| format!("unknown skill candidate status filter: {}", raw))?,
        ),
        None => None,
    };
    let limit = limit
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .min(MAX_LIST_LIMIT);
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || list_candidate_summaries(&db, status, limit))
        .await
        .map_err(|e| format!("list skill candidates task join error: {}", e))?
}

/// 对单个候选跑 dry-run 对账（对账结果写回状态机：new/screened → passed/failed）。
#[tauri::command]
pub async fn chat_v2_replay_skill_candidate(
    candidate_id: String,
    db: tauri::State<'_, Arc<ChatV2Database>>,
) -> Result<ReplayReport, String> {
    let candidate_id = candidate_id.trim().to_string();
    if candidate_id.is_empty() || candidate_id.len() > 255 {
        return Err(format!(
            "invalid candidate_id length: {}",
            candidate_id.len()
        ));
    }
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || replay_candidate(&db, &candidate_id))
        .await
        .map_err(|e| format!("replay skill candidate task join error: {}", e))?
}

/// 人工晋升：把已验证（passed）候选置为 published，并把 draft_payload 渲染
/// 成真实 SKILL.md 落技能目录（版本化 + 同 trace_hash 幂等；先写暂存目录
/// 再原子 rename，失败不留半个文件且状态保持 passed）。本命令绝不自动触发。
#[tauri::command]
pub async fn chat_v2_promote_skill_candidate(
    candidate_id: String,
    db: tauri::State<'_, Arc<ChatV2Database>>,
) -> Result<SkillCandidatePromotion, String> {
    let candidate_id = candidate_id.trim().to_string();
    if candidate_id.is_empty() || candidate_id.len() > 255 {
        return Err(format!(
            "invalid candidate_id length: {}",
            candidate_id.len()
        ));
    }
    let skills_base = learned_skills_base()?;
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        promote_candidate_with_base(&db, &candidate_id, &skills_base)
    })
    .await
    .map_err(|e| format!("promote skill candidate task join error: {}", e))?
}

/// 人工回滚：published → rolled_back，并把技能目录退役到
/// `~/.deep-student/skills/.archive/`（对技能扫描隐藏，不物理删除）。
#[tauri::command]
pub async fn chat_v2_rollback_skill_candidate(
    candidate_id: String,
    db: tauri::State<'_, Arc<ChatV2Database>>,
) -> Result<SkillCandidateRollback, String> {
    let candidate_id = candidate_id.trim().to_string();
    if candidate_id.is_empty() || candidate_id.len() > 255 {
        return Err(format!(
            "invalid candidate_id length: {}",
            candidate_id.len()
        ));
    }
    let skills_base = learned_skills_base()?;
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        rollback_candidate_with_base(&db, &candidate_id, &skills_base)
    })
    .await
    .map_err(|e| format!("rollback skill candidate task join error: {}", e))?
}

/// 晋升/回滚的技能基目录（内置常量 `~/.deep-student/skills`）+ 白名单校验
/// （与 workshop apply 同一道门；测试经 `*_with_base` 注入临时目录）。
fn learned_skills_base() -> Result<PathBuf, String> {
    let base = expand_path(DEFAULT_AGENT_SKILLS_BASE);
    super::skills::validate_skill_path(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::skill_usage::{NewSkillCandidate, NewSkillUsage, SkillUsageKind};
    use crate::data_governance::migration::coordinator::MigrationCoordinator;
    use crate::data_governance::schema_registry::DatabaseId;
    use tempfile::TempDir;

    /// 与 P0 测试一致的迁移路径（MigrationCoordinator → refinery，含
    /// V20260909 skill_usage / skill_candidates 表）。
    fn setup_test_db() -> (TempDir, Arc<ChatV2Database>) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("ChatV2 migrations should apply cleanly");
        let db = ChatV2Database::new(temp_dir.path()).expect("Failed to create database");
        (temp_dir, Arc::new(db))
    }

    fn insert_session(db: &Arc<ChatV2Database>, session_id: &str) {
        let conn = db.get_conn().expect("conn");
        conn.execute(
            "INSERT INTO chat_v2_sessions (id, mode, created_at, updated_at) \
             VALUES (?1, 'general_chat', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z')",
            params![session_id],
        )
        .expect("insert session");
    }

    fn insert_message(db: &Arc<ChatV2Database>, session_id: &str, message_id: &str, role: &str) {
        let conn = db.get_conn().expect("conn");
        conn.execute(
            "INSERT INTO chat_v2_messages (id, session_id, role, timestamp) \
             VALUES (?1, ?2, ?3, 1757000000000)",
            params![message_id, session_id, role],
        )
        .expect("insert message");
    }

    fn delete_message(db: &Arc<ChatV2Database>, message_id: &str) {
        let conn = db.get_conn().expect("conn");
        conn.execute(
            "DELETE FROM chat_v2_messages WHERE id = ?1",
            params![message_id],
        )
        .expect("delete message");
    }

    fn insert_tool_load(db: &Arc<ChatV2Database>, skill_id: &str, run_id: &str) {
        SkillUsageRepo::new(db.clone())
            .insert(&NewSkillUsage {
                skill_id: skill_id.to_string(),
                task_session_id: "sess-1".to_string(),
                run_id: Some(run_id.to_string()),
                kind: SkillUsageKind::ToolLoad,
                loads: 1,
                latency_ms: Some(100),
                tokens: Some(42),
            })
            .expect("insert usage");
    }

    /// 与 P0 写入完全同构的 trajectory 候选（统计量 payload，无内容）。
    fn trajectory_candidate(
        session_id: &str,
        run_id: &str,
        user_message_id: &str,
        tools: &[&str],
        skills: &[&str],
    ) -> NewSkillCandidate {
        let tool_sequence: Vec<String> = tools.iter().map(|t| t.to_string()).collect();
        let draft_payload = serde_json::json!({
            "kind": "trajectory",
            "tool_sequence": tool_sequence,
            "tool_call_count": tools.len() as i64,
            "failed_tool_call_count": 0,
            "skills_loaded": skills,
            "duration_ms": 1200,
            "total_tokens": 3456,
        });
        let evidence_refs = serde_json::json!({
            "run_id": run_id,
            "user_message_id": user_message_id,
        });
        NewSkillCandidate {
            source_kind: CandidateSourceKind::Trajectory,
            session_id: session_id.to_string(),
            trace_hash: trajectory_trace_hash(session_id, &tool_sequence),
            draft_payload_json: draft_payload.to_string(),
            evidence_refs_json: evidence_refs.to_string(),
        }
    }

    fn edit_correction_candidate(session_id: &str, user_message_id: &str) -> NewSkillCandidate {
        let draft_payload = serde_json::json!({
            "kind": "user_correction",
            "trigger": "edit_and_resend",
            "corrected_user_message_id": user_message_id,
        });
        let evidence_refs = serde_json::json!({
            "run_id": "msg_run_edit",
            "corrected_user_message_id": user_message_id,
        });
        NewSkillCandidate {
            source_kind: CandidateSourceKind::UserCorrection,
            session_id: session_id.to_string(),
            trace_hash: correction_trace_hash(session_id, "edit_and_resend", user_message_id),
            draft_payload_json: draft_payload.to_string(),
            evidence_refs_json: evidence_refs.to_string(),
        }
    }

    fn retry_correction_candidate(session_id: &str, run_id: &str) -> NewSkillCandidate {
        let draft_payload = serde_json::json!({
            "kind": "user_correction",
            "trigger": "retry",
            "corrected_run_id": run_id,
            "corrected_skill_ids": ["skill-a"],
        });
        let evidence_refs = serde_json::json!({
            "run_id": run_id,
            "corrected_run_id": run_id,
        });
        NewSkillCandidate {
            source_kind: CandidateSourceKind::UserCorrection,
            session_id: session_id.to_string(),
            trace_hash: correction_trace_hash(session_id, "retry", run_id),
            draft_payload_json: draft_payload.to_string(),
            evidence_refs_json: evidence_refs.to_string(),
        }
    }

    fn insert_candidate(db: &Arc<ChatV2Database>, candidate: &NewSkillCandidate) -> String {
        let repo = SkillCandidateRepo::new(db.clone());
        assert!(
            repo.insert_if_new(candidate).expect("insert"),
            "first insert"
        );
        repo.get_by_trace_hash(&candidate.trace_hash)
            .expect("get")
            .expect("stored")
            .candidate_id
    }

    /// P2 晋升测试环境：独立临时技能基目录（绝不触碰真实
    /// `~/.deep-student/skills`）。
    fn setup_promotion_env() -> (TempDir, TempDir, Arc<ChatV2Database>) {
        let (db_dir, db) = setup_test_db();
        let skills_dir = TempDir::new().expect("Failed to create skills temp dir");
        (db_dir, skills_dir, db)
    }

    fn candidate_status(db: &Arc<ChatV2Database>, candidate_id: &str) -> CandidateStatus {
        SkillCandidateRepo::new(db.clone())
            .get(candidate_id)
            .expect("get")
            .expect("stored")
            .status
    }

    // ------------------------------------------------------------------------
    // 状态机守卫：pending → validated/drifted → promoted（非法迁移拒绝）
    // ------------------------------------------------------------------------

    #[test]
    fn g09p1_replay_trajectory_passes_when_anchors_hold() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        insert_message(&db, "sess-1", "msg_run_1", "assistant");
        insert_message(&db, "sess-1", "msg_u1", "user");
        insert_tool_load(&db, "skill-a", "msg_run_1");

        let candidate_id = insert_candidate(
            &db,
            &trajectory_candidate(
                "sess-1",
                "msg_run_1",
                "msg_u1",
                &["vfs_search", "note_read", "anki_add_cards"],
                &["skill-a"],
            ),
        );

        let report = replay_candidate(&db, &candidate_id).expect("replay");
        assert!(report.still_valid);
        assert!(report.drift_reasons.is_empty());
        assert!(report.trace_hash_matches);
        assert_eq!(
            report.trace_hash_recomputed.as_deref(),
            Some(report.trace_hash_stored.as_str())
        );
        assert_eq!(report.previous_status, CandidateStatus::New);
        assert_eq!(report.resulting_status, CandidateStatus::Passed);
        assert_eq!(report.source_kind, CandidateSourceKind::Trajectory);
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::Passed
        );

        // 一次性对账语义：passed 之后不可重放
        let err = replay_candidate(&db, &candidate_id).expect_err("re-replay rejected");
        assert!(err.contains("not replayable"), "unexpected error: {}", err);
    }

    #[test]
    fn g09p1_replay_from_screened_also_works() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        insert_message(&db, "sess-1", "msg_u1", "user");
        let candidate_id = insert_candidate(&db, &edit_correction_candidate("sess-1", "msg_u1"));
        // new → screened（例如列表页人工初筛）
        assert!(SkillCandidateRepo::new(db.clone())
            .update_status(
                &candidate_id,
                CandidateStatus::New,
                CandidateStatus::Screened
            )
            .unwrap());

        let report = replay_candidate(&db, &candidate_id).expect("replay from screened");
        assert!(report.still_valid);
        assert_eq!(report.previous_status, CandidateStatus::Screened);
        assert_eq!(report.resulting_status, CandidateStatus::Passed);
    }

    #[test]
    fn g09p1_promote_requires_validated_status() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        let base = skills_dir.path();
        insert_session(&db, "sess-1");
        insert_message(&db, "sess-1", "msg_u1", "user");
        let candidate_id = insert_candidate(&db, &edit_correction_candidate("sess-1", "msg_u1"));

        // 非法迁移：new → published 直达被拒绝（不自动晋升）
        let err = promote_candidate_with_base(&db, &candidate_id, base)
            .expect_err("new must not promote");
        assert!(err.contains("must be validated"), "unexpected: {}", err);
        assert_eq!(candidate_status(&db, &candidate_id), CandidateStatus::New);

        // 合法链：replay（new→passed）→ promote（passed→published）
        replay_candidate(&db, &candidate_id).expect("replay");
        let promotion = promote_candidate_with_base(&db, &candidate_id, base).expect("promote");
        assert_eq!(promotion.status, CandidateStatus::Published);
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::Published
        );

        // 重复晋升：同 trace_hash 幂等返回既有文件（P2 起不再报错）
        let again = promote_candidate_with_base(&db, &candidate_id, base).expect("idempotent");
        assert!(!again.skill_file_written);
        // published / 终态候选不可回放
        assert!(replay_candidate(&db, &candidate_id).is_err());
    }

    #[test]
    fn g09p1_promote_returns_draft_payload_without_user_content() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        insert_session(&db, "sess-1");
        insert_message(&db, "sess-1", "msg_run_1", "assistant");
        insert_message(&db, "sess-1", "msg_u1", "user");
        insert_tool_load(&db, "skill-a", "msg_run_1");
        let candidate_id = insert_candidate(
            &db,
            &trajectory_candidate(
                "sess-1",
                "msg_run_1",
                "msg_u1",
                &["vfs_search", "note_read", "anki_add_cards"],
                &["skill-a"],
            ),
        );
        replay_candidate(&db, &candidate_id).expect("replay");

        let promotion =
            promote_candidate_with_base(&db, &candidate_id, skills_dir.path()).expect("promote");
        // 返回草稿可供后续流程建技能文件：统计字段齐全
        assert_eq!(
            promotion.draft_payload["tool_sequence"],
            serde_json::json!(["vfs_search", "note_read", "anki_add_cards"])
        );
        assert_eq!(
            promotion.draft_payload["skills_loaded"],
            serde_json::json!(["skill-a"])
        );
        // P0 隐私边界在 promote 通路保持：payload 只允许统计字段键
        let keys: Vec<&str> = promotion
            .draft_payload
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        assert_eq!(
            keys,
            vec![
                "kind",
                "tool_sequence",
                "tool_call_count",
                "failed_tool_call_count",
                "skills_loaded",
                "duration_ms",
                "total_tokens"
            ]
        );
    }

    // ------------------------------------------------------------------------
    // drift 检测
    // ------------------------------------------------------------------------

    #[test]
    fn g09p1_replay_trajectory_drifts_when_anchor_messages_deleted() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        insert_message(&db, "sess-1", "msg_run_1", "assistant");
        insert_message(&db, "sess-1", "msg_u1", "user");
        insert_tool_load(&db, "skill-a", "msg_run_1");
        // run 锚点被删（消息删除/会话清理后的环境漂移）
        delete_message(&db, "msg_run_1");
        let run_drifted = insert_candidate(
            &db,
            &trajectory_candidate(
                "sess-1",
                "msg_run_1",
                "msg_u1",
                &["a", "b", "c"],
                &["skill-a"],
            ),
        );

        let report = replay_candidate(&db, &run_drifted).expect("replay");
        assert!(!report.still_valid);
        assert!(
            report
                .drift_reasons
                .contains(&DRIFT_ANCHOR_RUN_MISSING.to_string()),
            "drift reasons: {:?}",
            report.drift_reasons
        );
        assert_eq!(report.resulting_status, CandidateStatus::Failed);
        assert_eq!(candidate_status(&db, &run_drifted), CandidateStatus::Failed);

        // 用户消息锚点被删
        insert_message(&db, "sess-1", "msg_run_2", "assistant");
        insert_tool_load(&db, "skill-a", "msg_run_2");
        delete_message(&db, "msg_u1");
        let user_drifted = insert_candidate(
            &db,
            &trajectory_candidate(
                "sess-1",
                "msg_run_2",
                "msg_u1",
                &["a", "b", "d"],
                &["skill-a"],
            ),
        );
        let report = replay_candidate(&db, &user_drifted).expect("replay");
        assert!(!report.still_valid);
        assert!(report
            .drift_reasons
            .contains(&DRIFT_ANCHOR_USER_MESSAGE_MISSING.to_string()));
    }

    #[test]
    fn g09p1_replay_trajectory_drifts_on_outcome_invalidation_and_skill_divergence() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        insert_message(&db, "sess-1", "msg_run_1", "assistant");
        insert_message(&db, "sess-1", "msg_u1", "user");
        insert_tool_load(&db, "skill-a", "msg_run_1");
        // 之后用户 retry 推翻了该 run → usage 行被 P0 收敛为 user_corrected
        // → "成功轨迹"前提失效
        SkillUsageRepo::new(db.clone())
            .mark_run_outcome("msg_run_1", SkillOutcome::UserCorrected)
            .unwrap();
        let invalidated = insert_candidate(
            &db,
            &trajectory_candidate(
                "sess-1",
                "msg_run_1",
                "msg_u1",
                &["a", "b", "c"],
                &["skill-a"],
            ),
        );
        let report = replay_candidate(&db, &invalidated).expect("replay");
        assert!(!report.still_valid);
        assert!(report
            .drift_reasons
            .contains(&DRIFT_OUTCOME_INVALIDATED.to_string()));

        // payload 声称的技能集合与实际账目不一致
        insert_message(&db, "sess-1", "msg_run_2", "assistant");
        insert_message(&db, "sess-1", "msg_u2", "user");
        insert_tool_load(&db, "skill-a", "msg_run_2");
        insert_tool_load(&db, "skill-b", "msg_run_2");
        let diverged = insert_candidate(
            &db,
            &trajectory_candidate(
                "sess-1",
                "msg_run_2",
                "msg_u2",
                &["a", "b", "d"],
                &["skill-a"],
            ),
        );
        let report = replay_candidate(&db, &diverged).expect("replay");
        assert!(!report.still_valid);
        assert!(report
            .drift_reasons
            .contains(&DRIFT_SKILLS_DIVERGED.to_string()));

        // payload 声称加载了技能但 run 账目已整体消失
        insert_message(&db, "sess-1", "msg_run_3", "assistant");
        insert_message(&db, "sess-1", "msg_u3", "user");
        let missing = insert_candidate(
            &db,
            &trajectory_candidate(
                "sess-1",
                "msg_run_3",
                "msg_u3",
                &["a", "b", "e"],
                &["skill-z"],
            ),
        );
        let report = replay_candidate(&db, &missing).expect("replay");
        assert!(!report.still_valid);
        assert!(report
            .drift_reasons
            .contains(&DRIFT_USAGE_ROWS_MISSING.to_string()));
    }

    #[test]
    fn g09p1_replay_edit_correction_drifts_after_anchor_delete() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        insert_session(&db, "sess-1");
        insert_message(&db, "sess-1", "msg_u_original", "user");

        // 锚点还在 → validated
        let ok = insert_candidate(&db, &edit_correction_candidate("sess-1", "msg_u_original"));
        let report = replay_candidate(&db, &ok).expect("replay");
        assert!(report.still_valid);
        assert_eq!(report.resulting_status, CandidateStatus::Passed);

        // 删掉候选锚定的 edit 行（用户消息）→ 回放报 drifted
        insert_message(&db, "sess-1", "msg_u_gone", "user");
        let drifted = insert_candidate(&db, &edit_correction_candidate("sess-1", "msg_u_gone"));
        delete_message(&db, "msg_u_gone");
        let report = replay_candidate(&db, &drifted).expect("replay");
        assert!(!report.still_valid);
        assert_eq!(
            report.drift_reasons,
            vec![DRIFT_ANCHOR_USER_MESSAGE_MISSING.to_string()]
        );
        assert_eq!(candidate_status(&db, &drifted), CandidateStatus::Failed);
        // failed 之后不可重放、不可晋升
        assert!(replay_candidate(&db, &drifted).is_err());
        assert!(promote_candidate_with_base(&db, &drifted, skills_dir.path()).is_err());
    }

    #[test]
    fn g09p1_replay_retry_correction_checks_usage_anchors() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");

        // 锚点齐全：被推翻 run 的 usage 行仍在且保持 user_corrected 标记
        insert_tool_load(&db, "skill-a", "msg_run_ok");
        SkillUsageRepo::new(db.clone())
            .mark_run_outcome("msg_run_ok", SkillOutcome::UserCorrected)
            .unwrap();
        let ok = insert_candidate(&db, &retry_correction_candidate("sess-1", "msg_run_ok"));
        let report = replay_candidate(&db, &ok).expect("replay");
        assert!(report.still_valid, "drifts: {:?}", report.drift_reasons);

        // usage 行仍在但 user_corrected 标记丢失 → drifted
        insert_tool_load(&db, "skill-a", "msg_run_unmarked");
        let unmarked = insert_candidate(
            &db,
            &retry_correction_candidate("sess-1", "msg_run_unmarked"),
        );
        let report = replay_candidate(&db, &unmarked).expect("replay");
        assert!(!report.still_valid);
        assert_eq!(
            report.drift_reasons,
            vec![DRIFT_CORRECTION_MARK_MISSING.to_string()]
        );

        // 被推翻 run 的 usage 行整体消失 → drifted
        let missing = insert_candidate(
            &db,
            &retry_correction_candidate("sess-1", "msg_run_vanished"),
        );
        let report = replay_candidate(&db, &missing).expect("replay");
        assert!(!report.still_valid);
        assert_eq!(
            report.drift_reasons,
            vec![DRIFT_ANCHOR_USAGE_MISSING.to_string()]
        );
    }

    #[test]
    fn g09p1_replay_unparseable_payload_fails_closed() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        // payload 损坏（不是合法 JSON）→ fail-closed：drifted 而不是 panic
        let candidate = NewSkillCandidate {
            source_kind: CandidateSourceKind::Trajectory,
            session_id: "sess-1".to_string(),
            trace_hash: "whatever".to_string(),
            draft_payload_json: "{not json".to_string(),
            evidence_refs_json: "{}".to_string(),
        };
        let candidate_id = insert_candidate(&db, &candidate);
        let report = replay_candidate(&db, &candidate_id).expect("replay");
        assert!(!report.still_valid);
        assert_eq!(
            report.drift_reasons,
            vec![DRIFT_PAYLOAD_UNPARSEABLE.to_string()]
        );
        assert_eq!(report.trace_hash_recomputed, None);
        assert!(!report.trace_hash_matches);
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::Failed
        );
    }

    // ------------------------------------------------------------------------
    // trace_hash 复核：确定性 + 篡改检测
    // ------------------------------------------------------------------------

    #[test]
    fn g09p1_trace_hash_recheck_is_deterministic() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        let candidate = trajectory_candidate(
            "sess-1",
            "msg_run_1",
            "msg_u1",
            &["vfs_search", "note_read", "anki_add_cards"],
            &["skill-a"],
        );
        let candidate_id = insert_candidate(&db, &candidate);
        let row = SkillCandidateRepo::new(db.clone())
            .get(&candidate_id)
            .unwrap()
            .unwrap();

        // 同输入同 hash：重算跑两次必须一致，且等于 P0 写入时的库存值
        let first = recompute_trace_hash(&row);
        let second = recompute_trace_hash(&row);
        assert_eq!(first, second);
        assert_eq!(first.as_deref(), Some(row.trace_hash.as_str()));
        assert_eq!(
            first.as_deref(),
            Some(
                trajectory_trace_hash(
                    "sess-1",
                    &[
                        "vfs_search".to_string(),
                        "note_read".to_string(),
                        "anki_add_cards".to_string()
                    ]
                )
                .as_str()
            )
        );

        // 纠错候选同样确定
        let correction = edit_correction_candidate("sess-1", "msg_u1");
        let correction_id = insert_candidate(&db, &correction);
        let row = SkillCandidateRepo::new(db.clone())
            .get(&correction_id)
            .unwrap()
            .unwrap();
        assert_eq!(recompute_trace_hash(&row), recompute_trace_hash(&row));
        assert_eq!(
            recompute_trace_hash(&row).as_deref(),
            Some(row.trace_hash.as_str())
        );
    }

    #[test]
    fn g09p1_replay_detects_trace_hash_tampering() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        insert_message(&db, "sess-1", "msg_run_1", "assistant");
        insert_message(&db, "sess-1", "msg_u1", "user");
        insert_tool_load(&db, "skill-a", "msg_run_1");
        let candidate_id = insert_candidate(
            &db,
            &trajectory_candidate(
                "sess-1",
                "msg_run_1",
                "msg_u1",
                &["a", "b", "c"],
                &["skill-a"],
            ),
        );
        // 直接改库篡改库存 trace_hash → 复核必须报 mismatch 且判 drifted
        let conn = db.get_conn().expect("conn");
        conn.execute(
            "UPDATE skill_candidates SET trace_hash = 'tampered' WHERE candidate_id = ?1",
            params![candidate_id],
        )
        .expect("tamper");

        let report = replay_candidate(&db, &candidate_id).expect("replay");
        assert!(!report.still_valid);
        assert!(!report.trace_hash_matches);
        assert_eq!(report.trace_hash_stored, "tampered");
        assert!(report.trace_hash_recomputed.is_some());
        assert!(report
            .drift_reasons
            .contains(&DRIFT_TRACE_HASH_MISMATCH.to_string()));
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::Failed
        );
    }

    // ------------------------------------------------------------------------
    // 列表摘要：隐私边界 + 过滤/limit
    // ------------------------------------------------------------------------

    #[test]
    fn g09p1_list_summaries_never_leak_draft_payload() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        // payload 里的唯一标记串：摘要序列化结果绝不允许包含它
        let marker = "PAYLOAD_MARKER_XYZ_NEVER_LEAK";
        let mut candidate = trajectory_candidate(
            "sess-1",
            "msg_run_1",
            "msg_u1",
            &["vfs_search", "note_read", "anki_add_cards"],
            &["skill-a"],
        );
        // 直接构造带标记的 payload（仍为合法 JSON，kind/工具序列保持原值，
        // trace_hash 因此仍与库存一致——本测试只验摘要泄漏，不验 hash）
        candidate.draft_payload_json = serde_json::json!({
            "kind": "trajectory",
            "tool_sequence": ["vfs_search", "note_read", "anki_add_cards"],
            "tool_call_count": 5,
            "failed_tool_call_count": 1,
            "skills_loaded": ["skill-a"],
            "duration_ms": 1200,
            "total_tokens": 3456,
            "marker": marker,
        })
        .to_string();
        insert_candidate(&db, &candidate);
        insert_candidate(&db, &edit_correction_candidate("sess-1", "msg_u9"));

        let all = list_candidate_summaries(&db, None, 50).expect("list");
        assert_eq!(all.len(), 2);
        let serialized = serde_json::to_string(&all).unwrap();
        assert!(
            !serialized.contains(marker),
            "summary must not leak payload fields"
        );
        assert!(!serialized.contains("draftPayloadJson"));
        assert!(!serialized.contains("evidenceRefsJson"));

        // 摘要字段与置信信号计数正确提取
        let trajectory = all
            .iter()
            .find(|s| s.source_kind == CandidateSourceKind::Trajectory)
            .expect("trajectory summary");
        assert_eq!(trajectory.skill_ids, vec!["skill-a".to_string()]);
        assert_eq!(trajectory.signals.distinct_tools, 3);
        assert_eq!(trajectory.signals.tool_calls, 5);
        assert_eq!(trajectory.signals.failed_tool_calls, 1);
        assert_eq!(trajectory.signals.skills_loaded, 1);
        assert_eq!(trajectory.status, CandidateStatus::New);
        assert_eq!(trajectory.session_id, "sess-1");
        assert!(!trajectory.trace_hash.is_empty());

        let correction = all
            .iter()
            .find(|s| s.source_kind == CandidateSourceKind::UserCorrection)
            .expect("correction summary");
        assert!(correction.skill_ids.is_empty(), "edit 纠错无技能信息");
        assert_eq!(correction.signals.distinct_tools, 0);

        // 状态过滤：DB 原名与任务层别名同效
        assert_eq!(
            list_candidate_summaries(&db, Some(CandidateStatus::New), 50)
                .unwrap()
                .len(),
            2
        );
        assert!(
            list_candidate_summaries(&db, Some(CandidateStatus::Passed), 50)
                .unwrap()
                .is_empty()
        );
        for (alias, expect) in [
            ("pending", Some(CandidateStatus::New)),
            ("validated", Some(CandidateStatus::Passed)),
            ("drifted", Some(CandidateStatus::Failed)),
            ("promoted", Some(CandidateStatus::Published)),
            ("rolled_back", Some(CandidateStatus::RolledBack)),
        ] {
            assert_eq!(parse_status_filter(alias), expect, "alias {}", alias);
        }
        assert_eq!(parse_status_filter("bogus"), None);

        // limit 生效
        assert_eq!(list_candidate_summaries(&db, None, 1).unwrap().len(), 1);
    }

    // ------------------------------------------------------------------------
    // G09-P2：晋升成文（SKILL.md 落盘 + 版本化 + 幂等 + 原子性）
    // ------------------------------------------------------------------------

    /// 造一个已通过回放的 trajectory 候选，返回 candidate_id。
    fn passed_trajectory_candidate(
        db: &Arc<ChatV2Database>,
        session_id: &str,
        run_id: &str,
        user_message_id: &str,
        tools: &[&str],
        skills: &[&str],
    ) -> String {
        insert_session(db, session_id);
        insert_message(db, session_id, run_id, "assistant");
        insert_message(db, session_id, user_message_id, "user");
        for skill_id in skills {
            insert_tool_load(db, skill_id, run_id);
        }
        let candidate_id = insert_candidate(
            db,
            &trajectory_candidate(session_id, run_id, user_message_id, tools, skills),
        );
        replay_candidate(db, &candidate_id).expect("replay to passed");
        candidate_id
    }

    fn get_candidate(db: &Arc<ChatV2Database>, candidate_id: &str) -> SkillCandidateRow {
        SkillCandidateRepo::new(db.clone())
            .get(candidate_id)
            .expect("get")
            .expect("stored")
    }

    #[test]
    fn g09p2_promote_writes_skill_file_with_lineage_frontmatter() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        let candidate_id = passed_trajectory_candidate(
            &db,
            "sess-1",
            "msg_run_1",
            "msg_u1",
            &["vfs_search", "note_read", "anki_add_cards"],
            &["skill-a"],
        );
        let row = get_candidate(&db, &candidate_id);

        let promotion =
            promote_candidate_with_base(&db, &candidate_id, skills_dir.path()).expect("promote");
        assert_eq!(promotion.status, CandidateStatus::Published);
        assert!(promotion.skill_file_written);
        assert_eq!(promotion.skill_version, 1);
        assert!(promotion.skill_id.starts_with(LEARNED_WORKFLOW_PREFIX));

        let skill_file = PathBuf::from(&promotion.skill_file_path);
        assert!(skill_file.is_file());
        assert_eq!(
            skill_file
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap(),
            promotion.skill_id
        );
        let content = std::fs::read_to_string(&skill_file).unwrap();
        // frontmatter 齐全：name/description/version/来源候选 id/trace_hash 血缘
        assert!(content.starts_with("---\n"));
        assert!(content.contains(&format!("\nname: {}\n", promotion.skill_id)));
        assert!(content.contains("\ndescription: \""));
        assert!(content.contains("\nversion: 1\n"));
        assert!(content.contains("\nsource: g09_candidate\n"));
        assert!(content.contains("\nsource_kind: trajectory\n"));
        assert!(content.contains(&format!("\nsource_candidate_id: {}\n", candidate_id)));
        assert!(content.contains(&format!("\ntrace_hash: {}\n", row.trace_hash)));
        // 正文：工作流步骤 + 观测统计（统计量，无用户内容）
        assert!(content.contains("vfs_search → note_read → anki_add_cards"));
        assert!(content.contains("`skill-a`"));
        assert!(content.contains("成功 3 次"));
        assert!(
            !content.contains("sess-1"),
            "skill body must not contain session id"
        );

        // AGENT_INSTALLED 标记同目录落盘（默认不受信，走 skill_trust 授权链）
        let marker_path = skill_file.parent().unwrap().join(AGENT_INSTALLED_MARKER);
        assert!(marker_path.is_file());
        let marker: Value =
            serde_json::from_str(&std::fs::read_to_string(&marker_path).unwrap()).unwrap();
        assert_eq!(marker["sourceKind"], "g09_candidate");
        assert_eq!(marker["proposalId"], Value::String(candidate_id.clone()));
        assert_eq!(marker["packageVersion"], 1);
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::Published
        );
    }

    #[test]
    fn g09p2_promote_idempotent_returns_existing_file() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        let candidate_id = passed_trajectory_candidate(
            &db,
            "sess-1",
            "msg_run_1",
            "msg_u1",
            &["vfs_search", "note_read", "anki_add_cards"],
            &["skill-a"],
        );

        let first = promote_candidate_with_base(&db, &candidate_id, skills_dir.path())
            .expect("first promote");
        let bytes_first = std::fs::read(&first.skill_file_path).expect("read first");

        // 同 trace_hash 重复 promote：幂等返回既有文件，不改写、不递增版本
        let second = promote_candidate_with_base(&db, &candidate_id, skills_dir.path())
            .expect("idempotent promote");
        assert!(!second.skill_file_written);
        assert_eq!(second.skill_version, 1);
        assert_eq!(second.skill_file_path, first.skill_file_path);
        assert_eq!(second.status, CandidateStatus::Published);
        let bytes_second = std::fs::read(&second.skill_file_path).expect("read second");
        assert_eq!(bytes_first, bytes_second, "idempotent hit must not rewrite");
    }

    #[test]
    fn g09p2_promote_new_version_increments_for_same_workflow() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        // 同一工作流（工具序列相同）在不同会话的新观测：trace_hash 不同、
        // 技能身份相同 → 版本递增
        let first_id = passed_trajectory_candidate(
            &db,
            "sess-1",
            "msg_run_1",
            "msg_u1",
            &["a", "b", "c"],
            &["skill-a"],
        );
        let second_id = passed_trajectory_candidate(
            &db,
            "sess-2",
            "msg_run_2",
            "msg_u2",
            &["a", "b", "c"],
            &["skill-a"],
        );
        let first =
            promote_candidate_with_base(&db, &first_id, skills_dir.path()).expect("first promote");
        assert_eq!(first.skill_version, 1);

        let second = promote_candidate_with_base(&db, &second_id, skills_dir.path())
            .expect("second promote");
        assert_eq!(second.skill_id, first.skill_id, "same workflow signature");
        assert_eq!(second.skill_version, 2, "new observation bumps version");
        assert!(second.skill_file_written);

        let row2 = get_candidate(&db, &second_id);
        let content = std::fs::read_to_string(&second.skill_file_path).unwrap();
        assert!(content.contains("\nversion: 2\n"));
        assert!(content.contains(&format!("\nsource_candidate_id: {}\n", second_id)));
        assert!(content.contains(&format!("\ntrace_hash: {}\n", row2.trace_hash)));
        // 两个候选都已发布
        assert_eq!(candidate_status(&db, &first_id), CandidateStatus::Published);
        assert_eq!(
            candidate_status(&db, &second_id),
            CandidateStatus::Published
        );
    }

    #[test]
    fn g09p2_promote_failure_leaves_no_partial_file_and_status_passed() {
        let (_db_dir, work_dir, db) = setup_promotion_env();
        let candidate_id = passed_trajectory_candidate(
            &db,
            "sess-1",
            "msg_run_1",
            "msg_u1",
            &["vfs_search", "note_read", "anki_add_cards"],
            &["skill-a"],
        );

        // 把基目录占位成普通文件 → 暂存目录创建必然失败（模拟中途失败）
        let blocked_base = work_dir.path().join("blocked-base");
        std::fs::write(&blocked_base, b"not a directory").expect("write blocker");
        let err = promote_candidate_with_base(&db, &candidate_id, &blocked_base)
            .expect_err("install must fail");
        assert!(
            err.contains("Failed to create skills base"),
            "unexpected error: {}",
            err
        );
        // 状态保持 passed（等价"失败回滚到 passed"），可重试
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::Passed
        );
        // 无半个文件残留：工作目录里只有占位文件，无 .staging-* 残骸
        let entries: Vec<String> = std::fs::read_dir(work_dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["blocked-base"], "residue: {:?}", entries);

        // 修复环境后重试成功（self-heal）
        let good_base = work_dir.path().join("skills");
        let promotion = promote_candidate_with_base(&db, &candidate_id, &good_base)
            .expect("retry after failure");
        assert!(promotion.skill_file_written);
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::Published
        );
    }

    #[test]
    fn g09p2_promote_refuses_foreign_skill_collision() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        let candidate_id = passed_trajectory_candidate(
            &db,
            "sess-1",
            "msg_run_1",
            "msg_u1",
            &["vfs_search", "note_read", "anki_add_cards"],
            &["skill-a"],
        );
        let row = get_candidate(&db, &candidate_id);
        let skill_id = derive_learned_skill_id(&row).expect("derive");

        // 同名目录被用户自建技能（无 G09 血缘）占用 → 拒绝覆盖
        let foreign_dir = skills_dir.path().join(&skill_id);
        std::fs::create_dir_all(&foreign_dir).expect("mkdir foreign");
        let foreign_content = "---\nname: custom\n---\n用户自建技能。";
        std::fs::write(foreign_dir.join(SKILL_FILE_NAME), foreign_content).expect("write foreign");

        let err = promote_candidate_with_base(&db, &candidate_id, skills_dir.path())
            .expect_err("collision must be rejected");
        assert!(err.contains("collision"), "unexpected: {}", err);
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::Passed,
            "collision failure keeps status at passed"
        );
        assert_eq!(
            std::fs::read_to_string(foreign_dir.join(SKILL_FILE_NAME)).unwrap(),
            foreign_content,
            "foreign skill must not be touched"
        );
    }

    #[test]
    fn g09p2_promote_correction_candidate_renders_counter_example_doc() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        insert_session(&db, "sess-1");
        insert_tool_load(&db, "skill-a", "msg_run_ok");
        SkillUsageRepo::new(db.clone())
            .mark_run_outcome("msg_run_ok", SkillOutcome::UserCorrected)
            .unwrap();
        let candidate_id =
            insert_candidate(&db, &retry_correction_candidate("sess-1", "msg_run_ok"));
        replay_candidate(&db, &candidate_id).expect("replay");

        let promotion = promote_candidate_with_base(&db, &candidate_id, skills_dir.path())
            .expect("promote correction");
        assert!(promotion.skill_id.starts_with(LEARNED_CORRECTION_PREFIX));
        let content = std::fs::read_to_string(&promotion.skill_file_path).unwrap();
        assert!(content.contains("\nsource_kind: user_correction\n"));
        assert!(content.contains("习得反例"));
        assert!(content.contains("`retry`"));
        assert!(content.contains("`skill-a`"));
    }

    // ------------------------------------------------------------------------
    // G09-P2：回滚（状态机 + 技能文件退役归档）
    // ------------------------------------------------------------------------

    #[test]
    fn g09p2_rollback_retires_skill_file_into_archive() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        let candidate_id = passed_trajectory_candidate(
            &db,
            "sess-1",
            "msg_run_1",
            "msg_u1",
            &["vfs_search", "note_read", "anki_add_cards"],
            &["skill-a"],
        );
        let promotion =
            promote_candidate_with_base(&db, &candidate_id, skills_dir.path()).expect("promote");
        let skill_dir = PathBuf::from(&promotion.skill_file_path)
            .parent()
            .unwrap()
            .to_path_buf();
        assert!(skill_dir.is_dir());

        let rollback =
            rollback_candidate_with_base(&db, &candidate_id, skills_dir.path()).expect("rollback");
        assert_eq!(rollback.status, CandidateStatus::RolledBack);
        assert_eq!(rollback.skill_id, promotion.skill_id);
        assert!(rollback.retired_from.is_some());

        // 目录整体迁入 .archive 隐藏子目录（含 SKILL.md 与标记，不物理删除）
        let archived = PathBuf::from(rollback.archived_to.clone().expect("archived_to"));
        assert!(archived.is_dir());
        assert!(archived.join(SKILL_FILE_NAME).is_file());
        assert!(archived.join(AGENT_INSTALLED_MARKER).is_file());
        assert_eq!(
            archived.parent().unwrap().file_name().unwrap(),
            SKILL_ARCHIVE_SUBDIR
        );
        assert!(!skill_dir.exists(), "live dir must be retired");
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::RolledBack
        );

        // 重复回滚被拒绝（rolled_back 不是合法前驱）；回滚后不可再晋升
        let err = rollback_candidate_with_base(&db, &candidate_id, skills_dir.path())
            .expect_err("re-rollback rejected");
        assert!(err.contains("must be 'published'"), "unexpected: {}", err);
        assert!(promote_candidate_with_base(&db, &candidate_id, skills_dir.path()).is_err());
    }

    #[test]
    fn g09p2_rollback_requires_published_status() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        insert_session(&db, "sess-1");
        insert_message(&db, "sess-1", "msg_u1", "user");
        let candidate_id = insert_candidate(&db, &edit_correction_candidate("sess-1", "msg_u1"));

        // new → 拒绝
        let err = rollback_candidate_with_base(&db, &candidate_id, skills_dir.path())
            .expect_err("new must not rollback");
        assert!(err.contains("must be 'published'"), "unexpected: {}", err);
        assert_eq!(candidate_status(&db, &candidate_id), CandidateStatus::New);

        // passed → 同样拒绝（只有 published 可回滚）
        replay_candidate(&db, &candidate_id).expect("replay");
        assert!(rollback_candidate_with_base(&db, &candidate_id, skills_dir.path()).is_err());
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::Passed
        );
        // 无文件副作用：归档目录未被创建
        assert!(!skills_dir.path().join(SKILL_ARCHIVE_SUBDIR).exists());
    }

    #[test]
    fn g09p2_rollback_tolerates_missing_skill_dir() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        let candidate_id = passed_trajectory_candidate(
            &db,
            "sess-1",
            "msg_run_1",
            "msg_u1",
            &["vfs_search", "note_read", "anki_add_cards"],
            &["skill-a"],
        );
        let promotion =
            promote_candidate_with_base(&db, &candidate_id, skills_dir.path()).expect("promote");
        // 技能目录被外部删除 → 回滚仍推进状态机（退役为空操作）
        let skill_dir = PathBuf::from(&promotion.skill_file_path)
            .parent()
            .unwrap()
            .to_path_buf();
        std::fs::remove_dir_all(&skill_dir).expect("remove skill dir");

        let rollback = rollback_candidate_with_base(&db, &candidate_id, skills_dir.path())
            .expect("rollback with missing dir");
        assert_eq!(rollback.status, CandidateStatus::RolledBack);
        assert_eq!(rollback.retired_from, None);
        assert_eq!(rollback.archived_to, None);
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::RolledBack
        );
    }

    // ------------------------------------------------------------------------
    // G09-P2：outcome_failed 失败反例的回放锚点
    // ------------------------------------------------------------------------

    fn outcome_failed_candidate(
        session_id: &str,
        run_id: &str,
        skills: &[&str],
    ) -> NewSkillCandidate {
        let draft_payload = serde_json::json!({
            "kind": "user_correction",
            "trigger": "outcome_failed",
            "corrected_run_id": run_id,
            "corrected_skill_ids": skills,
            "verdict": "partial",
        });
        let evidence_refs = serde_json::json!({
            "run_id": run_id,
            "corrected_run_id": run_id,
        });
        NewSkillCandidate {
            source_kind: CandidateSourceKind::UserCorrection,
            session_id: session_id.to_string(),
            trace_hash: correction_trace_hash(session_id, "outcome_failed", run_id),
            draft_payload_json: draft_payload.to_string(),
            evidence_refs_json: evidence_refs.to_string(),
        }
    }

    #[test]
    fn g09p2_replay_outcome_failed_candidate_checks_failure_anchor() {
        let (_db_dir, skills_dir, db) = setup_promotion_env();
        insert_session(&db, "sess-1");

        // 锚点齐全：失败 run 的 usage 行仍在且保持 failed 终态标记
        insert_tool_load(&db, "skill-a", "msg_run_bad");
        SkillUsageRepo::new(db.clone())
            .mark_run_outcome("msg_run_bad", SkillOutcome::Failed)
            .unwrap();
        let ok = insert_candidate(
            &db,
            &outcome_failed_candidate("sess-1", "msg_run_bad", &["skill-a"]),
        );
        let report = replay_candidate(&db, &ok).expect("replay");
        assert!(report.still_valid, "drifts: {:?}", report.drift_reasons);
        assert_eq!(report.resulting_status, CandidateStatus::Passed);

        // 失败反例同样可以晋升成文（反例文档含验收终态行）
        let promotion = promote_candidate_with_base(&db, &ok, skills_dir.path())
            .expect("promote outcome_failed");
        let content = std::fs::read_to_string(&promotion.skill_file_path).unwrap();
        assert!(content.contains("\nsource_kind: user_correction\n"));
        assert!(content.contains("`outcome_failed`"));
        assert!(content.contains("验收终态：`partial`"));

        // usage 行仍在但 failed 标记丢失（如被外部重置）→ drifted
        insert_tool_load(&db, "skill-a", "msg_run_unmarked");
        let unmarked = insert_candidate(
            &db,
            &outcome_failed_candidate("sess-1", "msg_run_unmarked", &["skill-a"]),
        );
        let report = replay_candidate(&db, &unmarked).expect("replay");
        assert!(!report.still_valid);
        assert_eq!(
            report.drift_reasons,
            vec![DRIFT_FAILURE_MARK_MISSING.to_string()]
        );

        // 失败 run 的 usage 行整体消失 → drifted
        let missing = insert_candidate(
            &db,
            &outcome_failed_candidate("sess-1", "msg_run_vanished", &["skill-a"]),
        );
        let report = replay_candidate(&db, &missing).expect("replay");
        assert!(!report.still_valid);
        assert_eq!(
            report.drift_reasons,
            vec![DRIFT_ANCHOR_USAGE_MISSING.to_string()]
        );
    }
}
