//! Browser 数据库 DTO（持久化层）
//!
//! 控制态（controlMode / loading / CDP 句柄）仅内存，不在此定义。

use serde::{Deserialize, Serialize};

/// 浏览器会话行（`sessions`）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionRow {
    pub id: String,
    pub profile_id: String,
    pub title: Option<String>,
    pub current_url: Option<String>,
    pub favicon_url: Option<String>,
    pub user_agent_override: Option<String>,
    /// 导航栈当前位置（`history.seq`）；`-1` 表示空栈
    pub history_index: i64,
    pub is_active: bool,
    pub last_focused_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
}

/// 写入 / upsert 会话时的字段（未提供的可选字段在 update 时保留原值）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionUpsert {
    pub id: String,
    pub profile_id: Option<String>,
    pub title: Option<String>,
    pub current_url: Option<String>,
    pub favicon_url: Option<String>,
    pub user_agent_override: Option<String>,
    pub history_index: Option<i64>,
    /// 默认 `true`：upsert 后设为唯一活跃会话
    pub is_active: Option<bool>,
    pub last_focused_at: Option<String>,
}

/// 历史访问行（`history`）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHistoryRow {
    pub id: String,
    pub session_id: Option<String>,
    pub url: String,
    pub title: Option<String>,
    pub seq: Option<i64>,
    pub visit_count: i64,
    pub typed_count: i64,
    pub last_visit_at: String,
    pub first_visit_at: String,
    pub transition: Option<String>,
    pub hidden: bool,
}

/// 压入导航栈的条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHistoryPush {
    pub url: String,
    pub title: Option<String>,
    pub transition: Option<String>,
    /// 是否计为地址栏输入（累加 `typed_count`）
    pub typed: bool,
}

/// 站点权限行（`site_permissions`）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SitePermissionRow {
    pub id: String,
    pub origin: String,
    pub permission: String,
    pub decision: String,
    pub scope: String,
    pub source: String,
    pub expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// upsert 站点权限
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePermissionUpsert {
    pub origin: String,
    pub permission: String,
    pub decision: String,
    pub scope: Option<String>,
    pub source: Option<String>,
    pub expires_at: Option<String>,
}

/// 设置 KV 行（`settings`）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSettingRow {
    pub key: String,
    pub value: String,
    pub updated_at: String,
}

/// 下载元数据行（`downloads`）——一期表已建，UI 可二期再接
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownloadRow {
    pub id: String,
    pub session_id: Option<String>,
    pub url: String,
    pub referrer: Option<String>,
    pub filename: String,
    pub mime_type: Option<String>,
    pub total_bytes: Option<i64>,
    pub received_bytes: Option<i64>,
    pub local_path: Option<String>,
    pub state: String,
    pub error_message: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub deleted_at: Option<String>,
}
