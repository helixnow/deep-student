//! 作文批改工具执行器（essay_* 工具组）
//!
//! 将 `essay_grading` 模块的批改流水线暴露给 agent，打通
//! "作文批改 → 错误点入题库（qbank_batch_import）→ 安排复习（review_schedule）" 的学习闭环。
//!
//! ## 工具列表
//! - `essay_grade`: 提交作文文本发起批改（异步任务型：后台运行批改流水线，立即返回 task_id）
//! - `essay_grade_wait`: 等待批改任务完成（内部轮询，超时返回 timeout 状态，可再次调用）
//! - `essay_grade_status`: 查询批改任务状态（不阻塞）
//! - `essay_list_modes`: 列出可用的内置批阅模式（gaokao/ielts/toefl/...）
//! - `essay_list_sessions`: 列出历史批改会话
//! - `essay_list_results`: 列出某会话的所有批改轮次（摘要）
//! - `essay_get_result`: 获取某轮批改的完整结果（原文 + 批改 + 评分）
//!
//! ## 异步模式说明（参照 chatanki run/status/wait 模式）
//! 批改是一次完整的 LLM 流式调用，长作文 + 推理模型可能超过工具默认 120s 超时，
//! 因此 `essay_grade` 采用 "发起 + 等待" 拆分：
//! 1. `essay_grade` 用 `tokio::spawn` 后台执行 `essay_grading::pipeline::run_grading`，
//!    任务状态登记在进程内 `ESSAY_TASKS` 注册表；
//! 2. `essay_grade_wait` 轮询注册表（兜底轮询 VFS 数据库轮次记录），拿到最终结果；
//! 3. 批改结果由流水线自身持久化到 VFS（essays 表），应用重启后仍可用
//!    `essay_list_results` / `essay_get_result` 查询。
//!
//! ## 敏感度
//! - `essay_grade`: Medium（消耗 LLM 算力 + 写入批改记录）
//! - 其余查询类: Low
//!
//! ## 事件发射（强制，见 tools/mod.rs 头注释）
//! - 开始: `ctx.emit_tool_call_start`
//! - 成功: `ctx.emit_tool_call_end`
//! - 失败: `ctx.emit_tool_call_error`

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::essay_grading::custom_modes::CustomModeManager;
use crate::essay_grading::events::GradingEventEmitter;
use crate::essay_grading::pipeline::{resolve_grading_mode, run_grading, GradingDeps};
use crate::essay_grading::types::{get_builtin_grading_modes, GradingMode, GradingRequest};
use crate::vfs::repos::VfsEssayRepo;
use crate::vfs::types::VfsCreateEssaySessionParams;

/// 作文输入最大字符数（与 essay_grading pipeline 的 MAX_INPUT_CHARS 保持一致）
const MAX_ESSAY_CHARS: usize = 50000;

/// essay_grade_wait 默认等待时长（毫秒）
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 90_000;

/// essay_grade_wait 最大等待时长（毫秒）——必须小于工具全局超时 120s，留出余量
const MAX_WAIT_TIMEOUT_MS: u64 = 100_000;

/// 批改结果回传给 LLM 的最大字符数（防止上下文膨胀；完整结果始终可经 essay_get_result 获取）
const MAX_RESULT_CHARS_IN_TOOL_OUTPUT: usize = 2_000;

// ============================================================================
// 后台批改任务注册表
// ============================================================================

/// 批改任务状态
#[derive(Debug, Clone)]
struct EssayTaskState {
    session_id: String,
    round_number: i32,
    /// running | completed | error | cancelled
    status: String,
    round_id: Option<String>,
    overall_score: Option<f32>,
    error: Option<String>,
    started_at_ms: i64,
    finished_at_ms: Option<i64>,
}

/// 进程内批改任务注册表（task_id -> 状态）
///
/// 仅用于本次进程生命周期内的状态查询；批改结果本身由流水线持久化到 VFS，
/// 重启后可通过 essay_list_results / essay_get_result 查询到已完成的轮次。
static ESSAY_TASKS: LazyLock<Mutex<HashMap<String, EssayTaskState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 安全截断字符串（按字符数，不劈开多字节字符）
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!(
            "{}…（已截断，完整内容请用 essay_get_result 查询）",
            truncated
        )
    }
}

pub struct EssayGradingExecutor;

impl EssayGradingExecutor {
    pub fn new() -> Self {
        Self
    }

    fn read_bounded_u32(args: &Value, key: &str, default: u32, min: u32, max: u32) -> u32 {
        let raw = args
            .get(key)
            .and_then(|v| v.as_i64())
            .unwrap_or(default as i64);
        let normalized = if raw < min as i64 { min } else { raw as u32 };
        normalized.clamp(min, max)
    }

    /// 从 VfsEssay 的 grading_result JSON 中提取批改文本
    fn extract_result_text(grading_result: Option<&Value>) -> String {
        grading_result
            .and_then(|v| v.get("result"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }

    /// 从 VfsEssay 的 grading_result JSON 中提取总分
    fn extract_overall_score(grading_result: Option<&Value>, score: Option<i32>) -> Option<f32> {
        grading_result
            .and_then(|v| v.get("overall_score"))
            .and_then(|v| v.as_f64())
            .map(|v| v as f32)
            .or_else(|| score.map(|s| s as f32))
    }

    /// Load the current custom-mode file using the same data directory that
    /// backs the active main database.  The UI owns the manager in AppState,
    /// but tool execution only receives the database handle; deriving the
    /// directory here keeps the tool on the same source of truth without
    /// introducing a second in-memory cache into the Chat V2 context.
    fn load_custom_modes_from_database(
        main_db: Option<&crate::database::Database>,
    ) -> Vec<GradingMode> {
        let Some(main_db) = main_db else {
            return Vec::new();
        };
        let Some(db_path) = main_db.db_path() else {
            return Vec::new();
        };
        let Some(data_dir) = db_path.parent() else {
            return Vec::new();
        };
        let data_dir = data_dir.to_path_buf();
        CustomModeManager::new(&data_dir).list_modes()
    }

    fn load_custom_modes(ctx: &ExecutionContext) -> Vec<GradingMode> {
        Self::load_custom_modes_from_database(ctx.main_db.as_deref())
    }

    /// Match the UI command semantics: custom overrides replace built-ins with
    /// the same id, while standalone custom modes are appended to the list.
    fn merge_modes(custom_modes: Vec<GradingMode>) -> Vec<GradingMode> {
        let builtin_modes = get_builtin_grading_modes();
        let builtin_ids = builtin_modes
            .iter()
            .map(|mode| mode.id.clone())
            .collect::<std::collections::HashSet<_>>();

        let mut modes = Vec::with_capacity(builtin_modes.len() + custom_modes.len());
        for builtin in builtin_modes {
            if let Some(custom) = custom_modes.iter().find(|mode| mode.id == builtin.id) {
                let mut override_mode = custom.clone();
                // Preserve the UI's semantic distinction for an overridden
                // built-in mode while still returning the customized prompt.
                override_mode.is_builtin = true;
                modes.push(override_mode);
            } else {
                modes.push(builtin);
            }
        }
        modes.extend(
            custom_modes
                .into_iter()
                .filter(|mode| !builtin_ids.contains(&mode.id)),
        );
        modes
    }

    fn canonicalize_requested_mode_id(
        requested_mode_id: Option<String>,
        custom_modes: &[GradingMode],
    ) -> Result<Option<String>, String> {
        if requested_mode_id.is_none() {
            return Ok(None);
        }

        resolve_grading_mode(&requested_mode_id, custom_modes)
            .map(|mode| Some(mode.id))
            .map_err(|error| serde_json::to_string(&error).unwrap_or_else(|_| error.to_string()))
    }

    // ========================================================================
    // essay_grade：发起批改（异步任务）
    // ========================================================================

    async fn execute_grade(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let text = call
            .arguments
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or("Missing 'text' parameter（作文正文不能为空）")?;

        let char_count = text.chars().count();
        if char_count > MAX_ESSAY_CHARS {
            return Err(format!(
                "作文长度超限：{} 字符（上限 {} 字符）",
                char_count, MAX_ESSAY_CHARS
            ));
        }

        let vfs_db = ctx
            .vfs_db
            .as_ref()
            .ok_or("VFS database not available")?
            .clone();
        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM Manager not available")?
            .clone();

        let requested_mode_id = call
            .arguments
            .get("mode_id")
            .and_then(|v| v.as_str())
            .map(String::from);
        // Validate before creating a grading session or background task. This
        // keeps an explicit stale/guessed mode ID from silently using the
        // default rubric and returns the pipeline's structured error intact.
        let custom_modes = Self::load_custom_modes(ctx);
        let mode_id = Self::canonicalize_requested_mode_id(requested_mode_id, &custom_modes)?;
        let topic = call
            .arguments
            .get("topic")
            .and_then(|v| v.as_str())
            .map(String::from);
        let essay_type = call
            .arguments
            .get("essay_type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let grade_level = call
            .arguments
            .get("grade_level")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let custom_prompt = call
            .arguments
            .get("custom_prompt")
            .and_then(|v| v.as_str())
            .map(String::from);
        let model_config_id = call
            .arguments
            .get("model_config_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(String::from);
        let session_id_arg = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(String::from);

        // 解析会话：续批已有会话 / 新建会话
        let (session_id, round_number, previous_result, previous_input) =
            if let Some(sid) = session_id_arg {
                let session = VfsEssayRepo::get_session(&vfs_db, &sid)
                    .map_err(|e| format!("获取批改会话失败: {}", e))?
                    .ok_or_else(|| {
                        format!("批改会话不存在: {}（请先用 essay_list_sessions 查询）", sid)
                    })?;
                let latest = VfsEssayRepo::get_latest_round_number(&vfs_db, &session.id)
                    .map_err(|e| format!("获取最新轮次失败: {}", e))?;
                // 多轮上下文：带上上一轮的批改结果与原文，便于流水线做修改对比
                let (prev_result, prev_input) =
                    match VfsEssayRepo::get_round(&vfs_db, &session.id, latest) {
                        Ok(Some(prev)) => {
                            let prev_text = Self::extract_result_text(prev.grading_result.as_ref());
                            let prev_input = VfsEssayRepo::get_essay_content(&vfs_db, &prev.id)
                                .ok()
                                .flatten();
                            (
                                if prev_text.is_empty() {
                                    None
                                } else {
                                    Some(prev_text)
                                },
                                prev_input,
                            )
                        }
                        _ => (None, None),
                    };
                (session.id, latest + 1, prev_result, prev_input)
            } else {
                // 新建会话：标题默认取正文前 20 字符
                let title = call
                    .arguments
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| {
                        let head: String = text.chars().take(20).collect();
                        format!("作文批改：{}", head)
                    });
                let params = VfsCreateEssaySessionParams {
                    title,
                    essay_type: if essay_type.is_empty() {
                        None
                    } else {
                        Some(essay_type.clone())
                    },
                    grade_level: if grade_level.is_empty() {
                        None
                    } else {
                        Some(grade_level.clone())
                    },
                    custom_prompt: custom_prompt.clone(),
                };
                let session = VfsEssayRepo::create_session(&vfs_db, params)
                    .map_err(|e| format!("创建批改会话失败: {}", e))?;
                (session.id, 1, None, None)
            };

        // 登记后台任务
        let task_id = format!("essaytask_{}", uuid::Uuid::new_v4().simple());
        let now_ms = chrono::Utc::now().timestamp_millis();
        {
            let mut tasks = ESSAY_TASKS.lock().await;
            tasks.insert(
                task_id.clone(),
                EssayTaskState {
                    session_id: session_id.clone(),
                    round_number,
                    status: "running".to_string(),
                    round_id: None,
                    overall_score: None,
                    error: None,
                    started_at_ms: now_ms,
                    finished_at_ms: None,
                },
            );
        }

        // 构造批改请求。stream_session_id 使用 agent 前缀，SSE 事件无前端订阅者，无副作用。
        let request = GradingRequest {
            session_id: session_id.clone(),
            stream_session_id: format!("agent_{}", task_id),
            round_number,
            input_text: text.to_string(),
            topic,
            mode_id,
            model_config_id,
            essay_type,
            grade_level,
            custom_prompt,
            previous_result,
            previous_input,
            image_base64_list: None,
            topic_image_base64_list: None,
        };

        // 后台执行批改流水线
        let deps = GradingDeps {
            llm: llm_manager,
            vfs_db,
            emitter: GradingEventEmitter::new(ctx.window_ref().clone()),
            custom_modes,
        };
        let task_id_for_spawn = task_id.clone();
        tokio::spawn(async move {
            let outcome = run_grading(request, deps).await;
            let mut tasks = ESSAY_TASKS.lock().await;
            if let Some(state) = tasks.get_mut(&task_id_for_spawn) {
                state.finished_at_ms = Some(chrono::Utc::now().timestamp_millis());
                match outcome {
                    Ok(Some(response)) => {
                        state.status = "completed".to_string();
                        state.round_id = Some(response.round_id);
                        state.overall_score = response.overall_score;
                    }
                    Ok(None) => {
                        state.status = "cancelled".to_string();
                    }
                    Err(e) => {
                        state.status = "error".to_string();
                        state.error = Some(e.to_string());
                        log::error!("[EssayGradingExecutor] 后台批改失败: {}", e);
                    }
                }
            }
        });

        Ok(json!({
            "status": "started",
            "task_id": task_id,
            "session_id": session_id,
            "round_number": round_number,
            "message": "批改任务已在后台启动",
            "hint": "下一轮调用 essay_grade_wait（传 task_id）等待批改完成；完成后可将批改指出的错误点整理为题目，用 qbank_batch_import 入错题本，再用 review_schedule 安排间隔复习。",
        }))
    }

    // ========================================================================
    // essay_grade_status / essay_grade_wait
    // ========================================================================

    /// 从注册表或数据库解析任务状态
    async fn resolve_task_state(
        &self,
        ctx: &ExecutionContext,
        task_id: Option<&str>,
        session_id: Option<&str>,
        round_number: Option<i32>,
    ) -> Result<Value, String> {
        // 1. 优先查进程内注册表
        if let Some(tid) = task_id {
            let tasks = ESSAY_TASKS.lock().await;
            if let Some(state) = tasks.get(tid) {
                let mut payload = json!({
                    "task_id": tid,
                    "status": state.status,
                    "session_id": state.session_id,
                    "round_number": state.round_number,
                    "started_at_ms": state.started_at_ms,
                });
                if let Some(round_id) = &state.round_id {
                    payload["round_id"] = json!(round_id);
                }
                if let Some(score) = state.overall_score {
                    payload["overall_score"] = json!(score);
                }
                if let Some(err) = &state.error {
                    payload["error"] = json!(err);
                }
                if let Some(finished) = state.finished_at_ms {
                    payload["finished_at_ms"] = json!(finished);
                }
                return Ok(payload);
            }
            // 注册表没有（可能应用重启）——回退数据库查询需要 session_id
        }

        // 2. 兜底：按 session_id + round_number 查数据库轮次是否已落库
        let sid = session_id.ok_or(
            "任务不在运行注册表中，且未提供 session_id。请传 task_id（本次会话内有效）或 session_id + round_number。",
        )?;
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let round = match round_number {
            Some(r) => r,
            None => VfsEssayRepo::get_latest_round_number(vfs_db, sid)
                .map_err(|e| format!("获取最新轮次失败: {}", e))?,
        };
        match VfsEssayRepo::get_round(vfs_db, sid, round)
            .map_err(|e| format!("查询批改轮次失败: {}", e))?
        {
            Some(essay) => Ok(json!({
                "status": "completed",
                "session_id": sid,
                "round_number": round,
                "round_id": essay.id,
                "overall_score": Self::extract_overall_score(essay.grading_result.as_ref(), essay.score),
                "source": "vfs_db",
            })),
            None => Ok(json!({
                "status": "not_found",
                "session_id": sid,
                "round_number": round,
                "message": "该轮次尚未落库（可能仍在批改中或已失败）。若刚发起批改，请稍后再查询。",
            })),
        }
    }

    async fn execute_grade_status(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let task_id = call.arguments.get("task_id").and_then(|v| v.as_str());
        let session_id = call.arguments.get("session_id").and_then(|v| v.as_str());
        let round_number = call
            .arguments
            .get("round_number")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32);
        if task_id.is_none() && session_id.is_none() {
            return Err("必须提供 task_id 或 session_id 之一".to_string());
        }
        self.resolve_task_state(ctx, task_id, session_id, round_number)
            .await
    }

    async fn execute_grade_wait(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let task_id = call
            .arguments
            .get("task_id")
            .and_then(|v| v.as_str())
            .map(String::from);
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(String::from);
        if task_id.is_none() && session_id.is_none() {
            return Err("必须提供 task_id 或 session_id 之一".to_string());
        }
        let round_number = call
            .arguments
            .get("round_number")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32);
        let timeout_ms = call
            .arguments
            .get("timeout_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_WAIT_TIMEOUT_MS)
            .min(MAX_WAIT_TIMEOUT_MS);

        let deadline = Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            if ctx.is_cancelled() {
                return Err("Tool execution cancelled".to_string());
            }

            let state = self
                .resolve_task_state(ctx, task_id.as_deref(), session_id.as_deref(), round_number)
                .await?;
            let status = state
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");

            if status == "completed" {
                // 完成：附上完整批改结果，供后续错题提取
                let mut payload = state.clone();
                let sid = state
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let round = state
                    .get("round_number")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0) as i32;
                if let Some(vfs_db) = ctx.vfs_db.as_ref() {
                    if let Ok(Some(essay)) = VfsEssayRepo::get_round(vfs_db, &sid, round) {
                        let result_text = Self::extract_result_text(essay.grading_result.as_ref());
                        payload["grading_result"] = json!(truncate_chars(
                            &result_text,
                            MAX_RESULT_CHARS_IN_TOOL_OUTPUT
                        ));
                        if let Some(dims) = essay.dimension_scores.as_ref() {
                            payload["dimension_scores"] = dims.clone();
                        }
                    }
                }
                payload["hint"] = json!(
                    "批改完成。建议后续链路：1) 从批改结果中提取错误点/薄弱项，用 qbank_batch_import 转为错题入题库；2) 对入库题目调用 review_schedule 安排间隔复习。"
                );
                return Ok(payload);
            }
            if status == "error" || status == "cancelled" {
                return Ok(state);
            }

            if Instant::now() >= deadline {
                let mut payload = state;
                payload["status"] = json!("timeout");
                payload["message"] = json!(format!(
                    "等待 {}ms 后批改仍未完成。可再次调用 essay_grade_wait 继续等待，或用 essay_grade_status 查询。",
                    timeout_ms
                ));
                return Ok(payload);
            }

            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }
    }

    // ========================================================================
    // 查询类工具
    // ========================================================================

    async fn execute_list_modes(&self, ctx: &ExecutionContext) -> Result<Value, String> {
        let modes: Vec<Value> = Self::merge_modes(Self::load_custom_modes(ctx))
            .into_iter()
            .map(|m| {
                json!({
                    "id": m.id,
                    "name": m.name,
                    "description": m.description,
                    "total_max_score": m.total_max_score,
                    "is_builtin": m.is_builtin,
                    "dimensions": m.score_dimensions.iter().map(|d| json!({
                        "name": d.name,
                        "max_score": d.max_score,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        Ok(json!({
            "modes": modes,
            "count": modes.len(),
            "hint": "调用 essay_grade 时通过 mode_id 指定批阅模式；不传则使用默认通用模式。",
        }))
    }

    async fn execute_list_sessions(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let page = Self::read_bounded_u32(&call.arguments, "page", 1, 1, u32::MAX);
        let page_size = Self::read_bounded_u32(&call.arguments, "page_size", 20, 1, 20);
        let offset = page.saturating_sub(1).saturating_mul(page_size);

        let sessions = VfsEssayRepo::list_sessions(vfs_db, page_size, offset)
            .map_err(|e| format!("查询批改会话失败: {}", e))?;
        let total =
            VfsEssayRepo::count_sessions(vfs_db).map_err(|e| format!("统计批改会话失败: {}", e))?;

        let items: Vec<Value> = sessions
            .iter()
            .map(|s| {
                json!({
                    "session_id": s.id,
                    "title": s.title,
                    "essay_type": s.essay_type,
                    "grade_level": s.grade_level,
                    "total_rounds": s.total_rounds,
                    "latest_score": s.latest_score,
                    "created_at": s.created_at,
                    "updated_at": s.updated_at,
                })
            })
            .collect();

        Ok(json!({
            "sessions": items,
            "count": items.len(),
            "total": total,
            "page": page,
            "pageSize": page_size,
            "hasMore": offset.saturating_add(items.len() as u32) < total,
        }))
    }

    async fn execute_list_results(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let page = Self::read_bounded_u32(&call.arguments, "page", 1, 1, u32::MAX);
        let page_size = Self::read_bounded_u32(&call.arguments, "page_size", 20, 1, 20);
        let offset = page.saturating_sub(1).saturating_mul(page_size);
        let essays = VfsEssayRepo::list_rounds_by_session(vfs_db, session_id, page_size, offset)
            .map_err(|e| format!("查询批改轮次失败: {}", e))?;
        let total = VfsEssayRepo::count_rounds_by_session(vfs_db, session_id)
            .map_err(|e| format!("统计批改轮次失败: {}", e))?;

        let rounds: Vec<Value> = essays
            .iter()
            .map(|e| {
                let result_text = Self::extract_result_text(e.grading_result.as_ref());
                json!({
                    "round_id": e.id,
                    "round_number": e.round_number,
                    "overall_score": Self::extract_overall_score(e.grading_result.as_ref(), e.score),
                    "result_preview": truncate_chars(&result_text, 200),
                    "created_at": e.created_at,
                })
            })
            .collect();

        Ok(json!({
            "session_id": session_id,
            "rounds": rounds,
            "count": rounds.len(),
            "total": total,
            "page": page,
            "pageSize": page_size,
            "hasMore": offset.saturating_add(rounds.len() as u32) < total,
            "hint": "用 essay_get_result 获取某轮的完整批改内容。",
        }))
    }

    async fn execute_get_result(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let round_number = match call.arguments.get("round_number").and_then(|v| v.as_i64()) {
            Some(r) => r as i32,
            None => VfsEssayRepo::get_latest_round_number(vfs_db, session_id)
                .map_err(|e| format!("获取最新轮次失败: {}", e))?,
        };

        let essay = VfsEssayRepo::get_round(vfs_db, session_id, round_number)
            .map_err(|e| format!("查询批改轮次失败: {}", e))?
            .ok_or_else(|| {
                format!(
                    "轮次不存在: session={}, round={}（用 essay_list_results 查看可用轮次）",
                    session_id, round_number
                )
            })?;

        let input_text = VfsEssayRepo::get_essay_content(vfs_db, &essay.id)
            .map_err(|e| format!("读取作文原文失败: {}", e))?
            .unwrap_or_default();
        let result_text = Self::extract_result_text(essay.grading_result.as_ref());

        let input_text_truncated = input_text.chars().count() > MAX_RESULT_CHARS_IN_TOOL_OUTPUT;
        let grading_result_truncated =
            result_text.chars().count() > MAX_RESULT_CHARS_IN_TOOL_OUTPUT;
        Ok(json!({
            "session_id": session_id,
            "round_id": essay.id,
            "round_number": essay.round_number,
            "input_text": truncate_chars(&input_text, MAX_RESULT_CHARS_IN_TOOL_OUTPUT),
            "inputTextTruncated": input_text_truncated,
            "grading_result": truncate_chars(&result_text, MAX_RESULT_CHARS_IN_TOOL_OUTPUT),
            "gradingResultTruncated": grading_result_truncated,
            "overall_score": Self::extract_overall_score(essay.grading_result.as_ref(), essay.score),
            "dimension_scores": essay.dimension_scores,
            "created_at": essay.created_at,
            "hint": "可将批改指出的错误点用 qbank_batch_import 入错题本，再用 review_schedule 安排复习。",
        }))
    }
}

impl Default for EssayGradingExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for EssayGradingExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let name = strip_tool_namespace(tool_name);
        matches!(
            name,
            "essay_grade"
                | "essay_grade_status"
                | "essay_grade_wait"
                | "essay_list_modes"
                | "essay_list_sessions"
                | "essay_list_results"
                | "essay_get_result"
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!("[EssayGradingExecutor] Executing tool: {}", tool_name);

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match tool_name {
            "essay_grade" => self.execute_grade(call, ctx).await,
            "essay_grade_status" => self.execute_grade_status(call, ctx).await,
            "essay_grade_wait" => self.execute_grade_wait(call, ctx).await,
            "essay_list_modes" => self.execute_list_modes(ctx).await,
            "essay_list_sessions" => self.execute_list_sessions(call, ctx).await,
            "essay_list_results" => self.execute_list_results(call, ctx).await,
            "essay_get_result" => self.execute_get_result(call, ctx).await,
            _ => Err(format!("Unknown essay tool: {}", tool_name)),
        };

        let elapsed_ms = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(value) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": value,
                    "durationMs": elapsed_ms,
                })));

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    value,
                    elapsed_ms,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[EssayGradingExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
                log::error!("[EssayGradingExecutor] Tool {} failed: {}", tool_name, e);

                ctx.emit_tool_call_error(&e);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    elapsed_ms,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[EssayGradingExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            // 发起批改：消耗 LLM 算力 + 写入批改记录
            "essay_grade" => ToolSensitivity::Medium,
            // 查询类工具
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "EssayGradingExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle() {
        let executor = EssayGradingExecutor::new();
        assert!(executor.can_handle("essay_grade"));
        assert!(executor.can_handle("builtin-essay_grade"));
        assert!(executor.can_handle("essay_grade_status"));
        assert!(executor.can_handle("essay_grade_wait"));
        assert!(executor.can_handle("essay_list_modes"));
        assert!(executor.can_handle("essay_list_sessions"));
        assert!(executor.can_handle("essay_list_results"));
        assert!(executor.can_handle("essay_get_result"));

        assert!(!executor.can_handle("essay_delete_session"));
        assert!(!executor.can_handle("qbank_list"));
        assert!(!executor.can_handle("review_get_due"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = EssayGradingExecutor::new();
        assert_eq!(
            executor.sensitivity_level("essay_grade"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-essay_grade"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("essay_grade_status"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("essay_list_sessions"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("essay_get_result"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn test_truncate_chars_preserves_short_text() {
        assert_eq!(truncate_chars("短文本", 100), "短文本");
    }

    #[test]
    fn test_truncate_chars_truncates_long_text() {
        let long_text = "很".repeat(300);
        let truncated = truncate_chars(&long_text, 100);
        assert!(truncated.starts_with(&"很".repeat(100)));
        assert!(truncated.contains("已截断"));
    }

    #[test]
    fn test_extract_result_text() {
        let grading = serde_json::json!({
            "result": "## 批改结果\n总体不错",
            "overall_score": 42.5,
        });
        assert_eq!(
            EssayGradingExecutor::extract_result_text(Some(&grading)),
            "## 批改结果\n总体不错"
        );
        assert_eq!(EssayGradingExecutor::extract_result_text(None), "");
    }

    #[test]
    fn test_extract_overall_score() {
        let grading = serde_json::json!({ "overall_score": 42.5 });
        assert_eq!(
            EssayGradingExecutor::extract_overall_score(Some(&grading), None),
            Some(42.5)
        );
        // 回退到 essays.score 字段
        assert_eq!(
            EssayGradingExecutor::extract_overall_score(None, Some(40)),
            Some(40.0)
        );
        assert_eq!(
            EssayGradingExecutor::extract_overall_score(None, None),
            None
        );
    }

    #[test]
    fn test_read_bounded_u32() {
        let args = serde_json::json!({ "limit": 500, "offset": -3 });
        assert_eq!(
            EssayGradingExecutor::read_bounded_u32(&args, "limit", 20, 1, 100),
            100
        );
        assert_eq!(
            EssayGradingExecutor::read_bounded_u32(&args, "offset", 0, 0, u32::MAX),
            0
        );
        assert_eq!(
            EssayGradingExecutor::read_bounded_u32(&args, "missing", 20, 1, 100),
            20
        );
    }

    #[test]
    fn test_load_custom_modes_from_active_database_directory() {
        let temp_dir = tempfile::tempdir().expect("create temp data directory");
        let data_dir = temp_dir.path().to_path_buf();
        let database = crate::database::Database::new(&data_dir.join("mistakes.db"))
            .expect("create active main database");
        let manager = CustomModeManager::new(&data_dir);
        let created = manager
            .create_mode(crate::essay_grading::custom_modes::CreateModeInput {
                name: "Agent 真实模式".to_string(),
                description: "从应用数据目录加载".to_string(),
                system_prompt: "Use this exact rubric".to_string(),
                score_dimensions: vec![crate::essay_grading::types::ScoreDimension {
                    name: "内容".to_string(),
                    max_score: 10.0,
                    description: None,
                }],
                total_max_score: 10.0,
            })
            .expect("persist custom grading mode");

        let loaded = EssayGradingExecutor::load_custom_modes_from_database(Some(&database));
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, created.id);
        assert_eq!(loaded[0].system_prompt, "Use this exact rubric");
    }

    #[test]
    fn test_merge_modes_includes_custom_and_preserves_builtin_override_semantics() {
        let builtin = get_builtin_grading_modes()
            .into_iter()
            .next()
            .expect("at least one builtin grading mode");
        let custom_only = GradingMode {
            id: "custom_agent_mode".to_string(),
            name: "Agent 自定义模式".to_string(),
            description: "测试模式".to_string(),
            system_prompt: "Grade carefully".to_string(),
            score_dimensions: builtin.score_dimensions.clone(),
            total_max_score: builtin.total_max_score,
            is_builtin: false,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        };
        let overridden = GradingMode {
            id: builtin.id.clone(),
            name: "覆盖后的内置模式".to_string(),
            description: "覆盖".to_string(),
            system_prompt: "Use the custom rubric".to_string(),
            score_dimensions: builtin.score_dimensions.clone(),
            total_max_score: builtin.total_max_score,
            is_builtin: false,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        };

        let merged = EssayGradingExecutor::merge_modes(vec![custom_only.clone(), overridden]);
        let override_result = merged
            .iter()
            .find(|mode| mode.id == builtin.id)
            .expect("overridden builtin remains listed");
        assert_eq!(override_result.name, "覆盖后的内置模式");
        assert!(override_result.is_builtin);
        assert!(merged.iter().any(|mode| mode.id == custom_only.id));
        assert_eq!(
            merged.iter().filter(|mode| mode.id == builtin.id).count(),
            1
        );
    }

    #[test]
    fn test_mode_validation_is_immediate_and_preserves_structured_error() {
        let invalid = EssayGradingExecutor::canonicalize_requested_mode_id(
            Some("missing-rubric".to_string()),
            &[],
        )
        .expect_err("unknown mode must be rejected before starting a task");
        let error: Value = serde_json::from_str(&invalid).expect("structured AppError JSON");
        assert_eq!(error["error_type"], "Validation");
        assert_eq!(error["details"]["code"], "ESSAY_MODE_NOT_FOUND");

        assert_eq!(
            EssayGradingExecutor::canonicalize_requested_mode_id(
                Some("ielts_task2".to_string()),
                &[],
            )
            .expect("known alias should resolve"),
            Some("ielts".to_string())
        );
        assert_eq!(
            EssayGradingExecutor::canonicalize_requested_mode_id(None, &[])
                .expect("omitting mode keeps the documented default behavior"),
            None
        );
    }

    #[tokio::test]
    async fn test_essay_task_registry_roundtrip() {
        let task_id = "essaytask_test_registry";
        {
            let mut tasks = ESSAY_TASKS.lock().await;
            tasks.insert(
                task_id.to_string(),
                EssayTaskState {
                    session_id: "essay_session_1".to_string(),
                    round_number: 1,
                    status: "running".to_string(),
                    round_id: None,
                    overall_score: None,
                    error: None,
                    started_at_ms: 0,
                    finished_at_ms: None,
                },
            );
        }
        {
            let mut tasks = ESSAY_TASKS.lock().await;
            let state = tasks.get_mut(task_id).expect("task should exist");
            state.status = "completed".to_string();
            state.overall_score = Some(45.0);
        }
        {
            let tasks = ESSAY_TASKS.lock().await;
            let state = tasks.get(task_id).expect("task should exist");
            assert_eq!(state.status, "completed");
            assert_eq!(state.overall_score, Some(45.0));
        }
        // 清理，避免污染其他测试
        ESSAY_TASKS.lock().await.remove(task_id);
    }
}
