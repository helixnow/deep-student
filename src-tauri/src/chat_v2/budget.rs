//! G08: 全树预算管控（parent budget 覆盖整棵子代理树）。
//!
//! # 问题
//!
//! G08 之前，5 个子代理 = 5 倍预算：每个 worker 独立计算自己的轮次 /
//! token / 时长，父任务对整棵树的总花费无感知、无约束。
//!
//! # 模型
//!
//! - [`BudgetKey`] = 任务树根 id。第一代 worker spawn 时以父会话 id 为根
//!   懒建账本；孙代理 spawn 时父（worker）会话已绑定根 key，直接复用——
//!   整棵树（任意深度）的花费全部归集到**同一个根账本**，不是各自独立池。
//! - 记账维度：`tool_calls` / `tokens_in + tokens_out` / `wall_clock`
//!   （账本创建起算，monotonic [`Instant`]）。
//! - [`BudgetLedger::try_consume`]：原子扣减，任一维度超限则**失败且全部
//!   不扣**（tool_calls 预扣语义，门内拦截用）。
//! - [`BudgetLedger::record_usage`]：无条件实报入账（tokens 轮末记账用；
//!   入账后若越顶，由下一次 `try_consume` 拦截）。
//!
//! # 传播路径（tree key 如何到达每个计数点）
//!
//! ```text
//! run_workspace_agent_backend（worker 派生唯一收口）
//!   └─ attach_child_to_tree(parent_session_id, agent_session_id, declared)
//!        ├─ tree_key = SESSION_TREE_KEYS[parent]（父已是树成员→复用根）
//!        │            或 parent_session_id（第一代 worker→以父会话为根建账）
//!        ├─ SESSION_TREE_KEYS[worker_session] = tree_key（守卫随管线 drop 解绑）
//!        └─ effective_budget = reserve_child_spec(declared, 父账本剩余)
//!             └─ 填入 DelegatedGrant.budget（min(声明, 父剩余) 快照）
//! ApprovalGateHook::before_tool（hooks.rs 预算门，grant 存活门旁）
//!   └─ tree_key_for_session(session_id) → try_consume(ONE_TOOL_CALL)
//!        ├─ worker 自身工具调用：session 已绑定 → 计入根账本
//!        └─ tool_pack / ptc 子调用：dispatch_with_admission →
//!           execute_single_tool 回到本门，子上下文继承 session_id
//!           （tool_pack_executor::create_sub_context /
//!           ptc_executor::PtcSubContextTemplate::build）→ 自动归集同一根账本。
//!           ⚠️ 因此执行器侧**不得**再自行计数（双计数 bug）。
//! ```
//!
//! # 账本轮换（防"额度耗尽后永久拉黑会话"）
//!
//! 根账本按父会话 id 复用，跨任务累计（parent budget 语义）。当账本
//! 已耗尽（任一维度到顶）**且**树上无活跃绑定（所有 worker 已结束）时，
//! 下一次 `attach_child_to_tree` 轮换为全新账本——耗尽是"这一代任务树"
//! 的终态，不是会话的永久封禁。
//!
//! # 进程内语义 + 持久化（G08-P2）
//!
//! 账本与绑定均为进程内 static；G08-P2 已落地：
//! - **默认预算值 settings 可配**（主库 settings 表三 key，见
//!   [`SETTING_BUDGET_MAX_TOOL_CALLS`] 等；缺失/非法值回退内置默认 + warn）；
//! - **预算快照落库**（迁移 V20260910 `budget_snapshots` 表）：账本创建 /
//!   超额 / worker 绑定解绑三个写入点（指纹去重），启动时恢复仍未完成的
//!   任务树根账本——防"重启/模型切换/重试重置任务累计预算"；超时的树按
//!   created_at_unix 推算已耗时，恢复即 exhausted（耗尽 + 树枯的轮换语义
//!   不变，下一代任务仍从零起算）。
//!
//! 持久化通道：attach/consume 的调用方（hooks/workspace_handlers）不携带
//! db 句柄，故由 `ChatV2Database::new` 启动时经 [`configure_persistence`]
//! 注册 chat_v2 连接池克隆与主库 settings 路径；全部热路径写入 fail-soft
//! （warn + 跳过），快照只是审计/恢复依据，绝不影响账本判定语义。
//!
//! TODO(G08-P2 后续)：
//! - token 记账接线：tool_loop 流式轮末的既有汇总点调 [`record_usage`]
//!   （tool_loop.rs 不在 G08 所有权内，P1 仅备好 API；wall_clock 与
//!   tool_calls 已在 hooks 门生效）；
//! - 注册表生命周期（LRU/TTL 清理；当前随会话规模缓慢增长）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use super::database::{ChatV2Database, ChatV2Pool};
use super::grants::BudgetSpec;

// ============================================================================
// 默认预算与 settings 可配（G08-P2）
// ============================================================================

/// 单树默认工具调用上限（整棵树所有成员共享）。
pub const DEFAULT_MAX_TOOL_CALLS: u64 = 200;
/// 单树默认 token 上限（in + out 合并计）。
pub const DEFAULT_MAX_TOKENS: u64 = 2_000_000;
/// 单树默认 wall-clock 上限（账本创建起算）。
pub const DEFAULT_MAX_WALL_CLOCK_SECS: u64 = 30 * 60;

/// settings key（主库 settings 表）：单树工具调用上限。
/// 缺失/非法（非正整数）→ 回退 [`DEFAULT_MAX_TOOL_CALLS`] + warn。
pub const SETTING_BUDGET_MAX_TOOL_CALLS: &str = "headless_budget_max_tool_calls";
/// settings key（主库 settings 表）：单树 token 上限（in + out 合并计）。
/// 缺失/非法 → 回退 [`DEFAULT_MAX_TOKENS`] + warn。
pub const SETTING_BUDGET_MAX_TOKENS: &str = "headless_budget_max_tokens";
/// settings key（主库 settings 表）：单树 wall-clock 上限秒数。
/// 缺失/非法 → 回退 [`DEFAULT_MAX_WALL_CLOCK_SECS`] + warn。
pub const SETTING_BUDGET_MAX_WALL_CLOCK_SECS: &str = "headless_budget_wall_clock_secs";

/// 任务树根 id（第一代 worker 的根 = 父会话 id）。
pub type BudgetKey = String;

/// 一棵树的三维预算上限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetLimits {
    pub max_tool_calls: u64,
    pub max_tokens: u64,
    pub max_wall_clock: Duration,
}

impl Default for BudgetLimits {
    fn default() -> Self {
        Self {
            max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
            max_tokens: DEFAULT_MAX_TOKENS,
            max_wall_clock: Duration::from_secs(DEFAULT_MAX_WALL_CLOCK_SECS),
        }
    }
}

/// 解析单个 settings 值：缺失 → 默认（正常态，不告警）；非法（非正整数）
/// → 默认 + warn。0 视为非法（上限 0 = 树创建即耗尽，无合理用途）。
fn parse_limit(raw: Option<String>, default: u64, key: &str) -> u64 {
    let Some(raw) = raw else { return default };
    let trimmed = raw.trim();
    match trimmed.parse::<u64>() {
        Ok(value) if value > 0 => value,
        _ => {
            log::warn!(
                "[Budget] settings key '{}' 的值 {:?} 非法（需为正整数），回退默认 {}",
                key,
                trimmed,
                default
            );
            default
        }
    }
}

/// 由 settings 读取闭包解析三维默认树上限（纯函数，测试友好）。
///
/// N06 语义适配：settings 读取侧的失败已降级为 None + warn（budget 是
/// 资源护栏而非机密/权限面，读取失败不得拖垮 worker 派生）；此处对
/// 缺失/非法值回退默认并 warn，与 headless `resolve_budget` 的
/// "setting 缺失回退默认" 模式一致。
pub fn resolve_limits(read: &dyn Fn(&str) -> Option<String>) -> BudgetLimits {
    BudgetLimits {
        max_tool_calls: parse_limit(
            read(SETTING_BUDGET_MAX_TOOL_CALLS),
            DEFAULT_MAX_TOOL_CALLS,
            SETTING_BUDGET_MAX_TOOL_CALLS,
        ),
        max_tokens: parse_limit(
            read(SETTING_BUDGET_MAX_TOKENS),
            DEFAULT_MAX_TOKENS,
            SETTING_BUDGET_MAX_TOKENS,
        ),
        max_wall_clock: Duration::from_secs(parse_limit(
            read(SETTING_BUDGET_MAX_WALL_CLOCK_SECS),
            DEFAULT_MAX_WALL_CLOCK_SECS,
            SETTING_BUDGET_MAX_WALL_CLOCK_SECS,
        )),
    }
}

/// 一次扣减/入账的增量。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BudgetDelta {
    pub tool_calls: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

impl BudgetDelta {
    /// 预算门单次工具调用预扣。
    pub const ONE_TOOL_CALL: Self = Self {
        tool_calls: 1,
        tokens_in: 0,
        tokens_out: 0,
    };

    /// 轮末 token 实报入账（[`BudgetLedger::record_usage`]）。
    pub const fn tokens(tokens_in: u64, tokens_out: u64) -> Self {
        Self {
            tool_calls: 0,
            tokens_in,
            tokens_out,
        }
    }
}

/// 扣减成功后的剩余量快照。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetRemaining {
    pub tool_calls: u64,
    /// in + out 合并剩余。
    pub tokens: u64,
    pub wall_clock_secs: u64,
}

/// 当前已用量快照（测试断言 / G08-P2 落库快照源）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetUsage {
    pub tool_calls: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    /// 账本创建至今的 wall-clock 秒数。
    pub wall_clock_secs: u64,
}

/// 超限维度。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetDimension {
    ToolCalls,
    Tokens,
    WallClock,
}

impl BudgetDimension {
    fn label(self) -> &'static str {
        match self {
            Self::ToolCalls => "工具调用次数",
            Self::Tokens => "token 用量",
            Self::WallClock => "运行时长",
        }
    }
}

/// 预算超限（`try_consume` 失败；未发生任何扣减）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetExceeded {
    pub dimension: BudgetDimension,
    pub used: u64,
    pub limit: u64,
}

impl BudgetExceeded {
    /// 面向模型的明确拦截原因（hook 回喂，供模型体面收尾）。
    pub fn message(&self, tool_name: &str) -> String {
        let unit = match self.dimension {
            BudgetDimension::WallClock => " 秒",
            _ => "",
        };
        format!(
            "任务树预算已耗尽：{}已达上限（已用 {} / 上限 {}{}）。工具调用 '{}' 已被后端拦截。请停止发起新的工具调用，基于已获得的信息整理结论并给出最终回答。",
            self.dimension.label(),
            self.used,
            self.limit,
            unit,
            tool_name
        )
    }
}

// ============================================================================
// BudgetLedger：单树根账本
// ============================================================================

struct UsageCore {
    tool_calls: u64,
    tokens_in: u64,
    tokens_out: u64,
}

impl UsageCore {
    fn tokens_total(&self) -> u64 {
        self.tokens_in.saturating_add(self.tokens_out)
    }
}

/// 任务树根账本。树内所有成员（任意深度）的消耗全部归集于此。
///
/// 线程安全：用量临界区极短，用 `std::sync::Mutex`（无跨 await 持锁）；
/// `created_at` 不可变；`active_bindings` 原子计数。
pub struct BudgetLedger {
    root_id: BudgetKey,
    limits: BudgetLimits,
    usage: Mutex<UsageCore>,
    created_at: Instant,
    /// 可序列化创建时间（G08-P2 快照落库用）。
    created_at_unix: i64,
    /// 当前绑定到本树的 worker session 数（轮换判定：>0 时树未枯）。
    active_bindings: AtomicU64,
    /// G08-P2 快照去重指纹（tool_calls, tokens_in, tokens_out）：与上次
    /// 成功落库的快照一致则跳过——超额拦截后的模型重试不再重复写库。
    /// 写库失败不更新指纹（下一次写入点重试）。
    last_snapshot_fingerprint: Mutex<Option<(u64, u64, u64)>>,
}

impl BudgetLedger {
    pub fn new(root_id: BudgetKey, limits: BudgetLimits) -> Self {
        Self {
            root_id,
            limits,
            usage: Mutex::new(UsageCore {
                tool_calls: 0,
                tokens_in: 0,
                tokens_out: 0,
            }),
            created_at: Instant::now(),
            created_at_unix: chrono::Utc::now().timestamp(),
            active_bindings: AtomicU64::new(0),
            last_snapshot_fingerprint: Mutex::new(None),
        }
    }

    /// 从持久快照重建账本（G08-P2 启动恢复）。
    ///
    /// wall_clock 以 `created_at_unix` 为权威锚点推算累计耗时——进程停机
    /// 期间墙钟继续流逝（wall-clock 是真实时间语义），超时的树恢复即
    /// exhausted（随后按既有"耗尽 + 树枯 → 轮换"语义处理，不会被重置成
    /// 有额度的账本继续跑）。时钟回拨时 elapsed 钳 0。
    fn restored(
        root_id: BudgetKey,
        limits: BudgetLimits,
        usage: UsageCore,
        created_at_unix: i64,
    ) -> Self {
        let elapsed_secs = u64::try_from(
            chrono::Utc::now().timestamp().saturating_sub(created_at_unix),
        )
        .unwrap_or(0);
        Self {
            root_id,
            limits,
            usage: Mutex::new(usage),
            created_at: Instant::now()
                .checked_sub(Duration::from_secs(elapsed_secs))
                .unwrap_or_else(Instant::now),
            created_at_unix,
            active_bindings: AtomicU64::new(0),
            last_snapshot_fingerprint: Mutex::new(None),
        }
    }

    pub fn root_id(&self) -> &str {
        &self.root_id
    }

    pub fn limits(&self) -> BudgetLimits {
        self.limits
    }

    pub fn created_at_unix(&self) -> i64 {
        self.created_at_unix
    }

    pub fn active_bindings(&self) -> u64 {
        self.active_bindings.load(Ordering::SeqCst)
    }

    fn lock_usage(&self) -> MutexGuard<'_, UsageCore> {
        self.usage.lock().unwrap_or_else(|poisoned| {
            log::error!("[Budget] Mutex poisoned; recovering inner data");
            poisoned.into_inner()
        })
    }

    fn wall_clock_elapsed(&self) -> Duration {
        self.created_at.elapsed()
    }

    fn wall_clock_exceeded(&self) -> Option<BudgetExceeded> {
        let elapsed = self.wall_clock_elapsed();
        (elapsed > self.limits.max_wall_clock).then(|| BudgetExceeded {
            dimension: BudgetDimension::WallClock,
            used: elapsed.as_secs(),
            limit: self.limits.max_wall_clock.as_secs(),
        })
    }

    /// 剩余量快照（wall_clock 到顶后归零）。
    pub fn remaining(&self) -> BudgetRemaining {
        let usage = self.lock_usage();
        BudgetRemaining {
            tool_calls: self.limits.max_tool_calls.saturating_sub(usage.tool_calls),
            tokens: self.limits.max_tokens.saturating_sub(usage.tokens_total()),
            wall_clock_secs: self
                .limits
                .max_wall_clock
                .as_secs()
                .saturating_sub(self.wall_clock_elapsed().as_secs()),
        }
    }

    /// 当前已用量快照。
    pub fn usage(&self) -> BudgetUsage {
        let usage = self.lock_usage();
        BudgetUsage {
            tool_calls: usage.tool_calls,
            tokens_in: usage.tokens_in,
            tokens_out: usage.tokens_out,
            wall_clock_secs: self.wall_clock_elapsed().as_secs(),
        }
    }

    /// 任一维度到顶（wall_clock 到期 / 用量 >= 上限）。
    pub fn is_exhausted(&self) -> bool {
        if self.wall_clock_exceeded().is_some() {
            return true;
        }
        let usage = self.lock_usage();
        usage.tool_calls >= self.limits.max_tool_calls
            || usage.tokens_total() >= self.limits.max_tokens
    }

    /// 原子扣减：任一维度（含 wall_clock）超限则失败且**全部维度不扣**。
    pub fn try_consume(&self, delta: BudgetDelta) -> Result<BudgetRemaining, BudgetExceeded> {
        if let Some(exceeded) = self.wall_clock_exceeded() {
            return Err(exceeded);
        }
        let mut usage = self.lock_usage();
        let projected_calls = usage.tool_calls.saturating_add(delta.tool_calls);
        let projected_tokens = usage
            .tokens_total()
            .saturating_add(delta.tokens_in)
            .saturating_add(delta.tokens_out);
        if projected_calls > self.limits.max_tool_calls {
            return Err(BudgetExceeded {
                dimension: BudgetDimension::ToolCalls,
                used: usage.tool_calls,
                limit: self.limits.max_tool_calls,
            });
        }
        if projected_tokens > self.limits.max_tokens {
            return Err(BudgetExceeded {
                dimension: BudgetDimension::Tokens,
                used: usage.tokens_total(),
                limit: self.limits.max_tokens,
            });
        }
        usage.tool_calls = projected_calls;
        usage.tokens_in = usage.tokens_in.saturating_add(delta.tokens_in);
        usage.tokens_out = usage.tokens_out.saturating_add(delta.tokens_out);
        drop(usage);
        Ok(self.remaining())
    }

    /// 无条件实报入账（tokens 轮末记账点无法"拒绝已发生的消耗"；入账后
    /// 若越顶，由下一次 `try_consume` 拦截后续调用）。返回入账后剩余快照。
    pub fn record_usage(&self, delta: BudgetDelta) -> BudgetRemaining {
        let mut usage = self.lock_usage();
        usage.tool_calls = usage.tool_calls.saturating_add(delta.tool_calls);
        usage.tokens_in = usage.tokens_in.saturating_add(delta.tokens_in);
        usage.tokens_out = usage.tokens_out.saturating_add(delta.tokens_out);
        drop(usage);
        self.remaining()
    }

    // ── G08-P2 快照辅助 ──────────────────────────────────────────────

    fn lock_snapshot_fingerprint(&self) -> MutexGuard<'_, Option<(u64, u64, u64)>> {
        self.last_snapshot_fingerprint.lock().unwrap_or_else(|poisoned| {
            log::error!("[Budget] snapshot fingerprint Mutex poisoned; recovering");
            poisoned.into_inner()
        })
    }

    /// 快照去重指纹（三维计数；wall_clock 由 created_at_unix 锚点推算，
    /// 不参与指纹）。
    fn snapshot_fingerprint(&self) -> (u64, u64, u64) {
        let usage = self.lock_usage();
        (usage.tool_calls, usage.tokens_in, usage.tokens_out)
    }

    /// 与上次成功落库的快照一致（无需再写）。
    fn snapshot_already_persisted(&self, fingerprint: (u64, u64, u64)) -> bool {
        *self.lock_snapshot_fingerprint() == Some(fingerprint)
    }

    /// 快照成功落库后记录指纹。
    fn mark_snapshot_persisted(&self, fingerprint: (u64, u64, u64)) {
        *self.lock_snapshot_fingerprint() = Some(fingerprint);
    }

    /// 上限的可序列化快照（生成代有效值）。
    fn limits_snapshot(&self) -> BudgetLimitsSnapshot {
        BudgetLimitsSnapshot {
            max_tool_calls: self.limits.max_tool_calls,
            max_tokens: self.limits.max_tokens,
            max_wall_clock_secs: self.limits.max_wall_clock.as_secs(),
        }
    }

    /// 用量的可序列化快照（含 created_at_unix 恢复锚点）。
    fn usage_snapshot(&self) -> BudgetUsageSnapshot {
        let usage = self.lock_usage();
        BudgetUsageSnapshot {
            tool_calls: usage.tool_calls,
            tokens_in: usage.tokens_in,
            tokens_out: usage.tokens_out,
            wall_clock_secs: self.wall_clock_elapsed().as_secs(),
            created_at_unix: self.created_at_unix,
        }
    }
}

// ============================================================================
// reserve 语义：子代理上限 = min(自身 grant 声明, 父剩余)
// ============================================================================

/// 由父账本剩余量与子代理声明计算子的有效预算（收缩语义，非预扣：
/// 子树花费仍实报进同一根账本，先到先得；本快照仅作为 grant 凭证上的
/// 子上限宣告，供审计与 G08-P2 子级独立 enforcement 使用）。
pub fn reserve_child_spec(
    declared: Option<&BudgetSpec>,
    remaining: &BudgetRemaining,
) -> BudgetSpec {
    let shrink_u32 = |declared_opt: Option<u32>, remaining: u64| -> Option<u32> {
        let remaining_clamped = u32::try_from(remaining).unwrap_or(u32::MAX);
        Some(declared_opt.map_or(remaining_clamped, |d| d.min(remaining_clamped)))
    };
    let shrink_u64 = |declared_opt: Option<u64>, remaining: u64| -> Option<u64> {
        Some(declared_opt.map_or(remaining, |d| d.min(remaining)))
    };
    let declared = declared.cloned().unwrap_or_default();
    BudgetSpec {
        max_tool_calls: shrink_u32(declared.max_tool_calls, remaining.tool_calls),
        max_tokens: shrink_u64(declared.max_tokens, remaining.tokens),
        max_wall_clock_seconds: shrink_u64(
            declared.max_wall_clock_seconds,
            remaining.wall_clock_secs,
        ),
    }
}

// ============================================================================
// G08-P2 持久化通道：快照落库 + settings 读取
// ============================================================================
//
// attach/consume/drop 的调用方（pipeline/hooks、workspace_handlers）不携带
// db 句柄且签名冻结，故持久化通道由 `ChatV2Database::new` 启动时注册
// （进程级单例）。全部热路径写入 fail-soft：通道未绑定（单元测试）→ 跳过；
// 写失败 → warn，账本语义不受影响。

static SNAPSHOT_POOL: OnceLock<RwLock<Option<ChatV2Pool>>> = OnceLock::new();
static MAIN_DB_PATH: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

fn snapshot_pool_cell() -> &'static RwLock<Option<ChatV2Pool>> {
    SNAPSHOT_POOL.get_or_init(|| RwLock::new(None))
}

fn main_db_path_cell() -> &'static RwLock<Option<PathBuf>> {
    MAIN_DB_PATH.get_or_init(|| RwLock::new(None))
}

/// 启动装配（`ChatV2Database::new` 调用）：注册快照写入通道（chat_v2 连接
/// 池克隆，与主库连接共享 WAL/busy_timeout 初始化）与主库 settings 路径。
/// 可重复绑定（后绑定覆盖，测试库频繁构造即短暂重绑）；所有经此通道的
/// 读写均 fail-soft，不影响账本判定。
pub fn configure_persistence(chat_v2_pool: ChatV2Pool, main_db_path: PathBuf) {
    *write_lock(main_db_path_cell()) = Some(main_db_path);
    *write_lock(snapshot_pool_cell()) = Some(chat_v2_pool);
}

fn snapshot_pool() -> Option<ChatV2Pool> {
    read_lock(snapshot_pool_cell()).clone()
}

fn main_db_path() -> Option<PathBuf> {
    read_lock(main_db_path_cell()).clone()
}

/// 从主库 settings 表读单个 key。独立短连接 + busy_timeout（settings 读
/// 不在热路径，仅账本创建时一次）；任何失败 → None + warn（解析层回退
/// 默认，见 [`resolve_limits`]）。
pub(crate) fn read_setting_from_main_db(db_path: &Path, key: &str) -> Option<String> {
    let conn = match rusqlite::Connection::open(db_path) {
        Ok(conn) => conn,
        Err(e) => {
            log::warn!(
                "[Budget] 打开主库 settings 失败（{}），key '{}' 回退默认: {}",
                db_path.display(),
                key,
                e
            );
            return None;
        }
    };
    let _ = conn.pragma_update(None, "busy_timeout", 2_000i64);
    match conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
    {
        Ok(value) => value,
        Err(e) => {
            log::warn!(
                "[Budget] 读取 settings key '{}' 失败，回退默认: {}",
                key,
                e
            );
            None
        }
    }
}

/// 当前生效的默认树上限：settings 可配（主库路径已绑定时），否则内置默认。
pub fn effective_limits() -> BudgetLimits {
    match main_db_path() {
        Some(path) => resolve_limits(&|key| read_setting_from_main_db(&path, key)),
        None => BudgetLimits::default(),
    }
}

/// `budget_snapshots.limits_json` 形态（V20260910）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetLimitsSnapshot {
    pub max_tool_calls: u64,
    pub max_tokens: u64,
    pub max_wall_clock_secs: u64,
}

/// `budget_snapshots.usage_json` 形态（V20260910）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetUsageSnapshot {
    pub tool_calls: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    /// 快照时刻已耗时秒数（审计可读性；恢复的权威锚点是 `created_at_unix`）。
    pub wall_clock_secs: u64,
    /// 账本创建锚点（unix 秒）。恢复时据此推算累计耗时（停机期间继续
    /// 计时），超时的树恢复即 exhausted。
    pub created_at_unix: i64,
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 连接级快照 upsert（pool 路径与显式 db 路径共用）。
fn persist_snapshot_conn(
    conn: &rusqlite::Connection,
    ledger: &BudgetLedger,
) -> Result<(), String> {
    let limits_json = serde_json::to_string(&ledger.limits_snapshot())
        .map_err(|e| format!("limits snapshot serialize failed: {e}"))?;
    let usage_json = serde_json::to_string(&ledger.usage_snapshot())
        .map_err(|e| format!("usage snapshot serialize failed: {e}"))?;
    conn.execute(
        "INSERT INTO budget_snapshots (root_id, limits_json, usage_json, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(root_id) DO UPDATE SET
           limits_json = excluded.limits_json,
           usage_json = excluded.usage_json,
           updated_at = excluded.updated_at",
        rusqlite::params![ledger.root_id(), limits_json, usage_json, now_rfc3339()],
    )
    .map_err(|e| format!("budget_snapshots upsert failed (root={}): {e}", ledger.root_id()))?;
    Ok(())
}

/// 显式落库一个账本快照（测试与未来的命令/审计路径用）。
pub fn persist_snapshot(db: &ChatV2Database, ledger: &BudgetLedger) -> Result<(), String> {
    let conn = db
        .get_conn()
        .map_err(|e| format!("budget_snapshots: get conn failed: {e}"))?;
    persist_snapshot_conn(&conn, ledger)
}

/// 热路径 best-effort 快照：通道未绑定 → 静默跳过（单元测试）；指纹一致
/// → 跳过；写失败 → warn 且不记指纹（下一写入点重试）。
fn persist_snapshot_best_effort(ledger: &BudgetLedger) {
    let Some(pool) = snapshot_pool() else {
        return;
    };
    let fingerprint = ledger.snapshot_fingerprint();
    if ledger.snapshot_already_persisted(fingerprint) {
        return;
    }
    let result = pool
        .get()
        .map_err(|e| format!("budget_snapshots: pool get failed: {e}"))
        .and_then(|conn| persist_snapshot_conn(&conn, ledger));
    match result {
        Ok(()) => ledger.mark_snapshot_persisted(fingerprint),
        Err(e) => {
            log::warn!(
                "[Budget] snapshot persist failed (root={}): {}",
                ledger.root_id(),
                e
            );
        }
    }
}

/// `budget_snapshots` 表是否已迁移存在。
fn budget_snapshots_table_exists(conn: &rusqlite::Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='budget_snapshots')",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        == 1
}

/// 启动恢复（`ChatV2Database::new` 调用）：把快照表中仍未完成的任务树
/// 账本恢复到进程内注册表——重启/模型切换/重试不得重置任务累计预算。
///
/// - 已存在于注册表的 root_id 跳过（不覆盖活账本）；
/// - 坏行（JSON 解析失败等）warn 跳过，不让一条脏数据拖垮整个恢复；
/// - 表缺失（未迁移库）debug 跳过；整体 fail-soft 不阻塞启动；
/// - 恢复不回写快照表（恢复后由正常运行路径的写入点继续推进）。
pub fn restore_budget_ledgers_from_db(db: &ChatV2Database) {
    let conn = match db.get_conn() {
        Ok(conn) => conn,
        Err(e) => {
            log::error!("[Budget] 恢复预算快照失败（get conn）: {}", e);
            return;
        }
    };
    if !budget_snapshots_table_exists(&conn) {
        log::debug!("[Budget] budget_snapshots table absent; nothing to restore");
        return;
    }
    let rows = (|| -> Result<Vec<(String, String, String)>, rusqlite::Error> {
        let mut stmt =
            conn.prepare("SELECT root_id, limits_json, usage_json FROM budget_snapshots")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect()
    })();
    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => {
            log::error!("[Budget] 读取 budget_snapshots 失败: {}", e);
            return;
        }
    };
    let mut restored_count = 0usize;
    for (root_id, limits_json, usage_json) in rows {
        let parsed = (|| -> Result<(BudgetLimits, UsageCore, i64), String> {
            let limits: BudgetLimitsSnapshot = serde_json::from_str(&limits_json)
                .map_err(|e| format!("limits_json parse failed: {e}"))?;
            let usage: BudgetUsageSnapshot = serde_json::from_str(&usage_json)
                .map_err(|e| format!("usage_json parse failed: {e}"))?;
            Ok((
                BudgetLimits {
                    max_tool_calls: limits.max_tool_calls,
                    max_tokens: limits.max_tokens,
                    max_wall_clock: Duration::from_secs(limits.max_wall_clock_secs),
                },
                UsageCore {
                    tool_calls: usage.tool_calls,
                    tokens_in: usage.tokens_in,
                    tokens_out: usage.tokens_out,
                },
                usage.created_at_unix,
            ))
        })();
        let (limits, usage, created_at_unix) = match parsed {
            Ok(parsed) => parsed,
            Err(e) => {
                log::warn!(
                    "[Budget] 跳过损坏的预算快照行（root={}）: {}",
                    root_id,
                    e
                );
                continue;
            }
        };
        let mut registry = write_lock(ledgers());
        if registry.contains_key(&root_id) {
            continue;
        }
        let ledger = Arc::new(BudgetLedger::restored(
            root_id.clone(),
            limits,
            usage,
            created_at_unix,
        ));
        log::info!(
            "[Budget] Restored tree ledger from snapshot: root={} (exhausted={})",
            root_id,
            ledger.is_exhausted()
        );
        registry.insert(root_id, ledger);
        restored_count += 1;
    }
    if restored_count > 0 {
        log::info!(
            "[Budget] 启动恢复完成：共恢复 {} 个任务树根账本",
            restored_count
        );
    }
}

// ============================================================================
// 进程内注册表：根账本 + session → 树根绑定
// ============================================================================

static BUDGET_LEDGERS: OnceLock<RwLock<HashMap<BudgetKey, Arc<BudgetLedger>>>> = OnceLock::new();
/// session → (树根 key, 绑定代际 id)。代际 id 单调递增、每代唯一：
/// 同 session 重 run 时 tree_key 通常相同（同一棵树），单靠 key 无法区分
/// 新旧绑定，守卫 drop 的代际判断必须用 binding id（对齐
/// `GrantRegistrationGuard` 的 grant_id 语义）。
static SESSION_TREE_KEYS: OnceLock<RwLock<HashMap<String, (BudgetKey, u64)>>> = OnceLock::new();
static NEXT_BINDING_ID: AtomicU64 = AtomicU64::new(1);

fn ledgers() -> &'static RwLock<HashMap<BudgetKey, Arc<BudgetLedger>>> {
    BUDGET_LEDGERS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn session_tree_keys() -> &'static RwLock<HashMap<String, (BudgetKey, u64)>> {
    SESSION_TREE_KEYS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| {
        log::error!("[Budget] RwLock poisoned during read; recovering inner data");
        poisoned.into_inner()
    })
}

fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|poisoned| {
        log::error!("[Budget] RwLock poisoned during write; recovering inner data");
        poisoned.into_inner()
    })
}

/// 预算门查询：该会话绑定的任务树根 key（未绑定的普通会话 → None，跳过记账）。
pub fn tree_key_for_session(session_id: &str) -> Option<BudgetKey> {
    read_lock(session_tree_keys())
        .get(session_id)
        .map(|(key, _)| key.clone())
}

/// 按根 key 取账本（预算门后的计数句柄；G08-P2 快照/落库同用）。
pub fn ledger_for_tree(key: &BudgetKey) -> Option<Arc<BudgetLedger>> {
    read_lock(ledgers()).get(key).cloned()
}

/// 取或懒建根账本（settings 生效的默认上限）。供门内/测试直接按 key 计数。
pub fn get_or_ensure_ledger(key: &BudgetKey) -> Arc<BudgetLedger> {
    let mut registry = write_lock(ledgers());
    let mut created = false;
    let ledger = registry
        .entry(key.clone())
        .or_insert_with(|| {
            created = true;
            Arc::new(BudgetLedger::new(key.clone(), effective_limits()))
        })
        .clone();
    drop(registry);
    if created {
        // G08-P2 快照写入点：账本创建
        persist_snapshot_best_effort(&ledger);
    }
    ledger
}

/// 自由函数版扣减（hooks 门调用形态：`try_consume(&tree_key, delta)`）。
/// 账本缺失时按 settings 生效的默认上限懒建（防御；正常路径 attach 已建账）。
pub fn try_consume(
    key: &BudgetKey,
    delta: BudgetDelta,
) -> Result<BudgetRemaining, BudgetExceeded> {
    let ledger = get_or_ensure_ledger(key);
    let result = ledger.try_consume(delta);
    if result.is_err() {
        // G08-P2 快照写入点：超额（指纹去重——超额后的模型重试不重复写）
        persist_snapshot_best_effort(&ledger);
    }
    result
}

/// 自由函数版实报入账（tokens 轮末记账点用；G08-P2 接线 tool_loop）。
pub fn record_usage(key: &BudgetKey, delta: BudgetDelta) -> BudgetRemaining {
    let ledger = get_or_ensure_ledger(key);
    let remaining = ledger.record_usage(delta);
    if ledger.is_exhausted() {
        // 实报越顶同样落快照（下一次 try_consume 才拦截，但账本已跨线）
        persist_snapshot_best_effort(&ledger);
    }
    remaining
}

// ============================================================================
// worker 派生接线：attach_child_to_tree
// ============================================================================

/// `attach_child_to_tree` 的产物。
pub struct ChildBudgetAttachment {
    /// 子任务挂上的任务树根 key（父已绑定则复用，否则 = 父会话 id）。
    pub tree_key: BudgetKey,
    /// 子的有效预算（reserve 语义快照），填入 `DelegatedGrant.budget`。
    pub effective_budget: BudgetSpec,
    /// session 绑定守卫：随 worker 管线 drop 解绑（panic/超时同样清理）。
    pub binding: SessionBudgetBindingGuard,
}

/// worker spawn 时把子会话挂到父任务树根账本。
///
/// - `parent_session_id`：父会话 id（tree key 解析入参；父已是树成员
///   → 复用其父的根 key，实现任意深度归集）。
/// - `child_session_id`：worker（子）会话 id，绑定到根 key。
/// - `declared`：子代理声明的预算（per-child 声明维度，现恒 None → 子上限
///   = 父剩余快照；树的**默认总上限**已由 G08-P2 settings 三 key 可配，见
///   [`effective_limits`]）。
///
/// 账本轮换：根账本已耗尽且树上无活跃绑定时，重建新账本（同 key 覆盖），
/// 避免"历史任务耗尽 → 会话永久被拒"。
pub fn attach_child_to_tree(
    parent_session_id: &str,
    child_session_id: &str,
    declared: Option<&BudgetSpec>,
) -> ChildBudgetAttachment {
    // 1. 解析根 key（父绑定优先；否则以父会话为根）。
    let tree_key = tree_key_for_session(parent_session_id)
        .unwrap_or_else(|| parent_session_id.to_string());

    // 2. 取/建/轮换根账本（单写锁内完成判定，防并发双建）。
    let (ledger, created_new) = {
        let mut registry = write_lock(ledgers());
        let reuse = registry
            .get(&tree_key)
            .filter(|existing| {
                !(existing.is_exhausted() && existing.active_bindings() == 0)
            })
            .cloned();
        match reuse {
            Some(existing) => (existing, false),
            None => {
                let fresh = Arc::new(BudgetLedger::new(tree_key.clone(), effective_limits()));
                if registry.insert(tree_key.clone(), fresh.clone()).is_some() {
                    log::info!(
                        "[Budget] Rotated exhausted tree ledger: root={}",
                        tree_key
                    );
                } else {
                    log::debug!(
                        "[Budget] Created tree ledger: root={} (limits: {} calls / {} tokens / {}s)",
                        tree_key,
                        fresh.limits().max_tool_calls,
                        fresh.limits().max_tokens,
                        fresh.limits().max_wall_clock.as_secs()
                    );
                }
                (fresh, true)
            }
        }
    };
    if created_new {
        // G08-P2 快照写入点：账本创建（含轮换重建）。移出注册表写锁之外，
        // 避免 IO 阻塞其他 attach。
        persist_snapshot_best_effort(&ledger);
    }

    // 3. 绑定子 session → 根 key，活跃计数 +1（代际 id 唯一化本次绑定）。
    let binding_id = NEXT_BINDING_ID.fetch_add(1, Ordering::SeqCst);
    write_lock(session_tree_keys())
        .insert(child_session_id.to_string(), (tree_key.clone(), binding_id));
    ledger.active_bindings.fetch_add(1, Ordering::SeqCst);

    let effective_budget = reserve_child_spec(declared, &ledger.remaining());
    log::debug!(
        "[Budget] Attached child session {} to tree {} (effective budget: {:?})",
        child_session_id,
        tree_key,
        effective_budget
    );
    ChildBudgetAttachment {
        tree_key: tree_key.clone(),
        effective_budget,
        binding: SessionBudgetBindingGuard {
            session_id: child_session_id.to_string(),
            tree_key,
            binding_id,
            // 守卫持有账本 Arc：drop 时精确归还活跃计数（即使注册表已轮换）。
            ledger,
        },
    }
}

/// session → 树根绑定守卫。drop 解绑并归还活跃计数——仅当绑定表里仍是
/// **自己这一代**绑定（binding_id 相等）时才移除（同 session 重 run 会
/// 先覆盖绑定，旧守卫 drop 不得误删新一代；语义对齐
/// `GrantRegistrationGuard`）。
pub struct SessionBudgetBindingGuard {
    session_id: String,
    tree_key: BudgetKey,
    binding_id: u64,
    ledger: Arc<BudgetLedger>,
}

impl SessionBudgetBindingGuard {
    pub fn tree_key(&self) -> &str {
        &self.tree_key
    }
}

impl Drop for SessionBudgetBindingGuard {
    fn drop(&mut self) {
        let mut bindings = write_lock(session_tree_keys());
        let is_current_generation = bindings
            .get(&self.session_id)
            .is_some_and(|(_, binding_id)| *binding_id == self.binding_id);
        if is_current_generation {
            bindings.remove(&self.session_id);
        }
        drop(bindings);
        self.ledger.active_bindings.fetch_sub(1, Ordering::SeqCst);
        // G08-P2 快照写入点：worker 绑定解绑（推进最终用量；指纹去重，
        // 无变化时不写）。
        persist_snapshot_best_effort(&self.ledger);
        log::debug!(
            "[Budget] Detached child session {} from tree {}",
            self.session_id,
            self.tree_key
        );
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 带 V20260910 表的临时 chat_v2 库（真实迁移 SQL）。
    /// 构造时表尚不存在，`ChatV2Database::new` 的启动恢复为空操作。
    /// 注意：new() 会把全局快照池/主库路径重绑到本临时库——并行测试的
    /// 热路径快照写入可能落进本库（root_id 均 ULID 唯一），故断言一律
    /// 按"本用例专属 key"查询，绝不断言全表行数。
    fn budget_test_db() -> (tempfile::TempDir, ChatV2Database) {
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

    fn small_limits(max_tool_calls: u64, max_tokens: u64, max_wall_clock: Duration) -> BudgetLimits {
        BudgetLimits {
            max_tool_calls,
            max_tokens,
            max_wall_clock,
        }
    }

    /// G08-P2 settings 解析：合法值覆盖默认；缺失/非法（非数字、0、负、空）
    /// 回退默认。
    #[test]
    fn settings_resolve_limits_valid_and_invalid() {
        // 全部缺失 → 内置默认
        let limits = resolve_limits(&|_| None);
        assert_eq!(limits, BudgetLimits::default());

        // 合法覆盖
        let limits = resolve_limits(&|key| match key {
            SETTING_BUDGET_MAX_TOOL_CALLS => Some("42".to_string()),
            SETTING_BUDGET_MAX_TOKENS => Some("123456".to_string()),
            SETTING_BUDGET_MAX_WALL_CLOCK_SECS => Some("90".to_string()),
            _ => None,
        });
        assert_eq!(limits.max_tool_calls, 42);
        assert_eq!(limits.max_tokens, 123_456);
        assert_eq!(limits.max_wall_clock, Duration::from_secs(90));

        // 非法值逐一回退默认（含 0 / 负数 / 非数字 / 空白）
        for bad in ["abc", "0", "-5", "  ", "1.5"] {
            let limits = resolve_limits(&|key| {
                if key == SETTING_BUDGET_MAX_TOOL_CALLS {
                    Some(bad.to_string())
                } else {
                    None
                }
            });
            assert_eq!(
                limits.max_tool_calls, DEFAULT_MAX_TOOL_CALLS,
                "非法值 {bad:?} 必须回退默认"
            );
            // 其余维度不受污染
            assert_eq!(limits.max_tokens, DEFAULT_MAX_TOKENS);
        }
        // 带空白包裹的合法值可解析
        let limits = resolve_limits(&|key| {
            if key == SETTING_BUDGET_MAX_TOKENS {
                Some("  777  ".to_string())
            } else {
                None
            }
        });
        assert_eq!(limits.max_tokens, 777);
    }

    /// G08-P2 settings 主库读取：真实 mistakes.db 文件 + settings 表。
    /// 缺表/缺 key/坏文件均回退 None（由解析层转默认）。
    #[test]
    fn settings_read_from_main_db_file() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let main_db_path = dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&main_db_path).expect("main db");
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
             INSERT INTO settings (key, value, updated_at)
             VALUES ('headless_budget_max_tool_calls', '55', 't0'),
                    ('headless_budget_max_tokens', 'not-a-number', 't0');",
        )
        .expect("seed settings");
        drop(conn);

        assert_eq!(
            read_setting_from_main_db(&main_db_path, SETTING_BUDGET_MAX_TOOL_CALLS),
            Some("55".to_string())
        );
        // 非法值原样返回（解析层负责回退）
        assert_eq!(
            read_setting_from_main_db(&main_db_path, SETTING_BUDGET_MAX_TOKENS),
            Some("not-a-number".to_string())
        );
        // 缺 key → None
        assert_eq!(
            read_setting_from_main_db(&main_db_path, SETTING_BUDGET_MAX_WALL_CLOCK_SECS),
            None
        );
        // 文件不存在 → None（不 panic）
        assert_eq!(
            read_setting_from_main_db(&dir.path().join("nope.db"), SETTING_BUDGET_MAX_TOKENS),
            None
        );

        // 端到端：以该文件为读取源的解析结果
        let limits = resolve_limits(&|key| read_setting_from_main_db(&main_db_path, key));
        assert_eq!(limits.max_tool_calls, 55);
        assert_eq!(limits.max_tokens, DEFAULT_MAX_TOKENS, "非法值回退默认");
        assert_eq!(limits.max_wall_clock, Duration::from_secs(DEFAULT_MAX_WALL_CLOCK_SECS));
    }

    /// G08-P2 快照 roundtrip：persist → restore → 全局注册表中的账本
    /// 用量/上限与源账本一致（重启不重置累计预算）。
    #[test]
    fn snapshot_persist_and_restore_roundtrip() {
        let (_dir, db) = budget_test_db();
        let root = fresh_key("snap");
        let ledger = BudgetLedger::new(
            root.clone(),
            small_limits(100, 10_000, Duration::from_secs(3600)),
        );
        ledger.try_consume(BudgetDelta::ONE_TOOL_CALL).unwrap();
        ledger.record_usage(BudgetDelta::tokens(300, 200));
        persist_snapshot(&db, &ledger).expect("persist snapshot");

        // "新进程"：从库恢复进全局注册表
        restore_budget_ledgers_from_db(&db);
        let restored = ledger_for_tree(&root).expect("restored ledger must exist");
        assert_eq!(restored.usage().tool_calls, 1);
        assert_eq!(restored.usage().tokens_in, 300);
        assert_eq!(restored.usage().tokens_out, 200);
        assert_eq!(restored.limits().max_tool_calls, 100);
        assert_eq!(restored.limits().max_tokens, 10_000);
        assert_eq!(restored.created_at_unix(), ledger.created_at_unix());

        // 恢复后 continue counting：累计预算不被重置
        restored.try_consume(BudgetDelta::ONE_TOOL_CALL).unwrap();
        assert_eq!(restored.usage().tool_calls, 2);

        // 重复恢复幂等（不覆盖活账本）
        restore_budget_ledgers_from_db(&db);
        assert_eq!(ledger_for_tree(&root).unwrap().usage().tool_calls, 2);
    }

    /// G08-P2 快照恢复后超额状态延续：wall_clock 已超时的树按
    /// created_at_unix 推算耗时，恢复即 exhausted；用量到顶的树同样。
    #[test]
    fn snapshot_restore_preserves_exhaustion() {
        let (_dir, db) = budget_test_db();
        let root_timeout = fresh_key("timeout");
        let root_usedup = fresh_key("usedup");
        let old_unix = chrono::Utc::now().timestamp() - 7200;

        // 直接写快照行：wall-clock 上限 1800s，但创建于 2 小时前
        let conn = db.get_conn().expect("conn");
        conn.execute(
            "INSERT INTO budget_snapshots (root_id, limits_json, usage_json, updated_at)
             VALUES (?1, ?2, ?3, 't0')",
            rusqlite::params![
                root_timeout,
                serde_json::to_string(&BudgetLimitsSnapshot {
                    max_tool_calls: 1000,
                    max_tokens: 10_000_000,
                    max_wall_clock_secs: 1800,
                })
                .unwrap(),
                serde_json::to_string(&BudgetUsageSnapshot {
                    tool_calls: 3,
                    tokens_in: 100,
                    tokens_out: 50,
                    wall_clock_secs: 1800,
                    created_at_unix: old_unix,
                })
                .unwrap(),
            ],
        )
        .unwrap();
        // 用量到顶（tool_calls >= limit），未超时
        conn.execute(
            "INSERT INTO budget_snapshots (root_id, limits_json, usage_json, updated_at)
             VALUES (?1, ?2, ?3, 't0')",
            rusqlite::params![
                root_usedup,
                serde_json::to_string(&BudgetLimitsSnapshot {
                    max_tool_calls: 5,
                    max_tokens: 10_000_000,
                    max_wall_clock_secs: 86_400,
                })
                .unwrap(),
                serde_json::to_string(&BudgetUsageSnapshot {
                    tool_calls: 5,
                    tokens_in: 0,
                    tokens_out: 0,
                    wall_clock_secs: 10,
                    created_at_unix: chrono::Utc::now().timestamp() - 10,
                })
                .unwrap(),
            ],
        )
        .unwrap();
        drop(conn);

        restore_budget_ledgers_from_db(&db);

        let timeout_ledger = ledger_for_tree(&root_timeout).expect("timeout tree restored");
        assert!(
            timeout_ledger.is_exhausted(),
            "超时的树恢复后必须保持 exhausted"
        );
        let err = timeout_ledger
            .try_consume(BudgetDelta::ONE_TOOL_CALL)
            .expect_err("恢复后的超时树必须继续拦截");
        assert_eq!(err.dimension, BudgetDimension::WallClock);
        // 耗时从停机前累计（>= 7200s），未被重启清零
        assert!(timeout_ledger.usage().wall_clock_secs >= 7200);

        let usedup_ledger = ledger_for_tree(&root_usedup).expect("used-up tree restored");
        assert!(usedup_ledger.is_exhausted(), "用量到顶的树恢复后必须保持 exhausted");
        assert!(usedup_ledger.try_consume(BudgetDelta::ONE_TOOL_CALL).is_err());
    }

    /// G08-P2 恢复容错：表缺失 → 空操作；坏行跳过好行恢复。
    #[test]
    fn snapshot_restore_tolerates_missing_table_and_bad_rows() {
        // 表缺失：不 panic、不报错
        let dir = tempfile::TempDir::new().expect("temp dir");
        let db_no_table = ChatV2Database::new(dir.path()).expect("db without table");
        restore_budget_ledgers_from_db(&db_no_table);

        // 坏行跳过
        let (_dir, db) = budget_test_db();
        let good_root = fresh_key("good");
        let conn = db.get_conn().expect("conn");
        conn.execute(
            "INSERT INTO budget_snapshots (root_id, limits_json, usage_json, updated_at)
             VALUES ('root-bad-json', 'not json', '{}', 't0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO budget_snapshots (root_id, limits_json, usage_json, updated_at)
             VALUES (?1, ?2, ?3, 't0')",
            rusqlite::params![
                good_root,
                serde_json::to_string(&BudgetLimitsSnapshot {
                    max_tool_calls: 9,
                    max_tokens: 99,
                    max_wall_clock_secs: 999,
                })
                .unwrap(),
                serde_json::to_string(&BudgetUsageSnapshot {
                    tool_calls: 1,
                    tokens_in: 2,
                    tokens_out: 3,
                    wall_clock_secs: 4,
                    created_at_unix: chrono::Utc::now().timestamp(),
                })
                .unwrap(),
            ],
        )
        .unwrap();
        drop(conn);

        restore_budget_ledgers_from_db(&db);
        assert!(ledger_for_tree(&"root-bad-json".to_string()).is_none());
        let good = ledger_for_tree(&good_root).expect("good row restored");
        assert_eq!(good.usage().tool_calls, 1);
        assert_eq!(good.limits().max_tool_calls, 9);
    }


    fn fresh_key(tag: &str) -> BudgetKey {
        format!("tree_{tag}_{}", ulid::Ulid::new())
    }

    /// 树归集：父 + 两子共一个账本——第一代两 worker 都挂到父会话根，
    /// 经任一子 session 的扣减全部归集到同一根账本。
    #[test]
    fn tree_aggregation_parent_and_two_children_share_one_ledger() {
        let parent = format!("sess_parent_{}", ulid::Ulid::new());
        let child_a = format!("sess_child_a_{}", ulid::Ulid::new());
        let child_b = format!("sess_child_b_{}", ulid::Ulid::new());

        let attach_a = attach_child_to_tree(&parent, &child_a, None);
        let attach_b = attach_child_to_tree(&parent, &child_b, None);

        // 两子同根（根 key = 父会话 id）
        assert_eq!(attach_a.tree_key, parent);
        assert_eq!(attach_b.tree_key, parent);
        assert_eq!(tree_key_for_session(&child_a).as_deref(), Some(parent.as_str()));
        assert_eq!(tree_key_for_session(&child_b).as_deref(), Some(parent.as_str()));

        // 父侧直接消耗 1 次（父作为树成员记账）+ 两子各 1 次 → 同账本该看到 3
        try_consume(&attach_a.tree_key, BudgetDelta::ONE_TOOL_CALL).unwrap();
        let key_a = tree_key_for_session(&child_a).unwrap();
        try_consume(&key_a, BudgetDelta::ONE_TOOL_CALL).unwrap();
        let key_b = tree_key_for_session(&child_b).unwrap();
        try_consume(&key_b, BudgetDelta::ONE_TOOL_CALL).unwrap();

        let ledger = ledger_for_tree(&parent).unwrap();
        assert_eq!(ledger.usage().tool_calls, 3, "父+两子必须归集到同一账本");
        assert_eq!(ledger.active_bindings(), 2);

        drop(attach_a);
        drop(attach_b);
        assert!(tree_key_for_session(&child_a).is_none());
        assert!(tree_key_for_session(&child_b).is_none());
    }

    /// 孙代理归集：worker 已绑定根 T，其子代理 attach 时复用 T。
    #[test]
    fn grandchild_rolls_up_to_same_root() {
        let root_parent = format!("sess_root_{}", ulid::Ulid::new());
        let worker = format!("sess_worker_{}", ulid::Ulid::new());
        let grandchild = format!("sess_grandchild_{}", ulid::Ulid::new());

        let attach_w = attach_child_to_tree(&root_parent, &worker, None);
        let attach_g = attach_child_to_tree(&worker, &grandchild, None);

        assert_eq!(attach_g.tree_key, attach_w.tree_key);
        let key = tree_key_for_session(&grandchild).unwrap();
        try_consume(&key, BudgetDelta::ONE_TOOL_CALL).unwrap();
        assert_eq!(ledger_for_tree(&attach_w.tree_key).unwrap().usage().tool_calls, 1);
    }

    /// 超额 Block 且不扣成负（失败后已用量不变）。
    #[test]
    fn exceed_blocks_without_going_negative() {
        let ledger = BudgetLedger::new(fresh_key("cap"), small_limits(2, 10, Duration::from_secs(60)));
        assert!(ledger.try_consume(BudgetDelta::ONE_TOOL_CALL).is_ok());
        assert!(ledger.try_consume(BudgetDelta::ONE_TOOL_CALL).is_ok());
        let err = ledger
            .try_consume(BudgetDelta::ONE_TOOL_CALL)
            .expect_err("第三次必须被拒");
        assert_eq!(err.dimension, BudgetDimension::ToolCalls);
        assert_eq!(err.used, 2);
        assert_eq!(err.limit, 2);
        // 失败不扣：已用量保持 2，剩余 0
        assert_eq!(ledger.usage().tool_calls, 2);
        assert_eq!(ledger.remaining().tool_calls, 0);

        // tokens 维度同样失败不扣
        let ledger = BudgetLedger::new(fresh_key("tok"), small_limits(100, 10, Duration::from_secs(60)));
        let err = ledger
            .try_consume(BudgetDelta::tokens(8, 8))
            .expect_err("16 > 10 必须被拒");
        assert_eq!(err.dimension, BudgetDimension::Tokens);
        assert_eq!(ledger.usage().tokens_in, 0, "失败不扣（tokens_in 不变）");
        assert_eq!(ledger.usage().tokens_out, 0);

        // record_usage 实报可越顶，但越顶后 try_consume 拦截
        let rem = ledger.record_usage(BudgetDelta::tokens(7, 6));
        assert_eq!(ledger.usage().tokens_in + ledger.usage().tokens_out, 13);
        assert_eq!(rem.tokens, 0);
        assert!(ledger.try_consume(BudgetDelta::ONE_TOOL_CALL).is_err());

        // wall_clock 到顶
        let ledger = BudgetLedger::new(fresh_key("wc"), small_limits(100, 100, Duration::ZERO));
        let err = ledger
            .try_consume(BudgetDelta::ONE_TOOL_CALL)
            .expect_err("wall_clock=0 必须立即到期");
        assert_eq!(err.dimension, BudgetDimension::WallClock);
        assert!(ledger.is_exhausted());
    }

    /// reserve 语义：子上限 = min(声明, 父剩余)；父剩余不足时子上限收缩；
    /// 未声明维度取父剩余快照。
    #[test]
    fn reserve_shrinks_child_cap_when_parent_low() {
        let remaining = BudgetRemaining {
            tool_calls: 50,
            tokens: 100_000,
            wall_clock_secs: 600,
        };
        // 声明超过父剩余 → 收缩到父剩余
        let declared = BudgetSpec {
            max_tool_calls: Some(80),
            max_tokens: Some(500_000),
            max_wall_clock_seconds: Some(300),
        };
        let effective = reserve_child_spec(Some(&declared), &remaining);
        assert_eq!(effective.max_tool_calls, Some(50), "声明 80 > 父剩 50 → 收缩");
        assert_eq!(effective.max_tokens, Some(100_000));
        assert_eq!(effective.max_wall_clock_seconds, Some(300), "声明 300 < 父剩 600 → 保留声明");

        // 未声明 → 全部 = 父剩余快照
        let effective = reserve_child_spec(None, &remaining);
        assert_eq!(effective.max_tool_calls, Some(50));
        assert_eq!(effective.max_tokens, Some(100_000));
        assert_eq!(effective.max_wall_clock_seconds, Some(600));

        // 父剩余 > u32::MAX 时钳到 u32::MAX（不因截断缩小声明）
        let huge = BudgetRemaining {
            tool_calls: u64::MAX,
            tokens: u64::MAX,
            wall_clock_secs: u64::MAX,
        };
        let declared = BudgetSpec {
            max_tool_calls: Some(7),
            max_tokens: None,
            max_wall_clock_seconds: None,
        };
        let effective = reserve_child_spec(Some(&declared), &huge);
        assert_eq!(effective.max_tool_calls, Some(7));
        assert_eq!(effective.max_tokens, Some(u64::MAX));
    }

    /// 子调用计入树：绑定 worker session 后，模拟 tool_pack/ptc 子调用经
    /// 中央准入回到预算门的路径（同一 session 解析根 key 再扣减），
    /// 根账本必须看到子调用计数。
    #[test]
    fn sub_calls_accounted_into_tree() {
        let parent = format!("sess_parent_{}", ulid::Ulid::new());
        let worker = format!("sess_worker_{}", ulid::Ulid::new());
        let attach = attach_child_to_tree(&parent, &worker, None);

        // 模拟：worker 自身 1 次普通调用 + tool_pack 内 3 个子调用 +
        // ptc 内 2 个子调用（子上下文继承 worker session_id → 同一路径）
        let mut consume_as_gate = |session: &str, n: u64| {
            let key = tree_key_for_session(session).expect("worker 必须已绑定");
            for _ in 0..n {
                try_consume(&key, BudgetDelta::ONE_TOOL_CALL).unwrap();
            }
        };
        consume_as_gate(&worker, 1);
        consume_as_gate(&worker, 3);
        consume_as_gate(&worker, 2);

        let ledger = ledger_for_tree(&attach.tree_key).unwrap();
        assert_eq!(ledger.usage().tool_calls, 6, "子调用必须全部计入树根账本");
    }

    /// 并发扣减无竞态：N 线程 × M 次争抢同一账本，成功数恰好等于上限，
    /// 已用量精确等于上限（不超、不少、不负）。
    #[test]
    fn concurrent_consume_is_race_free() {
        const THREADS: u64 = 8;
        const PER_THREAD: u64 = 50;
        const LIMIT: u64 = 200;
        let ledger = Arc::new(BudgetLedger::new(
            fresh_key("race"),
            small_limits(LIMIT, u64::MAX, Duration::from_secs(3600)),
        ));
        let successes = AtomicU64::new(0);
        std::thread::scope(|scope| {
            for _ in 0..THREADS {
                let ledger = ledger.clone();
                let successes = &successes;
                scope.spawn(move || {
                    for _ in 0..PER_THREAD {
                        if ledger.try_consume(BudgetDelta::ONE_TOOL_CALL).is_ok() {
                            successes.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                });
            }
        });
        assert_eq!(successes.load(Ordering::SeqCst), LIMIT);
        assert_eq!(ledger.usage().tool_calls, LIMIT);
        assert_eq!(ledger.remaining().tool_calls, 0);
        // 400 次尝试只放行 200 次，超限后再试仍失败且不改变用量
        assert!(ledger.try_consume(BudgetDelta::ONE_TOOL_CALL).is_err());
        assert_eq!(ledger.usage().tool_calls, LIMIT);
    }

    /// 守卫代际语义：同 session 重 run 覆盖绑定后，旧守卫 drop 不误删
    /// 新一代绑定；活跃计数精确归还。
    #[test]
    fn binding_guard_respects_generation() {
        let parent = format!("sess_parent_{}", ulid::Ulid::new());
        let worker = format!("sess_worker_{}", ulid::Ulid::new());

        let attach1 = attach_child_to_tree(&parent, &worker, None);
        let attach2 = attach_child_to_tree(&parent, &worker, None);
        assert_eq!(attach1.tree_key, attach2.tree_key);
        let ledger = ledger_for_tree(&parent).unwrap();
        assert_eq!(ledger.active_bindings(), 2);

        drop(attach1); // 旧一代：不得误删 attach2 的绑定
        assert!(tree_key_for_session(&worker).is_some());
        assert_eq!(ledger.active_bindings(), 1);

        drop(attach2.binding); // 当前一代：正常解绑
        assert!(tree_key_for_session(&worker).is_none());
        assert_eq!(ledger.active_bindings(), 0);
    }

    /// 账本轮换：耗尽 + 树枯（无活跃绑定）时 attach 重建新账本；
    /// 仍有活跃绑定时不轮换（在跑 worker 继续被旧账本拦截）。
    #[test]
    fn exhausted_and_idle_ledger_rotates_on_next_attach() {
        let parent = format!("sess_parent_{}", ulid::Ulid::new());
        let child1 = format!("sess_child1_{}", ulid::Ulid::new());
        let attach1 = attach_child_to_tree(&parent, &child1, None);
        let ledger1 = ledger_for_tree(&parent).unwrap();
        // 手动打爆账本（默认上限 200）
        for _ in 0..DEFAULT_MAX_TOOL_CALLS {
            ledger1.try_consume(BudgetDelta::ONE_TOOL_CALL).unwrap();
        }
        assert!(ledger1.is_exhausted());

        // 树未枯（attach1 存活）→ 不轮换
        let child2 = format!("sess_child2_{}", ulid::Ulid::new());
        let attach2 = attach_child_to_tree(&parent, &child2, None);
        assert!(std::ptr::eq(
            ledger_for_tree(&parent).unwrap().as_ref(),
            ledger1.as_ref()
        ));
        // 新子代即刻被旧账本拦截（额度确已耗尽）
        let key2 = tree_key_for_session(&child2).unwrap();
        assert!(try_consume(&key2, BudgetDelta::ONE_TOOL_CALL).is_err());

        drop(attach1);
        drop(attach2);
        assert_eq!(ledger1.active_bindings(), 0);

        // 树枯 + 耗尽 → 轮换：新账本从零起算
        let child3 = format!("sess_child3_{}", ulid::Ulid::new());
        let attach3 = attach_child_to_tree(&parent, &child3, None);
        let ledger3 = ledger_for_tree(&parent).unwrap();
        assert!(!std::ptr::eq(ledger3.as_ref(), ledger1.as_ref()));
        assert_eq!(ledger3.usage().tool_calls, 0);
        let key3 = tree_key_for_session(&child3).unwrap();
        assert!(try_consume(&key3, BudgetDelta::ONE_TOOL_CALL).is_ok());
        drop(attach3);
    }

    /// 超额消息必须含「任务树预算已耗尽」+ 已用量/上限（供模型体面收尾）。
    #[test]
    fn exceeded_message_is_explicit() {
        let err = BudgetExceeded {
            dimension: BudgetDimension::ToolCalls,
            used: 200,
            limit: 200,
        };
        let msg = err.message("builtin-web_search");
        assert!(msg.contains("任务树预算已耗尽"));
        assert!(msg.contains("200 / 上限 200"));
        assert!(msg.contains("builtin-web_search"));
        assert!(msg.contains("最终回答"));
        let wc = BudgetExceeded {
            dimension: BudgetDimension::WallClock,
            used: 1801,
            limit: 1800,
        };
        assert!(wc.message("t").contains("运行时长"));
    }
}
