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
use super::approval_scope::RuntimeApprovalScope;

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
    /// 本地 runtime 审批作用域摘要（例如 shell 的 root/cwd/command scope）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_scope: Option<RuntimeApprovalScope>,
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
    /// 是否记住选择（全局持久化）
    pub remember: bool,
    /// 🆕 审批三档分级：是否仅在本会话内记住选择（工具级，内存态，不持久化）
    #[serde(default)]
    pub remember_session: bool,
}

#[derive(Debug, Clone)]
pub struct ApprovalRespondResult {
    pub delivered: bool,
    pub setting_key: Option<String>,
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
            remember_session: false,
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
            remember_session: false,
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
            remember_session: false,
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
    /// 待审批工具调用对应的持久化 setting key。由后端原始参数生成，避免信任前端回传 arguments。
    pending_setting_keys: Arc<Mutex<HashMap<String, String>>>,
    /// 待审批工具原始名称。响应时以前端回传 tool_name 为辅，后端 pending 名称为准。
    pending_tool_names: Arc<Mutex<HashMap<String, String>>>,
    /// 默认超时时间（秒）
    default_timeout: u32,
    /// 记住的审批选择 Map<scope_key, approved>
    remembered: Arc<Mutex<HashMap<String, bool>>>,
    /// 🆕 会话级记住的审批选择 Map<session-scoped-key, approved>
    /// 普通工具保持工具级粒度；shell/runtime 工具按精确 scope 粒度，避免一次批准
    /// 放行同会话内所有命令。仅内存态，应用重启后失效。
    session_remembered: Arc<Mutex<HashMap<String, bool>>>,
}

impl ApprovalManager {
    /// 创建新的审批管理器
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            pending_scope_keys: Arc::new(Mutex::new(HashMap::new())),
            pending_setting_keys: Arc::new(Mutex::new(HashMap::new())),
            pending_tool_names: Arc::new(Mutex::new(HashMap::new())),
            default_timeout: 60,
            remembered: Arc::new(Mutex::new(HashMap::new())),
            session_remembered: Arc::new(Mutex::new(HashMap::new())),
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

    /// 会话级记住选择的 key（同样用换行符防碰撞）
    fn make_session_remember_key(session_id: &str, tool_name: &str) -> String {
        format!("{}\ntool\n{}", session_id, tool_name)
    }

    fn make_scoped_session_remember_key(session_id: &str, scope_key: &str) -> String {
        format!("{}\nscope\n{}", session_id, scope_key)
    }

    fn session_remember_key_for(
        session_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> String {
        if approval_scope::requires_precise_approval_scope(tool_name) {
            let scope_key = approval_scope::make_runtime_scope_key(tool_name, arguments);
            Self::make_scoped_session_remember_key(session_id, &scope_key)
        } else {
            Self::make_session_remember_key(session_id, tool_name)
        }
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
        let setting_key = approval_scope::make_setting_key(tool_name, arguments);
        self.pending_scope_keys
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .insert(pending_key.clone(), scope_key);
        self.pending_setting_keys
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .insert(pending_key.clone(), setting_key);
        self.pending_tool_names
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .insert(pending_key, tool_name.to_string());

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
        self.respond_with_result(response).delivered
    }

    pub fn respond_with_result(&self, mut response: ApprovalResponse) -> ApprovalRespondResult {
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
            self.pending_setting_keys
                .lock()
                .unwrap_or_else(|poisoned| {
                    log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                    poisoned.into_inner()
                })
                .remove(&pending_key);
            self.pending_tool_names
                .lock()
                .unwrap_or_else(|poisoned| {
                    log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                    poisoned.into_inner()
                })
                .remove(&pending_key);
            return ApprovalRespondResult {
                delivered: false,
                setting_key: None,
            };
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
        let setting_key_opt = self
            .pending_setting_keys
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .remove(&pending_key);
        let original_tool_name_opt = self
            .pending_tool_names
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .remove(&pending_key);

        if let Some(original_tool_name) = original_tool_name_opt {
            if original_tool_name != response.tool_name {
                log::warn!(
                    "[ApprovalManager] Approval response tool_name mismatch for session={}, tool_call_id={}: response='{}', pending='{}'; using pending tool name",
                    response.session_id,
                    response.tool_call_id,
                    response.tool_name,
                    original_tool_name
                );
                response.tool_name = original_tool_name;
            }
        }

        // ADR-B2：权限类工具（skill_install / mcp_server_propose / runtime_root_request）
        // 永不写入 remember —— 即使用户点了「始终允许 / 本会话允许」也降级为单次批准。
        if approval_scope::never_remember_approval(&response.tool_name) {
            if response.remember || response.remember_session {
                log::info!(
                    "[ApprovalManager] Downgrading remember flags for privilege tool '{}' (session={}, tool_call_id={})",
                    response.tool_name,
                    response.session_id,
                    response.tool_call_id
                );
                response.remember = false;
                response.remember_session = false;
            }
        }

        if response.remember {
            match scope_key_opt.as_ref() {
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
                        .insert(scope_key.clone(), response.approved);
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

        // 🆕 审批三档分级：会话级记住。
        // 普通工具沿用工具级粒度；shell/runtime 类工具必须按 pending scope 记住。
        if response.remember_session && !response.session_id.is_empty() {
            let session_key = if approval_scope::requires_precise_approval_scope(&response.tool_name)
            {
                match scope_key_opt.as_ref() {
                    Some(scope_key) => {
                        Self::make_scoped_session_remember_key(&response.session_id, scope_key)
                    }
                    None => {
                        log::warn!(
                            "[ApprovalManager] respond(remember_session=true) but scope_key missing for precise tool; dropping session remember (session={}, tool_call_id={}, tool={})",
                            response.session_id,
                            response.tool_call_id,
                            response.tool_name
                        );
                        String::new()
                    }
                }
            } else {
                Self::make_session_remember_key(&response.session_id, &response.tool_name)
            };

            if !session_key.is_empty() {
                log::info!(
                    "[ApprovalManager] Remembering approval for this session: '{}' approved={}",
                    session_key.replace('\n', " / "),
                    response.approved
                );
                self.session_remembered
                    .lock()
                    .unwrap_or_else(|poisoned| {
                        log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                        poisoned.into_inner()
                    })
                    .insert(session_key, response.approved);
            }
        }

        // ADR-B2：权限类工具不返回 setting_key，从源头阻断「始终允许」的 DB 持久化，
        // 即使 handler 层的 tool_name 判断被伪造的前端响应绕过也 fail-closed。
        let setting_key_for_persistence =
            if approval_scope::never_remember_approval(&response.tool_name) {
                None
            } else {
                setting_key_opt
            };

        // 送达等待方
        ApprovalRespondResult {
            delivered: tx.send(response).is_ok(),
            setting_key: setting_key_for_persistence,
        }
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
        self.pending_setting_keys
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .remove(&pending_key);
        self.pending_tool_names
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

        // 🔒 02 号报告 P2-3：tool_call_id 不保证跨会话唯一。命中多个 pending
        // 必然意味着分属不同会话（同会话同 id 是同一个 key），此时拒绝宽匹配取消，
        // 避免一个会话的取消误清另一会话的审批（fail-safe：留待超时或
        // `cancel_with_session` 精确处理）。
        if pending_keys.len() > 1 {
            log::warn!(
                "[ApprovalManager] cancel('{}') matched {} pending approvals across sessions; \
                 refusing broad cancellation — use cancel_with_session",
                tool_call_id,
                pending_keys.len()
            );
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
        let mut setting = self.pending_setting_keys.lock().unwrap_or_else(|poisoned| {
            log::error!("[ApprovalManager] Mutex poisoned (setting_keys)! Attempting recovery");
            poisoned.into_inner()
        });
        let mut tool_names = self.pending_tool_names.lock().unwrap_or_else(|poisoned| {
            log::error!("[ApprovalManager] Mutex poisoned (tool_names)! Attempting recovery");
            poisoned.into_inner()
        });

        for key in pending_keys {
            pending.remove(&key);
            scope.remove(&key);
            setting.remove(&key);
            tool_names.remove(&key);
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

    /// 🆕 检查工具在指定会话内是否已被记住（"本会话允许该工具"档）
    ///
    /// ## 返回
    /// - `Some(true)`: 本会话内自动批准
    /// - `Some(false)`: 本会话内自动拒绝
    /// - `None`: 未记住
    pub fn check_session_remembered(
        &self,
        session_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> Option<bool> {
        let key = Self::session_remember_key_for(session_id, tool_name, arguments);
        self.session_remembered
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .get(&key)
            .copied()
    }

    /// 🆕 清除指定会话的所有会话级记住选择（会话删除/重置时调用）
    pub fn clear_session_remembered(&self, session_id: &str) {
        let prefix = format!("{}\n", session_id);
        self.session_remembered
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("[ApprovalManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            })
            .retain(|key, _| !key.starts_with(&prefix));
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
        self.session_remembered
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
            "workspace_artifact_write" => {
                let path = arguments
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知路径");
                format!("将写入会话产物文件: {}", path)
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
            "browser_open" | "builtin-browser_open" => {
                let url = arguments
                    .get("url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知地址");
                format!("将打开内置浏览器: {}", url)
            }
            "browser_navigate" | "builtin-browser_navigate" => {
                let url = arguments
                    .get("url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知地址");
                format!("将导航至: {}", url)
            }
            "browser_click" | "builtin-browser_click" => {
                let element = arguments
                    .get("element")
                    .and_then(|v| v.as_str())
                    .unwrap_or("页面元素");
                let r#ref = arguments
                    .get("ref")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                format!("将点击网页元素: {} (ref={})", element, r#ref)
            }
            "browser_type" | "builtin-browser_type" => {
                let element = arguments
                    .get("element")
                    .and_then(|v| v.as_str())
                    .unwrap_or("输入框");
                let r#ref = arguments
                    .get("ref")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                // 不把 text 写入审批文案，避免密码/PII 泄露到通知面
                format!(
                    "将向网页元素输入文本: {} (ref={})（内容已隐藏）",
                    element, r#ref
                )
            }
            "browser_snapshot"
            | "builtin-browser_snapshot"
            | "browser_scroll"
            | "builtin-browser_scroll"
            | "browser_back"
            | "builtin-browser_back"
            | "browser_close"
            | "builtin-browser_close" => {
                format!("将执行浏览器操作: {}", tool_name)
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

    /// SECURITY 回归（02 号报告 P2-3）：两个会话共享同一 tool_call_id 时，
    /// 无 session 的宽匹配取消必须拒绝执行，避免跨会话误取消；
    /// 单一命中时行为不变；`cancel_with_session` 始终精确。
    #[tokio::test]
    async fn cancel_without_session_refuses_ambiguous_cross_session_match() {
        let manager = ApprovalManager::new();
        let _rx_a = manager.register_with_scope("sess_a", "call_dup", "test_tool", &Value::Null);
        let _rx_b = manager.register_with_scope("sess_b", "call_dup", "test_tool", &Value::Null);
        assert_eq!(manager.pending_count(), 2);

        // 命中两个会话 → 拒绝宽匹配取消
        manager.cancel("call_dup");
        assert_eq!(manager.pending_count(), 2, "ambiguous cancel must be a no-op");

        // 带 session 的取消精确生效
        manager.cancel_with_session("sess_a", "call_dup");
        assert_eq!(manager.pending_count(), 1);

        // 只剩单一命中时，宽匹配取消恢复可用
        manager.cancel("call_dup");
        assert_eq!(manager.pending_count(), 0);
    }

    #[test]
    fn session_remember_for_shell_is_scoped_to_root_cwd_and_command() {
        let manager = ApprovalManager::new();
        let approved_args = serde_json::json!({
            "command": "git status --short",
            "root_id": "workspace",
            "cwd": "."
        });

        let _rx =
            manager.register_with_scope("sess_1", "call_shell", "execute_command", &approved_args);
        let mut response = ApprovalResponse::approved(
            "sess_1".to_string(),
            "call_shell".to_string(),
            "execute_command".to_string(),
        );
        response.remember_session = true;
        assert!(manager.respond(response));

        assert_eq!(
            manager.check_session_remembered("sess_1", "execute_command", &approved_args),
            Some(true)
        );
        assert!(
            manager
                .check_session_remembered(
                    "sess_1",
                    "execute_command",
                    &serde_json::json!({
                        "command": "git status --short",
                        "root_id": "workspace",
                        "cwd": "notes"
                    })
                )
                .is_none(),
            "same command in another cwd must ask again"
        );
        assert!(
            manager
                .check_session_remembered(
                    "sess_1",
                    "execute_command",
                    &serde_json::json!({
                        "command": "git push origin main",
                        "root_id": "workspace",
                        "cwd": "."
                    })
                )
                .is_none(),
            "different command prefix must ask again"
        );
    }

    #[test]
    fn session_remember_for_regular_tools_keeps_tool_level_semantics() {
        let manager = ApprovalManager::new();
        let first_args = serde_json::json!({"noteId": "n1", "content": "v1"});

        let _rx = manager.register_with_scope("sess_1", "call_note", "note_set", &first_args);
        let mut response = ApprovalResponse::approved(
            "sess_1".to_string(),
            "call_note".to_string(),
            "note_set".to_string(),
        );
        response.remember_session = true;
        assert!(manager.respond(response));

        assert_eq!(
            manager.check_session_remembered(
                "sess_1",
                "note_set",
                &serde_json::json!({"noteId": "n2", "content": "v2"})
            ),
            Some(true),
            "existing session-level tool approval semantics should remain unchanged for regular tools"
        );
    }

    #[tokio::test]
    async fn response_tool_name_cannot_poison_shell_session_or_setting_scope() {
        let manager = ApprovalManager::new();
        let shell_args = serde_json::json!({
            "command": "git status --short",
            "root_id": "workspace",
            "cwd": "."
        });

        let rx =
            manager.register_with_scope("sess_1", "call_shell", "execute_command", &shell_args);
        let mut response = ApprovalResponse::approved(
            "sess_1".to_string(),
            "call_shell".to_string(),
            "note_set".to_string(),
        );
        response.remember = true;
        response.remember_session = true;

        let result = manager.respond_with_result(response);
        assert!(result.delivered);
        let expected_setting_key =
            crate::chat_v2::approval_scope::make_setting_key("execute_command", &shell_args);
        assert_eq!(
            result.setting_key.as_deref(),
            Some(expected_setting_key.as_str()),
            "persistent approval key must be derived from pending server-side arguments"
        );

        let delivered = rx.await.unwrap();
        assert_eq!(
            delivered.tool_name, "execute_command",
            "waiting pipeline should receive the pending tool name, not client-supplied spoof"
        );
        assert_eq!(
            manager.check_session_remembered("sess_1", "execute_command", &shell_args),
            Some(true)
        );
        assert!(
            manager
                .check_session_remembered(
                    "sess_1",
                    "note_set",
                    &serde_json::json!({"noteId": "n1"})
                )
                .is_none(),
            "spoofed response tool_name must not create a broad regular-tool session approval"
        );
    }
}
