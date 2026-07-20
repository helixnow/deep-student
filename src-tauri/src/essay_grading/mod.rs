/// 作文批改模块 - 独立流式管线
///
/// 职责：
/// - 提供流式批改命令
/// - 管理批改会话和轮次
/// - 发送 SSE 事件到前端
/// - 管理自定义批阅模式（JSON 存储）
///
/// 与 unified_chat 的关系：
/// - 完全独立的管线，不依赖 unified_chat 的类型或逻辑
/// - 仅复用 LLMManager 的底层能力
/// - ★ 使用 VFS 统一存储（2025-12-07）
pub mod custom_modes;
pub mod events;
pub mod pipeline;
pub mod text_stats;
pub mod types;

use tauri::{State, Window};

use crate::models::AppError;
use crate::vfs::error::VfsError;
use crate::vfs::repos::VfsEssayRepo;
use crate::vfs::types::{
    VfsCreateEssaySessionParams, VfsEssay, VfsEssaySession, VfsUpdateEssaySessionParams,
};
use events::GradingEventEmitter;
use types::{GradingRequest, GradingResponse, GradingRoundResponse};

/// list_sessions 单页上限（防止异常大的 limit 拖垮查询）
const MAX_LIST_LIMIT: u32 = 500;

/// 获取 VFS 数据库句柄（统一"未初始化"错误）
fn get_vfs_db<'a>(
    state: &'a State<'_, crate::commands::AppState>,
) -> Result<&'a std::sync::Arc<crate::vfs::database::VfsDatabase>, AppError> {
    state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::database("VFS 数据库未初始化"))
}

/// 获取自定义模式管理器（统一"未初始化"错误）
fn get_mode_manager<'a>(
    state: &'a State<'_, crate::commands::AppState>,
) -> Result<&'a custom_modes::CustomModeManager, AppError> {
    state
        .custom_mode_manager
        .as_ref()
        .ok_or_else(|| AppError::internal("自定义模式管理器未初始化"))
}

/// 将 VfsError 映射为 AppError，附带操作上下文；NotFound 不再吞成笼统的 Database 错误
fn map_vfs_err(context: impl AsRef<str>, e: VfsError) -> AppError {
    let msg = format!("{}: {}", context.as_ref(), e);
    match e {
        VfsError::NotFound { .. } | VfsError::ItemNotFound { .. } => AppError::not_found(msg),
        VfsError::InvalidArgument { .. } => AppError::validation(msg),
        _ => AppError::database(msg),
    }
}

/// 校验 session_id 非空
fn ensure_session_id(session_id: &str) -> Result<(), AppError> {
    if session_id.trim().is_empty() {
        return Err(AppError::validation("session_id 不能为空"));
    }
    Ok(())
}

/// 会话是否命中搜索词（大小写不敏感的包含匹配；needle 需已小写化）
fn session_matches_query(session: &VfsEssaySession, needle_lower: &str) -> bool {
    let field_matches =
        |field: Option<&str>| field.is_some_and(|f| f.to_lowercase().contains(needle_lower));
    field_matches(Some(&session.title))
        || field_matches(session.essay_type.as_deref())
        || field_matches(session.grade_level.as_deref())
}

/// 将 VfsEssay 组装为轮次响应（补齐 input_text、提取批改结果/分数）
fn round_response_from_essay(
    vfs_db: &crate::vfs::database::VfsDatabase,
    essay: VfsEssay,
) -> Result<GradingRoundResponse, AppError> {
    let input_text = VfsEssayRepo::get_essay_content(vfs_db, &essay.id)
        .map_err(|e| map_vfs_err(format!("获取作文内容失败 (essay_id={})", essay.id), e))?
        .unwrap_or_default();

    // 从 grading_result JSON 提取批改文本
    let grading_result = essay
        .grading_result
        .as_ref()
        .and_then(|v| v.get("result"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // 提取 overall_score，缺失时回退到 score 字段
    let overall_score = essay
        .grading_result
        .as_ref()
        .and_then(|v| v.get("overall_score"))
        .and_then(|v| v.as_f64())
        .map(|v| v as f32)
        .or_else(|| essay.score.map(|s| s as f32));

    let dimension_scores_json = essay
        .dimension_scores
        .as_ref()
        .and_then(|v| serde_json::to_string(v).ok());

    Ok(GradingRoundResponse {
        id: essay.id,
        session_id: essay.session_id.unwrap_or_default(),
        round_number: essay.round_number,
        input_text,
        grading_result,
        overall_score,
        dimension_scores_json,
        created_at: essay.created_at,
    })
}

/// 流式批改命令
#[tauri::command]
pub async fn essay_grading_stream(
    request: GradingRequest,
    window: Window,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<GradingResponse>, AppError> {
    ensure_session_id(&request.session_id)?;

    println!(
        "📝 [EssayGrading] 开始流式批改：session={}, round={}, 文本长度={}",
        request.session_id,
        request.round_number,
        request.input_text.chars().count()
    );

    let vfs_db = get_vfs_db(&state)?;

    let custom_modes = state
        .custom_mode_manager
        .as_ref()
        .map(|manager| manager.list_modes())
        .unwrap_or_default();
    let deps = pipeline::GradingDeps {
        llm: state.llm_manager.clone(),
        vfs_db: vfs_db.clone(),
        emitter: GradingEventEmitter::new(window),
        custom_modes,
    };

    let result = pipeline::run_grading(request.clone(), deps).await?;

    if let Some(ref response) = result {
        println!(
            "✅ [EssayGrading] 批改完成：round_id={}, 结果长度={}",
            response.round_id,
            response.grading_result.len()
        );
    } else {
        println!(
            "🛑 [EssayGrading] 用户取消批改：session={}",
            request.session_id
        );
    }

    Ok(result)
}

/// 创建新会话
#[tauri::command]
pub async fn essay_grading_create_session(
    title: String,
    essay_type: String,
    grade_level: String,
    custom_prompt: Option<String>,
    state: State<'_, crate::commands::AppState>,
) -> Result<VfsEssaySession, AppError> {
    let vfs_db = get_vfs_db(&state)?;
    let params = VfsCreateEssaySessionParams {
        title,
        essay_type: Some(essay_type),
        grade_level: Some(grade_level),
        custom_prompt,
    };

    let session = VfsEssayRepo::create_session(vfs_db, params)
        .map_err(|e| map_vfs_err("创建作文会话失败", e))?;

    println!("📝 [EssayGrading] 创建会话：{}", session.id);

    Ok(session)
}

/// 获取会话详情
#[tauri::command]
pub async fn essay_grading_get_session(
    session_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<VfsEssaySession>, AppError> {
    ensure_session_id(&session_id)?;
    let vfs_db = get_vfs_db(&state)?;

    VfsEssayRepo::get_session(vfs_db, &session_id)
        .map_err(|e| map_vfs_err(format!("获取作文会话失败 (session_id={})", session_id), e))
}

/// 更新会话
///
/// ★ M-061 修复：接收 VfsUpdateEssaySessionParams（仅可变字段），
///   而非完整 VfsEssaySession，确保前后端参数契约一致。
#[tauri::command]
pub async fn essay_grading_update_session(
    session: VfsUpdateEssaySessionParams,
    state: State<'_, crate::commands::AppState>,
) -> Result<(), AppError> {
    ensure_session_id(&session.id)?;
    let vfs_db = get_vfs_db(&state)?;

    VfsEssayRepo::update_session(
        vfs_db,
        &session.id,
        session.title.as_deref(),
        session.is_favorite,
        session.essay_type.as_deref(),
        session.grade_level.as_deref(),
        session.custom_prompt.as_deref(),
    )
    .map_err(|e| map_vfs_err(format!("更新作文会话失败 (session_id={})", session.id), e))
}

/// 永久删除会话
///
/// ★ 2025-12-11: 统一命名规范，使用 purge 表示永久删除
#[tauri::command]
pub async fn essay_grading_delete_session(
    session_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<usize, AppError> {
    ensure_session_id(&session_id)?;
    let vfs_db = get_vfs_db(&state)?;

    // ★ 2025-12-11: 使用 purge_session 永久删除（会话没有软删除机制）
    let deleted = VfsEssayRepo::purge_session(vfs_db, &session_id)
        .map_err(|e| map_vfs_err(format!("删除作文会话失败 (session_id={})", session_id), e))?;

    println!("🗑️ [EssayGrading] 永久删除会话：{}", session_id);

    Ok(deleted)
}

/// 获取会话列表
///
/// query 非空时做大小写不敏感的包含匹配（title / essay_type / grade_level）。
/// repo 层的 list_sessions 在 SQL 中做 LIMIT/OFFSET 分页，因此搜索路径改为
/// 在命令层全量拉取（按 updated_at DESC）后先过滤、再应用 offset/limit，
/// 保证分页发生在过滤之后。
#[tauri::command]
pub async fn essay_grading_list_sessions(
    offset: Option<u32>,
    limit: Option<u32>,
    query: Option<String>,
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<VfsEssaySession>, AppError> {
    let vfs_db = get_vfs_db(&state)?;
    let limit = limit.unwrap_or(20).min(MAX_LIST_LIMIT);
    let offset = offset.unwrap_or(0);

    let needle_lower = query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(str::to_lowercase);

    match needle_lower {
        None => VfsEssayRepo::list_sessions(vfs_db, limit, offset)
            .map_err(|e| map_vfs_err("获取作文会话列表失败", e)),
        Some(needle) => {
            // 全量拉取后过滤（repo 无搜索接口；会话表规模有限，可接受）
            let all = VfsEssayRepo::list_sessions(vfs_db, u32::MAX, 0)
                .map_err(|e| map_vfs_err(format!("搜索作文会话失败 (query={})", needle), e))?;
            Ok(all
                .into_iter()
                .filter(|s| session_matches_query(s, &needle))
                .skip(offset as usize)
                .take(limit as usize)
                .collect())
        }
    }
}

/// 切换收藏状态
#[tauri::command]
pub async fn essay_grading_toggle_favorite(
    session_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<bool, AppError> {
    ensure_session_id(&session_id)?;
    let vfs_db = get_vfs_db(&state)?;

    VfsEssayRepo::toggle_session_favorite(vfs_db, &session_id)
        .map_err(|e| map_vfs_err(format!("切换收藏状态失败 (session_id={})", session_id), e))
}

/// 获取会话的所有轮次（含内容）
///
/// ★ 2025-01-01: 返回完整的轮次数据，包含 input_text 和解析后的 grading_result
#[tauri::command]
pub async fn essay_grading_get_rounds(
    session_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<GradingRoundResponse>, AppError> {
    ensure_session_id(&session_id)?;
    let vfs_db = get_vfs_db(&state)?;

    let essays = VfsEssayRepo::get_rounds_by_session(vfs_db, &session_id)
        .map_err(|e| map_vfs_err(format!("获取批改轮次失败 (session_id={})", session_id), e))?;

    let mut rounds = Vec::with_capacity(essays.len());
    for essay in essays {
        rounds.push(round_response_from_essay(vfs_db, essay)?);
    }

    Ok(rounds)
}

/// 获取指定轮次（含内容）
///
/// ★ 2025-01-01: 返回完整的轮次数据
#[tauri::command]
pub async fn essay_grading_get_round(
    session_id: String,
    round_number: i32,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<GradingRoundResponse>, AppError> {
    ensure_session_id(&session_id)?;
    if round_number < 1 {
        return Err(AppError::validation(format!(
            "round_number 必须 >= 1 (收到 {})",
            round_number
        )));
    }
    let vfs_db = get_vfs_db(&state)?;

    let essay = VfsEssayRepo::get_round(vfs_db, &session_id, round_number)
        .map_err(|e| {
            map_vfs_err(
                format!(
                    "获取批改轮次失败 (session_id={}, round={})",
                    session_id, round_number
                ),
                e,
            )
        })?;

    essay
        .map(|essay| round_response_from_essay(vfs_db, essay))
        .transpose()
}

/// 获取最新轮次号
#[tauri::command]
pub async fn essay_grading_get_latest_round_number(
    session_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<i32, AppError> {
    ensure_session_id(&session_id)?;
    let vfs_db = get_vfs_db(&state)?;

    VfsEssayRepo::get_latest_round_number(vfs_db, &session_id)
        .map_err(|e| map_vfs_err(format!("获取最新轮次号失败 (session_id={})", session_id), e))
}

/// 获取所有批阅模式（内置 + 自定义，自定义覆盖优先）
#[tauri::command]
pub async fn essay_grading_get_modes(
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<types::GradingMode>, AppError> {
    let builtin_modes = types::get_builtin_grading_modes();

    if let Some(ref manager) = state.custom_mode_manager {
        let custom_modes = manager.list_modes();

        // 构建最终列表：自定义覆盖 + 未覆盖的内置模式 + 纯自定义模式
        let mut result: Vec<types::GradingMode> = Vec::new();

        // 1. 遍历内置模式，如有覆盖则用覆盖版本
        for builtin in builtin_modes {
            if let Some(custom) = custom_modes.iter().find(|c| c.id == builtin.id) {
                // 使用自定义覆盖，但标记为 is_builtin=true 以便前端识别
                let mut override_mode = custom.clone();
                override_mode.is_builtin = true; // 保持预置标记
                result.push(override_mode);
            } else {
                result.push(builtin);
            }
        }

        // 2. 添加纯自定义模式（ID 不是预置 ID）
        let builtin_ids: std::collections::HashSet<_> = types::get_builtin_grading_modes()
            .iter()
            .map(|m| m.id.clone())
            .collect();
        for custom in custom_modes {
            if !builtin_ids.contains(&custom.id) {
                result.push(custom);
            }
        }

        Ok(result)
    } else {
        Ok(builtin_modes)
    }
}

/// 获取指定批阅模式（自定义覆盖优先）
#[tauri::command]
pub async fn essay_grading_get_mode(
    mode_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<types::GradingMode>, AppError> {
    let canonical_mode_id = types::canonical_mode_id(&mode_id).to_string();

    // 先检查自定义覆盖
    if let Some(ref manager) = state.custom_mode_manager {
        if let Some(custom) = manager.get_mode(&canonical_mode_id) {
            // 检查是否是预置模式的覆盖
            let is_builtin_override = types::get_builtin_grading_modes()
                .iter()
                .any(|m| m.id == canonical_mode_id);

            let mut mode = custom;
            if is_builtin_override {
                mode.is_builtin = true; // 保持预置标记
            }
            return Ok(Some(mode));
        }
    }

    // 再在内置模式中查找
    let builtin_modes = types::get_builtin_grading_modes();
    if let Some(mode) = builtin_modes
        .into_iter()
        .find(|m| m.id == canonical_mode_id)
    {
        return Ok(Some(mode));
    }

    Ok(None)
}

// ============================================================================
// 自定义批阅模式 CRUD
// ============================================================================

/// 创建自定义批阅模式
#[tauri::command]
pub async fn essay_grading_create_custom_mode(
    input: custom_modes::CreateModeInput,
    state: State<'_, crate::commands::AppState>,
) -> Result<types::GradingMode, AppError> {
    let manager = get_mode_manager(&state)?;

    manager
        .create_mode(input)
        .map_err(|e| AppError::internal(format!("创建自定义批阅模式失败: {}", e)))
}

/// 更新自定义批阅模式
#[tauri::command]
pub async fn essay_grading_update_custom_mode(
    input: custom_modes::UpdateModeInput,
    state: State<'_, crate::commands::AppState>,
) -> Result<types::GradingMode, AppError> {
    let mode_id = input.id.clone();
    let manager = get_mode_manager(&state)?;

    manager
        .update_mode(input)
        .map_err(|e| AppError::internal(format!("更新自定义批阅模式失败 (mode_id={}): {}", mode_id, e)))
}

/// 删除自定义批阅模式
#[tauri::command]
pub async fn essay_grading_delete_custom_mode(
    mode_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<(), AppError> {
    let manager = get_mode_manager(&state)?;

    manager
        .delete_mode(&mode_id)
        .map_err(|e| AppError::internal(format!("删除自定义批阅模式失败 (mode_id={}): {}", mode_id, e)))
}

/// 获取所有自定义批阅模式
#[tauri::command]
pub async fn essay_grading_list_custom_modes(
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<types::GradingMode>, AppError> {
    let manager = get_mode_manager(&state)?;

    Ok(manager.list_modes())
}

/// 保存预置模式的自定义覆盖
#[tauri::command]
pub async fn essay_grading_save_builtin_override(
    input: custom_modes::SaveBuiltinOverrideInput,
    state: State<'_, crate::commands::AppState>,
) -> Result<types::GradingMode, AppError> {
    let builtin_id = input.builtin_id.clone();
    let manager = get_mode_manager(&state)?;

    let mut mode = manager.save_builtin_override(input).map_err(|e| {
        AppError::internal(format!(
            "保存预置模式覆盖失败 (builtin_id={}): {}",
            builtin_id, e
        ))
    })?;

    // 返回时保持 is_builtin 标记
    mode.is_builtin = true;
    Ok(mode)
}

/// 重置预置模式为默认配置
#[tauri::command]
pub async fn essay_grading_reset_builtin_mode(
    builtin_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<types::GradingMode, AppError> {
    let manager = get_mode_manager(&state)?;

    manager.reset_builtin_mode(&builtin_id).map_err(|e| {
        AppError::internal(format!(
            "重置预置模式失败 (builtin_id={}): {}",
            builtin_id, e
        ))
    })?;

    // 返回原始预置模式
    types::get_builtin_grading_modes()
        .into_iter()
        .find(|m| m.id == builtin_id)
        .ok_or_else(|| AppError::not_found(format!("预置模式不存在: {}", builtin_id)))
}

/// 检查预置模式是否有自定义覆盖
#[tauri::command]
pub async fn essay_grading_has_builtin_override(
    builtin_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<bool, AppError> {
    let manager = get_mode_manager(&state)?;

    Ok(manager.has_builtin_override(&builtin_id))
}

/// 模型简要信息（用于下拉选择）
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub model: String,
    pub is_default: bool,
}

/// 获取可用于作文批改的模型列表
///
/// 过滤逻辑与 Chat V2 保持一致：
/// - 排除嵌入模型 (is_embedding)
/// - 排除重排序模型 (is_reranker)
/// - 排除未启用的模型 (enabled = false，包括没有 API Key 的模型)
#[tauri::command]
pub async fn essay_grading_get_models(
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<Vec<ModelInfo>, AppError> {
    let configs = state.llm_manager.get_api_configs().await?;
    let assignments = state.llm_manager.get_model_assignments().await?;

    // 获取默认模型 ID（Model2）
    let default_model_id = assignments.model2_config_id.clone();

    let models: Vec<ModelInfo> = configs
        .into_iter()
        // 与 Chat V2 前端过滤逻辑一致：排除嵌入模型、重排序模型、未启用的模型
        .filter(|c| c.enabled && !c.is_embedding && !c.is_reranker)
        .map(|c| ModelInfo {
            id: c.id.clone(),
            name: c.name.clone(),
            model: c.model.clone(),
            is_default: Some(c.id.clone()) == default_model_id,
        })
        .collect();

    Ok(models)
}
