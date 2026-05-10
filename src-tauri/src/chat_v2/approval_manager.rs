//! 工具审批管理器
//!
//! 管理敏感工具的用户审批流程，使用 oneshot channel 实现异步等待。
//!
//! ## 设计文档
//! 参考：`src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md` 第 4 节
//!
//! ## 流程
//! 1. Pipeline 检测到敏感工具 → 调用 `register()` 获取 Receiver
//! 2. 发射 `tool_approval_request` 事件到前端
//! 3. Pipeline `select!` 等待 Receiver 或超时
//! 4. 前端调用 Tauri 命令 → `respond()` 发送到 Sender
//! 5. Pipeline 收到响应，继续执行或跳过

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use super::approval_scope;

// ============================================================================
// 审批请求/响应数据结构
// ============================================================================

/// 审批请求（发送到前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// 会话 ID
    pub session_id: String,
    /// 工具调用 ID
    pub tool_call_id: String,
    /// 工具名称
    pub tool_name: String,
    /// 工具参数
    pub arguments: Value,
    /// 敏感等级
    pub sensitivity: String,
    /// 人类可读描述
    pub description: String,
    /// 超时时间（秒）
    pub timeout_seconds: u32,
}

/// 审批响应（从前端接收）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResponse {
    /// 会话 ID
    pub session_id: String,
    /// 工具调用 ID
    pub tool_call_id: String,
    /// 工具名称（用于"记住选择"功能）
    pub tool_name: String,
    /// 是否批准
    pub approved: bool,
    /// 拒绝原因
    pub reason: Option<String>,
    /// 是否记住选择
    pub remember: bool,
}

impl ApprovalResponse {
    /// 创建批准响应
    pub fn approved(session_id: String, tool_call_id: String, tool_name: String) -> Self {
        Self {
            session_id,
            tool_call_id,
            tool_name,
            approved: true,
            reason: None,
            remember: false,
        }
    }

    /// 创建拒绝响应
    pub fn rejected(
        session_id: String,
        tool_call_id: String,
        tool_name: String,
        reason: Option<String>,
    ) -> Self {
        Self {
            session_id,
            tool_call_id,
            tool_name,
            approved: false,
            reason,
            remember: false,
        }
    }

    /// 创建超时响应
    pub fn timeout(session_id: String, tool_call_id: String, tool_name: String) -> Self {
        Self {
            session_id,
            tool_call_id,
            tool_name,
            approved: false,
            reason: Some("审批超时".to_string()),
            remember: false,
        }
    }
}

// ============================================================================
// 审批管理器
// ============================================================================

/// 审批管理器
///
/// 管理待审批的工具调用，使用 oneshot channel 实现异步等待。
pub struct ApprovalManager {
    /// 待审批的工具调用 Map<tool_call_id, Sender>
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalResponse>>>>,
    /// 待审批工具调用对应的作用域 key（用于 remember 参数隔离）
    pending_scope_keys: Arc<Mutex<HashMap<String, String>>>,
    /// 默认超时时间（秒）
    default_timeout: u32,
    /// 记住的审批选择 Map<scope_key, approved>
    remembered: Arc<Mutex<HashMap<String, bool>>>,
}

impl ApprovalManager {
    /// 创建新的审批管理器
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            pending_scope_keys: Arc::new(Mutex::new(HashMap::new())),
            default_timeout: 60,
            remembered: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 设置默认超时时间
    pub fn with_timeout(mut self, timeout_seconds: u32) -> Self {
        self.default_timeout = timeout_seconds;
        self
    }

    /// 注册待审批的工具调用
    ///
    /// ## 作用域键规则（M-081 修复 / P2）
    /// - v2：按工具类型提取关键字段（noteId / path / 命令前缀），忽略 content
    /// - v1：完整 args JSON + sha256，仅作为 v2 未命中的 fallback
    ///
    /// 写入时走统一入口 `approval_scope::make_runtime_scope_key`。
    /// 读取时 `check_remembered` 先查 v2，未命中再查 v1（保持旧记录兼容）。
    fn make_pending_key(session_id: &str, tool_call_id: &str) -> String {
        // 🔧 R2-MED 修复：用换行符作分隔符而非 `:`，避免 session_id / tool_call_id
        // 里包含 `:` 造成的潜在碰撞（极罕见但理论可能）
        format!("{}\n{}", session_id, tool_call_id)
    }

    /// 无 session / 无参数版本的 register — **仅供单测使用**。
    /// 生产代码必须调用 `register_with_scope`，传入真实 session_id / tool_name / arguments，
    /// 否则 scope_key 会落到 `::null` 这种通配桶。
    #[cfg(test)]
    pub fn register(&self, tool_call_id: &str) -> oneshot::Receiver<ApprovalResponse> {
        self.register_with_scope("", tool_call_id, "", &Value::Null)
    }

    pub fn register_with_scope(
        &self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> oneshot::Receiver<ApprovalResponse> {
        let (tx, rx) = oneshot::channel();
        let pending_key = Self::make_pending_key(session_id, tool_call_id);

        // 🔧 R2-MED 修复：检测 tool_call_id 复用。如果已有同 key 的 sender，
        // 新 register 会悄悄丢掉旧 sender → 旧调用方一直等到 timeout。
        // 这里改为显式告警 + 旧 sender 主动关闭（发 "Rejected + cancelled" 让
        // 旧等待者尽快解除阻塞）。
        let prior = {
            let mut map = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            map.insert(pending_key.clone(), tx)
        };
        if let Some(old_tx) = prior {
            log::warn!(
                "[ApprovalManager] Duplicate register_with_scope for pending_key session={}, tool_call_id={}; \
                 dropping earlier receiver (likely tool_call_id reuse from adapter)",
                session_id,
                tool_call_id
            );
            // 尝试通知旧等待者：作为 rejected 返回，避免它等到 timeout
            let resp = ApprovalResponse::rejected(
                session_id.to_string(),
                tool_call_id.to_string(),
                tool_name.to_string(),
                Some("duplicate approval request; earlier one superseded".to_string()),
            );
            let _ = old_tx.send(resp);
        }

        // 🔧 M-081 修复：统一入口 make_runtime_scope_key（v2 优先，未知工具 fallback v1）
        let scope_key = approval_scope::make_runtime_scope_key(tool_name, arguments);
        self.pending_scope_keys
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .insert(pending_key, scope_key);

        rx
    }

    /// 发送审批响应
    ///
    /// ## 参数
    /// - `response`: 审批响应
    ///
    /// ## 返回
    /// - `true`: 成功发送
    /// - `false`: 未找到对应的等待者（可能已超时）
    pub fn respond(&self, response: ApprovalResponse) -> bool {
        let pending_key = Self::make_pending_key(&response.session_id, &response.tool_call_id);

        // 🔧 M-081 修复（P2 - H4）：先弹出 pending 通道，确认请求仍存活。
        // 如果 pending 不在（已被取消或超时），直接报废本次 respond —— 不要在此状态下
        // 持久化 remember，避免把 Null 作为 "兜底 args" 构造通配作用域键。
        let tx = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .remove(&pending_key);

        let Some(tx) = tx else {
            log::warn!(
                "[ApprovalManager] No pending approval for tool_call_id: {}",
                response.tool_call_id
            );
            // 清理可能悬挂的 scope_key（即便 pending 已不在）
            self.pending_scope_keys
                .lock()
                .unwrap_or_else(|poisoned| {
                    log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                    poisoned.into_inner()
                })
                .remove(&pending_key);
            return false;
        };

        // 请求仍在等待：先取走 scope_key，再考虑是否 remember
        let scope_key_opt = self
            .pending_scope_keys
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .remove(&pending_key);

        if response.remember {
            match scope_key_opt {
                Some(scope_key) => {
                    log::info!(
                        "[ApprovalManager] Remembering approval choice for scope '{}': approved={}",
                        scope_key,
                        response.approved
                    );
                    self.remembered
                        .lock()
                        .unwrap_or_else(|poisoned| {
                            log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                            poisoned.into_inner()
                        })
                        .insert(scope_key, response.approved);
                }
                None => {
                    // H4：不允许在作用域键缺失时用 Null 合成作用域。
                    // 降级为"只响应不记住"，并明确告警。
                    log::warn!(
                        "[ApprovalManager] respond(remember=true) but scope_key missing; dropping remember flag (session={}, tool_call_id={}, tool={})",
                        response.session_id,
                        response.tool_call_id,
                        response.tool_name
                    );
                }
            }
        }

        // 送达等待方
        tx.send(response).is_ok()
    }

    /// 取消待审批（超时或取消时调用）
    pub fn cancel_with_session(&self, session_id: &str, tool_call_id: &str) {
        let pending_key = Self::make_pending_key(session_id, tool_call_id);
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .remove(&pending_key);
        self.pending_scope_keys
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .remove(&pending_key);
    }

    pub fn cancel(&self, tool_call_id: &str) {
        // 🔧 配合 make_pending_key 的 `\n` 分隔符；旧 `:{}` suffix 已失效
        let suffix = format!("\n{}", tool_call_id);
        let pending_keys: Vec<String> = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .keys()
            .filter(|k| k.ends_with(&suffix) || k.as_str() == tool_call_id)
            .cloned()
            .collect();

        if pending_keys.is_empty() {
            return;
        }

        let mut pending = self.pending.lock().unwrap_or_else(|poisoned| {
            log::error!("[ApprovalManager] Mutex poisoned (pending)! Attempting recovery");
            poisoned.into_inner()
        });
        let mut scope = self.pending_scope_keys.lock().unwrap_or_else(|poisoned| {
            log::error!("[ApprovalManager] Mutex poisoned (scope_keys)! Attempting recovery");
            poisoned.into_inner()
        });

        for key in pending_keys {
            pending.remove(&key);
            scope.remove(&key);
        }
    }

    /// 检查工具是否已被记住（自动批准/拒绝）
    ///
    /// ## 参数
    /// - `tool_name`: 工具名称
    ///
    /// ## 返回
    /// - `Some(true)`: 已记住，自动批准
    /// - `Some(false)`: 已记住，自动拒绝
    /// - `None`: 未记住，需要用户审批
    ///
    /// 🔧 M-081 修复：先查 v2 作用域键（新逻辑），未命中再查 v1（保持旧记录兼容）
    /// 🔧 M2 修复：在获取锁**之前**完成 JSON 序列化，避免阻塞其他审批检查
    pub fn check_remembered(&self, tool_name: &str, arguments: &Value) -> Option<bool> {
        // 在锁外计算（v1 含 serde_json::to_string，O(|args|)）
        let v2_key = approval_scope::make_runtime_scope_key_v2(tool_name, arguments);
        let v1_key = approval_scope::make_runtime_scope_key_v1(tool_name, arguments);

        let map = self.remembered.lock().unwrap_or_else(|poisoned| {
            log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });

        if let Some(key) = v2_key {
            if let Some(v) = map.get(&key).copied() {
                return Some(v);
            }
        }
        map.get(&v1_key).copied()
    }

    /// 清除记住的选择（按参数作用域）
    /// 两个键（v1 + v2）都尝试清理
    pub fn clear_remembered(&self, tool_name: &str, arguments: &Value) {
        // 同样在锁外序列化
        let v2_key = approval_scope::make_runtime_scope_key_v2(tool_name, arguments);
        let v1_key = approval_scope::make_runtime_scope_key_v1(tool_name, arguments);

        let mut map = self.remembered.lock().unwrap_or_else(|poisoned| {
            log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        if let Some(key) = v2_key {
            map.remove(&key);
        }
        map.remove(&v1_key);
    }

    /// 清除所有记住的选择
    pub fn clear_all_remembered(&self) {
        self.remembered
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .clear();
    }

    /// 获取默认超时时间
    pub fn default_timeout(&self) -> u32 {
        self.default_timeout
    }

    /// 获取待审批数量
    pub fn pending_count(&self) -> usize {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .len()
    }

    /// 生成人类可读的工具描述
    pub fn generate_description(tool_name: &str, arguments: &Value) -> String {
        match tool_name {
            "note_set" => {
                let note_id = arguments
                    .get("noteId")
                    .or(arguments.get("note_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知笔记");
                format!("将完全替换笔记 {} 的内容", note_id)
            }
            "note_replace" => {
                let search = arguments
                    .get("search")
                    .and_then(|v| v.as_str())
                    .unwrap_or("...");
                format!("将替换笔记中匹配 \"{}\" 的内容", search)
            }
            "file_write" => {
                let path = arguments
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知路径");
                format!("将写入文件: {}", path)
            }
            "file_delete" => {
                let path = arguments
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知路径");
                format!("将删除文件: {}", path)
            }
            "execute_command" => {
                let cmd = arguments
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("...");
                format!("将执行命令: {}", cmd)
            }
            _ => format!("将执行工具: {}", tool_name),
        }
    }
}

impl Default for ApprovalManager {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_approval_flow() {
        let manager = ApprovalManager::new();

        // 注册
        let rx = manager.register_with_scope(
            "sess_1",
            "call_123",
            "test_tool",
            &serde_json::json!({"a":1}),
        );

        // 模拟前端响应
        let response = ApprovalResponse::approved(
            "sess_1".to_string(),
            "call_123".to_string(),
            "test_tool".to_string(),
        );
        assert!(manager.respond(response));

        // 接收响应
        let result = rx.await.unwrap();
        assert!(result.approved);
    }

    #[tokio::test]
    async fn test_approval_timeout() {
        let manager = ApprovalManager::new();

        // 注册
        let _rx = manager.register_with_scope(
            "sess_1",
            "call_456",
            "test_tool",
            &serde_json::json!({"a":1}),
        );

        // 取消（模拟超时）
        manager.cancel_with_session("sess_1", "call_456");

        // 再次响应应该失败
        let response = ApprovalResponse::approved(
            "sess_1".to_string(),
            "call_456".to_string(),
            "test_tool".to_string(),
        );
        assert!(!manager.respond(response));
    }

    #[test]
    fn test_remembered_choices() {
        let manager = ApprovalManager::new();

        // 初始状态
        assert!(manager
            .check_remembered("test_tool", &serde_json::json!({"path":"/a"}))
            .is_none());

        // 注册并记住选择
        let _rx = manager.register_with_scope(
            "sess_1",
            "call_789",
            "test_tool",
            &serde_json::json!({"path":"/a"}),
        );
        let mut response = ApprovalResponse::approved(
            "sess_1".to_string(),
            "call_789".to_string(),
            "test_tool".to_string(),
        );
        response.remember = true;
        manager.respond(response);

        // 检查（使用 tool_name 查询）
        assert_eq!(
            manager.check_remembered("test_tool", &serde_json::json!({"path":"/a"})),
            Some(true)
        );
        assert!(manager
            .check_remembered("test_tool", &serde_json::json!({"path":"/b"}))
            .is_none());

        // 清除
        manager.clear_remembered("test_tool", &serde_json::json!({"path":"/a"}));
        assert!(manager
            .check_remembered("test_tool", &serde_json::json!({"path":"/a"}))
            .is_none());
    }
}
