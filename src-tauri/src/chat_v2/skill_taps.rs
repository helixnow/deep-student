//! Tap 式技能源（app 门面）。
//!
//! 实现在 dstu-agent 的 `chat_v2::skill_taps`，这里按原路径重导出。
//! 唯一例外是 Tauri 命令 `skill_export_tap`：它要从 `AppState.file_manager`
//! 取应用私有暂存目录（FileManager 未单独托管，crate 不得引用 AppState），
//! 因此命令薄包装留在 app，路径（`crate::chat_v2::skill_taps::skill_export_tap`）
//! 与签名均不变，逻辑交给 `skill_export_tap_with_staging_dir`。

pub use dstu_agent::chat_v2::skill_taps::*;

use tauri::State;

use crate::commands::AppState;

/// 把已安装的用户技能导出为 tap 结构 zip（见
/// `dstu_agent::chat_v2::skill_taps::skill_export_tap_with_staging_dir`）。
#[tauri::command]
pub async fn skill_export_tap(
    window: tauri::Window,
    state: State<'_, AppState>,
    skill_ids: Vec<String>,
    dest_path: String,
) -> Result<TapExportResult, String> {
    let staging_dir = state
        .file_manager
        .get_writable_app_data_dir()
        .join("temp_skill_tap_export");
    skill_export_tap_with_staging_dir(window, staging_dir, skill_ids, dest_path).await
}
