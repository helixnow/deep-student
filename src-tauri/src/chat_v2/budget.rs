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
//! # 进程内语义（P1）
//!
//! 账本与绑定均为进程内 static。TODO(G08-P2)：
//! - 默认预算值接入 settings 可配（对齐 headless `max_tool_rounds` 词汇）；
//! - 预算快照落库（重启可审计；`BudgetLedger::usage` / `remaining` 即快照源）；
//! - token 记账接线：tool_loop 流式轮末的既有汇总点调 [`record_usage`]
//!   （tool_loop.rs 不在 G08 所有权内，P1 仅备好 API；wall_clock 与
//!   tool_calls 已在 hooks 门生效）；
//! - 注册表生命周期（LRU/TTL 清理；当前随会话规模缓慢增长）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant};

use super::grants::BudgetSpec;

// ============================================================================
// 默认预算（TODO(G08-P2)：settings 可配）
// ============================================================================

/// 单树默认工具调用上限（整棵树所有成员共享）。
pub const DEFAULT_MAX_TOOL_CALLS: u64 = 200;
/// 单树默认 token 上限（in + out 合并计）。
pub const DEFAULT_MAX_TOKENS: u64 = 2_000_000;
/// 单树默认 wall-clock 上限（账本创建起算）。
pub const DEFAULT_MAX_WALL_CLOCK_SECS: u64 = 30 * 60;

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

/// 取或懒建根账本（默认上限）。供门内/测试直接按 key 计数。
pub fn get_or_ensure_ledger(key: &BudgetKey) -> Arc<BudgetLedger> {
    let mut registry = write_lock(ledgers());
    registry
        .entry(key.clone())
        .or_insert_with(|| Arc::new(BudgetLedger::new(key.clone(), BudgetLimits::default())))
        .clone()
}

/// 自由函数版扣减（hooks 门调用形态：`try_consume(&tree_key, delta)`）。
/// 账本缺失时按默认上限懒建（防御；正常路径 attach 已建账）。
pub fn try_consume(
    key: &BudgetKey,
    delta: BudgetDelta,
) -> Result<BudgetRemaining, BudgetExceeded> {
    get_or_ensure_ledger(key).try_consume(delta)
}

/// 自由函数版实报入账（tokens 轮末记账点用；G08-P2 接线 tool_loop）。
pub fn record_usage(key: &BudgetKey, delta: BudgetDelta) -> BudgetRemaining {
    get_or_ensure_ledger(key).record_usage(delta)
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
/// - `declared`：子代理声明的预算（G08-P2 settings/profile 可配；现恒
///   None → 子上限 = 父剩余快照）。
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
    let ledger = {
        let mut registry = write_lock(ledgers());
        let reuse = registry
            .get(&tree_key)
            .filter(|existing| {
                !(existing.is_exhausted() && existing.active_bindings() == 0)
            })
            .cloned();
        match reuse {
            Some(existing) => existing,
            None => {
                let fresh = Arc::new(BudgetLedger::new(tree_key.clone(), BudgetLimits::default()));
                if registry.insert(tree_key.clone(), fresh.clone()).is_some() {
                    log::info!(
                        "[Budget] Rotated exhausted tree ledger: root={}",
                        tree_key
                    );
                } else {
                    log::debug!(
                        "[Budget] Created tree ledger: root={} (limits: {} calls / {} tokens / {}s)",
                        tree_key,
                        DEFAULT_MAX_TOOL_CALLS,
                        DEFAULT_MAX_TOKENS,
                        DEFAULT_MAX_WALL_CLOCK_SECS
                    );
                }
                fresh
            }
        }
    };

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

    fn small_limits(max_tool_calls: u64, max_tokens: u64, max_wall_clock: Duration) -> BudgetLimits {
        BudgetLimits {
            max_tool_calls,
            max_tokens,
            max_wall_clock,
        }
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
