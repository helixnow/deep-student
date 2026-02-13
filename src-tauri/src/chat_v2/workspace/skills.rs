//! Workspace Agent Skills - 空壳模块
//!
//! 技能系统由前端管理（src/chat-v2/skills/）
//! 后端不存储任何技能数据，所有技能信息通过 API 参数从前端传递
//!
//! 此文件保留为兼容性占位符，将在后续版本移除。

use serde::{Deserialize, Serialize};

/// Skill 元数据（仅用于类型兼容）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub recommended_models: Vec<String>,
    pub tags: Vec<String>,
}

// 空实现 - 技能信息应从前端传递
pub fn get_skill(_skill_id: &str) -> Option<&'static WorkspaceSkill> {
    None
}

pub fn list_skills() -> Vec<&'static WorkspaceSkill> {
    vec![]
}

pub fn get_skill_recommended_models(_skill_id: &str) -> Vec<String> {
    vec![]
}
