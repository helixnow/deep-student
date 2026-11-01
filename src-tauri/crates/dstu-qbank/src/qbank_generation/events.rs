//! 题目集 AI 出题 - 任务事件发射器（全局）
//!
//! 2026-09-09 后台化改造：出题任务在后台执行，事件出口从「窗口级 SSE 流」
//! 改为「全局任务事件」（`AppHandle::emit`），前端壳层常驻监听 + 轮询兜底。
//! 窗口销毁不再影响任务与事件投递（旧实现 `Window::emit` 在窗口销毁后静默失败）。

use tauri::{AppHandle, Emitter};

use super::task_repo::GenerationTaskView;

/// 全局任务事件名（前端 `src/hooks/useQbankGenerationTasks.ts` 监听）
pub const QBANK_GENERATION_TASK_EVENT: &str = "qbank_generation_task_event";

/// 发送任务状态事件（发送失败只记日志，不影响任务本身）
pub fn emit_task_event(app: &AppHandle, task: &GenerationTaskView) {
    if let Err(e) = app.emit(QBANK_GENERATION_TASK_EVENT, task) {
        log::error!(
            "[QbankGeneration] 发送任务事件失败: task_id={}, status={:?}, error={}",
            task.id,
            task.status,
            e
        );
    }
}
