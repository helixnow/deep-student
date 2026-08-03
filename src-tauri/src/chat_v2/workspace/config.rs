pub const MAX_INBOX_SIZE: usize = 100;
pub const MAX_MESSAGES_PER_INJECTION: usize = 10;
pub const INJECTION_COOLDOWN_MS: u64 = 50;
pub const DEFAULT_HISTORY_INJECTION_COUNT: usize = 10;
pub const MAX_AGENTS_PER_WORKSPACE: usize = 10;
pub const MAX_WORKSPACE_MESSAGE_RATE_PER_MINUTE: usize = 100;
pub const INBOX_DRAIN_BATCH_SIZE: usize = 10;
/// Agent 执行失败后的最大重试次数（超过则不再重新入队）
pub const MAX_AGENT_RETRY_ATTEMPTS: u32 = 3;
/// Worker 管线整体 wall-clock 硬超时（秒），对齐 headless 的 600s 上限
pub const WORKER_PIPELINE_TIMEOUT_SECS: u64 = 600;
/// 超时取消后给管线保存部分结果的收尾窗口（秒）
pub const WORKER_PIPELINE_CANCEL_GRACE_SECS: u64 = 30;
/// 同时运行的 worker 管线数量上限（跨工作区；按嵌套深度分池，每层各此上限，
/// 见 workspace_handlers::worker_pipeline_semaphore_for_depth 的防饥饿说明）
pub const MAX_CONCURRENT_WORKERS: usize = 4;
/// 子代理递归嵌套的最大深度（fail-closed：深度检查失败时拒绝创建）
pub const MAX_SUBAGENT_DEPTH: u32 = 3;
/// subagent_call 阻塞等待子代理终态的总预算（秒）：
/// worker 管线 600s 硬超时 + 30s 取消收尾窗口 + 120s 调度排队余量
pub const SUBAGENT_WAIT_BUDGET_SECS: u64 = 750;
