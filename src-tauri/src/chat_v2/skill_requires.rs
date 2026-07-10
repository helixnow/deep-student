//! SKILL.md runtime dependency declarations (`requires.bins` / `requires.env`).
//!
//! Parses interoperable frontmatter and probes the local machine during
//! skill scan/install. Bin names are validated before any process lookup.

use std::collections::HashSet;
use std::process::Command;
use std::time::Duration;

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::time::timeout;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const PROBE_TIMEOUT_SECS: u64 = 5;

fn bin_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9._+-]{1,64}$").expect("valid bin name regex"))
}

fn env_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$").expect("valid env name regex"))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillRequires {
    pub bins: Vec<String>,
    pub env: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillRequiresBinProbe {
    pub name: String,
    pub found: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillRequiresEnvProbe {
    pub name: String,
    pub set: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillRequiresProbe {
    pub bins: Vec<SkillRequiresBinProbe>,
    pub env: Vec<SkillRequiresEnvProbe>,
    pub invalid: Vec<String>,
    pub missing_count: usize,
}

/// Extract YAML frontmatter body (without `---` delimiters).
pub fn extract_frontmatter(text: &str) -> Option<&str> {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }
    let rest = trimmed.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    Some(rest[..end].trim())
}

/// Parse `requires.bins` / `requires.env` from SKILL.md (top-level + nested compatibility metadata).
pub fn parse_requires_from_skill_md(text: &str) -> SkillRequires {
    let Some(frontmatter) = extract_frontmatter(text) else {
        return SkillRequires::default();
    };

    let mut bins = Vec::new();
    let mut env = Vec::new();

    merge_string_lists(&mut bins, parse_requires_block(frontmatter, "requires", "bins"));
    merge_string_lists(&mut env, parse_requires_block(frontmatter, "requires", "env"));

    if let Some(openclaw) = parse_openclaw_requires(frontmatter) {
        merge_string_lists(&mut bins, openclaw.bins);
        merge_string_lists(&mut env, openclaw.env);
    }

    SkillRequires { bins, env }
}

fn merge_string_lists(target: &mut Vec<String>, incoming: Vec<String>) {
    let mut seen: HashSet<String> = target.iter().cloned().collect();
    for item in incoming {
        if seen.insert(item.clone()) {
            target.push(item);
        }
    }
}

fn parse_openclaw_requires(frontmatter: &str) -> Option<SkillRequires> {
    let metadata_value = parse_mapping_value(frontmatter, "metadata", 0)?;
    if metadata_value.starts_with('{') {
        return parse_openclaw_from_json(&metadata_value);
    }
    Some(parse_openclaw_from_nested_yaml(&metadata_value))
}

fn parse_openclaw_from_json(raw: &str) -> Option<SkillRequires> {
    let value: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    let requires = value
        .get("openclaw")
        .and_then(|v| v.get("requires"))
        .or_else(|| value.get("requires"))?;
    Some(SkillRequires {
        bins: json_string_array(requires.get("bins")),
        env: json_string_array(requires.get("env")),
    })
}

fn json_string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(str::trim).filter(|s| !s.is_empty()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_openclaw_from_nested_yaml(metadata_block: &str) -> SkillRequires {
    let openclaw = parse_mapping_value(metadata_block, "openclaw", 0)
        .unwrap_or_else(|| metadata_block.to_string());
    SkillRequires {
        bins: parse_requires_block(&openclaw, "requires", "bins"),
        env: parse_requires_block(&openclaw, "requires", "env"),
    }
}

/// Parse list values under `parent.child` within a YAML-ish block.
fn parse_requires_block(block: &str, parent: &str, child: &str) -> Vec<String> {
    let parent_block = match parse_mapping_value(block, parent, 0) {
        Some(value) => value,
        None => return Vec::new(),
    };
    parse_list_field(&parent_block, child, 0)
}

fn parse_mapping_value(block: &str, key: &str, base_indent: usize) -> Option<String> {
    let key_prefix = format!("{}:", key);
    let lines: Vec<&str> = block.lines().collect();
    let mut in_block = false;
    let mut block_start = 0usize;
    let mut block_indent = 0usize;

    for (idx, line) in lines.iter().enumerate() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent < base_indent {
            break;
        }
        let trimmed = line.trim();

        if !in_block {
            if indent == base_indent
                && (trimmed == key_prefix || trimmed.starts_with(&format!("{} ", key_prefix)))
            {
                if let Some(rest) = trimmed.strip_prefix(&key_prefix) {
                    let rest = rest.trim();
                    if rest.is_empty() {
                        in_block = true;
                        block_indent = indent + 2;
                        block_start = idx + 1;
                        continue;
                    }
                    return Some(
                        rest.trim_matches('"')
                            .trim_matches('\'')
                            .to_string(),
                    );
                }
            }
        } else if indent <= base_indent {
            break;
        }
    }

    if !in_block {
        return None;
    }

    let mut collected = Vec::new();
    for line in lines.iter().skip(block_start) {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent < block_indent {
            break;
        }
        collected.push(*line);
    }
    Some(collected.join("\n"))
}

fn parse_list_field(block: &str, key: &str, _base_indent: usize) -> Vec<String> {
    let key_prefix = format!("{}:", key);
    let mut items = Vec::new();
    let mut collecting = false;
    let mut key_indent = 0usize;

    for line in block.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();

        if trimmed == key_prefix || trimmed.starts_with(&format!("{} ", key_prefix)) {
            if let Some(rest) = trimmed.strip_prefix(&key_prefix) {
                let rest = rest.trim();
                if rest.starts_with('[') {
                    return parse_inline_array(rest);
                }
            }
            collecting = true;
            key_indent = indent;
            continue;
        }

        if collecting {
            if trimmed.starts_with("- ") && indent > key_indent {
                let item = trimmed[2..].trim().trim_matches('"').trim_matches('\'');
                if !item.is_empty() {
                    items.push(item.to_string());
                }
                continue;
            }
            if indent <= key_indent && trimmed.contains(':') {
                break;
            }
        }
    }

    items
}

fn parse_inline_array(raw: &str) -> Vec<String> {
    let inner = raw.trim().trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(|part| part.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn is_valid_bin(name: &str) -> bool {
    bin_name_re().is_match(name)
}

fn is_valid_env(name: &str) -> bool {
    env_name_re().is_match(name)
}

fn partition_requires(requires: SkillRequires) -> (SkillRequires, Vec<String>) {
    let mut invalid = Vec::new();
    let mut valid_bins = Vec::new();
    let mut valid_env = Vec::new();

    for bin in requires.bins {
        if is_valid_bin(&bin) {
            valid_bins.push(bin);
        } else {
            invalid.push(format!("bin:{}", bin));
        }
    }
    for env in requires.env {
        if is_valid_env(&env) {
            valid_env.push(env);
        } else {
            invalid.push(format!("env:{}", env));
        }
    }

    (
        SkillRequires {
            bins: valid_bins,
            env: valid_env,
        },
        invalid,
    )
}

fn probe_bin_sync(bin: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("where");
        cmd.arg(bin);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {}", bin))
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}

async fn probe_bin(bin: &str) -> bool {
    let name = bin.to_string();
    timeout(
        Duration::from_secs(PROBE_TIMEOUT_SECS),
        tokio::task::spawn_blocking(move || probe_bin_sync(&name)),
    )
    .await
    .ok()
    .and_then(|join| join.ok())
    .unwrap_or(false)
}

/// Probe declared bins/env on the local machine.
pub async fn probe_requires(requires: SkillRequires) -> SkillRequiresProbe {
    let (validated, mut invalid) = partition_requires(requires);

    let mut bins = Vec::new();
    for name in validated.bins {
        let found = probe_bin(&name).await;
        bins.push(SkillRequiresBinProbe { name, found });
    }

    let mut env = Vec::new();
    for name in validated.env {
        let set = std::env::var(&name).is_ok();
        env.push(SkillRequiresEnvProbe { name, set });
    }

    let missing_count = bins.iter().filter(|b| !b.found).count()
        + env.iter().filter(|e| !e.set).count();

    invalid.sort();
    invalid.dedup();

    SkillRequiresProbe {
        bins,
        env,
        invalid,
        missing_count,
    }
}

/// Human-readable install hints for missing runtime dependencies (advisory only).
pub fn format_missing_requires_hints(probe: &SkillRequiresProbe) -> Vec<String> {
    let mut hints = Vec::new();

    for bin in probe.bins.iter().filter(|b| !b.found) {
        hints.push(bin_missing_hint(&bin.name));
    }
    for env in probe.env.iter().filter(|e| !e.set) {
        hints.push(format!(
            "Environment variable {} is not set. Ask the user to configure it in Settings or their shell profile before using this skill.",
            env.name
        ));
    }

    hints
}

fn bin_missing_hint(bin: &str) -> String {
    let lower = bin.to_ascii_lowercase();
    #[cfg(target_os = "windows")]
    {
        let winget_cmd = match lower.as_str() {
            "python" | "python3" => Some("winget install Python.Python.3"),
            "node" | "npm" | "npx" => Some("winget install OpenJS.NodeJS.LTS"),
            "pandoc" => Some("winget install JohnMacFarlane.Pandoc"),
            "git" => Some("winget install Git.Git"),
            "uv" => Some("winget install astral-sh.uv"),
            "rg" | "ripgrep" => Some("winget install BurntSushi.ripgrep.MSVC"),
            _ => None,
        };
        if let Some(cmd) = winget_cmd {
            return format!(
                "{bin} was not found on PATH. Ask the user to install it, or propose `local_shell_execute` with `{cmd}` after approval.",
                bin = bin
            );
        }
        return format!(
            "{bin} was not found on PATH. Ask the user to install it manually, then retry loading this skill.",
            bin = bin
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        let pkg_hint = match lower.as_str() {
            "python" | "python3" => "Install Python 3 via your system package manager (e.g. apt install python3).",
            "node" | "npm" | "npx" => "Install Node.js LTS via your system package manager or nvm.",
            "pandoc" => "Install pandoc via your system package manager.",
            "git" => "Install git via your system package manager.",
            _ => "Install it via your system package manager.",
        };
        format!(
            "{bin} was not found on PATH. {pkg_hint} After installation, retry loading this skill.",
            bin = bin,
            pkg_hint = pkg_hint
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_top_level_requires_lists() {
        let md = r#"---
name: Demo
description: Demo skill for requires parsing
requires:
  bins:
    - python
    - pandoc
  env:
    - OPENAI_API_KEY
---

# body
"#;
        let parsed = parse_requires_from_skill_md(md);
        assert_eq!(parsed.bins, vec!["python", "pandoc"]);
        assert_eq!(parsed.env, vec!["OPENAI_API_KEY"]);
    }

    #[test]
    fn parse_top_level_requires_inline_arrays() {
        let md = r#"---
name: Demo
description: Demo skill for requires parsing
requires:
  bins: [node, uv]
  env: [API_KEY, OTHER_ENV]
---
"#;
        let parsed = parse_requires_from_skill_md(md);
        assert_eq!(parsed.bins, vec!["node", "uv"]);
        assert_eq!(parsed.env, vec!["API_KEY", "OTHER_ENV"]);
    }

    #[test]
    fn parse_openclaw_nested_metadata() {
        let md = r#"---
name: Demo
description: Demo skill for requires parsing
metadata:
  openclaw:
    requires:
      bins:
        - curl
      env:
        - SECRET_TOKEN
requires:
  bins:
    - python
---
"#;
        let parsed = parse_requires_from_skill_md(md);
        assert_eq!(parsed.bins, vec!["python", "curl"]);
        assert_eq!(parsed.env, vec!["SECRET_TOKEN"]);
    }

    #[test]
    fn parse_openclaw_metadata_json_string() {
        let md = r#"---
name: Demo
description: Demo skill for requires parsing
metadata: {"openclaw":{"requires":{"bins":["rg"],"env":["TOKEN"]}}}
---
"#;
        let parsed = parse_requires_from_skill_md(md);
        assert_eq!(parsed.bins, vec!["rg"]);
        assert_eq!(parsed.env, vec!["TOKEN"]);
    }

    #[test]
    fn parse_missing_frontmatter_returns_empty() {
        let parsed = parse_requires_from_skill_md("# no frontmatter\n");
        assert!(parsed.bins.is_empty());
        assert!(parsed.env.is_empty());
    }

    #[test]
    fn partition_rejects_invalid_bin_names() {
        let requires = SkillRequires {
            bins: vec![
                "python".to_string(),
                "bad bin".to_string(),
                "$(whoami)".to_string(),
            ],
            env: vec!["GOOD_ENV".to_string(), "bad-env".to_string()],
        };
        let (valid, invalid) = partition_requires(requires);
        assert_eq!(valid.bins, vec!["python"]);
        assert_eq!(valid.env, vec!["GOOD_ENV"]);
        assert_eq!(invalid.len(), 3);
    }

    #[tokio::test]
    async fn probe_env_reports_presence_only() {
        std::env::set_var("SKILL_REQUIRES_TEST_VAR", "1");
        let probe = probe_requires(SkillRequires {
            bins: Vec::new(),
            env: vec!["SKILL_REQUIRES_TEST_VAR".to_string(), "SKILL_REQUIRES_MISSING_VAR".to_string()],
        })
        .await;
        std::env::remove_var("SKILL_REQUIRES_TEST_VAR");

        let present = probe.env.iter().find(|e| e.name == "SKILL_REQUIRES_TEST_VAR").unwrap();
        assert!(present.set);
        let missing = probe.env.iter().find(|e| e.name == "SKILL_REQUIRES_MISSING_VAR").unwrap();
        assert!(!missing.set);
        assert_eq!(probe.missing_count, 1);
    }

    #[test]
    fn format_hints_for_missing_python_on_windows() {
        let probe = SkillRequiresProbe {
            bins: vec![SkillRequiresBinProbe {
                name: "python".to_string(),
                found: false,
            }],
            env: Vec::new(),
            invalid: Vec::new(),
            missing_count: 1,
        };
        let hints = format_missing_requires_hints(&probe);
        assert_eq!(hints.len(), 1);
        assert!(hints[0].contains("python"));
        #[cfg(target_os = "windows")]
        assert!(hints[0].contains("winget install Python.Python.3"));
    }
}
