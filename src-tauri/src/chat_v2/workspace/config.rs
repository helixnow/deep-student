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
/// 同时运行的 worker 管线数量上限（全局，跨工作区）
pub const MAX_CONCURRENT_WORKERS: usize = 4;
