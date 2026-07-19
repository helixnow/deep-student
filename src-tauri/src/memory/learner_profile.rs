//! 学习者画像层（Learner Profile）
//!
//! 参考成熟代理运行时的 三层记忆（MEMORY.md 策展长期层 / 每日笔记工作层 / dreaming 晋升管道）
//! 与 另一桌面代理实现 三层记忆的设计：
//! - 本模块是"策展长期层"：一份结构化画像（薄弱知识点/学习偏好/学习目标/近期状态），
//!   随会话注入 system prompt（见 chat_v2/prompt_builder.rs 的 `<learner_profile>` 段）
//! - 工作层见 `daily_log.rs`（每日学习日志，只可检索不注入）
//! - 晋升管道见 `evolution.rs` 的 `run_promotion_throttled`（日志→画像）
//!
//! 存储：复用记忆存储底座，画像作为 `__system__` 文件夹下的系统笔记
//! `__learner_profile__`（JSON 内容，索引禁用，不参与向量检索），
//! 版本历史保存在 `__learner_profile_history__`（JSONL，保留最近 N 版）。

use std::sync::Arc;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::note_repo::VfsNoteRepo;
use crate::vfs::types::{VfsCreateNoteParams, VfsFolder, VfsUpdateNoteParams};

use super::audit_log::{MemoryAuditEntry, MemoryOpSource, MemoryOpType};
use super::config::MemoryConfig;
use super::service::MemoryService;

/// 画像系统笔记标题（`__` 前缀 → 自动排除在 list/画像刷新/分类聚合之外）
pub const LEARNER_PROFILE_NOTE_TITLE: &str = "__learner_profile__";
/// 画像版本历史笔记标题（JSONL，每行一个历史版本）
pub const LEARNER_PROFILE_HISTORY_NOTE_TITLE: &str = "__learner_profile_history__";
/// 画像渲染后的总长度硬上限（字符）——它是"策展层"，不是日志
pub const LEARNER_PROFILE_MAX_CHARS: usize = 4000;
/// 版本历史保留条数
const PROFILE_HISTORY_KEEP: usize = 5;
/// 薄弱知识点条数上限
const MAX_WEAK_POINTS: usize = 20;
/// 学习目标条数上限
const MAX_GOALS: usize = 10;
/// 其他偏好条数上限
const MAX_OTHER_PREFERENCES: usize = 10;
/// 近期状态摘要长度上限（字符）
const MAX_RECENT_STATUS_CHARS: usize = 500;
/// Bounded retry count for optimistic profile/history updates.
const PROFILE_CAS_MAX_RETRIES: usize = 32;
const PROMOTION_FINGERPRINT_JSON_KEY: &str = "_promotion_fingerprint";

// ============================================================================
// 数据结构
// ============================================================================

/// 薄弱知识点来源：掌握度中间层确定性回流（与 LLM 晋升路径共存）
pub const WEAK_POINT_SOURCE_MASTERY: &str = "mastery";

/// 薄弱知识点：科目→知识点→错误模式，带证据计数
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct WeakPoint {
    /// 科目（如"数学"）
    #[serde(default)]
    pub subject: String,
    /// 知识点（如"二次函数"）
    #[serde(default)]
    pub knowledge_point: String,
    /// 错误模式（如"配方时符号处理错误"）
    #[serde(default)]
    pub error_pattern: String,
    /// 证据计数（观察到该错误模式的次数）
    #[serde(default)]
    pub evidence_count: u32,
    /// 最近一次观察日期（YYYY-MM-DD）
    #[serde(default)]
    pub last_seen: Option<String>,
    /// 来源标注：`mastery` = 成绩硬回流；缺省/其他 = LLM 提取或工具写入
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// 掌握度回流时携带的确定性证据（不经 LLM）
#[derive(Debug, Clone)]
pub struct MasteryWeakPointEvidence {
    pub score: f64,
    pub total: i32,
    pub wrong_count: i32,
    pub recent_wrong_summary: String,
}

/// 学习偏好（讲解风格、语言、节奏）
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct LearnerPreferences {
    /// 讲解风格（如"先结论后推导"）
    #[serde(default)]
    pub explanation_style: Option<String>,
    /// 语言偏好（如"中文"）
    #[serde(default)]
    pub language: Option<String>,
    /// 学习节奏（如"较快，喜欢直接进入难题"）
    #[serde(default)]
    pub pace: Option<String>,
    /// 其他偏好（自由条目）
    #[serde(default)]
    pub others: Vec<String>,
}

/// 学习目标（考试/期限）
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct LearningGoal {
    /// 目标描述（如"高考数学 130+"）
    #[serde(default)]
    pub goal: String,
    /// 期限（YYYY-MM-DD，可空）
    #[serde(default)]
    pub deadline: Option<String>,
}

/// 学习者画像（策展的结构化长期层）
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct LearnerProfile {
    /// 版本号（每次保存递增）
    #[serde(default)]
    pub version: u32,
    /// 最后更新时间（ISO 8601）
    #[serde(default)]
    pub updated_at: String,
    /// 薄弱知识点
    #[serde(default)]
    pub weak_points: Vec<WeakPoint>,
    /// 学习偏好
    #[serde(default)]
    pub preferences: LearnerPreferences,
    /// 学习目标
    #[serde(default)]
    pub goals: Vec<LearningGoal>,
    /// 近期状态摘要
    #[serde(default)]
    pub recent_status: Option<String>,
    /// Internal exactly-once marker for the daily-log promotion pipeline.
    /// Generic API serialization omits it; `to_json` persists it in the reserved note only.
    #[serde(skip)]
    pub(crate) last_promotion_fingerprint: Option<String>,
}

/// 画像结构化增量更新（工具 learner_profile_update 与晋升管道共用；
/// merge 语义而非整体覆盖，防止一次坏更新清空画像）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LearnerProfileUpdate {
    /// 新增/强化薄弱知识点：按 (subject, knowledge_point) upsert，证据计数累加
    #[serde(default)]
    pub weak_points_add: Vec<WeakPoint>,
    /// 移除薄弱知识点（已克服）：按 (subject, knowledge_point) 匹配
    #[serde(default)]
    pub weak_points_remove: Vec<WeakPointKey>,
    /// 偏好补丁：仅覆盖提供的字段；others 为追加去重
    #[serde(default)]
    pub preferences: Option<PreferencesPatch>,
    /// 新增学习目标（按 goal 文本去重）
    #[serde(default)]
    pub goals_add: Vec<LearningGoal>,
    /// 移除学习目标（按 goal 文本匹配）
    #[serde(default)]
    pub goals_remove: Vec<String>,
    /// 覆盖近期状态摘要（None = 不变）
    #[serde(default)]
    pub recent_status: Option<String>,
}

/// 薄弱知识点定位键
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WeakPointKey {
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub knowledge_point: String,
}

/// 偏好字段级补丁
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PreferencesPatch {
    #[serde(default)]
    pub explanation_style: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub pace: Option<String>,
    /// 追加的其他偏好（去重）
    #[serde(default)]
    pub others_add: Vec<String>,
    /// 移除的其他偏好（精确匹配）
    #[serde(default)]
    pub others_remove: Vec<String>,
}

impl LearnerProfileUpdate {
    /// 更新是否为空（无任何变更内容）
    pub fn is_empty(&self) -> bool {
        self.weak_points_add.is_empty()
            && self.weak_points_remove.is_empty()
            && self.preferences.is_none()
            && self.goals_add.is_empty()
            && self.goals_remove.is_empty()
            && self.recent_status.is_none()
    }
}

// ============================================================================
// merge / 渲染 / 上限精炼（纯逻辑，可单元测试）
// ============================================================================

fn key_eq(a_subject: &str, a_point: &str, b_subject: &str, b_point: &str) -> bool {
    a_subject.trim().eq_ignore_ascii_case(b_subject.trim())
        && a_point.trim().eq_ignore_ascii_case(b_point.trim())
}

impl LearnerProfile {
    /// 应用结构化增量更新（merge 语义）。返回是否发生实际变更。
    pub fn merge_update(&mut self, update: &LearnerProfileUpdate) -> bool {
        let mut changed = false;

        // 1. 薄弱知识点 upsert：同键累加证据、更新错误模式与 last_seen
        for incoming in &update.weak_points_add {
            if incoming.subject.trim().is_empty() || incoming.knowledge_point.trim().is_empty() {
                continue;
            }
            let existing = self.weak_points.iter_mut().find(|wp| {
                key_eq(
                    &wp.subject,
                    &wp.knowledge_point,
                    &incoming.subject,
                    &incoming.knowledge_point,
                )
            });
            match existing {
                Some(wp) => {
                    wp.evidence_count = wp
                        .evidence_count
                        .saturating_add(incoming.evidence_count.max(1));
                    if !incoming.error_pattern.trim().is_empty() {
                        wp.error_pattern = incoming.error_pattern.clone();
                    }
                    if incoming.last_seen.is_some() {
                        wp.last_seen = incoming.last_seen.clone();
                    }
                    if incoming.source.is_some() {
                        wp.source = incoming.source.clone();
                    }
                }
                None => {
                    let mut wp = incoming.clone();
                    wp.evidence_count = wp.evidence_count.max(1);
                    self.weak_points.push(wp);
                }
            }
            changed = true;
        }

        // 2. 薄弱知识点移除（已克服）
        for key in &update.weak_points_remove {
            let before = self.weak_points.len();
            self.weak_points.retain(|wp| {
                !key_eq(
                    &wp.subject,
                    &wp.knowledge_point,
                    &key.subject,
                    &key.knowledge_point,
                )
            });
            if self.weak_points.len() != before {
                changed = true;
            }
        }

        // 3. 偏好字段级补丁
        if let Some(patch) = &update.preferences {
            if let Some(v) = &patch.explanation_style {
                if !v.trim().is_empty() {
                    self.preferences.explanation_style = Some(v.clone());
                    changed = true;
                }
            }
            if let Some(v) = &patch.language {
                if !v.trim().is_empty() {
                    self.preferences.language = Some(v.clone());
                    changed = true;
                }
            }
            if let Some(v) = &patch.pace {
                if !v.trim().is_empty() {
                    self.preferences.pace = Some(v.clone());
                    changed = true;
                }
            }
            for item in &patch.others_add {
                let trimmed = item.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if !self.preferences.others.iter().any(|o| o.trim() == trimmed) {
                    self.preferences.others.push(trimmed.to_string());
                    changed = true;
                }
            }
            for item in &patch.others_remove {
                let before = self.preferences.others.len();
                self.preferences.others.retain(|o| o.trim() != item.trim());
                if self.preferences.others.len() != before {
                    changed = true;
                }
            }
        }

        // 4. 学习目标（按 goal 文本去重）
        for goal in &update.goals_add {
            let trimmed = goal.goal.trim();
            if trimmed.is_empty() {
                continue;
            }
            match self.goals.iter_mut().find(|g| g.goal.trim() == trimmed) {
                Some(existing) => {
                    if goal.deadline.is_some() && existing.deadline != goal.deadline {
                        existing.deadline = goal.deadline.clone();
                        changed = true;
                    }
                }
                None => {
                    self.goals.push(goal.clone());
                    changed = true;
                }
            }
        }
        for goal_text in &update.goals_remove {
            let before = self.goals.len();
            self.goals.retain(|g| g.goal.trim() != goal_text.trim());
            if self.goals.len() != before {
                changed = true;
            }
        }

        // 5. 近期状态覆盖
        if let Some(status) = &update.recent_status {
            let trimmed = status.trim();
            if !trimmed.is_empty() && self.recent_status.as_deref() != Some(trimmed) {
                self.recent_status = Some(trimmed.to_string());
                changed = true;
            }
        }

        changed
    }

    /// 渲染为注入 prompt 用的 Markdown 摘要
    pub fn render_markdown(&self) -> String {
        let mut lines: Vec<String> = Vec::new();
        lines.push(format!(
            "# 学习者画像（v{}，更新于 {}）",
            self.version,
            if self.updated_at.is_empty() {
                "未知"
            } else {
                &self.updated_at
            }
        ));

        if !self.weak_points.is_empty() {
            lines.push("## 薄弱知识点".to_string());
            for wp in &self.weak_points {
                let last_seen = wp
                    .last_seen
                    .as_deref()
                    .map(|d| format!("，最近 {}", d))
                    .unwrap_or_default();
                lines.push(format!(
                    "- [{}/{}] {}（证据×{}{}）",
                    wp.subject, wp.knowledge_point, wp.error_pattern, wp.evidence_count, last_seen
                ));
            }
        }

        let prefs = &self.preferences;
        if prefs.explanation_style.is_some()
            || prefs.language.is_some()
            || prefs.pace.is_some()
            || !prefs.others.is_empty()
        {
            lines.push("## 学习偏好".to_string());
            if let Some(v) = &prefs.explanation_style {
                lines.push(format!("- 讲解风格：{}", v));
            }
            if let Some(v) = &prefs.language {
                lines.push(format!("- 语言：{}", v));
            }
            if let Some(v) = &prefs.pace {
                lines.push(format!("- 节奏：{}", v));
            }
            for other in &prefs.others {
                lines.push(format!("- {}", other));
            }
        }

        if !self.goals.is_empty() {
            lines.push("## 学习目标".to_string());
            for goal in &self.goals {
                match &goal.deadline {
                    Some(d) => lines.push(format!("- {}（期限 {}）", goal.goal, d)),
                    None => lines.push(format!("- {}", goal.goal)),
                }
            }
        }

        if let Some(status) = &self.recent_status {
            if !status.trim().is_empty() {
                lines.push("## 近期状态".to_string());
                lines.push(status.trim().to_string());
            }
        }

        lines.join("\n")
    }

    /// 渲染后的字符数（用于硬上限判定）
    pub fn rendered_char_count(&self) -> usize {
        self.render_markdown().chars().count()
    }

    /// 画像是否没有任何实质内容
    pub fn is_content_empty(&self) -> bool {
        self.weak_points.is_empty()
            && self.goals.is_empty()
            && self.preferences.explanation_style.is_none()
            && self.preferences.language.is_none()
            && self.preferences.pace.is_none()
            && self.preferences.others.is_empty()
            && self
                .recent_status
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
    }

    /// 强制精炼到硬上限以内（自动路径用；工具路径应改为报错要求模型精炼）。
    ///
    /// 精炼顺序：条数上限 → 截断近期状态 → 按证据计数升序丢弃薄弱知识点 →
    /// 丢弃末尾目标/其他偏好。返回是否发生了精炼。
    pub fn enforce_char_limit(&mut self) -> bool {
        let mut trimmed = false;

        // 先按证据计数降序排序（保留高证据条目），再应用条数上限
        self.weak_points
            .sort_by_key(|b| std::cmp::Reverse(b.evidence_count));
        if self.weak_points.len() > MAX_WEAK_POINTS {
            self.weak_points.truncate(MAX_WEAK_POINTS);
            trimmed = true;
        }
        if self.goals.len() > MAX_GOALS {
            self.goals.truncate(MAX_GOALS);
            trimmed = true;
        }
        if self.preferences.others.len() > MAX_OTHER_PREFERENCES {
            self.preferences.others.truncate(MAX_OTHER_PREFERENCES);
            trimmed = true;
        }
        if let Some(status) = &self.recent_status {
            if status.chars().count() > MAX_RECENT_STATUS_CHARS {
                self.recent_status = Some(status.chars().take(MAX_RECENT_STATUS_CHARS).collect());
                trimmed = true;
            }
        }

        // 仍超限时逐步丢弃低价值条目
        while self.rendered_char_count() > LEARNER_PROFILE_MAX_CHARS {
            if self.weak_points.len() > 1 {
                self.weak_points.pop(); // 已按证据降序，pop 掉的是证据最少的
            } else if self.goals.len() > 1 {
                self.goals.pop();
            } else if !self.preferences.others.is_empty() {
                self.preferences.others.pop();
            } else if self.recent_status.is_some() {
                self.recent_status = None;
            } else {
                // 极端情形：单条目仍超限，硬截断错误模式描述
                if let Some(wp) = self.weak_points.first_mut() {
                    if wp.error_pattern.chars().count() > 100 {
                        wp.error_pattern = wp.error_pattern.chars().take(100).collect();
                        trimmed = true;
                        continue;
                    }
                }
                break;
            }
            trimmed = true;
        }

        trimmed
    }

    pub fn to_json(&self) -> String {
        let mut value = match serde_json::to_value(self) {
            Ok(value) => value,
            Err(_) => return "{}".to_string(),
        };
        if let (Some(object), Some(fingerprint)) = (
            value.as_object_mut(),
            self.last_promotion_fingerprint.as_deref(),
        ) {
            object.insert(
                PROMOTION_FINGERPRINT_JSON_KEY.to_string(),
                serde_json::Value::String(fingerprint.to_string()),
            );
        }
        serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn from_json(raw: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(raw).ok()?;
        let fingerprint = value
            .get(PROMOTION_FINGERPRINT_JSON_KEY)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let mut profile: Self = serde_json::from_value(value).ok()?;
        profile.last_promotion_fingerprint = fingerprint;
        Some(profile)
    }

    pub(crate) fn has_promotion_fingerprint(&self, fingerprint: &str) -> bool {
        self.last_promotion_fingerprint.as_deref() == Some(fingerprint)
    }
}

// ============================================================================
// 存储（复用记忆存储底座：__system__ 文件夹下的系统笔记）
// ============================================================================

#[derive(Debug, Clone)]
struct SystemNoteSnapshot {
    note_id: String,
    updated_at: String,
    content: String,
}

/// Profile size handling differs between the explicit tool and automatic
/// promotion: the former asks the model to refine, while the latter keeps the
/// highest-value entries automatically.
#[derive(Debug, Clone, Copy)]
pub enum ProfileLimitPolicy {
    Reject,
    Enforce,
}

#[derive(Debug, Clone)]
pub struct LearnerProfileApplyOutcome {
    pub profile: LearnerProfile,
    pub changed: bool,
}

/// 在指定文件夹下按标题读取笔记及其 CAS token。
fn find_note_snapshot_by_title(
    vfs_db: &Arc<VfsDatabase>,
    folder_id: &str,
    title: &str,
) -> VfsResult<Option<SystemNoteSnapshot>> {
    use rusqlite::params;
    let conn = vfs_db.get_conn_safe()?;
    conn.query_row(
        r#"
            SELECT n.id, n.updated_at, r.data
            FROM notes n
            JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
            JOIN resources r ON r.id = n.resource_id
            WHERE n.title = ?1 AND fi.folder_id = ?2
              AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
            LIMIT 1
            "#,
        params![title, folder_id],
        |row| {
            Ok(SystemNoteSnapshot {
                note_id: row.get(0)?,
                updated_at: row.get(1)?,
                content: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// 只读定位 `__system__` 文件夹（不创建；供 prompt 注入等只读路径使用）
fn find_system_folder_id_readonly(vfs_db: &Arc<VfsDatabase>) -> VfsResult<Option<String>> {
    let config = MemoryConfig::new(vfs_db.clone());
    let Some(root_id) = config.get_root_folder_id()? else {
        return Ok(None);
    };
    let children = VfsFolderRepo::list_folders_by_parent(vfs_db, Some(&root_id))?;
    Ok(children
        .iter()
        .find(|f| f.title == "__system__")
        .map(|f| f.id.clone()))
}

/// 只读加载学习者画像（无需 MemoryService/LLMManager，供 prompt 注入路径使用）
pub fn load_profile_from_db(vfs_db: &Arc<VfsDatabase>) -> VfsResult<Option<LearnerProfile>> {
    let Some(sys_folder_id) = find_system_folder_id_readonly(vfs_db)? else {
        return Ok(None);
    };
    let Some(snapshot) =
        find_note_snapshot_by_title(vfs_db, &sys_folder_id, LEARNER_PROFILE_NOTE_TITLE)?
    else {
        return Ok(None);
    };
    if snapshot.content.trim().is_empty() {
        return Ok(None);
    }
    match LearnerProfile::from_json(&snapshot.content) {
        Some(profile) => Ok(Some(profile)),
        None => {
            warn!("[LearnerProfile] Profile note content is not valid JSON; ignoring");
            Ok(None)
        }
    }
}

/// 通过 MemoryService 加载画像（写路径/工具路径使用）
pub fn load_profile(service: &MemoryService) -> VfsResult<Option<LearnerProfile>> {
    load_profile_from_db(service.vfs_db_ref())
}

fn load_profile_snapshot(
    vfs_db: &Arc<VfsDatabase>,
) -> VfsResult<Option<(SystemNoteSnapshot, LearnerProfile)>> {
    let Some(sys_folder_id) = find_system_folder_id_readonly(vfs_db)? else {
        return Ok(None);
    };
    let Some(snapshot) =
        find_note_snapshot_by_title(vfs_db, &sys_folder_id, LEARNER_PROFILE_NOTE_TITLE)?
    else {
        return Ok(None);
    };
    let profile = LearnerProfile::from_json(&snapshot.content).unwrap_or_else(|| {
        warn!("[LearnerProfile] Profile note content is not valid JSON; replacing on next update");
        LearnerProfile::default()
    });
    Ok(Some((snapshot, profile)))
}

fn cancelled_error() -> VfsError {
    VfsError::InvalidOperation {
        operation: "learner_profile_update".to_string(),
        reason: "cancelled before profile commit".to_string(),
    }
}

/// Atomically merge an incremental update into the latest profile.
///
/// Each attempt reloads the latest profile and commits with the note's
/// `expected_updated_at` token. A conflicting writer therefore causes the
/// update to be replayed rather than silently overwritten.
pub fn apply_profile_update<C>(
    service: &MemoryService,
    update: &LearnerProfileUpdate,
    source: MemoryOpSource,
    session_id: Option<&str>,
    reason: &str,
    limit_policy: ProfileLimitPolicy,
    is_cancelled: C,
) -> VfsResult<LearnerProfileApplyOutcome>
where
    C: Fn() -> bool,
{
    apply_profile_update_inner(
        service,
        update,
        source,
        session_id,
        reason,
        limit_policy,
        is_cancelled,
        None,
        None::<fn()>,
    )
}

/// Apply a daily-log promotion with an exactly-once fingerprint committed in the same
/// profile-note CAS write. Replaying the same logs repairs history but never re-merges evidence.
pub(crate) fn apply_profile_promotion_update<C>(
    service: &MemoryService,
    update: &LearnerProfileUpdate,
    source: MemoryOpSource,
    session_id: Option<&str>,
    reason: &str,
    limit_policy: ProfileLimitPolicy,
    fingerprint: &str,
    is_cancelled: C,
) -> VfsResult<LearnerProfileApplyOutcome>
where
    C: Fn() -> bool,
{
    apply_profile_update_inner(
        service,
        update,
        source,
        session_id,
        reason,
        limit_policy,
        is_cancelled,
        Some(fingerprint),
        None::<fn()>,
    )
}

fn apply_profile_update_inner<C, H>(
    service: &MemoryService,
    update: &LearnerProfileUpdate,
    source: MemoryOpSource,
    session_id: Option<&str>,
    reason: &str,
    limit_policy: ProfileLimitPolicy,
    is_cancelled: C,
    promotion_fingerprint: Option<&str>,
    mut before_first_commit: Option<H>,
) -> VfsResult<LearnerProfileApplyOutcome>
where
    C: Fn() -> bool,
    H: FnOnce(),
{
    if is_cancelled() {
        return Err(cancelled_error());
    }

    let vfs_db = service.vfs_db_ref().clone();

    for attempt in 0..PROFILE_CAS_MAX_RETRIES {
        let snapshot = load_profile_snapshot(&vfs_db)?;
        let mut profile = snapshot
            .as_ref()
            .map(|(_, profile)| profile.clone())
            .unwrap_or_default();

        if promotion_fingerprint
            .map(|fingerprint| profile.has_promotion_fingerprint(fingerprint))
            .unwrap_or(false)
        {
            if profile.version > 0 {
                if let Err(error) = append_profile_history(service, &profile) {
                    warn!(
                        "[LearnerProfile] Failed to repair profile history for promotion replay: {}",
                        error
                    );
                }
            }
            return Ok(LearnerProfileApplyOutcome {
                profile,
                changed: false,
            });
        }

        let content_changed = profile.merge_update(update);
        let marker_changed = promotion_fingerprint
            .map(|fingerprint| {
                profile.last_promotion_fingerprint = Some(fingerprint.to_string());
                true
            })
            .unwrap_or(false);
        if !content_changed && !marker_changed {
            return Ok(LearnerProfileApplyOutcome {
                profile,
                changed: false,
            });
        }

        if content_changed {
            profile.version = profile.version.saturating_add(1);
            profile.updated_at = chrono::Utc::now().to_rfc3339();
        }
        match limit_policy {
            ProfileLimitPolicy::Enforce => {
                profile.enforce_char_limit();
            }
            ProfileLimitPolicy::Reject => {
                let rendered_chars = profile.rendered_char_count();
                if rendered_chars > LEARNER_PROFILE_MAX_CHARS {
                    return Err(VfsError::InvalidArgument {
                        param: "profile".to_string(),
                        reason: format!(
                            "合并后画像 {} 字符，超过 {} 字符硬上限。请精炼本次更新。",
                            rendered_chars, LEARNER_PROFILE_MAX_CHARS
                        ),
                    });
                }
            }
        }
        let json = profile.to_json();

        if let Some(hook) = before_first_commit.take() {
            hook();
        }
        if is_cancelled() {
            return Err(cancelled_error());
        }

        let persisted = match snapshot {
            Some((note, _)) => match VfsNoteRepo::update_note(
                &vfs_db,
                &note.note_id,
                VfsUpdateNoteParams {
                    title: None,
                    content: Some(json.clone()),
                    tags: None,
                    expected_updated_at: Some(note.updated_at),
                },
            ) {
                Ok(_) => {
                    debug!(
                        "[LearnerProfile] Updated profile note v{} ({})",
                        profile.version, note.note_id
                    );
                    true
                }
                Err(VfsError::Conflict { .. }) => false,
                Err(error) if super::is_retryable_sqlite_lock(&error) => false,
                Err(error) => return Err(error),
            },
            None => {
                let _guard = super::lock_memory_structure();
                if load_profile_snapshot(&vfs_db)?.is_some() {
                    false
                } else {
                    if is_cancelled() {
                        return Err(cancelled_error());
                    }
                    let sys_folder_id = service.get_or_create_system_folder_id_unlocked()?;
                    let note = VfsNoteRepo::create_note_in_folder(
                        &vfs_db,
                        VfsCreateNoteParams {
                            title: LEARNER_PROFILE_NOTE_TITLE.to_string(),
                            content: json.clone(),
                            tags: vec!["_system".to_string()],
                        },
                        Some(&sys_folder_id),
                    )?;
                    if let Err(e) = VfsIndexStateRepo::mark_disabled_with_reason(
                        &vfs_db,
                        &note.resource_id,
                        "system learner profile note",
                    ) {
                        warn!(
                            "[LearnerProfile] Failed to disable indexing for profile note: {}",
                            e
                        );
                    }
                    debug!(
                        "[LearnerProfile] Created profile note v{} ({})",
                        profile.version, note.id
                    );
                    true
                }
            }
        };

        if !persisted {
            debug!(
                "[LearnerProfile] CAS conflict on attempt {}; replaying update",
                attempt + 1
            );
            super::backoff_memory_write(attempt);
            continue;
        }

        // History and audit happen after the profile's commit point. Cancellation
        // after this point must still be reported as a successful update.
        if content_changed {
            if let Err(e) = append_profile_history(service, &profile) {
                warn!("[LearnerProfile] Failed to append profile history: {}", e);
            }
            service.audit_logger().log(&MemoryAuditEntry {
                source,
                operation: MemoryOpType::Update,
                success: true,
                note_id: None,
                title: Some(LEARNER_PROFILE_NOTE_TITLE.to_string()),
                content_preview: Some(reason.to_string()),
                folder: Some("__system__".to_string()),
                event: Some("PROFILE_UPDATE".to_string()),
                confidence: None,
                reason: Some(reason.to_string()),
                session_id: session_id.map(|s| s.to_string()),
                duration_ms: None,
                extra_json: Some(
                    serde_json::json!({ "learner_profile_version": profile.version }).to_string(),
                ),
            });
        }

        return Ok(LearnerProfileApplyOutcome {
            profile,
            changed: content_changed,
        });
    }

    Err(VfsError::Conflict {
        key: "learner_profile.conflict".to_string(),
        message: "The learner profile remained busy after repeated retries.".to_string(),
    })
}

fn get_or_create_system_folder_id_unlocked(vfs_db: &Arc<VfsDatabase>) -> VfsResult<String> {
    let config = MemoryConfig::new(vfs_db.clone());
    let root_id = config.get_or_create_root_folder()?;
    let children = VfsFolderRepo::list_folders_by_parent(vfs_db, Some(&root_id))?;
    if let Some(existing) = children.iter().find(|f| f.title == "__system__") {
        return Ok(existing.id.clone());
    }
    let folder = VfsFolder::new("__system__".to_string(), Some(root_id), None, None);
    VfsFolderRepo::create_folder(vfs_db, &folder)?;
    Ok(folder.id)
}

/// 掌握度中间层 → 画像薄弱点确定性 upsert（`source: mastery`，与 LLM 晋升共存）
pub fn upsert_weak_point_from_mastery(
    vfs_db: &Arc<VfsDatabase>,
    concept: &str,
    evidence: &MasteryWeakPointEvidence,
) -> VfsResult<LearnerProfileApplyOutcome> {
    let concept = concept.trim();
    if concept.is_empty() {
        return Err(VfsError::InvalidArgument {
            param: "concept".to_string(),
            reason: "mastery concept must be non-empty".to_string(),
        });
    }
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let error_pattern = format!(
        "[mastery] score={:.2} total={} wrongs={}; {}",
        evidence.score, evidence.total, evidence.wrong_count, evidence.recent_wrong_summary
    );
    let update = LearnerProfileUpdate {
        weak_points_add: vec![WeakPoint {
            subject: "掌握度".to_string(),
            knowledge_point: concept.to_string(),
            error_pattern,
            evidence_count: evidence.wrong_count.max(1) as u32,
            last_seen: Some(today),
            source: Some(WEAK_POINT_SOURCE_MASTERY.to_string()),
        }],
        ..Default::default()
    };
    persist_profile_update_from_vfs(
        vfs_db,
        &update,
        "mastery hard reflux upsert",
        ProfileLimitPolicy::Enforce,
    )
}

/// 掌握度恢复：移除 `source=mastery` 且知识点匹配的薄弱点（不影响 LLM 提取条目）
pub fn remove_weak_point_from_mastery(
    vfs_db: &Arc<VfsDatabase>,
    concept: &str,
) -> VfsResult<LearnerProfileApplyOutcome> {
    let concept = concept.trim();
    if concept.is_empty() {
        return Err(VfsError::InvalidArgument {
            param: "concept".to_string(),
            reason: "mastery concept must be non-empty".to_string(),
        });
    }

    for attempt in 0..PROFILE_CAS_MAX_RETRIES {
        let snapshot = load_profile_snapshot(vfs_db)?;
        let mut profile = snapshot
            .as_ref()
            .map(|(_, profile)| profile.clone())
            .unwrap_or_default();

        let before = profile.weak_points.len();
        profile.weak_points.retain(|wp| {
            let mastery_match = wp.source.as_deref() == Some(WEAK_POINT_SOURCE_MASTERY)
                && wp.knowledge_point.trim().eq_ignore_ascii_case(concept);
            !mastery_match
        });
        if profile.weak_points.len() == before {
            return Ok(LearnerProfileApplyOutcome {
                profile,
                changed: false,
            });
        }

        profile.version = profile.version.saturating_add(1);
        profile.updated_at = chrono::Utc::now().to_rfc3339();
        profile.enforce_char_limit();
        let json = profile.to_json();

        let persisted = match snapshot {
            Some((note, _)) => match VfsNoteRepo::update_note(
                vfs_db,
                &note.note_id,
                VfsUpdateNoteParams {
                    title: None,
                    content: Some(json.clone()),
                    tags: None,
                    expected_updated_at: Some(note.updated_at),
                },
            ) {
                Ok(_) => true,
                Err(VfsError::Conflict { .. }) => false,
                Err(error) if super::is_retryable_sqlite_lock(&error) => false,
                Err(error) => return Err(error),
            },
            None => true, // nothing to remove from empty profile
        };

        if !persisted {
            super::backoff_memory_write(attempt);
            continue;
        }
        debug!(
            "[LearnerProfile] Removed mastery weak_point concept={}",
            concept
        );
        return Ok(LearnerProfileApplyOutcome {
            profile,
            changed: true,
        });
    }

    Err(VfsError::Conflict {
        key: "learner_profile.conflict".to_string(),
        message: "The learner profile remained busy after mastery recovery retries.".to_string(),
    })
}

fn persist_profile_update_from_vfs(
    vfs_db: &Arc<VfsDatabase>,
    update: &LearnerProfileUpdate,
    reason: &str,
    limit_policy: ProfileLimitPolicy,
) -> VfsResult<LearnerProfileApplyOutcome> {
    for attempt in 0..PROFILE_CAS_MAX_RETRIES {
        let snapshot = load_profile_snapshot(vfs_db)?;
        let mut profile = snapshot
            .as_ref()
            .map(|(_, profile)| profile.clone())
            .unwrap_or_default();

        let content_changed = profile.merge_update(update);
        if !content_changed {
            return Ok(LearnerProfileApplyOutcome {
                profile,
                changed: false,
            });
        }

        profile.version = profile.version.saturating_add(1);
        profile.updated_at = chrono::Utc::now().to_rfc3339();
        match limit_policy {
            ProfileLimitPolicy::Enforce => {
                profile.enforce_char_limit();
            }
            ProfileLimitPolicy::Reject => {
                let rendered_chars = profile.rendered_char_count();
                if rendered_chars > LEARNER_PROFILE_MAX_CHARS {
                    return Err(VfsError::InvalidArgument {
                        param: "profile".to_string(),
                        reason: format!(
                            "合并后画像 {} 字符，超过 {} 字符硬上限。",
                            rendered_chars, LEARNER_PROFILE_MAX_CHARS
                        ),
                    });
                }
            }
        }
        let json = profile.to_json();

        let persisted = match snapshot {
            Some((note, _)) => match VfsNoteRepo::update_note(
                vfs_db,
                &note.note_id,
                VfsUpdateNoteParams {
                    title: None,
                    content: Some(json.clone()),
                    tags: None,
                    expected_updated_at: Some(note.updated_at),
                },
            ) {
                Ok(_) => true,
                Err(VfsError::Conflict { .. }) => false,
                Err(error) if super::is_retryable_sqlite_lock(&error) => false,
                Err(error) => return Err(error),
            },
            None => {
                let _guard = super::lock_memory_structure();
                if load_profile_snapshot(vfs_db)?.is_some() {
                    false
                } else {
                    let sys_folder_id = get_or_create_system_folder_id_unlocked(vfs_db)?;
                    let note = VfsNoteRepo::create_note_in_folder(
                        vfs_db,
                        VfsCreateNoteParams {
                            title: LEARNER_PROFILE_NOTE_TITLE.to_string(),
                            content: json.clone(),
                            tags: vec!["_system".to_string()],
                        },
                        Some(&sys_folder_id),
                    )?;
                    if let Err(e) = VfsIndexStateRepo::mark_disabled_with_reason(
                        vfs_db,
                        &note.resource_id,
                        "system learner profile note",
                    ) {
                        warn!(
                            "[LearnerProfile] Failed to disable indexing for mastery profile note: {}",
                            e
                        );
                    }
                    debug!(
                        "[LearnerProfile] Created profile via mastery reflux ({reason}) v{} ({})",
                        profile.version, note.id
                    );
                    true
                }
            }
        };

        if !persisted {
            super::backoff_memory_write(attempt);
            continue;
        }
        return Ok(LearnerProfileApplyOutcome {
            profile,
            changed: true,
        });
    }

    Err(VfsError::Conflict {
        key: "learner_profile.conflict".to_string(),
        message: "The learner profile remained busy after mastery upsert retries.".to_string(),
    })
}

/// 读取画像版本历史（最新在前）
pub fn load_profile_history(service: &MemoryService) -> VfsResult<Vec<LearnerProfile>> {
    let vfs_db = service.vfs_db_ref();
    let Some(sys_folder_id) = find_system_folder_id_readonly(vfs_db)? else {
        return Ok(vec![]);
    };
    let Some(snapshot) =
        find_note_snapshot_by_title(vfs_db, &sys_folder_id, LEARNER_PROFILE_HISTORY_NOTE_TITLE)?
    else {
        return Ok(vec![]);
    };
    let versions: Vec<LearnerProfile> = snapshot
        .content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(LearnerProfile::from_json)
        .collect();
    let mut versions = dedupe_profile_versions_keep_last(versions);
    versions.reverse();
    Ok(versions)
}

fn dedupe_profile_versions_keep_last(versions: Vec<LearnerProfile>) -> Vec<LearnerProfile> {
    let mut by_version = std::collections::BTreeMap::new();
    for profile in versions {
        by_version.insert(profile.version, profile);
    }
    by_version.into_values().collect()
}

fn append_profile_history(service: &MemoryService, committed: &LearnerProfile) -> VfsResult<()> {
    let vfs_db = service.vfs_db_ref().clone();

    for attempt in 0..PROFILE_CAS_MAX_RETRIES {
        let sys_folder_id = service.get_or_create_system_folder_id()?;
        let snapshot = find_note_snapshot_by_title(
            &vfs_db,
            &sys_folder_id,
            LEARNER_PROFILE_HISTORY_NOTE_TITLE,
        )?;
        let mut versions: Vec<LearnerProfile> = snapshot
            .as_ref()
            .map(|note| {
                note.content
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .filter_map(LearnerProfile::from_json)
                    .collect()
            })
            .unwrap_or_default();
        versions.push(committed.clone());
        let mut versions = dedupe_profile_versions_keep_last(versions);
        if versions.len() > PROFILE_HISTORY_KEEP {
            versions.drain(0..versions.len() - PROFILE_HISTORY_KEEP);
        }
        let new_content = versions
            .iter()
            .map(LearnerProfile::to_json)
            .collect::<Vec<_>>()
            .join("\n");

        match snapshot {
            Some(note) => match VfsNoteRepo::update_note(
                &vfs_db,
                &note.note_id,
                VfsUpdateNoteParams {
                    title: None,
                    content: Some(new_content),
                    tags: None,
                    expected_updated_at: Some(note.updated_at),
                },
            ) {
                Ok(_) => return Ok(()),
                Err(VfsError::Conflict { .. }) => {
                    super::backoff_memory_write(attempt);
                    continue;
                }
                Err(error) if super::is_retryable_sqlite_lock(&error) => {
                    super::backoff_memory_write(attempt);
                    continue;
                }
                Err(error) => return Err(error),
            },
            None => {
                let _guard = super::lock_memory_structure();
                if find_note_snapshot_by_title(
                    &vfs_db,
                    &sys_folder_id,
                    LEARNER_PROFILE_HISTORY_NOTE_TITLE,
                )?
                .is_some()
                {
                    continue;
                }
                let note = VfsNoteRepo::create_note_in_folder(
                    &vfs_db,
                    VfsCreateNoteParams {
                        title: LEARNER_PROFILE_HISTORY_NOTE_TITLE.to_string(),
                        content: new_content,
                        tags: vec!["_system".to_string()],
                    },
                    Some(&sys_folder_id),
                )?;
                if let Err(e) = VfsIndexStateRepo::mark_disabled_with_reason(
                    &vfs_db,
                    &note.resource_id,
                    "system learner profile history note",
                ) {
                    warn!(
                        "[LearnerProfile] Failed to disable indexing for history note: {}",
                        e
                    );
                }
                return Ok(());
            }
        }
    }

    Err(VfsError::Conflict {
        key: "learner_profile_history.conflict".to_string(),
        message: "The learner profile history remained busy after repeated retries.".to_string(),
    })
}

// ============================================================================
// 单元测试（merge / 渲染 / 上限精炼，均为纯逻辑无 DB）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Barrier};

    fn wp(subject: &str, point: &str, pattern: &str, count: u32) -> WeakPoint {
        WeakPoint {
            subject: subject.to_string(),
            knowledge_point: point.to_string(),
            error_pattern: pattern.to_string(),
            evidence_count: count,
            last_seen: None,
            source: None,
        }
    }

    #[test]
    fn test_merge_upsert_weak_point_accumulates_evidence() {
        let mut profile = LearnerProfile::default();
        profile
            .weak_points
            .push(wp("数学", "二次函数", "符号错误", 2));

        let update = LearnerProfileUpdate {
            weak_points_add: vec![wp("数学", "二次函数", "配方时符号处理错误", 3)],
            ..Default::default()
        };
        assert!(profile.merge_update(&update));
        assert_eq!(profile.weak_points.len(), 1);
        assert_eq!(profile.weak_points[0].evidence_count, 5);
        assert_eq!(profile.weak_points[0].error_pattern, "配方时符号处理错误");
    }

    #[test]
    fn test_merge_adds_new_weak_point_with_min_evidence() {
        let mut profile = LearnerProfile::default();
        let update = LearnerProfileUpdate {
            weak_points_add: vec![wp("英语", "虚拟语气", "时态搭配错误", 0)],
            ..Default::default()
        };
        assert!(profile.merge_update(&update));
        assert_eq!(profile.weak_points.len(), 1);
        // 证据计数至少为 1
        assert_eq!(profile.weak_points[0].evidence_count, 1);
    }

    #[test]
    fn test_merge_remove_weak_point() {
        let mut profile = LearnerProfile::default();
        profile
            .weak_points
            .push(wp("数学", "二次函数", "符号错误", 2));
        let update = LearnerProfileUpdate {
            weak_points_remove: vec![WeakPointKey {
                subject: "数学".to_string(),
                knowledge_point: "二次函数".to_string(),
            }],
            ..Default::default()
        };
        assert!(profile.merge_update(&update));
        assert!(profile.weak_points.is_empty());
    }

    #[test]
    fn test_merge_skips_blank_weak_point() {
        let mut profile = LearnerProfile::default();
        let update = LearnerProfileUpdate {
            weak_points_add: vec![wp("", "", "无效", 1)],
            ..Default::default()
        };
        assert!(!profile.merge_update(&update));
        assert!(profile.weak_points.is_empty());
    }

    #[test]
    fn test_merge_preferences_patch_is_field_level() {
        let mut profile = LearnerProfile::default();
        profile.preferences.language = Some("中文".to_string());
        profile.preferences.pace = Some("较慢".to_string());

        let update = LearnerProfileUpdate {
            preferences: Some(PreferencesPatch {
                pace: Some("较快".to_string()),
                others_add: vec!["喜欢表格总结".to_string(), "喜欢表格总结".to_string()],
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(profile.merge_update(&update));
        // 未提供的字段不被覆盖
        assert_eq!(profile.preferences.language.as_deref(), Some("中文"));
        assert_eq!(profile.preferences.pace.as_deref(), Some("较快"));
        // others 追加去重
        assert_eq!(profile.preferences.others.len(), 1);
    }

    #[test]
    fn test_merge_goals_dedup_and_remove() {
        let mut profile = LearnerProfile::default();
        let update = LearnerProfileUpdate {
            goals_add: vec![
                LearningGoal {
                    goal: "高考数学 130+".to_string(),
                    deadline: Some("2026-06-07".to_string()),
                },
                LearningGoal {
                    goal: "高考数学 130+".to_string(),
                    deadline: Some("2026-06-07".to_string()),
                },
            ],
            ..Default::default()
        };
        assert!(profile.merge_update(&update));
        assert_eq!(profile.goals.len(), 1);

        let remove = LearnerProfileUpdate {
            goals_remove: vec!["高考数学 130+".to_string()],
            ..Default::default()
        };
        assert!(profile.merge_update(&remove));
        assert!(profile.goals.is_empty());
    }

    #[test]
    fn test_merge_empty_update_no_change() {
        let mut profile = LearnerProfile::default();
        let update = LearnerProfileUpdate::default();
        assert!(update.is_empty());
        assert!(!profile.merge_update(&update));
    }

    #[test]
    fn test_render_markdown_contains_all_sections() {
        let mut profile = LearnerProfile {
            version: 3,
            updated_at: "2026-07-08".to_string(),
            recent_status: Some("连续三天练习二次函数".to_string()),
            ..Default::default()
        };
        profile.weak_points.push(WeakPoint {
            subject: "数学".to_string(),
            knowledge_point: "二次函数".to_string(),
            error_pattern: "符号错误".to_string(),
            evidence_count: 4,
            last_seen: Some("2026-07-08".to_string()),
            source: None,
        });
        profile.preferences.explanation_style = Some("先结论后推导".to_string());
        profile.goals.push(LearningGoal {
            goal: "高考数学 130+".to_string(),
            deadline: Some("2026-06-07".to_string()),
        });

        let md = profile.render_markdown();
        assert!(md.contains("学习者画像（v3"));
        assert!(md.contains("薄弱知识点"));
        assert!(md.contains("[数学/二次函数] 符号错误（证据×4，最近 2026-07-08）"));
        assert!(md.contains("讲解风格：先结论后推导"));
        assert!(md.contains("高考数学 130+（期限 2026-06-07）"));
        assert!(md.contains("近期状态"));
    }

    #[test]
    fn test_enforce_char_limit_drops_low_evidence_first() {
        let mut profile = LearnerProfile::default();
        // 构造超限画像：50 条长错误模式的薄弱知识点
        for i in 0..50 {
            profile.weak_points.push(wp(
                "数学",
                &format!("知识点{}", i),
                &"很长的错误模式描述".repeat(10),
                i as u32,
            ));
        }
        assert!(profile.rendered_char_count() > LEARNER_PROFILE_MAX_CHARS);
        assert!(profile.enforce_char_limit());
        assert!(profile.rendered_char_count() <= LEARNER_PROFILE_MAX_CHARS);
        // 保留的是证据计数最高的条目
        assert!(
            profile.weak_points[0].evidence_count
                >= profile.weak_points.last().unwrap().evidence_count
        );
    }

    #[test]
    fn test_enforce_char_limit_noop_when_small() {
        let mut profile = LearnerProfile::default();
        profile.weak_points.push(wp("数学", "函数", "符号错误", 1));
        assert!(!profile.enforce_char_limit());
        assert_eq!(profile.weak_points.len(), 1);
    }

    #[test]
    fn test_json_roundtrip() {
        let mut profile = LearnerProfile::default();
        profile.version = 7;
        profile
            .weak_points
            .push(wp("物理", "受力分析", "漏画摩擦力", 3));
        let json = profile.to_json();
        let parsed = LearnerProfile::from_json(&json).unwrap();
        assert_eq!(parsed, profile);
    }

    #[test]
    fn test_from_json_tolerates_missing_fields() {
        let parsed = LearnerProfile::from_json(r#"{"weak_points":[{"subject":"数学"}]}"#).unwrap();
        assert_eq!(parsed.version, 0);
        assert_eq!(parsed.weak_points.len(), 1);
        assert_eq!(parsed.weak_points[0].evidence_count, 0);
    }

    #[test]
    fn promotion_fingerprint_replay_is_exactly_once_and_repairs_history() {
        let (_temp_dir, vfs_db, service) = crate::memory::test_support::setup_memory_service();
        let update = LearnerProfileUpdate {
            weak_points_add: vec![wp("数学", "二次函数", "配方时符号错误", 3)],
            ..Default::default()
        };

        let first = apply_profile_promotion_update(
            &service,
            &update,
            MemoryOpSource::Evolution,
            None,
            "promotion test",
            ProfileLimitPolicy::Enforce,
            "logs-fingerprint-1",
            || false,
        )
        .expect("first promotion");
        assert!(first.changed);
        assert_eq!(first.profile.version, 1);
        assert_eq!(first.profile.weak_points[0].evidence_count, 3);
        assert!(first
            .profile
            .to_json()
            .contains(PROMOTION_FINGERPRINT_JSON_KEY));
        assert!(
            serde_json::to_value(&first.profile)
                .unwrap()
                .get(PROMOTION_FINGERPRINT_JSON_KEY)
                .is_none(),
            "generic API serialization must not expose the internal marker"
        );

        // Equivalent to a crash after the profile+marker commit but before history/config.
        let system_folder = find_system_folder_id_readonly(&vfs_db)
            .unwrap()
            .expect("system folder");
        let history_note = find_note_snapshot_by_title(
            &vfs_db,
            &system_folder,
            LEARNER_PROFILE_HISTORY_NOTE_TITLE,
        )
        .unwrap()
        .expect("history note");
        VfsNoteRepo::update_note(
            &vfs_db,
            &history_note.note_id,
            VfsUpdateNoteParams {
                content: Some(String::new()),
                expected_updated_at: Some(history_note.updated_at),
                ..Default::default()
            },
        )
        .expect("clear history to simulate interrupted post-commit work");

        let replay = apply_profile_promotion_update(
            &service,
            &update,
            MemoryOpSource::Evolution,
            None,
            "promotion retry",
            ProfileLimitPolicy::Enforce,
            "logs-fingerprint-1",
            || false,
        )
        .expect("promotion replay");
        assert!(!replay.changed);
        assert_eq!(replay.profile.version, 1);
        assert_eq!(replay.profile.weak_points[0].evidence_count, 3);

        let history = load_profile_history(&service).expect("repaired profile history");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].version, 1);
        assert_eq!(history[0].weak_points[0].evidence_count, 3);
    }

    #[test]
    fn profile_history_dedup_keeps_last_entry_for_each_version() {
        let mut v1_old = LearnerProfile {
            version: 1,
            recent_status: Some("old".to_string()),
            ..Default::default()
        };
        let mut v2 = LearnerProfile {
            version: 2,
            recent_status: Some("v2".to_string()),
            ..Default::default()
        };
        let v1_new = LearnerProfile {
            version: 1,
            recent_status: Some("new".to_string()),
            ..Default::default()
        };
        v1_old.updated_at = "old".to_string();
        v2.updated_at = "v2".to_string();

        let deduped = dedupe_profile_versions_keep_last(vec![v1_old, v2, v1_new]);
        assert_eq!(deduped.len(), 2);
        assert_eq!(deduped[0].version, 1);
        assert_eq!(deduped[0].recent_status.as_deref(), Some("new"));
        assert_eq!(deduped[1].version, 2);
    }

    #[test]
    fn concurrent_profile_updates_replay_after_cas_conflict() {
        let (_temp_dir, _vfs_db, service) = crate::memory::test_support::setup_memory_service();
        let seed = LearnerProfileUpdate {
            goals_add: vec![LearningGoal {
                goal: "seed-goal".to_string(),
                deadline: None,
            }],
            ..Default::default()
        };
        apply_profile_update(
            &service,
            &seed,
            MemoryOpSource::ToolCall,
            None,
            "seed",
            ProfileLimitPolicy::Reject,
            || false,
        )
        .expect("seed profile");

        let service = Arc::new(service);
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();
        for goal in ["concurrent-goal-a", "concurrent-goal-b"] {
            let service = service.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                let update = LearnerProfileUpdate {
                    goals_add: vec![LearningGoal {
                        goal: goal.to_string(),
                        deadline: None,
                    }],
                    ..Default::default()
                };
                apply_profile_update_inner(
                    &service,
                    &update,
                    MemoryOpSource::ToolCall,
                    None,
                    "concurrent update",
                    ProfileLimitPolicy::Reject,
                    || false,
                    None,
                    Some(move || {
                        barrier.wait();
                    }),
                )
                .expect("concurrent profile update should retry")
            }));
        }
        for handle in handles {
            assert!(handle.join().expect("profile thread panicked").changed);
        }

        let profile = load_profile(&service)
            .expect("load profile")
            .expect("profile should exist");
        let goals: Vec<&str> = profile
            .goals
            .iter()
            .map(|goal| goal.goal.as_str())
            .collect();
        assert!(goals.contains(&"seed-goal"));
        assert!(goals.contains(&"concurrent-goal-a"));
        assert!(goals.contains(&"concurrent-goal-b"));
        assert_eq!(profile.version, 3);

        let history = load_profile_history(&service).expect("load profile history");
        assert_eq!(history.first().map(|profile| profile.version), Some(3));
        assert!(history.iter().any(|profile| profile.version == 2));
        assert!(history.iter().any(|profile| profile.version == 1));
    }

    #[test]
    fn concurrent_first_profile_updates_create_one_reserved_structure() {
        let (_temp_dir, vfs_db, service) = crate::memory::test_support::setup_memory_service();
        let service = Arc::new(service);
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();
        for goal in ["first-goal-a", "first-goal-b"] {
            let service = service.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                apply_profile_update_inner(
                    &service,
                    &LearnerProfileUpdate {
                        goals_add: vec![LearningGoal {
                            goal: goal.to_string(),
                            deadline: None,
                        }],
                        ..Default::default()
                    },
                    MemoryOpSource::ToolCall,
                    None,
                    "concurrent first update",
                    ProfileLimitPolicy::Reject,
                    || false,
                    None,
                    Some(move || {
                        barrier.wait();
                    }),
                )
                .expect("first profile update should replay")
            }));
        }
        for handle in handles {
            assert!(handle.join().expect("profile thread panicked").changed);
        }

        let profile = load_profile(&service)
            .expect("load profile")
            .expect("profile should exist");
        assert_eq!(profile.version, 2);
        assert!(profile.goals.iter().any(|goal| goal.goal == "first-goal-a"));
        assert!(profile.goals.iter().any(|goal| goal.goal == "first-goal-b"));

        let conn = vfs_db.get_conn_safe().expect("open VFS database");
        for (title, expected) in [("记忆", 1_i64), ("__system__", 1_i64)] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM folders WHERE title = ?1 AND deleted_at IS NULL",
                    rusqlite::params![title],
                    |row| row.get(0),
                )
                .expect("count reserved folders");
            assert_eq!(count, expected, "reserved folder {title} must be unique");
        }
        for title in [
            LEARNER_PROFILE_NOTE_TITLE,
            LEARNER_PROFILE_HISTORY_NOTE_TITLE,
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL",
                    rusqlite::params![title],
                    |row| row.get(0),
                )
                .expect("count reserved notes");
            assert_eq!(count, 1, "reserved note {title} must be unique");
        }
    }

    #[test]
    fn cancellation_before_commit_leaves_profile_unchanged() {
        let (_temp_dir, _vfs_db, service) = crate::memory::test_support::setup_memory_service();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_for_check = cancelled.clone();
        let cancel_at_barrier = cancelled.clone();
        let update = LearnerProfileUpdate {
            goals_add: vec![LearningGoal {
                goal: "must-not-commit".to_string(),
                deadline: None,
            }],
            ..Default::default()
        };

        let result = apply_profile_update_inner(
            &service,
            &update,
            MemoryOpSource::ToolCall,
            None,
            "cancelled update",
            ProfileLimitPolicy::Reject,
            move || cancel_for_check.load(Ordering::SeqCst),
            None,
            Some(move || cancel_at_barrier.store(true, Ordering::SeqCst)),
        );

        assert!(matches!(
            result,
            Err(VfsError::InvalidOperation { operation, .. })
                if operation == "learner_profile_update"
        ));
        assert!(load_profile(&service).expect("load profile").is_none());
    }
}
