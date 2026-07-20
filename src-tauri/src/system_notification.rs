//! 统一系统通知策略（Rust 侧）。
//!
//! 与前端 `src/utils/systemNotification.ts` 的三档策略共用同一持久化键
//! （settings 表 `system-notification-policy`，设置页写入并在启动时对齐）：
//! - `background`（默认）：仅应用在后台时发系统通知；
//! - `always`：总是发；
//! - `never`：从不发。
//!
//! Rust 侧的发送场景（自动化运行通知、紧急停止、后台驻留提示）要么本身
//! 发生在后台语义下，要么属于用户主动订阅/告警类（force 语义），因此这里
//! 只需提供策略读取与 `never` 档的全局拦截；「background 档的前台抑制」由
//! 各调用点已有的窗口活跃检查承担（见 automations.rs 的
//! `main_window_is_active` 抑制逻辑）。

use crate::database::Database;

/// 与前端 localStorage / settings 表共用的策略键。
pub const POLICY_SETTING_KEY: &str = "system-notification-policy";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SystemNotificationPolicy {
    Background,
    Always,
    Never,
}

/// 解析策略原始值；非法/缺失回退默认档（background），与前端一致。
pub fn policy_from_raw(raw: Option<&str>) -> SystemNotificationPolicy {
    match raw {
        Some("always") => SystemNotificationPolicy::Always,
        Some("never") => SystemNotificationPolicy::Never,
        _ => SystemNotificationPolicy::Background,
    }
}

/// 读取当前策略；设置缺失/读取失败按默认档处理。
pub fn current_policy(db: &Database) -> SystemNotificationPolicy {
    policy_from_raw(db.get_setting(POLICY_SETTING_KEY).ok().flatten().as_deref())
}

/// 系统通知是否被用户全局关闭（never 档）。
pub fn notifications_disabled(db: &Database) -> bool {
    current_policy(db) == SystemNotificationPolicy::Never
}

/// `AppHandle` 版本：从全局 AppState 取主数据库读策略。
/// 状态未就绪（启动极早期）时按默认档处理，不拦截。
pub fn notifications_disabled_for_app(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    app.try_state::<crate::commands::AppState>()
        .map(|state| notifications_disabled(&state.database))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_policy_with_background_default() {
        assert_eq!(
            policy_from_raw(Some("always")),
            SystemNotificationPolicy::Always
        );
        assert_eq!(
            policy_from_raw(Some("never")),
            SystemNotificationPolicy::Never
        );
        assert_eq!(
            policy_from_raw(Some("background")),
            SystemNotificationPolicy::Background
        );
        // 非法值与缺失都回退默认档
        assert_eq!(
            policy_from_raw(Some("sometimes")),
            SystemNotificationPolicy::Background
        );
        assert_eq!(policy_from_raw(None), SystemNotificationPolicy::Background);
    }
}
