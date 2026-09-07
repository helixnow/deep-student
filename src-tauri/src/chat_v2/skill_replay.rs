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
//! published ──▶ rolled_back   （P2 预留，本模块不提供入口）
//! ```
//!
//! **不做任何自动行为**：回放与晋升都必须由命令显式触发；passed 候选绝不
//! 自动变 published；技能文件的创建不是本模块职责——promote 只推进状态机
//! 并返回 draft_payload 草稿（实际建文件由用户/后续流程负责）。
//!
//! **隐私边界**（与 P0 同级红线）：
//! - `chat_v2_list_skill_candidates` 只返回摘要（id/kind/status/trace_hash/
//!   技能 ID/置信信号计数/时间戳），**绝不返回 draft_payload_json /
//!   evidence_refs_json**；
//! - replay / promote 的日志只落 candidate_id、状态与漂移原因码，不落任何
//!   payload 内容；
//! - trace_hash 复核不哈希任何 serde 结构体：从库存 draft_payload 解析出
//!   原始输入（工具名序列数组 / 纠错锚点 id），重新调用 P0 的
//!   [`trajectory_trace_hash`] / [`correction_trace_hash`]（Sha256 over 字符串
//!   join，天然确定性，无 HashMap 迭代序问题——AGENTS.md 红线）。
//!
//! **P2 预留**：晋升后的技能文件生成、以及技能上线后的效果回流（outcome
//! 收敛进 skill_usage）由 G09-P2 实现；本模块的 [`ReplayReport`] /
//! [`SkillCandidatePromotion`] 已携带 P2 所需的全部句柄（candidate_id、
//! source_kind、trace_hash、draft_payload）。

use std::collections::BTreeSet;
use std::sync::Arc;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use super::database::ChatV2Database;
use super::skill_usage::{
    correction_trace_hash, trajectory_trace_hash, CandidateSourceKind, CandidateStatus,
    SkillCandidateRepo, SkillCandidateRow, SkillOutcome, SkillUsageRepo,
};

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
/// token 数），按 P0 隐私边界本就不含用户内容；实际创建技能文件由用户/
/// 后续流程负责，本命令只做状态机推进 + 返回草稿。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCandidatePromotion {
    pub candidate_id: String,
    pub status: CandidateStatus,
    pub draft_payload: Value,
    pub promoted_at: String,
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
    /// P0 写入的触发信号：`edit_and_resend` / `retry`。
    trigger: String,
    /// 纠错锚点：edit → 被编辑的用户消息 id；retry → 被推翻 run 的 id。
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
    if !matches!(
        row.status,
        CandidateStatus::New | CandidateStatus::Screened
    ) {
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
// 人工晋升（状态机推进 + 返回草稿；绝不自动触发）
// ============================================================================

/// 把候选从 passed 推进到 published 并返回 draft_payload 草稿（同步，可单测）。
///
/// 守卫：只有 passed（validated）候选可晋升——未回放/回放失败的候选一律
/// 拒绝；`update_status` 的 WHERE 守卫同时挡住并发双晋升。
pub fn promote_candidate(
    db: &Arc<ChatV2Database>,
    candidate_id: &str,
) -> Result<SkillCandidatePromotion, String> {
    let repo = SkillCandidateRepo::new(db.clone());
    let row = repo
        .get(candidate_id)?
        .ok_or_else(|| format!("skill candidate not found: {}", candidate_id))?;
    if row.status != CandidateStatus::Passed {
        return Err(format!(
            "skill candidate {} must be validated ('passed') before promote; current status '{}'",
            candidate_id,
            row.status.as_str()
        ));
    }
    let draft_payload: Value = serde_json::from_str(&row.draft_payload_json).map_err(|e| {
        format!(
            "skill candidate {} draft payload is unparseable: {}",
            candidate_id, e
        )
    })?;
    if !repo.update_status(candidate_id, CandidateStatus::Passed, CandidateStatus::Published)? {
        return Err(format!(
            "skill candidate {} status changed concurrently during promote",
            candidate_id
        ));
    }
    // 日志只落 id，不落 draft_payload（隐私红线）。
    log::info!(
        "[G09::skill_replay] promoted: id={} (draft payload returned to caller, not logged)",
        candidate_id
    );
    Ok(SkillCandidatePromotion {
        candidate_id: candidate_id.to_string(),
        status: CandidateStatus::Published,
        draft_payload,
        promoted_at: now_rfc3339(),
    })
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
        return Err(format!("invalid candidate_id length: {}", candidate_id.len()));
    }
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || replay_candidate(&db, &candidate_id))
        .await
        .map_err(|e| format!("replay skill candidate task join error: {}", e))?
}

/// 人工晋升：把已验证（passed）候选置为 published 并返回 draft_payload 草稿。
/// 实际创建技能文件由用户/后续流程负责；本命令绝不自动触发。
#[tauri::command]
pub async fn chat_v2_promote_skill_candidate(
    candidate_id: String,
    db: tauri::State<'_, Arc<ChatV2Database>>,
) -> Result<SkillCandidatePromotion, String> {
    let candidate_id = candidate_id.trim().to_string();
    if candidate_id.is_empty() || candidate_id.len() > 255 {
        return Err(format!("invalid candidate_id length: {}", candidate_id.len()));
    }
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || promote_candidate(&db, &candidate_id))
        .await
        .map_err(|e| format!("promote skill candidate task join error: {}", e))?
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::skill_usage::{
        NewSkillCandidate, NewSkillUsage, SkillUsageKind,
    };
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
        assert!(repo.insert_if_new(candidate).expect("insert"), "first insert");
        repo.get_by_trace_hash(&candidate.trace_hash)
            .expect("get")
            .expect("stored")
            .candidate_id
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
        assert_eq!(candidate_status(&db, &candidate_id), CandidateStatus::Passed);

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
            .update_status(&candidate_id, CandidateStatus::New, CandidateStatus::Screened)
            .unwrap());

        let report = replay_candidate(&db, &candidate_id).expect("replay from screened");
        assert!(report.still_valid);
        assert_eq!(report.previous_status, CandidateStatus::Screened);
        assert_eq!(report.resulting_status, CandidateStatus::Passed);
    }

    #[test]
    fn g09p1_promote_requires_validated_status() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        insert_message(&db, "sess-1", "msg_u1", "user");
        let candidate_id = insert_candidate(&db, &edit_correction_candidate("sess-1", "msg_u1"));

        // 非法迁移：new → published 直达被拒绝（不自动晋升）
        let err = promote_candidate(&db, &candidate_id).expect_err("new must not promote");
        assert!(err.contains("must be validated"), "unexpected: {}", err);
        assert_eq!(candidate_status(&db, &candidate_id), CandidateStatus::New);

        // 合法链：replay（new→passed）→ promote（passed→published）
        replay_candidate(&db, &candidate_id).expect("replay");
        let promotion = promote_candidate(&db, &candidate_id).expect("promote");
        assert_eq!(promotion.status, CandidateStatus::Published);
        assert_eq!(
            candidate_status(&db, &candidate_id),
            CandidateStatus::Published
        );

        // 重复晋升被拒绝（published 不是合法前驱）
        assert!(promote_candidate(&db, &candidate_id).is_err());
        // published / 终态候选不可回放
        assert!(replay_candidate(&db, &candidate_id).is_err());
    }

    #[test]
    fn g09p1_promote_returns_draft_payload_without_user_content() {
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
        replay_candidate(&db, &candidate_id).expect("replay");

        let promotion = promote_candidate(&db, &candidate_id).expect("promote");
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
            &trajectory_candidate("sess-1", "msg_run_2", "msg_u1", &["a", "b", "d"], &["skill-a"]),
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
            &trajectory_candidate("sess-1", "msg_run_1", "msg_u1", &["a", "b", "c"], &["skill-a"]),
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
            &trajectory_candidate("sess-1", "msg_run_2", "msg_u2", &["a", "b", "d"], &["skill-a"]),
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
            &trajectory_candidate("sess-1", "msg_run_3", "msg_u3", &["a", "b", "e"], &["skill-z"]),
        );
        let report = replay_candidate(&db, &missing).expect("replay");
        assert!(!report.still_valid);
        assert!(report
            .drift_reasons
            .contains(&DRIFT_USAGE_ROWS_MISSING.to_string()));
    }

    #[test]
    fn g09p1_replay_edit_correction_drifts_after_anchor_delete() {
        let (_dir, db) = setup_test_db();
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
        assert!(promote_candidate(&db, &drifted).is_err());
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
        assert_eq!(candidate_status(&db, &candidate_id), CandidateStatus::Failed);
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
                    &["vfs_search".to_string(), "note_read".to_string(), "anki_add_cards".to_string()]
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
            &trajectory_candidate("sess-1", "msg_run_1", "msg_u1", &["a", "b", "c"], &["skill-a"]),
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
        assert!(list_candidate_summaries(&db, Some(CandidateStatus::Passed), 50)
            .unwrap()
            .is_empty());
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
}
