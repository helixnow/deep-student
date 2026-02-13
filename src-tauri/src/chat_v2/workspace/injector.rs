use std::sync::Arc;
use std::time::Instant;

use super::config::{INJECTION_COOLDOWN_MS, MAX_MESSAGES_PER_INJECTION};
use super::coordinator::WorkspaceCoordinator;
use super::types::WorkspaceMessage;

pub struct InjectionResult {
    pub messages: Vec<WorkspaceMessage>,
    pub should_continue: bool,
}

pub struct WorkspaceInjector {
    coordinator: Arc<WorkspaceCoordinator>,
    last_injection: std::sync::Mutex<Option<Instant>>,
    injection_count: std::sync::Mutex<u32>,
}

impl WorkspaceInjector {
    pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self {
        Self {
            coordinator,
            last_injection: std::sync::Mutex::new(None),
            injection_count: std::sync::Mutex::new(0),
        }
    }

    pub fn check_and_inject(
        &self,
        workspace_id: &str,
        session_id: &str,
        max_injections_per_round: u32,
    ) -> Result<InjectionResult, String> {
        {
            let count = self.injection_count.lock().unwrap_or_else(|poisoned| {
                log::error!("[WorkspaceInjector] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            });
            if *count >= max_injections_per_round {
                return Ok(InjectionResult {
                    messages: Vec::new(),
                    should_continue: false,
                });
            }
        }

        {
            let last = self.last_injection.lock().unwrap_or_else(|poisoned| {
                log::error!("[WorkspaceInjector] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            });
            if let Some(last_time) = *last {
                if last_time.elapsed().as_millis() < INJECTION_COOLDOWN_MS as u128 {
                    return Ok(InjectionResult {
                        messages: Vec::new(),
                        should_continue: false,
                    });
                }
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

        {
            let mut last = self.last_injection.lock().unwrap_or_else(|poisoned| {
                log::error!("[WorkspaceInjector] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            });
            *last = Some(Instant::now());
        }
        {
            let mut count = self.injection_count.lock().unwrap_or_else(|poisoned| {
                log::error!("[WorkspaceInjector] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            });
            *count += 1;
        }

        let has_more = self
            .coordinator
            .has_pending_messages(workspace_id, session_id);

        Ok(InjectionResult {
            messages,
            should_continue: has_more,
        })
    }

    pub fn reset_injection_count(&self) {
        let mut count = self.injection_count.lock().unwrap_or_else(|poisoned| {
            log::error!("[WorkspaceInjector] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        *count = 0;
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
                msg.content
            ));
        }
        formatted
    }
}
