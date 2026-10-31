//! 工具提供者（provider）：显式声明自己拥有的 descriptor 与 executor 花名册。
//!
//! 名字 → executor 的映射是显式数据，不再依赖 `can_handle` 顺序 +
//! `strip_tool_namespace` 的隐式协议。

use std::fmt;
use std::sync::Arc;

use serde_json::Value;

use crate::descriptor::ToolDescriptor;
use crate::executor::ToolExecutor;

/// provider 标识（注册表用于冲突报错与顺序快照）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProviderId(&'static str);

impl ProviderId {
    /// 由静态字符串构造。
    pub const fn new(id: &'static str) -> Self {
        Self(id)
    }

    /// 取得内部字符串。
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

impl From<&'static str> for ProviderId {
    fn from(value: &'static str) -> Self {
        Self(value)
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

/// 工具提供者契约。
///
/// `executor(name)` 必须覆盖 [`ToolProvider::descriptors`] 声明的每个 name 与
/// alias；注册表 build 时逐项校验。
pub trait ToolProvider: Send + Sync {
    /// provider 标识（同一注册表内唯一）。
    fn id(&self) -> ProviderId;

    /// 该 provider 拥有的全部工具描述。启动时只调用一次。
    fn descriptors(&self) -> Vec<ToolDescriptor>;

    /// name/alias -> executor。
    fn executor(&self, tool_name: &str) -> Option<Arc<dyn ToolExecutor>>;

    /// 用于花名册/顺序快照；顺序即 provider 内注册顺序。
    fn executors(&self) -> Vec<Arc<dyn ToolExecutor>>;

    /// headless 精简 schema（可选）。
    fn headless_schemas(&self) -> Vec<Value> {
        Vec::new()
    }

    /// 仅 General/MCP 这类兜底 provider 返回 true。
    fn is_catch_all(&self) -> bool {
        false
    }
}
