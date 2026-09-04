//! Read-only semantic code navigation backed by installed language servers.
//!
//! The executor speaks LSP over stdio directly and keeps one initialized server
//! per workspace/language. It intentionally exposes navigation only: definition,
//! references, hover, and document symbols. Rename/code actions are not available.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;
use url::Url;

use super::code_navigation_executor::CodeNavigationExecutor;
use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

pub mod tool_names {
    pub const DEFINITION: &str = "workspace_lsp_definition";
    pub const REFERENCES: &str = "workspace_lsp_references";
    pub const HOVER: &str = "workspace_lsp_hover";
    pub const DOCUMENT_SYMBOLS: &str = "workspace_lsp_document_symbols";
}

const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LSP_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum LspLanguage {
    Rust,
    TypeScript,
    Python,
}

impl LspLanguage {
    fn for_path(path: &Path) -> Result<Self, String> {
        match path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "rs" => Ok(Self::Rust),
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Ok(Self::TypeScript),
            "py" | "pyi" => Ok(Self::Python),
            extension => Err(format!(
                "No supported LSP mapping for extension '{extension}'. Supported: Rust, TypeScript/JavaScript, Python"
            )),
        }
    }

    fn server_name(self) -> &'static str {
        match self {
            Self::Rust => "rust-analyzer",
            Self::TypeScript => "typescript-language-server",
            Self::Python => "pyright-langserver",
        }
    }

    fn language_id(self, path: &Path) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => match path.extension().and_then(|value| value.to_str()) {
                Some("tsx") => "typescriptreact",
                Some("js" | "mjs" | "cjs") => "javascript",
                Some("jsx") => "javascriptreact",
                _ => "typescript",
            },
            Self::Python => "python",
        }
    }

    fn arguments(self) -> &'static [&'static str] {
        match self {
            Self::Rust => &[],
            Self::TypeScript | Self::Python => &["--stdio"],
        }
    }

    fn initialization_options(self) -> Value {
        match self {
            // Semantic navigation must not implicitly run workspace build scripts
            // or load project proc macros.
            Self::Rust => json!({
                "cargo": { "buildScripts": { "enable": false } },
                "procMacro": { "enable": false },
                "diagnostics": { "enable": false },
                "checkOnSave": false,
            }),
            _ => Value::Null,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SessionKey {
    root: PathBuf,
    language: LspLanguage,
}

struct OpenDocument {
    version: i32,
    text: String,
}

struct LspSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    root_uri: String,
    server_name: &'static str,
    open_documents: HashMap<String, OpenDocument>,
}

impl LspSession {
    async fn start(root: &Path, language: LspLanguage) -> Result<Self, String> {
        let executable = locate_server(language)?;
        let mut command = server_command(&executable, language.arguments());
        command
            .current_dir(root)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("NO_COLOR", "1");
        let mut child = command.spawn().map_err(|error| {
            format!(
                "Failed to start {} at '{}': {error}",
                language.server_name(),
                executable.display()
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Language server stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Language server stdout is unavailable".to_string())?;
        let root_uri = file_uri(root, true)?;
        let mut session = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            root_uri: root_uri.clone(),
            server_name: language.server_name(),
            open_documents: HashMap::new(),
        };
        let initialize = json!({
            "processId": Value::Null,
            "rootUri": root_uri,
            "workspaceFolders": [{ "uri": session.root_uri, "name": root.file_name().and_then(|name| name.to_str()).unwrap_or("workspace") }],
            "capabilities": {
                "textDocument": {
                    "definition": { "linkSupport": true },
                    "references": {},
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                    "synchronization": { "didSave": false, "dynamicRegistration": false }
                },
                "workspace": { "workspaceFolders": true }
            },
            "initializationOptions": language.initialization_options(),
            "clientInfo": { "name": "Deep Student", "version": env!("CARGO_PKG_VERSION") },
        });
        session.request("initialize", initialize).await?;
        session.notify("initialized", json!({})).await?;
        Ok(session)
    }

    fn is_running(&mut self) -> bool {
        self.child.try_wait().is_ok_and(|status| status.is_none())
    }

    async fn write_message(&mut self, value: &Value) -> Result<(), String> {
        let payload = serde_json::to_vec(value)
            .map_err(|error| format!("Failed to encode LSP request: {error}"))?;
        let header = format!("Content-Length: {}\r\n\r\n", payload.len());
        self.stdin
            .write_all(header.as_bytes())
            .await
            .map_err(|error| format!("Failed to write LSP header: {error}"))?;
        self.stdin
            .write_all(&payload)
            .await
            .map_err(|error| format!("Failed to write LSP payload: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Failed to flush LSP request: {error}"))
    }

    async fn read_message(&mut self) -> Result<Value, String> {
        let mut content_length = None;
        loop {
            let mut line = String::new();
            let bytes = self
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|error| format!("Failed to read LSP header: {error}"))?;
            if bytes == 0 {
                return Err(format!("{} exited before responding", self.server_name));
            }
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                break;
            }
            if let Some(value) = line.strip_prefix("Content-Length:") {
                content_length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|_| "Invalid LSP Content-Length header".to_string())?,
                );
            }
        }
        let length =
            content_length.ok_or_else(|| "LSP response omitted Content-Length".to_string())?;
        if length > MAX_LSP_MESSAGE_BYTES {
            return Err(format!(
                "LSP response exceeds the {MAX_LSP_MESSAGE_BYTES} byte limit"
            ));
        }
        let mut payload = vec![0; length];
        self.stdout
            .read_exact(&mut payload)
            .await
            .map_err(|error| format!("Failed to read LSP response: {error}"))?;
        serde_json::from_slice(&payload)
            .map_err(|error| format!("Language server returned invalid JSON: {error}"))
    }

    async fn respond_to_server_request(&mut self, message: &Value) -> Result<(), String> {
        let Some(id) = message.get("id") else {
            return Ok(());
        };
        let result = match message.get("method").and_then(Value::as_str) {
            Some("workspace/configuration") => {
                let count = message
                    .pointer("/params/items")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                Value::Array(vec![Value::Null; count])
            }
            Some("workspace/workspaceFolders") => json!([{
                "uri": self.root_uri,
                "name": "workspace"
            }]),
            _ => Value::Null,
        };
        self.write_message(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await?;
        loop {
            let message = self.read_message().await?;
            if message.get("id").and_then(Value::as_u64) == Some(id)
                && (message.get("result").is_some() || message.get("error").is_some())
            {
                if let Some(error) = message.get("error") {
                    return Err(format!(
                        "{} returned an LSP error: {error}",
                        self.server_name
                    ));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            if message.get("id").is_some() && message.get("method").is_some() {
                self.respond_to_server_request(&message).await?;
            }
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn sync_document(
        &mut self,
        uri: &str,
        language_id: &str,
        text: String,
    ) -> Result<(), String> {
        if let Some(document) = self.open_documents.get_mut(uri) {
            if document.text == text {
                return Ok(());
            }
            document.version += 1;
            document.text.clone_from(&text);
            let version = document.version;
            self.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": { "uri": uri, "version": version },
                    "contentChanges": [{ "text": text }],
                }),
            )
            .await
        } else {
            self.notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": language_id,
                        "version": 1,
                        "text": text,
                    }
                }),
            )
            .await?;
            self.open_documents
                .insert(uri.to_string(), OpenDocument { version: 1, text });
            Ok(())
        }
    }
}

pub struct LspNavigationExecutor {
    sessions: Mutex<HashMap<SessionKey, Arc<Mutex<LspSession>>>>,
}

impl Default for LspNavigationExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl LspNavigationExecutor {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    async fn session(&self, key: &SessionKey) -> Result<Arc<Mutex<LspSession>>, String> {
        if let Some(session) = self.sessions.lock().await.get(key).cloned() {
            if session.lock().await.is_running() {
                return Ok(session);
            }
            self.sessions.lock().await.remove(key);
        }
        let session = timeout(REQUEST_TIMEOUT, LspSession::start(&key.root, key.language))
            .await
            .map_err(|_| format!("{} initialization timed out", key.language.server_name()))??;
        let session = Arc::new(Mutex::new(session));
        self.sessions
            .lock()
            .await
            .insert(key.clone(), session.clone());
        Ok(session)
    }

    async fn remove_session(&self, key: &SessionKey) {
        if let Some(session) = self.sessions.lock().await.remove(key) {
            let _ = session.lock().await.child.kill().await;
        }
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

    fn source_position(text: &str, line: u64, column: u64) -> Result<Value, String> {
        if line == 0 || column == 0 {
            return Err("line and column are 1-based and must be at least 1".to_string());
        }
        let source_line = text
            .lines()
            .nth((line - 1) as usize)
            .ok_or_else(|| format!("line {line} is outside the source file"))?;
        let prefix: String = source_line.chars().take((column - 1) as usize).collect();
        if prefix.chars().count() != (column - 1) as usize {
            return Err(format!("column {column} is outside line {line}"));
        }
        Ok(json!({
            "line": line - 1,
            "character": prefix.encode_utf16().count(),
        }))
    }

    async fn execute_query(
        &self,
        tool_name: &str,
        arguments: &Map<String, Value>,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let position_required = !matches!(tool_name, tool_names::DOCUMENT_SYMBOLS);
        let allowed = if tool_name == tool_names::REFERENCES {
            &["path", "line", "column", "include_declaration"][..]
        } else if position_required {
            &["path", "line", "column"][..]
        } else {
            &["path"][..]
        };
        Self::ensure_allowed_keys(arguments, allowed)?;
        let raw_path = arguments
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "path is required and must be a string".to_string())?;
        let root = CodeNavigationExecutor::resolve_workspace(ctx)?;
        let (relative, source_path) =
            CodeNavigationExecutor::resolve_existing_path(&root, Some(raw_path))?;
        let metadata = std::fs::metadata(&source_path)
            .map_err(|error| format!("Failed to inspect source file: {error}"))?;
        if !metadata.is_file() {
            return Err("LSP navigation path must be a source file".to_string());
        }
        if metadata.len() > MAX_SOURCE_BYTES {
            return Err(format!(
                "Source file exceeds the {MAX_SOURCE_BYTES} byte limit"
            ));
        }
        let text = std::fs::read_to_string(&source_path)
            .map_err(|error| format!("Source file must be UTF-8 text: {error}"))?;
        let language = LspLanguage::for_path(&source_path)?;
        let uri = file_uri(&source_path, false)?;
        let position = if position_required {
            let line = arguments
                .get("line")
                .and_then(Value::as_u64)
                .ok_or_else(|| "line is required and must be a positive integer".to_string())?;
            let column = arguments
                .get("column")
                .and_then(Value::as_u64)
                .ok_or_else(|| "column is required and must be a positive integer".to_string())?;
            Some(Self::source_position(&text, line, column)?)
        } else {
            None
        };
        let key = SessionKey {
            root: root.clone(),
            language,
        };
        let session = self.session(&key).await?;
        let cancellation = ctx.cancellation_token().cloned();
        let query = async {
            let mut session = session.lock().await;
            session
                .sync_document(&uri, language.language_id(&source_path), text)
                .await?;
            let text_document = json!({ "uri": uri });
            let (method, params) = match tool_name {
                tool_names::DEFINITION => (
                    "textDocument/definition",
                    json!({ "textDocument": text_document, "position": position }),
                ),
                tool_names::REFERENCES => (
                    "textDocument/references",
                    json!({
                        "textDocument": text_document,
                        "position": position,
                        "context": {
                            "includeDeclaration": arguments
                                .get("include_declaration")
                                .and_then(Value::as_bool)
                                .unwrap_or(true)
                        }
                    }),
                ),
                tool_names::HOVER => (
                    "textDocument/hover",
                    json!({ "textDocument": text_document, "position": position }),
                ),
                tool_names::DOCUMENT_SYMBOLS => (
                    "textDocument/documentSymbol",
                    json!({ "textDocument": text_document }),
                ),
                other => return Err(format!("Unknown LSP navigation tool: {other}")),
            };
            let mut result = session.request(method, params).await?;
            normalize_result_uris(&mut result, &root);
            Ok(json!({
                "root_id": "workspace",
                "path": relative.to_string_lossy().replace('\\', "/"),
                "server": language.server_name(),
                "method": method,
                "result": result,
            }))
        };
        let result = if let Some(token) = cancellation {
            tokio::select! {
                _ = token.cancelled() => Err("LSP navigation cancelled".to_string()),
                result = timeout(REQUEST_TIMEOUT, query) => result
                    .map_err(|_| format!("{} request timed out", language.server_name()))?,
            }
        } else {
            timeout(REQUEST_TIMEOUT, query)
                .await
                .map_err(|_| format!("{} request timed out", language.server_name()))?
        };
        if result.is_err() {
            self.remove_session(&key).await;
        }
        result
    }
}

fn file_uri(path: &Path, directory: bool) -> Result<String, String> {
    let url = if directory {
        Url::from_directory_path(path)
    } else {
        Url::from_file_path(path)
    }
    .map_err(|_| format!("Failed to convert '{}' to a file URI", path.display()))?;
    Ok(url.to_string())
}

fn normalize_result_uris(value: &mut Value, root: &Path) {
    match value {
        Value::Array(items) => {
            items.retain_mut(|item| {
                normalize_result_uris(item, root);
                !item.is_null()
            });
        }
        Value::Object(map) => {
            for key in ["uri", "targetUri"] {
                let Some(uri) = map.get(key).and_then(Value::as_str) else {
                    continue;
                };
                let Ok(url) = Url::parse(uri) else {
                    continue;
                };
                if url.scheme() != "file" {
                    continue;
                }
                let Ok(path) = url.to_file_path() else {
                    continue;
                };
                let Ok(relative) = path.strip_prefix(root) else {
                    *value = Value::Null;
                    return;
                };
                map.insert(
                    key.to_string(),
                    Value::String(relative.to_string_lossy().replace('\\', "/")),
                );
            }
            for child in map.values_mut() {
                normalize_result_uris(child, root);
            }
        }
        _ => {}
    }
}

fn executable_names(base: &str) -> Vec<OsString> {
    #[cfg(windows)]
    {
        vec![
            format!("{base}.exe").into(),
            format!("{base}.cmd").into(),
            format!("{base}.bat").into(),
            base.into(),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![base.into()]
    }
}

fn server_command(executable: &Path, arguments: &[&str]) -> Command {
    #[cfg(windows)]
    {
        let extension = executable
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
            let mut command = Command::new("cmd.exe");
            command.arg("/D").arg("/S").arg("/C").arg(executable);
            command.args(arguments);
            return command;
        }
    }
    let mut command = Command::new(executable);
    command.args(arguments);
    command
}

fn locate_server(language: LspLanguage) -> Result<PathBuf, String> {
    let names = executable_names(language.server_name());
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        directories.push(home.join(".cargo").join("bin"));
        directories.push(home.join(".local").join("bin"));
        #[cfg(windows)]
        directories.push(home.join("AppData").join("Roaming").join("npm"));
    }
    #[cfg(target_os = "macos")]
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    for directory in directories {
        if !directory.is_absolute() {
            continue;
        }
        for name in &names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!(
        "{} is not installed or was not found on PATH",
        language.server_name()
    ))
}

#[async_trait]
impl ToolExecutor for LspNavigationExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            tool_names::DEFINITION
                | tool_names::REFERENCES
                | tool_names::HOVER
                | tool_names::DOCUMENT_SYMBOLS
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
            Ok(arguments) => {
                self.execute_query(strip_tool_namespace(&call.name), arguments, ctx)
                    .await
            }
            Err(error) => Err(error),
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        let tool_result = match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(
                    json!({ "result": output, "durationMs": duration_ms }),
                ));
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
            log::warn!("[LspNavigationExecutor] Failed to persist tool block: {error}");
        }
        Ok(tool_result)
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // Queries are read-only, but starting an installed external language
        // server is process execution and therefore not classified Low.
        ToolSensitivity::Medium
    }

    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        // Starting and retaining an external process must not participate in
        // the registry's parallel read retry path.
        ToolConcurrency::Serial
    }

    fn manages_cancellation(&self, _tool_name: &str) -> bool {
        true
    }

    fn name(&self) -> &'static str {
        "LspNavigationExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_mapping_covers_initial_server_set() {
        assert_eq!(
            LspLanguage::for_path(Path::new("lib.rs")).unwrap(),
            LspLanguage::Rust
        );
        assert_eq!(
            LspLanguage::for_path(Path::new("view.tsx")).unwrap(),
            LspLanguage::TypeScript
        );
        assert_eq!(
            LspLanguage::for_path(Path::new("main.py")).unwrap(),
            LspLanguage::Python
        );
        assert!(LspLanguage::for_path(Path::new("main.go")).is_err());
    }

    #[test]
    fn source_positions_are_one_based_and_convert_to_utf16() {
        let position = LspNavigationExecutor::source_position("a😀b\n", 1, 3).unwrap();
        assert_eq!(position, json!({ "line": 0, "character": 3 }));
        assert!(LspNavigationExecutor::source_position("a", 0, 1).is_err());
        assert!(LspNavigationExecutor::source_position("a", 1, 3).is_err());
    }

    #[test]
    fn executor_contract_is_medium_readonly() {
        let executor = LspNavigationExecutor::new();
        assert!(executor.can_handle("builtin-workspace_lsp_definition"));
        assert!(executor.can_handle("workspace_lsp_document_symbols"));
        assert!(!executor.can_handle("workspace_symbol_outline"));
        assert_eq!(
            executor.sensitivity_level("workspace_lsp_hover"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.concurrency_class("workspace_lsp_references"),
            ToolConcurrency::Serial
        );
    }

    #[test]
    fn result_uris_are_relative_and_external_locations_are_removed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let inside = file_uri(&root.join("src/lib.rs"), false).unwrap();
        let outside = file_uri(&temp.path().join("dependency/lib.rs"), false).unwrap();
        let mut result = json!([
            { "uri": inside, "range": {} },
            { "targetUri": outside, "targetRange": {} }
        ]);
        normalize_result_uris(&mut result, &root);
        assert_eq!(result.as_array().unwrap().len(), 1);
        assert_eq!(result[0]["uri"], "src/lib.rs");
    }

    #[tokio::test]
    async fn rust_analyzer_completes_initialize_handshake_when_installed() {
        let Ok(executable) = locate_server(LspLanguage::Rust) else {
            return;
        };
        let mut version = server_command(&executable, &["--version"]);
        version
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let available = timeout(Duration::from_secs(5), version.status())
            .await
            .ok()
            .and_then(Result::ok)
            .is_some_and(|status| status.success());
        if !available {
            // rustup may install a proxy named rust-analyzer even when the
            // component itself is absent; that is not an installed server.
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"lsp-smoke\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::create_dir(temp.path().join("src")).unwrap();
        std::fs::write(
            temp.path().join("src/lib.rs"),
            "pub fn answer() -> u32 { 42 }\n",
        )
        .unwrap();
        let mut session = timeout(
            REQUEST_TIMEOUT,
            LspSession::start(temp.path(), LspLanguage::Rust),
        )
        .await
        .expect("rust-analyzer initialization timed out")
        .expect("rust-analyzer initialization failed");
        let _ = session.child.kill().await;
    }
}
