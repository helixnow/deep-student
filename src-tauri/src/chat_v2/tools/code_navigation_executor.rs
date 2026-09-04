//! Cross-platform, read-only code navigation for the configured workspace.
//!
//! This provides a dependable baseline rather than pretending to be an LSP:
//! bounded tree text search and declaration outlines for one source file.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use async_trait::async_trait;
use regex::{Regex, RegexBuilder};
use serde_json::{json, Map, Value};
use tauri::Manager;
use walkdir::{DirEntry, WalkDir};

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::{
    normalize_runtime_relative_path, revalidate_runtime_root, runtime_root_by_id, RuntimeRootKind,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;

pub mod tool_names {
    pub const TEXT_SEARCH: &str = "workspace_text_search";
    pub const SYMBOL_OUTLINE: &str = "workspace_symbol_outline";
}

const MAX_QUERY_CHARS: usize = 500;
const MAX_RESULTS: usize = 500;
const DEFAULT_RESULTS: usize = 100;
const MAX_SCANNED_FILES: usize = 20_000;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LINE_CHARS: usize = 500;
const MAX_EXTENSIONS: usize = 32;

pub struct CodeNavigationExecutor;

impl Default for CodeNavigationExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl CodeNavigationExecutor {
    pub fn new() -> Self {
        Self
    }

    fn arguments(arguments: &Value) -> Result<&Map<String, Value>, String> {
        arguments
            .as_object()
            .ok_or_else(|| "arguments must be a JSON object".to_string())
    }

    fn ensure_allowed_keys(arguments: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
        if let Some(key) = arguments
            .keys()
            .find(|key| !allowed.contains(&key.as_str()))
        {
            return Err(format!("Unknown argument '{key}'"));
        }
        Ok(())
    }

    pub(crate) fn resolve_workspace(ctx: &ExecutionContext) -> Result<PathBuf, String> {
        let state = ctx.window_ref().state::<AppState>();
        let root = runtime_root_by_id(
            ctx.window_ref().app_handle(),
            &state.database,
            &ctx.session_id,
            ctx.skill_package_roots.as_ref(),
            Some("workspace"),
            true,
        )?;
        if root.kind != RuntimeRootKind::Workspace || !root.configured {
            return Err("Code navigation requires a configured workspace root".to_string());
        }
        revalidate_runtime_root(&state.database, &root)
    }

    fn is_private_component(component: &std::ffi::OsStr) -> bool {
        let Some(name) = component.to_str() else {
            return true;
        };
        let lower = name.to_ascii_lowercase();
        lower.starts_with('.')
            || matches!(
                lower.as_str(),
                "credential"
                    | "credentials"
                    | "credential.json"
                    | "credentials.json"
                    | "secret"
                    | "secrets"
                    | "secret.json"
                    | "secrets.json"
                    | "token"
                    | "tokens"
                    | "token.json"
                    | "tokens.json"
                    | "password"
                    | "passwords"
                    | "passwd"
                    | "shadow"
                    | "id_rsa"
                    | "id_dsa"
                    | "id_ecdsa"
                    | "id_ed25519"
            )
            || lower.ends_with(".pem")
            || lower.ends_with(".key")
            || lower.ends_with(".p12")
            || lower.ends_with(".pfx")
            || lower.contains("private_key")
            || lower.contains("private-key")
            || lower.starts_with("service-account")
            || lower.starts_with("service_account")
    }

    fn ensure_public_relative_path(relative: &Path) -> Result<(), String> {
        if relative.components().any(|component| match component {
            std::path::Component::Normal(value) => Self::is_private_component(value),
            _ => false,
        }) {
            return Err("Code navigation does not expose hidden or sensitive paths".to_string());
        }
        Ok(())
    }

    pub(crate) fn resolve_existing_path(
        root: &Path,
        raw: Option<&str>,
    ) -> Result<(PathBuf, PathBuf), String> {
        let relative = normalize_runtime_relative_path(raw)?;
        Self::ensure_public_relative_path(&relative)?;
        let mut current = root.to_path_buf();
        for component in relative.components() {
            let std::path::Component::Normal(value) = component else {
                continue;
            };
            current.push(value);
            let metadata = fs::symlink_metadata(&current)
                .map_err(|error| format!("Path does not exist or cannot be inspected: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err("Code navigation does not follow symlinks".to_string());
            }
        }
        let canonical = current
            .canonicalize()
            .map_err(|error| format!("Path does not exist or cannot be read: {error}"))?;
        if !canonical.starts_with(root) {
            return Err("Path escapes the workspace root".to_string());
        }
        Ok((relative, canonical))
    }

    fn bounded_usize(
        arguments: &Map<String, Value>,
        key: &str,
        default: usize,
        max: usize,
    ) -> Result<usize, String> {
        let Some(value) = arguments.get(key) else {
            return Ok(default);
        };
        let value = value
            .as_u64()
            .ok_or_else(|| format!("{key} must be an integer"))?;
        let value = usize::try_from(value).map_err(|_| format!("{key} is too large"))?;
        if value == 0 || value > max {
            return Err(format!("{key} must be between 1 and {max}"));
        }
        Ok(value)
    }

    fn extensions(arguments: &Map<String, Value>) -> Result<HashSet<String>, String> {
        let Some(value) = arguments.get("extensions") else {
            return Ok(HashSet::new());
        };
        let values = value
            .as_array()
            .ok_or_else(|| "extensions must be an array of strings".to_string())?;
        if values.len() > MAX_EXTENSIONS {
            return Err(format!(
                "extensions must contain at most {MAX_EXTENSIONS} entries"
            ));
        }
        values
            .iter()
            .map(|value| {
                let extension = value
                    .as_str()
                    .ok_or_else(|| "extensions entries must be strings".to_string())?
                    .trim()
                    .trim_start_matches('.')
                    .to_ascii_lowercase();
                if extension.is_empty()
                    || !extension
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric())
                {
                    return Err(format!("Invalid file extension '{extension}'"));
                }
                Ok(extension)
            })
            .collect()
    }

    fn should_enter(entry: &DirEntry) -> bool {
        if entry.depth() == 0 {
            return true;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        !entry.file_type().is_symlink()
            && !Self::is_private_component(entry.file_name())
            && !matches!(
                name.as_str(),
                "node_modules" | "target" | "dist" | "build" | "coverage" | ".next" | ".turbo"
            )
    }

    fn display_line(line: &str) -> String {
        let line = line.trim_end_matches('\r');
        if line.chars().count() <= MAX_LINE_CHARS {
            line.to_string()
        } else {
            let mut visible: String = line.chars().take(MAX_LINE_CHARS).collect();
            visible.push_str("...[truncated]");
            visible
        }
    }

    fn text_search(
        root: &Path,
        base: &Path,
        matcher: &Regex,
        extensions: &HashSet<String>,
        max_results: usize,
        cancellation: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<Value, String> {
        let mut matches = Vec::new();
        let mut scanned_files = 0usize;
        let mut skipped_files = 0usize;
        let mut truncated = false;

        for entry in WalkDir::new(base)
            .follow_links(false)
            .into_iter()
            .filter_entry(Self::should_enter)
        {
            if cancellation
                .as_ref()
                .is_some_and(|token| token.is_cancelled())
            {
                return Err("Code search cancelled".to_string());
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    skipped_files += 1;
                    continue;
                }
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if !extensions.is_empty()
                && !path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| extensions.contains(&value.to_ascii_lowercase()))
            {
                continue;
            }
            if scanned_files >= MAX_SCANNED_FILES {
                truncated = true;
                break;
            }
            scanned_files += 1;
            if !entry
                .metadata()
                .is_ok_and(|metadata| metadata.len() <= MAX_SOURCE_BYTES)
            {
                skipped_files += 1;
                continue;
            }
            let bytes = match fs::read(path) {
                Ok(bytes) if !bytes.contains(&0) => bytes,
                _ => {
                    skipped_files += 1;
                    continue;
                }
            };
            let text = match std::str::from_utf8(&bytes) {
                Ok(text) => text,
                Err(_) => {
                    skipped_files += 1;
                    continue;
                }
            };
            let relative = path
                .strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            for (line_index, line) in text.lines().enumerate() {
                let Some(found) = matcher.find(line) else {
                    continue;
                };
                matches.push(json!({
                    "path": relative,
                    "line": line_index + 1,
                    "column": line[..found.start()].chars().count() + 1,
                    "text": Self::display_line(line),
                }));
                if matches.len() >= max_results {
                    truncated = true;
                    break;
                }
            }
            if matches.len() >= max_results {
                break;
            }
        }

        Ok(json!({
            "root_id": "workspace",
            "matches": matches,
            "match_count": matches.len(),
            "scanned_files": scanned_files,
            "skipped_files": skipped_files,
            "truncated": truncated,
        }))
    }

    fn symbol_patterns(extension: &str) -> Result<Vec<Regex>, String> {
        let rust = r#"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const)\s+)*(?P<kind>fn|struct|enum|trait|union|type|mod|const|static)\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)"#;
        let javascript = r#"^\s*(?:export\s+(?:default\s+)?)?(?:(?:declare|abstract|async)\s+)*(?P<kind>function|class|interface|type|enum|namespace|const|let|var)\s+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)"#;
        let python =
            r#"^\s*(?:(?:async)\s+)?(?P<kind>def|class)\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)"#;
        let go = r#"^\s*(?P<kind>func|type|var|const)\s+(?:\([^)]*\)\s*)?(?P<name>[A-Za-z_][A-Za-z0-9_]*)"#;
        let nominal = r#"^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|final|data|open)\s+)*(?P<kind>class|interface|enum|record|struct|object)\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)"#;
        let selected: &[&str] = match extension {
            "rs" => &[rust],
            "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" => &[javascript],
            "py" | "pyi" => &[python],
            "go" => &[go],
            "java" | "kt" | "kts" | "cs" | "swift" => &[nominal],
            _ => &[rust, javascript, python, go, nominal],
        };
        selected
            .iter()
            .map(|pattern| Regex::new(pattern).map_err(|error| error.to_string()))
            .collect()
    }

    fn symbol_outline(root: &Path, path: &Path, max_symbols: usize) -> Result<Value, String> {
        let metadata =
            fs::metadata(path).map_err(|error| format!("Failed to inspect file: {error}"))?;
        if !metadata.is_file() {
            return Err("workspace_symbol_outline path must be a file".to_string());
        }
        if metadata.len() > MAX_SOURCE_BYTES {
            return Err(format!(
                "Source file exceeds the {MAX_SOURCE_BYTES} byte outline limit"
            ));
        }
        let text = fs::read_to_string(path)
            .map_err(|error| format!("Source file must be UTF-8 text: {error}"))?;
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let patterns = Self::symbol_patterns(&extension)?;
        let mut symbols = Vec::new();
        let mut seen = HashSet::new();
        let mut truncated = false;
        for (line_index, line) in text.lines().enumerate() {
            for pattern in &patterns {
                let Some(captures) = pattern.captures(line) else {
                    continue;
                };
                let kind = captures
                    .name("kind")
                    .map(|value| value.as_str())
                    .unwrap_or("symbol");
                let name = captures
                    .name("name")
                    .map(|value| value.as_str())
                    .unwrap_or("");
                if name.is_empty() || !seen.insert((line_index, name.to_string())) {
                    continue;
                }
                if symbols.len() == max_symbols {
                    truncated = true;
                    break;
                }
                symbols.push(json!({
                    "name": name,
                    "kind": kind,
                    "line": line_index + 1,
                    "signature": Self::display_line(line.trim()),
                }));
                break;
            }
            if truncated {
                break;
            }
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        Ok(json!({
            "root_id": "workspace",
            "path": relative,
            "language_hint": extension,
            "symbols": symbols,
            "symbol_count": symbols.len(),
            "truncated": truncated,
            "precision": "declaration_outline",
        }))
    }

    async fn execute_text_search(
        &self,
        arguments: &Map<String, Value>,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        Self::ensure_allowed_keys(
            arguments,
            &[
                "query",
                "path",
                "regex",
                "case_sensitive",
                "extensions",
                "max_results",
            ],
        )?;
        let query = arguments
            .get("query")
            .and_then(Value::as_str)
            .ok_or_else(|| "query is required and must be a string".to_string())?;
        if query.is_empty() || query.chars().count() > MAX_QUERY_CHARS {
            return Err(format!(
                "query must contain between 1 and {MAX_QUERY_CHARS} characters"
            ));
        }
        let regex_mode = match arguments.get("regex") {
            Some(value) => value
                .as_bool()
                .ok_or_else(|| "regex must be a boolean".to_string())?,
            None => false,
        };
        let case_sensitive = match arguments.get("case_sensitive") {
            Some(value) => value
                .as_bool()
                .ok_or_else(|| "case_sensitive must be a boolean".to_string())?,
            None => true,
        };
        let pattern = if regex_mode {
            query.to_string()
        } else {
            regex::escape(query)
        };
        let matcher = RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|error| format!("Invalid search regex: {error}"))?;
        let extensions = Self::extensions(arguments)?;
        let max_results =
            Self::bounded_usize(arguments, "max_results", DEFAULT_RESULTS, MAX_RESULTS)?;
        let root = Self::resolve_workspace(ctx)?;
        let (_, base) =
            Self::resolve_existing_path(&root, arguments.get("path").and_then(Value::as_str))?;
        if !base.is_dir() {
            return Err("workspace_text_search path must be a directory".to_string());
        }
        let cancellation = ctx.cancellation_token().cloned();
        tokio::task::spawn_blocking(move || {
            Self::text_search(
                &root,
                &base,
                &matcher,
                &extensions,
                max_results,
                cancellation,
            )
        })
        .await
        .map_err(|error| format!("Code search worker failed: {error}"))?
    }

    async fn execute_symbol_outline(
        &self,
        arguments: &Map<String, Value>,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        Self::ensure_allowed_keys(arguments, &["path", "max_symbols"])?;
        let path = arguments
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "path is required and must be a string".to_string())?;
        let max_symbols = Self::bounded_usize(arguments, "max_symbols", 200, MAX_RESULTS)?;
        let root = Self::resolve_workspace(ctx)?;
        let (_, source) = Self::resolve_existing_path(&root, Some(path))?;
        tokio::task::spawn_blocking(move || Self::symbol_outline(&root, &source, max_symbols))
            .await
            .map_err(|error| format!("Symbol outline worker failed: {error}"))?
    }
}

#[async_trait]
impl ToolExecutor for CodeNavigationExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            tool_names::TEXT_SEARCH | tool_names::SYMBOL_OUTLINE
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));
        let result = match Self::arguments(&call.arguments) {
            Ok(arguments) => match strip_tool_namespace(&call.name) {
                tool_names::TEXT_SEARCH => self.execute_text_search(arguments, ctx).await,
                tool_names::SYMBOL_OUTLINE => self.execute_symbol_outline(arguments, ctx).await,
                other => Err(format!("Unknown code navigation tool: {other}")),
            },
            Err(error) => Err(error),
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        let tool_result = match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));
                ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                )
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);
                ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                )
            }
        };
        if let Err(error) = ctx.save_tool_block(&tool_result) {
            log::warn!("[CodeNavigationExecutor] Failed to persist tool block: {error}");
        }
        Ok(tool_result)
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        ToolConcurrency::ReadOnly
    }

    fn name(&self) -> &'static str {
        "CodeNavigationExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_search_is_bounded_and_filters_extensions() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("main.rs"), "fn alpha() {}\nalpha();\n").unwrap();
        fs::write(temp.path().join("notes.md"), "alpha\n").unwrap();
        let output = CodeNavigationExecutor::text_search(
            temp.path(),
            temp.path(),
            &Regex::new("alpha").unwrap(),
            &HashSet::from(["rs".to_string()]),
            1,
            None,
        )
        .unwrap();
        assert_eq!(output["match_count"], 1);
        assert_eq!(output["matches"][0]["path"], "main.rs");
        assert_eq!(output["matches"][0]["line"], 1);
        assert_eq!(output["truncated"], true);
    }

    #[test]
    fn search_skips_generated_and_hidden_directories() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("target")).unwrap();
        fs::create_dir(temp.path().join(".git")).unwrap();
        fs::create_dir(temp.path().join("secrets")).unwrap();
        fs::write(temp.path().join("target/generated.rs"), "needle").unwrap();
        fs::write(temp.path().join(".git/config"), "needle").unwrap();
        fs::write(temp.path().join("secrets/token.txt"), "needle").unwrap();
        fs::write(temp.path().join("visible.rs"), "needle").unwrap();
        let output = CodeNavigationExecutor::text_search(
            temp.path(),
            temp.path(),
            &Regex::new("needle").unwrap(),
            &HashSet::new(),
            10,
            None,
        )
        .unwrap();
        assert_eq!(output["match_count"], 1);
        assert_eq!(output["matches"][0]["path"], "visible.rs");
    }

    #[test]
    fn outlines_rust_and_typescript_declarations() {
        let temp = tempfile::tempdir().unwrap();
        let rust = temp.path().join("lib.rs");
        fs::write(
            &rust,
            "pub struct Item;\nimpl Item {}\nasync fn load() {}\n",
        )
        .unwrap();
        let output = CodeNavigationExecutor::symbol_outline(temp.path(), &rust, 20).unwrap();
        assert_eq!(output["symbol_count"], 2);
        assert_eq!(output["symbols"][0]["name"], "Item");
        assert_eq!(output["symbols"][1]["name"], "load");

        let ts = temp.path().join("view.ts");
        fs::write(
            &ts,
            "export interface View {}\nexport const createView = () => {};\n",
        )
        .unwrap();
        let output = CodeNavigationExecutor::symbol_outline(temp.path(), &ts, 20).unwrap();
        assert_eq!(output["symbol_count"], 2);
        assert_eq!(output["symbols"][1]["kind"], "const");
    }

    #[test]
    fn outline_marks_truncated_only_when_an_extra_symbol_exists() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("lib.rs");
        fs::write(&source, "fn one() {}\n").unwrap();
        let output = CodeNavigationExecutor::symbol_outline(temp.path(), &source, 1).unwrap();
        assert_eq!(output["truncated"], false);

        fs::write(&source, "fn one() {}\nfn two() {}\n").unwrap();
        let output = CodeNavigationExecutor::symbol_outline(temp.path(), &source, 1).unwrap();
        assert_eq!(output["symbol_count"], 1);
        assert_eq!(output["truncated"], true);
    }

    #[test]
    fn executor_contract_is_low_readonly() {
        let executor = CodeNavigationExecutor::new();
        assert!(executor.can_handle("builtin-workspace_text_search"));
        assert!(executor.can_handle("workspace_symbol_outline"));
        assert!(!executor.can_handle("workspace_file_write"));
        assert_eq!(
            executor.sensitivity_level("builtin-workspace_text_search"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.concurrency_class("builtin-workspace_symbol_outline"),
            ToolConcurrency::ReadOnly
        );
    }
}
