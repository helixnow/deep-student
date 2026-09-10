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
//! # 进程内语义 + 持久化（P2）
//!
//! grant 注册表为进程内 static（worker 随进程存亡，无需落库）；撤权 epoch
//! 已落库（G02-P2，迁移 V20260910 `revocation_epochs` 表）——撤权是终态，
//! 记录必须跨重启存活。写读序：
//! - bump（[`revoke_all_grants`] / [`revoke_grants_for`]）：**先写库再更新
//!   内存**（fail-closed：写库失败则内存不动、整体返回错误，绝不留下
//!   "内存已撤、库里没撤"的半态导致重启后静默回滚撤权）；
//! - 启动（`ChatV2Database::new` 调用 [`restore_revocation_epochs_from_db`]）：
//!   从表加载并以 max 语义安装进进程内轴（无行 → 0，表缺失 → 跳过）。
//!
//! 撤权入口：
//! - [`revoke_all_grants`]：bump 全局 epoch，此前签发的所有 grant 立即失效；
//! - [`revoke_grants_for`]：仅 bump 指定 `child_task_id` 的 epoch，其余 grant 不受影响。
//!
//! epoch 单调递增、永不复用：撤权是终态，「恢复」的语义 = 重新 run 签发新
//! grant（快照新 epoch），与 worker 重跑模型一致。
//!
//! TODO(P2 后续)：grant 登记审计落库；`object_scopes` 对接 transformer
//! profile 的对象级写授权。`budget` 已由 G08 对接（`budget.rs` 树根账本 +
//! reserve 语义填充；G08-P2 已落地 settings 可配与快照落库）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};

use super::database::ChatV2Database;
use super::tool_descriptors::{self, GrantsScopeHint};
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

    /// 从白名单条目还原类型化范围（P1：与条目一一对应）。
    ///
    /// G01-e：「条目对应哪个已知内建工具、其 scope 类别」的判定切换到
    /// ToolDescriptor 注册表（[`tool_descriptors::grants_scope_hint`]）。
    /// 显式源限定（`server::tool`）与 `mcp_`/`mcp.tools.` 命名空间条目仍按
    /// 字符串规则**先行**分类为 [`ToolScope::Mcp`]（规则与顺序逐字节不变，
    /// 注册表不接管——注册表内 `mcp_server_*` 等裸名工具的白名单条目本就以
    /// `builtin-` 前缀形式出现）；其余条目查注册表 hint：
    /// - `Shell` 族（local_shell_*）→ [`ToolScope::Shell`] 语义位（P1 恒
    ///   fail-closed；`prefixes` 留空——不携带任何命令前缀授权，P2 接线时
    ///   由 profile 的 shell_command_prefixes 另行构造）；
    /// - `Builtin` 族与未登记名字（外部 MCP 动态工具等）→ [`ToolScope::Builtin`]
    ///   兜底（与旧纯字符串规则结果一致）。
    ///
    /// 既定语义差异（与 G01-e headless 半边同型）：worker/profile 白名单均
    /// 不含 shell 族条目（内建 profile = 协作工具 ∪ headless 只读子集；
    /// custom profile 安全全集同样无 shell；legacy 回退仅两个协作工具），
    /// 故生产求值（`issue_worker_grant` / `effective_tools`）结果集与旧规则
    /// 逐字节一致；差异仅在手工构造 shell 工具名条目时从「按白名单匹配」
    /// 收紧为「恒拒」，正是 [`GrantsScopeHint::Shell`] 的声明性语义。
    /// 等价性由 `registry_driven_scope_derivation_matches_legacy_rules`
    /// 四层断言锁定。
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
        match tool_descriptors::grants_scope_hint(entry) {
            Some(GrantsScopeHint::Shell) => Self::Shell {
                prefixes: Vec::new(),
            },
            Some(GrantsScopeHint::Builtin) | None => Self::Builtin {
                name: entry.to_string(),
            },
        }
    }

    /// profile.allowed_tools → scopes 的映射（保序、不去重——输入已被
    /// profile 规范化去重）。G01-e 起每个条目的 Builtin/Shell 分类由
    /// 注册表 hint 驱动（见 [`ToolScope::from_allow_entry`]）。
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
            if self
                .tool_scopes
                .iter()
                .any(|scope| scope.allows(entry, &empty_args))
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
// 撤权 epoch（进程内轴 + V20260910 落库）
// ============================================================================

/// 全局撤权 epoch。签发 grant 时取快照；`revoke_all_grants` bump 后，
/// 快照值小于新 epoch 的全部 grant 失效。
static GLOBAL_REVOCATION_EPOCH: AtomicU64 = AtomicU64::new(0);

static TASK_REVOCATION_EPOCHS: OnceLock<RwLock<HashMap<String, u64>>> = OnceLock::new();
static GRANT_REGISTRY: OnceLock<RwLock<HashMap<String, DelegatedGrant>>> = OnceLock::new();

/// bump 序列化锁：「读当前值 → +1 → 写库 → 写内存」必须整体原子，
/// 否则并发 revoke 会算出相同的 next 或出现库/内存倒挂。
static REVOCATION_BUMP_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// `revocation_epochs` 表行键（迁移 V20260910）：全局行 (kind='global',
/// task_id='')；per-task 行 (kind='task', task_id=<child_task_id>)。
const EPOCH_KIND_GLOBAL: &str = "global";
const EPOCH_KIND_TASK: &str = "task";

fn task_revocation_epochs() -> &'static RwLock<HashMap<String, u64>> {
    TASK_REVOCATION_EPOCHS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn grant_registry() -> &'static RwLock<HashMap<String, DelegatedGrant>> {
    GRANT_REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

fn revocation_bump_lock() -> &'static Mutex<()> {
    REVOCATION_BUMP_LOCK.get_or_init(|| Mutex::new(()))
}

fn bump_guard() -> MutexGuard<'static, ()> {
    revocation_bump_lock().lock().unwrap_or_else(|poisoned| {
        log::error!("[Grants] bump Mutex poisoned; recovering");
        poisoned.into_inner()
    })
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
///
/// G02-P2 fail-closed 写读序：先在 bump 锁内向 `revocation_epochs` 写入
/// ('global','') 行，**写库成功后才更新内存**；写库失败则内存保持原值、
/// 整体返回 Err（调用方可上报告警）——绝不留下"内存已撤、库里没撤"的
/// 半态（那等于重启后静默回滚撤权）。单行 UPSERT 自身即原子，无需显式
/// 事务包裹。
pub fn revoke_all_grants(db: &ChatV2Database) -> Result<u64, String> {
    let _guard = bump_guard();
    let next = current_global_epoch().saturating_add(1);
    persist_revocation_epoch(db, EPOCH_KIND_GLOBAL, "", next)?;
    GLOBAL_REVOCATION_EPOCH.store(next, Ordering::SeqCst);
    log::warn!(
        "[Grants] revoke_all_grants: global revocation epoch bumped to {} (persisted)",
        next
    );
    Ok(next)
}

/// 仅撤销指定子任务的 grant：该任务的 epoch 提升一级，**不动全局 epoch**，
/// 其他任务的 grant 不受影响。返回该任务的新 epoch。
///
/// per-task epoch 取值 `max(全局 epoch, 既有 task epoch) + 1`：与全局 epoch
/// 共用一条单调轴，保证「revoke_all 之后 revoke_for」与「revoke_for 之后
/// revoke_all」任意交错下快照比较都成立；签发快照取
/// [`current_epoch_for`]（= 同一 max 轴），因此撤权后同一 child_task 重跑
/// 新签发的 grant 仍存活（撤权是「撤销在跑的一代」，不是永久拉黑）。
///
/// 写读序同 [`revoke_all_grants`]：先落库 ('task', child_task_id) 行，
/// 成功后更新内存；失败不更新内存（fail-closed）。
pub fn revoke_grants_for(db: &ChatV2Database, child_task_id: &str) -> Result<u64, String> {
    let _guard = bump_guard();
    let next = {
        let epochs = read_lock(task_revocation_epochs());
        let current = epochs.get(child_task_id).copied().unwrap_or(0);
        current.max(current_global_epoch()).saturating_add(1)
    };
    persist_revocation_epoch(db, EPOCH_KIND_TASK, child_task_id, next)?;
    write_lock(task_revocation_epochs()).insert(child_task_id.to_string(), next);
    log::warn!(
        "[Grants] revoke_grants_for: child_task_id={} revoked at epoch {} (persisted)",
        child_task_id,
        next
    );
    Ok(next)
}

// ============================================================================
// epoch 持久化（V20260910 revocation_epochs 表）
// ============================================================================

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 低层写入：upsert 一行 epoch（bump 路径在锁内调用；测试可直接调用做
/// roundtrip，不触碰进程内轴）。
pub fn persist_revocation_epoch(
    db: &ChatV2Database,
    kind: &str,
    task_id: &str,
    epoch: u64,
) -> Result<(), String> {
    let epoch_i64 =
        i64::try_from(epoch).map_err(|_| format!("epoch {epoch} exceeds SQLite INTEGER range"))?;
    let conn = db
        .get_conn()
        .map_err(|e| format!("revocation_epochs: get conn failed: {e}"))?;
    conn.execute(
        "INSERT INTO revocation_epochs (kind, task_id, epoch, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(kind, task_id) DO UPDATE SET
           epoch = excluded.epoch,
           updated_at = excluded.updated_at",
        rusqlite::params![kind, task_id, epoch_i64, now_rfc3339()],
    )
    .map_err(|e| format!("revocation_epochs upsert failed (kind={kind}, task={task_id}): {e}"))?;
    Ok(())
}

/// 从库中加载的撤权 epoch 快照（"新进程内存"的可测试形态）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoadedRevocationEpochs {
    pub global: u64,
    pub tasks: Vec<(String, u64)>,
}

impl LoadedRevocationEpochs {
    /// 与进程内轴同语义：max(global, 该任务 per-task epoch)。
    pub fn current_epoch_for(&self, child_task_id: &str) -> u64 {
        let task_epoch = self
            .tasks
            .iter()
            .find(|(task_id, _)| task_id == child_task_id)
            .map(|(_, epoch)| *epoch)
            .unwrap_or(0);
        self.global.max(task_epoch)
    }
}

/// `revocation_epochs` 表是否已迁移存在（未迁移的测试库/旧库 → 跳过加载）。
fn revocation_epochs_table_exists(conn: &rusqlite::Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='revocation_epochs')",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        == 1
}

/// 纯读取：从 revocation_epochs 表加载全部行。表不存在 → 返回空快照
/// （等同于"无行 → 0"）；单条坏行（负 epoch / 未知 kind）跳过并 warn，
/// 不让一条脏数据拖垮整个恢复。
pub fn load_revocation_epochs(db: &ChatV2Database) -> Result<LoadedRevocationEpochs, String> {
    let conn = db
        .get_conn()
        .map_err(|e| format!("revocation_epochs: get conn failed: {e}"))?;
    if !revocation_epochs_table_exists(&conn) {
        log::debug!("[Grants] revocation_epochs table absent; starting from epoch 0");
        return Ok(LoadedRevocationEpochs::default());
    }
    let mut stmt = conn
        .prepare("SELECT kind, task_id, epoch FROM revocation_epochs")
        .map_err(|e| format!("revocation_epochs prepare failed: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("revocation_epochs query failed: {e}"))?;
    let mut loaded = LoadedRevocationEpochs::default();
    for row in rows {
        let (kind, task_id, epoch) =
            row.map_err(|e| format!("revocation_epochs row decode failed: {e}"))?;
        let Ok(epoch) = u64::try_from(epoch) else {
            log::warn!(
                "[Grants] skipping corrupt revocation_epochs row (negative epoch): kind={}, task={}",
                kind,
                task_id
            );
            continue;
        };
        match kind.as_str() {
            EPOCH_KIND_GLOBAL => loaded.global = loaded.global.max(epoch),
            EPOCH_KIND_TASK => {
                // 复合主键保证每任务至多一行；防御性 max 合并
                match loaded.tasks.iter().position(|(id, _)| *id == task_id) {
                    Some(pos) => loaded.tasks[pos].1 = loaded.tasks[pos].1.max(epoch),
                    None => loaded.tasks.push((task_id, epoch)),
                }
            }
            other => {
                log::warn!("[Grants] skipping revocation_epochs row with unknown kind: {other}");
            }
        }
    }
    Ok(loaded)
}

/// 启动恢复入口（`ChatV2Database::new` 调用）：加载并以 **max 语义**安装
/// 进进程内轴——只升不降，重复调用/并发调用安全。失败仅记 error 不阻塞
/// 启动（epoch 丢失的最坏后果是旧撤权记录失效，而 grant 注册表本身不随
/// 进程存活，重启后本就没有在跑的旧 grant 可拦；新签发 grant 从 0 轴重新
/// 快照，语义自洽）。
pub fn restore_revocation_epochs_from_db(db: &ChatV2Database) {
    match load_revocation_epochs(db) {
        Ok(loaded) => {
            if loaded.global == 0 && loaded.tasks.is_empty() {
                return;
            }
            GLOBAL_REVOCATION_EPOCH.fetch_max(loaded.global, Ordering::SeqCst);
            let task_count = loaded.tasks.len();
            {
                let mut epochs = write_lock(task_revocation_epochs());
                for (task_id, epoch) in &loaded.tasks {
                    epochs
                        .entry(task_id.clone())
                        .and_modify(|existing| *existing = (*existing).max(*epoch))
                        .or_insert(*epoch);
                }
            }
            log::info!(
                "[Grants] Restored revocation epochs from db: global={}, tasks={}",
                loaded.global,
                task_count
            );
        }
        Err(e) => {
            log::error!(
                "[Grants] Failed to restore revocation epochs (starting from in-memory 0): {}",
                e
            );
        }
    }
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

/// G01-e 切换前，grants 的 ToolScope 推导是纯字符串规则（见
/// [`ToolScope::from_allow_entry`] 文档），不区分 shell 族；本清单是切换时
/// 为锁定「注册表收紧范围」而立的书面 ground truth（与
/// [`GrantsScopeHint::Shell`] 的声明性语义一致），保留为测试对照 oracle
/// （第二信源）。生产推导已切换为注册表驱动；防漂移测试逐名锁定「注册表
/// `grants_scope_hint == Shell` 集合 == 本清单」。新增/移除 shell 族工具时
/// 必须同步更新本清单与 `tool_descriptors::BUILTIN_DESCRIPTORS` 的
/// `grants_scope_hint` 标志，否则对照测试红灯。
#[cfg(test)]
pub(crate) const LEGACY_SHELL_FAMILY_TOOLS: &[&str] = &[
    "builtin-local_shell_execute",
    "builtin-local_shell_preflight",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::workspace::agent_profile::{
        AgentProfileResolver, DEFAULT_PROFILE_ID, EXPLORER_PROFILE_ID, WORKER_PROFILE_ID,
    };
    use chrono::{Duration, Utc};
    use serde_json::json;

    /// 操纵/断言进程内 epoch 轴的测试必须串行（cargo test 默认并线程）：
    /// 凡调用 revoke_* / restore_* 或断言全局 epoch 绝对关系的用例都要持有
    /// 本锁；纯库读写 roundtrip（persist + load 返回 struct）不触碰进程内轴，
    /// 无需持锁。
    static TEST_EPOCH_LOCK: Mutex<()> = Mutex::new(());

    /// 带 V20260910 表的临时 chat_v2 库（真实迁移 SQL，不用替身 schema）。
    /// 注意构造时表尚不存在，`ChatV2Database::new` 的启动恢复为空操作；
    /// 行写入发生在建库之后，不会再触发自动恢复，不污染进程内轴。
    fn grants_test_db() -> (tempfile::TempDir, ChatV2Database) {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let db = ChatV2Database::new(dir.path()).expect("chat_v2 db");
        db.get_conn()
            .expect("conn")
            .execute_batch(include_str!(
                "../../migrations/chat_v2/V20260910__revocation_epochs_and_budget.sql"
            ))
            .expect("apply V20260910");
        (dir, db)
    }

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
                        !grant
                            .tool_scopes
                            .iter()
                            .any(|s| s.allows(foreign, &json!({}))),
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

    /// G01-e 切换前的纯字符串规则参考实现（oracle，第二信源）：锁定「除
    /// shell 族收紧为 Shell 语义位外，其余条目的推导逐字节等价」。
    fn legacy_from_allow_entry(entry: &str) -> ToolScope {
        let entry = entry.trim();
        if let Some((server, tool)) = entry.split_once("::") {
            return ToolScope::Mcp {
                server: server.to_string(),
                tool: tool.to_string(),
            };
        }
        if entry.starts_with("mcp.tools.") || entry.starts_with("mcp_") {
            return ToolScope::Mcp {
                server: String::new(),
                tool: entry.to_string(),
            };
        }
        ToolScope::Builtin {
            name: entry.to_string(),
        }
    }

    /// G01-e 防漂移对照：ToolScope 推导切换注册表驱动后与旧字符串规则
    /// 逐名等价——唯一既定差异是 shell 族（LEGACY oracle）收紧为 Shell
    /// 语义位（fail-closed），生产路径白名单不含 shell 条目故结果集不变。
    #[test]
    fn registry_driven_scope_derivation_matches_legacy_rules() {
        use std::collections::HashSet;

        // ① 集合级：注册表 Shell-hint 裸名集与手写 shell 族 oracle 完全一致
        let flagged: HashSet<&str> = tool_descriptors::BUILTIN_DESCRIPTORS
            .iter()
            .filter(|d| d.grants_scope_hint == GrantsScopeHint::Shell)
            .map(|d| d.name)
            .collect();
        let legacy: HashSet<&str> = LEGACY_SHELL_FAMILY_TOOLS
            .iter()
            .map(|name| name.strip_prefix("builtin-").unwrap_or(name))
            .collect();
        assert_eq!(
            flagged, legacy,
            "shell 族工具集与注册表 grants_scope_hint 标志发生漂移"
        );

        // ② 名单内逐名：shell 族按线上名与裸名两种形式都映射 Shell 语义位，
        //    且恒 fail-closed（P1 不携带命令前缀授权）
        for name in LEGACY_SHELL_FAMILY_TOOLS {
            let bare = name.strip_prefix("builtin-").unwrap_or(name);
            for entry in [*name, bare] {
                let scope = ToolScope::from_allow_entry(entry);
                assert!(
                    matches!(scope, ToolScope::Shell { .. }),
                    "{entry} 应推导为 Shell 语义位，实际 {scope:?}"
                );
                assert!(
                    !scope.allows(entry, &json!({})),
                    "shell 族 scope 在 P1 必须恒 fail-closed：{entry}"
                );
            }
        }

        // ③ 名单外逐名：注册表内全部 Builtin-hint 工具（线上名/裸名两种
        //    形式）的推导结果与旧字符串规则参考实现逐字节相等
        for descriptor in tool_descriptors::BUILTIN_DESCRIPTORS {
            if descriptor.grants_scope_hint == GrantsScopeHint::Shell {
                continue;
            }
            let prefixed = format!("builtin-{}", descriptor.name);
            for entry in [descriptor.name.to_string(), prefixed] {
                assert_eq!(
                    ToolScope::from_allow_entry(&entry),
                    legacy_from_allow_entry(&entry),
                    "{entry} 的 ToolScope 推导与旧字符串规则发生漂移"
                );
            }
        }

        // ④ 未登记名：注册表恒不认领（hint=None），推导保持旧规则兜底
        //    （`::`/`mcp_` 字符串规则 → Mcp；裸外部名 → Builtin 兜底）
        for outsider in [
            "mcp_anything",
            "builtin-mcp_foo",
            "anki_generate_cards",
            "nonexistent_tool",
            "server-a::fetch",
        ] {
            assert_eq!(
                tool_descriptors::grants_scope_hint(outsider),
                None,
                "未登记名 {outsider} 不得被注册表认领"
            );
            assert_eq!(
                ToolScope::from_allow_entry(outsider),
                legacy_from_allow_entry(outsider),
                "未登记名 {outsider} 的兜底推导与旧字符串规则发生漂移"
            );
        }
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

    /// 全局机制集成测试（持有 TEST_EPOCH_LOCK 串行化全部进程内轴操纵；
    /// 业务 id 用 ULID 唯一化）：
    /// - per-task 撤权只影响目标任务；
    /// - 全局撤权使全部旧 grant 失效，新签发 grant 不受影响；
    /// - 撤权同时落库（revocation_epochs 行与内存同值）；
    /// - 守卫 drop 注销且不误删新一代注册。
    #[test]
    fn global_revocation_epoch_gates_registered_grants() {
        let _serial = TEST_EPOCH_LOCK.lock().unwrap();
        let (_dir, db) = grants_test_db();
        let suffix = ulid::Ulid::new().to_string();
        let (session_a, child_a) = (format!("sess_a_{suffix}"), format!("child_a_{suffix}"));
        let (session_b, child_b) = (format!("sess_b_{suffix}"), format!("child_b_{suffix}"));
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
        let revoked_epoch_a = revoke_grants_for(&db, &child_a).expect("persisted revoke");
        assert_eq!(
            lookup_grant_for_session(&session_a).unwrap().ensure_live(),
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

        // 撤权行已落库，且与内存同值（先库后内存）
        let persisted = load_revocation_epochs(&db).expect("load");
        assert_eq!(
            persisted.current_epoch_for(&child_a),
            revoked_epoch_a,
            "per-task 撤权后库内 epoch 必须与返回值一致"
        );

        // 全局撤权：B、A2 全部失效；之后签发的 D 存活
        let global_epoch = revoke_all_grants(&db).expect("persisted revoke all");
        assert_eq!(
            lookup_grant_for_session(&session_b).unwrap().ensure_live(),
            Err(GrantDenial::Revoked)
        );
        assert_eq!(
            lookup_grant_for_session(&session_a2).unwrap().ensure_live(),
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

        // 全局 epoch 行同样落库且与内存同值
        let persisted = load_revocation_epochs(&db).expect("load");
        assert_eq!(persisted.global, global_epoch);

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

    /// G02-P2 落库 roundtrip（纯库读写，不触碰进程内轴，无需串行锁）：
    /// persist → load 逐值相等；重复 upsert 覆盖同键行。
    #[test]
    fn epoch_persistence_roundtrip() {
        let (_dir, db) = grants_test_db();

        persist_revocation_epoch(&db, EPOCH_KIND_GLOBAL, "", 7).unwrap();
        persist_revocation_epoch(&db, EPOCH_KIND_TASK, "child-x", 9).unwrap();
        persist_revocation_epoch(&db, EPOCH_KIND_TASK, "child-y", 3).unwrap();
        // 同键 upsert 覆盖
        persist_revocation_epoch(&db, EPOCH_KIND_TASK, "child-y", 4).unwrap();

        let loaded = load_revocation_epochs(&db).expect("load");
        assert_eq!(loaded.global, 7);
        // 每任务恰好一行，upsert 覆盖旧值
        assert_eq!(
            loaded
                .tasks
                .iter()
                .filter(|(id, _)| id == "child-y")
                .map(|(_, epoch)| *epoch)
                .collect::<Vec<_>>(),
            vec![4],
            "upsert 必须覆盖旧值且不留重复行"
        );
        // per-task 轴语义 = max(global, task)
        assert_eq!(loaded.current_epoch_for("child-x"), 9);
        assert_eq!(
            loaded.current_epoch_for("child-y"),
            7,
            "max(global=7, task=4)"
        );
        // 未撤权的任务回落到全局轴
        assert_eq!(loaded.current_epoch_for("child-unknown"), 7);
    }

    /// G02-P2 重启保持语义（不触碰进程内轴）：写库 → 模拟新进程重新加载 →
    /// 旧快照 grant 仍被撤权拦截；未撤权任务的新快照 grant 存活。
    #[test]
    fn epoch_reload_keeps_revocation_effective() {
        let (_dir, db) = grants_test_db();
        let child_revoked = format!("child_revoked_{}", ulid::Ulid::new());
        let child_other = format!("child_other_{}", ulid::Ulid::new());

        persist_revocation_epoch(&db, EPOCH_KIND_GLOBAL, "", 5).unwrap();
        persist_revocation_epoch(&db, EPOCH_KIND_TASK, &child_revoked, 8).unwrap();

        // "新实例"：从库重新加载的内存视图
        let loaded = load_revocation_epochs(&db).expect("reload");

        let now = Utc::now();
        // 被 per-task 撤权的一代（快照 6 < 8）：重启后仍拒
        let mut grant = bare_grant(Vec::new());
        grant.child_task_id = child_revoked.clone();
        grant.revocation_epoch = 6;
        assert_eq!(
            grant.check_liveness(loaded.current_epoch_for(&child_revoked), now),
            Err(GrantDenial::Revoked),
            "重启加载后被撤任务旧快照必须仍被拒"
        );
        // 撤权后重跑的新一代（快照 = 8）：存活
        grant.revocation_epoch = 8;
        assert_eq!(
            grant.check_liveness(loaded.current_epoch_for(&child_revoked), now),
            Ok(())
        );
        // 全局撤权波及其他任务的旧快照（快照 4 < global 5）
        grant.child_task_id = child_other.clone();
        grant.revocation_epoch = 4;
        assert_eq!(
            grant.check_liveness(loaded.current_epoch_for(&child_other), now),
            Err(GrantDenial::Revoked)
        );
        // 其他任务的新快照（5 >= 5）：存活
        grant.revocation_epoch = 5;
        assert_eq!(
            grant.check_liveness(loaded.current_epoch_for(&child_other), now),
            Ok(())
        );
    }

    /// G02-P2 fail-closed：写库失败（表缺失）时内存轴纹丝不动，且返回 Err。
    /// 持有串行锁（断言进程内轴不变）。
    #[test]
    fn revoke_fails_closed_when_db_write_fails() {
        let _serial = TEST_EPOCH_LOCK.lock().unwrap();
        // 故意不应用 V20260910 迁移的库
        let dir = tempfile::TempDir::new().expect("temp dir");
        let db_no_table = ChatV2Database::new(dir.path()).expect("db without table");

        let global_before = current_global_epoch();
        let child = format!("child_fc_{}", ulid::Ulid::new());
        let task_before = current_epoch_for(&child);

        assert!(revoke_all_grants(&db_no_table).is_err());
        assert!(revoke_grants_for(&db_no_table, &child).is_err());
        assert_eq!(
            current_global_epoch(),
            global_before,
            "写库失败不得更新全局内存 epoch"
        );
        assert_eq!(
            current_epoch_for(&child),
            task_before,
            "写库失败不得更新 per-task 内存 epoch"
        );
    }

    /// G02-P2 启动恢复：max 语义安装（只升不降），重复恢复幂等。
    /// 持有串行锁（操纵进程内轴）。
    #[test]
    fn restore_installs_loaded_epochs_with_max_semantics() {
        let _serial = TEST_EPOCH_LOCK.lock().unwrap();
        let (_dir, db) = grants_test_db();
        let child = format!("child_restore_{}", ulid::Ulid::new());

        let global_base = current_global_epoch();
        persist_revocation_epoch(&db, EPOCH_KIND_GLOBAL, "", global_base + 10).unwrap();
        persist_revocation_epoch(&db, EPOCH_KIND_TASK, &child, global_base + 12).unwrap();

        restore_revocation_epochs_from_db(&db);
        assert_eq!(current_global_epoch(), global_base + 10);
        assert_eq!(current_epoch_for(&child), global_base + 12);

        // 重复恢复幂等；库中更小的旧值不得回退内存
        persist_revocation_epoch(&db, EPOCH_KIND_TASK, &child, 1).unwrap();
        restore_revocation_epochs_from_db(&db);
        assert_eq!(current_global_epoch(), global_base + 10);
        assert_eq!(current_epoch_for(&child), global_base + 12);
    }

    /// 表缺失（未迁移库）时启动恢复为空操作而非报错。
    #[test]
    fn restore_tolerates_missing_table() {
        let _serial = TEST_EPOCH_LOCK.lock().unwrap();
        let dir = tempfile::TempDir::new().expect("temp dir");
        let db = ChatV2Database::new(dir.path()).expect("db without table");
        let global_before = current_global_epoch();
        restore_revocation_epochs_from_db(&db); // 不得 panic
        assert_eq!(current_global_epoch(), global_before);
        assert!(load_revocation_epochs(&db).expect("load").global == 0);
    }
}
