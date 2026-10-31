//! 恢复域账本（restore domain ledger）的稳定错误码与前端可见状态字面量。
//!
//! 本模块只承载字面量契约，不含任何恢复逻辑：
//! - 恢复协调侧（`migration/coordinator.rs`、`backup/mod.rs`、`commands_restore.rs`）
//!   在拒绝/失败消息中以 `[CODE] 说明` 前缀携带这些稳定码；
//! - 前端展示层（`src/features/settings/components/data-governance/localizeCloudError.ts`
//!   与 `DataGovernanceDashboard.tsx` 的 `localizeBackupJobError`）按稳定码/子串
//!   映射到 i18n 文案（`cloudStorage:errors.*` / `data:governance.*`）。
//!
//! ## 字面量稳定性约束
//!
//! 下列字符串是跨进程契约（Rust 错误消息 → Tauri command error → 前端 i18n 映射
//! → 审计日志检索），一经发布不得改动拼写。新增语义请新增稳定码，不要复用。

/// 恢复域账本存在「已断言但未被任何恢复器消费」的域（未消费断言）。
///
/// 语义：备份清单 coverage 中声明为需要恢复的域，在恢复流水线结束时没有任何
/// 恢复器登记消费。此时禁止提交切槽——静默丢域比失败更危险，必须 fail-closed。
pub const RESTORE_DOMAIN_UNCONSUMED_CODE: &str = "E_RESTORE_DOMAIN_UNCONSUMED";

/// 恢复域账本中某个域的恢复器显式登记了失败。
///
/// 语义：域被消费了，但消费结果为失败（例如密钥域解封失败、工作区库校验不过）。
/// 与 `E_RESTORE_DOMAIN_UNCONSUMED` 区分：前者是"没人处理"，本码是"处理了但失败"。
pub const RESTORE_DOMAIN_FAILED_CODE: &str = "E_RESTORE_DOMAIN_FAILED";

/// 恢复载荷来源不可信，已被放入隔离区等待用户信任确认，未进入数据槽。
///
/// 语义：恢复没有失败也没有丢数据——载荷完整落盘在隔离区，但在用户显式建立
/// 信任之前不会激活。前端应把它展示为可操作的隔离态而不是普通错误。
pub const RESTORE_UNTRUSTED_ISOLATED_CODE: &str = "E_RESTORE_UNTRUSTED_ISOLATED";

/// 前端可见的隔离状态字面量：载荷已隔离、等待信任确认。
///
/// 该值出现在恢复任务结果/审计日志的 `details` JSON 的
/// [`RESTORE_DETAILS_ISOLATION_STATE_FIELD`] 字段中，前端据此渲染
/// `data:governance.restore_isolated_pending_trust` 文案。serde 不参与
/// 此序列化（手写 JSON details），因此保持 PascalCase 字面量不变。
pub const RESTORE_ISOLATION_STATE_PENDING_TRUST: &str = "IsolatedPendingTrust";

/// 恢复结果 `details`/`stats` JSON 中承载隔离状态的字段名。
///
/// 约定 payload 形如：
/// `{ "isolation_state": "IsolatedPendingTrust", "unconsumed_domains": [...], "failed_domains": [...] }`
pub const RESTORE_DETAILS_ISOLATION_STATE_FIELD: &str = "isolation_state";

/// 恢复结果 `details` JSON 中列出未消费域名单的字段名（配合
/// `E_RESTORE_DOMAIN_UNCONSUMED`；元素为 coverage 域名，如 `"crypto"`）。
pub const RESTORE_DETAILS_UNCONSUMED_DOMAINS_FIELD: &str = "unconsumed_domains";

/// 恢复结果 `details` JSON 中列出恢复失败域名单的字段名（配合
/// `E_RESTORE_DOMAIN_FAILED`；元素为 `"域名: 原因"`）。
pub const RESTORE_DETAILS_FAILED_DOMAINS_FIELD: &str = "failed_domains";

/// 以 `[CODE] 说明` 的既有惯例（对齐 `ATOMIC_RESTORE_UNAVAILABLE_CODE` 的用法）
/// 拼装携带稳定码的用户可见错误消息。
pub fn tagged_message(code: &str, detail: impl AsRef<str>) -> String {
    format!("[{}] {}", code, detail.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 稳定码是前后端与审计日志的跨进程契约；此测试把字面量钉死，
    /// 任何改动都必须显式改这里并同步前端映射与 i18n。
    #[test]
    fn stable_code_literals_are_frozen() {
        assert_eq!(
            RESTORE_DOMAIN_UNCONSUMED_CODE,
            "E_RESTORE_DOMAIN_UNCONSUMED"
        );
        assert_eq!(RESTORE_DOMAIN_FAILED_CODE, "E_RESTORE_DOMAIN_FAILED");
        assert_eq!(
            RESTORE_UNTRUSTED_ISOLATED_CODE,
            "E_RESTORE_UNTRUSTED_ISOLATED"
        );
        assert_eq!(
            RESTORE_ISOLATION_STATE_PENDING_TRUST,
            "IsolatedPendingTrust"
        );
        assert_eq!(RESTORE_DETAILS_ISOLATION_STATE_FIELD, "isolation_state");
        assert_eq!(
            RESTORE_DETAILS_UNCONSUMED_DOMAINS_FIELD,
            "unconsumed_domains"
        );
        assert_eq!(RESTORE_DETAILS_FAILED_DOMAINS_FIELD, "failed_domains");
    }

    #[test]
    fn tagged_message_matches_bracket_prefix_convention() {
        let message = tagged_message(RESTORE_DOMAIN_UNCONSUMED_CODE, "crypto 域未被消费");
        assert_eq!(message, "[E_RESTORE_DOMAIN_UNCONSUMED] crypto 域未被消费");
        // 前端 localizeBackupJobError 按 message.includes(code) 分发，
        // 稳定码必须原样出现在消息中。
        assert!(message.contains(RESTORE_DOMAIN_UNCONSUMED_CODE));
    }

    #[test]
    fn codes_are_distinct() {
        let codes = [
            RESTORE_DOMAIN_UNCONSUMED_CODE,
            RESTORE_DOMAIN_FAILED_CODE,
            RESTORE_UNTRUSTED_ISOLATED_CODE,
        ];
        for (i, a) in codes.iter().enumerate() {
            for b in codes.iter().skip(i + 1) {
                assert_ne!(a, b);
            }
        }
    }
}
