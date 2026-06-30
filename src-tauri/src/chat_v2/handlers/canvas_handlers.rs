//! Canvas 工具处理器
//!
//! 处理 Canvas 笔记工具的前端回调，用于完全前端模式的编辑操作。
//!
//! ## 完全前端模式
//! 1. 后端发送 `canvas:ai-edit-request` 事件到前端
//! 2. 前端编辑器执行编辑操作
//! 3. 前端调用此命令返回编辑结果
//! 4. 后端恢复工具执行流程

use crate::chat_v2::tools::canvas_executor::{
    handle_edit_ack, handle_edit_result, CanvasAIEditResult,
};

/// 处理前端返回的 Canvas 编辑结果
///
/// 前端在执行完 AI 编辑请求后，调用此命令返回结果。
/// 后端通过 request_id 匹配等待的回调，恢复工具执行流程。
#[tauri::command]
pub fn chat_v2_canvas_edit_result(result: CanvasAIEditResult) -> Result<(), String> {
    log::debug!(
        "[canvas_handlers] Received edit result: request_id={}, success={}",
        result.request_id,
        result.success
    );

    handle_edit_result(result);
    Ok(())
}

/// ★ R2：处理前端的编辑请求认领（ACK）
///
/// 持有目标笔记的编辑器实例收到 `canvas:ai-edit-request` 后立即调用此命令，
/// 告知后端"请求已被认领"。后端在 ACK 超时内未收到认领则快速失败
/// （笔记未打开），避免非目标实例抢答消费回调。
#[tauri::command]
pub fn chat_v2_canvas_edit_ack(request_id: String) -> Result<(), String> {
    log::debug!(
        "[canvas_handlers] Received edit ack: request_id={}",
        request_id
    );

    handle_edit_ack(&request_id);
    Ok(())
}
