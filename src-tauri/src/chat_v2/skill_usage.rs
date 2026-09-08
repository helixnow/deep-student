//! 技能使用后端账目 + 经验候选库（G09-P0：只记录，不回放）。
//!
//! 此前技能使用统计只有前端 localStorage 计数
//! （`src/features/chat/skills/skillUsageStats.ts`），无后端表、无 outcome、
//! 无 token/延迟。本模块把"技能被用了没有、用得怎么样"落到 chat_v2 库
//! （迁移 V20260909），并在轮末（`pipeline/persistence.rs
//! save_results_post_commit` 旁）做**零 LLM 成本**的经验候选检测：
//!
//! - **usage 账目**：成功的 `load_skills` 工具调用按 (skill, run) 聚合写入
//!   `skill_usage`（kind='tool_load'）；前端显式激活经
//!   `chat_v2_record_skill_activation` 命令写入（kind='activation'，
//!   run_id=NULL）。两条通路互不重叠，不会双计。
//! - **trajectory 候选**：一轮成功完成（save_results 事务提交）且成功工具
//!   序列 ≥3 个不同工具、且本轮不是纠错触发的重跑 → 写正例候选。
//! - **user_correction 候选**：edit_and_resend / retry 信号 → 写反例候选。
//!   检测精确锚点（均在写入本轮 usage 行之前探测）：
//!     - edit_and_resend 复用原用户消息 id → 该消息行在库中存在；
//!     - retry 复用被删助手消息 id 作为新 run_id → 该 run_id 已有 usage 行
//!       （来自被推翻的那次运行）。
//!   retry 命中时把被推翻 run 的 usage 行 outcome 从 unknown 收敛为
//!   user_corrected；edit 路径锚点是用户消息而非 run，不回标 usage 行。
//!   P0 已知缺口：被推翻的 run 若没有任何技能加载（无 usage 行），retry
//!   不产生候选；wake/goal 续跑等系统轮被 correction_hint 粗筛后经上述
//!   DB 探针排除，不会落候选。
//!
//! **隐私边界**：`draft_payload_json` 只存工具名序列、技能 ID、计数、耗时、
//! token 数等统计量；**绝不写入用户消息内容、助手回复内容、工具输入输出**。
//! `evidence_refs_json` 只存不透明 id 引用。测试 `privacy_*` 用例强制该边界。
//!
//! **outcome 终态对接（G09-P2 已接）**：G07 `finalizer.rs` 在完成块写入
//! `toolOutput.finalization.verdict`；tool_loop 在 finalize 返回后调
//! [`on_task_finalized`]（立即通路：该 run 已存在的 unknown 行直接收敛），
//! 轮末 `process_turn` 在写入本轮账目行后按同一映射补标（延迟通路——
//! 账目行在 save_results_post_commit 才落账，两轮通路都以 unknown 守卫防
//! 覆盖）。映射：verified_complete/complete_with_exceptions→success、
//! partial/blocked→failed、outcome_unknown→不标记。终态失败且本轮加载过
//! 技能时另写 trigger='outcome_failed' 的失败反例候选（trace_hash 锚定
//! 失败 run，复用候选插入通路，不新造表）。
//!
//! **P1 回放器接口预留**：[`SkillCandidateRepo::list_by_status`] 拉取
//! `status='new'` 候选；[`SkillCandidateRepo::update_status`] 提供原子守卫的
//! 状态迁移（new → screened → replaying → passed/failed → published →
//! rolled_back）；[`SkillUsageRepo::list_by_run`]/[`SkillUsageRepo::list_by_skill`]
//! 供回放器取回某次运行/某技能的全部账目。

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::context::PipelineContext;
use super::database::ChatV2Database;
use super::types::{SendOptions, ToolResultInfo};

/// trajectory 候选的"不同成功工具数"门槛（轮末零成本检测）。
const TRAJECTORY_MIN_DISTINCT_TOOLS: usize = 3;

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ============================================================================
// skill_usage 账目
// ============================================================================

/// 使用账目写入通路（与迁移 V20260909 的 CHECK 约束一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillUsageKind {
    /// 前端显式激活（面板点击 / 斜杠命令 / 默认技能注入），run_id 为 NULL。
    Activation,
    /// 轮末钩子从成功的 load_skills 工具结果聚合写入。
    ToolLoad,
}

impl SkillUsageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Activation => "activation",
            Self::ToolLoad => "tool_load",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "activation" => Some(Self::Activation),
            "tool_load" => Some(Self::ToolLoad),
            _ => None,
        }
    }
}

/// 使用账目终态（与迁移 V20260909 的 CHECK 约束一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillOutcome {
    Success,
    Failed,
    UserCorrected,
    Unknown,
}

impl SkillOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failed => "failed",
            Self::UserCorrected => "user_corrected",
            Self::Unknown => "unknown",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "success" => Some(Self::Success),
            "failed" => Some(Self::Failed),
            "user_corrected" => Some(Self::UserCorrected),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }

    /// G09-P2：G07 `FinalizationVerdict` → 账目终态映射。
    ///
    /// - `verified_complete` / `complete_with_exceptions` → success
    /// - `partial` / `blocked` → failed
    /// - `outcome_unknown`（及任何未知值）→ None（不标记）
    pub fn from_finalization_verdict(verdict: &str) -> Option<Self> {
        match verdict {
            "verified_complete" | "complete_with_exceptions" => Some(Self::Success),
            "partial" | "blocked" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// `skill_usage` 表的完整行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillUsageRow {
    pub usage_id: String,
    pub skill_id: String,
    pub task_session_id: String,
    pub run_id: Option<String>,
    pub kind: SkillUsageKind,
    pub loads: i64,
    pub outcome: SkillOutcome,
    pub latency_ms: Option<i64>,
    pub tokens: Option<i64>,
    pub created_at: String,
}

impl SkillUsageRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let kind_raw: String = row.get("kind")?;
        let outcome_raw: String = row.get("outcome")?;
        let invalid = |column: &str, raw: String| {
            let index = row.as_ref().column_index(column).unwrap_or(usize::MAX);
            rusqlite::Error::InvalidColumnType(index, raw, rusqlite::types::Type::Text)
        };
        Ok(Self {
            usage_id: row.get("usage_id")?,
            skill_id: row.get("skill_id")?,
            task_session_id: row.get("task_session_id")?,
            run_id: row.get("run_id")?,
            kind: SkillUsageKind::parse(&kind_raw)
                .ok_or_else(|| invalid("kind", kind_raw.clone()))?,
            loads: row.get("loads")?,
            outcome: SkillOutcome::parse(&outcome_raw)
                .ok_or_else(|| invalid("outcome", outcome_raw.clone()))?,
            latency_ms: row.get("latency_ms")?,
            tokens: row.get("tokens")?,
            created_at: row.get("created_at")?,
        })
    }
}

/// 新建 usage 行的写入参数。
#[derive(Debug, Clone)]
pub struct NewSkillUsage {
    pub skill_id: String,
    pub task_session_id: String,
    pub run_id: Option<String>,
    pub kind: SkillUsageKind,
    pub loads: i64,
    pub latency_ms: Option<i64>,
    pub tokens: Option<i64>,
}

/// 技能使用账目 repo。
#[derive(Clone)]
pub struct SkillUsageRepo {
    db: Arc<ChatV2Database>,
}

impl SkillUsageRepo {
    pub fn new(db: Arc<ChatV2Database>) -> Self {
        Self { db }
    }

    /// 插入一条使用账目（outcome 恒以 'unknown' 落库）。
    pub fn insert(&self, usage: &NewSkillUsage) -> Result<String, String> {
        let usage_id = format!("susage_{}", Uuid::new_v4());
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO skill_usage (
                usage_id, skill_id, task_session_id, run_id, kind, loads,
                outcome, latency_ms, tokens, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'unknown', ?7, ?8, ?9)",
            params![
                usage_id,
                usage.skill_id,
                usage.task_session_id,
                usage.run_id,
                usage.kind.as_str(),
                usage.loads,
                usage.latency_ms,
                usage.tokens,
                now_rfc3339(),
            ],
        )
        .map_err(|e| format!("failed to insert skill usage: {}", e))?;
        Ok(usage_id)
    }

    /// 前端显式激活的镜像写入（fire-and-forget 命令的后端落点）。
    ///
    /// `session_id` 不可解析时落空串（迁移默认值语义：'' = 未知会话）。
    pub fn record_activation(
        &self,
        skill_id: &str,
        session_id: Option<&str>,
    ) -> Result<String, String> {
        self.insert(&NewSkillUsage {
            skill_id: skill_id.to_string(),
            task_session_id: session_id.unwrap_or_default().to_string(),
            run_id: None,
            kind: SkillUsageKind::Activation,
            loads: 0,
            latency_ms: None,
            tokens: None,
        })
    }

    /// 把某次 run 的全部账目行 outcome 从 unknown 收敛为 `outcome`
    /// （原子守卫：已收敛的行不会被覆盖）。返回收敛行数。
    ///
    /// TODO(G07): TaskFinalizer 终态产出后由 finalizer 以 Success/Failed 调用。
    pub fn mark_run_outcome(&self, run_id: &str, outcome: SkillOutcome) -> Result<usize, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE skill_usage SET outcome = ?2 \
                 WHERE run_id = ?1 AND outcome = 'unknown'",
                params![run_id, outcome.as_str()],
            )
            .map_err(|e| format!("failed to mark skill usage outcome: {}", e))?;
        Ok(changed)
    }

    /// 该 run 是否已有 usage 行（retry 精确锚点：run_id 复用被删助手消息 id）。
    pub fn run_has_usage(&self, run_id: &str) -> Result<bool, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM skill_usage WHERE run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("failed to count skill usage for run: {}", e))?;
        Ok(count > 0)
    }

    /// 某次 run 内使用过的技能 ID（去重，user_correction 候选的证据摘要）。
    pub fn skill_ids_for_run(&self, run_id: &str) -> Result<Vec<String>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT skill_id FROM skill_usage \
                 WHERE run_id = ?1 ORDER BY skill_id",
            )
            .map_err(|e| format!("failed to prepare skill usage query: {}", e))?;
        let rows = stmt
            .query_map(params![run_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("failed to list skill ids for run: {}", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("failed to parse skill id: {}", e))?);
        }
        Ok(out)
    }

    /// P1 回放器接口预留：取回某次 run 的全部账目（按创建时间升序）。
    pub fn list_by_run(&self, run_id: &str) -> Result<Vec<SkillUsageRow>, String> {
        self.list_by("run_id = ?1", params![run_id])
    }

    /// P1 回放器接口预留：取回某技能的最近账目（按创建时间倒序）。
    pub fn list_by_skill(&self, skill_id: &str, limit: usize) -> Result<Vec<SkillUsageRow>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT * FROM skill_usage WHERE skill_id = ?1 \
                 ORDER BY created_at DESC, usage_id DESC LIMIT ?2",
            )
            .map_err(|e| format!("failed to prepare skill usage query: {}", e))?;
        let rows = stmt
            .query_map(params![skill_id, limit as i64], SkillUsageRow::from_row)
            .map_err(|e| format!("failed to list skill usage: {}", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("failed to parse skill usage row: {}", e))?);
        }
        Ok(out)
    }

    fn list_by(
        &self,
        where_clause: &str,
        params: impl rusqlite::Params,
    ) -> Result<Vec<SkillUsageRow>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let sql = format!(
            "SELECT * FROM skill_usage WHERE {} ORDER BY created_at, usage_id",
            where_clause
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("failed to prepare skill usage query: {}", e))?;
        let rows = stmt
            .query_map(params, SkillUsageRow::from_row)
            .map_err(|e| format!("failed to list skill usage: {}", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("failed to parse skill usage row: {}", e))?);
        }
        Ok(out)
    }
}

// ============================================================================
// skill_candidates 经验候选
// ============================================================================

/// 候选来源（与迁移 V20260909 的 CHECK 约束一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateSourceKind {
    /// 成功完成的多工具体运行轨迹（正例）。
    Trajectory,
    /// 用户纠错信号（edit_and_resend / retry 推翻上一轮，反例）。
    UserCorrection,
}

impl CandidateSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trajectory => "trajectory",
            Self::UserCorrection => "user_correction",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "trajectory" => Some(Self::Trajectory),
            "user_correction" => Some(Self::UserCorrection),
            _ => None,
        }
    }
}

/// 候选状态机（与迁移 V20260909 的 CHECK 约束一致）。
///
/// P0 只写入 `new`；后续迁移由 P1 回放器驱动：
/// `new → screened → replaying → passed/failed → published → rolled_back`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateStatus {
    New,
    Screened,
    Replaying,
    Passed,
    Failed,
    Published,
    RolledBack,
}

impl CandidateStatus {
    pub const ALL: [Self; 7] = [
        Self::New,
        Self::Screened,
        Self::Replaying,
        Self::Passed,
        Self::Failed,
        Self::Published,
        Self::RolledBack,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Screened => "screened",
            Self::Replaying => "replaying",
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Published => "published",
            Self::RolledBack => "rolled_back",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|s| s.as_str() == raw)
    }

    /// 校验状态机迁移是否合法（无自环；failed/published 之后允许 rolled_back
    /// 之外的终态收敛见迁移头注释；rolled_back 为终态）。
    pub fn can_transition(from: Self, to: Self) -> bool {
        matches!(
            (from, to),
            (Self::New, Self::Screened)
                | (Self::Screened, Self::Replaying)
                | (Self::Replaying, Self::Passed)
                | (Self::Replaying, Self::Failed)
                | (Self::Passed, Self::Published)
                | (Self::Published, Self::RolledBack)
        )
    }
}

/// `skill_candidates` 表的完整行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillCandidateRow {
    pub candidate_id: String,
    pub source_kind: CandidateSourceKind,
    pub session_id: String,
    pub trace_hash: String,
    pub draft_payload_json: String,
    pub evidence_refs_json: String,
    pub status: CandidateStatus,
    pub created_at: String,
    pub updated_at: String,
}

impl SkillCandidateRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let kind_raw: String = row.get("source_kind")?;
        let status_raw: String = row.get("status")?;
        let invalid = |column: &str, raw: String| {
            let index = row.as_ref().column_index(column).unwrap_or(usize::MAX);
            rusqlite::Error::InvalidColumnType(index, raw, rusqlite::types::Type::Text)
        };
        Ok(Self {
            candidate_id: row.get("candidate_id")?,
            source_kind: CandidateSourceKind::parse(&kind_raw)
                .ok_or_else(|| invalid("source_kind", kind_raw.clone()))?,
            session_id: row.get("session_id")?,
            trace_hash: row.get("trace_hash")?,
            draft_payload_json: row.get("draft_payload_json")?,
            evidence_refs_json: row.get("evidence_refs_json")?,
            status: CandidateStatus::parse(&status_raw)
                .ok_or_else(|| invalid("status", status_raw.clone()))?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

/// 新建候选的写入参数。
#[derive(Debug, Clone)]
pub struct NewSkillCandidate {
    pub source_kind: CandidateSourceKind,
    pub session_id: String,
    pub trace_hash: String,
    pub draft_payload_json: String,
    pub evidence_refs_json: String,
}

/// trajectory 候选去重键：同一会话内相同成功工具序列只留一条候选。
pub fn trajectory_trace_hash(session_id: &str, tool_sequence: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"trajectory\n");
    hasher.update(session_id.as_bytes());
    hasher.update(b"\n");
    hasher.update(tool_sequence.join(",").as_bytes());
    hex::encode(hasher.finalize())
}

/// user_correction 候选去重键：同一会话内对同一被纠正锚点只留一条候选。
pub fn correction_trace_hash(session_id: &str, trigger: &str, corrected_ref: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"user_correction\n");
    hasher.update(session_id.as_bytes());
    hasher.update(b"\n");
    hasher.update(trigger.as_bytes());
    hasher.update(b"\n");
    hasher.update(corrected_ref.as_bytes());
    hex::encode(hasher.finalize())
}

/// 经验候选 repo。
#[derive(Clone)]
pub struct SkillCandidateRepo {
    db: Arc<ChatV2Database>,
}

impl SkillCandidateRepo {
    pub fn new(db: Arc<ChatV2Database>) -> Self {
        Self { db }
    }

    /// 以 trace_hash 去重插入候选（status 恒以 'new' 落库）。
    /// 返回 true = 本次新建；false = 相同 trace_hash 的候选已存在。
    pub fn insert_if_new(&self, candidate: &NewSkillCandidate) -> Result<bool, String> {
        let candidate_id = format!("cand_{}", Uuid::new_v4());
        let now = now_rfc3339();
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO skill_candidates (
                    candidate_id, source_kind, session_id, trace_hash,
                    draft_payload_json, evidence_refs_json,
                    status, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new', ?7, ?7)",
                params![
                    candidate_id,
                    candidate.source_kind.as_str(),
                    candidate.session_id,
                    candidate.trace_hash,
                    candidate.draft_payload_json,
                    candidate.evidence_refs_json,
                    now,
                ],
            )
            .map_err(|e| format!("failed to insert skill candidate: {}", e))?;
        Ok(changed > 0)
    }

    pub fn get(&self, candidate_id: &str) -> Result<Option<SkillCandidateRow>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT * FROM skill_candidates WHERE candidate_id = ?1",
            params![candidate_id],
            SkillCandidateRow::from_row,
        )
        .optional()
        .map_err(|e| format!("failed to read skill candidate: {}", e))
    }

    pub fn get_by_trace_hash(&self, trace_hash: &str) -> Result<Option<SkillCandidateRow>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT * FROM skill_candidates WHERE trace_hash = ?1",
            params![trace_hash],
            SkillCandidateRow::from_row,
        )
        .optional()
        .map_err(|e| format!("failed to read skill candidate by trace hash: {}", e))
    }

    /// P1 回放器接口预留：按状态拉取候选（按创建时间升序，先进先筛）。
    pub fn list_by_status(
        &self,
        status: CandidateStatus,
        limit: usize,
    ) -> Result<Vec<SkillCandidateRow>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT * FROM skill_candidates WHERE status = ?1 \
                 ORDER BY created_at, candidate_id LIMIT ?2",
            )
            .map_err(|e| format!("failed to prepare skill candidate query: {}", e))?;
        let rows = stmt
            .query_map(
                params![status.as_str(), limit as i64],
                SkillCandidateRow::from_row,
            )
            .map_err(|e| format!("failed to list skill candidates: {}", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("failed to parse skill candidate row: {}", e))?);
        }
        Ok(out)
    }

    /// 原子守卫的状态迁移（P1 回放器接口预留）：
    /// `UPDATE ... WHERE candidate_id = ? AND status = 期望前驱`，
    /// `changes() == 0` 即非法迁移/并发竞争，返回 false。
    pub fn update_status(
        &self,
        candidate_id: &str,
        expected: CandidateStatus,
        next: CandidateStatus,
    ) -> Result<bool, String> {
        if !CandidateStatus::can_transition(expected, next) {
            return Ok(false);
        }
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE skill_candidates SET status = ?3, updated_at = ?4 \
                 WHERE candidate_id = ?1 AND status = ?2",
                params![
                    candidate_id,
                    expected.as_str(),
                    next.as_str(),
                    now_rfc3339()
                ],
            )
            .map_err(|e| format!("failed to update skill candidate status: {}", e))?;
        Ok(changed > 0)
    }

    /// P1 回放器：按可选状态过滤列出候选（None = 全部状态；创建时间升序，
    /// 与 `list_by_status` 同序）。G09-P1 `skill_replay` 的列表命令使用。
    pub fn list_filtered(
        &self,
        status: Option<CandidateStatus>,
        limit: usize,
    ) -> Result<Vec<SkillCandidateRow>, String> {
        if let Some(status) = status {
            return self.list_by_status(status, limit);
        }
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT * FROM skill_candidates \
                 ORDER BY created_at, candidate_id LIMIT ?1",
            )
            .map_err(|e| format!("failed to prepare skill candidate query: {}", e))?;
        let rows = stmt
            .query_map(params![limit as i64], SkillCandidateRow::from_row)
            .map_err(|e| format!("failed to list skill candidates: {}", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("failed to parse skill candidate row: {}", e))?);
        }
        Ok(out)
    }
}

// ============================================================================
// 轮末检测（save_results_post_commit 挂点）
// ============================================================================

/// 本轮工具调用的最小 trace（**只含名字与成败，不含输入输出**——隐私边界）。
#[derive(Debug, Clone, Serialize)]
struct ToolCallTrace {
    name: String,
    success: bool,
    /// load_skills 成功调用实际加载的技能（requested − rejected）；
    /// 非 load_skills 调用恒为空。
    loaded_skill_ids: Vec<String>,
}

/// 从 PipelineContext 提取的轮末摘要（全 owned，可跨 spawn_blocking 边界）。
#[derive(Debug, Clone)]
struct TurnUsageSummary {
    session_id: String,
    /// 一次 run = 一次助手回合（assistant_message_id）。
    run_id: String,
    user_message_id: String,
    latency_ms: i64,
    total_tokens: i64,
    /// 粗筛：可能是纠错触发的重跑（skip_user_message_save + 非 headless + 非
    /// goal 续跑）。精确锚定由 process_turn 内的 DB 探针完成。
    correction_hint: bool,
    /// G09-P2：完成块 `toolOutput.finalization.verdict`（G07 终态，raw 字符串；
    /// 非任务完成轮为 None）。映射规则见
    /// [`SkillOutcome::from_finalization_verdict`]。
    finalization_verdict: Option<String>,
    tools: Vec<ToolCallTrace>,
}

impl TurnUsageSummary {
    fn from_ctx(ctx: &PipelineContext) -> Self {
        Self {
            session_id: ctx.session_id.clone(),
            run_id: ctx.assistant_message_id.clone(),
            user_message_id: ctx.user_message_id.clone(),
            latency_ms: ctx.start_time.elapsed().as_millis().min(i64::MAX as u128) as i64,
            total_tokens: i64::from(ctx.token_usage.total_tokens),
            correction_hint: detect_correction_hint(&ctx.options),
            finalization_verdict: finalization_verdict_of(&ctx.tool_results),
            tools: ctx.tool_results.iter().map(tool_trace).collect(),
        }
    }
}

/// 纠错粗筛（纯 ctx 字段，无 DB 访问）。
///
/// `skip_user_message_save=true` 的调用方：retry / edit_and_resend /
/// wake_session / goal 续跑 / headless。后三者在此排除：
/// - headless/worker：`execution_allowed_tools` 只由后端 headless 入口构造；
/// - goal 续跑：`schema_tool_ids` 注入 goal 三件套（goal/runtime.rs）；
/// - wake：留给 process_turn 的 DB 探针排除（无 edit 消息行、无 run usage 行）。
fn detect_correction_hint(options: &SendOptions) -> bool {
    if options.skip_user_message_save != Some(true) {
        return false;
    }
    if options.execution_allowed_tools.is_some() {
        return false;
    }
    let has_goal_schema_tools = options
        .schema_tool_ids
        .as_ref()
        .is_some_and(|ids| ids.iter().any(|id| id.starts_with("goal_")));
    !has_goal_schema_tools
}

/// 提取单个工具结果的最小 trace；对成功的 load_skills 解析实际加载的技能。
fn tool_trace(tr: &ToolResultInfo) -> ToolCallTrace {
    let loaded_skill_ids =
        if tr.success && crate::chat_v2::tools::SkillsExecutor::is_load_skills_tool(&tr.tool_name)
        {
            parse_load_skills_loaded(tr)
        } else {
            Vec::new()
        };
    ToolCallTrace {
        name: tr.tool_name.clone(),
        success: tr.success,
        loaded_skill_ids,
    }
}

/// 解析一次成功的 load_skills 实际加载的技能：请求侧 `input.skills`
/// （数组；兼容模型偶发的逗号分隔字符串，与前端容忍度对齐）减去输出侧
/// `result.rejected_skills` 的键。
fn parse_load_skills_loaded(tr: &ToolResultInfo) -> Vec<String> {
    let requested: Vec<String> = match tr.input.get("skills") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Some(Value::String(raw)) => raw
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    };
    if requested.is_empty() {
        return Vec::new();
    }
    let empty_map = serde_json::Map::new();
    let rejected = tr
        .output
        .get("result")
        .and_then(|r| r.get("rejected_skills"))
        .and_then(Value::as_object)
        .unwrap_or(&empty_map);
    let mut seen = std::collections::HashSet::new();
    requested
        .into_iter()
        .filter(|id| !rejected.contains_key(id.as_str()))
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

/// 轮末钩子入口（fire-and-forget）：提取摘要后 spawn_blocking，
/// 任何失败只 log，绝不拖垮主流程。
pub(crate) fn on_turn_committed(db: &Arc<ChatV2Database>, ctx: &PipelineContext) {
    let summary = TurnUsageSummary::from_ctx(ctx);
    // 空回合（无工具、非纠错）没有可记录内容，连 task 都不创建。
    if summary.tools.is_empty() && !summary.correction_hint {
        return;
    }
    let db = db.clone();
    tokio::task::spawn_blocking(move || {
        if let Err(err) = process_turn(&db, &summary) {
            log::warn!(
                "[G09::skill_usage] post-commit processing failed (non-fatal): session={}, run={}, err={}",
                summary.session_id,
                summary.run_id,
                err
            );
        }
    });
}

/// 轮末处理核心（同步，可单测）。
///
/// 顺序不变量：**纠错处理必须先于本轮 usage 行写入**——retry 复用被推翻
/// run 的 run_id，先完成标记/取证再写新行，新行才不会被误标。
fn process_turn(
    db: &Arc<ChatV2Database>,
    summary: &TurnUsageSummary,
) -> Result<(), String> {
    let usage_repo = SkillUsageRepo::new(db.clone());
    let candidate_repo = SkillCandidateRepo::new(db.clone());

    // 1. 纠错信号：写 user_correction 反例候选；retry 路径同时把被推翻 run 的
    //    usage 行 outcome 收敛为 user_corrected。
    let is_correction = if summary.correction_hint {
        process_correction(db, summary, &usage_repo, &candidate_repo)?
    } else {
        false
    };

    // 2. 本轮技能加载账目（每个被加载技能一行 tool_load，run 级延迟/token）。
    let mut load_counts: HashMap<String, i64> = HashMap::new();
    for tool in &summary.tools {
        for skill_id in &tool.loaded_skill_ids {
            *load_counts.entry(skill_id.clone()).or_insert(0) += 1;
        }
    }
    let mut loaded_skill_ids: Vec<String> = load_counts.keys().cloned().collect();
    loaded_skill_ids.sort();
    for skill_id in &loaded_skill_ids {
        usage_repo.insert(&NewSkillUsage {
            skill_id: skill_id.clone(),
            task_session_id: summary.session_id.clone(),
            run_id: Some(summary.run_id.clone()),
            kind: SkillUsageKind::ToolLoad,
            loads: load_counts.get(skill_id).copied().unwrap_or(0),
            latency_ms: Some(summary.latency_ms),
            tokens: Some(summary.total_tokens),
        })?;
    }

    // 2.5 G09-P2：G07 终态回流——本轮账目行落账后，按完成块
    //     `toolOutput.finalization.verdict` 收敛 outcome。
    //     顺序不变量：步骤 1 的纠错处理已先把被推翻 run 的旧行收敛为
    //     user_corrected，`mark_run_outcome` 的 unknown 守卫保证此处只
    //     标本轮新行（retry 复用 run_id 时旧行绝不被 verdict 覆盖）。
    let final_outcome = summary
        .finalization_verdict
        .as_deref()
        .and_then(SkillOutcome::from_finalization_verdict);
    if let Some(outcome) = final_outcome {
        let marked = usage_repo.mark_run_outcome(&summary.run_id, outcome)?;
        if marked > 0 {
            log::info!(
                "[G09::skill_usage] outcome reflux: session={}, run={}, verdict={:?}, outcome={}, rows={}",
                summary.session_id,
                summary.run_id,
                summary.finalization_verdict,
                outcome.as_str(),
                marked
            );
        }
        // 失败反例：终态失败且本轮加载过已发布技能 → 写 user_correction
        // 类候选（复用候选插入通路，insert_if_new 按 trace_hash 去重，
        // 同一失败 run 只留一条）。
        if outcome == SkillOutcome::Failed && !loaded_skill_ids.is_empty() {
            write_outcome_failed_candidate(summary, &loaded_skill_ids, &candidate_repo)?;
        }
    }

    // 3. trajectory 正例候选：非纠错触发 + 终态非失败 + ≥3 个不同成功工具。
    //    "任务成功完成" P2 语义 = save_results 事务提交到达轮末，且 G07
    //    验收未判失败（Partial/Blocked 的完成块不沉淀正例——它已在步骤 2.5
    //    被记为反例；OutcomeUnknown / 非任务轮保持 P0 行为）。
    if !is_correction && final_outcome != Some(SkillOutcome::Failed) {
        let mut seen = std::collections::HashSet::new();
        let tool_sequence: Vec<String> = summary
            .tools
            .iter()
            .filter(|tool| tool.success)
            .map(|tool| tool.name.clone())
            // load_skills 是元工具，不计入"工作流工具序列"（技能本身记在
            // payload.skills_loaded）
            .filter(|name| !crate::chat_v2::tools::SkillsExecutor::is_load_skills_tool(name))
            .filter(|name| seen.insert(name.clone()))
            .collect();
        if tool_sequence.len() >= TRAJECTORY_MIN_DISTINCT_TOOLS {
            let succeeded = summary
                .tools
                .iter()
                .filter(|tool| tool.success)
                .count() as i64;
            let failed = summary.tools.len() as i64 - succeeded;
            let draft_payload = serde_json::json!({
                "kind": "trajectory",
                "tool_sequence": tool_sequence,
                "tool_call_count": succeeded,
                "failed_tool_call_count": failed,
                "skills_loaded": loaded_skill_ids,
                "duration_ms": summary.latency_ms,
                "total_tokens": summary.total_tokens,
            });
            let evidence_refs = serde_json::json!({
                "run_id": summary.run_id,
                "user_message_id": summary.user_message_id,
            });
            candidate_repo.insert_if_new(&NewSkillCandidate {
                source_kind: CandidateSourceKind::Trajectory,
                session_id: summary.session_id.clone(),
                trace_hash: trajectory_trace_hash(&summary.session_id, &tool_sequence),
                draft_payload_json: draft_payload.to_string(),
                evidence_refs_json: evidence_refs.to_string(),
            })?;
        }
    }

    Ok(())
}

/// 纠错精确锚定 + 反例候选写入。返回是否确认本轮由纠错触发
/// （确认后本轮不再写 trajectory 正例）。
fn process_correction(
    db: &Arc<ChatV2Database>,
    summary: &TurnUsageSummary,
    usage_repo: &SkillUsageRepo,
    candidate_repo: &SkillCandidateRepo,
) -> Result<bool, String> {
    // edit_and_resend 锚点：复用原用户消息 id，该消息行在库中存在
    // （wake/retry 的 user_message_id 都是全新生成且 skip 保存，不会命中）。
    if message_exists(db, &summary.user_message_id)? {
        let evidence_refs = serde_json::json!({
            "run_id": summary.run_id,
            "corrected_user_message_id": summary.user_message_id,
        });
        let draft_payload = serde_json::json!({
            "kind": "user_correction",
            "trigger": "edit_and_resend",
            "corrected_user_message_id": summary.user_message_id,
        });
        candidate_repo.insert_if_new(&NewSkillCandidate {
            source_kind: CandidateSourceKind::UserCorrection,
            session_id: summary.session_id.clone(),
            trace_hash: correction_trace_hash(
                &summary.session_id,
                "edit_and_resend",
                &summary.user_message_id,
            ),
            draft_payload_json: draft_payload.to_string(),
            evidence_refs_json: evidence_refs.to_string(),
        })?;
        return Ok(true);
    }

    // retry 锚点：复用被删助手消息 id 作为新 run_id，被推翻 run 的 usage
    // 行因此与本轮同 run_id（本轮新行尚未写入，命中的必是被推翻 run 的行）。
    if usage_repo.run_has_usage(&summary.run_id)? {
        let corrected_skill_ids = usage_repo.skill_ids_for_run(&summary.run_id)?;
        let marked = usage_repo.mark_run_outcome(&summary.run_id, SkillOutcome::UserCorrected)?;
        log::info!(
            "[G09::skill_usage] user correction (retry): session={}, corrected_run={}, rows_marked={}",
            summary.session_id,
            summary.run_id,
            marked
        );
        let evidence_refs = serde_json::json!({
            "run_id": summary.run_id,
            "corrected_run_id": summary.run_id,
        });
        let draft_payload = serde_json::json!({
            "kind": "user_correction",
            "trigger": "retry",
            "corrected_run_id": summary.run_id,
            "corrected_skill_ids": corrected_skill_ids,
        });
        candidate_repo.insert_if_new(&NewSkillCandidate {
            source_kind: CandidateSourceKind::UserCorrection,
            session_id: summary.session_id.clone(),
            trace_hash: correction_trace_hash(&summary.session_id, "retry", &summary.run_id),
            draft_payload_json: draft_payload.to_string(),
            evidence_refs_json: evidence_refs.to_string(),
        })?;
        return Ok(true);
    }

    // wake / 无技能加载的被推翻 run / 其他系统轮：粗筛命中但无精确锚点，跳过。
    Ok(false)
}

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

/// 失败反例候选写入（G09-P2）：outcome=failed 且该 run 加载过已发布技能时，
/// 往候选库写一条 user_correction 类候选（trigger='outcome_failed'，
/// trace_hash 锚定失败 run——复用 P0 候选插入通路，不新造表）。
///
/// 隐私边界与 P0 同级：payload 只含触发信号、run 锚点 id、技能 ID 列表与
/// verdict 枚举，绝不写用户内容。
fn write_outcome_failed_candidate(
    summary: &TurnUsageSummary,
    loaded_skill_ids: &[String],
    candidate_repo: &SkillCandidateRepo,
) -> Result<(), String> {
    let draft_payload = serde_json::json!({
        "kind": "user_correction",
        "trigger": "outcome_failed",
        "corrected_run_id": summary.run_id,
        "corrected_skill_ids": loaded_skill_ids,
        "verdict": summary.finalization_verdict.as_deref().unwrap_or(""),
    });
    let evidence_refs = serde_json::json!({
        "run_id": summary.run_id,
        "corrected_run_id": summary.run_id,
    });
    candidate_repo.insert_if_new(&NewSkillCandidate {
        source_kind: CandidateSourceKind::UserCorrection,
        session_id: summary.session_id.clone(),
        trace_hash: correction_trace_hash(&summary.session_id, "outcome_failed", &summary.run_id),
        draft_payload_json: draft_payload.to_string(),
        evidence_refs_json: evidence_refs.to_string(),
    })?;
    Ok(())
}

// ============================================================================
// G09-P2：G07 终态 outcome 回流（tool_loop 接线 + 轮末补标双通路）
// ============================================================================

/// 从完成块 toolOutput 提取 finalization verdict（G07 finalizer 在工具环内
/// 写入；取最后一个 task_completed 工具结果，与 finalizer 的定位口径一致）。
fn finalization_verdict_of(tool_results: &[ToolResultInfo]) -> Option<String> {
    let result = tool_results.iter().rev().find(|r| {
        r.output
            .get("task_completed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    })?;
    result
        .output
        .get("finalization")?
        .get("verdict")?
        .as_str()
        .map(str::to_string)
}

/// tool_loop 接线点（`finalize_task_completion` 返回后调用）：把 verdict 映射
/// 为 outcome，对该 run 已存在的 unknown 账目行立即收敛。
///
/// 时序说明：本轮 usage 行要到阶段 6 `save_results_post_commit` 才落账，
/// 因此常规首轮这里标记 0 行——真正落地由轮末 `process_turn` 按同一映射
/// 补标（verdict 随 ctx.tool_results 流到轮末）。correction_hint 轮跳过
/// 立即通路：retry 复用被推翻 run 的 run_id，其旧行此时仍是 unknown，
/// 必须留给轮末纠错处理先收敛为 user_corrected，绝不能在此被 verdict 误标。
///
/// fire-and-forget：任何失败只 log，绝不影响主循环终止路径。
pub(crate) fn on_task_finalized(db: &Arc<ChatV2Database>, ctx: &PipelineContext) {
    on_task_finalized_inner(
        db,
        &ctx.assistant_message_id,
        &ctx.tool_results,
        detect_correction_hint(&ctx.options),
    );
}

fn on_task_finalized_inner(
    db: &Arc<ChatV2Database>,
    run_id: &str,
    tool_results: &[ToolResultInfo],
    correction_hint: bool,
) {
    let Some(verdict) = finalization_verdict_of(tool_results) else {
        return;
    };
    let Some(outcome) = SkillOutcome::from_finalization_verdict(&verdict) else {
        return; // OutcomeUnknown / 未知值：不标记
    };
    if correction_hint {
        return;
    }
    match SkillUsageRepo::new(db.clone()).mark_run_outcome(run_id, outcome) {
        Ok(marked) if marked > 0 => {
            log::info!(
                "[G09::skill_usage] outcome reflux (finalize): run={}, verdict={}, outcome={}, rows={}",
                run_id,
                verdict,
                outcome.as_str(),
                marked
            );
        }
        Ok(_) => {} // 行尚未落账——轮末 process_turn 补标
        Err(err) => {
            log::warn!(
                "[G09::skill_usage] outcome reflux at finalize failed (non-fatal): run={}, err={}",
                run_id,
                err
            );
        }
    }
}

// ============================================================================
// Tauri 命令：前端激活计数双写（fire-and-forget 落点）
// ============================================================================

/// 记录一次前端显式技能激活（kind='activation'，run_id=NULL）。
///
/// 前端 `skillUsageStats.recordSkillActivation` 在写 localStorage 后
/// fire-and-forget 调用本命令；tool_load 行由轮末钩子权威写入，
/// 前端不上报，避免双计。
#[tauri::command]
pub async fn chat_v2_record_skill_activation(
    skill_id: String,
    session_id: Option<String>,
    db: tauri::State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    let skill_id = skill_id.trim().to_string();
    if skill_id.is_empty() || skill_id.len() > 255 {
        return Err(format!("invalid skill_id length: {}", skill_id.len()));
    }
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        SkillUsageRepo::new(db).record_activation(&skill_id, session_id.as_deref())
    })
    .await
    .map_err(|e| format!("skill activation task join error: {}", e))??;
    Ok(())
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::types::{SendMessageRequest, TokenUsage};
    use crate::data_governance::migration::coordinator::MigrationCoordinator;
    use crate::data_governance::schema_registry::DatabaseId;
    use std::time::Instant;
    use tempfile::TempDir;

    /// 创建已应用全部 chat_v2 迁移的测试库（生产一致的迁移路径：
    /// MigrationCoordinator → refinery embed_migrations!，含本模块对应的
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

    fn insert_user_message(db: &Arc<ChatV2Database>, session_id: &str, message_id: &str) {
        let conn = db.get_conn().expect("conn");
        conn.execute(
            "INSERT INTO chat_v2_messages (id, session_id, role, timestamp) \
             VALUES (?1, ?2, 'user', 1757000000000)",
            params![message_id, session_id],
        )
        .expect("insert user message");
    }

    fn tool_result(name: &str, success: bool) -> ToolResultInfo {
        ToolResultInfo {
            tool_call_id: Some(format!("call_{}", name)),
            block_id: None,
            tool_name: name.to_string(),
            input: serde_json::json!({}),
            output: serde_json::json!({}),
            success,
            error: if success {
                None
            } else {
                Some("boom".to_string())
            },
            duration_ms: Some(10),
            reasoning_content: None,
            thought_signature: None,
        }
    }

    fn load_skills_result(skills: &[&str], rejected: &[&str]) -> ToolResultInfo {
        let rejected_map = rejected
            .iter()
            .map(|id| (id.to_string(), serde_json::json!("untrusted")))
            .collect::<serde_json::Map<String, Value>>();
        ToolResultInfo {
            tool_name: "load_skills".to_string(),
            input: serde_json::json!({ "skills": skills }),
            output: serde_json::json!({
                "result": {
                    "status": "success",
                    "loaded_skill_ids": skills,
                    "rejected_skills": Value::Object(rejected_map),
                },
                "durationMs": 5,
            }),
            ..tool_result("load_skills", true)
        }
    }

    fn summary_for(
        session_id: &str,
        run_id: &str,
        user_message_id: &str,
        correction_hint: bool,
        tools: Vec<ToolCallTrace>,
    ) -> TurnUsageSummary {
        TurnUsageSummary {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            user_message_id: user_message_id.to_string(),
            latency_ms: 1200,
            total_tokens: 3456,
            correction_hint,
            finalization_verdict: None,
            tools,
        }
    }

    fn traces(results: &[ToolResultInfo]) -> Vec<ToolCallTrace> {
        results.iter().map(tool_trace).collect()
    }

    fn list_all_candidates(db: &Arc<ChatV2Database>) -> Vec<SkillCandidateRow> {
        let conn = db.get_conn().expect("conn");
        let mut stmt = conn
            .prepare("SELECT * FROM skill_candidates ORDER BY created_at, candidate_id")
            .expect("prepare");
        let rows = stmt
            .query_map([], SkillCandidateRow::from_row)
            .expect("query");
        rows.collect::<Result<Vec<_>, _>>().expect("rows")
    }

    // ------------------------------------------------------------------------
    // 迁移与表结构
    // ------------------------------------------------------------------------

    #[test]
    fn g09_migration_creates_skill_tables() {
        let (_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("conn");
        for table in ["skill_usage", "skill_candidates"] {
            let found: Option<String> = conn
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .optional()
                .expect("query sqlite_master");
            assert_eq!(found.as_deref(), Some(table), "missing table {}", table);
        }
        for index in [
            "idx_skill_usage_skill_created",
            "idx_skill_usage_session_created",
            "idx_skill_usage_run",
            "idx_skill_usage_outcome",
            "idx_skill_candidates_trace_hash",
            "idx_skill_candidates_status_created",
            "idx_skill_candidates_session_created",
        ] {
            let found: Option<String> = conn
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    params![index],
                    |row| row.get(0),
                )
                .optional()
                .expect("query index");
            assert_eq!(found.as_deref(), Some(index), "missing index {}", index);
        }
    }

    // ------------------------------------------------------------------------
    // usage repo CRUD
    // ------------------------------------------------------------------------

    #[test]
    fn g09_usage_insert_and_read_roundtrip() {
        let (_dir, db) = setup_test_db();
        let repo = SkillUsageRepo::new(db.clone());

        let run_id = "msg_run_1";
        repo.insert(&NewSkillUsage {
            skill_id: "skill-a".to_string(),
            task_session_id: "sess-1".to_string(),
            run_id: Some(run_id.to_string()),
            kind: SkillUsageKind::ToolLoad,
            loads: 2,
            latency_ms: Some(800),
            tokens: Some(1234),
        })
        .unwrap();
        repo.record_activation("skill-b", Some("sess-1")).unwrap();
        repo.record_activation("skill-c", None).unwrap();

        let run_rows = repo.list_by_run(run_id).unwrap();
        assert_eq!(run_rows.len(), 1);
        assert_eq!(run_rows[0].skill_id, "skill-a");
        assert_eq!(run_rows[0].kind, SkillUsageKind::ToolLoad);
        assert_eq!(run_rows[0].loads, 2);
        assert_eq!(run_rows[0].outcome, SkillOutcome::Unknown);
        assert_eq!(run_rows[0].latency_ms, Some(800));
        assert_eq!(run_rows[0].tokens, Some(1234));

        let skill_b = repo.list_by_skill("skill-b", 10).unwrap();
        assert_eq!(skill_b.len(), 1);
        assert_eq!(skill_b[0].kind, SkillUsageKind::Activation);
        assert_eq!(skill_b[0].run_id, None);
        assert_eq!(skill_b[0].task_session_id, "sess-1");

        // 无会话上下文的激活落空串
        let skill_c = repo.list_by_skill("skill-c", 10).unwrap();
        assert_eq!(skill_c[0].task_session_id, "");
    }

    #[test]
    fn g09_mark_run_outcome_is_guarded() {
        let (_dir, db) = setup_test_db();
        let repo = SkillUsageRepo::new(db.clone());
        repo.insert(&NewSkillUsage {
            skill_id: "skill-a".to_string(),
            task_session_id: "sess-1".to_string(),
            run_id: Some("msg_run_1".to_string()),
            kind: SkillUsageKind::ToolLoad,
            loads: 1,
            latency_ms: None,
            tokens: None,
        })
        .unwrap();

        // unknown → user_corrected
        assert_eq!(
            repo.mark_run_outcome("msg_run_1", SkillOutcome::UserCorrected)
                .unwrap(),
            1
        );
        // 已收敛的行不会被重复覆盖
        assert_eq!(
            repo.mark_run_outcome("msg_run_1", SkillOutcome::Success)
                .unwrap(),
            0
        );
        assert_eq!(
            repo.list_by_run("msg_run_1").unwrap()[0].outcome,
            SkillOutcome::UserCorrected
        );
        assert!(repo.run_has_usage("msg_run_1").unwrap());
        assert!(!repo.run_has_usage("msg_run_other").unwrap());
        assert_eq!(
            repo.skill_ids_for_run("msg_run_1").unwrap(),
            vec!["skill-a".to_string()]
        );
    }

    // ------------------------------------------------------------------------
    // candidate repo CRUD + trace_hash 去重 + 状态机
    // ------------------------------------------------------------------------

    fn trajectory_candidate(session_id: &str, tools: &[&str]) -> NewSkillCandidate {
        let seq: Vec<String> = tools.iter().map(|t| t.to_string()).collect();
        NewSkillCandidate {
            source_kind: CandidateSourceKind::Trajectory,
            session_id: session_id.to_string(),
            trace_hash: trajectory_trace_hash(session_id, &seq),
            draft_payload_json: r#"{"kind":"trajectory"}"#.to_string(),
            evidence_refs_json: r#"{"run_id":"msg_r"}"#.to_string(),
        }
    }

    #[test]
    fn g09_candidate_insert_dedupes_by_trace_hash() {
        let (_dir, db) = setup_test_db();
        let repo = SkillCandidateRepo::new(db.clone());

        let candidate = trajectory_candidate("sess-1", &["a", "b", "c"]);
        assert!(repo.insert_if_new(&candidate).unwrap(), "first insert");
        // 相同 session + 相同工具序列 → 相同 trace_hash → 去重
        assert!(
            !repo.insert_if_new(&candidate).unwrap(),
            "same trace hash must dedup"
        );
        // 不同 session 的相同序列不去重
        assert!(repo
            .insert_if_new(&trajectory_candidate("sess-2", &["a", "b", "c"]))
            .unwrap());
        // 同 session 不同序列不去重
        assert!(repo
            .insert_if_new(&trajectory_candidate("sess-1", &["a", "b", "d"]))
            .unwrap());

        let stored = repo
            .get_by_trace_hash(&candidate.trace_hash)
            .unwrap()
            .expect("stored");
        assert_eq!(stored.status, CandidateStatus::New);
        assert_eq!(stored.source_kind, CandidateSourceKind::Trajectory);
        assert_eq!(repo.get(&stored.candidate_id).unwrap().unwrap(), stored);
    }

    #[test]
    fn g09_candidate_status_transitions_are_guarded() {
        let (_dir, db) = setup_test_db();
        let repo = SkillCandidateRepo::new(db.clone());
        let candidate = trajectory_candidate("sess-1", &["a", "b", "c"]);
        repo.insert_if_new(&candidate).unwrap();
        let stored = repo.get_by_trace_hash(&candidate.trace_hash).unwrap().unwrap();

        // 合法链：new → screened → replaying → passed → published → rolled_back
        assert!(repo
            .update_status(&stored.candidate_id, CandidateStatus::New, CandidateStatus::Screened)
            .unwrap());
        assert!(repo
            .update_status(
                &stored.candidate_id,
                CandidateStatus::Screened,
                CandidateStatus::Replaying
            )
            .unwrap());
        // 非法迁移被拒绝（new 不能直达 passed；状态不是期望前驱也被拒）
        assert!(!repo
            .update_status(&stored.candidate_id, CandidateStatus::New, CandidateStatus::Passed)
            .unwrap());
        assert!(!repo
            .update_status(
                &stored.candidate_id,
                CandidateStatus::Replaying,
                CandidateStatus::Published
            )
            .unwrap());
        assert!(repo
            .update_status(
                &stored.candidate_id,
                CandidateStatus::Replaying,
                CandidateStatus::Passed
            )
            .unwrap());
        assert!(repo
            .update_status(
                &stored.candidate_id,
                CandidateStatus::Passed,
                CandidateStatus::Published
            )
            .unwrap());
        assert!(repo
            .update_status(
                &stored.candidate_id,
                CandidateStatus::Published,
                CandidateStatus::RolledBack
            )
            .unwrap());
        // 终态不允许外向转换
        assert!(!repo
            .update_status(
                &stored.candidate_id,
                CandidateStatus::RolledBack,
                CandidateStatus::New
            )
            .unwrap());

        let listed = repo.list_by_status(CandidateStatus::RolledBack, 10).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(repo.list_by_status(CandidateStatus::New, 10).unwrap().is_empty());
    }

    // ------------------------------------------------------------------------
    // 轮末检测：触发 / 不触发条件
    // ------------------------------------------------------------------------

    #[test]
    fn g09_turn_with_3_distinct_tools_writes_trajectory_candidate() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        let results = vec![
            load_skills_result(&["skill-a"], &[]),
            tool_result("vfs_search", true),
            tool_result("note_read", true),
            tool_result("anki_add_cards", true),
            tool_result("note_read", true), // 重复工具只计一次
            tool_result("broken_tool", false), // 失败工具不进序列
        ];
        let summary = summary_for("sess-1", "msg_run_1", "msg_u1", false, traces(&results));
        process_turn(&db, &summary).unwrap();

        // usage 行：skill-a 一行 tool_load（load_skills 元工具不进轨迹序列）
        let usage_repo = SkillUsageRepo::new(db.clone());
        let rows = usage_repo.list_by_run("msg_run_1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].skill_id, "skill-a");
        assert_eq!(rows[0].kind, SkillUsageKind::ToolLoad);
        assert_eq!(rows[0].outcome, SkillOutcome::Unknown);
        assert_eq!(rows[0].latency_ms, Some(1200));
        assert_eq!(rows[0].tokens, Some(3456));

        let candidates = list_all_candidates(&db);
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate.source_kind, CandidateSourceKind::Trajectory);
        assert_eq!(candidate.status, CandidateStatus::New);
        let payload: Value = serde_json::from_str(&candidate.draft_payload_json).unwrap();
        assert_eq!(
            payload["tool_sequence"],
            serde_json::json!(["vfs_search", "note_read", "anki_add_cards"])
        );
        assert_eq!(payload["skills_loaded"], serde_json::json!(["skill-a"]));
        assert_eq!(payload["tool_call_count"], 5);
        assert_eq!(payload["failed_tool_call_count"], 1);
        let evidence: Value = serde_json::from_str(&candidate.evidence_refs_json).unwrap();
        assert_eq!(evidence["run_id"], "msg_run_1");

        // 同序列再来一轮 → trace_hash 去重，不重复写候选
        process_turn(&db, &summary).unwrap();
        assert_eq!(list_all_candidates(&db).len(), 1);
    }

    #[test]
    fn g09_turn_below_tool_threshold_writes_no_candidate() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");

        // 只有 2 个不同成功工具 → 不写 trajectory 候选
        let results = vec![tool_result("vfs_search", true), tool_result("note_read", true)];
        let summary = summary_for("sess-1", "msg_run_1", "msg_u1", false, traces(&results));
        process_turn(&db, &summary).unwrap();
        assert!(list_all_candidates(&db).is_empty());

        // 无工具回合 → 既不写候选也不写 usage
        let empty = summary_for("sess-1", "msg_run_2", "msg_u2", false, vec![]);
        process_turn(&db, &empty).unwrap();
        assert!(list_all_candidates(&db).is_empty());
        assert!(SkillUsageRepo::new(db.clone())
            .list_by_run("msg_run_2")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn g09_retry_marks_prior_run_and_writes_correction_candidate() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        let usage_repo = SkillUsageRepo::new(db.clone());

        // 被推翻的 run：使用了 skill-a（run_id 与重试轮相同——retry 复用被删
        // 助手消息 id）
        let rejected = summary_for(
            "sess-1",
            "msg_run_retry",
            "msg_u1",
            false,
            traces(&[load_skills_result(&["skill-a"], &[])]),
        );
        process_turn(&db, &rejected).unwrap();
        assert_eq!(
            usage_repo.list_by_run("msg_run_retry").unwrap()[0].outcome,
            SkillOutcome::Unknown
        );

        // 重试轮：correction_hint=true，user_message_id 是新生成的（库中不存在）
        let retry = summary_for(
            "sess-1",
            "msg_run_retry",
            "msg_u_new",
            true,
            traces(&[load_skills_result(&["skill-a", "skill-b"], &[])]),
        );
        process_turn(&db, &retry).unwrap();

        // 被推翻 run 的旧行收敛为 user_corrected；本轮新行保持 unknown
        let rows = usage_repo.list_by_run("msg_run_retry").unwrap();
        assert_eq!(rows.len(), 3, "1 old + 2 new rows share the reused run_id");
        let corrected = rows
            .iter()
            .filter(|r| r.outcome == SkillOutcome::UserCorrected)
            .count();
        let fresh = rows
            .iter()
            .filter(|r| r.outcome == SkillOutcome::Unknown)
            .count();
        assert_eq!(corrected, 1, "rejected run's row marked user_corrected");
        assert_eq!(fresh, 2, "new attempt's rows stay unknown");

        let candidates = list_all_candidates(&db);
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate.source_kind, CandidateSourceKind::UserCorrection);
        let payload: Value = serde_json::from_str(&candidate.draft_payload_json).unwrap();
        assert_eq!(payload["trigger"], "retry");
        assert_eq!(payload["corrected_run_id"], "msg_run_retry");
        assert_eq!(
            payload["corrected_skill_ids"],
            serde_json::json!(["skill-a"])
        );

        // 再次重试同一 run → 候选按 trace_hash 去重
        process_turn(&db, &retry).unwrap();
        assert_eq!(list_all_candidates(&db).len(), 1);
    }

    #[test]
    fn g09_edit_and_resend_writes_correction_candidate_via_user_message_anchor() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        // edit_and_resend 复用原用户消息 id → 消息行在库中存在
        insert_user_message(&db, "sess-1", "msg_u_original");

        let edit_turn = summary_for(
            "sess-1",
            "msg_run_edit",
            "msg_u_original",
            true,
            traces(&[tool_result("vfs_search", true)]),
        );
        process_turn(&db, &edit_turn).unwrap();

        let candidates = list_all_candidates(&db);
        assert_eq!(candidates.len(), 1);
        let payload: Value = serde_json::from_str(&candidates[0].draft_payload_json).unwrap();
        assert_eq!(payload["trigger"], "edit_and_resend");
        assert_eq!(payload["corrected_user_message_id"], "msg_u_original");
        // edit 路径锚点是用户消息，不回标任何 usage 行
    }

    #[test]
    fn g09_wake_turn_without_anchor_writes_no_correction_candidate() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        // wake：correction 粗筛命中，但 user_message_id 是新生成的（库中不存在），
        // 且本轮 run 无既有 usage 行 → 无精确锚点，不落候选；
        // 工具数达标时仍按普通成功轮写 trajectory（wake 是合法完成的运行）。
        let wake = summary_for(
            "sess-1",
            "msg_run_wake",
            "msg_u_fresh",
            true,
            traces(&[
                tool_result("a", true),
                tool_result("b", true),
                tool_result("c", true),
            ]),
        );
        process_turn(&db, &wake).unwrap();

        let candidates = list_all_candidates(&db);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source_kind, CandidateSourceKind::Trajectory);
    }

    #[test]
    fn g09_correction_turn_writes_no_trajectory_candidate() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        insert_user_message(&db, "sess-1", "msg_u_original");
        // 纠错轮本身即使有 ≥3 个成功工具，也不写 trajectory 正例
        // （"无用户纠错信号" 条件）
        let edit_turn = summary_for(
            "sess-1",
            "msg_run_edit",
            "msg_u_original",
            true,
            traces(&[
                tool_result("a", true),
                tool_result("b", true),
                tool_result("c", true),
            ]),
        );
        process_turn(&db, &edit_turn).unwrap();

        let candidates = list_all_candidates(&db);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source_kind, CandidateSourceKind::UserCorrection);
    }

    // ------------------------------------------------------------------------
    // 隐私边界
    // ------------------------------------------------------------------------

    #[test]
    fn g09_candidate_payload_contains_no_user_content() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");

        let user_secret = "用户的私密问题内容XYZ";
        let assistant_secret = "助手回复的私密内容ABC";
        let tool_input_secret = "工具参数里的私密路径/private/secret";
        let mut with_secret_input = tool_result("vfs_search", true);
        with_secret_input.input = serde_json::json!({ "query": tool_input_secret });
        let results = vec![
            with_secret_input,
            tool_result("note_read", true),
            tool_result("anki_add_cards", true),
        ];
        // summary 只携带最小 trace；用户/助手内容根本不进入摘要结构。
        let summary = summary_for("sess-1", "msg_run_1", "msg_u1", false, traces(&results));
        process_turn(&db, &summary).unwrap();

        let candidates = list_all_candidates(&db);
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        for forbidden in [user_secret, assistant_secret, tool_input_secret] {
            assert!(
                !candidate.draft_payload_json.contains(forbidden),
                "draft_payload must not contain user content: {}",
                forbidden
            );
            assert!(
                !candidate.evidence_refs_json.contains(forbidden),
                "evidence_refs must not contain user content: {}",
                forbidden
            );
        }
        // payload 只允许统计字段键
        let payload: Value = serde_json::from_str(&candidate.draft_payload_json).unwrap();
        let keys: Vec<&str> = payload
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

    #[test]
    fn g09_turn_summary_from_ctx_carries_no_content_fields() {
        // 端到端隐私防线：TurnUsageSummary 结构上就不含用户/助手内容字段。
        let request = SendMessageRequest {
            session_id: "sess-1".to_string(),
            content: "绝密用户消息内容".to_string(),
            options: Some(SendOptions {
                skip_user_message_save: Some(true),
                ..Default::default()
            }),
            user_message_id: None,
            assistant_message_id: None,
            user_context_refs: None,
            path_map: None,
            workspace_id: None,
        };
        let mut ctx = PipelineContext::new(request);
        ctx.tool_results = vec![load_skills_result(&["skill-a"], &["skill-b"])];
        ctx.token_usage = TokenUsage {
            total_tokens: 999,
            ..Default::default()
        };
        ctx.start_time = Instant::now();

        let summary = TurnUsageSummary::from_ctx(&ctx);
        assert!(summary.correction_hint, "skip_user_message_save → hint");
        assert_eq!(summary.total_tokens, 999);
        assert_eq!(summary.tools.len(), 1);
        assert_eq!(
            summary.tools[0].loaded_skill_ids,
            vec!["skill-a".to_string()],
            "rejected skill must be excluded"
        );
        let serialized = serde_json::to_string(&summary.tools).unwrap();
        assert!(!serialized.contains("绝密用户消息内容"));
    }

    #[test]
    fn g09_correction_hint_excludes_headless_and_goal_continuation() {
        // headless/worker：execution_allowed_tools 只由后端构造
        let headless = SendOptions {
            skip_user_message_save: Some(true),
            execution_allowed_tools: Some(vec!["tool".to_string()]),
            ..Default::default()
        };
        assert!(!detect_correction_hint(&headless));

        // goal 续跑：schema_tool_ids 注入 goal 三件套
        let goal = SendOptions {
            skip_user_message_save: Some(true),
            schema_tool_ids: Some(vec!["goal_update".to_string()]),
            ..Default::default()
        };
        assert!(!detect_correction_hint(&goal));

        // retry / edit_and_resend / wake：hint 命中（精确锚定交给 DB 探针）
        let retry = SendOptions {
            skip_user_message_save: Some(true),
            ..Default::default()
        };
        assert!(detect_correction_hint(&retry));

        // 普通发送：不命中
        assert!(!detect_correction_hint(&SendOptions::default()));
    }

    // ------------------------------------------------------------------------
    // G09-P2：G07 终态 outcome 回流 + 失败反例候选
    // ------------------------------------------------------------------------

    /// finalizer 写入完成块 toolOutput 的形状（task_completed + finalization）。
    fn completion_tool_result(verdict: &str) -> ToolResultInfo {
        ToolResultInfo {
            tool_name: "attempt_completion".to_string(),
            output: serde_json::json!({
                "task_completed": true,
                "finalization": { "verdict": verdict },
            }),
            ..tool_result("attempt_completion", true)
        }
    }

    #[test]
    fn g09p2_finalization_verdict_maps_to_three_state_outcome() {
        assert_eq!(
            SkillOutcome::from_finalization_verdict("verified_complete"),
            Some(SkillOutcome::Success)
        );
        assert_eq!(
            SkillOutcome::from_finalization_verdict("complete_with_exceptions"),
            Some(SkillOutcome::Success)
        );
        assert_eq!(
            SkillOutcome::from_finalization_verdict("partial"),
            Some(SkillOutcome::Failed)
        );
        assert_eq!(
            SkillOutcome::from_finalization_verdict("blocked"),
            Some(SkillOutcome::Failed)
        );
        // OutcomeUnknown 不标记；未知值 fail-closed
        assert_eq!(
            SkillOutcome::from_finalization_verdict("outcome_unknown"),
            None
        );
        assert_eq!(SkillOutcome::from_finalization_verdict("bogus"), None);
    }

    #[test]
    fn g09p2_process_turn_refluxes_verdict_into_usage_rows() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        let usage_repo = SkillUsageRepo::new(db.clone());

        // verified_complete / complete_with_exceptions → success
        let mut ok = summary_for(
            "sess-1",
            "msg_run_ok",
            "msg_u1",
            false,
            traces(&[load_skills_result(&["skill-a"], &[])]),
        );
        ok.finalization_verdict = Some("complete_with_exceptions".to_string());
        process_turn(&db, &ok).unwrap();
        let rows = usage_repo.list_by_run("msg_run_ok").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].outcome, SkillOutcome::Success);
        // 成功终态不产生失败反例；工具数不足也不产生 trajectory
        assert!(list_all_candidates(&db).is_empty());

        // partial / blocked → failed
        let mut bad = summary_for(
            "sess-1",
            "msg_run_bad",
            "msg_u2",
            false,
            traces(&[load_skills_result(&["skill-b"], &[])]),
        );
        bad.finalization_verdict = Some("blocked".to_string());
        process_turn(&db, &bad).unwrap();
        let rows = usage_repo.list_by_run("msg_run_bad").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].outcome, SkillOutcome::Failed);

        // outcome_unknown → 不标记
        let mut unknown = summary_for(
            "sess-1",
            "msg_run_unknown",
            "msg_u3",
            false,
            traces(&[load_skills_result(&["skill-c"], &[])]),
        );
        unknown.finalization_verdict = Some("outcome_unknown".to_string());
        process_turn(&db, &unknown).unwrap();
        let rows = usage_repo.list_by_run("msg_run_unknown").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].outcome, SkillOutcome::Unknown);

        // 无完成块 verdict（非任务轮）→ 保持 unknown（P0 行为不变）
        let plain = summary_for(
            "sess-1",
            "msg_run_plain",
            "msg_u4",
            false,
            traces(&[load_skills_result(&["skill-d"], &[])]),
        );
        process_turn(&db, &plain).unwrap();
        let rows = usage_repo.list_by_run("msg_run_plain").unwrap();
        assert_eq!(rows[0].outcome, SkillOutcome::Unknown);
    }

    #[test]
    fn g09p2_failed_outcome_writes_counter_example_candidate() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");

        let mut failed = summary_for(
            "sess-1",
            "msg_run_bad",
            "msg_u1",
            false,
            traces(&[load_skills_result(&["skill-a", "skill-b"], &[])]),
        );
        failed.finalization_verdict = Some("partial".to_string());
        process_turn(&db, &failed).unwrap();

        let candidates = list_all_candidates(&db);
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate.source_kind, CandidateSourceKind::UserCorrection);
        assert_eq!(candidate.status, CandidateStatus::New);
        // trace_hash 含失败锚点（失败 run id）
        assert_eq!(
            candidate.trace_hash,
            correction_trace_hash("sess-1", "outcome_failed", "msg_run_bad")
        );
        let payload: Value = serde_json::from_str(&candidate.draft_payload_json).unwrap();
        assert_eq!(payload["kind"], "user_correction");
        assert_eq!(payload["trigger"], "outcome_failed");
        assert_eq!(payload["corrected_run_id"], "msg_run_bad");
        assert_eq!(
            payload["corrected_skill_ids"],
            serde_json::json!(["skill-a", "skill-b"])
        );
        assert_eq!(payload["verdict"], "partial");
        let evidence: Value = serde_json::from_str(&candidate.evidence_refs_json).unwrap();
        assert_eq!(evidence["run_id"], "msg_run_bad");
        assert_eq!(evidence["corrected_run_id"], "msg_run_bad");

        // 同一失败 run 重复处理 → 候选按 trace_hash 去重
        process_turn(&db, &failed).unwrap();
        assert_eq!(list_all_candidates(&db).len(), 1);
    }

    #[test]
    fn g09p2_failed_verdict_without_loaded_skills_writes_no_candidate() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");

        // 终态失败 + ≥3 个不同成功工具但没加载技能：
        // 既不写失败反例（无已发布技能涉及），也不写 trajectory 正例
        // （G07 门控：失败完成块不沉淀正例）。
        let mut failed = summary_for(
            "sess-1",
            "msg_run_bad",
            "msg_u1",
            false,
            traces(&[
                tool_result("a", true),
                tool_result("b", true),
                tool_result("c", true),
            ]),
        );
        failed.finalization_verdict = Some("partial".to_string());
        process_turn(&db, &failed).unwrap();
        assert!(
            list_all_candidates(&db).is_empty(),
            "failed verdict must suppress trajectory candidate and needs loaded skills for counter-example"
        );

        // 对照：同样的工具序列但验收通过 → trajectory 正例照常写入
        let mut ok = summary_for(
            "sess-1",
            "msg_run_ok",
            "msg_u2",
            false,
            traces(&[
                tool_result("a", true),
                tool_result("b", true),
                tool_result("c", true),
            ]),
        );
        ok.finalization_verdict = Some("verified_complete".to_string());
        process_turn(&db, &ok).unwrap();
        let candidates = list_all_candidates(&db);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source_kind, CandidateSourceKind::Trajectory);
    }

    #[test]
    fn g09p2_retry_correction_precedes_failed_outcome_reflux() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        let usage_repo = SkillUsageRepo::new(db.clone());

        // 被推翻 run 的旧行（同 run_id，tokens=Some(7) 用于区分新行）
        usage_repo
            .insert(&NewSkillUsage {
                skill_id: "skill-a".to_string(),
                task_session_id: "sess-1".to_string(),
                run_id: Some("msg_run_retry".to_string()),
                kind: SkillUsageKind::ToolLoad,
                loads: 7,
                latency_ms: None,
                tokens: Some(7),
            })
            .unwrap();

        // 重试轮：correction_hint=true，且本轮验收也失败（partial）
        let mut retry = summary_for(
            "sess-1",
            "msg_run_retry",
            "msg_u_new",
            true,
            traces(&[load_skills_result(&["skill-a"], &[])]),
        );
        retry.finalization_verdict = Some("partial".to_string());
        process_turn(&db, &retry).unwrap();

        // 顺序不变量：旧行先被纠错收敛为 user_corrected（绝不能被 verdict
        // 覆盖成 failed），本轮新行才被标本 failed
        let rows = usage_repo.list_by_run("msg_run_retry").unwrap();
        assert_eq!(rows.len(), 2);
        let old = rows.iter().find(|r| r.tokens == Some(7)).expect("old row");
        let new = rows.iter().find(|r| r.tokens == Some(3456)).expect("new row");
        assert_eq!(old.outcome, SkillOutcome::UserCorrected);
        assert_eq!(new.outcome, SkillOutcome::Failed);

        // 候选：retry 反例 + outcome_failed 反例各一（锚点不同 trigger）
        let candidates = list_all_candidates(&db);
        assert_eq!(candidates.len(), 2);
        let triggers: Vec<String> = candidates
            .iter()
            .map(|c| {
                let payload: Value = serde_json::from_str(&c.draft_payload_json).unwrap();
                payload["trigger"].as_str().unwrap().to_string()
            })
            .collect();
        assert!(triggers.contains(&"retry".to_string()));
        assert!(triggers.contains(&"outcome_failed".to_string()));
    }

    #[test]
    fn g09p2_on_task_finalized_marks_existing_rows_only_when_safe() {
        let (_dir, db) = setup_test_db();
        insert_session(&db, "sess-1");
        let usage_repo = SkillUsageRepo::new(db.clone());
        let insert_unknown = |run_id: &str| {
            usage_repo
                .insert(&NewSkillUsage {
                    skill_id: "skill-a".to_string(),
                    task_session_id: "sess-1".to_string(),
                    run_id: Some(run_id.to_string()),
                    kind: SkillUsageKind::ToolLoad,
                    loads: 1,
                    latency_ms: None,
                    tokens: None,
                })
                .unwrap();
        };

        // 立即通路：行已存在 + 非纠错轮 → 直接收敛
        insert_unknown("msg_run_a");
        on_task_finalized_inner(
            &db,
            "msg_run_a",
            &[completion_tool_result("verified_complete")],
            false,
        );
        assert_eq!(
            usage_repo.list_by_run("msg_run_a").unwrap()[0].outcome,
            SkillOutcome::Success
        );

        // 纠错轮（retry 复用 run_id）：跳过立即通路——旧行必须留给轮末
        // 纠错处理先收敛为 user_corrected
        insert_unknown("msg_run_b");
        on_task_finalized_inner(&db, "msg_run_b", &[completion_tool_result("partial")], true);
        assert_eq!(
            usage_repo.list_by_run("msg_run_b").unwrap()[0].outcome,
            SkillOutcome::Unknown,
            "correction-hint turn must not early-mark reused run_id rows"
        );

        // outcome_unknown：不标记
        insert_unknown("msg_run_c");
        on_task_finalized_inner(
            &db,
            "msg_run_c",
            &[completion_tool_result("outcome_unknown")],
            false,
        );
        assert_eq!(
            usage_repo.list_by_run("msg_run_c").unwrap()[0].outcome,
            SkillOutcome::Unknown
        );

        // 无完成块：no-op
        insert_unknown("msg_run_d");
        on_task_finalized_inner(&db, "msg_run_d", &[tool_result("vfs_search", true)], false);
        assert_eq!(
            usage_repo.list_by_run("msg_run_d").unwrap()[0].outcome,
            SkillOutcome::Unknown
        );

        // 行尚不存在（常规首轮：usage 行在轮末才落账）：标记 0 行，不报错
        on_task_finalized_inner(&db, "msg_run_e", &[completion_tool_result("blocked")], false);
        assert!(usage_repo.list_by_run("msg_run_e").unwrap().is_empty());
    }
}
