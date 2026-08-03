//! SKILL.md runtime dependency declarations (`requires.bins` / `requires.env` /
//! `requires.python_packages`).
//!
//! Parses interoperable frontmatter and probes the local machine during
//! skill scan/install. Bin/package names are validated before any process lookup.

use std::collections::HashSet;
use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
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

/// Pip / PyPI distribution name (PEP 503–ish subset, no extras/URLs).
fn python_package_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^[A-Za-z0-9]([A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$")
            .expect("valid python package name regex")
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillRequires {
    pub bins: Vec<String>,
    pub env: Vec<String>,
    #[serde(default)]
    pub python_packages: Vec<String>,
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
pub struct SkillRequiresPythonPackageProbe {
    pub name: String,
    pub found: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillRequiresProbe {
    pub bins: Vec<SkillRequiresBinProbe>,
    pub env: Vec<SkillRequiresEnvProbe>,
    #[serde(default)]
    pub python_packages: Vec<SkillRequiresPythonPackageProbe>,
    pub invalid: Vec<String>,
    pub missing_count: usize,
}

/// 前端运行时探测入口：按声明的 bins/env/python_packages 探测本机满足情况。
///
/// 用于加载期 requires 门控（不满足的技能不进入 `<available_skills>`），
/// 与安装期扫描共用同一套探测逻辑。名称非法的条目记入 `invalid`。
#[tauri::command]
pub async fn skill_probe_requires(
    bins: Option<Vec<String>>,
    env: Option<Vec<String>>,
    python_packages: Option<Vec<String>>,
) -> SkillRequiresProbe {
    probe_requires(SkillRequires {
        bins: bins.unwrap_or_default(),
        env: env.unwrap_or_default(),
        python_packages: python_packages.unwrap_or_default(),
    })
    .await
}

/// Extract YAML frontmatter body (without `---` delimiters).
pub fn extract_frontmatter(text: &str) -> Option<&str> {
    let trimmed = text.trim_start();
    let opening_end = trimmed.find('\n')?;
    if !is_frontmatter_delimiter_line(&trimmed[..=opening_end]) {
        return None;
    }
    let body_start = opening_end + 1;
    let mut offset = body_start;
    for line in trimmed[body_start..].split_inclusive('\n') {
        if is_frontmatter_delimiter_line(line) {
            return Some(trimmed[body_start..offset].trim());
        }
        offset += line.len();
    }
    None
}

fn is_frontmatter_delimiter_line(line: &str) -> bool {
    line.trim_end_matches(|character| character == '\r' || character == '\n')
        .trim_end_matches(|character| character == ' ' || character == '\t')
        == "---"
}

/// Parse `requires.bins` / `requires.env` / `requires.python_packages` from SKILL.md.
pub fn parse_requires_from_skill_md(text: &str) -> SkillRequires {
    let Some(frontmatter) = extract_frontmatter(text) else {
        return SkillRequires::default();
    };

    let mut bins = Vec::new();
    let mut env = Vec::new();
    let mut python_packages = Vec::new();

    merge_string_lists(
        &mut bins,
        parse_requires_block(frontmatter, "requires", "bins"),
    );
    merge_string_lists(
        &mut env,
        parse_requires_block(frontmatter, "requires", "env"),
    );
    merge_string_lists(
        &mut python_packages,
        parse_requires_block(frontmatter, "requires", "python_packages"),
    );

    // OpenClaw-compatible nested metadata:
    // metadata.openclaw.requires.{bins,env,python_packages}
    if let Some(metadata) = parse_mapping_value(frontmatter, "metadata", 0) {
        if let Some(openclaw) = parse_mapping_value(&metadata, "openclaw", 0) {
            merge_string_lists(
                &mut bins,
                parse_requires_block(&openclaw, "requires", "bins"),
            );
            merge_string_lists(&mut env, parse_requires_block(&openclaw, "requires", "env"));
            merge_string_lists(
                &mut python_packages,
                parse_requires_block(&openclaw, "requires", "python_packages"),
            );
        }
    }

    SkillRequires {
        bins,
        env,
        python_packages,
    }
}

fn merge_string_lists(target: &mut Vec<String>, incoming: Vec<String>) {
    let mut seen: HashSet<String> = target.iter().cloned().collect();
    for item in incoming {
        if seen.insert(item.clone()) {
            target.push(item);
        }
    }
}

/// Parse list values under `parent.child` within a YAML-ish block.
fn parse_requires_block(block: &str, parent: &str, child: &str) -> Vec<String> {
    let parent_block = match parse_mapping_value(block, parent, 0) {
        Some(value) => value,
        None => return Vec::new(),
    };
    if let Some(values) = parse_inline_mapping_list(&parent_block, child) {
        return values;
    }
    parse_list_field(&parent_block, child, 0)
}

fn parse_inline_mapping_list(mapping: &str, key: &str) -> Option<Vec<String>> {
    let mapping = mapping.trim();
    let inner = mapping.strip_prefix('{')?.strip_suffix('}')?;
    let mut start = 0usize;
    let mut bracket_depth = 0usize;
    let mut quote: Option<char> = None;
    let mut fields = Vec::new();

    for (index, character) in inner.char_indices() {
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
            }
            continue;
        }
        match character {
            '"' | '\'' => quote = Some(character),
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.saturating_sub(1),
            ',' if bracket_depth == 0 => {
                fields.push(&inner[start..index]);
                start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    fields.push(&inner[start..]);

    fields.into_iter().find_map(|field| {
        let (field_key, value) = field.split_once(':')?;
        let field_key = field_key
            .trim()
            .trim_matches(|character| character == '"' || character == '\'');
        (field_key == key).then(|| parse_inline_array(value.trim()))
    })
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
                    return Some(rest.trim_matches('"').trim_matches('\'').to_string());
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
        collected.push(
            line.get(block_indent..)
                .unwrap_or_else(|| line.trim_start()),
        );
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

fn is_valid_python_package(name: &str) -> bool {
    python_package_name_re().is_match(name)
}

/// Map PyPI distribution name → importable top-level module for probing.
fn python_import_name(package: &str) -> String {
    let lower = package.to_ascii_lowercase().replace('_', "-");
    match lower.as_str() {
        "pymupdf" => "fitz".to_string(),
        "pillow" => "PIL".to_string(),
        "opencv-python" | "opencv-python-headless" => "cv2".to_string(),
        "scikit-learn" => "sklearn".to_string(),
        "beautifulsoup4" | "bs4" => "bs4".to_string(),
        "pyyaml" => "yaml".to_string(),
        "python-dateutil" => "dateutil".to_string(),
        "msgpack-python" => "msgpack".to_string(),
        other => other.replace('-', "_"),
    }
}

fn partition_requires(requires: SkillRequires) -> (SkillRequires, Vec<String>) {
    let mut invalid = Vec::new();
    let mut valid_bins = Vec::new();
    let mut valid_env = Vec::new();
    let mut valid_python_packages = Vec::new();

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
    for pkg in requires.python_packages {
        if is_valid_python_package(&pkg) {
            valid_python_packages.push(pkg);
        } else {
            invalid.push(format!("python_package:{}", pkg));
        }
    }

    (
        SkillRequires {
            bins: valid_bins,
            env: valid_env,
            python_packages: valid_python_packages,
        },
        invalid,
    )
}

fn probe_search_dirs(path: Option<&OsStr>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |dir: PathBuf| {
        if !dir.as_os_str().is_empty() && seen.insert(dir.clone()) {
            dirs.push(dir);
        }
    };

    if let Some(path) = path {
        for dir in env::split_paths(path) {
            push(dir);
        }
    }

    #[cfg(target_os = "macos")]
    for dir in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push(PathBuf::from(dir));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    for dir in [
        "/home/linuxbrew/.linuxbrew/bin",
        "/home/linuxbrew/.linuxbrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push(PathBuf::from(dir));
    }

    if let Some(home) = home {
        for relative in [".local/bin", ".cargo/bin", "bin"] {
            push(home.join(relative));
        }
    }

    dirs
}

#[cfg(unix)]
fn probe_bin_in_dirs(bin: &str, dirs: &[PathBuf]) -> bool {
    use std::os::unix::fs::PermissionsExt;

    dirs.iter().any(|dir| {
        std::fs::metadata(dir.join(bin))
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    })
}

fn probe_bin_sync(bin: &str) -> bool {
    let home = env::var_os("HOME").map(PathBuf::from);
    let dirs = probe_search_dirs(env::var_os("PATH").as_deref(), home.as_deref());

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("where");
        cmd.arg(bin);
        if let Ok(path) = env::join_paths(&dirs) {
            cmd.env("PATH", path);
        }
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(unix)]
    {
        probe_bin_in_dirs(bin, &dirs)
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = (bin, dirs);
        false
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

fn apply_no_window(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

/// Lightweight importability probe via `importlib.util.find_spec`.
fn probe_python_package_sync(package: &str) -> bool {
    let import_name = python_import_name(package);
    // Avoid injecting untrusted strings into -c beyond validated package → mapped import.
    let script = format!(
        "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec({import_name:?}) else 1)"
    );

    for python in ["python3", "python"] {
        let mut cmd = Command::new(python);
        cmd.args(["-c", &script]);
        apply_no_window(&mut cmd);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                return true;
            }
        }
    }
    false
}

async fn probe_python_package(package: &str) -> bool {
    let name = package.to_string();
    timeout(
        Duration::from_secs(PROBE_TIMEOUT_SECS),
        tokio::task::spawn_blocking(move || probe_python_package_sync(&name)),
    )
    .await
    .ok()
    .and_then(|join| join.ok())
    .unwrap_or(false)
}

/// Probe declared bins/env/python_packages on the local machine.
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

    let mut python_packages = Vec::new();
    for name in validated.python_packages {
        let found = probe_python_package(&name).await;
        python_packages.push(SkillRequiresPythonPackageProbe { name, found });
    }

    let missing_count = bins.iter().filter(|b| !b.found).count()
        + env.iter().filter(|e| !e.set).count()
        + python_packages.iter().filter(|p| !p.found).count();

    invalid.sort();
    invalid.dedup();

    SkillRequiresProbe {
        bins,
        env,
        python_packages,
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
    for pkg in probe.python_packages.iter().filter(|p| !p.found) {
        hints.push(python_package_missing_hint(&pkg.name));
    }

    hints
}

fn python_package_missing_hint(package: &str) -> String {
    let import_name = python_import_name(package);
    let import_note = if import_name != package.replace('-', "_").to_ascii_lowercase()
        && import_name.to_ascii_lowercase() != package.to_ascii_lowercase()
    {
        format!(" (import as `{import_name}`)")
    } else {
        String::new()
    };
    format!(
        "Python package `{package}` is not importable{import_note}. Prefer proposing `local_shell_execute` with `uv pip install {package}` (or `python3 -m pip install {package}`) after the skill is trusted and the command is approved, then retry loading this skill."
    )
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
            "python" | "python3" => {
                "Install Python 3 via your system package manager (e.g. apt install python3)."
            }
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
  python_packages:
    - pymupdf
---

# body
"#;
        let parsed = parse_requires_from_skill_md(md);
        assert_eq!(parsed.bins, vec!["python", "pandoc"]);
        assert_eq!(parsed.env, vec!["OPENAI_API_KEY"]);
        assert_eq!(parsed.python_packages, vec!["pymupdf"]);
    }

    #[test]
    fn parse_top_level_requires_inline_arrays() {
        let md = r#"---
name: Demo
description: Demo skill for requires parsing
requires:
  bins: [node, uv]
  env: [API_KEY, OTHER_ENV]
  python_packages: [pymupdf, pillow]
---
"#;
        let parsed = parse_requires_from_skill_md(md);
        assert_eq!(parsed.bins, vec!["node", "uv"]);
        assert_eq!(parsed.env, vec!["API_KEY", "OTHER_ENV"]);
        assert_eq!(parsed.python_packages, vec!["pymupdf", "pillow"]);
    }

    #[test]
    fn parse_missing_frontmatter_returns_empty() {
        let parsed = parse_requires_from_skill_md("# no frontmatter\n");
        assert!(parsed.bins.is_empty());
        assert!(parsed.env.is_empty());
        assert!(parsed.python_packages.is_empty());
    }

    #[test]
    fn frontmatter_delimiters_must_occupy_their_own_line() {
        assert!(extract_frontmatter("---suffix\nname: Demo\n---\n").is_none());
        assert!(extract_frontmatter("---\nname: Demo\n---suffix\n# body\n").is_none());
        assert!(extract_frontmatter("---\nname: Demo\n\t--- \r\n# body\n").is_none());
        assert_eq!(
            extract_frontmatter("  ---  \r\nname: Demo\r\n--- \r\n# body\n"),
            Some("name: Demo")
        );
    }

    #[test]
    fn parses_flow_map_and_openclaw_nested_requires() {
        let flow = parse_requires_from_skill_md(
            "---\nname: Demo\nrequires: {bins: [node, uv], env: [API_KEY], python_packages: [pymupdf]}\n---\n",
        );
        assert_eq!(flow.bins, vec!["node", "uv"]);
        assert_eq!(flow.env, vec!["API_KEY"]);
        assert_eq!(flow.python_packages, vec!["pymupdf"]);

        let nested = parse_requires_from_skill_md(
            "---\nname: Demo\nmetadata:\n  openclaw:\n    requires:\n      bins: [rg]\n      env:\n        - SEARCH_TOKEN\n      python_packages:\n        - pillow\n---\n",
        );
        assert_eq!(nested.bins, vec!["rg"]);
        assert_eq!(nested.env, vec!["SEARCH_TOKEN"]);
        assert_eq!(nested.python_packages, vec!["pillow"]);
    }

    #[test]
    fn python_import_name_maps_common_packages() {
        assert_eq!(python_import_name("pymupdf"), "fitz");
        assert_eq!(python_import_name("PyMuPDF"), "fitz");
        assert_eq!(python_import_name("pillow"), "PIL");
        assert_eq!(python_import_name("scikit-learn"), "sklearn");
        assert_eq!(python_import_name("requests"), "requests");
        assert_eq!(python_import_name("python-dateutil"), "dateutil");
    }

    #[test]
    fn probe_search_path_includes_gui_install_locations_without_shell_profiles() {
        let home = Path::new("/tmp/deep-student-home");
        let source_path =
            env::join_paths([Path::new("/custom/bin"), Path::new("/usr/bin")]).unwrap();
        let dirs = probe_search_dirs(Some(source_path.as_os_str()), Some(home));
        assert!(dirs.contains(&PathBuf::from("/custom/bin")));
        assert!(dirs.contains(&home.join(".local/bin")));
        assert!(dirs.contains(&home.join(".cargo/bin")));
        assert_eq!(
            dirs.iter()
                .filter(|path| path.as_path() == Path::new("/usr/bin"))
                .count(),
            1
        );
        #[cfg(target_os = "macos")]
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    }

    #[cfg(unix)]
    #[test]
    fn probe_bin_checks_executable_files_directly() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("demo-tool");
        std::fs::write(&executable, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(probe_bin_in_dirs("demo-tool", &[temp.path().to_path_buf()]));

        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!probe_bin_in_dirs(
            "demo-tool",
            &[temp.path().to_path_buf()]
        ));
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
            python_packages: vec![
                "pymupdf".to_string(),
                "bad pkg".to_string(),
                "../evil".to_string(),
            ],
        };
        let (valid, invalid) = partition_requires(requires);
        assert_eq!(valid.bins, vec!["python"]);
        assert_eq!(valid.env, vec!["GOOD_ENV"]);
        assert_eq!(valid.python_packages, vec!["pymupdf"]);
        assert_eq!(invalid.len(), 5);
    }

    #[tokio::test]
    async fn probe_env_reports_presence_only() {
        std::env::set_var("SKILL_REQUIRES_TEST_VAR", "1");
        let probe = probe_requires(SkillRequires {
            bins: Vec::new(),
            env: vec![
                "SKILL_REQUIRES_TEST_VAR".to_string(),
                "SKILL_REQUIRES_MISSING_VAR".to_string(),
            ],
            python_packages: Vec::new(),
        })
        .await;
        std::env::remove_var("SKILL_REQUIRES_TEST_VAR");

        let present = probe
            .env
            .iter()
            .find(|e| e.name == "SKILL_REQUIRES_TEST_VAR")
            .unwrap();
        assert!(present.set);
        let missing = probe
            .env
            .iter()
            .find(|e| e.name == "SKILL_REQUIRES_MISSING_VAR")
            .unwrap();
        assert!(!missing.set);
        assert_eq!(probe.missing_count, 1);
    }

    #[tokio::test]
    async fn probe_python_packages_reports_missing_and_stdlib_found() {
        let probe = probe_requires(SkillRequires {
            bins: Vec::new(),
            env: Vec::new(),
            python_packages: vec![
                "json".to_string(), // stdlib — found when Python is present
                "deep-student-definitely-missing-pkg-xyz".to_string(),
            ],
        })
        .await;

        let missing = probe
            .python_packages
            .iter()
            .find(|p| p.name == "deep-student-definitely-missing-pkg-xyz")
            .unwrap();
        assert!(!missing.found);

        let stdlib = probe
            .python_packages
            .iter()
            .find(|p| p.name == "json")
            .unwrap();
        // If neither python3 nor python is available, both are missing.
        if probe_bin_sync("python3") || probe_bin_sync("python") {
            assert!(stdlib.found);
            assert_eq!(probe.missing_count, 1);
        } else {
            assert!(!stdlib.found);
            assert_eq!(probe.missing_count, 2);
        }
    }

    #[test]
    fn format_hints_for_missing_python_on_windows() {
        let probe = SkillRequiresProbe {
            bins: vec![SkillRequiresBinProbe {
                name: "python".to_string(),
                found: false,
            }],
            env: Vec::new(),
            python_packages: Vec::new(),
            invalid: Vec::new(),
            missing_count: 1,
        };
        let hints = format_missing_requires_hints(&probe);
        assert_eq!(hints.len(), 1);
        assert!(hints[0].contains("python"));
        #[cfg(target_os = "windows")]
        assert!(hints[0].contains("winget install Python.Python.3"));
    }

    #[test]
    fn format_hints_for_missing_python_packages() {
        let probe = SkillRequiresProbe {
            bins: Vec::new(),
            env: Vec::new(),
            python_packages: vec![SkillRequiresPythonPackageProbe {
                name: "pymupdf".to_string(),
                found: false,
            }],
            invalid: Vec::new(),
            missing_count: 1,
        };
        let hints = format_missing_requires_hints(&probe);
        assert_eq!(hints.len(), 1);
        assert!(hints[0].contains("pymupdf"));
        assert!(hints[0].contains("fitz"));
        assert!(hints[0].contains("uv pip install pymupdf"));
        assert!(hints[0].contains("python3 -m pip install pymupdf"));
        assert!(hints[0].contains("local_shell_execute"));
    }
}
