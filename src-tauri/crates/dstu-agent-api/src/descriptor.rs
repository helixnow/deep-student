//! 工具描述符：名字/别名、块类型、超时与 headless/PTC/审批策略的显式声明。
//!
//! 不迁移 `chat_v2::tool_descriptors` 的 344 条内建表；这里只定义类型，供
//! `LegacyToolProvider` 与各域 provider 声明自己拥有的条目。

use dstu_core::agent::block_types;

use crate::executor::ToolSensitivity;

/// 工具超时（`None` = 不设外层超时，供看门狗豁免类工具使用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolTimeout {
    /// 不设置外层超时。
    #[default]
    None,
    /// 以秒为单位的外层超时。
    Secs(u64),
}

/// headless（无前端）运行时的准入策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HeadlessPolicy {
    /// headless 下禁止调用。
    #[default]
    Blocked,
    /// headless 下只读调用。
    ReadOnly,
    /// headless 下完全允许。
    Allowed,
}

/// PTC（程序化工具组合）准入策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PtcPolicy {
    /// 禁止在 PTC 脚本中调用。
    #[default]
    Denied,
    /// 允许只读调用。
    ReadOnly,
    /// 允许写调用。
    Write,
}

/// 审批策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalPolicy {
    /// 不需要用户确认。
    Never,
    /// 需要按 scope 类别审批（迁移期保留 precise / never_remember 语义位）。
    Scoped {
        /// 审批 scope 类别（如 `note` / `qbank` / `skill_install`）。
        scope_kind: &'static str,
        /// 是否要求精确 scope（不能用宽泛授权跳过）。
        precise: bool,
        /// 是否禁止「记住本次授权」。
        never_remember: bool,
    },
}

impl Default for ApprovalPolicy {
    fn default() -> Self {
        Self::Scoped {
            scope_kind: "tool",
            precise: false,
            never_remember: false,
        }
    }
}

/// 工具描述符（provider 声明的最小集合）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolDescriptor {
    /// 裸工具名（无 `builtin-` 前缀）。
    pub name: &'static str,
    /// 历史 wire 名/别名（`builtin-`、`workspace_`、`mcp_` 等），显式列出。
    pub aliases: &'static [&'static str],
    /// 前端块类型（`block_types::*`）。
    pub block_type: &'static str,
    /// 外层超时。
    pub timeout: ToolTimeout,
    /// headless 准入。
    pub headless: HeadlessPolicy,
    /// PTC 准入。
    pub ptc: PtcPolicy,
    /// 审批策略。
    pub approval: ApprovalPolicy,
    /// 名字级敏感基线（参数级动态分级仍以 executor 的 `sensitivity_level_for_call` 为准）。
    pub sensitivity: ToolSensitivity,
}

impl ToolDescriptor {
    /// 以保守默认值创建一个 descriptor（block_type = `mcp_tool`，需审批）。
    pub const fn new(name: &'static str) -> Self {
        Self {
            name,
            aliases: &[],
            block_type: block_types::MCP_TOOL,
            timeout: ToolTimeout::None,
            headless: HeadlessPolicy::Blocked,
            ptc: PtcPolicy::Denied,
            approval: ApprovalPolicy::Scoped {
                scope_kind: "tool",
                precise: false,
                never_remember: false,
            },
            sensitivity: ToolSensitivity::Low,
        }
    }

    /// 声明别名（含历史 wire 名）。
    pub const fn with_aliases(mut self, aliases: &'static [&'static str]) -> Self {
        self.aliases = aliases;
        self
    }

    /// 声明前端块类型。
    pub const fn with_block_type(mut self, block_type: &'static str) -> Self {
        self.block_type = block_type;
        self
    }

    /// 声明外层超时。
    pub const fn with_timeout(mut self, timeout: ToolTimeout) -> Self {
        self.timeout = timeout;
        self
    }

    /// 声明 headless 准入。
    pub const fn with_headless(mut self, headless: HeadlessPolicy) -> Self {
        self.headless = headless;
        self
    }

    /// 声明 PTC 准入。
    pub const fn with_ptc(mut self, ptc: PtcPolicy) -> Self {
        self.ptc = ptc;
        self
    }

    /// 声明审批策略。
    pub const fn with_approval(mut self, approval: ApprovalPolicy) -> Self {
        self.approval = approval;
        self
    }

    /// 声明名字级敏感基线。
    pub const fn with_sensitivity(mut self, sensitivity: ToolSensitivity) -> Self {
        self.sensitivity = sensitivity;
        self
    }

    /// 该 descriptor 声明的全部名字（主名 + 别名）。
    pub fn names(&self) -> impl Iterator<Item = &'static str> + '_ {
        std::iter::once(self.name).chain(self.aliases.iter().copied())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_names_include_primary_and_aliases_in_order() {
        let descriptor = ToolDescriptor::new("workspace_file_read").with_aliases(&[
            "builtin-workspace_file_read",
            "workspace_workspace_file_read",
        ]);
        let names: Vec<_> = descriptor.names().collect();
        assert_eq!(
            names,
            vec![
                "workspace_file_read",
                "builtin-workspace_file_read",
                "workspace_workspace_file_read"
            ]
        );
    }

    #[test]
    fn descriptor_defaults_are_conservative() {
        let descriptor = ToolDescriptor::new("demo");
        assert_eq!(descriptor.block_type, block_types::MCP_TOOL);
        assert_eq!(descriptor.timeout, ToolTimeout::None);
        assert_eq!(descriptor.headless, HeadlessPolicy::Blocked);
        assert_eq!(descriptor.ptc, PtcPolicy::Denied);
        assert_eq!(descriptor.sensitivity, ToolSensitivity::Low);
        assert!(matches!(descriptor.approval, ApprovalPolicy::Scoped { .. }));
    }
}
