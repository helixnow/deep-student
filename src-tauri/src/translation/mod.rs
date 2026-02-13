/// 翻译模块 - 独立流式管线
///
/// 职责：
/// - 提供流式翻译命令
/// - 管理翻译会话状态
/// - 发送 SSE 事件到前端
///
/// 与 unified_chat 的关系：
/// - 完全独立的管线，不依赖 unified_chat 的类型或逻辑
/// - 仅复用 LLMManager 的底层能力
pub mod events;
pub mod pipeline;
pub mod types;

use tauri::{State, Window};

use crate::models::AppError;
use events::TranslationEventEmitter;
use types::{TranslationRequest, TranslationResponse};

/// 流式翻译命令
///
/// # 参数
/// - `request`: 翻译请求（包含源文本、语言对、提示词等）
/// - `window`: Tauri 窗口句柄（用于发送 SSE 事件）
/// - `state`: 应用状态（访问 LLMManager、Database 等）
///
/// # 事件流
/// 1. `translation_stream_data`: 增量译文片段
/// 2. `translation_stream_complete`: 翻译完成（含完整译文和 ID）
/// 3. `translation_stream_error`: 错误信息
#[tauri::command]
pub async fn translate_text_stream(
    request: TranslationRequest,
    window: Window,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<TranslationResponse>, AppError> {
    println!(
        "🌐 [Translation] 开始流式翻译：{} -> {}, 文本长度：{}",
        request.src_lang,
        request.tgt_lang,
        request.text.len()
    );

    // 获取 VFS 数据库（必需）
    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::database("VFS 数据库未初始化".to_string()))?;

    // 构造依赖
    let deps = pipeline::TranslationDeps {
        llm: state.llm_manager.clone(),
        db: state.database.clone(), // 仅用于迁移期读取旧数据
        emitter: TranslationEventEmitter::new(window.clone()),
        vfs_db, // ★ VFS 统一存储（必需）
    };

    // 运行翻译管线
    let result = pipeline::run_translation(request.clone(), deps).await?;

    if let Some(ref response) = result {
        println!(
            "✅ [Translation] 翻译完成：ID={}, 译文长度：{}",
            response.id,
            response.translated_text.len()
        );
    } else {
        println!(
            "🛑 [Translation] 用户取消翻译：session_id={}",
            request.session_id
        );
    }

    Ok(result)
}
