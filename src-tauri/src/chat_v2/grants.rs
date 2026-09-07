//! G02-P1: DelegatedGrant —— 委派授权数据模型 + 只读 worker 迁移载体 + 撤权 epoch。
//!
//! # P1 铁律：行为不变
//!
//! grant 只是「换个载体表达同一份白名单」。P1 阶段：
//! - worker 的 `SendOptions.execution_allowed_tools` 继续原样下发，
//!   `ApprovalGateHook` 的白名单检查路径（`tool_policy::
//!   is_tool_allowed_by_execution_policy`）一字不改，仍是执行面唯一权威；
//! - grant 在 hook 白名单检查**之前**新增一道「存活门」：仅比对
//!   `revocation_epoch` 与 `expiry`，不改写有效工具集；
//! - 有效工具集求值逻辑（[`DelegatedGrant::effective_tools`] =
//!   profile.allowed_tools ∩ tool_scopes）随数据模型一同上线并有单测锁定，
//!   但 P1 接线处两者内容相同，求值结果恒等于现有白名单——为 P2 切换到
//!   grant 求值、回收 `execution_allowed_tools` 预留。
//!
//! # 数据流
//!
//! ```text
//! run_workspace_agent_backend
//!   └─ issue_worker_grant(session_id, ...) ──► GRANT_REGISTRY[session_id]
//!        （与 execution_allowed_tools 同源的 ToolScope 列表）
//! ApprovalGateHook::before_tool（hooks.rs 白名单检查点之前）
//!   └─ lookup_grant_for_session(session_id) ──► grant.ensure_live()
//!        ├─ revocation_epoch < current_epoch_for(child_task_id) → Block（授权已撤销）
//!        └─ expiry 过期 → Block（授权已过期）
//! worker 管线结束（含 panic/超时）→ GrantRegistrationGuard::drop 注销
//! ```
//!
//! # 进程内语义（P1）
//!
//! epoch 与注册表均为进程内 static（DB 持久化留 TODO，见下）。撤权入口：
//! - [`revoke_all_grants`]：bump 全局 epoch，此前签发的所有 grant 立即失效；
//! - [`revoke_grants_for`]：仅 bump 指定 `child_task_id` 的 epoch，其余 grant 不受影响。
//!
//! epoch 单调递增、永不复用：撤权是终态，「恢复」的语义 = 重新 run 签发新
//! grant（快照新 epoch），与 worker 重跑模型一致。
//!
//! TODO(P2)：epoch 与 grant 登记落库（重启后撤权记录不丢）；`object_scopes`
//! 对接 transformer profile 的对象级写授权。`budget` 已由 G08 对接
//! （`budget.rs` 树根账本 + reserve 语义填充，settings 可配与快照落库属
//! G08-P2）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};

use super::tool_policy;

/// DelegatedGrant 结构版本。P1 = 1；schema 演进时递增并在此注释变更点。
pub const DELEGATED_GRANT_SCHEMA_VERSION: u16 = 1;

// ============================================================================
// 数据模型
// ============================================================================

/// 类型化工具授权范围。
///
/// `allows` 的匹配语义**完全委托** [`tool_policy::tool_allow_entry_matches`]
/// （含 builtin/MCP 源隔离、`_serverId` 显式源限定），保证 grant 求值与
/// 现有白名单逐字节一致，不产生第二套匹配规则。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ToolScope {
    /// 内建工具（`builtin-*` / `builtin:*` / 裸名条目）。
    Builtin { name: String },
    /// MCP 工具。`server` 非空时等价白名单的 `server::tool` 显式源限定条目；
    /// 为空时表示 `mcp_*` 命名空间条目（未限定服务器）。
    Mcp { server: String, tool: String },
    /// Shell 命令前缀授权（P1 占位：恒不匹配——worker 白名单无 shell 条目，
    /// fail-closed；P2 参照 TrustedAutomationProfile.shell_command_prefixes 接线）。
    Shell { prefixes: Vec<String> },
}

impl ToolScope {
    /// 本范围是否放行一次工具调用。匹配语义 = 白名单条目匹配语义。
    pub fn allows(&self, tool_name: &str, arguments: &Value) -> bool {
        match self {
            Self::Builtin { name } => {
                tool_policy::tool_allow_entry_matches(name, tool_name, arguments)
            }
            Self::Mcp { server, tool } => {
                if server.is_empty() {
                    tool_policy::tool_allow_entry_matches(tool, tool_name, arguments)
                } else {
                    tool_policy::tool_allow_entry_matches(
                        &format!("{server}::{tool}"),
                        tool_name,
                        arguments,
                    )
                }
            }
            // P1 fail-closed：shell 前缀授权尚未接线。
            Self::Shell { .. } => false,
        }
    }

    /// 从白名单条目还原类型化范围（P1：与条目一一对应，内容无损）。
    pub fn from_allow_entry(entry: &str) -> Self {
        let entry = entry.trim();
        if let Some((server, tool)) = entry.split_once("::") {
            return Self::Mcp {
                server: server.to_string(),
                tool: tool.to_string(),
            };
        }
        if entry.starts_with("mcp.tools.") || entry.starts_with("mcp_") {
            return Self::Mcp {
                server: String::new(),
                tool: entry.to_string(),
            };
        }
        Self::Builtin {
            name: entry.to_string(),
        }
    }

    /// profile.allowed_tools → scopes 的无损映射（保序、不去重——输入已被
    /// profile 规范化去重过）。
    pub fn scopes_from_allowed_tools(allowed_tools: &[String]) -> Vec<Self> {
        allowed_tools
            .iter()
            .map(|entry| Self::from_allow_entry(entry))
            .collect()
    }
}

/// 对象级授权范围（P1 字段先立、恒为空 Vec；P2 对接 transformer profile 的
/// 对象范围写授权）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ObjectScope {
    /// VFS 资源只读。
    ResourceRead { resource_ids: Vec<String> },
    /// VFS 资源写（P2 预留）。
    ResourceWrite { resource_ids: Vec<String> },
    /// 运行时根目录（参照 TrustedAutomationProfile.runtime_roots）。
    RuntimeRoot { root_id: String, writable: bool },
}

/// 预算上限（G08 定稿：由 `budget::reserve_child_spec` 计算后填入
/// `DelegatedGrant.budget`——子上限 = min(自身声明, 父账本剩余) 的快照，
/// 作为 grant 凭证上的预算宣告；执行面 enforcement 在 `budget::BudgetLedger`
/// 树根账本 + hooks 预算门）。
///
/// 语义注意：`max_tool_calls` 计工具**调用**次数（一轮 LLM 可能发起多次
/// 调用），与 headless 会话级的 `max_tool_rounds`（轮次上限，见
/// headless.rs `SETTING_HEADLESS_MAX_TOOL_ROUNDS`）是不同维度；G08-P2
/// settings 可配时注意映射关系。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSpec {
    pub max_tool_calls: Option<u32>,
    pub max_tokens: Option<u64>,
    pub max_wall_clock_seconds: Option<u64>,
}

/// 委派授权：父任务授予子任务的一份显式、可撤销的能力凭证。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DelegatedGrant {
    pub grant_id: String,
    pub schema_version: u16,
    /// 委派方（父）任务标识。P1 近似为父会话 / 请求者会话 id（真实 task
    /// 血缘随 G03 账本在 P2 收紧）。
    pub parent_task_id: String,
    /// 受权方（子）任务标识。per-task 撤权（[`revoke_grants_for`]）以此为键。
    pub child_task_id: String,
    pub tool_scopes: Vec<ToolScope>,
    /// P1 恒为空 Vec（字段先立）。
    pub object_scopes: Vec<ObjectScope>,
    /// P1 恒为空 Vec（字段先立；P2 参照 TrustedAutomationProfile.network_domains）。
    pub network_destinations: Vec<String>,
    /// G08：子的有效预算快照（reserve 语义，由 `budget::attach_child_to_tree`
    /// 计算并经 `issue_worker_grant` 的 `budget` 参数填入）。
    pub budget: Option<BudgetSpec>,
    /// 过期时间。P1 签发恒为 None（不启用过期，行为不变）。
    pub expiry: Option<chrono::DateTime<chrono::Utc>>,
    /// 签发时的撤权 epoch 快照。存活条件：
    /// `revocation_epoch >= current_epoch_for(child_task_id)`。
    pub revocation_epoch: u64,
    /// 签发来源 profile 的内容锁定哈希（`AgentProfile::computed_hash`）。
    /// 审计/对账用：grant 与 profile 内容的血缘锚点。
    pub profile_hash: String,
}

/// 存活门拒绝原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantDenial {
    /// 撤权 epoch 已越过本 grant 的快照。
    Revoked,
    /// 已过 expiry。
    Expired,
}

impl GrantDenial {
    /// 面向操作者/模型的明确拦截原因（hook 直接回喂给模型）。
    pub fn message(&self, grant_id: &str, tool_name: &str) -> String {
        match self {
            Self::Revoked => format!(
                "授权已撤销：委派授权（grant {grant_id}）已被撤回，工具调用 '{tool_name}' 已被后端拦截"
            ),
            Self::Expired => format!(
                "授权已过期：委派授权（grant {grant_id}）已过有效期，工具调用 '{tool_name}' 已被后端拦截"
            ),
        }
    }
}

impl DelegatedGrant {
    /// 有效工具集 = profile.allowed_tools ∩ tool_scopes（按 profile 顺序，
    /// 去重）。P1 两者内容相同，返回值恒等于 `profile_allowed_tools` 本身；
    /// 该求值逻辑先上线由单测锁定，P2 切换执行面时直接复用。
    pub fn effective_tools(&self, profile_allowed_tools: &[String]) -> Vec<String> {
        let empty_args = Value::Null;
        let mut effective: Vec<String> = Vec::with_capacity(profile_allowed_tools.len());
        for entry in profile_allowed_tools {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            if self.tool_scopes.iter().any(|scope| scope.allows(entry, &empty_args))
                && !effective.iter().any(|seen| seen == entry)
            {
                effective.push(entry.to_string());
            }
        }
        effective
    }

    /// 纯函数存活性判定（无全局状态，测试友好）。
    pub fn check_liveness(
        &self,
        current_epoch: u64,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<(), GrantDenial> {
        if self.revocation_epoch < current_epoch {
            return Err(GrantDenial::Revoked);
        }
        if let Some(expiry) = self.expiry {
            if now >= expiry {
                return Err(GrantDenial::Expired);
            }
        }
        Ok(())
    }

    /// 以进程内全局 epoch / 当前时间判定存活（worker 工具调用的准入门）。
    pub fn ensure_live(&self) -> Result<(), GrantDenial> {
        self.check_liveness(current_epoch_for(&self.child_task_id), chrono::Utc::now())
    }
}

// ============================================================================
// 撤权 epoch（进程内，单调递增；DB 持久化 TODO(P2)）
// ============================================================================

/// 全局撤权 epoch。签发 grant 时取快照；`revoke_all_grants` bump 后，
/// 快照值小于新 epoch 的全部 grant 失效。
static GLOBAL_REVOCATION_EPOCH: AtomicU64 = AtomicU64::new(0);

static TASK_REVOCATION_EPOCHS: OnceLock<RwLock<HashMap<String, u64>>> = OnceLock::new();
static GRANT_REGISTRY: OnceLock<RwLock<HashMap<String, DelegatedGrant>>> = OnceLock::new();

fn task_revocation_epochs() -> &'static RwLock<HashMap<String, u64>> {
    TASK_REVOCATION_EPOCHS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn grant_registry() -> &'static RwLock<HashMap<String, DelegatedGrant>> {
    GRANT_REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| {
        log::error!("[Grants] RwLock poisoned during read; recovering inner data");
        poisoned.into_inner()
    })
}

fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|poisoned| {
        log::error!("[Grants] RwLock poisoned during write; recovering inner data");
        poisoned.into_inner()
    })
}

/// 当前全局撤权 epoch（签发快照用）。
pub fn current_global_epoch() -> u64 {
    GLOBAL_REVOCATION_EPOCH.load(Ordering::SeqCst)
}

/// 指定子任务当前生效的 epoch = max(全局 epoch, 该任务的 per-task epoch)。
pub fn current_epoch_for(child_task_id: &str) -> u64 {
    let task_epoch = read_lock(task_revocation_epochs())
        .get(child_task_id)
        .copied()
        .unwrap_or(0);
    current_global_epoch().max(task_epoch)
}

/// 撤销**全部**已签发 grant：bump 全局 epoch，旧快照的 grant 在下一次工具
/// 调用即被准入门拦截。返回新 epoch。
pub fn revoke_all_grants() -> u64 {
    let next = GLOBAL_REVOCATION_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    log::warn!(
        "[Grants] revoke_all_grants: global revocation epoch bumped to {}",
        next
    );
    next
}

/// 仅撤销指定子任务的 grant：该任务的 epoch 提升一级，**不动全局 epoch**，
/// 其他任务的 grant 不受影响。返回该任务的新 epoch。
///
/// per-task epoch 取值 `max(全局 epoch, 既有 task epoch) + 1`：与全局 epoch
/// 共用一条单调轴，保证「revoke_all 之后 revoke_for」与「revoke_for 之后
/// revoke_all」任意交错下快照比较都成立；签发快照取
/// [`current_epoch_for`]（= 同一 max 轴），因此撤权后同一 child_task 重跑
/// 新签发的 grant 仍存活（撤权是「撤销在跑的一代」，不是永久拉黑）。
pub fn revoke_grants_for(child_task_id: &str) -> u64 {
    let mut epochs = write_lock(task_revocation_epochs());
    let current = epochs.get(child_task_id).copied().unwrap_or(0);
    let next = current.max(current_global_epoch()) + 1;
    epochs.insert(child_task_id.to_string(), next);
    log::warn!(
        "[Grants] revoke_grants_for: child_task_id={} revoked at epoch {}",
        child_task_id,
        next
    );
    next
}

// ============================================================================
// 进程内 grant 注册表（worker 会话 → grant）
// ============================================================================

/// 为一次 worker run 签发并登记 grant，返回随管线寿命的注册守卫
/// （drop 即注销；与 `card_read_scope_guard` 同模式，panic/超时路径同样清理）。
///
/// `allowed_tools` 必须与本次 `SendOptions.execution_allowed_tools` 同源
/// （P1：同一 Vec），保证 grant 表达的白名单与执行面逐字节一致。
///
/// `budget`（G08）：worker 的有效预算快照，由调用方经
/// `budget::attach_child_to_tree` 的 reserve 语义算得（子上限 =
/// min(声明, 父账本剩余)）；仅作凭证宣告，执行面在树根账本。
pub fn issue_worker_grant(
    session_id: String,
    parent_task_id: String,
    child_task_id: String,
    allowed_tools: &[String],
    profile_hash: String,
    budget: Option<BudgetSpec>,
) -> GrantRegistrationGuard {
    // 快照取 max(全局, 该任务 per-task) 轴上的当前值：per-task 撤权后
    // 同一 child_task 重跑的新 grant 快照仍在新 epoch 之上（存活），
    // 而被撤的旧一代 grant 快照低于它（失效）。
    let revocation_epoch = current_epoch_for(&child_task_id);
    let grant = DelegatedGrant {
        grant_id: format!("grant_{}", ulid::Ulid::new()),
        schema_version: DELEGATED_GRANT_SCHEMA_VERSION,
        parent_task_id,
        child_task_id,
        tool_scopes: ToolScope::scopes_from_allowed_tools(allowed_tools),
        object_scopes: Vec::new(),
        network_destinations: Vec::new(),
        budget,
        // P1：不启用过期（行为不变）；字段先立，过期语义由 check_liveness 承载。
        expiry: None,
        revocation_epoch,
        profile_hash,
    };
    register_grant(session_id, grant)
}

/// 登记 grant（同 session 重复 run 时新 grant 覆盖旧注册）。
pub fn register_grant(session_id: String, grant: DelegatedGrant) -> GrantRegistrationGuard {
    let guard = GrantRegistrationGuard {
        session_id: session_id.clone(),
        grant_id: grant.grant_id.clone(),
    };
    log::debug!(
        "[Grants] Registered grant {} for session {} (child_task={}, scopes={}, epoch={})",
        grant.grant_id,
        session_id,
        grant.child_task_id,
        grant.tool_scopes.len(),
        grant.revocation_epoch
    );
    write_lock(grant_registry()).insert(session_id, grant);
    guard
}

/// 准入门查询：该会话当前登记的 grant（克隆出注册表，不持锁跨 await）。
pub fn lookup_grant_for_session(session_id: &str) -> Option<DelegatedGrant> {
    read_lock(grant_registry()).get(session_id).cloned()
}

/// grant 注册守卫。drop 时注销——但仅当注册表里仍是**自己这一代** grant
/// 时才移除（参照 StreamRegistration 的 generation 语义：同 session 重跑会
/// 先覆盖注册，旧守卫 drop 不得误删新一代 grant）。
pub struct GrantRegistrationGuard {
    session_id: String,
    grant_id: String,
}

impl GrantRegistrationGuard {
    pub fn grant_id(&self) -> &str {
        &self.grant_id
    }
}

impl Drop for GrantRegistrationGuard {
    fn drop(&mut self) {
        let mut registry = write_lock(grant_registry());
        let is_current_generation = registry
            .get(&self.session_id)
            .is_some_and(|grant| grant.grant_id == self.grant_id);
        if is_current_generation {
            registry.remove(&self.session_id);
            log::debug!(
                "[Grants] Unregistered grant {} for session {}",
                self.grant_id,
                self.session_id
            );
        }
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::workspace::agent_profile::{
        AgentProfileResolver, DEFAULT_PROFILE_ID, EXPLORER_PROFILE_ID, WORKER_PROFILE_ID,
    };
    use chrono::{Duration, Utc};
    use serde_json::json;

    fn bare_grant(tool_scopes: Vec<ToolScope>) -> DelegatedGrant {
        DelegatedGrant {
            grant_id: "grant_test".into(),
            schema_version: DELEGATED_GRANT_SCHEMA_VERSION,
            parent_task_id: "parent".into(),
            child_task_id: "child".into(),
            tool_scopes,
            object_scopes: Vec::new(),
            network_destinations: Vec::new(),
            budget: None,
            expiry: None,
            revocation_epoch: 0,
            profile_hash: String::new(),
        }
    }

    /// profile→grant 映射无损：default / worker / explorer 各一例，
    /// 每个白名单工具被且仅被 scopes 放行，有效工具集与现状逐一相等。
    #[test]
    fn builtin_profiles_map_losslessly_to_grant_scopes() {
        for profile_id in [DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID] {
            let profile = AgentProfileResolver::built_in(profile_id).unwrap();
            let grant = bare_grant(profile.grant_tool_scopes());

            // 白名单内每个工具均被放行（空参数 = builtin 本地调用形态）
            for tool in &profile.allowed_tools {
                assert!(
                    grant.tool_scopes.iter().any(|s| s.allows(tool, &json!({}))),
                    "profile {profile_id}: scope set must allow whitelisted tool {tool}"
                );
            }
            // 交集求值与现状白名单逐一相等（保序）
            assert_eq!(
                grant.effective_tools(&profile.allowed_tools),
                profile.allowed_tools,
                "profile {profile_id}: effective_tools must equal the existing whitelist"
            );
            // 白名单外工具一律拒止（以写工具/越权工具为例）
            for foreign in [
                "builtin-dstu_delete",
                "builtin-note_append",
                "builtin-chatanki_run",
                "builtin-local_shell_execute",
            ] {
                if !profile.allowed_tools.iter().any(|t| t == foreign) {
                    assert!(
                        !grant.tool_scopes.iter().any(|s| s.allows(foreign, &json!({}))),
                        "profile {profile_id}: scope set must NOT allow foreign tool {foreign}"
                    );
                }
            }
        }
    }

    /// 交集求值：scopes 为 profile 子集时有效集 = 交集；空侧 → 空集。
    #[test]
    fn effective_tools_computes_intersection() {
        let profile_tools = vec![
            "builtin-workspace_send".to_string(),
            "builtin-web_search".to_string(),
            "builtin-resource_read".to_string(),
        ];
        // scopes 只含 web_search（+ 一个 profile 未声明的条目，不得混入结果）
        let grant = bare_grant(vec![
            ToolScope::Builtin {
                name: "builtin-web_search".into(),
            },
            ToolScope::Builtin {
                name: "builtin-unified_search".into(),
            },
        ]);
        assert_eq!(
            grant.effective_tools(&profile_tools),
            vec!["builtin-web_search".to_string()]
        );

        let empty_scopes = bare_grant(Vec::new());
        assert!(empty_scopes.effective_tools(&profile_tools).is_empty());
        assert!(grant.effective_tools(&[]).is_empty());
    }

    /// 匹配语义复用白名单规则：builtin scope 不得跨源放行 MCP 同名工具；
    /// server::tool 显式源限定仅对携带同一 _serverId 的调用生效。
    #[test]
    fn scopes_respect_source_isolation() {
        let builtin = ToolScope::Builtin {
            name: "builtin-web_search".into(),
        };
        assert!(builtin.allows("builtin-web_search", &json!({})));
        assert!(builtin.allows("web_search", &json!({})));
        assert!(!builtin.allows("mcp_web_search", &json!({})));
        assert!(!builtin.allows("web_search", &json!({ "_serverId": "evil" })));

        let mcp = ToolScope::from_allow_entry("server-a::fetch");
        assert!(mcp.allows("fetch", &json!({ "_serverId": "server-a" })));
        assert!(!mcp.allows("fetch", &json!({ "_serverId": "server-b" })));
        assert!(!mcp.allows("fetch", &json!({})));

        // Shell scope 在 P1 恒 fail-closed
        let shell = ToolScope::Shell {
            prefixes: vec!["ls".into()],
        };
        assert!(!shell.allows("builtin-local_shell_execute", &json!({})));
    }

    /// expiry 语义（纯函数）：过去 → Expired；未来/None → live。
    #[test]
    fn expiry_gates_liveness() {
        let now = Utc::now();
        let mut grant = bare_grant(Vec::new());
        grant.expiry = Some(now - Duration::seconds(1));
        assert_eq!(
            grant.check_liveness(0, now),
            Err(GrantDenial::Expired),
            "过期 grant 必须被拒"
        );
        grant.expiry = Some(now + Duration::minutes(5));
        assert_eq!(grant.check_liveness(0, now), Ok(()));
        // expiry=None 永不过期（epoch 快照与当前相同，存活）
        grant.expiry = None;
        assert_eq!(
            grant.check_liveness(grant.revocation_epoch, now),
            Ok(()),
            "无 expiry 的 grant 不得因过期被拒"
        );
    }

    /// epoch 语义（纯函数）：快照 >= 当前 epoch 存活；快照 < 当前 epoch 撤销。
    #[test]
    fn epoch_liveness_is_monotonic() {
        let mut grant = bare_grant(Vec::new());
        grant.revocation_epoch = 5;
        assert_eq!(grant.check_liveness(5, Utc::now()), Ok(()));
        assert_eq!(
            grant.check_liveness(6, Utc::now()),
            Err(GrantDenial::Revoked)
        );
    }

    /// 全局机制集成测试（串行语义：本测试是唯一操纵全局 epoch 的用例，
    /// 全部 id 用 ULID 唯一化，与其他并行测试互不干扰）：
    /// - per-task 撤权只影响目标任务；
    /// - 全局撤权使全部旧 grant 失效，新签发 grant 不受影响；
    /// - 守卫 drop 注销且不误删新一代注册。
    #[test]
    fn global_revocation_epoch_gates_registered_grants() {
        let suffix = ulid::Ulid::new().to_string();
        let (session_a, child_a) = (
            format!("sess_a_{suffix}"),
            format!("child_a_{suffix}"),
        );
        let (session_b, child_b) = (
            format!("sess_b_{suffix}"),
            format!("child_b_{suffix}"),
        );
        let tools = vec!["builtin-web_search".to_string()];

        let guard_a = issue_worker_grant(
            session_a.clone(),
            "parent".into(),
            child_a.clone(),
            &tools,
            String::new(),
            None,
        );
        let guard_b = issue_worker_grant(
            session_b.clone(),
            "parent".into(),
            child_b.clone(),
            &tools,
            String::new(),
            None,
        );
        assert!(lookup_grant_for_session(&session_a)
            .unwrap()
            .ensure_live()
            .is_ok());
        assert!(lookup_grant_for_session(&session_b)
            .unwrap()
            .ensure_live()
            .is_ok());

        // per-task 撤权：A 失效，B 与新签发的 A2 不受影响
        revoke_grants_for(&child_a);
        assert_eq!(
            lookup_grant_for_session(&session_a)
                .unwrap()
                .ensure_live(),
            Err(GrantDenial::Revoked),
            "epoch bump 后旧 grant 必须被拒"
        );
        assert!(lookup_grant_for_session(&session_b)
            .unwrap()
            .ensure_live()
            .is_ok());
        let session_a2 = format!("sess_a2_{suffix}");
        let guard_a2 = issue_worker_grant(
            session_a2.clone(),
            "parent".into(),
            format!("child_a2_{suffix}"),
            &tools,
            String::new(),
            None,
        );
        assert!(lookup_grant_for_session(&session_a2)
            .unwrap()
            .ensure_live()
            .is_ok());

        // 全局撤权：B、A2 全部失效；之后签发的 D 存活
        revoke_all_grants();
        assert_eq!(
            lookup_grant_for_session(&session_b)
                .unwrap()
                .ensure_live(),
            Err(GrantDenial::Revoked)
        );
        assert_eq!(
            lookup_grant_for_session(&session_a2)
                .unwrap()
                .ensure_live(),
            Err(GrantDenial::Revoked)
        );
        let session_d = format!("sess_d_{suffix}");
        let _guard_d = issue_worker_grant(
            session_d.clone(),
            "parent".into(),
            format!("child_d_{suffix}"),
            &tools,
            String::new(),
            None,
        );
        assert!(lookup_grant_for_session(&session_d)
            .unwrap()
            .ensure_live()
            .is_ok());

        // 守卫 drop：注销自己这一代；同 session 已被新 grant 覆盖时不得误删
        let grant_id_a = guard_a.grant_id().to_string();
        let guard_a3 = issue_worker_grant(
            session_a.clone(),
            "parent".into(),
            child_a.clone(),
            &tools,
            String::new(),
            None,
        );
        assert_ne!(guard_a3.grant_id(), grant_id_a);
        drop(guard_a); // 旧一代守卫：不得误删 A3 的注册
        assert!(lookup_grant_for_session(&session_a).is_some());
        drop(guard_a3); // 当前一代守卫：正常注销
        assert!(lookup_grant_for_session(&session_a).is_none());
        drop(guard_b);
        assert!(lookup_grant_for_session(&session_b).is_none());
        drop(guard_a2);
        drop(_guard_d);
    }

    /// 错误消息必须明确「授权已撤销 / 授权已过期」（hook 回喂模型用）。
    #[test]
    fn denial_messages_are_explicit() {
        assert!(GrantDenial::Revoked
            .message("grant_x", "builtin-web_search")
            .contains("授权已撤销"));
        assert!(GrantDenial::Expired
            .message("grant_x", "builtin-web_search")
            .contains("授权已过期"));
    }
}
