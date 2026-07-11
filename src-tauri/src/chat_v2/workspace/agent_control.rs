//! Root-scoped control plane for workspace agents.
//!
//! UI events are observers only. Runtime actions are delegated through
//! [`AgentControlRuntime`], so queueing and starting a turn stay distinct.

use super::agent_profile::{
    AgentProfile, AgentProfileResolver, AgentProfileSelection, AgentRuntimeConfig,
};
use super::{
    AgentRole, AgentStatus, MessageType, SubagentTaskData, WorkspaceAgent, WorkspaceCoordinator,
    WorkspaceMessage,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

const CONTROL_STATE_KEY: &str = "agent_control_state";
const PARENT_AGENT_KEY: &str = "parent_agent_id";
const AGENT_DEPTH_KEY: &str = "agent_depth";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentControlState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    Closed,
}

impl AgentControlState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Closed
        )
    }
}

#[derive(Debug, Clone)]
pub struct AgentControlConfig {
    pub max_depth: u32,
    pub wait_poll_interval: Duration,
}

impl Default for AgentControlConfig {
    fn default() -> Self {
        Self {
            max_depth: 1,
            wait_poll_interval: Duration::from_millis(50),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnRequest {
    pub workspace_id: String,
    pub parent_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    pub task: String,
    #[serde(default)]
    pub profile: AgentProfileSelection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnResult {
    pub agent: WorkspaceAgent,
    pub task: SubagentTaskData,
    pub profile: AgentProfile,
    pub runtime_config: AgentRuntimeConfig,
    pub depth: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentControlSnapshot {
    pub agent: WorkspaceAgent,
    pub state: AgentControlState,
    pub parent_session_id: Option<String>,
    pub depth: u32,
    pub profile: Option<AgentProfile>,
}

#[async_trait]
pub trait AgentControlRuntime: Send + Sync {
    async fn spawn(&self, result: &AgentSpawnResult) -> Result<(), String>;
    async fn trigger_turn(&self, workspace_id: &str, agent_session_id: &str) -> Result<(), String>;
    async fn interrupt(&self, workspace_id: &str, agent_session_id: &str) -> Result<(), String>;
    async fn resume(&self, workspace_id: &str, agent_session_id: &str) -> Result<(), String>;
    async fn close(&self, workspace_id: &str, agent_session_id: &str) -> Result<(), String>;
}

pub struct DetachedAgentRuntime;

#[async_trait]
impl AgentControlRuntime for DetachedAgentRuntime {
    async fn spawn(&self, _: &AgentSpawnResult) -> Result<(), String> {
        Err("Agent runtime is not attached".into())
    }
    async fn trigger_turn(&self, _: &str, _: &str) -> Result<(), String> {
        Err("Agent runtime is not attached".into())
    }
    async fn interrupt(&self, _: &str, _: &str) -> Result<(), String> {
        Err("Agent runtime is not attached".into())
    }
    async fn resume(&self, _: &str, _: &str) -> Result<(), String> {
        Err("Agent runtime is not attached".into())
    }
    async fn close(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}

pub struct AgentControl {
    coordinator: Arc<WorkspaceCoordinator>,
    runtime: Arc<dyn AgentControlRuntime>,
    config: AgentControlConfig,
}

impl AgentControl {
    pub fn new(
        coordinator: Arc<WorkspaceCoordinator>,
        runtime: Arc<dyn AgentControlRuntime>,
        config: AgentControlConfig,
    ) -> Self {
        Self {
            coordinator,
            runtime,
            config,
        }
    }

    pub async fn spawn(&self, request: AgentSpawnRequest) -> Result<AgentSpawnResult, String> {
        let task_text = request.task.trim();
        if task_text.is_empty() {
            return Err("Agent task must not be empty".into());
        }
        self.coordinator
            .ensure_member_or_creator(&request.workspace_id, &request.parent_session_id)?;
        let parent_depth = self.parent_depth(&request.workspace_id, &request.parent_session_id)?;
        let depth = parent_depth.saturating_add(1);
        if depth > self.config.max_depth {
            return Err(format!(
                "Maximum agent nesting depth ({}) exceeded: parent depth is {}",
                self.config.max_depth, parent_depth
            ));
        }

        let profile = AgentProfileResolver::resolve(request.profile)?;
        let runtime_config = AgentRuntimeConfig::from(&profile);
        let session_id = request
            .agent_session_id
            .unwrap_or_else(|| format!("agent_{}_{}", profile.id, ulid::Ulid::new()));
        let mut metadata = AgentProfileResolver::persist_into_metadata(request.metadata, &profile);
        let object = metadata
            .as_object_mut()
            .expect("profile persistence creates object");
        object.insert(CONTROL_STATE_KEY.into(), json!(AgentControlState::Queued));
        object.insert(PARENT_AGENT_KEY.into(), json!(request.parent_session_id));
        object.insert(AGENT_DEPTH_KEY.into(), json!(depth));
        if let Some(context) = request.context {
            object.insert("spawn_context".into(), context);
        }

        let legacy_skill = profile.skills.first().cloned();
        let mut agent = self.coordinator.register_agent(
            &request.workspace_id,
            &session_id,
            AgentRole::Worker,
            legacy_skill.clone(),
            Some(metadata),
        )?;
        self.coordinator.update_agent_status(
            &request.workspace_id,
            &session_id,
            AgentStatus::Queued,
        )?;
        agent.status = AgentStatus::Queued;
        let task = SubagentTaskData::new(
            request.workspace_id.clone(),
            session_id.clone(),
            legacy_skill,
            Some(task_text.to_string()),
        );
        if let Err(error) = self
            .coordinator
            .get_task_manager(&request.workspace_id)?
            .create_task(&task)
        {
            let _ = self
                .coordinator
                .unregister_agent(&request.workspace_id, &session_id);
            return Err(format!("Failed to persist agent task: {error}"));
        }
        let result = AgentSpawnResult {
            agent,
            task,
            profile,
            runtime_config,
            depth,
        };
        if let Err(error) = self.runtime.spawn(&result).await {
            self.set_state(
                &request.workspace_id,
                &session_id,
                AgentControlState::Failed,
            )?;
            let _ = self
                .coordinator
                .get_task_manager(&request.workspace_id)?
                .update_status(
                    &result.task.id,
                    super::SubagentTaskStatus::Failed,
                    Some(&error),
                );
            return Err(error);
        }
        Ok(result)
    }

    pub fn list(&self, workspace_id: &str) -> Result<Vec<AgentControlSnapshot>, String> {
        self.coordinator
            .list_agents(workspace_id)?
            .into_iter()
            .map(Self::snapshot)
            .collect()
    }

    pub fn get(&self, workspace_id: &str, agent_id: &str) -> Result<AgentControlSnapshot, String> {
        Self::snapshot(self.require_agent(workspace_id, agent_id)?)
    }

    pub fn runtime_config(
        &self,
        workspace_id: &str,
        agent_id: &str,
    ) -> Result<AgentRuntimeConfig, String> {
        let agent = self.require_agent(workspace_id, agent_id)?;
        AgentProfileResolver::runtime_config_for_agent(&agent)
    }

    /// Runtime-owned state transition entry point. Supervisors call this when
    /// execution actually starts or reaches a terminal condition.
    pub fn update_state(
        &self,
        workspace_id: &str,
        agent_id: &str,
        state: AgentControlState,
    ) -> Result<(), String> {
        self.set_state(workspace_id, agent_id, state)
    }

    /// Queue-only delivery. This never starts a new turn.
    pub fn send_message(
        &self,
        workspace_id: &str,
        sender_id: &str,
        target_id: &str,
        content: String,
    ) -> Result<WorkspaceMessage, String> {
        self.coordinator.send_message(
            workspace_id,
            sender_id,
            Some(target_id),
            MessageType::Correction,
            content,
        )
    }

    /// Deliver a task and immediately ask the runtime to start a turn.
    pub async fn followup_task(
        &self,
        workspace_id: &str,
        sender_id: &str,
        target_id: &str,
        task: String,
    ) -> Result<WorkspaceMessage, String> {
        let message = self.coordinator.send_message(
            workspace_id,
            sender_id,
            Some(target_id),
            MessageType::Task,
            task,
        )?;
        if let Err(error) = self.runtime.trigger_turn(workspace_id, target_id).await {
            return Err(format!("Follow-up queued but turn trigger failed: {error}"));
        }
        self.set_state(workspace_id, target_id, AgentControlState::Running)?;
        Ok(message)
    }

    pub async fn interrupt(&self, workspace_id: &str, agent_id: &str) -> Result<(), String> {
        self.runtime.interrupt(workspace_id, agent_id).await?;
        self.set_state(workspace_id, agent_id, AgentControlState::Interrupted)
    }

    pub async fn resume(&self, workspace_id: &str, agent_id: &str) -> Result<(), String> {
        let snapshot = Self::snapshot(self.require_agent(workspace_id, agent_id)?)?;
        if snapshot.state != AgentControlState::Interrupted {
            return Err(format!("Agent {agent_id} is not interrupted"));
        }
        self.runtime.resume(workspace_id, agent_id).await?;
        self.set_state(workspace_id, agent_id, AgentControlState::Queued)
    }

    pub async fn close(&self, workspace_id: &str, agent_id: &str) -> Result<(), String> {
        self.runtime.close(workspace_id, agent_id).await?;
        self.set_state(workspace_id, agent_id, AgentControlState::Closed)
    }

    pub async fn wait(
        &self,
        workspace_id: &str,
        agent_ids: &[String],
        timeout: Duration,
    ) -> Result<Vec<AgentControlSnapshot>, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let snapshots = agent_ids
                .iter()
                .map(|id| {
                    self.require_agent(workspace_id, id)
                        .and_then(Self::snapshot)
                })
                .collect::<Result<Vec<_>, _>>()?;
            if snapshots
                .iter()
                .all(|snapshot| snapshot.state.is_terminal())
                || Instant::now() >= deadline
            {
                return Ok(snapshots);
            }
            tokio::time::sleep(self.config.wait_poll_interval).await;
        }
    }

    fn require_agent(&self, workspace_id: &str, agent_id: &str) -> Result<WorkspaceAgent, String> {
        self.coordinator
            .get_agent(workspace_id, agent_id)?
            .ok_or_else(|| format!("Agent not found: {agent_id}"))
    }

    fn parent_depth(&self, workspace_id: &str, parent_id: &str) -> Result<u32, String> {
        Ok(self
            .coordinator
            .get_agent(workspace_id, parent_id)?
            .and_then(|agent| agent.metadata)
            .and_then(|metadata| metadata.get(AGENT_DEPTH_KEY).and_then(Value::as_u64))
            .unwrap_or(0) as u32)
    }

    fn set_state(
        &self,
        workspace_id: &str,
        agent_id: &str,
        state: AgentControlState,
    ) -> Result<(), String> {
        let agent = self.require_agent(workspace_id, agent_id)?;
        let mut object = match agent.metadata {
            Some(Value::Object(object)) => object,
            _ => Map::new(),
        };
        object.insert(CONTROL_STATE_KEY.into(), json!(state));
        self.coordinator.update_agent_metadata(
            workspace_id,
            agent_id,
            Some(Value::Object(object)),
        )?;
        let status = match state {
            AgentControlState::Queued => AgentStatus::Queued,
            AgentControlState::Running => AgentStatus::Running,
            AgentControlState::Completed => AgentStatus::Completed,
            AgentControlState::Failed => AgentStatus::Failed,
            AgentControlState::Cancelled => AgentStatus::Cancelled,
            AgentControlState::Interrupted => AgentStatus::Interrupted,
            AgentControlState::Closed => AgentStatus::Closed,
        };
        self.coordinator
            .update_agent_status(workspace_id, agent_id, status)
    }

    fn snapshot(agent: WorkspaceAgent) -> Result<AgentControlSnapshot, String> {
        let state = agent
            .metadata
            .as_ref()
            .and_then(|m| m.get(CONTROL_STATE_KEY))
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| format!("Invalid agent control state: {e}"))?
            .unwrap_or_else(|| match &agent.status {
                AgentStatus::Idle | AgentStatus::Queued => AgentControlState::Queued,
                AgentStatus::Running => AgentControlState::Running,
                AgentStatus::Completed => AgentControlState::Completed,
                AgentStatus::Failed => AgentControlState::Failed,
                AgentStatus::Cancelled => AgentControlState::Cancelled,
                AgentStatus::Interrupted => AgentControlState::Interrupted,
                AgentStatus::Closed => AgentControlState::Closed,
            });
        let parent_session_id = agent
            .metadata
            .as_ref()
            .and_then(|m| m.get(PARENT_AGENT_KEY))
            .and_then(Value::as_str)
            .map(str::to_string);
        let depth = agent
            .metadata
            .as_ref()
            .and_then(|m| m.get(AGENT_DEPTH_KEY))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32;
        let profile = AgentProfileResolver::from_metadata(agent.metadata.as_ref())?;
        Ok(AgentControlSnapshot {
            agent,
            state,
            parent_session_id,
            depth,
            profile,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct RecordingRuntime;
    #[async_trait]
    impl AgentControlRuntime for RecordingRuntime {
        async fn spawn(&self, _: &AgentSpawnResult) -> Result<(), String> {
            Ok(())
        }
        async fn trigger_turn(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn interrupt(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn resume(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn close(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    fn setup(max_depth: u32) -> (TempDir, AgentControl, String) {
        let dir = TempDir::new().unwrap();
        let coordinator = Arc::new(WorkspaceCoordinator::new(dir.path().to_path_buf()));
        let workspace = coordinator.create_workspace("root", None).unwrap();
        let control = AgentControl::new(
            coordinator,
            Arc::new(RecordingRuntime),
            AgentControlConfig {
                max_depth,
                ..Default::default()
            },
        );
        (dir, control, workspace.id)
    }

    #[tokio::test]
    async fn spawn_persists_profile_depth_and_task() {
        let (_dir, control, workspace_id) = setup(1);
        let result = control
            .spawn(AgentSpawnRequest {
                workspace_id: workspace_id.clone(),
                parent_session_id: "root".into(),
                agent_session_id: Some("worker-1".into()),
                task: "inspect".into(),
                profile: AgentProfileSelection {
                    profile_id: Some("explorer".into()),
                    ..Default::default()
                },
                context: None,
                metadata: None,
            })
            .await
            .unwrap();
        assert_eq!(result.depth, 1);
        assert_eq!(
            result.runtime_config.allowed_tools.last().unwrap(),
            "web_search"
        );
        let snapshot = control.list(&workspace_id).unwrap().pop().unwrap();
        assert_eq!(snapshot.profile.unwrap().id, "explorer");
        assert_eq!(snapshot.state, AgentControlState::Queued);
    }

    #[tokio::test]
    async fn default_depth_rejects_nested_spawn() {
        let (_dir, control, workspace_id) = setup(1);
        control
            .spawn(AgentSpawnRequest {
                workspace_id: workspace_id.clone(),
                parent_session_id: "root".into(),
                agent_session_id: Some("worker-1".into()),
                task: "first".into(),
                profile: Default::default(),
                context: None,
                metadata: None,
            })
            .await
            .unwrap();
        let error = control
            .spawn(AgentSpawnRequest {
                workspace_id,
                parent_session_id: "worker-1".into(),
                agent_session_id: None,
                task: "nested".into(),
                profile: Default::default(),
                context: None,
                metadata: None,
            })
            .await
            .unwrap_err();
        assert!(error.contains("Maximum agent nesting depth"));
    }
}
