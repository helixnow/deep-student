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
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::chatanki_transform::TransformFields;
use super::shell_sandbox::{
    cleanup_finished_process_group, platform_sandbox_contract, terminate_process_group,
    PlatformSandboxBackend, SandboxBackend, SandboxCapability, SandboxEffectReport, SandboxPolicy,
};

// ============================================================================
// 资源边界（对齐调研报告 §6）
// ============================================================================

/// 脚本正文长度上限（JSON Schema maxLength 同值，按 Unicode 标量计）。
pub const CHATANKI_TRANSFORM_SCRIPT_CODE_MAX_CHARS: usize = 65_536;
/// 脚本超时下限（毫秒）。
pub const CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MIN_MS: u64 = 1_000;
/// 脚本超时上限（毫秒），与 local_shell 的 120s 对齐。
pub const CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MAX_MS: u64 = 120_000;
/// 脚本默认超时（毫秒）。
pub const CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_DEFAULT_MS: u64 = 30_000;
/// `CHATANKI_OUTPUT.json` 文件大小上限。
pub const CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// stdout / stderr 各自最多从管道消费的字节数。达到上限后关闭对应管道，
/// 避免失控日志在整个 timeout 窗口内持续占用宿主 CPU / I/O。
pub const CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES: u64 = 1024 * 1024;
/// stdout / stderr 各自进入工具返回值的日志尾部字节数。
pub const CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES: usize = 16 * 1024;
/// transform script 接受的平台后端进程数上限。当前 Unix RLIMIT_NPROC 为
/// 2048，Windows Job Object 更严格（128）；未来后端若放宽超过此值则
/// transform script fail-closed，而不是静默失去进程洪泛边界。
pub const CHATANKI_TRANSFORM_SCRIPT_PROCESS_MAX: u32 = 2_048;
/// 脚本回传的单卡 tags 数上限（宽于 ops 单 op 的 50：允许全量重写标签集）。
pub const CHATANKI_TRANSFORM_SCRIPT_TAGS_LIMIT: usize = 100;
/// 脚本**新写入**的单字段（front/back/text）字符数上限（Round 4 安全复审）：
/// 输出文件整体有 32MB 闸门，但缺少逐字段上限时脚本可把一张卡的单字段膨胀到
/// ~32MB 并经 CAS 写库，形成存储/渲染放大炸弹。回显既有超长字段（值与快照
/// 完全一致 = 未修改）不受此限，避免误伤"整对象回写"模式下的存量大卡。
pub const CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS: usize = 100_000;
/// 脚本**新写入**的单个 tag 字符数上限（与 APKG 导入 MAX_TAG_BYTES 同量级）。
pub const CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS: usize = 4_096;
/// 输出 `cards` 数组条目数硬上限（Round 4 安全复审）：选择集 ≤ 500，合同
/// 容忍少量未知 id 逐项报告，但成千上万条伪造条目只可能是恶意/失控输出，
/// fail-closed 整批拒绝，防止 unknownCardIds 洪泛撑爆工具返回值。
pub const CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES: usize =
    2 * super::chatanki_transform::CHATANKI_TRANSFORM_CARD_LIMIT;
/// 输出条目 `id` 字符数上限（真实卡 id 为 UUID 量级；超长 id 只能是伪造，
/// 且未截断回显会借 unknownCardIds 注入超大 payload）。
pub const CHATANKI_TRANSFORM_SCRIPT_ID_MAX_CHARS: usize = 128;
/// 逐卡拒绝 detail 中回显脚本自报内容（如未知键名）的截断长度，
/// 防止敌意超长键名借 detail 放大工具返回值。
const SCRIPT_ISSUE_ECHO_MAX_CHARS: usize = 64;
/// 超时杀进程组后等待收尸 / 排空管道的宽限期。
const SCRIPT_CLEANUP_GRACE: Duration = Duration::from_secs(5);

/// job 目录内的固定文件名（同时也是环境变量指向的目标）。
pub const CHATANKI_INPUT_FILE: &str = "CHATANKI_INPUT.json";
pub const CHATANKI_OUTPUT_FILE: &str = "CHATANKI_OUTPUT.json";

static JOB_SEQ: AtomicU64 = AtomicU64::new(0);

// ============================================================================
// 参数（wire 形态 → 归一化）
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptLanguage {
    Python,
    Node,
}

impl ScriptLanguage {
    pub fn as_str(&self) -> &'static str {
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
pub struct TransformScriptSpec {
    language: ScriptLanguage,
    code: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedTransformScript {
    pub language: ScriptLanguage,
    pub code: String,
    pub timeout: Duration,
}

impl TransformScriptSpec {
    pub fn normalize(self) -> Result<NormalizedTransformScript, String> {
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
pub fn build_script_input(document_id: &str, cards: &[crate::models::AnkiCard]) -> Value {
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
pub enum ScriptOutputError {
    /// 输出文件超过大小上限。
    TooLarge { bytes: u64, limit: u64 },
    /// 不是合法 JSON。
    Parse(String),
    /// JSON 形状不符合合同（缺 cards / 非数组 / 条目缺 id / 重复 id 等）。
    Schema(String),
}

impl ScriptOutputError {
    pub fn detail(&self) -> String {
        match self {
            Self::TooLarge { bytes, limit } => {
                format!("CHATANKI_OUTPUT.json is {bytes} bytes, exceeding the {limit} byte limit")
            }
            Self::Parse(detail) | Self::Schema(detail) => detail.clone(),
        }
    }
}

/// 单卡输出条目被拒绝的结构化原因（不整批失败，逐卡 invalid）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptCardIssue {
    pub code: &'static str,
    pub detail: String,
}

/// 输出评估结果：与选择集**等长且同序**的逐卡计划。
#[derive(Debug)]
pub struct ScriptTransformEvaluation {
    /// `Ok(after)`：变换后的字段快照（可能与 before 相同 = 未变更）；
    /// `Err(issue)`：该卡输出条目非法，apply 时逐卡拒绝。
    pub card_plans: Vec<Result<TransformFields, ScriptCardIssue>>,
    /// 输出中出现但不在快照内的 id（v1 禁止脚本增删卡，逐项报告）。
    pub unknown_card_ids: Vec<String>,
}

/// 输出条目允许的更新键。`version` / `index` / `templateId` / `extraFields`
/// 是输入合同键的回显（脚本整对象回写是常见模式），**静默忽略**；其余未知键
/// 按 fail-closed 逐卡拒绝。
const SCRIPT_OUTPUT_UPDATE_KEYS: &[&str] = &["front", "back", "text", "tags"];
const SCRIPT_OUTPUT_ECHO_KEYS: &[&str] = &["id", "version", "index", "templateId", "extraFields"];

/// 与 `database::contains_valid_anki_cloze_markup` 同语义的本地实现
/// （该函数为模块私有，此处按同一规则复刻并在单测中锁定语义）：
/// 存在至少一个 `{{cN::非空答案}}`（N ≥ 1，答案允许 `::hint` 后缀）。
pub fn text_has_valid_cloze_markup(text: &str) -> bool {
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

/// 截断脚本自报内容的回显（按 Unicode 标量数），防止超长键名/值借 detail
/// 放大工具返回值。截断时追加省略号标记。
fn truncate_echo(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let truncated: String = value.chars().take(max_chars).collect();
    format!("{truncated}…")
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
                format!(
                    "output card contains unsupported field '{}' (v1 allows front/back/text/tags updates only)",
                    truncate_echo(key, SCRIPT_ISSUE_ECHO_MAX_CHARS)
                ),
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
                // 逐字段大小闸门：只约束**新写入**的值；与快照完全一致的回显
                // （= 未修改）放行，避免误伤存量超长字段的整对象回写。
                let unchanged = match field {
                    "front" => value == &before.front,
                    "back" => value == &before.back,
                    _ => Some(value.as_str()) == before.text.as_deref(),
                };
                if !unchanged && value.chars().count() > CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS {
                    return Err(issue(
                        "field_too_large",
                        format!(
                            "output card sets '{field}' to {} characters, exceeding the {} character limit",
                            value.chars().count(),
                            CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS
                        ),
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
                // 新增 tag 的长度闸门；卡上既有 tag 的原样回显放行。
                if tag.chars().count() > CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS
                    && !before.tags.iter().any(|existing| existing == &tag)
                {
                    return Err(issue(
                        "tag_too_large",
                        format!(
                            "output card carries a {} character tag, exceeding the {} character limit",
                            tag.chars().count(),
                            CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS
                        ),
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
pub fn evaluate_script_output(
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
    // 条目洪泛闸门：合法输出条目数不可能超过选择集上限的 2 倍
    //（选择集 ≤ 500，未知 id 只容忍少量并逐项报告）。fail-closed 整批拒绝。
    if cards.len() > CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES {
        return Err(ScriptOutputError::Schema(format!(
            "'cards' contains {} entries, exceeding the {} entry limit",
            cards.len(),
            CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES
        )));
    }

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
        // 超长 id 只能是伪造（真实卡 id 为 UUID 量级）；不截断回显，直接整批拒绝。
        if id.chars().count() > CHATANKI_TRANSFORM_SCRIPT_ID_MAX_CHARS {
            return Err(ScriptOutputError::Schema(format!(
                "cards[{index}] has a {} character 'id', exceeding the {} character limit",
                id.chars().count(),
                CHATANKI_TRANSFORM_SCRIPT_ID_MAX_CHARS
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
pub fn resolve_interpreter_in_dirs(candidates: &[&str], dirs: &[PathBuf]) -> Option<PathBuf> {
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

pub fn resolve_interpreter(language: ScriptLanguage) -> Option<PathBuf> {
    resolve_interpreter_in_dirs(language.candidate_bins(), &interpreter_search_dirs())
}

// ============================================================================
// 沙箱策略与命令行
// ============================================================================

/// macOS Seatbelt 的默认可读集不含 `/opt`（Homebrew Cellar），bwrap 则整根只读
/// bind 无此问题。对 `/opt/<x>/...` 下的解释器额外放行其顶层前缀目录，其余场景
/// 只补解释器所在目录（对 bwrap 恒为冗余但无害）。
pub fn extra_readable_roots_for_interpreter(interpreter: &Path) -> Vec<PathBuf> {
    let canonical = interpreter
        .canonicalize()
        .unwrap_or_else(|_| interpreter.to_path_buf());
    let mut roots = Vec::new();
    if let Some(parent) = canonical.parent() {
        roots.push(parent.to_path_buf());
        // Version-managed interpreters commonly live at <prefix>/bin while
        // their standard library/native modules live at <prefix>/lib. Expose
        // that sibling only; never expose the whole prefix (which may also
        // contain user application data such as ~/.local/share).
        if parent.file_name() == Some(std::ffi::OsStr::new("bin")) {
            if let Some(prefix) = parent.parent() {
                let lib = prefix.join("lib");
                if lib.is_dir() {
                    roots.push(lib);
                }
            }
        }
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
pub fn transform_sandbox_policy(job_dir: &Path, interpreter: &Path) -> SandboxPolicy {
    let mut readable_roots = vec![job_dir.to_path_buf()];
    readable_roots.extend(extra_readable_roots_for_interpreter(interpreter));
    SandboxPolicy {
        readable_roots,
        writable_roots: vec![job_dir.to_path_buf()],
        protected_read_roots: Vec::new(),
        protected_write_roots: Vec::new(),
        // Script bodies are untrusted. In particular, Linux must not inherit
        // shell_sandbox's compatibility-mode read-only bind of the host root.
        restrict_read_to_roots: true,
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
pub fn build_shell_command(
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
pub struct PreparedTransformJob {
    pub job_dir: PathBuf,
    pub input_path: PathBuf,
    pub output_path: PathBuf,
    pub script_path: PathBuf,
    /// 相对 temp root 的展示引用（`runtime-root://temp/...`）。
    pub job_ref: String,
}

#[cfg(unix)]
fn set_private_job_permissions(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).map_err(|error| {
        format!(
            "Failed to restrict permissions for {}: {error}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn set_private_job_permissions(_path: &Path, _mode: u32) -> Result<(), String> {
    // Windows job files inherit the app-data directory ACL.
    Ok(())
}

/// 在会话 temp root 下创建一次性 job 目录并写入输入快照与脚本正文。
/// job 目录随 temp root 生命周期保留（审计用途），不在本次调用内删除。
pub fn prepare_transform_job(
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
    // 规范化 job 目录（Round 4 安全复审）：temp root 可能位于符号链接路径下
    //（如 macOS 的 /var → /private/var）。沙箱策略按字面路径匹配（Seatbelt
    // subpath / bwrap bind），未解析的符号链接会导致策略路径与真实 vnode 路径
    // 不一致——轻则拒写（macOS 误拒），重则策略作用在错误的路径上。
    let job_dir = job_dir.canonicalize().unwrap_or(job_dir);
    // 快照含未截断卡片全文，且 job 会保留用于审计。不能依赖进程 umask：
    // 常见 0022 会创建 0755/0644，令同机其他用户可读。目录先收紧到
    // owner-only，再创建文件，避免文件 chmod 前的短暂暴露窗口。
    set_private_job_permissions(&job_dir, 0o700)?;

    let input_path = job_dir.join(CHATANKI_INPUT_FILE);
    let output_path = job_dir.join(CHATANKI_OUTPUT_FILE);
    let script_path = job_dir.join(script.language.script_file_name());

    let input_bytes = serde_json::to_vec(input)
        .map_err(|error| format!("Failed to serialize transform input snapshot: {error}"))?;
    std::fs::write(&input_path, input_bytes)
        .map_err(|error| format!("Failed to write {CHATANKI_INPUT_FILE}: {error}"))?;
    std::fs::write(&script_path, script.code.as_bytes())
        .map_err(|error| format!("Failed to write transform script file: {error}"))?;
    set_private_job_permissions(&input_path, 0o600)?;
    set_private_job_permissions(&script_path, 0o600)?;

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

/// transform script 在所有受支持桌面后端上必须具备的资源合同。
///
/// wall-clock timeout 由每次请求携带，故在 `ScriptExecutionReport::to_json`
/// 中与这些固定/后端上限一起序列化。`sandbox_file_size_max_bytes` 是平台
/// 额外纵深防御（Unix RLIMIT_FSIZE；Windows 为 `None`）；可移植的输出读入
/// 上限始终由 `output_file_max_bytes` 独立强制。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptResourceLimits {
    pub stream_max_bytes: u64,
    pub stream_tail_bytes: usize,
    pub output_file_max_bytes: u64,
    pub sandbox_file_size_max_bytes: Option<u64>,
    pub active_process_max: u32,
}

impl ScriptResourceLimits {
    fn to_json(&self, timeout: Duration) -> Value {
        json!({
            "wallClockTimeoutMs": timeout.as_millis() as u64,
            "stdoutMaxBytes": self.stream_max_bytes,
            "stderrMaxBytes": self.stream_max_bytes,
            "stdoutTailBytes": self.stream_tail_bytes,
            "stderrTailBytes": self.stream_tail_bytes,
            "outputFileMaxBytes": self.output_file_max_bytes,
            "sandboxFileMaxBytes": self.sandbox_file_size_max_bytes,
            "activeProcessesMax": self.active_process_max,
        })
    }
}

/// 把平台后端能力收敛为 transform 的可移植资源合同。
///
/// script 模式本来就要求硬沙箱；这里进一步要求网络隔离、进程组隔离和有限
/// 进程数均被后端声明为已执行。任一项缺失或未来被放宽到 transform 上限之外
/// 都 fail-closed，不会降级成无界执行。
pub fn transform_resource_limits(
    effects: &SandboxEffectReport,
) -> Result<ScriptResourceLimits, String> {
    if !effects.enforced {
        return Err("transform script requires an enforced hard sandbox".to_string());
    }
    if !effects.network_enforced {
        return Err("transform script requires enforced network isolation".to_string());
    }
    if !effects.process_group_isolated {
        return Err("transform script requires isolated process-group cleanup".to_string());
    }
    let Some(active_process_max) = effects.active_process_limit else {
        return Err("transform script requires an active-process limit".to_string());
    };
    if active_process_max == 0 || active_process_max > CHATANKI_TRANSFORM_SCRIPT_PROCESS_MAX {
        return Err(format!(
            "sandbox active-process limit {active_process_max} is outside the transform script range 1..={CHATANKI_TRANSFORM_SCRIPT_PROCESS_MAX}"
        ));
    }

    Ok(ScriptResourceLimits {
        stream_max_bytes: CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES,
        stream_tail_bytes: CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES,
        output_file_max_bytes: CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES,
        sandbox_file_size_max_bytes: effects.file_size_limit_bytes,
        active_process_max,
    })
}

/// 一次脚本执行的观测报告（成功与否都会尽力填充，进入工具返回值与审计）。
#[derive(Debug, Clone)]
pub struct ScriptExecutionReport {
    pub language: &'static str,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub stdout_bytes_read: u64,
    pub stderr_bytes_read: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub sandbox_backend: &'static str,
    pub interpreter: String,
    pub resource_limits: ScriptResourceLimits,
}

impl ScriptExecutionReport {
    pub fn to_json(&self, timeout: Duration) -> Value {
        json!({
            "language": self.language,
            "exitCode": self.exit_code,
            "timedOut": self.timed_out,
            "timeoutMs": timeout.as_millis() as u64,
            "durationMs": self.duration_ms,
            "stdoutTail": self.stdout_tail,
            "stderrTail": self.stderr_tail,
            "stdoutBytesRead": self.stdout_bytes_read,
            "stderrBytesRead": self.stderr_bytes_read,
            "stdoutTruncated": self.stdout_truncated,
            "stderrTruncated": self.stderr_truncated,
            "sandbox": self.sandbox_backend,
            "interpreter": self.interpreter,
            "resourceLimits": self.resource_limits.to_json(timeout),
        })
    }
}

/// 脚本执行失败的结构化分类（全部映射为工具的结构化返回，不 panic）。
#[derive(Debug)]
pub enum ScriptRunError {
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

#[derive(Debug, PartialEq, Eq)]
struct StreamCapture {
    tail: Vec<u8>,
    bytes_read: u64,
    truncated: bool,
}

/// 有界日志捕获：每条流最多消费 `max_bytes + 1` 字节用于识别超限，报告仅保留
/// 已接受前缀的最后 `tail_cap` 字节。超限后 reader 随 task 结束而关闭；持续写日志
/// 的脚本会收到 broken pipe，而宿主不会在整个 timeout 窗口内无限排空日志。
async fn drain_stream_tail<R>(mut reader: R, tail_cap: usize, max_bytes: u64) -> StreamCapture
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut tail: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut bytes_read = 0u64;
    let probe_limit = max_bytes.saturating_add(1);
    loop {
        let remaining = probe_limit.saturating_sub(bytes_read);
        if remaining == 0 {
            break;
        }
        let read_len = usize::try_from(remaining.min(chunk.len() as u64)).unwrap_or(chunk.len());
        match reader.read(&mut chunk[..read_len]).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let accepted = usize::try_from(max_bytes.saturating_sub(bytes_read))
                    .unwrap_or(usize::MAX)
                    .min(read);
                tail.extend_from_slice(&chunk[..accepted]);
                if tail.len() > tail_cap {
                    let excess = tail.len() - tail_cap;
                    tail.drain(..excess);
                }
                bytes_read = bytes_read.saturating_add(read as u64);
                if bytes_read > max_bytes {
                    break;
                }
            }
        }
    }
    StreamCapture {
        tail,
        bytes_read,
        truncated: bytes_read > max_bytes,
    }
}

fn tail_to_string(tail: Vec<u8>) -> String {
    String::from_utf8_lossy(&tail).into_owned()
}

#[derive(Debug, PartialEq, Eq)]
enum BoundedOutputReadError {
    Missing,
    NotRegular,
    TooLarge { bytes: u64, limit: u64 },
    Io(String),
}

/// 输出文件的双重有界读取：先用 metadata 快速拒绝，再只读取 `limit + 1`
/// 字节。即使文件在 metadata 检查后发生变化，也不会进入无界 `std::fs::read`
/// 分配路径。
fn read_output_file_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, BoundedOutputReadError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
        Ok(_) => return Err(BoundedOutputReadError::NotRegular),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(BoundedOutputReadError::Missing);
        }
        Err(error) => return Err(BoundedOutputReadError::Io(error.to_string())),
    };
    if metadata.len() > limit {
        return Err(BoundedOutputReadError::TooLarge {
            bytes: metadata.len(),
            limit,
        });
    }

    let file =
        std::fs::File::open(path).map_err(|error| BoundedOutputReadError::Io(error.to_string()))?;
    let mut output =
        Vec::with_capacity(usize::try_from(metadata.len().min(limit)).unwrap_or_default());
    file.take(limit.saturating_add(1))
        .read_to_end(&mut output)
        .map_err(|error| BoundedOutputReadError::Io(error.to_string()))?;
    if output.len() as u64 > limit {
        return Err(BoundedOutputReadError::TooLarge {
            bytes: output.len() as u64,
            limit,
        });
    }
    Ok(output)
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
pub async fn run_transform_script(
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
    let resource_limits = transform_resource_limits(&backend.effect_report(&policy))
        .map_err(ScriptRunError::SandboxUnavailable)?;

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
    let process_id = child.id().ok_or_else(|| {
        backend.cleanup_command_resources(&command);
        ScriptRunError::Setup("Sandboxed transform script did not expose a process id".to_string())
    })?;

    let stdout_task = child.stdout.take().map(|stream| {
        tokio::spawn(drain_stream_tail(
            stream,
            CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES,
            CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES,
        ))
    });
    let stderr_task = child.stderr.take().map(|stream| {
        tokio::spawn(drain_stream_tail(
            stream,
            CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES,
            CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES,
        ))
    });

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
                log::warn!(
                    "[chatanki_transform] failed to terminate timed-out script group: {error}"
                );
            }
            let _ = tokio::time::timeout(SCRIPT_CLEANUP_GRACE, child.wait()).await;
            None
        }
    };
    if !timed_out {
        // 前台解释器可能 0 退出但留下继承同一进程组的后台后代。读取输出前先
        // 清理它们，关闭继续改写输出文件/占用日志管道的竞态窗口。
        if let Err(error) = cleanup_finished_process_group(process_id) {
            log::warn!(
                "[chatanki_transform] failed to clean up finished script descendants: {error}"
            );
        }
    }
    backend.cleanup_command_resources(&command);

    // 进程（组）已退出/被杀，管道随之关闭；限期回收日志尾部。
    let collect_stream = |task: Option<tokio::task::JoinHandle<StreamCapture>>| async {
        match task {
            None => StreamCapture {
                tail: Vec::new(),
                bytes_read: 0,
                truncated: false,
            },
            Some(mut task) => match tokio::time::timeout(SCRIPT_CLEANUP_GRACE, &mut task).await {
                Ok(Ok(capture)) => capture,
                Ok(Err(_)) => StreamCapture {
                    tail: Vec::new(),
                    bytes_read: 0,
                    truncated: false,
                },
                Err(_) => {
                    task.abort();
                    StreamCapture {
                        tail: Vec::new(),
                        bytes_read: 0,
                        truncated: false,
                    }
                }
            },
        }
    };
    let stdout = collect_stream(stdout_task).await;
    let stderr = collect_stream(stderr_task).await;

    let report = ScriptExecutionReport {
        language: script.language.as_str(),
        exit_code: exit_status.and_then(|status| status.code()),
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
        stdout_tail: tail_to_string(stdout.tail),
        stderr_tail: tail_to_string(stderr.tail),
        stdout_bytes_read: stdout.bytes_read,
        stderr_bytes_read: stderr.bytes_read,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        sandbox_backend: contract.backend,
        interpreter: interpreter.to_string_lossy().into_owned(),
        resource_limits,
    };

    if timed_out {
        return Err(ScriptRunError::TimedOut(report));
    }
    if !exit_status.is_some_and(|status| status.success()) {
        return Err(ScriptRunError::NonZeroExit(report));
    }

    let output_bytes = match read_output_file_bounded(
        &job.output_path,
        CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES,
    ) {
        Ok(output) => output,
        Err(BoundedOutputReadError::Missing) => {
            return Err(ScriptRunError::OutputMissing(report));
        }
        Err(BoundedOutputReadError::NotRegular) => {
            return Err(ScriptRunError::Setup(format!(
                "{CHATANKI_OUTPUT_FILE} must be a regular file"
            )));
        }
        Err(BoundedOutputReadError::TooLarge { bytes, limit }) => {
            return Err(ScriptRunError::OutputTooLarge {
                report,
                bytes,
                limit,
            });
        }
        Err(BoundedOutputReadError::Io(error)) => {
            return Err(ScriptRunError::Setup(format!(
                "Failed to read {CHATANKI_OUTPUT_FILE}: {error}"
            )));
        }
    };

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

    fn make_card(
        id: &str,
        front: &str,
        back: &str,
        text: Option<&str>,
        tags: &[&str],
    ) -> crate::models::AnkiCard {
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

    #[test]
    fn bounded_output_reader_accepts_exact_limit_and_rejects_limit_plus_one() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join(CHATANKI_OUTPUT_FILE);
        std::fs::write(&output, b"12345678").unwrap();
        assert_eq!(read_output_file_bounded(&output, 8).unwrap(), b"12345678");

        std::fs::write(&output, b"123456789").unwrap();
        assert_eq!(
            read_output_file_bounded(&output, 8).unwrap_err(),
            BoundedOutputReadError::TooLarge { bytes: 9, limit: 8 }
        );
    }

    #[test]
    fn bounded_output_reader_rejects_missing_and_non_regular_paths() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing.json");
        assert_eq!(
            read_output_file_bounded(&missing, 8).unwrap_err(),
            BoundedOutputReadError::Missing
        );
        assert_eq!(
            read_output_file_bounded(temp.path(), 8).unwrap_err(),
            BoundedOutputReadError::NotRegular
        );
    }

    #[tokio::test]
    async fn stream_capture_stops_after_budget_and_keeps_bounded_tail() {
        let payload: Vec<u8> = (0u8..64).collect();
        let capture = drain_stream_tail(&payload[..], 8, 32).await;
        assert_eq!(capture.bytes_read, 33, "one probe byte detects overflow");
        assert!(capture.truncated);
        assert_eq!(capture.tail, payload[24..32]);

        let capture = drain_stream_tail(&payload[..16], 8, 32).await;
        assert_eq!(capture.bytes_read, 16);
        assert!(!capture.truncated);
        assert_eq!(capture.tail, payload[8..16]);
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

        let raw =
            serde_json::to_vec(&json!({ "cards": [{ "id": "card-1", "front": "  " }] })).unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert_eq!(
            evaluation.card_plans[0].as_ref().unwrap_err().code,
            "empty_field"
        );

        let raw =
            serde_json::to_vec(&json!({ "cards": [{ "id": "card-1", "back": 42 }] })).unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert_eq!(
            evaluation.card_plans[0].as_ref().unwrap_err().code,
            "invalid_field_type"
        );

        let raw = serde_json::to_vec(&json!({ "cards": [{ "id": "card-1", "tags": ["ok", ""] }] }))
            .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert_eq!(
            evaluation.card_plans[0].as_ref().unwrap_err().code,
            "empty_field"
        );
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
        let raw =
            serde_json::to_vec(&json!({ "cards": [{ "id": "card-1", "tags": tags }] })).unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert_eq!(
            evaluation.card_plans[0].as_ref().unwrap_err().code,
            "tags_limit_exceeded"
        );
    }

    // ------------------------------------------------------------------
    // Round 4 安全复审：输出合同的资源边界与伪造 id 防线
    // ------------------------------------------------------------------

    /// 安全回归：脚本新写入的超长字段被逐卡拒绝（存储放大炸弹），
    /// 但与快照完全一致的超长回显（= 未修改）放行。
    #[test]
    fn security_output_rejects_oversized_new_field_but_allows_echo_of_existing() {
        let oversized_existing = "旧".repeat(CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS + 10);
        let cards = [
            make_card("card-1", &oversized_existing, "A", None, &[]),
            make_card("card-2", "Q", "A", None, &[]),
        ];
        let bomb = "爆".repeat(CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS + 1);
        let raw = serde_json::to_vec(&json!({
            "cards": [
                // card-1 原样回显自己的超长 front：未修改，必须放行
                { "id": "card-1", "front": oversized_existing },
                // card-2 试图写入新的超长 back：逐卡拒绝
                { "id": "card-2", "back": bomb },
            ],
        }))
        .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert!(
            evaluation.card_plans[0].is_ok(),
            "echo of existing oversized field must pass"
        );
        let issue = evaluation.card_plans[1].as_ref().unwrap_err();
        assert_eq!(issue.code, "field_too_large");
        assert!(issue.detail.contains("character limit"), "{}", issue.detail);
    }

    /// 安全回归：脚本新增的超长 tag 被逐卡拒绝；卡上既有超长 tag 的回显放行。
    #[test]
    fn security_output_rejects_oversized_new_tag_but_allows_existing_echo() {
        let long_existing_tag = "既".repeat(CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS + 5);
        let cards = [
            make_card("card-1", "Q", "A", None, &[long_existing_tag.as_str()]),
            make_card("card-2", "Q", "A", None, &[]),
        ];
        let bomb_tag = "炸".repeat(CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS + 1);
        let raw = serde_json::to_vec(&json!({
            "cards": [
                { "id": "card-1", "tags": [long_existing_tag] },
                { "id": "card-2", "tags": [bomb_tag] },
            ],
        }))
        .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert!(
            evaluation.card_plans[0].is_ok(),
            "existing tag echo must pass"
        );
        assert_eq!(
            evaluation.card_plans[1].as_ref().unwrap_err().code,
            "tag_too_large"
        );
    }

    /// 安全回归：条目洪泛（成千上万条伪造 id）在 schema 层整批拒绝，
    /// 防止 unknownCardIds 撑爆工具返回值。
    #[test]
    fn security_output_rejects_entry_floods_at_schema_level() {
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        let flood: Vec<Value> = (0..(CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES + 1))
            .map(|index| json!({ "id": format!("forged-{index}") }))
            .collect();
        let raw = serde_json::to_vec(&json!({ "cards": flood })).unwrap();
        let error = evaluate_script_output(&raw, &cards).unwrap_err();
        assert!(matches!(error, ScriptOutputError::Schema(_)), "{error:?}");
        assert!(error.detail().contains("entry limit"), "{}", error.detail());

        // 恰好在上限内则维持既有"容忍并报告未知 id"语义
        let tolerated: Vec<Value> = (0..CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES)
            .map(|index| json!({ "id": format!("forged-{index}") }))
            .collect();
        let raw = serde_json::to_vec(&json!({ "cards": tolerated })).unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        assert_eq!(
            evaluation.unknown_card_ids.len(),
            CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES
        );
    }

    /// 安全回归：超长伪造 id 在 schema 层整批拒绝（不回显 id 本体）。
    #[test]
    fn security_output_rejects_overlong_forged_ids() {
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        let forged_id = "x".repeat(CHATANKI_TRANSFORM_SCRIPT_ID_MAX_CHARS + 1);
        let raw = serde_json::to_vec(&json!({
            "cards": [{ "id": forged_id.clone(), "front": "伪造" }],
        }))
        .unwrap();
        let error = evaluate_script_output(&raw, &cards).unwrap_err();
        assert!(matches!(error, ScriptOutputError::Schema(_)), "{error:?}");
        assert!(
            error.detail().contains("character limit"),
            "{}",
            error.detail()
        );
        assert!(
            !error.detail().contains(&forged_id),
            "detail must not echo the forged id body"
        );
    }

    /// 安全回归：未知键名的 detail 回显被截断，敌意超长键名不能借 detail
    /// 放大工具返回值。
    #[test]
    fn security_unknown_field_detail_truncates_hostile_key() {
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        let hostile_key = "k".repeat(10_000);
        let raw = serde_json::to_vec(&json!({
            "cards": [{ "id": "card-1", hostile_key.clone(): "payload" }],
        }))
        .unwrap();
        let evaluation = evaluate_script_output(&raw, &cards).unwrap();
        let issue = evaluation.card_plans[0].as_ref().unwrap_err();
        assert_eq!(issue.code, "unknown_output_field");
        assert!(
            issue.detail.chars().count() < 300,
            "detail must stay bounded, got {} chars",
            issue.detail.chars().count()
        );
        assert!(issue.detail.contains('…'), "truncation marker expected");
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
        assert!(
            resolve_interpreter_in_dirs(&["python3", "python"], &[temp.path().to_path_buf()])
                .is_none()
        );
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
        let powershell = build_shell_command(
            "windows_powershell",
            ScriptLanguage::Python,
            interpreter,
            script,
        )
        .unwrap();
        assert!(powershell.starts_with("& '"));
        assert!(
            build_shell_command("unavailable", ScriptLanguage::Python, interpreter, script)
                .is_err()
        );
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
        assert!(policy.restrict_read_to_roots);
    }

    fn sandbox_effects(active_process_limit: Option<u32>) -> SandboxEffectReport {
        SandboxEffectReport {
            backend: "test_hard_sandbox",
            shell_kind: "posix_sh",
            output_encoding: "utf-8",
            enforced: true,
            network_enforced: true,
            process_group_isolated: true,
            cpu_time_limit_seconds: Some(130),
            file_size_limit_bytes: Some(4 * 1024 * 1024 * 1024),
            active_process_limit,
            readable_roots: 1,
            writable_roots: 1,
            protected_read_roots: 0,
            protected_write_roots: 0,
        }
    }

    #[test]
    fn resource_contract_exposes_portable_stream_file_and_process_limits() {
        let limits = transform_resource_limits(&sandbox_effects(Some(128))).unwrap();
        assert_eq!(
            limits.stream_max_bytes,
            CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES
        );
        assert_eq!(
            limits.stream_tail_bytes,
            CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES
        );
        assert_eq!(
            limits.output_file_max_bytes,
            CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES
        );
        assert_eq!(limits.active_process_max, 128);

        let json = limits.to_json(Duration::from_secs(30));
        assert_eq!(json["wallClockTimeoutMs"], 30_000);
        assert_eq!(json["stdoutMaxBytes"], 1024 * 1024);
        assert_eq!(json["stderrMaxBytes"], 1024 * 1024);
        assert_eq!(json["outputFileMaxBytes"], 32 * 1024 * 1024);
        assert_eq!(json["activeProcessesMax"], 128);
    }

    #[test]
    fn resource_contract_fails_closed_without_bounded_process_tree() {
        let missing = transform_resource_limits(&sandbox_effects(None)).unwrap_err();
        assert!(missing.contains("active-process limit"), "{missing}");

        let mut relaxed = sandbox_effects(Some(CHATANKI_TRANSFORM_SCRIPT_PROCESS_MAX + 1));
        let error = transform_resource_limits(&relaxed).unwrap_err();
        assert!(
            error.contains("outside the transform script range"),
            "{error}"
        );

        relaxed.active_process_limit = Some(128);
        relaxed.process_group_isolated = false;
        let error = transform_resource_limits(&relaxed).unwrap_err();
        assert!(error.contains("process-group"), "{error}");

        relaxed.process_group_isolated = true;
        relaxed.network_enforced = false;
        let error = transform_resource_limits(&relaxed).unwrap_err();
        assert!(error.contains("network isolation"), "{error}");
    }

    #[test]
    fn interpreter_under_opt_gains_top_level_readable_root() {
        let roots = extra_readable_roots_for_interpreter(Path::new("/opt/homebrew/bin/python3.12"));
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
        // job_dir 会被 canonicalize（macOS /var → /private/var），比较前对齐
        let canonical_temp = temp
            .path()
            .canonicalize()
            .unwrap_or_else(|_| temp.path().to_path_buf());
        assert!(job.job_dir.starts_with(&canonical_temp));
        assert!(job
            .job_ref
            .starts_with("runtime-root://temp/chatanki_transform/job-"));
        let written: Value =
            serde_json::from_slice(&std::fs::read(&job.input_path).unwrap()).unwrap();
        assert_eq!(written, input);
        assert_eq!(
            std::fs::read_to_string(&job.script_path).unwrap(),
            "print('ok')"
        );
        assert!(!job.output_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn prepare_job_keeps_full_card_snapshot_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let script = NormalizedTransformScript {
            language: ScriptLanguage::Python,
            code: "print('ok')".to_string(),
            timeout: Duration::from_secs(5),
        };
        let job = prepare_transform_job(
            temp.path(),
            &script,
            &json!({ "cards": [{ "front": "private material" }] }),
        )
        .unwrap();

        assert_eq!(
            std::fs::metadata(&job.job_dir)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for path in [&job.input_path, &job.script_path] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600,
                "{} must be owner-only",
                path.display()
            );
        }
    }

    /// 安全回归：temp root 位于符号链接路径下时 job 目录被规范化为真实路径，
    /// 保证沙箱策略（Seatbelt subpath / bwrap bind）作用在真实 vnode 路径上。
    #[cfg(unix)]
    #[test]
    fn security_prepare_job_canonicalizes_symlinked_temp_root() {
        let real = tempfile::tempdir().unwrap();
        let holder = tempfile::tempdir().unwrap();
        let link = holder.path().join("temp-root-link");
        std::os::unix::fs::symlink(real.path(), &link).unwrap();

        let script = NormalizedTransformScript {
            language: ScriptLanguage::Python,
            code: "print('ok')".to_string(),
            timeout: Duration::from_secs(5),
        };
        let job = prepare_transform_job(&link, &script, &json!({ "cards": [] })).unwrap();
        let canonical_real = real.path().canonicalize().unwrap();
        assert!(
            job.job_dir.starts_with(&canonical_real),
            "job dir {} must resolve under the real temp root {}",
            job.job_dir.display(),
            canonical_real.display()
        );
        assert!(job.input_path.starts_with(&canonical_real));
        assert!(job.output_path.starts_with(&canonical_real));
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
        let (report, output, job_ref) = run_transform_script(temp.path(), "doc-1", &cards, &script)
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

    /// 安全回归（e2e）：脚本只能读取 job 快照及解释器运行时，不能借 Linux
    /// bwrap 的只读根挂载读取 job 外的宿主文件后通过卡片字段外带。
    #[cfg(unix)]
    #[tokio::test]
    async fn e2e_host_files_outside_job_are_unreadable() {
        if !sandbox_e2e_ready(ScriptLanguage::Python) {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let secret = temp.path().join("host-secret.txt");
        std::fs::write(&secret, "must-not-leak").unwrap();
        let secret_literal = serde_json::to_string(&secret.to_string_lossy().to_string()).unwrap();
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        let script = NormalizedTransformScript {
            language: ScriptLanguage::Python,
            code: format!(
                r#"
import json, os
try:
    with open({secret_literal}, encoding="utf-8") as fh:
        result = "leaked:" + fh.read()
except OSError:
    result = "denied"
with open(os.environ["CHATANKI_OUTPUT"], "w", encoding="utf-8") as fh:
    json.dump({{"cards": [{{"id": "card-1", "front": result}}]}}, fh)
"#
            ),
            timeout: Duration::from_secs(30),
        };
        let (_report, output, _job_ref) =
            run_transform_script(temp.path(), "doc-1", &cards, &script)
                .await
                .expect("sandboxed script should still write its declared output");
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

    /// 安全回归（e2e）：脚本把 CHATANKI_OUTPUT.json 写成指向沙箱外文件的
    /// 符号链接时，Rust 侧必须结构化拒绝且**不跟随读取**链接目标。
    #[cfg(unix)]
    #[tokio::test]
    async fn e2e_symlink_output_is_rejected_without_following() {
        if !sandbox_e2e_ready(ScriptLanguage::Python) {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let cards = [make_card("card-1", "Q", "A", None, &[])];
        let script = NormalizedTransformScript {
            language: ScriptLanguage::Python,
            code: r#"
import os
os.symlink("/etc/passwd", os.environ["CHATANKI_OUTPUT"])
"#
            .to_string(),
            timeout: Duration::from_secs(30),
        };
        let error = run_transform_script(temp.path(), "doc-1", &cards, &script)
            .await
            .expect_err("symlink output must be rejected");
        match error {
            ScriptRunError::Setup(detail) => {
                assert!(
                    detail.contains("must be a regular file"),
                    "unexpected detail: {detail}"
                );
                assert!(
                    !detail.contains("root:"),
                    "detail must not leak symlink target contents"
                );
            }
            other => panic!("expected Setup rejection, got {other:?}"),
        }
    }
}
