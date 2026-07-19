//! Runtime-consumable agent profiles.
//!
//! A profile is resolved before an agent is persisted. `skill_id` remains a
//! compatibility alias, but never acts as the agent's runtime configuration.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

use super::types::WorkspaceAgent;

pub const DEFAULT_PROFILE_ID: &str = "default";
pub const WORKER_PROFILE_ID: &str = "worker";
pub const EXPLORER_PROFILE_ID: &str = "explorer";
pub const AGENT_PROFILE_METADATA_KEY: &str = "agent_profile";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "mode")]
#[derive(Default)]
pub enum ContextInheritance {
    None,
    #[default]
    Summary,
    LastNTurns {
        turns: u32,
    },
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum SandboxMode {
    #[default]
    Inherit,
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ApprovalPolicy {
    #[default]
    Inherit,
    Never,
    OnRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissions {
    #[serde(default)]
    pub sandbox: SandboxMode,
    #[serde(default)]
    pub approval_policy: ApprovalPolicy,
    #[serde(default)]
    pub network_access: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub instructions: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub permissions: AgentPermissions,
    #[serde(default)]
    pub context_inheritance: ContextInheritance,
    #[serde(default)]
    pub skills: Vec<String>,
}

/// Exact configuration consumed by the child runtime after profile resolution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeConfig {
    pub system_instructions: String,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub allowed_tools: Vec<String>,
    pub permissions: AgentPermissions,
    pub context_inheritance: ContextInheritance,
    pub skill_ids: Vec<String>,
}

impl From<&AgentProfile> for AgentRuntimeConfig {
    fn from(profile: &AgentProfile) -> Self {
        Self {
            system_instructions: profile.instructions.clone(),
            model_id: profile.model.clone(),
            reasoning_effort: profile.reasoning_effort.clone(),
            allowed_tools: profile.allowed_tools.clone(),
            permissions: profile.permissions.clone(),
            context_inheritance: profile.context_inheritance.clone(),
            skill_ids: profile.skills.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileOverride {
    pub instructions: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub allowed_tools: Option<Vec<String>>,
    pub permissions: Option<AgentPermissions>,
    pub context_inheritance: Option<ContextInheritance>,
    pub skills: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileSelection {
    pub profile_id: Option<String>,
    /// Compatibility input for old callers. Known aliases select a profile;
    /// unknown values are loaded as a skill on the default worker profile.
    pub skill_id: Option<String>,
    #[serde(default)]
    pub overrides: AgentProfileOverride,
}

pub struct AgentProfileResolver;

impl AgentProfileResolver {
    pub fn built_in(id: &str) -> Option<AgentProfile> {
        match id {
            DEFAULT_PROFILE_ID => Some(AgentProfile {
                id: DEFAULT_PROFILE_ID.into(),
                instructions: "Complete the delegated task and return a concise, evidence-backed result to the parent agent.".into(),
                model: None,
                reasoning_effort: Some(ReasoningEffort::Medium),
                allowed_tools: vec!["workspace_send".into(), "workspace_query".into()],
                permissions: AgentPermissions::default(),
                context_inheritance: ContextInheritance::Summary,
                skills: vec![],
            }),
            WORKER_PROFILE_ID => Some(AgentProfile {
                id: WORKER_PROFILE_ID.into(),
                instructions: "Execute the delegated task independently. Use the available tools, verify the result, and report completion to the parent agent.".into(),
                model: None,
                reasoning_effort: Some(ReasoningEffort::High),
                allowed_tools: vec![
                    "workspace_send".into(),
                    "workspace_query".into(),
                    "read_file".into(),
                    "search_files".into(),
                ],
                permissions: AgentPermissions {
                    sandbox: SandboxMode::WorkspaceWrite,
                    approval_policy: ApprovalPolicy::Inherit,
                    network_access: false,
                },
                context_inheritance: ContextInheritance::Summary,
                skills: vec![],
            }),
            EXPLORER_PROFILE_ID => Some(AgentProfile {
                id: EXPLORER_PROFILE_ID.into(),
                instructions: "Investigate the delegated question. Prefer primary evidence, keep exploration read-only, and return findings with concrete references.".into(),
                model: None,
                reasoning_effort: Some(ReasoningEffort::High),
                allowed_tools: vec![
                    "workspace_send".into(),
                    "workspace_query".into(),
                    "read_file".into(),
                    "search_files".into(),
                    "web_search".into(),
                ],
                permissions: AgentPermissions {
                    sandbox: SandboxMode::ReadOnly,
                    approval_policy: ApprovalPolicy::Never,
                    network_access: true,
                },
                context_inheritance: ContextInheritance::LastNTurns { turns: 8 },
                skills: vec![],
            }),
            _ => None,
        }
    }

    pub fn resolve(selection: AgentProfileSelection) -> Result<AgentProfile, String> {
        let legacy_skill = selection
            .skill_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let selected_id = selection
            .profile_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| legacy_skill.filter(|id| Self::built_in(id).is_some()))
            .unwrap_or(WORKER_PROFILE_ID);
        let mut profile = Self::built_in(selected_id)
            .ok_or_else(|| format!("Unknown agent profile: {selected_id}"))?;

        if let Some(skill) = legacy_skill.filter(|id| Self::built_in(id).is_none()) {
            profile.skills.push(skill.to_string());
        }
        Self::apply_overrides(&mut profile, selection.overrides);
        Self::validate_and_normalize(&mut profile)?;
        Ok(profile)
    }

    pub fn from_metadata(metadata: Option<&Value>) -> Result<Option<AgentProfile>, String> {
        let Some(value) = metadata.and_then(|m| m.get(AGENT_PROFILE_METADATA_KEY)) else {
            return Ok(None);
        };
        let mut profile: AgentProfile = serde_json::from_value(value.clone())
            .map_err(|e| format!("Invalid persisted agent profile: {e}"))?;
        Self::validate_and_normalize(&mut profile)?;
        Ok(Some(profile))
    }

    /// Resolve a persisted agent, including legacy rows which only have
    /// `skill_id`. Runtime callers should use this instead of reading either
    /// field directly.
    pub fn resolve_for_agent(agent: &WorkspaceAgent) -> Result<AgentProfile, String> {
        if let Some(profile) = Self::from_metadata(agent.metadata.as_ref())? {
            return Ok(profile);
        }
        Self::resolve(AgentProfileSelection {
            skill_id: agent.skill_id.clone(),
            ..Default::default()
        })
    }

    pub fn runtime_config_for_agent(agent: &WorkspaceAgent) -> Result<AgentRuntimeConfig, String> {
        Ok(AgentRuntimeConfig::from(&Self::resolve_for_agent(agent)?))
    }

    pub fn persist_into_metadata(metadata: Option<Value>, profile: &AgentProfile) -> Value {
        let mut object = match metadata {
            Some(Value::Object(object)) => object,
            _ => Map::new(),
        };
        object.insert(
            AGENT_PROFILE_METADATA_KEY.to_string(),
            serde_json::to_value(profile).expect("AgentProfile must serialize"),
        );
        Value::Object(object)
    }

    fn apply_overrides(profile: &mut AgentProfile, overrides: AgentProfileOverride) {
        if let Some(value) = overrides.instructions {
            profile.instructions = value;
        }
        if let Some(value) = overrides.model {
            profile.model = Some(value);
        }
        if let Some(value) = overrides.reasoning_effort {
            profile.reasoning_effort = Some(value);
        }
        if let Some(value) = overrides.allowed_tools {
            profile.allowed_tools = value;
        }
        if let Some(value) = overrides.permissions {
            profile.permissions = value;
        }
        if let Some(value) = overrides.context_inheritance {
            profile.context_inheritance = value;
        }
        if let Some(value) = overrides.skills {
            profile.skills = value;
        }
    }

    fn validate_and_normalize(profile: &mut AgentProfile) -> Result<(), String> {
        profile.id = profile.id.trim().to_string();
        profile.instructions = profile.instructions.trim().to_string();
        if profile.id.is_empty() {
            return Err("Agent profile id must not be empty".into());
        }
        if profile.instructions.is_empty() {
            return Err("Agent profile instructions must not be empty".into());
        }
        if matches!(
            profile.context_inheritance,
            ContextInheritance::LastNTurns { turns: 0 }
        ) {
            return Err("last_n_turns context inheritance requires turns > 0".into());
        }
        if let Some(model) = &mut profile.model {
            *model = model.trim().to_string();
            if model.is_empty() {
                profile.model = None;
            }
        }
        normalize_ids(&mut profile.allowed_tools, "tool")?;
        normalize_ids(&mut profile.skills, "skill")?;
        Ok(())
    }
}

fn normalize_ids(values: &mut Vec<String>, label: &str) -> Result<(), String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(values.len());
    for value in values.drain(..) {
        let value = value.trim().to_string();
        if value.is_empty() {
            return Err(format!("Agent profile {label} id must not be empty"));
        }
        if seen.insert(value.clone()) {
            normalized.push(value);
        }
    }
    *values = normalized;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_skill_resolves_to_real_worker_profile() {
        let profile = AgentProfileResolver::resolve(AgentProfileSelection {
            skill_id: Some("code_review".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(profile.id, WORKER_PROFILE_ID);
        assert_eq!(profile.skills, vec!["code_review"]);
        assert!(!profile.allowed_tools.is_empty());
    }

    #[test]
    fn persisted_profile_round_trips_as_runtime_config() {
        let profile = AgentProfileResolver::built_in(EXPLORER_PROFILE_ID).unwrap();
        let metadata = AgentProfileResolver::persist_into_metadata(None, &profile);
        let restored = AgentProfileResolver::from_metadata(Some(&metadata))
            .unwrap()
            .unwrap();
        assert_eq!(AgentRuntimeConfig::from(&restored).model_id, profile.model);
        assert_eq!(restored, profile);
    }

    #[test]
    fn overrides_are_normalized_and_directly_consumable() {
        let profile = AgentProfileResolver::resolve(AgentProfileSelection {
            profile_id: Some(DEFAULT_PROFILE_ID.into()),
            overrides: AgentProfileOverride {
                model: Some(" model-config-1 ".into()),
                allowed_tools: Some(vec!["read_file".into(), "read_file".into()]),
                ..Default::default()
            },
            ..Default::default()
        })
        .unwrap();
        let runtime = AgentRuntimeConfig::from(&profile);
        assert_eq!(runtime.model_id.as_deref(), Some("model-config-1"));
        assert_eq!(runtime.allowed_tools, vec!["read_file"]);
    }

    #[test]
    fn legacy_agent_row_is_runtime_consumable() {
        let mut agent = WorkspaceAgent::new(
            "agent-1".into(),
            "ws-1".into(),
            super::super::types::AgentRole::Worker,
        );
        agent.skill_id = Some("research".into());
        let runtime = AgentProfileResolver::runtime_config_for_agent(&agent).unwrap();
        assert_eq!(runtime.skill_ids, vec!["research"]);
        assert!(!runtime.allowed_tools.is_empty());
    }
}
