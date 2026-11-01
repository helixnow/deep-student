//! Multi-agent Phase 2（QAAgent 只读卡面）：workspace coordinator 只读作用域注册表。
//!
//! 默认所有权模型是「会话独占」：任何 chatanki 工具只能触到 `ctx.session_id`
//! 自己拥有的文档。Phase 2 为**只读**卡面工具（get_cards / status）开一个
//! 唯一豁免：worker 会话若被后端运行时（`run_workspace_agent_backend`）安装了
//! 「同 workspace coordinator 只读作用域」，则可以读取该 coordinator 会话
//! 完整拥有的文档。
//!
//! 注册表（`WORKSPACE_CARD_READ_SCOPES`）全进程**只有这一份**：worker 启动路径
//! （`handlers::workspace_handlers`）在这里安装/撤销，chatanki 执行器从这里只读
//! 查询（`chatanki_executor` 以 `pub use` 重导出安装入口），不得另存副本，否则
//! worker 读作用域会失效。
//!
//! fail-closed 论证：
//! 1. 作用域只能由后端 worker 启动路径安装（`install_workspace_card_read_scope`
//!    仅在 handlers 内调用，模型工具无法触达），并以 RAII guard 绑定 worker
//!    管线生命周期——管线结束即撤销，普通交互会话永远查不到作用域；
//! 2. 每个 worker 会话至多映射到**一个** coordinator 会话；跨 workspace 的
//!    文档因不属于该 coordinator 而继续得到 `statusNotFound`（不泄露存在性）；
//! 3. 豁免只进入读路径（chatanki `resolve_chatanki_read_session` 只被
//!    get_cards / status 调用）；全部写路径仍直接用 `ctx.session_id` 走原有
//!    所有权检查，worker 对 coordinator 文档的写入照旧被拒；
//! 4. 任何一步失败（空 id、自映射、锁异常、文档混合归属）都回到默认拒绝。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// worker 会话 → 同 workspace coordinator 的只读作用域。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceCardReadScope {
    pub workspace_id: String,
    pub coordinator_session_id: String,
}

static WORKSPACE_CARD_READ_SCOPES: OnceLock<Mutex<HashMap<String, WorkspaceCardReadScope>>> =
    OnceLock::new();

fn lock_workspace_card_read_scopes(
) -> std::sync::MutexGuard<'static, HashMap<String, WorkspaceCardReadScope>> {
    WORKSPACE_CARD_READ_SCOPES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| {
            log::error!("[ChatAnkiToolExecutor] card read scope registry poisoned; recovering");
            poisoned.into_inner()
        })
}

/// RAII 守卫：drop 时撤销 worker 会话的只读作用域（管线正常结束 / 取消 /
/// 超时 / panic 均触发），保证作用域寿命 ≤ worker 管线寿命。
pub struct WorkspaceCardReadScopeGuard {
    worker_session_id: String,
}

impl Drop for WorkspaceCardReadScopeGuard {
    fn drop(&mut self) {
        lock_workspace_card_read_scopes().remove(&self.worker_session_id);
    }
}

/// 为 worker 会话安装「同 workspace coordinator 文档可读」的只读作用域。
///
/// 仅供后端 worker 启动路径（`run_workspace_agent_backend`）调用；
/// fail-closed：任一 id 为空或 worker 即 coordinator（自映射无意义且可能
/// 掩盖上游解析错误）都拒绝安装。
pub fn install_workspace_card_read_scope(
    worker_session_id: &str,
    workspace_id: &str,
    coordinator_session_id: &str,
) -> Result<WorkspaceCardReadScopeGuard, String> {
    let worker_session_id = worker_session_id.trim();
    let workspace_id = workspace_id.trim();
    let coordinator_session_id = coordinator_session_id.trim();
    if worker_session_id.is_empty() || workspace_id.is_empty() || coordinator_session_id.is_empty()
    {
        return Err("workspace card read scope requires non-empty ids".to_string());
    }
    if worker_session_id == coordinator_session_id {
        return Err(
            "workspace card read scope must map a worker to a distinct coordinator session"
                .to_string(),
        );
    }
    lock_workspace_card_read_scopes().insert(
        worker_session_id.to_string(),
        WorkspaceCardReadScope {
            workspace_id: workspace_id.to_string(),
            coordinator_session_id: coordinator_session_id.to_string(),
        },
    );
    log::info!(
        "[ChatAnkiToolExecutor] installed workspace card read scope: worker={}, workspace={}, coordinator={}",
        worker_session_id,
        workspace_id,
        coordinator_session_id
    );
    Ok(WorkspaceCardReadScopeGuard {
        worker_session_id: worker_session_id.to_string(),
    })
}

/// 查询会话当前安装的只读作用域（未安装返回 `None`）。
pub fn workspace_card_read_scope(session_id: &str) -> Option<WorkspaceCardReadScope> {
    lock_workspace_card_read_scopes().get(session_id).cloned()
}
