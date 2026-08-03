//! 自定义子代理定义（契约 C6）。
//!
//! `{workspaces_dir}/agents/*.md` 下每个 Markdown 文件定义一个自定义
//! profile：文件开头的 `---` frontmatter 提供元数据（name/description/base/
//! model/reasoning_effort/tools/skills），正文（trim 后非空时）替换 base
//! profile 的 instructions。
//!
//! 设计原则：
//! - frontmatter 手写解析（不引入 serde_yaml 依赖），未知 key 忽略（前向兼容）；
//! - fail-closed：name 非法 / 与内建 id 冲突 / base 非内建 → 整个文件跳过并
//!   log warn；tools 越界仅剔除越界项（不作废整个文件）；
//! - `tools` 必须是安全全集的子集：安全全集 = 协作工具
//!   （workspace_send/query）∪ headless 只读白名单
//!   （[`crate::chat_v2::headless::headless_allowed_tools`]）；
//! - tools 覆盖时自动并入 workspace_send/query，保证完成协作面不丢；
//! - `skills:` 与 `reasoning_effort:` 会进入 worker runtime；找不到声明技能的
//!   内容快照时，subagent 创建会 fail-closed；
//! - `permissions:` / `context_inheritance:` 当前不受 worker runtime 支持，
//!   显式声明会使文件无效，禁止“保存成功但静默忽略”。
//!
//! 子代理创建是低频操作，`load_custom_profiles` / `find_custom_profile`
//! 每次调用现扫目录，不做缓存。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use super::agent_profile::{
    AgentProfile, AgentProfileResolver, ReasoningEffort, WORKER_PROFILE_ID,
};

/// 单个定义文件大小上限（64 KiB），超出忽略并 warn。
const MAX_FILE_BYTES: u64 = 64 * 1024;
/// 目录最多加载的定义文件数，超出部分（按文件名排序后）忽略并 warn。
const MAX_FILES: usize = 64;

/// 完成协作面：tools 覆盖时无条件并入，保证 worker 始终能与父级协作。
const COLLABORATION_TOOLS: [&str; 2] = ["builtin-workspace_send", "builtin-workspace_query"];

static CUSTOM_AGENT_FILE_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Serialize compare-and-write/delete operations across tool and Settings
/// entry points so their content revision checks remain atomic.
pub(crate) fn lock_custom_agent_files() -> Result<MutexGuard<'static, ()>, String> {
    CUSTOM_AGENT_FILE_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Custom agent file write lock is poisoned".to_string())
}

/// frontmatter 解析结果（除 name 外全部可选）。
#[derive(Debug, Default)]
struct AgentFileFrontmatter {
    name: Option<String>,
    description: Option<String>,
    base: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<ReasoningEffort>,
    tools: Option<Vec<String>>,
    skills: Option<Vec<String>>,
    invalid_fields: Vec<String>,
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// 解析列表值：支持 `[a, b]` 内联数组或裸逗号分隔；项目允许可选引号包裹。
fn parse_list_value(value: &str) -> Vec<String> {
    let inner = value.trim();
    let inner = inner
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(inner);
    inner
        .split(',')
        .map(|item| {
            item.trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .trim()
                .to_string()
        })
        .filter(|item| !item.is_empty())
        .collect()
}

fn parse_reasoning_effort(value: &str) -> Option<ReasoningEffort> {
    match value.trim().trim_matches(|c| c == '"' || c == '\'') {
        "minimal" => Some(ReasoningEffort::Minimal),
        "low" => Some(ReasoningEffort::Low),
        "medium" => Some(ReasoningEffort::Medium),
        "high" => Some(ReasoningEffort::High),
        "xhigh" | "x_high" => Some(ReasoningEffort::XHigh),
        _ => None,
    }
}

/// 拆分 frontmatter 与正文。
///
/// 文件必须以 `---` 行开头，到下一个 `---` 行为止的 `key: value` 行构成
/// frontmatter；未知 key 忽略。frontmatter 缺失或未闭合返回 `None`。
fn parse_agent_file(content: &str) -> Option<(AgentFileFrontmatter, String)> {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }

    let mut front = AgentFileFrontmatter::default();
    let mut closed = false;
    for line in lines.by_ref() {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "name" => front.name = non_empty(value),
            "description" => front.description = non_empty(value),
            "base" => front.base = non_empty(value),
            "model" => front.model = non_empty(value),
            "reasoning_effort" | "reasoningEffort" => {
                if let Some(effort) = parse_reasoning_effort(value) {
                    front.reasoning_effort = Some(effort);
                } else {
                    front
                        .invalid_fields
                        .push("reasoning_effort (allowed: minimal/low/medium/high/xhigh)".into());
                }
            }
            "tools" => front.tools = Some(parse_list_value(value)),
            "skills" => front.skills = Some(parse_list_value(value)),
            "permissions" | "context_inheritance" | "contextInheritance" => front
                .invalid_fields
                .push(format!("{} (unsupported)", key.trim())),
            // 未知 key 忽略，保持前向兼容
            _ => {}
        }
    }
    if !closed {
        return None;
    }

    let body = lines.collect::<Vec<_>>().join("\n");
    Some((front, body))
}

/// name 校验：非空，且只允许小写字母 / 数字 / 连字符。
fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// 自定义 profile 可声明的工具安全全集：协作工具 ∪ headless 只读白名单。
fn safe_tool_set() -> HashSet<String> {
    let mut set: HashSet<String> = crate::chat_v2::headless::headless_allowed_tools()
        .into_iter()
        .collect();
    for tool in COLLABORATION_TOOLS {
        set.insert(tool.to_string());
    }
    set
}

/// tools 覆盖清洗：越界工具剔除并 warn（不作废整个文件），并保证协作工具在列。
fn sanitize_tools(tools: Vec<String>, path: &Path) -> Vec<String> {
    let safe = safe_tool_set();
    let mut result: Vec<String> = COLLABORATION_TOOLS.iter().map(|s| s.to_string()).collect();
    for tool in tools {
        if !safe.contains(&tool) {
            log::warn!(
                "[CustomAgents] {}: tool '{}' is outside the safe whitelist, dropped",
                path.display(),
                tool
            );
            continue;
        }
        if !result.contains(&tool) {
            result.push(tool);
        }
    }
    result
}

/// 解析单个定义文件为 [`AgentProfile`]。任何 fail-closed 校验失败都返回
/// `None` 并 log warn（调用方跳过该文件继续）。
fn profile_from_file(path: &Path) -> Option<AgentProfile> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > MAX_FILE_BYTES => {
            log::warn!(
                "[CustomAgents] {}: file exceeds {} KiB limit, skipped",
                path.display(),
                MAX_FILE_BYTES / 1024
            );
            return None;
        }
        Err(e) => {
            log::warn!(
                "[CustomAgents] {}: failed to stat file, skipped: {}",
                path.display(),
                e
            );
            return None;
        }
        Ok(_) => {}
    }

    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) => {
            log::warn!(
                "[CustomAgents] {}: failed to read file, skipped: {}",
                path.display(),
                e
            );
            return None;
        }
    };

    let Some((front, body)) = parse_agent_file(&content) else {
        log::warn!(
            "[CustomAgents] {}: missing or unterminated frontmatter, skipped",
            path.display()
        );
        return None;
    };
    if !front.invalid_fields.is_empty() {
        log::warn!(
            "[CustomAgents] {}: invalid/unsupported frontmatter fields: {}; skipped",
            path.display(),
            front.invalid_fields.join(", ")
        );
        return None;
    }

    let Some(name) = front.name else {
        log::warn!(
            "[CustomAgents] {}: frontmatter is missing required 'name', skipped",
            path.display()
        );
        return None;
    };
    if !is_valid_name(&name) {
        log::warn!(
            "[CustomAgents] {}: name '{}' is invalid (only lowercase letters, digits and hyphens are allowed), skipped",
            path.display(),
            name
        );
        return None;
    }
    if AgentProfileResolver::built_in(&name).is_some() {
        log::warn!(
            "[CustomAgents] {}: name '{}' conflicts with a built-in profile id, skipped",
            path.display(),
            name
        );
        return None;
    }

    let base_id = front.base.as_deref().unwrap_or(WORKER_PROFILE_ID);
    let Some(mut profile) = AgentProfileResolver::built_in(base_id) else {
        log::warn!(
            "[CustomAgents] {}: base '{}' is not a built-in profile id, skipped",
            path.display(),
            base_id
        );
        return None;
    };

    // 从 base 克隆：permissions / context_inheritance / reasoning_effort 沿用 base
    profile.id = name;
    // description 不继承 base（内建简介对自定义档案会产生误导）：文件没写就是 None
    profile.description = front.description;
    let body = body.trim();
    if !body.is_empty() {
        profile.instructions = body.to_string();
    }
    if let Some(model) = front.model {
        profile.model = Some(model);
    }
    if let Some(reasoning_effort) = front.reasoning_effort {
        profile.reasoning_effort = Some(reasoning_effort);
    }
    if let Some(tools) = front.tools {
        profile.allowed_tools = sanitize_tools(tools, path);
    }
    if let Some(skills) = front.skills {
        profile.skills = skills;
    }
    Some(profile)
}

/// 扫描目录加载全部自定义 profile。
///
/// 目录不存在返回空；文件按文件名排序后最多加载 [`MAX_FILES`] 个；重名
/// （不同文件声明同一 name）时先加载者生效，后者 warn 跳过。
pub fn load_custom_profiles(dir: &Path) -> Vec<AgentProfile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .collect();
    paths.sort();
    if paths.len() > MAX_FILES {
        log::warn!(
            "[CustomAgents] {}: {} definition files found, only the first {} (by filename) are loaded",
            dir.display(),
            paths.len(),
            MAX_FILES
        );
        paths.truncate(MAX_FILES);
    }

    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut profiles = Vec::new();
    for path in &paths {
        let Some(profile) = profile_from_file(path) else {
            continue;
        };
        if !seen_ids.insert(profile.id.clone()) {
            log::warn!(
                "[CustomAgents] {}: duplicate profile name '{}', skipped (first definition wins)",
                path.display(),
                profile.id
            );
            continue;
        }
        profiles.push(profile);
    }
    profiles
}

/// 按 id 查找单个自定义 profile（现扫目录；目录不存在返回 `None`）。
pub fn find_custom_profile(dir: &Path, id: &str) -> Option<AgentProfile> {
    load_custom_profiles(dir).into_iter().find(|p| p.id == id)
}

/// 设置页文件列表用的 frontmatter 摘要。
///
/// 宽容解析：frontmatter 缺失/未闭合时字段全部为 `None`（不 fail-closed，
/// 因为设置页要把非法文件也列出来供用户修复）。
#[derive(Debug, Default)]
pub struct FrontmatterSummary {
    pub name: Option<String>,
    pub description: Option<String>,
    pub base: Option<String>,
    pub model: Option<String>,
}

/// 设置页文件列表条目：每个 `.md` 文件一条，包含宽容解析的 frontmatter
/// 摘要与 fail-closed 解析结果（`profile` 为 `None` 说明加载器会跳过该文件）。
#[derive(Debug)]
pub struct CustomAgentFileInfo {
    pub file_name: String,
    pub bytes: u64,
    /// RFC3339 修改时间（stat 失败时为 None）。
    pub modified_at: Option<String>,
    pub summary: FrontmatterSummary,
    pub profile: Option<AgentProfile>,
}

/// 列出目录下全部 persona 文件（含加载器会跳过的非法文件，供设置页修复）。
///
/// 排序与 [`load_custom_profiles`] 一致（按文件名），便于调用方按
/// 「先加载者生效」复算重名文件的生效状态。
pub fn list_custom_agent_files(dir: &Path) -> Vec<CustomAgentFileInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .collect();
    paths.sort();

    paths
        .iter()
        .filter_map(|path| {
            let file_name = path.file_name()?.to_str()?.to_string();
            let meta = std::fs::metadata(path).ok();
            let bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let modified_at = meta
                .and_then(|m| m.modified().ok())
                .map(chrono::DateTime::<chrono::Utc>::from)
                .map(|dt| dt.to_rfc3339());
            let summary = std::fs::read_to_string(path)
                .map(|content| frontmatter_summary(&content))
                .unwrap_or_default();
            Some(CustomAgentFileInfo {
                file_name,
                bytes,
                modified_at,
                summary,
                profile: profile_from_file(path),
            })
        })
        .collect()
}

/// 宽容提取 frontmatter 中的 name/description/base/model（供设置页列表）。
pub fn frontmatter_summary(content: &str) -> FrontmatterSummary {
    let mut out = FrontmatterSummary::default();
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return out;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = non_empty(value);
        match key.trim() {
            "name" => out.name = value,
            "description" => out.description = value,
            "base" => out.base = value,
            "model" => out.model = value,
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::workspace::agent_profile::{EXPLORER_PROFILE_ID, WORKER_PROFILE_ID};

    fn write_agent_file(dir: &Path, filename: &str, content: &str) {
        std::fs::write(dir.join(filename), content).expect("write agent definition file");
    }

    #[test]
    fn parses_regular_definition_with_comma_separated_tools() {
        let dir = tempfile::tempdir().unwrap();
        write_agent_file(
            dir.path(),
            "paper-summarizer.md",
            "---\nname: paper-summarizer\ndescription: 阅读论文并输出结构化摘要\nbase: explorer\nmodel: some-model-config-id\ntools: builtin-web_search, builtin-resource_read\n---\n阅读论文并输出结构化摘要。\n",
        );

        let profiles = load_custom_profiles(dir.path());
        assert_eq!(profiles.len(), 1);
        let profile = &profiles[0];
        assert_eq!(profile.id, "paper-summarizer");
        assert_eq!(
            profile.description.as_deref(),
            Some("阅读论文并输出结构化摘要")
        );
        assert_eq!(profile.model.as_deref(), Some("some-model-config-id"));
        assert_eq!(profile.instructions, "阅读论文并输出结构化摘要。");
        // 协作工具自动并入 + frontmatter 声明的工具
        assert_eq!(
            profile.allowed_tools,
            vec![
                "builtin-workspace_send",
                "builtin-workspace_query",
                "builtin-web_search",
                "builtin-resource_read",
            ]
        );
        // permissions / context_inheritance 沿用 base（explorer）
        let base = AgentProfileResolver::built_in(EXPLORER_PROFILE_ID).unwrap();
        assert_eq!(profile.permissions, base.permissions);
        assert_eq!(profile.context_inheritance, base.context_inheritance);
    }

    #[test]
    fn parses_inline_array_tools() {
        let dir = tempfile::tempdir().unwrap();
        write_agent_file(
            dir.path(),
            "inline.md",
            "---\nname: inline-agent\ntools: [builtin-web_search, \"builtin-web_fetch\"]\n---\nBody.\n",
        );

        let profile = find_custom_profile(dir.path(), "inline-agent").unwrap();
        // frontmatter 未写 description：不继承 base 的内建简介
        assert_eq!(profile.description, None);
        assert_eq!(
            profile.allowed_tools,
            vec![
                "builtin-workspace_send",
                "builtin-workspace_query",
                "builtin-web_search",
                "builtin-web_fetch",
            ]
        );
        // base 缺省 worker
        let base = AgentProfileResolver::built_in(WORKER_PROFILE_ID).unwrap();
        assert_eq!(profile.permissions, base.permissions);
    }

    #[test]
    fn out_of_whitelist_tools_are_dropped_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        write_agent_file(
            dir.path(),
            "risky.md",
            "---\nname: risky-agent\ntools: [builtin-web_search, builtin-dstu_delete, tool_pack]\n---\nBody.\n",
        );

        let profile = find_custom_profile(dir.path(), "risky-agent").unwrap();
        assert_eq!(
            profile.allowed_tools,
            vec![
                "builtin-workspace_send",
                "builtin-workspace_query",
                "builtin-web_search",
            ]
        );
    }

    #[test]
    fn built_in_name_conflict_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        write_agent_file(dir.path(), "worker.md", "---\nname: worker\n---\nBody.\n");
        write_agent_file(dir.path(), "ok.md", "---\nname: ok-agent\n---\nBody.\n");

        let profiles = load_custom_profiles(dir.path());
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "ok-agent");
    }

    #[test]
    fn missing_name_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        write_agent_file(dir.path(), "noname.md", "---\nbase: worker\n---\nBody.\n");
        assert!(load_custom_profiles(dir.path()).is_empty());
    }

    #[test]
    fn invalid_name_characters_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        write_agent_file(dir.path(), "bad1.md", "---\nname: Upper-Case\n---\nBody.\n");
        write_agent_file(dir.path(), "bad2.md", "---\nname: has space\n---\nBody.\n");
        write_agent_file(
            dir.path(),
            "bad3.md",
            "---\nname: under_score\n---\nBody.\n",
        );
        assert!(load_custom_profiles(dir.path()).is_empty());
    }

    #[test]
    fn empty_body_keeps_base_instructions() {
        let dir = tempfile::tempdir().unwrap();
        write_agent_file(
            dir.path(),
            "empty-body.md",
            "---\nname: empty-body\nbase: explorer\n---\n   \n",
        );

        let profile = find_custom_profile(dir.path(), "empty-body").unwrap();
        let base = AgentProfileResolver::built_in(EXPLORER_PROFILE_ID).unwrap();
        assert_eq!(profile.instructions, base.instructions);
    }

    #[test]
    fn invalid_base_is_skipped_and_missing_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        write_agent_file(
            dir.path(),
            "badbase.md",
            "---\nname: bad-base\nbase: not-a-builtin\n---\nBody.\n",
        );
        assert!(load_custom_profiles(dir.path()).is_empty());

        let missing = dir.path().join("does-not-exist");
        assert!(load_custom_profiles(&missing).is_empty());
        assert!(find_custom_profile(&missing, "anything").is_none());
    }

    #[test]
    fn skills_field_is_parsed_for_runtime_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        write_agent_file(
            dir.path(),
            "with-skills.md",
            "---\nname: with-skills\nskills: [research, code-review]\n---\nBody.\n",
        );

        let profile = find_custom_profile(dir.path(), "with-skills").unwrap();
        assert_eq!(profile.skills, vec!["research", "code-review"]);
    }

    #[test]
    fn reasoning_effort_is_parsed_for_runtime_use() {
        let dir = tempfile::tempdir().unwrap();
        write_agent_file(
            dir.path(),
            "reasoning.md",
            "---\nname: reasoning-agent\nreasoning_effort: xhigh\n---\nBody.\n",
        );

        let profile = find_custom_profile(dir.path(), "reasoning-agent").unwrap();
        assert_eq!(profile.reasoning_effort, Some(ReasoningEffort::XHigh));
        assert_eq!(
            super::super::agent_profile::AgentRuntimeConfig::from(&profile)
                .reasoning_effort
                .as_ref()
                .map(ReasoningEffort::as_str),
            Some("xhigh")
        );
    }

    #[test]
    fn unsupported_permission_and_context_fields_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        write_agent_file(
            dir.path(),
            "permissions.md",
            "---\nname: permissions-agent\npermissions: workspace-write\n---\nBody.\n",
        );
        write_agent_file(
            dir.path(),
            "context.md",
            "---\nname: context-agent\ncontext_inheritance: full\n---\nBody.\n",
        );
        write_agent_file(
            dir.path(),
            "bad-reasoning.md",
            "---\nname: bad-reasoning\nreasoning_effort: unlimited\n---\nBody.\n",
        );

        assert!(load_custom_profiles(dir.path()).is_empty());
    }
}
