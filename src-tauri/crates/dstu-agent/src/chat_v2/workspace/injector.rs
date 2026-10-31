use std::sync::Arc;
use std::time::Instant;

use super::config::{INJECTION_COOLDOWN_MS, MAX_MESSAGES_PER_INJECTION};
use super::coordinator::WorkspaceCoordinator;
use super::types::WorkspaceMessage;

/// 单条注入消息内容的最大字符数（与 A2 侧 result_summary 4000 预算对齐），
/// 防止子代理超长 result 消息撑爆主代理上下文
const MAX_INJECTED_MESSAGE_CHARS: usize = 4000;

pub struct InjectionResult {
    pub messages: Vec<WorkspaceMessage>,
    pub should_continue: bool,
}

/// 注入节流状态（纯数据，无锁）。
///
/// 由调用方在一次 Pipeline 执行的生命周期内持有，并在同一轮执行的
/// 多个注入检查点之间复用——这样冷却时间与 `max_injections_per_round`
/// 才有真实含义。此前 WorkspaceInjector 把这些状态放在实例字段上，
/// 但检查点每次都 `WorkspaceInjector::new(...)`，节流形同虚设。
///
/// throttle 是函数局部变量，不跨任务共享，无需 Mutex。
#[derive(Debug, Default, Clone)]
pub struct InjectionThrottle {
    pub last_injection: Option<Instant>,
    pub injection_count: u32,
}

impl InjectionThrottle {
    pub fn new() -> Self {
        Self::default()
    }

    /// 重置轮次计数（新一轮执行开始时可选调用）
    pub fn reset_count(&mut self) {
        self.injection_count = 0;
    }
}

/// 工作区消息注入器（无状态）。
///
/// 节流状态由调用方通过 [`InjectionThrottle`] 传入，
/// 本结构体只持有 coordinator 引用与注入逻辑。
pub struct WorkspaceInjector {
    coordinator: Arc<WorkspaceCoordinator>,
}

impl WorkspaceInjector {
    pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self {
        Self { coordinator }
    }

    /// 检查 inbox 并按节流规则注入消息。
    ///
    /// - 每轮最多注入 `max_injections_per_round` 批（由 `throttle.injection_count` 记账）；
    /// - 两次注入之间至少间隔 [`INJECTION_COOLDOWN_MS`]；
    /// - 每批最多 [`MAX_MESSAGES_PER_INJECTION`] 条。
    pub fn check_and_inject(
        &self,
        throttle: &mut InjectionThrottle,
        workspace_id: &str,
        session_id: &str,
        max_injections_per_round: u32,
    ) -> Result<InjectionResult, String> {
        if throttle.injection_count >= max_injections_per_round {
            return Ok(InjectionResult {
                messages: Vec::new(),
                should_continue: false,
            });
        }

        if let Some(last_time) = throttle.last_injection {
            if last_time.elapsed().as_millis() < INJECTION_COOLDOWN_MS as u128 {
                return Ok(InjectionResult {
                    messages: Vec::new(),
                    should_continue: false,
                });
            }
        }

        if !self
            .coordinator
            .has_pending_messages(workspace_id, session_id)
        {
            return Ok(InjectionResult {
                messages: Vec::new(),
                should_continue: false,
            });
        }

        let messages =
            self.coordinator
                .drain_inbox(workspace_id, session_id, MAX_MESSAGES_PER_INJECTION)?;

        if messages.is_empty() {
            return Ok(InjectionResult {
                messages: Vec::new(),
                should_continue: false,
            });
        }

        throttle.last_injection = Some(Instant::now());
        throttle.injection_count += 1;

        let has_more = self
            .coordinator
            .has_pending_messages(workspace_id, session_id);

        Ok(InjectionResult {
            messages,
            should_continue: has_more,
        })
    }

    pub fn format_injected_messages(messages: &[WorkspaceMessage]) -> String {
        if messages.is_empty() {
            return String::new();
        }

        let mut formatted = String::from("[工作区消息]\n");
        for msg in messages {
            formatted.push_str(&format!(
                "来自 {}: [{}] {}\n",
                msg.sender_session_id,
                serde_json::to_string(&msg.message_type)
                    .unwrap_or_default()
                    .trim_matches('"'),
                Self::truncate_content(&msg.content)
            ));
        }
        formatted
    }

    /// 单条消息内容截断（字符安全，不会切在多字节字符中间）
    fn truncate_content(content: &str) -> std::borrow::Cow<'_, str> {
        match content.char_indices().nth(MAX_INJECTED_MESSAGE_CHARS) {
            Some((byte_idx, _)) => {
                std::borrow::Cow::Owned(format!("{}…[truncated]", &content[..byte_idx]))
            }
            None => std::borrow::Cow::Borrowed(content),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::{AgentRole, MessageType};
    use super::*;
    use tempfile::TempDir;

    const COORD: &str = "coord_sess";
    const WORKER: &str = "worker_sess";

    fn setup() -> (TempDir, Arc<WorkspaceCoordinator>, String) {
        let temp_dir = TempDir::new().expect("temp dir");
        let coordinator = Arc::new(WorkspaceCoordinator::new(temp_dir.path().to_path_buf()));
        let workspace = coordinator
            .create_workspace(COORD, Some("test".to_string()))
            .expect("create workspace");
        coordinator
            .register_agent(&workspace.id, COORD, AgentRole::Coordinator, None, None)
            .expect("register coordinator");
        coordinator
            .register_agent(&workspace.id, WORKER, AgentRole::Worker, None, None)
            .expect("register worker");
        let ws_id = workspace.id;
        (temp_dir, coordinator, ws_id)
    }

    fn send_result(coordinator: &WorkspaceCoordinator, ws_id: &str, content: &str) {
        coordinator
            .send_message(
                ws_id,
                WORKER,
                Some(COORD),
                MessageType::Result,
                content.to_string(),
            )
            .expect("send message");
    }

    #[test]
    fn throttle_enforces_cooldown_between_injections() {
        let (_dir, coordinator, ws_id) = setup();
        let injector = WorkspaceInjector::new(Arc::clone(&coordinator));
        let mut throttle = InjectionThrottle::new();

        send_result(&coordinator, &ws_id, "first");
        let first = injector
            .check_and_inject(&mut throttle, &ws_id, COORD, 5)
            .expect("first inject");
        assert_eq!(first.messages.len(), 1);
        assert_eq!(throttle.injection_count, 1);

        // 冷却期内（50ms）第二次检查被节流，即使 inbox 有新消息。
        // 固定 last_injection 为"刚刚"，消除中间 DB 操作耗时导致的时序抖动
        send_result(&coordinator, &ws_id, "second");
        throttle.last_injection = Some(Instant::now());
        let second = injector
            .check_and_inject(&mut throttle, &ws_id, COORD, 5)
            .expect("second inject");
        assert!(second.messages.is_empty());
        assert_eq!(throttle.injection_count, 1);

        // 冷却期过后可再次注入
        std::thread::sleep(std::time::Duration::from_millis(INJECTION_COOLDOWN_MS + 20));
        let third = injector
            .check_and_inject(&mut throttle, &ws_id, COORD, 5)
            .expect("third inject");
        assert_eq!(third.messages.len(), 1);
        assert_eq!(throttle.injection_count, 2);
    }

    #[test]
    fn throttle_enforces_max_injections_per_round() {
        let (_dir, coordinator, ws_id) = setup();
        let injector = WorkspaceInjector::new(Arc::clone(&coordinator));
        let mut throttle = InjectionThrottle::new();

        send_result(&coordinator, &ws_id, "first");
        let first = injector
            .check_and_inject(&mut throttle, &ws_id, COORD, 1)
            .expect("first inject");
        assert_eq!(first.messages.len(), 1);

        // 轮次上限已达：冷却期过后仍不再注入
        send_result(&coordinator, &ws_id, "second");
        std::thread::sleep(std::time::Duration::from_millis(INJECTION_COOLDOWN_MS + 20));
        let second = injector
            .check_and_inject(&mut throttle, &ws_id, COORD, 1)
            .expect("second inject");
        assert!(second.messages.is_empty());
        assert_eq!(throttle.injection_count, 1);

        // reset_count 后恢复注入能力
        throttle.reset_count();
        let third = injector
            .check_and_inject(&mut throttle, &ws_id, COORD, 1)
            .expect("third inject");
        assert_eq!(third.messages.len(), 1);
    }

    #[test]
    fn fresh_throttle_per_call_would_not_throttle_but_shared_one_does() {
        let (_dir, coordinator, ws_id) = setup();
        let injector = WorkspaceInjector::new(Arc::clone(&coordinator));

        // 复现旧缺陷的对照：每次新建 throttle（等价于旧代码每次 new 注入器）
        // 不会被节流；共享 throttle 才会
        send_result(&coordinator, &ws_id, "a");
        let mut shared = InjectionThrottle::new();
        let first = injector
            .check_and_inject(&mut shared, &ws_id, COORD, 5)
            .expect("inject with shared");
        assert_eq!(first.messages.len(), 1);

        send_result(&coordinator, &ws_id, "b");
        let mut fresh = InjectionThrottle::new();
        let with_fresh = injector
            .check_and_inject(&mut fresh, &ws_id, COORD, 5)
            .expect("inject with fresh");
        // 新 throttle 无冷却记录 → 立即注入（这正是旧实现节流失效的原因）
        assert_eq!(with_fresh.messages.len(), 1);

        send_result(&coordinator, &ws_id, "c");
        // 固定冷却起点，消除时序抖动
        shared.last_injection = Some(Instant::now());
        let with_shared = injector
            .check_and_inject(&mut shared, &ws_id, COORD, 5)
            .expect("inject with shared again");
        // 共享 throttle 处于冷却期 → 被正确节流
        assert!(with_shared.messages.is_empty());
    }

    #[test]
    fn format_truncates_long_message_content() {
        let long_content = "长".repeat(MAX_INJECTED_MESSAGE_CHARS + 100);
        let msg = WorkspaceMessage::new(
            "ws_x".to_string(),
            WORKER.to_string(),
            Some(COORD.to_string()),
            MessageType::Result,
            long_content,
        );

        let formatted = WorkspaceInjector::format_injected_messages(&[msg]);
        assert!(formatted.contains("…[truncated]"));
        // 截断保留恰好 MAX_INJECTED_MESSAGE_CHARS 个字符
        let kept = formatted.matches('长').count();
        assert_eq!(kept, MAX_INJECTED_MESSAGE_CHARS);
    }

    #[test]
    fn format_keeps_short_message_content_intact() {
        let msg = WorkspaceMessage::new(
            "ws_x".to_string(),
            WORKER.to_string(),
            Some(COORD.to_string()),
            MessageType::Progress,
            "短消息内容".to_string(),
        );

        let formatted = WorkspaceInjector::format_injected_messages(&[msg]);
        assert!(formatted.contains("短消息内容"));
        assert!(!formatted.contains("[truncated]"));
    }
}
