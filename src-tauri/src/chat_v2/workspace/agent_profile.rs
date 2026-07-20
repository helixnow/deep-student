//! Runtime-consumable agent profiles.
//!
//! A profile is resolved before an agent is persisted. `skill_id` remains a
//! compatibility alias, but never acts as the agent's runtime configuration.
//!
//! Profiles are consumed for real by `run_workspace_agent_backend`
//! (handlers/workspace_handlers.rs): `system_instructions` becomes the worker
//! system prompt (plus a workspace preamble), `model_id` selects the model, and
//! `allowed_tools` drives both schema injection (headless read-only schemas)
//! and the fail-closed execution whitelist. Tool names must therefore match
//! real executor names (`builtin-*`).

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
    /// 人类可读的一句话简介（列表/管理 UI 展示用，不参与运行时行为）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
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
                description: Some("通用子代理：完成委派任务并向父代理返回简明结论。".into()),
                instructions: "Complete the delegated task and return a concise, evidence-backed result to the parent agent.".into(),
                model: None,
                reasoning_effort: Some(ReasoningEffort::Medium),
                allowed_tools: vec![
                    "builtin-workspace_send".into(),
                    "builtin-workspace_query".into(),
                ],
                permissions: AgentPermissions::default(),
                context_inheritance: ContextInheritance::Summary,
                skills: vec![],
            }),
            WORKER_PROFILE_ID => Some(AgentProfile {
                id: WORKER_PROFILE_ID.into(),
                description: Some("执行型子代理：独立完成任务、自行验证并汇报结果。".into()),
                instructions: "Execute the delegated task independently. Use the available tools, verify the result, and report completion to the parent agent.".into(),
                model: None,
                reasoning_effort: Some(ReasoningEffort::High),
                // Worker 定位是纯执行 + 汇报：与 default 相同的协作工具面
                allowed_tools: vec![
                    "builtin-workspace_send".into(),
                    "builtin-workspace_query".into(),
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
                description: Some("调研型子代理：只读探索与检索，产出带出处的调研结论。".into()),
                instructions: "Investigate the delegated question. Prefer primary evidence, keep exploration read-only, and return findings with concrete references.".into(),
                model: None,
                reasoning_effort: Some(ReasoningEffort::High),
                // 除协作工具外，全部为 headless 只读白名单的子集（backend 有现成 schema）
                allowed_tools: vec![
                    "builtin-workspace_send".into(),
                    "builtin-workspace_query".into(),
                    "builtin-unified_search".into(),
                    "builtin-rag_search".into(),
                    "builtin-web_search".into(),
                    "builtin-web_fetch".into(),
                    "builtin-resource_list".into(),
                    "builtin-resource_read".into(),
                    "builtin-resource_search".into(),
                    "builtin-folder_list".into(),
                    "builtin-memory_read".into(),
                    "builtin-memory_list".into(),
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
        Self::resolve_with_custom(selection, None)
    }

    /// 契约 C6：与 [`Self::resolve`] 相同，但允许附加一个自定义子代理定义
    /// 目录（`{workspaces_dir}/agents/*.md`，见 `custom_agents` 模块）。
    ///
    /// 解析顺序：显式 `profile_id` → 内建优先，内建没有再查 custom
    /// （[`super::custom_agents::find_custom_profile`]）；都没有时错误信息
    /// 列出全部可用 profile id（内建 + 目录里的自定义名单）。
    ///
    /// - `custom_agents_dir=None` 时行为与原 `resolve` 完全一致；
    /// - overrides（model 等）在 custom profile 上同样生效；
    /// - `skill_id` legacy 别名逻辑不变：只有内建 id 能作为别名选中 profile，
    ///   未知值仍作为技能记录挂到选中的 profile 上；
    /// - 注意：自定义文件的 `skills:` 字段解析后写入 `profile.skills` 仅作
    ///   记录，运行时**不会**自动加载技能内容（当前限制，防止误导）。
    pub fn resolve_with_custom(
        selection: AgentProfileSelection,
        custom_agents_dir: Option<&std::path::Path>,
    ) -> Result<AgentProfile, String> {
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
        let mut profile = match Self::built_in(selected_id) {
            Some(profile) => profile,
            None => custom_agents_dir
                .and_then(|dir| super::custom_agents::find_custom_profile(dir, selected_id))
                .ok_or_else(|| {
                    let mut available: Vec<String> = vec![
                        DEFAULT_PROFILE_ID.to_string(),
                        WORKER_PROFILE_ID.to_string(),
                        EXPLORER_PROFILE_ID.to_string(),
                    ];
                    if let Some(dir) = custom_agents_dir {
                        available.extend(
                            super::custom_agents::load_custom_profiles(dir)
                                .into_iter()
                                .map(|p| p.id),
                        );
                    }
                    format!(
                        "Unknown agent profile: {selected_id}. Available profiles: {}",
                        available.join(", ")
                    )
                })?,
        };

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
        if let Some(description) = &mut profile.description {
            *description = description.trim().to_string();
            if description.is_empty() {
                profile.description = None;
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
        assert_eq!(
            profile.allowed_tools,
            vec!["builtin-workspace_send", "builtin-workspace_query"]
        );
    }

    #[test]
    fn built_in_tools_use_real_executor_names() {
        for id in [DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID] {
            let profile = AgentProfileResolver::built_in(id).unwrap();
            assert!(profile
                .allowed_tools
                .iter()
                .all(|tool| tool.starts_with("builtin-")));
            assert!(profile
                .allowed_tools
                .contains(&"builtin-workspace_send".to_string()));
            assert!(profile
                .allowed_tools
                .contains(&"builtin-workspace_query".to_string()));
        }
    }

    #[test]
    fn explorer_extra_tools_are_headless_read_only_subset() {
        let profile = AgentProfileResolver::built_in(EXPLORER_PROFILE_ID).unwrap();
        for tool in profile
            .allowed_tools
            .iter()
            .filter(|tool| !tool.starts_with("builtin-workspace_"))
        {
            assert!(
                crate::chat_v2::headless::is_headless_allowed_tool(tool),
                "explorer tool {tool} must be part of the headless read-only whitelist"
            );
        }
    }

    #[test]
    fn description_is_trimmed_and_empty_becomes_none() {
        let mut profile = AgentProfileResolver::built_in(DEFAULT_PROFILE_ID).unwrap();
        profile.description = Some("  一句话简介  ".into());
        AgentProfileResolver::validate_and_normalize(&mut profile).unwrap();
        assert_eq!(profile.description.as_deref(), Some("一句话简介"));

        profile.description = Some("   ".into());
        AgentProfileResolver::validate_and_normalize(&mut profile).unwrap();
        assert_eq!(profile.description, None);

        // 旧持久化 metadata 无 description 字段：serde default 反序列化安全
        let legacy = serde_json::json!({
            "agent_profile": {
                "id": "worker",
                "instructions": "legacy instructions",
            }
        });
        let restored = AgentProfileResolver::from_metadata(Some(&legacy))
            .unwrap()
            .unwrap();
        assert_eq!(restored.description, None);
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
                allowed_tools: Some(vec![
                    "builtin-web_search".into(),
                    "builtin-web_search".into(),
                ]),
                ..Default::default()
            },
            ..Default::default()
        })
        .unwrap();
        let runtime = AgentRuntimeConfig::from(&profile);
        assert_eq!(runtime.model_id.as_deref(), Some("model-config-1"));
        assert_eq!(runtime.allowed_tools, vec!["builtin-web_search"]);
    }

    #[test]
    fn resolve_with_custom_falls_back_to_directory_and_applies_overrides() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("paper-summarizer.md"),
            "---\nname: paper-summarizer\nbase: explorer\nmodel: file-model\n---\nSummarize papers.\n",
        )
        .unwrap();

        // 内建优先：worker 不会被目录内容影响
        let built_in = AgentProfileResolver::resolve_with_custom(
            AgentProfileSelection {
                profile_id: Some(WORKER_PROFILE_ID.into()),
                ..Default::default()
            },
            Some(dir.path()),
        )
        .unwrap();
        assert_eq!(built_in.id, WORKER_PROFILE_ID);

        // 内建没有 → 查 custom；overrides（model）在 custom 上生效
        let custom = AgentProfileResolver::resolve_with_custom(
            AgentProfileSelection {
                profile_id: Some("paper-summarizer".into()),
                overrides: AgentProfileOverride {
                    model: Some("override-model".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
            Some(dir.path()),
        )
        .unwrap();
        assert_eq!(custom.id, "paper-summarizer");
        assert_eq!(custom.instructions, "Summarize papers.");
        assert_eq!(custom.model.as_deref(), Some("override-model"));

        // 都没有 → 错误信息列出内建 + 自定义全部可用 id
        let error = AgentProfileResolver::resolve_with_custom(
            AgentProfileSelection {
                profile_id: Some("nonexistent".into()),
                ..Default::default()
            },
            Some(dir.path()),
        )
        .unwrap_err();
        for id in ["default", "worker", "explorer", "paper-summarizer"] {
            assert!(error.contains(id), "error must list available id {id}: {error}");
        }

        // custom_dir=None 等价原 resolve：仅列内建
        let error_no_dir = AgentProfileResolver::resolve_with_custom(
            AgentProfileSelection {
                profile_id: Some("paper-summarizer".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap_err();
        assert!(error_no_dir.contains("Unknown agent profile"));
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
