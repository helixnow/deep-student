use std::sync::Arc;

use super::inbox::{InboxManager, InboxPushResult};
use super::repo::WorkspaceRepo;
use super::types::*;

#[derive(Debug, Clone)]
pub struct InboxOverflow {
    pub target_session_id: AgentId,
    pub rejected_message_id: MessageId,
}

pub struct MessageRouter {
    repo: Arc<WorkspaceRepo>,
    inbox_manager: Arc<InboxManager>,
}

impl MessageRouter {
    pub fn new(repo: Arc<WorkspaceRepo>, inbox_manager: Arc<InboxManager>) -> Self {
        Self {
            repo,
            inbox_manager,
        }
    }

    pub fn route(
        &self,
        message: &WorkspaceMessage,
    ) -> Result<(Vec<AgentId>, Vec<InboxOverflow>), String> {
        self.repo.save_message(message)?;

        let targets = self.resolve_targets(message)?;
        let mut overflow: Vec<InboxOverflow> = Vec::new();

        for target in &targets {
            let priority = self.calculate_priority(&message.message_type);
            self.repo.add_to_inbox(target, &message.id, priority)?;
            let push_result: InboxPushResult = self.inbox_manager.push(target, &message.id);
            if let Some(rejected_message_id) = push_result.rejected_message_id {
                // 保持数据库与内存一致：将本次被拒绝入队的消息标记为 processed
                let _ = self
                    .repo
                    .mark_inbox_processed_by_message(target, &rejected_message_id);
                overflow.push(InboxOverflow {
                    target_session_id: target.clone(),
                    rejected_message_id,
                });
            }
        }

        self.repo
            .update_message_status(&message.id, MessageStatus::Delivered)?;

        Ok((targets, overflow))
    }

    fn resolve_targets(&self, message: &WorkspaceMessage) -> Result<Vec<AgentId>, String> {
        match &message.target_session_id {
            Some(target) => {
                if target != &message.sender_session_id {
                    Ok(vec![target.clone()])
                } else {
                    Ok(vec![])
                }
            }
            None => {
                let agents = self.repo.list_agents()?;
                Ok(agents
                    .into_iter()
                    .filter(|a| a.session_id != message.sender_session_id)
                    .map(|a| a.session_id)
                    .collect())
            }
        }
    }

    fn calculate_priority(&self, message_type: &MessageType) -> i32 {
        match message_type {
            MessageType::Correction => 2,
            MessageType::Task => 1,
            MessageType::Query => 1,
            MessageType::Progress => 0,
            MessageType::Result => 0,
            MessageType::Broadcast => 0,
        }
    }

    pub fn send_unicast(
        &self,
        workspace_id: &str,
        sender_id: &str,
        target_id: &str,
        message_type: MessageType,
        content: String,
    ) -> Result<(WorkspaceMessage, Vec<InboxOverflow>), String> {
        let message = WorkspaceMessage::new(
            workspace_id.to_string(),
            sender_id.to_string(),
            Some(target_id.to_string()),
            message_type,
            content,
        );
        let (_targets, overflow) = self.route(&message)?;
        Ok((message, overflow))
    }

    pub fn send_broadcast(
        &self,
        workspace_id: &str,
        sender_id: &str,
        message_type: MessageType,
        content: String,
    ) -> Result<(WorkspaceMessage, Vec<AgentId>, Vec<InboxOverflow>), String> {
        let message = WorkspaceMessage::new(
            workspace_id.to_string(),
            sender_id.to_string(),
            None,
            message_type,
            content,
        );
        let (targets, overflow) = self.route(&message)?;
        Ok((message, targets, overflow))
    }
}
