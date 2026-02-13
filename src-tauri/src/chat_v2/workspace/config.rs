pub const MAX_INBOX_SIZE: usize = 100;
pub const MAX_MESSAGES_PER_INJECTION: usize = 10;
pub const INJECTION_COOLDOWN_MS: u64 = 50;
pub const DEFAULT_HISTORY_INJECTION_COUNT: usize = 10;
pub const MAX_AGENTS_PER_WORKSPACE: usize = 10;
pub const MAX_WORKSPACE_MESSAGE_RATE_PER_MINUTE: usize = 100;
pub const INBOX_DRAIN_BATCH_SIZE: usize = 10;
/// Agent 执行失败后的最大重试次数（超过则不再重新入队）
pub const MAX_AGENT_RETRY_ATTEMPTS: u32 = 3;
