//! Connector provider 抽象（G04-P1）：第一个真实 provider 纵向打通。
//!
//! G04-P0 把 connector 操作状态机持久化到账本（`connector_ledger`），但
//! provider 侧全部是 mock/空实现。本模块定义真实 provider 的统一契约
//! [`ConnectorProvider`]，并给出第一个自包含实现
//! [`webhook::WebhookProvider`]（generic HTTPS webhook + HMAC-SHA256 签名）。
//!
//! ## 契约要点
//! - `submit`：把已确认的操作发往 provider，返回 [`ProviderReceipt`]。
//! - `lookup`：按系统幂等键查询远端是否已有该操作的记录——启动对账
//!   （`reconcile`）据此把 `outcome_unknown` 核销为 committed/failed，
//!   查询失败或不确定时**保持原状**（不误判）。
//! - 错误分类 [`ProviderErrorKind`]：
//!   - `Transient`：网络/超时/5xx/429——携带同一幂等键重试是安全的；
//!   - `Permanent`：4xx/配置缺失/白名单拒绝——明确失败，重试无意义；
//!   - `Unknown`：请求很可能已落地但回执不可读（如 2xx 超大/畸形响应）——
//!     禁止盲目重试，交给 lookup 对账。
//!
//! ## 卫生约束
//! provider 实现读取的 secret 只允许来自 settings 安全通道
//! （`Database::get_secret`，N06 strict 语义：读失败即报错，绝不回退），
//! 不落账本、不进日志（详见 webhook 模块的脱敏说明）。

use async_trait::async_trait;
use serde_json::Value;

pub mod webhook;

/// webhook provider 在 connector registry 中的 `provider` 字段值。
pub const WEBHOOK_PROVIDER_KIND: &str = "webhook";

/// provider 错误的三分分类（决定账本状态如何收敛）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderErrorKind {
    /// 瞬时错误（网络/超时/5xx/429）：携带同一幂等键重试是安全的。
    Transient,
    /// 永久错误（4xx/配置缺失/白名单拒绝）：重试无意义。
    Permanent,
    /// 结果未知（请求很可能已落地但回执不可读）：禁止盲目重试，
    /// 必须经 `lookup` 对账核销。
    Unknown,
}

impl ProviderErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transient => "transient",
            Self::Permanent => "permanent",
            Self::Unknown => "unknown",
        }
    }
}

/// provider 调用错误。`message` 必须已脱敏（不含 secret/签名材料）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderError {
    pub kind: ProviderErrorKind,
    pub message: String,
}

impl ProviderError {
    pub fn transient(message: impl Into<String>) -> Self {
        Self {
            kind: ProviderErrorKind::Transient,
            message: message.into(),
        }
    }

    pub fn permanent(message: impl Into<String>) -> Self {
        Self {
            kind: ProviderErrorKind::Permanent,
            message: message.into(),
        }
    }

    pub fn unknown(message: impl Into<String>) -> Self {
        Self {
            kind: ProviderErrorKind::Unknown,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind.as_str(), self.message)
    }
}

impl std::error::Error for ProviderError {}

/// 发往 provider 的一次操作调用。`body` 是完整请求载荷（由 executor 从
/// 已确认的 draft preview 重建，含幂等键）；`request_payload_hash` 由
/// 调用方对 `body` 另行计算并落账本。
#[derive(Debug, Clone)]
pub struct ProviderOperation {
    pub operation_id: String,
    /// 系统幂等键（draft 时生成，账本持久化）；provider 侧据此去重。
    pub idempotency_key: String,
    /// 规范动作名（`"<capability>:<action>"`，如 `mail:send`）。
    pub action: String,
    /// 完整请求体（webhook provider 将其原样作为 JSON POST body）。
    pub body: Value,
}

/// `submit` 成功的回执（已脱敏；不含 secret/签名材料）。
#[derive(Debug, Clone)]
pub struct ProviderReceipt {
    /// provider 侧的外部对象/操作 id（persist 到账本 `external_operation_id`）。
    pub external_operation_id: Option<String>,
    /// provider 返回的结果正文（作为 commit evidence 的 provider_result）。
    pub result: Value,
}

/// `lookup` 命中时 provider 报告的最终结果。
#[derive(Debug, Clone)]
pub struct ProviderOutcome {
    pub external_operation_id: Option<String>,
    /// provider 记录的回执摘要（写入 reconcile 证据）。
    pub receipt: Value,
}

/// provider 返回值中的外部对象 id（committed 时持久化到账本
/// `external_operation_id`，供 provider lookup reconcile 使用）。
/// 这是各 provider 通用的宽松提取启发式，executor 与 webhook 共用。
pub fn extract_external_operation_id(provider_result: &Value) -> Option<String> {
    [
        "id",
        "object_id",
        "objectId",
        "event_id",
        "eventId",
        "message_id",
        "messageId",
    ]
    .iter()
    .find_map(|key| provider_result.get(key).and_then(Value::as_str))
    .map(str::to_string)
}

/// 真实 connector provider 的统一契约（G04-P2 的 OAuth SaaS provider
/// 也实现本 trait；registry 按 `provider` 字段分发）。
#[async_trait]
pub trait ConnectorProvider: Send + Sync {
    /// provider 名（账本/日志标识用，不含 secret）。
    fn name(&self) -> &str;

    /// 提交一次操作。幂等键在 `op.idempotency_key`，provider 必须对
    /// 重复键去重（返回既有结果而非二次执行）。
    async fn submit(&self, op: &ProviderOperation) -> Result<ProviderReceipt, ProviderError>;

    /// 按幂等键查询远端结果。`Ok(None)` = provider 确认无此记录
    /// （never_submitted）；`Err(_)` = 查询失败/不确定（调用方不得据此
    /// 改变账本状态）。
    async fn lookup(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<ProviderOutcome>, ProviderError>;
}
