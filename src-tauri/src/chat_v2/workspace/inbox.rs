use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use super::config::{INBOX_DRAIN_BATCH_SIZE, MAX_INBOX_SIZE};
use super::types::{AgentId, InboxItem, MessageId};

pub struct InboxManager {
    inboxes: Mutex<HashMap<AgentId, VecDeque<MessageId>>>,
}

#[derive(Debug, Clone)]
pub struct InboxPushResult {
    pub accepted: bool,
    pub rejected_message_id: Option<MessageId>,
}

impl InboxManager {
    pub fn new() -> Self {
        Self {
            inboxes: Mutex::new(HashMap::new()),
        }
    }

    /// 从数据库 InboxItem 列表恢复内存状态
    /// 应在工作区实例加载时调用，确保重启后 inbox 状态不丢失
    pub fn restore_from_db(&self, items: Vec<InboxItem>) {
        let mut inboxes = self.inboxes.lock().unwrap_or_else(|poisoned| {
            log::error!("[InboxManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        for item in items {
            // 只恢复 unread 状态的 inbox
            if item.status == super::types::InboxStatus::Unread {
                let inbox = inboxes
                    .entry(item.session_id.clone())
                    .or_insert_with(VecDeque::new);
                // 避免重复添加
                if !inbox.contains(&item.message_id) {
                    inbox.push_back(item.message_id);
                }
            }
        }
        log::debug!(
            "[InboxManager] Restored {} agents' inboxes from database",
            inboxes.len()
        );
    }

    pub fn push(&self, agent_id: &str, message_id: &str) -> InboxPushResult {
        let mut inboxes = self.inboxes.lock().unwrap_or_else(|poisoned| {
            log::error!("[InboxManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        let inbox = inboxes
            .entry(agent_id.to_string())
            .or_insert_with(VecDeque::new);

        if inbox.len() >= MAX_INBOX_SIZE {
            return InboxPushResult {
                accepted: false,
                rejected_message_id: Some(message_id.to_string()),
            };
        }

        inbox.push_back(message_id.to_string());
        InboxPushResult {
            accepted: true,
            rejected_message_id: None,
        }
    }

    pub fn drain(&self, agent_id: &str, limit: usize) -> Vec<MessageId> {
        let mut inboxes = self.inboxes.lock().unwrap_or_else(|poisoned| {
            log::error!("[InboxManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        let inbox = match inboxes.get_mut(agent_id) {
            Some(inbox) => inbox,
            None => return Vec::new(),
        };

        let count = limit.min(inbox.len()).min(INBOX_DRAIN_BATCH_SIZE);
        inbox.drain(..count).collect()
    }

    pub fn peek(&self, agent_id: &str, limit: usize) -> Vec<MessageId> {
        let inboxes = self.inboxes.lock().unwrap_or_else(|poisoned| {
            log::error!("[InboxManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        match inboxes.get(agent_id) {
            Some(inbox) => inbox.iter().take(limit).cloned().collect(),
            None => Vec::new(),
        }
    }

    pub fn len(&self, agent_id: &str) -> usize {
        let inboxes = self.inboxes.lock().unwrap_or_else(|poisoned| {
            log::error!("[InboxManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        inboxes.get(agent_id).map(|i| i.len()).unwrap_or(0)
    }

    pub fn is_empty(&self, agent_id: &str) -> bool {
        self.len(agent_id) == 0
    }

    pub fn clear(&self, agent_id: &str) {
        let mut inboxes = self.inboxes.lock().unwrap_or_else(|poisoned| {
            log::error!("[InboxManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        inboxes.remove(agent_id);
    }

    pub fn clear_all(&self) {
        let mut inboxes = self.inboxes.lock().unwrap_or_else(|poisoned| {
            log::error!("[InboxManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        inboxes.clear();
    }

    pub fn total_pending(&self) -> usize {
        let inboxes = self.inboxes.lock().unwrap_or_else(|poisoned| {
            log::error!("[InboxManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        inboxes.values().map(|i| i.len()).sum()
    }

    pub fn agent_count(&self) -> usize {
        let inboxes = self.inboxes.lock().unwrap_or_else(|poisoned| {
            log::error!("[InboxManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        inboxes.len()
    }
}

impl Default for InboxManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_push_and_drain() {
        let manager = InboxManager::new();

        manager.push("agent1", "msg1");
        manager.push("agent1", "msg2");
        manager.push("agent1", "msg3");

        assert_eq!(manager.len("agent1"), 3);

        let drained = manager.drain("agent1", 2);
        assert_eq!(drained, vec!["msg1", "msg2"]);
        assert_eq!(manager.len("agent1"), 1);
    }

    #[test]
    fn test_max_inbox_size_rejects_new_messages() {
        let manager = InboxManager::new();

        for i in 0..MAX_INBOX_SIZE {
            let result = manager.push("agent1", &format!("msg{}", i));
            assert!(result.accepted);
            assert!(result.rejected_message_id.is_none());
        }

        let rejected = manager.push("agent1", "msg_overflow");
        assert!(!rejected.accepted);
        assert_eq!(
            rejected.rejected_message_id.as_deref(),
            Some("msg_overflow")
        );

        assert_eq!(manager.len("agent1"), MAX_INBOX_SIZE);
        let drained = manager.drain("agent1", MAX_INBOX_SIZE);
        let expected_last = format!("msg{}", MAX_INBOX_SIZE - 1);
        assert_eq!(drained.first().map(String::as_str), Some("msg0"));
        assert_eq!(
            drained.last().map(String::as_str),
            Some(expected_last.as_str())
        );
    }

    #[test]
    fn test_multiple_agents() {
        let manager = InboxManager::new();

        manager.push("agent1", "msg1");
        manager.push("agent2", "msg2");

        assert_eq!(manager.len("agent1"), 1);
        assert_eq!(manager.len("agent2"), 1);
        assert_eq!(manager.agent_count(), 2);
    }
}
