//! `builtin-chatanki_transform` 沙箱脚本模式（script mode）。
//!
//! 实现调研报告 `docs/research/anki-ai-native/round1/04-shell-script-integration.md`
//! 方案 B 的「计算面」：
//!
//! 1. **快照导出**：执行器把选中卡片的 DB 无截断全文快照（连同 Rust 侧记录的
//!    version）写入会话 temp root 下的 job 目录 `CHATANKI_INPUT.json`；
//! 2. **沙箱执行**：复用 `shell_sandbox::PlatformSandboxBackend`（macOS Seatbelt /
//!    Linux bwrap / Windows AppContainer；移动端 fail-closed），网络恒禁、
//!    只挂载 job 目录可写，环境变量白名单注入 `CHATANKI_INPUT` / `CHATANKI_OUTPUT`；
//! 3. **输出校验**：脚本写回的 `CHATANKI_OUTPUT.json` 经严格 schema 校验转成
//!    逐卡字段补丁；**脚本回传的 `version` 一律忽略**（CAS 只认快照时 Rust 记录的
//!    version）；v1 只允许 update 既有卡字段，禁止脚本增删卡。
//!
//! 本模块只承载「参数归一化 + I/O 合同 + 解释器探测 + 沙箱运行 + 输出校验」，
//! 全部为纯函数或自包含 async 原语；DB 快照读取与 CAS 写回仍在
//! `chatanki_executor.rs` 的 `execute_transform` 中复用 ops 模式同一条路径完成。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::chatanki_transform::TransformFields;
use super::shell_sandbox::{
    platform_sandbox_contract, terminate_process_group, PlatformSandboxBackend, SandboxBackend,
    SandboxCapability, SandboxPolicy,
};

// ============================================================================
// 资源边界（对齐调研报告 §6）
// ============================================================================

/// 脚本正文长度上限（JSON Schema maxLength 同值，按 Unicode 标量计）。
pub(crate) const CHATANKI_TRANSFORM_SCRIPT_CODE_MAX_CHARS: usize = 65_536;
/// 脚本超时下限（毫秒）。
pub(crate) const CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MIN_MS: u64 = 1_000;
/// 脚本超时上限（毫秒），与 local_shell 的 120s 对齐。
pub(crate) const CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MAX_MS: u64 = 120_000;
/// 脚本默认超时（毫秒）。
pub(crate) const CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_DEFAULT_MS: u64 = 30_000;
/// `CHATANKI_OUTPUT.json` 文件大小上限。
pub(crate) const CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// 脚本回传的单卡 tags 数上限（宽于 ops 单 op 的 50：允许全量重写标签集）。
pub(crate) const CHATANKI_TRANSFORM_SCRIPT_TAGS_LIMIT: usize = 100;
/// stdout / stderr 各自保留的日志尾部字节数（数据面走文件，stdout 只承载日志）。
const SCRIPT_STREAM_TAIL_BYTES: usize = 16 * 1024;
/// 超时杀进程组后等待收尸 / 排空管道的宽限期。
const SCRIPT_CLEANUP_GRACE: Duration = Duration::from_secs(5);

/// job 目录内的固定文件名（同时也是环境变量指向的目标）。
pub(crate) const CHATANKI_INPUT_FILE: &str = "CHATANKI_INPUT.json";
pub(crate) const CHATANKI_OUTPUT_FILE: &str = "CHATANKI_OUTPUT.json";

static JOB_SEQ: AtomicU64 = AtomicU64::new(0);

// ============================================================================
// 参数（wire 形态 → 归一化）
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ScriptLanguage {
    Python,
    Node,
}

impl ScriptLanguage {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Python => "python",
            Self::Node => "node",
        }
    }

    /// 解释器候选名（按优先级），与 `skill_requires::probe_bin` 相同的探测思路：
    /// 只在绝对路径目录集中直接查可执行文件，不经 shell。
    fn candidate_bins(&self) -> &'static [&'static str] {
        match self {
            Self::Python => &["python3", "python"],
            Self::Node => &["node"],
        }
    }

    fn script_file_name(&self) -> &'static str {
        match self {
            Self::Python => "transform_script.py",
            Self::Node => "transform_script.js",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransformScriptSpec {
    language: ScriptLanguage,
    code: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NormalizedTransformScript {
    pub(crate) language: ScriptLanguage,
    pub(crate) code: String,
    pub(crate) timeout: Duration,
}

impl TransformScriptSpec {
    pub(crate) fn normalize(self) -> Result<NormalizedTransformScript, String> {
        let code = self.code;
        if code.trim().is_empty() {
            return Err("transform.script.code must not be empty".to_string());
        }
        if code.chars().count() > CHATANKI_TRANSFORM_SCRIPT_CODE_MAX_CHARS {
            return Err(format!(
                "transform.script.code exceeds {} characters",
                CHATANKI_TRANSFORM_SCRIPT_CODE_MAX_CHARS
            ));
        }
        let timeout_ms = self
            .timeout_ms
            .unwrap_or(CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_DEFAULT_MS);
        if !(CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MIN_MS..=CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MAX_MS)
            .contains(&timeout_ms)
        {
            return Err(format!(
                "transform.script.timeoutMs must be within {}..={} milliseconds",
                CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MIN_MS, CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MAX_MS
            ));
        }
        Ok(NormalizedTransformScript {
            language: self.language,
            code,
            timeout: Duration::from_millis(timeout_ms),
        })
    }
}

// ============================================================================
// 输入合同（$CHATANKI_INPUT）
// ============================================================================

/// 构造脚本输入 JSON。字段全文出自 DB 快照，**不经任何 2000 字符截断视图**；
/// `version` 为快照时 Rust 记录的乐观锁版本（= `updated_at`，与 get_cards 一致），
/// 仅供脚本参考——写回比对永远使用 Rust 侧的这份记录，脚本篡改无效。
pub(crate) fn build_script_input(document_id: &str, cards: &[crate::models::AnkiCard]) -> Value {
    let cards: Vec<Value> = cards
        .iter()
        .enumerate()
        .map(|(index, card)| {
            json!({
                "id": card.id,
                "index": index + 1,
                "front": card.front,
                "back": card.back,
                "text": card.text,
                "tags": card.tags,
                "templateId": card.template_id,
                "extraFields": card.extra_fields,
                "version": card.updated_at,
            })
        })
        .collect();
    json!({
        "documentId": document_id,
        "cards": cards,
    })
}

// ============================================================================
// 输出合同（$CHATANKI_OUTPUT）校验
// ============================================================================

/// 顶层输出不可用（整批失败，不写库）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ScriptOutputError {
    /// 输出文件超过大小上限。
    TooLarge { bytes: u64, limit: u64 },
    /// 不是合法 JSON。
    Parse(String),
    /// JSON 形状不符合合同（缺 cards / 非数组 / 条目缺 id / 重复 id 等）。
    Schema(String),
}

impl ScriptOutputError {
    pub(crate) fn detail(&self) -> String {
        match self {
            Self::TooLarge { bytes, limit } => format!(
                "CHATANKI_OUTPUT.json is {bytes} bytes, exceeding the {limit} byte limit"
            ),
            Self::Parse(detail) | Self::Schema(detail) => detail.clone(),
        }
    }
}

/// 单卡输出条目被拒绝的结构化原因（不整批失败，逐卡 invalid）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScriptCardIssue {
    pub(crate) code: &'static str,
    pub(crate) detail: String,
}

/// 输出评估结果：与选择集**等长且同序**的逐卡计划。
#[derive(Debug)]
pub(crate) struct ScriptTransformEvaluation {
    /// `Ok(after)`：变换后的字段快照（可能与 before 相同 = 未变更）；
    /// `Err(issue)`：该卡输出条目非法，apply 时逐卡拒绝。
    pub(crate) card_plans: Vec<Result<TransformFields, ScriptCardIssue>>,
    /// 输出中出现但不在快照内的 id（v1 禁止脚本增删卡，逐项报告）。
    pub(crate) unknown_card_ids: Vec<String>,
}

/// 输出条目允许的更新键。`version` / `index` / `templateId` / `extraFields`
/// 是输入合同键的回显（脚本整对象回写是常见模式），**静默忽略**；其余未知键
/// 按 fail-closed 逐卡拒绝。
const SCRIPT_OUTPUT_UPDATE_KEYS: &[&str] = &["front", "back", "text", "tags"];
const SCRIPT_OUTPUT_ECHO_KEYS: &[&str] = &["id", "version", "index", "templateId", "extraFields"];

/// 与 `database::contains_valid_anki_cloze_markup` 同语义的本地实现
/// （该函数为模块私有，此处按同一规则复刻并在单测中锁定语义）：
/// 存在至少一个 `{{cN::非空答案}}`（N ≥ 1，答案允许 `::hint` 后缀）。
pub(crate) fn text_has_valid_cloze_markup(text: &str) -> bool {
    let mut cursor = 0usize;
    while let Some(relative_start) = text[cursor..].find("{{c") {
        let start = cursor + relative_start + 3;
        let suffix = &text[start..];
        let digit_len = suffix
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if digit_len == 0 {
            cursor = start;
            continue;
        }
        let cloze_number = suffix[..digit_len].parse::<usize>().unwrap_or_default();
        let after_number = &suffix[digit_len..];
        if cloze_number == 0 || !after_number.starts_with("::") {
            cursor = start;
            continue;
        }
        let body = &after_number[2..];
        let Some(close) = body.find("}}") else {
            cursor = start;
            continue;
        };
        let answer = body[..close].split("::").next().unwrap_or_default();
        if !answer.trim().is_empty() {
            return true;
        }
        cursor = start + digit_len;
    }
    false
}

fn issue(code: &'static str, detail: impl Into<String>) -> ScriptCardIssue {
    ScriptCardIssue {
        code,
        detail: detail.into(),
    }
}

/// 从一条输出条目构造变换后的字段快照。
///
/// 规则（对齐任务合同）：
/// - `front` / `back` / `text`：`null` = 不修改；字符串必须 trim 后非空（**空字段拒绝**，
///   v1 不支持清空字段）；
/// - `text` 被修改为非空值时必须包含合法 `{{cN::answer}}` Cloze 标记；
/// - `tags`：`null` = 不修改；数组元素必须为 trim 后非空字符串，按序去重，
///   允许空数组（清空标签），上限 100；
/// - 回显键（`id`/`version`/`index`/`templateId`/`extraFields`）静默忽略——
///   其中 **`version` 一律忽略**，CAS 只认快照时 Rust 记录的 version；
/// - 其余未知键逐卡拒绝（fail-closed）。
fn evaluate_card_entry(
    entry: &serde_json::Map<String, Value>,
    before: &TransformFields,
) -> Result<TransformFields, ScriptCardIssue> {
    for key in entry.keys() {
        if !SCRIPT_OUTPUT_UPDATE_KEYS.contains(&key.as_str())
            && !SCRIPT_OUTPUT_ECHO_KEYS.contains(&key.as_str())
        {
            return Err(issue(
                "unknown_output_field",
                format!("output card contains unsupported field '{key}' (v1 allows front/back/text/tags updates only)"),
            ));
        }
    }

    let mut after = before.clone();

    for field in ["front", "back", "text"] {
        match entry.get(field) {
            None | Some(Value::Null) => {}
            Some(Value::String(value)) => {
                if value.trim().is_empty() {
                    return Err(issue(
                        "empty_field",
                        format!("output card sets '{field}' to an empty string (clearing fields is not allowed in v1)"),
                    ));
                }
                match field {
                    "front" => after.front = value.clone(),
                    "back" => after.back = value.clone(),
                    _ => after.text = Some(value.clone()),
                }
            }
            Some(other) => {
                return Err(issue(
                    "invalid_field_type",
                    format!(
                        "output card field '{field}' must be a string or null, got {}",
                        json_type_name(other)
                    ),
                ));
            }
        }
    }

    match entry.get("tags") {
        None | Some(Value::Null) => {}
        Some(Value::Array(raw_tags)) => {
            let mut seen = HashSet::new();
            let mut tags = Vec::with_capacity(raw_tags.len());
            for tag in raw_tags {
                let Value::String(tag) = tag else {
                    return Err(issue(
                        "invalid_field_type",
                        "output card tags must be an array of strings",
                    ));
                };
                let tag = tag.trim().to_string();
                if tag.is_empty() {
                    return Err(issue(
                        "empty_field",
                        "output card tags must not contain empty entries",
                    ));
                }
                if seen.insert(tag.clone()) {
                    tags.push(tag);
                }
            }
            if tags.len() > CHATANKI_TRANSFORM_SCRIPT_TAGS_LIMIT {
                return Err(issue(
                    "tags_limit_exceeded",
                    format!(
                        "output card carries {} unique tags, exceeding the {} limit",
                        tags.len(),
                        CHATANKI_TRANSFORM_SCRIPT_TAGS_LIMIT
                    ),
                ));
            }
            after.tags = tags;
        }
        Some(other) => {
            return Err(issue(
                "invalid_field_type",
                format!(
                    "output card field 'tags' must be an array or null, got {}",
                    json_type_name(other)
                ),
            ));
        }
    }

    // Cloze 语法校验：只在脚本实际改动 text 时执行（与 retemplate 的
    // invalid_cloze_text 同语义），未触碰的存量 text 不追溯。
    if after.text != before.text {
        if let Some(text) = after.text.as_deref() {
            if !text_has_valid_cloze_markup(text) {
                return Err(issue(
                    "invalid_cloze_text",
                    "output card sets 'text' without a valid {{cN::answer}} cloze marker",
                ));
            }
        }
    }

    Ok(after)
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// 校验脚本输出并生成逐卡计划。
///
/// 顶层合同：UTF-8 JSON 对象，必须含 `cards` 数组；数组条目必须是携带非空字符串
/// `id` 的对象；同一 `id` 不得重复出现。顶层多余键（如脚本自报统计）被忽略。
/// 输出中**未提及**的卡 = 不修改（`Ok(before)`）。
pub(crate) fn evaluate_script_output(
    raw: &[u8],
    selected: &[crate::models::AnkiCard],
) -> Result<ScriptTransformEvaluation, ScriptOutputError> {
    if raw.len() as u64 > CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES {
        return Err(ScriptOutputError::TooLarge {
            bytes: raw.len() as u64,
            limit: CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES,
        });
    }
    let parsed: Value = serde_json::from_slice(raw)
        .map_err(|error| ScriptOutputError::Parse(format!("output is not valid JSON: {error}")))?;
    let Some(object) = parsed.as_object() else {
        return Err(ScriptOutputError::Schema(
            "output root must be a JSON object with a 'cards' array".to_string(),
        ));
    };
    let Some(cards) = object.get("cards") else {
        return Err(ScriptOutputError::Schema(
            "output root is missing the required 'cards' array".to_string(),
        ));
    };
    let Some(cards) = cards.as_array() else {
        return Err(ScriptOutputError::Schema(
            "'cards' must be a JSON array".to_string(),
        ));
    };

    let mut entries: std::collections::HashMap<String, &serde_json::Map<String, Value>> =
        std::collections::HashMap::with_capacity(cards.len());
    let mut order: Vec<String> = Vec::with_capacity(cards.len());
    for (index, entry) in cards.iter().enumerate() {
        let Some(entry) = entry.as_object() else {
            return Err(ScriptOutputError::Schema(format!(
                "cards[{index}] must be a JSON object"
            )));
        };
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            return Err(ScriptOutputError::Schema(format!(
                "cards[{index}] is missing a string 'id'"
            )));
        };
        let id = id.trim();
        if id.is_empty() {
            return Err(ScriptOutputError::Schema(format!(
                "cards[{index}] has an empty 'id'"
            )));
        }
        if entries.insert(id.to_string(), entry).is_some() {
            return Err(ScriptOutputError::Schema(format!(
                "cards contains duplicate id '{id}'"
            )));
        }
        order.push(id.to_string());
    }

    let snapshot_ids: HashSet<&str> = selected.iter().map(|card| card.id.as_str()).collect();
    let unknown_card_ids: Vec<String> = order
        .iter()
        .filter(|id| !snapshot_ids.contains(id.as_str()))
        .cloned()
        .collect();

    let card_plans = selected
        .iter()
        .map(|card| {
            let before = TransformFields::from_card(card);
            match entries.get(card.id.as_str()) {
                None => Ok(before),
                Some(entry) => evaluate_card_entry(entry, &before),
            }
        })
        .collect();

    Ok(ScriptTransformEvaluation {
        card_plans,
        unknown_card_ids,
    })
}

// ============================================================================
// 解释器探测（对齐 skill_requires::probe_bin 的目录直查思路）
// ============================================================================

/// 探测目录集：PATH 中的绝对路径目录 + 平台固定安装目录 + $HOME 常见 bin。
/// 与 `skill_requires::probe_search_dirs` 同构（该函数为模块私有，无法复用）。
fn interpreter_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut push = |dir: PathBuf| {
        if dir.as_os_str().is_empty() || !dir.is_absolute() {
            return;
        }
        if seen.insert(dir.clone()) {
            dirs.push(dir);
        }
    };

    if let Some(path_value) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_value) {
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

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for relative in [".local/bin", ".cargo/bin", "bin"] {
            push(home.join(relative));
        }
    }

    dirs
}

/// 在目录集中按候选名顺序解析第一个可执行文件的绝对路径（纯函数，可单测）。
pub(crate) fn resolve_interpreter_in_dirs(
    candidates: &[&str],
    dirs: &[PathBuf],
) -> Option<PathBuf> {
    for candidate in candidates {
        for dir in dirs {
            let path = dir.join(candidate);
            if is_executable_file(&path) {
                return Some(path);
            }
            #[cfg(windows)]
            for extension in ["exe", "cmd", "bat"] {
                let with_ext = dir.join(format!("{candidate}.{extension}"));
                if with_ext.is_file() {
                    return Some(with_ext);
                }
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

pub(crate) fn resolve_interpreter(language: ScriptLanguage) -> Option<PathBuf> {
    resolve_interpreter_in_dirs(language.candidate_bins(), &interpreter_search_dirs())
}

// ============================================================================
// 沙箱策略与命令行
// ============================================================================

/// macOS Seatbelt 的默认可读集不含 `/opt`（Homebrew Cellar），bwrap 则整根只读
/// bind 无此问题。对 `/opt/<x>/...` 下的解释器额外放行其顶层前缀目录，其余场景
/// 只补解释器所在目录（对 bwrap 恒为冗余但无害）。
pub(crate) fn extra_readable_roots_for_interpreter(interpreter: &Path) -> Vec<PathBuf> {
    let canonical = interpreter
        .canonicalize()
        .unwrap_or_else(|_| interpreter.to_path_buf());
    let mut roots = Vec::new();
    if let Some(parent) = canonical.parent() {
        roots.push(parent.to_path_buf());
    }
    let mut components = canonical.components();
    if let (Some(std::path::Component::RootDir), Some(std::path::Component::Normal(first))) =
        (components.next(), components.next())
    {
        if first == std::ffi::OsStr::new("opt") {
            if let Some(std::path::Component::Normal(second)) = components.next() {
                roots.push(PathBuf::from("/opt").join(second));
            }
        }
    }
    roots
}

/// 沙箱策略：只有 job 目录可写；网络**恒禁**（无豁免参数）。
pub(crate) fn transform_sandbox_policy(job_dir: &Path, interpreter: &Path) -> SandboxPolicy {
    let mut readable_roots = vec![job_dir.to_path_buf()];
    readable_roots.extend(extra_readable_roots_for_interpreter(interpreter));
    SandboxPolicy {
        readable_roots,
        writable_roots: vec![job_dir.to_path_buf()],
        protected_read_roots: Vec::new(),
        protected_write_roots: Vec::new(),
        allow_network: false,
    }
}

fn shell_quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn shell_quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// 构造沙箱内执行的解释器命令行。python 追加 `-I`（isolated mode：忽略
/// PYTHONPATH / 用户 site-packages，双保险叠加环境变量白名单）。
pub(crate) fn build_shell_command(
    shell_kind: &str,
    language: ScriptLanguage,
    interpreter: &Path,
    script_path: &Path,
) -> Result<String, String> {
    let interpreter = interpreter.to_string_lossy();
    let script_path = script_path.to_string_lossy();
    let interpreter_args = match language {
        ScriptLanguage::Python => " -I",
        ScriptLanguage::Node => "",
    };
    match shell_kind {
        "posix_sh" => Ok(format!(
            "{}{} {}",
            shell_quote_posix(&interpreter),
            interpreter_args,
            shell_quote_posix(&script_path)
        )),
        "windows_powershell" => Ok(format!(
            "& {}{} {}",
            shell_quote_powershell(&interpreter),
            interpreter_args,
            shell_quote_powershell(&script_path)
        )),
        other => Err(format!(
            "Unsupported sandbox shell kind for transform scripts: {other}"
        )),
    }
}

// ============================================================================
// job 目录准备
// ============================================================================

#[derive(Debug)]
pub(crate) struct PreparedTransformJob {
    pub(crate) job_dir: PathBuf,
    pub(crate) input_path: PathBuf,
    pub(crate) output_path: PathBuf,
    pub(crate) script_path: PathBuf,
    /// 相对 temp root 的展示引用（`runtime-root://temp/...`）。
    pub(crate) job_ref: String,
}

/// 在会话 temp root 下创建一次性 job 目录并写入输入快照与脚本正文。
/// job 目录随 temp root 生命周期保留（审计用途），不在本次调用内删除。
pub(crate) fn prepare_transform_job(
    temp_root: &Path,
    script: &NormalizedTransformScript,
    input: &Value,
) -> Result<PreparedTransformJob, String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let seq = JOB_SEQ.fetch_add(1, Ordering::Relaxed);
    let relative = format!("chatanki_transform/job-{millis}-{seq:04}");
    let job_dir = temp_root.join(&relative);
    std::fs::create_dir_all(&job_dir)
        .map_err(|error| format!("Failed to create transform job directory: {error}"))?;

    let input_path = job_dir.join(CHATANKI_INPUT_FILE);
    let output_path = job_dir.join(CHATANKI_OUTPUT_FILE);
    let script_path = job_dir.join(script.language.script_file_name());

    let input_bytes = serde_json::to_vec(input)
        .map_err(|error| format!("Failed to serialize transform input snapshot: {error}"))?;
    std::fs::write(&input_path, input_bytes)
        .map_err(|error| format!("Failed to write {CHATANKI_INPUT_FILE}: {error}"))?;
    std::fs::write(&script_path, script.code.as_bytes())
        .map_err(|error| format!("Failed to write transform script file: {error}"))?;

    Ok(PreparedTransformJob {
        job_dir,
        input_path,
        output_path,
        script_path,
        job_ref: format!("runtime-root://temp/{relative}"),
    })
}

// ============================================================================
// 沙箱执行
// ============================================================================

/// 一次脚本执行的观测报告（成功与否都会尽力填充，进入工具返回值与审计）。
#[derive(Debug, Clone)]
pub(crate) struct ScriptExecutionReport {
    pub(crate) language: &'static str,
    pub(crate) exit_code: Option<i32>,
    pub(crate) timed_out: bool,
    pub(crate) duration_ms: u64,
    pub(crate) stdout_tail: String,
    pub(crate) stderr_tail: String,
    pub(crate) sandbox_backend: &'static str,
    pub(crate) interpreter: String,
}

impl ScriptExecutionReport {
    pub(crate) fn to_json(&self, timeout: Duration) -> Value {
        json!({
            "language": self.language,
            "exitCode": self.exit_code,
            "timedOut": self.timed_out,
            "timeoutMs": timeout.as_millis() as u64,
            "durationMs": self.duration_ms,
            "stdoutTail": self.stdout_tail,
            "stderrTail": self.stderr_tail,
            "sandbox": self.sandbox_backend,
            "interpreter": self.interpreter,
        })
    }
}

/// 脚本执行失败的结构化分类（全部映射为工具的结构化返回，不 panic）。
#[derive(Debug)]
pub(crate) enum ScriptRunError {
    /// 平台无硬沙箱（移动端 / Linux 缺 bwrap / macOS 缺 sandbox-exec）。
    SandboxUnavailable(String),
    /// 本机没有可用解释器。
    InterpreterUnavailable {
        language: &'static str,
        detail: String,
    },
    /// job 目录 / 命令构造 / spawn 等基础设施失败。
    Setup(String),
    /// 超时：进程组已终止，未写库。
    TimedOut(ScriptExecutionReport),
    /// 脚本非零退出（或被信号杀死，exit_code=None）。
    NonZeroExit(ScriptExecutionReport),
    /// 脚本 0 退出但未写 CHATANKI_OUTPUT.json。
    OutputMissing(ScriptExecutionReport),
    /// 输出文件超过大小上限（未读入内存）。
    OutputTooLarge {
        report: ScriptExecutionReport,
        bytes: u64,
        limit: u64,
    },
}

/// 有界尾部捕获：保留流的最后 `cap` 字节（数据面走文件，stdout/stderr 只承载日志）。
async fn drain_stream_tail<R>(mut reader: R, cap: usize) -> Vec<u8>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut tail: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                tail.extend_from_slice(&chunk[..read]);
                if tail.len() > cap {
                    let excess = tail.len() - cap;
                    tail.drain(..excess);
                }
            }
        }
    }
    tail
}

fn tail_to_string(tail: Vec<u8>) -> String {
    String::from_utf8_lossy(&tail).into_owned()
}

/// 环境变量白名单：不继承父进程任何变量；只注入合同变量、job 目录 temp 指向、
/// 净化后的 PATH 与 UTF-8 强制。与 local_shell 的敏感变量硬拒绝语义等价
/// （从零构建白名单，而不是过滤黑名单）。
fn apply_script_env(
    command: &mut tokio::process::Command,
    job: &PreparedTransformJob,
    interpreter: &Path,
) {
    command.env_clear();
    let mut path_dirs: Vec<PathBuf> = Vec::new();
    if let Some(parent) = interpreter.parent() {
        path_dirs.push(parent.to_path_buf());
    }
    path_dirs.extend(interpreter_search_dirs());
    let mut seen = HashSet::new();
    path_dirs.retain(|dir| seen.insert(dir.clone()));
    if let Ok(joined) = std::env::join_paths(&path_dirs) {
        command.env("PATH", joined);
    }
    command
        .env("CHATANKI_INPUT", &job.input_path)
        .env("CHATANKI_OUTPUT", &job.output_path)
        .env("HOME", &job.job_dir)
        .env("TMPDIR", &job.job_dir)
        .env("TEMP", &job.job_dir)
        .env("TMP", &job.job_dir)
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("PYTHONUTF8", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("NO_COLOR", "1");
}

/// 在平台沙箱内运行变换脚本并读回输出文件字节。
///
/// 全链条：capability 探测 → 解释器解析 → job 目录（输入快照 + 脚本正文）→
/// `PlatformSandboxBackend`（网络恒禁 + 仅 job 目录可写）→ 超时看门狗
/// （超时终止整个进程组）→ 输出文件大小闸门 → 返回原始字节交由
/// `evaluate_script_output` 校验。任何失败均为结构化 `ScriptRunError`。
pub(crate) async fn run_transform_script(
    temp_root: &Path,
    document_id: &str,
    cards: &[crate::models::AnkiCard],
    script: &NormalizedTransformScript,
) -> Result<(ScriptExecutionReport, Vec<u8>, String), ScriptRunError> {
    let backend = PlatformSandboxBackend::new();
    if let SandboxCapability::Unavailable { reason } = backend.capability() {
        return Err(ScriptRunError::SandboxUnavailable(reason));
    }
    let contract = platform_sandbox_contract();

    let Some(interpreter) = resolve_interpreter(script.language) else {
        return Err(ScriptRunError::InterpreterUnavailable {
            language: script.language.as_str(),
            detail: format!(
                "no {} interpreter found on this machine (searched PATH and standard install locations)",
                script.language.candidate_bins().join("/")
            ),
        });
    };

    let input = build_script_input(document_id, cards);
    let job = prepare_transform_job(temp_root, script, &input).map_err(ScriptRunError::Setup)?;
    let shell_command = build_shell_command(
        contract.shell_kind,
        script.language,
        &interpreter,
        &job.script_path,
    )
    .map_err(ScriptRunError::Setup)?;
    let policy = transform_sandbox_policy(&job.job_dir, &interpreter);

    let mut command = backend
        .command(&shell_command, &job.job_dir, &policy)
        .map_err(ScriptRunError::SandboxUnavailable)?;
    apply_script_env(&mut command, &job, &interpreter);

    let started = std::time::Instant::now();
    let spawn_result = command.spawn();
    let mut child = match spawn_result {
        Ok(child) => child,
        Err(error) => {
            backend.cleanup_command_resources(&command);
            return Err(ScriptRunError::Setup(format!(
                "Failed to spawn sandboxed transform script: {error}"
            )));
        }
    };

    let stdout_task = child
        .stdout
        .take()
        .map(|stream| tokio::spawn(drain_stream_tail(stream, SCRIPT_STREAM_TAIL_BYTES)));
    let stderr_task = child
        .stderr
        .take()
        .map(|stream| tokio::spawn(drain_stream_tail(stream, SCRIPT_STREAM_TAIL_BYTES)));

    let wait_result = tokio::time::timeout(script.timeout, child.wait()).await;
    let timed_out = wait_result.is_err();
    let exit_status = match wait_result {
        Ok(Ok(status)) => Some(status),
        Ok(Err(error)) => {
            backend.cleanup_command_resources(&command);
            return Err(ScriptRunError::Setup(format!(
                "Failed to wait for sandboxed transform script: {error}"
            )));
        }
        Err(_elapsed) => {
            // 超时：终止整个进程组（含脚本 fork 的后代），限期收尸。
            if let Err(error) = terminate_process_group(&mut child) {
                log::warn!("[chatanki_transform] failed to terminate timed-out script group: {error}");
            }
            let _ = tokio::time::timeout(SCRIPT_CLEANUP_GRACE, child.wait()).await;
            None
        }
    };
    backend.cleanup_command_resources(&command);

    // 进程（组）已退出/被杀，管道随之关闭；限期回收日志尾部。
    let collect_tail = |task: Option<tokio::task::JoinHandle<Vec<u8>>>| async {
        match task {
            None => String::new(),
            Some(mut task) => {
                match tokio::time::timeout(SCRIPT_CLEANUP_GRACE, &mut task).await {
                    Ok(Ok(tail)) => tail_to_string(tail),
                    Ok(Err(_)) => String::new(),
                    Err(_) => {
                        task.abort();
                        String::new()
                    }
                }
            }
        }
    };
    let stdout_tail = collect_tail(stdout_task).await;
    let stderr_tail = collect_tail(stderr_task).await;

    let report = ScriptExecutionReport {
        language: script.language.as_str(),
        exit_code: exit_status.and_then(|status| status.code()),
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
        stdout_tail,
        stderr_tail,
        sandbox_backend: contract.backend,
        interpreter: interpreter.to_string_lossy().into_owned(),
    };

    if timed_out {
        return Err(ScriptRunError::TimedOut(report));
    }
    if !exit_status.is_some_and(|status| status.success()) {
        return Err(ScriptRunError::NonZeroExit(report));
    }

    let metadata = match std::fs::symlink_metadata(&job.output_path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
        Ok(_) => {
            return Err(ScriptRunError::Setup(format!(
                "{CHATANKI_OUTPUT_FILE} must be a regular file"
            )));
        }
        Err(_) => return Err(ScriptRunError::OutputMissing(report)),
    };
    if metadata.len() > CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES {
        return Err(ScriptRunError::OutputTooLarge {
            report,
            bytes: metadata.len(),
            limit: CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES,
        });
    }
    let output_bytes = std::fs::read(&job.output_path).map_err(|error| {
        ScriptRunError::Setup(format!("Failed to read {CHATANKI_OUTPUT_FILE}: {error}"))
    })?;

    Ok((report, output_bytes, job.job_ref))
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(value: Value) -> Result<NormalizedTransformScript, String> {
        serde_json::from_value::<TransformScriptSpec>(value)
            .map_err(|error| error.to_string())
            .and_then(TransformScriptSpec::normalize)
    }

    fn make_card(id: &str, front: &str, back: &str, text: Option<&str>, tags: &[&str]) -> crate::models::AnkiCard {
        crate::models::AnkiCard {
            front: front.to_string(),
            back: back.to_string(),
            text: text.map(str::to_string),
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            images: vec![],
            id: id.to_string(),
            task_id: "task-1".to_string(),
            is_error_card: false,
            error_content: None,
            created_at: "2026-08-24T00:00:00Z".to_string(),
            updated_at: "2026-08-24T01:00:00Z".to_string(),
            extra_fields: Default::default(),
            template_id: Some("design-swiss".to_string()),
        }
    }

    // ------------------------------------------------------------------
    // 参数归一化
    // ------------------------------------------------------------------

    #[test]
    fn normalize_accepts_python_and_node_with_default_timeout() {
        let script = spec(json!({ "language": "python", "code": "print(1)" })).unwrap();
        assert_eq!(script.language, ScriptLanguage::Python);
        assert_eq!(
            script.timeout,
            Duration::from_millis(CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_DEFAULT_MS)
        );

        let script = spec(json!({ "language": "node", "code": "1", "timeoutMs": 120000 })).unwrap();
        assert_eq!(script.language, ScriptLanguage::Node);
        assert_eq!(script.timeout, Duration::from_millis(120_000));
    }

    #[test]
    fn normalize_rejects_empty_or_oversized_code_and_unknown_language() {
        let error = spec(json!({ "language": "python", "code": "   " })).unwrap_err();
        assert!(error.contains("must not be empty"), "{error}");

        let oversized = "x".repeat(CHATANKI_TRANSFORM_SCRIPT_CODE_MAX_CHARS + 1);
        let error = spec(json!({ "language": "python", "code": oversized })).unwrap_err();
        assert!(error.contains("exceeds 65536"), "{error}");

        let error = spec(json!({ "language": "ruby", "code": "puts 1" })).unwrap_err();
        assert!(error.contains("unknown variant"), "{error}");
    }

    #[test]
    fn normalize_rejects_out_of_range_timeout() {
        let error =
            spec(json!({ "language": "python", "code": "1", "timeoutMs": 999 })).unwrap_err();
        assert!(error.contains("1000..=120000"), "{error}");
        let error =
            spec(json!({ "language": "python", "code": "1", "timeoutMs": 120001 })).unwrap_err();
        assert!(error.contains("1000..=120000"), "{error}");
    }

    #[test]
    fn normalize_rejects_unknown_script_keys() {
        let result = serde_json::from_value::<TransformScriptSpec>(json!({
            "language": "python",
            "code": "1",
            "allowNetwork": true,
        }));
        let error = result.unwrap_err().to_string();
        assert!(error.contains("unknown field"), "{error}");
    }

    // ------------------------------------------------------------------
    // 输入合同
    // ------------------------------------------------------------------

    #[test]
    fn input_snapshot_carries_full_text_index_and_rust_recorded_version() {
        let long_front = "长".repeat(5000);
        let card = make_card("card-1", &long_front, "A", Some("{{c1::x}}"), &["生物"]);
        let input = build_script_input("doc-1", &[card]);
        assert_eq!(input["documentId"], "doc-1");
        let entry = &input["cards"][0];
        assert_eq!(entry["id"], "card-1");
        assert_eq!(entry["index"], 1);
        // 无截断：5000 字符全文原样导出
        assert_eq!(entry["front"].as_str().unwrap().chars().count(), 5000);
        assert_eq!(entry["version"], "2026-08-24T01:00:00Z");
        assert_eq!(entry["templateId"], "design-swiss");
    }

    // ------------------------------------------------------------------
    // 输出校验：顶层合同
    // ------------------------------------------------------------------

    #[test]
    fn output_rejects_non_json_and_missing_cards() {
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        let error = evaluate_script_output(b"not json", &cards).unwrap_err();
        assert!(matches!(error, ScriptOutputError::Parse(_)), "{error:?}");

        let error = evaluate_script_output(b"[]", &cards).unwrap_err();
        assert!(matches!(error, ScriptOutputError::Schema(_)), "{error:?}");

        let error = evaluate_script_output(br#"{"stats": 1}"#, &cards).unwrap_err();
        assert!(error.detail().contains("missing the required 'cards'"));

        let error = evaluate_script_output(br#"{"cards": {}}"#, &cards).unwrap_err();
        assert!(error.detail().contains("must be a JSON array"));
    }

    #[test]
    fn output_rejects_duplicate_and_missing_ids_at_schema_level() {
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        let raw = serde_json::to_vec(&json!({
            "cards": [{ "id": "card-1" }, { "id": "card-1" }],
        }))
        .unwrap();
        let error = evaluate_script_output(&raw, &cards).unwrap_err();
        assert!(error.detail().contains("duplicate id"), "{error:?}");

        let raw = serde_json::to_vec(&json!({ "cards": [{ "front": "x" }] })).unwrap();
        let error = evaluate_script_output(&raw, &cards).unwrap_err();
        assert!(error.detail().contains("missing a string 'id'"));
    }

    #[test]
    fn output_rejects_oversized_payloads() {
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        let oversized = vec![b' '; CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES as usize + 1];
        let error = evaluate_script_output(&oversized, &cards).unwrap_err();
        assert!(matches!(error, ScriptOutputError::TooLarge { .. }));
    }

    // ------------------------------------------------------------------
    // 输出校验：逐卡合同
    // ------------------------------------------------------------------

    #[test]
    fn unmentioned_cards_stay_unchanged_and_full_echo_is_tolerated() {
        let cards = [
            make_card("card-1", "Q1", "A1", None, &["旧"]),
            make_card("card-2", "Q2", "A2", None, &[]),
        ];
        // card-1 整对象回显（含 version/index/templateId/extraFields），card-2 未提及。
        let raw = serde_json::to_vec(&json!({
            "cards": [{
                "id": "card-1",
                "index": 1,
                "front": "Q1",
                "back": "A1",
                "text": null,
                "tags": ["旧"],
                "templateId": "design-swiss",
                "extraFields": {},
                "version": "被脚本篡改的版本，必须忽略",
            }],
        }))
        .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert!(evaluation.unknown_card_ids.is_empty());
        let plan_1 = evaluation.card_plans[0].as_ref().unwrap();
        assert_eq!(plan_1, &TransformFields::from_card(&cards[0]));
        let plan_2 = evaluation.card_plans[1].as_ref().unwrap();
        assert_eq!(plan_2, &TransformFields::from_card(&cards[1]));
    }

    #[test]
    fn output_applies_field_updates_and_ignores_script_version() {
        let cards = [make_card("card-1", "Q", "A", None, &["草稿"])];
        let raw = serde_json::to_vec(&json!({
            "cards": [{
                "id": "card-1",
                "front": "新问题",
                "tags": ["生物", "生物", " 重点 "],
                "version": "1999-01-01T00:00:00Z",
            }],
        }))
        .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        let after = evaluation.card_plans[0].as_ref().unwrap();
        assert_eq!(after.front, "新问题");
        assert_eq!(after.back, "A"); // 未提及字段不变
        assert_eq!(after.tags, vec!["生物".to_string(), "重点".to_string()]); // 去重 + trim
    }

    #[test]
    fn output_rejects_unknown_fields_per_card_not_batch() {
        let cards = [
            make_card("card-1", "Q1", "A1", None, &[]),
            make_card("card-2", "Q2", "A2", None, &[]),
        ];
        let raw = serde_json::to_vec(&json!({
            "cards": [
                { "id": "card-1", "isErrorCard": false },
                { "id": "card-2", "front": "更新" },
            ],
        }))
        .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        let issue = evaluation.card_plans[0].as_ref().unwrap_err();
        assert_eq!(issue.code, "unknown_output_field");
        assert!(issue.detail.contains("isErrorCard"));
        // 另一张卡照常生效（不整批失败）
        assert_eq!(evaluation.card_plans[1].as_ref().unwrap().front, "更新");
    }

    #[test]
    fn output_rejects_empty_fields_and_wrong_types() {
        let cards = [make_card("card-1", "Q", "A", None, &[])];

        let raw = serde_json::to_vec(&json!({ "cards": [{ "id": "card-1", "front": "  " }] }))
            .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert_eq!(evaluation.card_plans[0].as_ref().unwrap_err().code, "empty_field");

        let raw = serde_json::to_vec(&json!({ "cards": [{ "id": "card-1", "back": 42 }] }))
            .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert_eq!(
            evaluation.card_plans[0].as_ref().unwrap_err().code,
            "invalid_field_type"
        );

        let raw = serde_json::to_vec(&json!({ "cards": [{ "id": "card-1", "tags": ["ok", ""] }] }))
            .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert_eq!(evaluation.card_plans[0].as_ref().unwrap_err().code, "empty_field");
    }

    #[test]
    fn output_enforces_cloze_syntax_only_when_text_changes() {
        let cards = [
            make_card("card-1", "Q", "A", Some("{{c1::旧}}"), &[]),
            make_card("card-2", "Q", "A", Some("{{c1::旧}}"), &[]),
        ];
        let raw = serde_json::to_vec(&json!({
            "cards": [
                { "id": "card-1", "text": "术语无标记" },
                { "id": "card-2", "text": "新 {{c2::答案::提示}} 挖空" },
            ],
        }))
        .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert_eq!(
            evaluation.card_plans[0].as_ref().unwrap_err().code,
            "invalid_cloze_text"
        );
        assert_eq!(
            evaluation.card_plans[1].as_ref().unwrap().text.as_deref(),
            Some("新 {{c2::答案::提示}} 挖空")
        );
    }

    #[test]
    fn cloze_markup_validator_matches_database_semantics() {
        assert!(text_has_valid_cloze_markup("A {{c1::answer}} B"));
        assert!(text_has_valid_cloze_markup("{{c12::多位编号::hint}}"));
        assert!(!text_has_valid_cloze_markup("{{c0::zero}}"));
        assert!(!text_has_valid_cloze_markup("{{c1::}}"));
        assert!(!text_has_valid_cloze_markup("{{color}} 假标记"));
        assert!(!text_has_valid_cloze_markup("plain text"));
    }

    #[test]
    fn output_reports_unknown_snapshot_ids_v1_forbids_card_creation() {
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        let raw = serde_json::to_vec(&json!({
            "cards": [
                { "id": "card-1", "front": "更新" },
                { "id": "card-ghost", "front": "脚本试图新增" },
            ],
        }))
        .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert_eq!(evaluation.unknown_card_ids, vec!["card-ghost".to_string()]);
        assert_eq!(evaluation.card_plans.len(), 1);
        assert!(evaluation.card_plans[0].is_ok());
    }

    #[test]
    fn output_enforces_script_tags_limit() {
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        let tags: Vec<String> = (0..(CHATANKI_TRANSFORM_SCRIPT_TAGS_LIMIT + 1))
            .map(|index| format!("tag-{index}"))
            .collect();
        let raw = serde_json::to_vec(&json!({ "cards": [{ "id": "card-1", "tags": tags }] }))
            .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert_eq!(
            evaluation.card_plans[0].as_ref().unwrap_err().code,
            "tags_limit_exceeded"
        );
    }

    // ------------------------------------------------------------------
    // 解释器解析 / 命令行 / 沙箱策略
    // ------------------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn interpreter_resolution_prefers_candidate_order_and_requires_exec_bit() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let python = temp.path().join("python");
        std::fs::write(&python, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();

        // python3 缺失时回退 python
        let resolved =
            resolve_interpreter_in_dirs(&["python3", "python"], &[temp.path().to_path_buf()])
                .unwrap();
        assert_eq!(resolved, python);

        // 无执行位 → 视为不可用
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(resolve_interpreter_in_dirs(
            &["python3", "python"],
            &[temp.path().to_path_buf()]
        )
        .is_none());
    }

    #[test]
    fn shell_command_quotes_paths_for_posix_and_powershell() {
        let interpreter = Path::new("/opt/home brew/bin/python3");
        let script = Path::new("/tmp/job dir/transform_script.py");
        let posix =
            build_shell_command("posix_sh", ScriptLanguage::Python, interpreter, script).unwrap();
        assert_eq!(
            posix,
            "'/opt/home brew/bin/python3' -I '/tmp/job dir/transform_script.py'"
        );
        let node = build_shell_command(
            "posix_sh",
            ScriptLanguage::Node,
            Path::new("/usr/bin/node"),
            Path::new("/tmp/job/transform_script.js"),
        )
        .unwrap();
        assert_eq!(node, "'/usr/bin/node' '/tmp/job/transform_script.js'");
        let powershell =
            build_shell_command("windows_powershell", ScriptLanguage::Python, interpreter, script)
                .unwrap();
        assert!(powershell.starts_with("& '"));
        assert!(build_shell_command("unavailable", ScriptLanguage::Python, interpreter, script)
            .is_err());
    }

    #[test]
    fn sandbox_policy_grants_job_dir_only_and_never_allows_network() {
        let temp = tempfile::tempdir().unwrap();
        let job_dir = temp.path().join("job");
        std::fs::create_dir_all(&job_dir).unwrap();
        let policy = transform_sandbox_policy(&job_dir, Path::new("/usr/bin/python3"));
        assert!(!policy.allow_network);
        assert_eq!(policy.writable_roots, vec![job_dir.clone()]);
        assert!(policy.readable_roots.contains(&job_dir));
        assert!(policy.protected_read_roots.is_empty());
        assert!(policy.protected_write_roots.is_empty());
    }

    #[test]
    fn interpreter_under_opt_gains_top_level_readable_root() {
        let roots =
            extra_readable_roots_for_interpreter(Path::new("/opt/homebrew/bin/python3.12"));
        assert!(roots.contains(&PathBuf::from("/opt/homebrew")));
    }

    #[test]
    fn prepare_job_writes_input_snapshot_and_script_body() {
        let temp = tempfile::tempdir().unwrap();
        let script = NormalizedTransformScript {
            language: ScriptLanguage::Python,
            code: "print('ok')".to_string(),
            timeout: Duration::from_secs(5),
        };
        let input = json!({ "documentId": "doc-1", "cards": [] });
        let job = prepare_transform_job(temp.path(), &script, &input).unwrap();
        assert!(job.job_dir.starts_with(temp.path()));
        assert!(job.job_ref.starts_with("runtime-root://temp/chatanki_transform/job-"));
        let written: Value =
            serde_json::from_slice(&std::fs::read(&job.input_path).unwrap()).unwrap();
        assert_eq!(written, input);
        assert_eq!(
            std::fs::read_to_string(&job.script_path).unwrap(),
            "print('ok')"
        );
        assert!(!job.output_path.exists());
    }

    // ------------------------------------------------------------------
    // 端到端（真实沙箱）：环境无硬沙箱/解释器时跳过，不失败
    // ------------------------------------------------------------------

    fn sandbox_e2e_ready(language: ScriptLanguage) -> bool {
        if !matches!(
            PlatformSandboxBackend::new().capability(),
            SandboxCapability::Available
        ) {
            eprintln!("skipping sandbox e2e: platform sandbox unavailable");
            return false;
        }
        if resolve_interpreter(language).is_none() {
            eprintln!(
                "skipping sandbox e2e: {} interpreter unavailable",
                language.as_str()
            );
            return false;
        }
        true
    }

    #[tokio::test]
    async fn e2e_python_script_reads_input_and_writes_output_in_sandbox() {
        if !sandbox_e2e_ready(ScriptLanguage::Python) {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let cards = [make_card("card-1", "术语 解释", "答案", None, &[])];
        let script = NormalizedTransformScript {
            language: ScriptLanguage::Python,
            code: r#"
import json, os
with open(os.environ["CHATANKI_INPUT"], encoding="utf-8") as fh:
    data = json.load(fh)
out = []
for card in data["cards"]:
    out.append({"id": card["id"], "front": card["front"].replace("术语", "TERM")})
with open(os.environ["CHATANKI_OUTPUT"], "w", encoding="utf-8") as fh:
    json.dump({"cards": out}, fh, ensure_ascii=False)
print("transformed", len(out))
"#
            .to_string(),
            timeout: Duration::from_secs(30),
        };
        let (report, output, job_ref) =
            run_transform_script(temp.path(), "doc-1", &cards, &script)
                .await
                .expect("sandboxed python run should succeed");
        assert_eq!(report.exit_code, Some(0));
        assert!(!report.timed_out);
        assert!(report.stdout_tail.contains("transformed 1"));
        assert!(job_ref.starts_with("runtime-root://temp/"));
        let evaluation = evaluate_script_output(&output, &cards).unwrap();
        assert_eq!(
            evaluation.card_plans[0].as_ref().unwrap().front,
            "TERM 解释"
        );
    }

    #[tokio::test]
    async fn e2e_network_is_always_denied_inside_the_sandbox() {
        if !sandbox_e2e_ready(ScriptLanguage::Python) {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        // 脚本尝试建 TCP 连接；沙箱断网下必须失败，脚本据此报告 denied。
        let script = NormalizedTransformScript {
            language: ScriptLanguage::Python,
            code: r#"
import json, os, socket
denied = False
try:
    socket.create_connection(("127.0.0.1", 9), timeout=1)
except OSError:
    denied = True
with open(os.environ["CHATANKI_OUTPUT"], "w", encoding="utf-8") as fh:
    json.dump({"cards": [{"id": "card-1", "front": "denied" if denied else "reachable"}]}, fh)
"#
            .to_string(),
            timeout: Duration::from_secs(30),
        };
        let (_report, output, _job_ref) =
            run_transform_script(temp.path(), "doc-1", &cards, &script)
                .await
                .expect("script itself should exit 0");
        let evaluation = evaluate_script_output(&output, &cards).unwrap();
        assert_eq!(evaluation.card_plans[0].as_ref().unwrap().front, "denied");
    }

    #[tokio::test]
    async fn e2e_timeout_terminates_the_process_group_structurally() {
        if !sandbox_e2e_ready(ScriptLanguage::Python) {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        let script = NormalizedTransformScript {
            language: ScriptLanguage::Python,
            code: "import time\ntime.sleep(600)".to_string(),
            timeout: Duration::from_millis(1_000),
        };
        let error = run_transform_script(temp.path(), "doc-1", &cards, &script)
            .await
            .unwrap_err();
        match error {
            ScriptRunError::TimedOut(report) => {
                assert!(report.timed_out);
                assert!(report.duration_ms >= 1_000);
            }
            other => panic!("expected TimedOut, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn e2e_nonzero_exit_and_missing_output_are_structured_failures() {
        if !sandbox_e2e_ready(ScriptLanguage::Python) {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let cards = [make_card("card-1", "Q", "A", None, &[])];

        let failing = NormalizedTransformScript {
            language: ScriptLanguage::Python,
            code: "import sys\nsys.stderr.write('boom')\nsys.exit(3)".to_string(),
            timeout: Duration::from_secs(30),
        };
        let error = run_transform_script(temp.path(), "doc-1", &cards, &failing)
            .await
            .unwrap_err();
        match error {
            ScriptRunError::NonZeroExit(report) => {
                assert_eq!(report.exit_code, Some(3));
                assert!(report.stderr_tail.contains("boom"));
            }
            other => panic!("expected NonZeroExit, got {other:?}"),
        }

        let silent = NormalizedTransformScript {
            language: ScriptLanguage::Python,
            code: "print('forgot to write output')".to_string(),
            timeout: Duration::from_secs(30),
        };
        let error = run_transform_script(temp.path(), "doc-1", &cards, &silent)
            .await
            .unwrap_err();
        assert!(matches!(error, ScriptRunError::OutputMissing(_)));
    }

    #[tokio::test]
    async fn e2e_node_script_honours_the_same_contract() {
        if !sandbox_e2e_ready(ScriptLanguage::Node) {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let cards = [make_card("card-1", "Q", "A", None, &["旧"])];
        let script = NormalizedTransformScript {
            language: ScriptLanguage::Node,
            code: r#"
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.env.CHATANKI_INPUT, 'utf-8'));
const cards = data.cards.map((card) => ({ id: card.id, tags: [...card.tags, '新标签'] }));
fs.writeFileSync(process.env.CHATANKI_OUTPUT, JSON.stringify({ cards }));
"#
            .to_string(),
            timeout: Duration::from_secs(30),
        };
        let (report, output, _job_ref) =
            run_transform_script(temp.path(), "doc-1", &cards, &script)
                .await
                .expect("sandboxed node run should succeed");
        assert_eq!(report.exit_code, Some(0));
        let evaluation = evaluate_script_output(&output, &cards).unwrap();
        assert_eq!(
            evaluation.card_plans[0].as_ref().unwrap().tags,
            vec!["旧".to_string(), "新标签".to_string()]
        );
    }
}
