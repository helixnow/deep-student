use crate::anki_protocol::{self, OutputProtocol, StructuredOutputOptions};
use crate::database::Database;
use crate::llm_manager::{build_provider_adapter, ApiConfig, LLMManager};
use crate::models::{
    AnkiCard, AnkiGenerationOptions, AppError, DocumentTask, FieldExtractionRule, FieldType,
    StreamedCardPayload, TaskStatus, TemplateDescription,
};
use crate::providers::ProviderAdapter;
use chrono::Utc;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;
use tauri::{Emitter, Window};
use tokio::sync::{watch, Mutex};
use tokio::time::timeout;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

const RETRY_ASSIGNMENT_MARK: &str = "[RETRY_ASSIGNED]";

// F3（round2）：将原先散落的控制流魔法字符串集中为常量，降低笔误与“字符串即协议”的脆弱性。
// 注：这是低风险硬化，未改为类型化错误枚举（那属跨层中风险重构，已登记待评估）。
/// 用户主动取消的内部哨兵消息：流式取消路径以 `AppError::validation` 携带，
/// 调度层据此判定“用户取消”而非真正错误。
const CANCELLED_BY_USER_MSG: &str = "CANCELLED_BY_USER";
/// `handle_task_error` 据错误消息判定 `Truncated` 的关键词（上游 LLM 截断/超时提示）。
const ERR_KEYWORD_TIMEOUT: &str = "超时";
const ERR_KEYWORD_TRUNCATED: &str = "截断";
/// 解析残片完全不含可读文本时的内部哨兵消息：
/// 流式循环据此判定"丢弃该残片并记录 warning"，而非降级为错误卡。
const UNREADABLE_FRAGMENT_MSG: &str = "UNREADABLE_CARD_FRAGMENT";
/// 字段校验违规标记写入 `extra_fields` 的键名。
/// 设计取舍：违规不毙卡（LLM 输出轻微越界很常见，毙卡损失内容），
/// 仅在卡片上留痕供 QA/前端复查，值为 JSON 数组字符串。
pub const QA_FLAGS_FIELD: &str = "_qa_flags";

// 已知会泄漏进制卡流的模型包装 token（issue #58 / PR #187）。
//
// 这些值也可能作为协议示例出现在卡片正文中，因此只能丢弃纯 token 残片，
// 或剥离完整卡片 JSON 外侧的纯 token 包装，不能做全局字符串替换。
//
// wave2-A r4 #2：本地表删除，改引 utils 单源，避免两处清理层的 token 清单漂移。
use crate::utils::model_special_tokens::MODEL_SPECIAL_TOKENS;

fn contains_only_model_special_tokens(text: &str) -> bool {
    let mut remaining = text.trim();
    let mut consumed_token = false;

    while !remaining.is_empty() {
        let Some(rest) = MODEL_SPECIAL_TOKENS
            .iter()
            .find_map(|token| remaining.strip_prefix(token))
        else {
            return false;
        };
        remaining = rest.trim_start();
        consumed_token = true;
    }

    consumed_token
}

/// 丢弃纯 token 残片，或剥离完整卡片 JSON 外侧的纯 token 包装。
///
/// #268 对 #187 的最终语义要求保留正文中的字面 token；尤其是截断 JSON，
/// 不能因为其中出现 `<|im_end|>` 等值就删除用户内容。
fn strip_model_special_tokens(text: &str) -> String {
    if contains_only_model_special_tokens(text) {
        return String::new();
    }

    let trimmed = text.trim();
    if let (Some(json_start), Some(json_end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        let prefix = &trimmed[..json_start];
        let suffix = &trimmed[json_end + 1..];
        let prefix_is_token = contains_only_model_special_tokens(prefix);
        let suffix_is_token = contains_only_model_special_tokens(suffix);
        let prefix_is_noise = prefix.trim().is_empty() || prefix_is_token;
        let suffix_is_noise = suffix.trim().is_empty() || suffix_is_token;

        if (prefix_is_token || suffix_is_token) && prefix_is_noise && suffix_is_noise {
            return trimmed[json_start..=json_end].to_string();
        }
    }

    text.to_string()
}

/// 纯模型 token 错误卡无法通过重试修复，只会反复生成同一错误卡。
fn error_content_is_repairable(content: &str) -> bool {
    strip_model_special_tokens(content)
        .chars()
        .any(|c| c.is_alphanumeric())
}

/// 流收尾残留展开出的单卡 payload（见 `expand_wrapper_payloads`）。
///
/// `truncated == true` 表示该卡只能经有损修复（字符串中途截断补引号）才拼回
/// 语法合法的 JSON——内容已经丢失，必须落错误卡，不得按正常卡解析入库。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResidualCardPayload {
    json: String,
    truncated: bool,
}

/// 单个任务流式生成的统计结果（仅新增上报口径，不影响既有事件契约）。
#[derive(Debug, Default, Clone, Copy)]
pub struct StreamStats {
    /// 成功入库的卡片数
    pub card_count: u32,
    /// 解析/校验失败、降级为错误卡的卡片数
    pub failed_cards: u32,
    /// 因 DB 唯一索引去重而跳过的重复卡片数
    pub duplicate_cards: u32,
    /// 不含任何可读文本、被直接丢弃的残片数
    pub dropped_fragments: u32,
    /// 字段校验违规、被标记 `_qa_flags` 但仍入库的卡片数
    pub flagged_cards: u32,
}

impl StreamStats {
    /// 本次生成是否留有质量警告（失败卡/丢弃残片/去重/校验标记任一非零）。
    /// 任务成功收尾时据此在 `TaskCompleted` 事件上打 `completed_with_warnings`。
    pub fn has_warnings(&self) -> bool {
        self.failed_cards > 0
            || self.dropped_fragments > 0
            || self.duplicate_cards > 0
            || self.flagged_cards > 0
    }

    /// 是否携带任何非零计数（失败路径据此决定要不要补发 `GenerationStats`）。
    pub fn has_any_signal(&self) -> bool {
        self.card_count > 0 || self.has_warnings()
    }
}

/// 构建 `CriticSummary` 事件载荷（纯函数便于单测）。
///
/// 不手抄字段：直接对 [`crate::anki_critic::CriticSummary`] 做 serde 序列化，
/// 再 merge 进 `task_id` / `document_id`。struct 新增字段（如 `gold_references`、
/// `gold_references_truncated`、`routed_config_id`、`routed_model`、
/// `routed_degraded`）会自动跟着上 wire，无需再改本函数；旧版前端按 key
/// 消费未识别字段会被安全忽略。
fn build_critic_summary_event(
    task_id: &str,
    document_id: &str,
    summary: &crate::anki_critic::CriticSummary,
) -> Value {
    let mut inner = serde_json::to_value(summary).unwrap_or_else(|e| {
        error!("序列化 CriticSummary 失败（降级为空对象）: {}", e);
        json!({})
    });
    if let Some(obj) = inner.as_object_mut() {
        obj.insert("task_id".to_string(), json!(task_id));
        obj.insert("document_id".to_string(), json!(document_id));
    }
    json!({ "CriticSummary": inner })
}

/// 构建 `TaskCompleted` 事件载荷（纯函数便于单测）。
///
/// 以既有 [`StreamedCardPayload::TaskCompleted`] 序列化结果为基底（保证
/// `task_id` / `final_status` / `total_cards_generated` / `document_id`
/// 与旧 wire 格式完全一致），再 merge 进本轮新增的质量统计字段与
/// `completed_with_warnings` 标记。旧版前端按 key 消费，未识别字段安全忽略。
fn build_task_completed_event(task_id: &str, document_id: &str, stats: &StreamStats) -> Value {
    let base = StreamedCardPayload::TaskCompleted {
        task_id: task_id.to_string(),
        final_status: TaskStatus::Completed,
        total_cards_generated: stats.card_count,
        document_id: Some(document_id.to_string()),
    };
    let mut value = serde_json::to_value(&base).unwrap_or_else(|e| {
        error!("序列化 TaskCompleted 失败（降级为最小载荷）: {}", e);
        json!({ "TaskCompleted": { "task_id": task_id, "document_id": document_id } })
    });
    if let Some(obj) = value
        .get_mut("TaskCompleted")
        .and_then(Value::as_object_mut)
    {
        obj.insert("failed_cards".to_string(), json!(stats.failed_cards));
        obj.insert(
            "dropped_fragments".to_string(),
            json!(stats.dropped_fragments),
        );
        obj.insert("duplicate_cards".to_string(), json!(stats.duplicate_cards));
        obj.insert("flagged_cards".to_string(), json!(stats.flagged_cards));
        obj.insert(
            "completed_with_warnings".to_string(),
            json!(stats.has_warnings()),
        );
    }
    value
}

#[derive(Clone)]
pub struct StreamingAnkiService {
    db: Arc<Database>,
    llm_manager: Arc<LLMManager>,
    client: Client,
}

struct PromptPayload {
    system: Option<String>,
    user: String,
    debug_preview: String,
}

// 全局取消信号寄存（确保不同实例可见）
static CANCEL_SENDERS: LazyLock<Mutex<HashMap<String, watch::Sender<bool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn normalize_template_identifier(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || ('\u{4E00}'..='\u{9FFF}').contains(c))
        .collect()
}

fn resolve_template_id_candidate(
    raw_candidate: Option<String>,
    template_descriptions: Option<&[TemplateDescription]>,
    template_ids: Option<&[String]>,
    template_fields_by_id: Option<&HashMap<String, Vec<String>>>,
) -> Option<String> {
    let candidate = raw_candidate
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;

    let mut exact_matches: Vec<String> = Vec::new();

    if let Some(fields_by_id) = template_fields_by_id {
        if fields_by_id.contains_key(candidate) {
            return Some(candidate.to_string());
        }
        for key in fields_by_id.keys() {
            if key.eq_ignore_ascii_case(candidate) {
                return Some(key.clone());
            }
        }
    }

    if let Some(ids) = template_ids {
        if ids.iter().any(|id| id == candidate) {
            return Some(candidate.to_string());
        }
        for id in ids {
            if id.eq_ignore_ascii_case(candidate) {
                return Some(id.clone());
            }
        }
    }

    if let Some(descriptions) = template_descriptions {
        for t in descriptions {
            if t.id == candidate || t.id.eq_ignore_ascii_case(candidate) || t.name == candidate {
                exact_matches.push(t.id.clone());
            }
        }
    }

    if exact_matches.len() == 1 {
        return exact_matches.into_iter().next();
    }
    if exact_matches.len() > 1 {
        return None;
    }

    let normalized_candidate = normalize_template_identifier(candidate);
    if normalized_candidate.is_empty() {
        return None;
    }

    let mut normalized_matches: Vec<String> = Vec::new();
    if let Some(fields_by_id) = template_fields_by_id {
        for key in fields_by_id.keys() {
            if normalize_template_identifier(key) == normalized_candidate {
                normalized_matches.push(key.clone());
            }
        }
    }
    if let Some(ids) = template_ids {
        for id in ids {
            if normalize_template_identifier(id) == normalized_candidate
                && !normalized_matches.contains(id)
            {
                normalized_matches.push(id.clone());
            }
        }
    }
    if let Some(descriptions) = template_descriptions {
        for t in descriptions {
            if (normalize_template_identifier(&t.id) == normalized_candidate
                || normalize_template_identifier(&t.name) == normalized_candidate)
                && !normalized_matches.contains(&t.id)
            {
                normalized_matches.push(t.id.clone());
            }
        }
    }

    if normalized_matches.len() == 1 {
        return normalized_matches.into_iter().next();
    }

    None
}

fn format_template_identifier_help(options: &AnkiGenerationOptions) -> String {
    let mut entries: Vec<String> = Vec::new();
    if let Some(descriptions) = options.template_descriptions.as_ref() {
        for t in descriptions {
            entries.push(format!("{}({})", t.id, t.name));
            if entries.len() >= 8 {
                break;
            }
        }
    } else if let Some(ids) = options.template_ids.as_ref() {
        for id in ids {
            entries.push(id.clone());
            if entries.len() >= 8 {
                break;
            }
        }
    } else if let Some(fields_by_id) = options.template_fields_by_id.as_ref() {
        for key in fields_by_id.keys() {
            entries.push(key.clone());
            if entries.len() >= 8 {
                break;
            }
        }
    }

    if entries.is_empty() {
        "可用模板列表为空".to_string()
    } else {
        format!("可用模板(部分): {}", entries.join(", "))
    }
}

/// 从卡片 JSON 中提取首个可读的文本内容（顶层优先，再查 `fields` 嵌套对象）。
///
/// 用于 front 字段的最终兜底：旧实现直接把整段 JSON `to_string()` 塞进 front，
/// 用户会看到原始 JSON 噪声。现在优先提取可读文本，完全没有可读内容时由调用方丢弃。
fn extract_readable_text(json_value: &Value) -> Option<String> {
    fn scan(obj: &serde_json::Map<String, Value>) -> Option<String> {
        for (key, value) in obj {
            let key_lower = key.to_lowercase();
            if matches!(
                key_lower.as_str(),
                "tags" | "template_id" | "templateid" | "images" | "fields"
            ) {
                continue;
            }
            if let Some(s) = value.as_str() {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        None
    }

    let obj = json_value.as_object()?;
    scan(obj).or_else(|| obj.get("fields").and_then(|f| f.as_object()).and_then(scan))
}

/// 按字段提取规则的 `is_required` 标记生成诚实的字段要求描述。
///
/// 旧实现把所有非 front/back/tags 字段硬编码标为"可选"，
/// 与解析侧"必需字段缺失即报错"的行为矛盾，误导模型省略必填字段。
fn describe_prompt_field(field: &str, rule: Option<&FieldExtractionRule>) -> String {
    let required_mark = match rule {
        Some(r) if r.is_required => "必填",
        Some(_) => "可选",
        // 无规则可查时退回历史默认：front/back 必填，其余可选
        None => match field {
            "front" | "back" => "必填",
            _ => "可选",
        },
    };
    let type_label = match rule.map(|r| &r.field_type) {
        Some(FieldType::Array) => "字符串数组",
        Some(FieldType::Number) => "数字",
        Some(FieldType::Boolean) => "布尔值",
        Some(_) => "字符串",
        None if field == "tags" => "字符串数组",
        None => "字符串",
    };
    let description = rule
        .map(|r| r.description.trim())
        .filter(|d| !d.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| match field {
            "front" => "问题或概念".to_string(),
            "back" => "答案或解释".to_string(),
            "tags" => "相关标签".to_string(),
            "example" => "具体示例".to_string(),
            "source" => "来源信息".to_string(),
            "code" => "代码示例".to_string(),
            "notes" => "补充注释".to_string(),
            _ => field.to_string(),
        });
    format!(
        "{}（{}，{}）：{}",
        field, type_label, required_mark, description
    )
}

/// 在字段提取规则中按名称查找规则（先精确匹配，再大小写不敏感匹配）。
fn find_rule<'a>(
    rules: Option<&'a HashMap<String, FieldExtractionRule>>,
    field: &str,
) -> Option<&'a FieldExtractionRule> {
    let rules = rules?;
    rules.get(field).or_else(|| {
        rules
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(field))
            .map(|(_, rule)| rule)
    })
}

/// 依据规则元数据（min_length/max_length/allowed_values/validation_pattern）校验字段值。
///
/// 返回违规描述列表（每项为 `{field, rule, message}` 的 JSON 对象）；
/// 空列表表示通过。违规不作为错误返回——调用方将其汇总写入
/// `extra_fields[QA_FLAGS_FIELD]`，卡片照常入库。
///
/// 长度按 Unicode 字符数（`chars().count()`）计，避免中文按字节数误判。
/// `validation_pattern` 编译失败视为模板配置问题：记录 warning 并跳过该项，
/// 不惩罚卡片本身。
fn validate_field_against_rule(
    field_name: &str,
    value: &str,
    rule: &FieldExtractionRule,
) -> Vec<Value> {
    let mut violations = Vec::new();
    let char_count = value.chars().count() as u32;

    if let Some(min) = rule.min_length {
        if char_count < min {
            violations.push(json!({
                "field": field_name,
                "rule": "min_length",
                "message": format!("长度 {} 小于最小长度 {}", char_count, min),
            }));
        }
    }

    if let Some(max) = rule.max_length {
        if char_count > max {
            violations.push(json!({
                "field": field_name,
                "rule": "max_length",
                "message": format!("长度 {} 超过最大长度 {}", char_count, max),
            }));
        }
    }

    if let Some(allowed) = rule.allowed_values.as_deref().filter(|v| !v.is_empty()) {
        let matched = allowed.iter().any(|candidate| match candidate {
            Value::String(s) => s == value,
            other => other.to_string() == value,
        });
        if !matched {
            let preview: String = value.chars().take(40).collect();
            violations.push(json!({
                "field": field_name,
                "rule": "allowed_values",
                "message": format!("值 \"{}\" 不在允许值列表中", preview),
            }));
        }
    }

    if let Some(pattern) = rule
        .validation_pattern
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        match regex::Regex::new(pattern) {
            Ok(re) => {
                if !re.is_match(value) {
                    violations.push(json!({
                        "field": field_name,
                        "rule": "validation_pattern",
                        "message": format!("值不匹配校验模式 {}", pattern),
                    }));
                }
            }
            Err(e) => {
                warn!(
                    "[QA_FLAGS] 字段 {} 的 validation_pattern 无法编译（{}），跳过该项校验",
                    field_name, e
                );
            }
        }
    }

    violations
}

/// 判断 JSON 片段是否自身配平（括号栈空且不落在字符串中）。
/// 用于 clean_json_string 区分「完整对象 + 尾部垃圾」与「未闭合的截断输入」。
fn json_fragment_balanced(fragment: &str) -> bool {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for c in fragment.chars() {
        if in_string {
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            _ => {}
        }
        if depth < 0 {
            return false;
        }
    }
    depth == 0 && !in_string
}

impl StreamingAnkiService {
    pub fn new(db: Arc<Database>, llm_manager: Arc<LLMManager>) -> Self {
        // 生产路径不 panic：带超时配置构建失败时（极罕见，TLS 初始化异常等）
        // 记录错误并回退默认客户端，保证服务仍可实例化。
        let client = Client::builder()
            .timeout(Duration::from_secs(600)) // 10分钟超时，适合流式处理
            .build()
            .unwrap_or_else(|e| {
                error!("创建带超时配置的HTTP客户端失败，回退默认客户端: {}", e);
                Client::new()
            });

        Self {
            db,
            llm_manager,
            client,
        }
    }

    /// 处理任务并流式生成卡片
    pub async fn process_task_and_generate_cards_stream(
        &self,
        task: DocumentTask,
        window: Window,
        // F5（round2）：调度层在 spawn 前传入就绪信号；本任务注册取消通道后立即回执，
        // 调度层据此确定性等待（替代固定 sleep(20ms)）。None 表示调用方不关心就绪时机。
        ready_signal: Option<tokio::sync::oneshot::Sender<()>>,
    ) -> Result<(), AppError> {
        let task_id = task.id.clone();

        // 更新任务状态为处理中
        self.update_task_status(
            &task_id,
            TaskStatus::Processing,
            None,
            Some(task.segment_index),
            Some(task.document_id.as_str()),
            &window,
        )
        .await?;

        // 获取配置（Sidekick 路由感知：见 get_configurations 文档）
        let api_config = match self
            .get_configurations(&task.anki_generation_options_json)
            .await
        {
            Ok(cfg) => cfg,
            Err(err) => {
                self.handle_task_error(
                    &task_id,
                    &err,
                    &window,
                    Some(task.segment_index),
                    Some(task.document_id.as_str()),
                )
                .await?;
                return Ok(());
            }
        };

        // 解析生成选项
        let options: AnkiGenerationOptions =
            match serde_json::from_str(&task.anki_generation_options_json) {
                Ok(opts) => opts,
                Err(e) => {
                    let err = AppError::validation(format!("解析生成选项失败: {}", e));
                    self.handle_task_error(
                        &task_id,
                        &err,
                        &window,
                        Some(task.segment_index),
                        Some(task.document_id.as_str()),
                    )
                    .await?;
                    return Ok(());
                }
            };

        // 协议扩展选项（output_protocol / enable_qa_pass）：从同一份 options JSON
        // 经 AnkiGenerationOptions 单点解析后投影（见 StructuredOutputOptions）。
        let structured_opts =
            StructuredOutputOptions::from_options_json(&task.anki_generation_options_json);
        let capability = anki_protocol::detect_schema_capability(
            &api_config.model_adapter,
            api_config.api_protocol.as_deref(),
            api_config.provider_type.as_deref(),
            &api_config.base_url,
        );
        let (mut protocol, protocol_reason) = anki_protocol::resolve_output_protocol(
            structured_opts.output_protocol.as_deref(),
            capability,
        );
        info!(
            "[ANKI_PROTOCOL] 输出协议决策: protocol={} reason={} capability={:?} model={} adapter={}",
            protocol.as_str(),
            protocol_reason,
            capability,
            api_config.model,
            api_config.model_adapter
        );

        // 全局限额分配下，额度为 0 的分段直接跳过，避免“0 表示无限制”带来额外卡片。
        if options.max_cards_total.unwrap_or(0) > 0 && options.max_cards_per_mistake <= 0 {
            self.update_task_status(
                &task_id,
                TaskStatus::Completed,
                None,
                Some(task.segment_index),
                Some(task.document_id.as_str()),
                &window,
            )
            .await?;
            return Ok(());
        }

        // 构建prompt
        let prompt_payload = match self.build_prompt(&task.content_segment, &options, protocol) {
            Ok(p) => p,
            Err(err) => {
                self.handle_task_error(
                    &task_id,
                    &err,
                    &window,
                    Some(task.segment_index),
                    Some(task.document_id.as_str()),
                )
                .await?;
                return Ok(());
            }
        };

        // 确定API参数
        let max_tokens = options
            .max_output_tokens_override
            .or(options.max_tokens)
            .unwrap_or(api_config.max_output_tokens);
        let temperature = options
            .temperature_override
            .or(options.temperature)
            .unwrap_or(api_config.temperature);

        // 开始流式处理
        self.update_task_status(
            &task_id,
            TaskStatus::Streaming,
            None,
            Some(task.segment_index),
            Some(task.document_id.as_str()),
            &window,
        )
        .await?;
        // 设置取消通道（暂停走文档级硬取消，见 EnhancedAnkiService::pause_document_processing）
        let (cancel_tx, cancel_rx) = watch::channel(false);
        // 结构化协议被端点拒绝时回退 delimiter 重试一次需要第二个接收端
        let cancel_rx_fallback = cancel_tx.subscribe();
        {
            let mut senders = CANCEL_SENDERS.lock().await;
            senders.insert(task_id.clone(), cancel_tx);
        }
        // F5（round2）：取消通道已注册，确定性通知调度层（替代非确定性的 sleep(20ms)）。
        // 任一提前返回路径都会 drop 掉 ready_signal，使调度层的 await 立即返回，不会死等。
        if let Some(ready_tx) = ready_signal {
            let _ = ready_tx.send(());
        }
        // 统计口径由调用方持有（out 参数）：流式中途失败时已累计的
        // 失败卡/丢弃残片/去重/标记计数不随 Err 丢失，失败路径仍可上报。
        let mut stream_stats = StreamStats::default();
        let mut result = self
            .stream_cards_from_ai(
                &api_config,
                &prompt_payload,
                &task.content_segment,
                max_tokens,
                temperature,
                &task_id,
                &task.document_id,
                &window,
                &options,
                protocol,
                structured_opts.qa_pass_enabled(),
                cancel_rx,
                &mut stream_stats,
            )
            .await;

        // 结构化输出被端点拒绝（HTTP 400/404/422，典型为 response_format 不支持或
        // schema 不合法）时，回退 delimiter 协议重试一次。失败发生在 HTTP 状态检查
        // 阶段（任何卡片解析之前），重试不会产生重复卡片。
        if let Err(ref e) = result {
            if protocol.is_structured()
                && e.message != CANCELLED_BY_USER_MSG
                && anki_protocol::is_probably_structured_output_rejection(&e.message)
            {
                warn!(
                    "[ANKI_PROTOCOL] 结构化输出请求被拒绝（{}），回退 delimiter 协议重试一次",
                    e.message
                );
                protocol = OutputProtocol::Delimiter;
                match self.build_prompt(&task.content_segment, &options, protocol) {
                    Ok(fallback_prompt) => {
                        // 首次失败发生在 HTTP 状态检查阶段（任何卡片解析之前），
                        // 计数理应全零；重置以确保重试统计不叠加。
                        stream_stats = StreamStats::default();
                        result = self
                            .stream_cards_from_ai(
                                &api_config,
                                &fallback_prompt,
                                &task.content_segment,
                                max_tokens,
                                temperature,
                                &task_id,
                                &task.document_id,
                                &window,
                                &options,
                                protocol,
                                structured_opts.qa_pass_enabled(),
                                cancel_rx_fallback,
                                &mut stream_stats,
                            )
                            .await;
                    }
                    Err(prompt_err) => {
                        warn!(
                            "[ANKI_PROTOCOL] 回退 delimiter 时重建 prompt 失败，保留原始错误: {}",
                            prompt_err
                        );
                    }
                }
            }
        }

        let outcome: Result<(), AppError> = match result {
            Ok(()) => {
                // 先上报本次流式生成的质量统计（新增事件，前端按需消费，旧版前端会安全忽略）
                self.emit_generation_stats(&task_id, &task.document_id, &stream_stats, &window);
                // Round 4 #2：生成后 LLM critic pass（opt-in，默认关闭）。
                // 对本任务已入库卡片做一次批量 grounded 裁决（keep|revise|flag）。
                // run_critic_pass 永不返回 Err：模型失败/解析失败一律降级为全 keep，
                // 绝不影响整批制卡的成功收尾。
                let critic_opts = crate::anki_critic::CriticOptions::from_options_json(
                    &task.anki_generation_options_json,
                );
                if critic_opts.critic_enabled() && stream_stats.card_count > 0 {
                    let critic_cfg = critic_opts.to_config();
                    // Round 5 #4：同文档兄弟卡的用户修正记录 → 同源金标参照
                    // （改前劣化/改后金标）。收集失败/无信号返回空列表，
                    // critic 自动回到规则 rubric，收尾路径行为不变。
                    let gold_refs = crate::anki_critic::collect_gold_references(
                        self.db.as_ref(),
                        &task,
                        &critic_cfg,
                    );
                    let critic_summary = crate::anki_critic::run_critic_pass(
                        self.db.as_ref(),
                        self.llm_manager.as_ref(),
                        &task,
                        &gold_refs,
                        &critic_cfg,
                    )
                    .await;
                    self.emit_critic_summary(&task_id, &task.document_id, &critic_summary, &window);
                }
                self.complete_task_successfully(&task_id, &stream_stats, &task.document_id, &window)
                    .await
            }
            Err(e) => {
                if e.message == CANCELLED_BY_USER_MSG {
                    // 由上层 EnhancedAnkiService 负责将任务状态置为 Paused 并派发事件，避免重复事件
                    info!("🛑 任务被用户取消，保持暂停态由调度层处理: {}", task_id);
                    Ok(())
                } else {
                    // 失败前已累计的统计（部分卡片已入库/已降级为错误卡等）
                    // 同样补发 GenerationStats，前端据此展示"失败但有部分产出"。
                    if stream_stats.has_any_signal() {
                        self.emit_generation_stats(
                            &task_id,
                            &task.document_id,
                            &stream_stats,
                            &window,
                        );
                    }
                    self.handle_task_error(
                        &task_id,
                        &e,
                        &window,
                        Some(task.segment_index),
                        Some(task.document_id.as_str()),
                    )
                    .await
                }
            }
        };
        // 清理取消通道（无论成功/失败都必须执行，否则 CANCEL_SENDERS 会泄漏残留条目）
        CANCEL_SENDERS.lock().await.remove(&task_id);

        outcome
    }

    /// 获取API配置
    ///
    /// ===== Sidekick 模型分层路由（Round 4 #7）=====
    /// 先经 `anki_model_routing` 计算完整路由计划（Planner/Generator/Critic/Vlm）
    /// 并 debug 输出决策，本流式生成路径取 Generator 角色的模型：
    /// - 槽位齐全时 Generator 即制卡槽模型，与旧行为完全一致；
    /// - 制卡槽缺失时降级到主模型槽（旧路径此时会直接报配置错误）。
    /// 路由的任何异常（探测失败/无可用槽位/配置消失）都回退到下方旧的
    /// 单模型解析路径，绝不因路由本身阻断制卡（要求 5）。
    async fn get_configurations(&self, options_json: &str) -> Result<ApiConfig, AppError> {
        let mode = crate::anki_model_routing::parse_routing_mode(options_json);
        let slots = self.llm_manager.probe_anki_routing_slots().await;
        if let Some(plan) = crate::anki_model_routing::plan_routing(mode, &slots) {
            plan.log_debug();
            let generator = plan.decision(crate::anki_model_routing::AnkiModelRole::Generator);
            match self.llm_manager.get_api_configs().await {
                Ok(configs) => {
                    if let Some(cfg) = configs
                        .into_iter()
                        .find(|c| c.id == generator.config_id && c.enabled)
                    {
                        debug!(
                            "[ANKI_ROUTING] Generator 角色选定模型: id={} model={} slot={:?} degraded={}",
                            generator.config_id, generator.model, generator.slot, generator.degraded
                        );
                        return Ok(cfg);
                    }
                    debug!(
                        "[ANKI_ROUTING] Generator 槽位配置 {} 已不可用，回退旧单模型路径",
                        generator.config_id
                    );
                }
                Err(e) => {
                    debug!("[ANKI_ROUTING] 读取 API 配置失败，回退旧单模型路径: {}", e);
                }
            }
        } else {
            debug!("[ANKI_ROUTING] 无可用路由槽位，回退旧单模型路径");
        }

        // ===== 旧单模型路径（保持原始错误语义） =====
        // 获取模型分配
        let model_assignments = self
            .llm_manager
            .get_model_assignments()
            .await
            .map_err(|e| AppError::configuration(format!("获取模型分配失败: {}", e)))?;

        // 获取Anki制卡模型配置
        let anki_model_id = model_assignments.anki_card_model_config_id.ok_or_else(|| {
            AppError::configuration(
                "Anki制卡模型在模型分配中未配置 (anki_card_model_config_id is None)",
            )
        })?;
        // debug removed

        let api_configs = self
            .llm_manager
            .get_api_configs()
            .await
            .map_err(|e| AppError::configuration(format!("获取API配置失败: {}", e)))?;

        let config_count = api_configs.len();
        let api_config = api_configs
            .into_iter()
            .find(|config| config.id == anki_model_id && config.enabled)
            .ok_or_else(|| {
                AppError::configuration(format!(
                    "找不到有效的Anki制卡模型配置. Tried to find ID: {} in {} available configs.",
                    anki_model_id, config_count
                ))
            })?;

        // debug removed

        Ok(api_config)
    }

    /// 构建AI提示词
    fn build_prompt(
        &self,
        content: &str,
        options: &AnkiGenerationOptions,
        protocol: OutputProtocol,
    ) -> Result<PromptPayload, AppError> {
        // 默认 Anki 制卡 prompt（通用质量要求，始终保留）
        let default_prompt = "你是一个专业的 Anki 学习卡片制作助手。请根据提供的学习内容，生成高质量的 Anki 学习卡片。\n\n要求：\n1. 卡片应该有助于记忆和理解\n2. 问题要简洁明确\n3. 答案要准确完整\n4. 适当添加相关标签\n5. 确保卡片的逻辑性和实用性\n6. 卡片内容语言必须与学习材料一致：英文材料生成英文卡片，中文材料生成中文卡片，不要翻译".to_string();

        // 模板 generation_prompt（经 custom_anki_prompt 传入）改为「附加而非替换」：
        // 旧实现整体替换默认 prompt，会把上面的通用质量要求一并丢弃，
        // 模板作者写的往往只是字段格式说明，不该抹掉质量基线。
        let base_prompt = match options
            .custom_anki_prompt
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            Some(custom_prompt) => format!(
                "{}\n\n模板生成说明（模板作者提供，在遵守上述通用要求的前提下执行）：\n{}",
                default_prompt, custom_prompt
            ),
            None => default_prompt,
        };

        // system role 信息
        let mut system_sections: Vec<String> = Vec::new();

        if let Some(requirements) = &options.custom_requirements {
            let trimmed = requirements.trim();
            if !trimmed.is_empty() {
                system_sections.push(format!(
                    "🚨🚨 强制遵守的制卡要求（优先级最高） 🚨🚨\n<<CUSTOM_REQUIREMENTS>>\n{}\n<<END_CUSTOM_REQUIREMENTS>>",
                    trimmed
                ));
            }
        }

        system_sections.push(base_prompt);

        // ===== CardForge 2.0: 添加多模板信息供 LLM 自动选择 =====
        if let Some(template_descriptions) = &options.template_descriptions {
            if !template_descriptions.is_empty() {
                let mut template_info =
                    String::from("\n可用模板列表（请根据内容特征自动选择最合适的模板）：\n\n");
                for (idx, tmpl) in template_descriptions.iter().enumerate() {
                    // 基本信息
                    template_info.push_str(&format!(
                        "{}. 模板ID: {}\n   名称: {}\n   描述: {}\n   必需字段: {}\n",
                        idx + 1,
                        tmpl.id,
                        tmpl.name,
                        tmpl.description,
                        tmpl.fields.join(", ")
                    ));
                    // 如果有 generation_prompt，添加具体的字段格式说明
                    if let Some(gen_prompt) = &tmpl.generation_prompt {
                        template_info.push_str(&format!("   字段格式说明: {}\n", gen_prompt));
                    }
                    template_info.push('\n');
                }
                template_info.push_str(
                    "🚨 重要规则：\n\
                    - 选择模板后，必须严格按照该模板的「必需字段」生成 JSON\n\
                    - 字段名称必须与模板定义完全一致（区分大小写）\n\
                    - 每个卡片JSON中必须包含 \"template_id\" 字段标识使用的模板\n\
                    - template_id 只能填写模板ID，绝不能填写模板名称\n\
                    - 不要使用 front/back 等通用字段，除非模板明确要求\n\n",
                );
                let mut whitelist = Vec::new();
                let mut id_name_pairs = Vec::new();
                for tmpl in template_descriptions {
                    whitelist.push(format!("\"{}\"", tmpl.id));
                    id_name_pairs.push(format!("{} => {}", tmpl.name, tmpl.id));
                }
                template_info.push_str("template_id 白名单（只能从下列值中选择）：\n");
                template_info.push_str(&format!("[{}]\n", whitelist.join(", ")));
                template_info.push_str("名称到ID映射（若你想用某模板“名称”，必须写成对应ID）：\n");
                template_info.push_str(&id_name_pairs.join("\n"));
                template_info.push('\n');
                system_sections.push(template_info);
            }
        } else if let Some(template_ids) = &options.template_ids {
            // 回退：仅有 template_ids 但无详情时的简化提示
            if !template_ids.is_empty() {
                system_sections.push(format!(
                    "\n可用模板ID列表: {}\n\
                    请在生成卡片时选择合适的模板ID（在JSON中添加 \"template_id\" 字段）\n",
                    template_ids.join(", ")
                ));
            }
        }

        if let Some(system_prompt) = &options.system_prompt {
            let trimmed = system_prompt.trim();
            if !trimmed.is_empty() {
                system_sections.push(format!("用户补充要求：\n{}", trimmed));
            }
        }

        let system_message = system_sections.join("\n\n");

        // 多模板判定：与 parse_and_save_card 共用 anki_protocol::is_multi_template
        let multi_template = anki_protocol::is_multi_template(options);

        // 获取模板字段（多模板时不强制统一字段清单）
        let template_fields = if multi_template {
            None
        } else {
            let resolved = options.template_fields.clone().or_else(|| {
                options
                    .template_fields_by_id
                    .as_ref()
                    .and_then(|fields_by_id| {
                        if let Some(template_id) = options.template_id.as_ref() {
                            fields_by_id.get(template_id).cloned()
                        } else if fields_by_id.len() == 1 {
                            fields_by_id.values().next().cloned()
                        } else {
                            None
                        }
                    })
            });
            Some(resolved.unwrap_or_else(|| {
                vec!["front".to_string(), "back".to_string(), "tags".to_string()]
            }))
        };

        // 示例 JSON 使用语言中性占位符（<question> 等），避免中文 few-shot
        // 把非中文材料的卡片语言牵引到中文（材料语言一致性要求见系统段）。
        let (fields_requirement, example_json) = if multi_template {
            (
                "template_id（字符串）+ 所选模板的必需字段（见上方模板列表）".to_string(),
                "{\"template_id\": \"<template-id>\", \"<field-name>\": \"<value>\"}".to_string(),
            )
        } else if let Some(fields) = template_fields.as_ref() {
            // 按模板字段提取规则的 is_required 生成诚实的必填/可选标记，
            // 修复旧实现把所有扩展字段硬编码为"可选"、与解析侧校验矛盾的问题。
            let resolved_prompt_rules: Option<&HashMap<String, FieldExtractionRule>> =
                options.field_extraction_rules.as_ref().or_else(|| {
                    options
                        .field_extraction_rules_by_id
                        .as_ref()
                        .and_then(|rules_by_id| {
                            if let Some(template_id) = options.template_id.as_ref() {
                                rules_by_id.get(template_id)
                            } else if rules_by_id.len() == 1 {
                                rules_by_id.values().next()
                            } else {
                                None
                            }
                        })
                });
            let fields_requirement = fields
                .iter()
                .map(|field| describe_prompt_field(field, find_rule(resolved_prompt_rules, field)))
                .collect::<Vec<_>>()
                .join("、");

            let example_json = {
                let mut example_fields = vec![];
                for field in fields {
                    match field.as_str() {
                        "front" => example_fields.push("\"front\": \"<question>\"".to_string()),
                        "back" => example_fields.push("\"back\": \"<answer>\"".to_string()),
                        "tags" => {
                            example_fields.push("\"tags\": [\"<tag-1>\", \"<tag-2>\"]".to_string())
                        }
                        "example" => example_fields.push("\"example\": \"<example>\"".to_string()),
                        "source" => example_fields.push("\"source\": \"<source>\"".to_string()),
                        "code" => example_fields.push("\"code\": \"<code>\"".to_string()),
                        "notes" => example_fields.push("\"notes\": \"<notes>\"".to_string()),
                        _ => example_fields.push(format!("\"{}\": \"<{}>\"", field, field)),
                    }
                }
                format!("{{{}}}", example_fields.join(", "))
            };

            (fields_requirement, example_json)
        } else {
            (
                "front/back/tags（默认字段）".to_string(),
                "{\"front\": \"<question>\", \"back\": \"<answer>\", \"tags\": [\"<tag>\"]}"
                    .to_string(),
            )
        };

        // 已在系统段开头处理自定义要求

        // 构建卡片数量要求（E4 修复：上限语义是"至多 N 张"，不是"恰好 N 张"，
        // 避免模型为凑数生成低质量填充卡）
        let card_count_instruction = if options.max_cards_per_mistake > 0 {
            format!(
                "🚨 卡片数量上限 🚨\n\
                本次最多生成 {} 张卡片，超过上限的输出会被丢弃。\n\
                - 数量由内容的知识点密度决定：知识点少就少生成，不要为凑数而拆分或编造\n\
                - 优先覆盖内容中最重要的知识点，确保每张卡片高质量\n\
                - 生成到第 {} 张后必须立即停止，不要再输出任何卡片\n\n",
                options.max_cards_per_mistake, options.max_cards_per_mistake
            )
        } else {
            "根据内容的信息密度生成适量的高质量卡片，充分覆盖所有知识点。\n\n".to_string()
        };

        // 输出格式指令按协议生成（分隔符常量与解析侧共用 anki_protocol::CARD_DELIMITER）
        let generation_instructions = anki_protocol::format_instructions(
            protocol,
            &card_count_instruction,
            &fields_requirement,
            &example_json,
        );

        // VlmFull 遮挡草稿 marker 只供后端字段接线使用，不能暴露给生成模型，
        // 否则模型可能把机器协议误制成卡片正文。
        let model_visible_content =
            crate::anki_image_occlusion::strip_occlusion_draft_markers(content);
        let user_message = format!(
            "{}\n\n请根据以下内容生成Anki卡片：\n\n{}",
            generation_instructions, model_visible_content
        );

        let debug_preview = format!("[SYSTEM]\n{}\n\n[USER]\n{}", system_message, user_message);

        Ok(PromptPayload {
            system: if system_message.trim().is_empty() {
                None
            } else {
                Some(system_message)
            },
            user: user_message,
            debug_preview,
        })
    }

    /// 流式处理AI响应并生成卡片
    ///
    /// 返回本次流式生成的统计（成功/失败/去重/丢弃残片计数），供上层做进度与质量上报。
    async fn stream_cards_from_ai(
        &self,
        api_config: &ApiConfig,
        prompt_payload: &PromptPayload,
        source_content: &str,
        max_tokens: u32,
        temperature: f32,
        task_id: &str,
        document_id: &str,
        window: &Window,
        options: &AnkiGenerationOptions,
        protocol: OutputProtocol,
        qa_pass_enabled: bool,
        mut cancel_rx: watch::Receiver<bool>,
        // 统计累计口径改为调用方持有的 out 参数：任何提前 Err 返回
        // （取消/超时/网络中断等）都不会丢失已累计的计数，
        // 失败路径也能上报 GenerationStats。
        stats: &mut StreamStats,
    ) -> Result<(), AppError> {
        let mut messages = vec![];
        if let Some(system_message) = &prompt_payload.system {
            messages.push(json!({
                "role": "system",
                "content": system_message
            }));
        }
        messages.push(json!({
            "role": "user",
            "content": prompt_payload.user
        }));

        let mut request_body = json!({
            "model": api_config.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": true
        });

        // 结构化协议：注入 OpenAI CC 形态的 response_format。
        // 各 provider 适配器（providers/mod.rs、adapters/gemini-openai-converter.rs）
        // 负责将其转换为 Responses text.format / Anthropic output_config.format /
        // Gemini response_schema；delimiter 协议不注入，保持历史请求体不变。
        if let Some(response_format) = anki_protocol::build_response_format(protocol, options) {
            info!(
                "[ANKI_PROTOCOL] 注入 response_format: protocol={} type={}",
                protocol.as_str(),
                response_format
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("?")
            );
            request_body["response_format"] = response_format;
        }

        // 使用 ProviderAdapter 构建请求（支持 Gemini 中转），并统一合并自定义头 / Codex OAuth。
        let adapter: Box<dyn ProviderAdapter> = build_provider_adapter(api_config);
        let mut preq = self
            .llm_manager
            .prepare_provider_request(
                adapter.as_ref(),
                api_config,
                &request_body,
                None,
                Some(task_id),
                "Anki 流式请求构建失败",
            )
            .await?;

        let request_url = preq.url.clone();
        debug!(
            "[ANKI_REQUEST_DEBUG] Attempting to POST to URL: {}",
            request_url
        );
        debug!(
            "[ANKI_REQUEST_DEBUG] Request Body Model: {}",
            api_config.model
        );
        debug!(
            "[ANKI_REQUEST_DEBUG] Prompt length: {}",
            prompt_payload.debug_preview.len()
        );
        debug!(
            "[ANKI_REQUEST_DEBUG] Max Tokens: {}, Temperature: {}",
            max_tokens, temperature
        );
        debug!(
            "[ANKI_REQUEST_DEBUG] Max Cards Per Mistake: {}",
            options.max_cards_per_mistake
        );
        debug!(
            "[ANKI_REQUEST_DEBUG] System Prompt: {}",
            if let Some(sp) = &options.system_prompt {
                if sp.trim().is_empty() {
                    "未设置"
                } else {
                    "已自定义"
                }
            } else {
                "使用默认"
            }
        );

        // 输出完整的 prompt 内容
        debug!("[ANKI_PROMPT_DEBUG] ==> 完整Prompt内容开始 <==");
        debug!("{}", prompt_payload.debug_preview);
        debug!("[ANKI_PROMPT_DEBUG] ==> 完整Prompt内容结束 <==");

        // 输出完整的请求体
        debug!("[ANKI_REQUEST_DEBUG] ==> 完整请求体开始 <==");
        debug!(
            "{}",
            serde_json::to_string_pretty(&request_body).unwrap_or_default()
        );
        debug!("[ANKI_REQUEST_DEBUG] ==> 完整请求体结束 <==");

        let response = if preq.is_codex() {
            self.llm_manager
                .send_codex_stream_request_with_single_refresh(
                    &mut preq,
                    Some(Duration::from_secs(600)),
                )
                .await?
        } else {
            let mut req_builder = self.client
                .post(&request_url)
                .header("Accept", "text/event-stream, application/json, text/plain, */*")
                .header("Accept-Encoding", "identity")
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                .header("Connection", "keep-alive")
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
            for (k, v) in &preq.headers {
                req_builder = req_builder.header(k, v);
            }

            req_builder
                .json(&preq.body)
                .send()
                .await
                .map_err(|e| AppError::network(format!("AI请求失败: {}", e)))?
        };

        if !response.status().is_success() {
            let status_code = response.status().as_u16();
            let error_text = response.text().await.unwrap_or_default();
            // 🔧 三轮修复 #9: 记录完整错误到日志，但返回给前端的消息不包含敏感信息
            error!(
                "[ANKI_API_ERROR] HTTP {} - 详细错误: {}",
                status_code, error_text
            );

            // 根据状态码返回用户友好的错误消息
            let user_message = match status_code {
                401 => "API 认证失败，请检查 API 密钥配置",
                403 => "API 访问被拒绝，请检查账户权限",
                429 => "API 请求过于频繁，请稍后重试",
                500..=599 => "AI 服务暂时不可用，请稍后重试",
                _ => "AI API 请求失败，请检查网络连接或 API 配置",
            };
            return Err(AppError::llm(format!(
                "{} (HTTP {})",
                user_message, status_code
            )));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut _last_activity = std::time::Instant::now(); // Prefixed to silence warning
        const IDLE_TIMEOUT: Duration = Duration::from_secs(180); // 180秒无响应超时
        const LOG_STREAM_CHUNKS: bool = false; // 禁用逐chunk日志
        let mut sse_buffer = crate::utils::sse_buffer::SseEventBuffer::new();
        let mut chunk_counter: u32 = 0;
        let mut reached_card_limit = false;
        // VlmFull 只为包含 marker 的分段生成一个遮挡草稿。仅首张成功入库卡
        // 消费它，避免把同一 spec 假装附着到该分段的每一张普通卡。
        let mut pending_occlusion_fields =
            crate::anki_image_occlusion::extract_occlusion_draft_fields(source_content);

        loop {
            // 同时监听取消信号与流事件
            let next_item = tokio::select! {
                _ = cancel_rx.changed() => {
                    info!("🛑 检测到取消信号，终止流式制卡");
                    return Err(AppError::validation(CANCELLED_BY_USER_MSG.to_string()));
                },
                res = timeout(IDLE_TIMEOUT, stream.next()) => {
                    res.map_err(|_| AppError::network("AI响应超时"))?
                }
            };

            let Some(chunk_result) = next_item else {
                break;
            };

            let chunk =
                chunk_result.map_err(|e| AppError::network(format!("读取AI响应流失败: {}", e)))?;
            _last_activity = std::time::Instant::now(); // Prefixed to silence warning
            for line in sse_buffer.process_bytes(&chunk) {
                // 检查是否是结束标记
                if crate::utils::sse_buffer::SseEventBuffer::check_done_marker(&line) {
                    debug!("📍 检测到SSE结束标记: [DONE]");
                    break;
                }

                // 使用 ProviderAdapter 解析流事件，兼容 Gemini/OpenAI/Claude
                let events = adapter.parse_stream(&line);
                for event in events {
                    match event {
                        crate::providers::StreamEvent::ContentChunk(content) => {
                            chunk_counter += 1;
                            if LOG_STREAM_CHUNKS {
                                debug!(
                                    "[ANKI_RESPONSE_STREAM][chunk={}] {}",
                                    chunk_counter, content
                                );
                            }
                            buffer.push_str(&content);
                            if *cancel_rx.borrow() {
                                return Err(AppError::validation(
                                    CANCELLED_BY_USER_MSG.to_string(),
                                ));
                            }

                            // 结构化协议：剥离 wrapper 前缀 {"cards": [ 后，
                            // 数组内的卡片对象成为顶层对象，brace-depth 切卡器
                            // 可原样逐卡流式切出（首卡延迟与 delimiter 协议持平）
                            if protocol.is_structured() {
                                anki_protocol::strip_wrapper_prefix(&mut buffer);
                            }

                            // 检查是否有完整的卡片
                            while let Some(card_result) = self.extract_card_from_buffer(&mut buffer)
                            {
                                // 硬截断：达到 max_cards_per_mistake 上限时停止
                                if options.max_cards_per_mistake > 0
                                    && stats.card_count as i32 >= options.max_cards_per_mistake
                                {
                                    info!(
                                        "[ANKI_CARD_DEBUG] 已达到卡片上限 {}，停止解析",
                                        options.max_cards_per_mistake
                                    );
                                    reached_card_limit = true;
                                    break;
                                }
                                match card_result {
                                    Ok(card_json) => {
                                        match self
                                            .parse_and_save_card(
                                                &card_json,
                                                task_id,
                                                document_id,
                                                options,
                                                qa_pass_enabled,
                                                pending_occlusion_fields.as_ref(),
                                            )
                                            .await
                                        {
                                            Ok(Some(card)) => {
                                                if pending_occlusion_fields.is_some()
                                                    && card.extra_fields.contains_key(
                                                        crate::anki_image_occlusion::OCCLUSION_FIELD,
                                                    )
                                                {
                                                    pending_occlusion_fields = None;
                                                }
                                                stats.card_count += 1;
                                                if card.extra_fields.contains_key(QA_FLAGS_FIELD) {
                                                    stats.flagged_cards += 1;
                                                }
                                                debug!("[ANKI_CARD_DEBUG] 已生成第{}张卡片 (上限: {}张)", stats.card_count, options.max_cards_per_mistake);
                                                self.emit_new_card(card, document_id, window).await;
                                            }
                                            Ok(None) => {
                                                // 重复卡片被 DB 唯一索引去重跳过，计数上报但不中断流程
                                                stats.duplicate_cards += 1;
                                                debug!("[ANKI_CARD_DEBUG] 卡片被跳过（重复或不需要保存）");
                                            }
                                            Err(e)
                                                if e.message.contains(UNREADABLE_FRAGMENT_MSG) =>
                                            {
                                                // 残片完全不含可读文本：丢弃并记录 warning，
                                                // 不再生成 front 为原始 JSON 的噪声卡片
                                                stats.dropped_fragments += 1;
                                                warn!(
                                                    "[ANKI_CARD_DEBUG] 丢弃不可读残片（{} 字符）: {}",
                                                    card_json.chars().count(),
                                                    e.message
                                                );
                                                self.emit_generation_warning(
                                                    task_id,
                                                    document_id,
                                                    "unreadable_fragment_dropped",
                                                    &card_json,
                                                    window,
                                                );
                                            }
                                            Err(e) => {
                                                stats.failed_cards += 1;
                                                error!(
                                                    "解析卡片失败: {} - 原始JSON: {}",
                                                    e, card_json
                                                );
                                                match self
                                                    .create_error_card(
                                                        &format!("解析卡片失败: {}", e),
                                                        task_id,
                                                    )
                                                    .await
                                                {
                                                    Ok(error_card) => {
                                                        self.emit_error_card(
                                                            error_card,
                                                            document_id,
                                                            window,
                                                        )
                                                        .await;
                                                    }
                                                    Err(create_err) => {
                                                        let app_err =
                                                            AppError::validation(format!(
                                                                "解析卡片失败且无法创建错误卡: {}",
                                                                create_err
                                                            ));
                                                        let _ = self
                                                            .handle_task_error(
                                                                task_id,
                                                                &app_err,
                                                                window,
                                                                None,
                                                                Some(document_id),
                                                            )
                                                            .await;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    Err(truncated_content) => {
                                        stats.failed_cards += 1;
                                        if let Ok(error_card) = self
                                            .create_error_card(&truncated_content, task_id)
                                            .await
                                        {
                                            self.emit_error_card(error_card, document_id, window)
                                                .await;
                                        }
                                    }
                                }
                            }
                            if reached_card_limit {
                                break;
                            }
                        }
                        crate::providers::StreamEvent::SafetyBlocked(safety_info) => {
                            warn!("检测到安全阻断: {:?}", safety_info);
                            // 创建安全阻断错误卡片
                            let error_content = format!(
                                "AI请求被安全策略阻断: {}",
                                safety_info
                                    .get("reason")
                                    .and_then(|r| r.as_str())
                                    .unwrap_or("未知原因")
                            );
                            if let Ok(error_card) =
                                self.create_error_card(&error_content, task_id).await
                            {
                                self.emit_error_card(error_card, document_id, window).await;
                            }
                            break; // 安全阻断后停止处理
                        }
                        crate::providers::StreamEvent::Done => {
                            break;
                        }
                        _ => { /* 忽略 Reasoning/ToolCall/Usage */ }
                    }
                }
                if reached_card_limit {
                    break;
                }
            }
            if reached_card_limit {
                break;
            }
        }

        if !reached_card_limit {
            // 处理自然关闭且没有空行分隔符的最后一个 SSE 事件。
            for remaining_line in sse_buffer.flush() {
                if !remaining_line.trim().is_empty() {
                    debug!(
                        "📥 处理SSE缓冲器中的剩余数据: {} 字符",
                        remaining_line.len()
                    );
                    // 使用适配器解析剩余的行
                    let events = adapter.parse_stream(&remaining_line);
                    for event in events {
                        if let crate::providers::StreamEvent::ContentChunk(content) = event {
                            chunk_counter += 1;
                            if LOG_STREAM_CHUNKS {
                                debug!(
                                    "[ANKI_RESPONSE_STREAM][chunk={}] {}",
                                    chunk_counter, content
                                );
                            }
                            buffer.push_str(&content);
                        }
                    }
                }
            }

            // 处理剩余缓冲区内容（E1 修复）：
            // 模型经常遗漏最后一张卡之后的分隔符，残留内容大概率是一张合法卡片；
            // 先尝试正常解析入库，失败且不像 JSON（纯收尾客套话）则丢弃，
            // 只有"像卡片但解析失败"才降级为错误卡。
            // GLM 系可能在最后一张卡后泄漏 box token；使用 #268 的保守清理，
            // 仅去掉纯 token 残片/JSON 外包装，不删除卡片正文里的字面 token。
            let residual_raw = buffer.trim().to_string();
            let residual = strip_model_special_tokens(&residual_raw).trim().to_string();
            if residual.is_empty() && !residual_raw.is_empty() {
                info!(
                    "[ANKI_CARD_DEBUG] 流收尾残留仅含模型特殊token，已丢弃（{} 字符）",
                    residual_raw.chars().count()
                );
            }
            if !residual.is_empty() {
                // 结构化协议下收尾残留可能是完整的 {"cards": [...]} wrapper
                // （例如整段响应在 flush 阶段才到达）：先尝试展开为逐卡 payload。
                // 非 wrapper 内容原样作为单个 payload，行为与旧实现一致。
                let payloads = self.expand_wrapper_payloads(&residual);
                for ResidualCardPayload {
                    json: payload,
                    truncated,
                } in payloads
                {
                    // 有损修复标记的卡：内容在字符串中途被截断，绝不静默入库为正常卡，
                    // 直接落错误卡保留残片供用户检查/重试（0824 评审 #3）。
                    if truncated {
                        stats.failed_cards += 1;
                        warn!(
                            "[ANKI_CARD_DEBUG] 流收尾 wrapper 的最后一张卡在字符串中途截断，降级为错误卡（{} 字符）",
                            payload.chars().count()
                        );
                        if let Ok(error_card) = self
                            .create_error_card(
                                &format!(
                                    "卡片在流结束时于字符串中途被截断，内容不完整: {}",
                                    payload
                                ),
                                task_id,
                            )
                            .await
                        {
                            self.emit_error_card(error_card, document_id, window).await;
                        }
                        continue;
                    }

                    let within_limit = options.max_cards_per_mistake <= 0
                        || (stats.card_count as i32) < options.max_cards_per_mistake;
                    let looks_like_card = payload.contains('{');

                    let mut handled = false;
                    if within_limit && looks_like_card {
                        match self
                            .parse_and_save_card(
                                &payload,
                                task_id,
                                document_id,
                                options,
                                qa_pass_enabled,
                                pending_occlusion_fields.as_ref(),
                            )
                            .await
                        {
                            Ok(Some(card)) => {
                                if pending_occlusion_fields.is_some()
                                    && card
                                        .extra_fields
                                        .contains_key(crate::anki_image_occlusion::OCCLUSION_FIELD)
                                {
                                    pending_occlusion_fields = None;
                                }
                                stats.card_count += 1;
                                if card.extra_fields.contains_key(QA_FLAGS_FIELD) {
                                    stats.flagged_cards += 1;
                                }
                                info!(
                                    "[ANKI_CARD_DEBUG] 流收尾残留缓冲解析为正常卡片（第{}张）",
                                    stats.card_count
                                );
                                self.emit_new_card(card, document_id, window).await;
                                handled = true;
                            }
                            Ok(None) => {
                                // 重复卡片被去重跳过，视为已处理
                                stats.duplicate_cards += 1;
                                debug!("[ANKI_CARD_DEBUG] 流收尾残留缓冲解析成功但被去重跳过");
                                handled = true;
                            }
                            Err(e) if e.message.contains(UNREADABLE_FRAGMENT_MSG) => {
                                // 收尾残片不含任何可读文本：丢弃并记录 warning
                                stats.dropped_fragments += 1;
                                warn!(
                                    "[ANKI_CARD_DEBUG] 丢弃流收尾的不可读残片（{} 字符）",
                                    payload.chars().count()
                                );
                                self.emit_generation_warning(
                                    task_id,
                                    document_id,
                                    "unreadable_fragment_dropped",
                                    &payload,
                                    window,
                                );
                                handled = true;
                            }
                            Err(e) => {
                                debug!("[ANKI_CARD_DEBUG] 流收尾残留缓冲解析失败: {}", e);
                            }
                        }
                    }

                    if !handled {
                        if looks_like_card {
                            // 像卡片但解析失败：保留为错误卡供用户检查
                            stats.failed_cards += 1;
                            if let Ok(error_card) = self.create_error_card(&payload, task_id).await
                            {
                                self.emit_error_card(error_card, document_id, window).await;
                            }
                        } else {
                            // 纯自然语言收尾（如"以上就是全部卡片"）：丢弃，不生成错误卡
                            info!(
                                "[ANKI_CARD_DEBUG] 丢弃流收尾的非卡片残留内容（{} 字符）",
                                payload.chars().count()
                            );
                        }
                    }
                }
            }
        }

        if LOG_STREAM_CHUNKS {
            debug!("[ANKI_RESPONSE_STREAM] total_chunks={}", chunk_counter);
            debug!(
                "[ANKI_RESPONSE_STREAM] cards_generated={} residual_len={}",
                stats.card_count,
                buffer.len()
            );
        }

        Ok(())
    }

    /// 单卡缓冲的硬性安全上限（字节）。
    ///
    /// 🔧 P1-2 修复：旧实现的 10000 字节阈值会把"仍在传输中的合法长卡片"
    /// （学术模板多字段、含代码块/解析的选择题在中文下仅约 3300 字即触发）
    /// 误判为截断并清空缓冲，腰斩合法卡且让后续内容成为无头残片。
    /// "缓冲过大即截断"只应作为最后防线（模型完全不输出分隔符时防止无界增长），
    /// 上限须远大于单卡体积；流结束后的残留由收尾逻辑（E1）单独处理。
    const CARD_BUFFER_HARD_LIMIT: usize = 1_000_000;

    /// 从缓冲区提取卡片
    ///
    /// 主信号：brace-depth 状态机 —— 跟踪 in_string / escape / brace_depth，
    /// 顶层 JSON 对象闭合（depth 归零）的瞬间即切出该卡片，无需等待分隔符，
    /// 天然支持"一个 chunk 内多张卡"并降低首卡延迟。
    ///
    /// 辅助信号（向后兼容）：DELIMITER `<<<ANKI_CARD_JSON_END>>>`。
    /// 当 JSON 括号不配平（残片/截断/语法损坏）时，字符串外出现的分隔符
    /// 仍会强制切卡，保证旧协议内容不会滞留缓冲；而位于 JSON 字符串内部的
    /// 分隔符文本会被状态机正确忽略，不再误切。
    ///
    /// 分隔符未到达且 JSON 未闭合时缓冲继续增长属正常现象（内容可能在下一个
    /// chunk 里），只有超过 CARD_BUFFER_HARD_LIMIT 的异常无界增长才判为截断。
    fn extract_card_from_buffer(&self, buffer: &mut String) -> Option<Result<String, String>> {
        Self::extract_card_from_buffer_impl(buffer)
    }

    /// brace-depth 切卡核心（不依赖 &self，便于单元测试直接调用）
    ///
    /// 单次线性扫描，事件按缓冲区中出现的先后顺序生效：
    /// 1. 顶层 `}` 使 depth 归零 → 切出完整 JSON 对象（主信号）；
    /// 2. 字符串外遇到标准分隔符 → 按旧协议切卡（辅助信号，兜底坏 JSON）；
    /// 3. 字符串外遇到损坏分隔符尾部（如 `<<< ANKI_CARD_JSON_END>>>`）→ 自动修复切卡。
    fn extract_card_from_buffer_impl(buffer: &mut String) -> Option<Result<String, String>> {
        // 分隔符常量与 build_prompt 指令生成侧共用唯一定义（anki_protocol）
        const DELIMITER: &str = anki_protocol::CARD_DELIMITER;
        const BROKEN_DELIMITER_TAIL: &str = anki_protocol::BROKEN_DELIMITER_TAIL;

        // 按字节扫描是 UTF-8 安全的：所有关注的字符（引号、反斜杠、大括号、
        // 分隔符）均为 ASCII，多字节字符的后续字节都 >= 0x80，不会误匹配。
        let bytes = buffer.as_bytes();

        let mut in_string = false;
        let mut escape = false;
        let mut depth: usize = 0;
        let mut obj_start: Option<usize> = None;

        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];

            if in_string {
                if escape {
                    escape = false;
                } else if b == b'\\' {
                    escape = true;
                } else if b == b'"' {
                    in_string = false;
                }
                i += 1;
                continue;
            }

            // 辅助信号（向后兼容）：字符串外的完整分隔符强制切卡，
            // 兜底括号不配平的残片（JSON 语法坏了但分隔符还在）
            if b == b'<' && bytes[i..].starts_with(DELIMITER.as_bytes()) {
                let card_content = buffer[..i].trim().to_string();
                *buffer = buffer[i + DELIMITER.len()..].to_string();
                return if card_content.is_empty() {
                    None
                } else {
                    Some(Ok(card_content))
                };
            }

            // 损坏分隔符（如 "<<< ANKI_CARD_JSON_END>>>"）的自动修复，
            // 语义与旧实现一致，但升级为字符串感知：JSON 字符串内的同形文本不会误触发
            if b == b'A' && bytes[i..].starts_with(BROKEN_DELIMITER_TAIL.as_bytes()) {
                if let Some(start) = buffer[..i].rfind("<<<") {
                    let card_content = buffer[..start].trim().to_string();
                    let end_pos = i + BROKEN_DELIMITER_TAIL.len();
                    *buffer = buffer[end_pos..].to_string();

                    warn!("[ANKI_CARD_DEBUG] 检测到损坏的分隔符，已自动修复");

                    return if card_content.is_empty() {
                        None
                    } else {
                        Some(Ok(card_content))
                    };
                }
            }

            match b {
                // 只在对象内部把引号当作 JSON 字符串边界，
                // 避免对象之间的自然语言引号污染状态机
                b'"' if depth > 0 => in_string = true,
                b'{' => {
                    if depth == 0 {
                        obj_start = Some(i);
                    }
                    depth += 1;
                }
                b'}' if depth > 0 => {
                    depth -= 1;
                    if depth == 0 {
                        if let Some(start) = obj_start {
                            let card_content = buffer[start..=i].to_string();
                            // 消费卡片本体及紧随其后的分隔符（若已到达，含损坏变体），
                            // 避免其残留成为下一张卡的前缀噪声；
                            // 对象前的自然语言前缀（如"以下是卡片："）一并丢弃
                            let mut rest_start = i + 1;
                            let rest = &buffer[rest_start..];
                            let trimmed = rest.trim_start();
                            let ws_len = rest.len() - trimmed.len();
                            if trimmed.starts_with(DELIMITER) {
                                rest_start += ws_len + DELIMITER.len();
                            } else if trimmed.starts_with("<<<") {
                                // 损坏分隔符变体（如 "<<< ANKI_CARD_JSON_END>>>"）紧随卡片时一并消费
                                if let Some(tail_pos) = trimmed.find(BROKEN_DELIMITER_TAIL) {
                                    let between = &trimmed[3..tail_pos];
                                    if between.chars().all(|c| c.is_whitespace() || c == '<') {
                                        rest_start +=
                                            ws_len + tail_pos + BROKEN_DELIMITER_TAIL.len();
                                    }
                                }
                            }
                            *buffer = buffer[rest_start..].to_string();
                            return Some(Ok(card_content));
                        }
                    }
                }
                _ => {}
            }
            i += 1;
        }

        // 既无完整 JSON 也无分隔符：等待后续 chunk，仅做无界增长兜底
        Self::check_buffer_hard_limit(buffer)
    }

    /// 缓冲区硬上限检查：超限时判为截断并清空（仅防无界增长的最后防线）
    fn check_buffer_hard_limit(buffer: &mut String) -> Option<Result<String, String>> {
        if buffer.len() > Self::CARD_BUFFER_HARD_LIMIT {
            warn!(
                "[ANKI_CARD_DEBUG] 卡片缓冲超过硬上限 {} 字节（当前 {} 字节）仍未出现分隔符，判为异常截断",
                Self::CARD_BUFFER_HARD_LIMIT,
                buffer.len()
            );
            let truncated = buffer.clone();
            buffer.clear();
            Some(Err(truncated))
        } else {
            None
        }
    }

    /// 若内容是结构化 wrapper（`{"cards": [...]}`），展开为逐卡 payload；
    /// 否则原样返回单元素列表。解析失败时先尝试一次轻量 JSON 修复。
    ///
    /// wrapper 只能经**有损修复**（字符串中途截断补引号）才解析成功时，
    /// 截断只可能发生在输入末尾，因此除最后一张卡外其余卡均完整；
    /// 最后一张卡标记 `truncated = true`，调用方必须落错误卡，
    /// 不得静默升级为正常卡（0824 评审 #3）。
    fn expand_wrapper_payloads(&self, raw: &str) -> Vec<ResidualCardPayload> {
        let intact = |json: String| ResidualCardPayload {
            json,
            truncated: false,
        };
        if !raw.contains('{') {
            return vec![intact(raw.to_string())];
        }
        let cleaned = self.clean_json_string(raw);
        let (parsed, lossy) = match serde_json::from_str::<Value>(&cleaned) {
            Ok(value) => (Some(value), false),
            Err(_) => match anki_protocol::repair_json_detailed(&cleaned) {
                Some(repair) => (
                    serde_json::from_str::<Value>(&repair.text).ok(),
                    repair.truncated_string,
                ),
                None => (None, false),
            },
        };
        if let Some(value) = parsed {
            if let Some(cards) = anki_protocol::unwrap_cards_array(&value) {
                info!(
                    "[ANKI_PROTOCOL] 收尾残留为结构化 wrapper，展开为 {} 个卡片 payload{}",
                    cards.len(),
                    if lossy {
                        "（最后一张受字符串截断影响，将落错误卡）"
                    } else {
                        ""
                    }
                );
                let last_index = cards.len().saturating_sub(1);
                return cards
                    .iter()
                    .enumerate()
                    .map(|(index, card)| ResidualCardPayload {
                        json: card.to_string(),
                        truncated: lossy && index == last_index,
                    })
                    .collect();
            }
        }
        vec![intact(raw.to_string())]
    }

    /// 解析并保存卡片 - 支持动态字段提取规则
    ///
    /// `document_id` 用于文档级重复/近重复指纹检测（Round 4 #3）：
    /// 同一文档的所有 segment task 经 `anki_qa_lint::observe_document_card`
    /// 共享同一个 FingerprintTracker，检测结果只打 flag 不丢卡。
    async fn parse_and_save_card(
        &self,
        card_json: &str,
        task_id: &str,
        document_id: &str,
        options: &AnkiGenerationOptions,
        qa_pass_enabled: bool,
        occlusion_fields: Option<&crate::anki_image_occlusion::OcclusionCardFields>,
    ) -> Result<Option<AnkiCard>, AppError> {
        // 纯包装 token 残片按不可读内容丢弃，不再落为错误卡并进入重试循环。
        // 完整卡片 JSON 的外层包装可剥离，正文 token 则由保守清理原样保留。
        let stripped = strip_model_special_tokens(card_json);
        if stripped.trim().is_empty() {
            return Err(AppError::validation(format!(
                "{}: 残片仅含模型特殊token，已丢弃",
                UNREADABLE_FRAGMENT_MSG
            )));
        }

        // 清理JSON字符串
        let cleaned_json = self.clean_json_string(&stripped);

        // 解析JSON：serde 失败后只做**无损**轻量修复（去尾逗号/截外围垃圾/
        // 补已闭合字符串后的缺失括号）。字符串中途截断属有损形态：修复产物
        // 内容已丢失，必须降级为错误卡，绝不静默升级为正常卡（0824 评审 #3）。
        let json_value: Value = match serde_json::from_str(&cleaned_json) {
            Ok(value) => value,
            Err(e) => match anki_protocol::repair_json_detailed(&cleaned_json) {
                Some(repair) if repair.truncated_string => {
                    error!("[ANKI_PARSE_ERROR] JSON在字符串中途截断，拒绝有损修复入库");
                    error!("[ANKI_PARSE_ERROR] 错误信息: {}", e);
                    error!("[ANKI_PARSE_ERROR] 原始内容: {}", card_json);
                    return Err(AppError::validation(format!(
                        "JSON在字符串中途截断（{}），残缺内容: {}",
                        e, cleaned_json
                    )));
                }
                Some(repair) => match serde_json::from_str::<Value>(&repair.text) {
                    Ok(repaired_value) => {
                        warn!(
                            "[ANKI_JSON_REPAIR] serde 解析失败（{}），无损修复后成功解析",
                            e
                        );
                        repaired_value
                    }
                    Err(_) => {
                        error!("[ANKI_PARSE_ERROR] JSON解析失败（修复产物不可解析）");
                        error!("[ANKI_PARSE_ERROR] 错误信息: {}", e);
                        error!("[ANKI_PARSE_ERROR] 原始内容: {}", card_json);
                        error!("[ANKI_PARSE_ERROR] 清理后内容: {}", cleaned_json);
                        return Err(AppError::validation(format!("JSON解析失败: {}", e)));
                    }
                },
                None => {
                    error!("[ANKI_PARSE_ERROR] JSON解析失败");
                    error!("[ANKI_PARSE_ERROR] 错误信息: {}", e);
                    error!("[ANKI_PARSE_ERROR] 原始内容: {}", card_json);
                    error!("[ANKI_PARSE_ERROR] 清理后内容: {}", cleaned_json);
                    return Err(AppError::validation(format!("JSON解析失败: {}", e)));
                }
            },
        };

        // 多模板判定：与 build_prompt 共用 anki_protocol::is_multi_template
        let multi_template = anki_protocol::is_multi_template(options);

        let raw_template_id_from_card = self.extract_template_id(&json_value);
        let template_id_from_card = resolve_template_id_candidate(
            raw_template_id_from_card.clone(),
            options.template_descriptions.as_deref(),
            options.template_ids.as_deref(),
            options.template_fields_by_id.as_ref(),
        );
        if let Some(raw_id) = raw_template_id_from_card.as_ref() {
            match template_id_from_card.as_ref() {
                Some(resolved_id) if resolved_id != raw_id => {
                    info!(
                        "[ANKI_TEMPLATE_RESOLVE] template_id normalized: raw='{}' -> resolved='{}'",
                        raw_id, resolved_id
                    );
                }
                None => {
                    warn!(
                        "[ANKI_TEMPLATE_RESOLVE] Unknown template_id from model: '{}' ({})",
                        raw_id,
                        format_template_identifier_help(options)
                    );
                }
                _ => {}
            }
        }
        let resolved_template_id = if multi_template {
            template_id_from_card
        } else {
            template_id_from_card.or_else(|| {
                options.template_id.clone().or_else(|| {
                    options.template_ids.as_ref().and_then(|ids| {
                        if ids.len() == 1 {
                            Some(ids[0].clone())
                        } else {
                            None
                        }
                    })
                })
            })
        };

        if multi_template && resolved_template_id.is_none() {
            return Err(AppError::validation(
                format!(
                    "卡片缺少或无法识别 template_id，无法在多模板场景解析字段。请确保每个卡片JSON包含 template_id 且值为模板ID（不是名称）。{}",
                    format_template_identifier_help(options)
                ),
            ));
        }
        if multi_template && options.field_extraction_rules_by_id.is_none() {
            return Err(AppError::validation(
                "多模板解析失败：缺少按模板分组的 field_extraction_rules_by_id。".to_string(),
            ));
        }
        if multi_template && options.template_fields_by_id.is_none() {
            return Err(AppError::validation(
                "多模板解析失败：缺少按模板分组的 template_fields_by_id。".to_string(),
            ));
        }

        let resolved_template_fields = match &options.template_fields_by_id {
            Some(fields_by_id) => {
                let template_id = resolved_template_id.as_deref().ok_or_else(|| {
                    AppError::validation("多模板解析失败：缺少 template_id".to_string())
                })?;
                Some(fields_by_id.get(template_id).cloned().ok_or_else(|| {
                    AppError::validation(format!(
                        "模板字段缺失：未找到模板 {} 的 template_fields。{}",
                        template_id,
                        format_template_identifier_help(options)
                    ))
                })?)
            }
            None => options.template_fields.clone(),
        };

        let resolved_rules = match &options.field_extraction_rules_by_id {
            Some(rules_by_id) => {
                let template_id = resolved_template_id.as_deref().ok_or_else(|| {
                    AppError::validation("多模板解析失败：缺少 template_id".to_string())
                })?;
                rules_by_id.get(template_id).ok_or_else(|| {
                    AppError::validation(format!(
                        "字段提取规则缺失：未找到模板 {} 的 field_extraction_rules。{}",
                        template_id,
                        format_template_identifier_help(options)
                    ))
                })?
            }
            None => options.field_extraction_rules.as_ref().ok_or_else(|| {
                AppError::validation(
                    "字段提取规则缺失：前端未传递 field_extraction_rules，无法解析AI生成的卡片JSON。\
                    请确保模板配置正确且前端已传递字段提取规则。"
                        .to_string(),
                )
            })?,
        };

        // 动态字段提取：必须使用模板字段提取规则，不再有兜底逻辑
        let (front, back, tags, extra_fields) =
            self.extract_fields_with_rules(&json_value, resolved_rules, &resolved_template_fields)?;

        // 清理所有字段中的模板占位符
        let cleaned_front = self.clean_template_placeholders(&front);
        let cleaned_back = self.clean_template_placeholders(&back);
        let mut cleaned_tags: Vec<String> = tags
            .iter()
            .map(|tag| self.clean_template_placeholders(tag))
            .filter(|tag| !tag.is_empty())
            .collect();
        let mut cleaned_extra_fields: std::collections::HashMap<String, String> = extra_fields
            .iter()
            .map(|(k, v)| (k.clone(), self.clean_template_placeholders(v)))
            .collect();

        // Cloze 模板兼容：若模板声明 Text 字段但当前缺失，则尝试补齐
        let needs_text_field = resolved_template_fields
            .as_ref()
            .map(|fields| fields.iter().any(|f| f.eq_ignore_ascii_case("text")))
            .unwrap_or(false);
        if needs_text_field && !cleaned_extra_fields.contains_key("text") {
            if let Some(raw) = json_value
                .get("text")
                .or_else(|| json_value.get("Text"))
                .and_then(|v| v.as_str())
            {
                cleaned_extra_fields
                    .insert("text".to_string(), self.clean_template_placeholders(raw));
            } else if cleaned_front.contains("{{c") {
                cleaned_extra_fields.insert("text".to_string(), cleaned_front.clone());
            } else if cleaned_back.contains("{{c") {
                cleaned_extra_fields.insert("text".to_string(), cleaned_back.clone());
            }
        }

        // VlmFull 的 IMAGE_DESC 草稿只补机器字段、识别 tag 与缺失的 text 草稿，
        // 不改写模型生成的 front/back，也不覆盖模型/模板已产出的非空 text
        // （未来 grounding 路径直接产出的字段同理不被覆盖）。
        if let Some(fields) = occlusion_fields {
            for (key, value) in &fields.extra_fields {
                cleaned_extra_fields
                    .entry(key.clone())
                    .or_insert_with(|| value.clone());
            }
            for tag in &fields.tags {
                if !cleaned_tags.iter().any(|existing| existing == tag) {
                    cleaned_tags.push(tag.clone());
                }
            }
            // 遮挡草稿 text（`<img src>` + cloze）仅在模型未产出非空 text 时
            // 补入，使入库卡直接携带可复习的遮挡正文。
            let has_model_text = cleaned_extra_fields
                .get("text")
                .is_some_and(|t| !t.trim().is_empty());
            if !has_model_text && !fields.text.trim().is_empty() {
                cleaned_extra_fields.insert("text".to_string(), fields.text.clone());
            }
        }

        // Round 3 #3：确定性质检 lint（零 LLM 成本，规则见 anki_qa_lint 模块文档）。
        // 默认 Flag 级别只标记不丢卡；merge_flags 保留 extract_fields_with_rules
        // 已写入 _qa_flags 的字段规则违规条目并按 (code, field) 去重。
        // extra_fields 含 _qa_flags 时，流式循环既有逻辑自动累计 StreamStats::flagged_cards。
        let lint_input = crate::anki_qa_lint::CardLintInput {
            front: &cleaned_front,
            back: &cleaned_back,
            text: cleaned_extra_fields.get("text").map(String::as_str),
            tags: &cleaned_tags,
            extra_fields: &cleaned_extra_fields,
        };
        let mut lint_issues = crate::anki_qa_lint::lint_card(
            &lint_input,
            &crate::anki_qa_lint::LintConfig::default(),
        );
        // Round 4 #3：文档级重复/近重复指纹检测。key 与 lint_card_with_tracker
        // 同语义（cloze 卡优先 Text 字段）；observe_document_card 内部吞掉所有
        // 锁异常且永不返回错误——检测失败最坏结果是少打一个 flag，
        // 卡片入库路径完全不受影响（duplicate_in_document / near_duplicate 均为
        // Warn 级，只 flag 不丢卡；DB 唯一索引仍是精确重复的最终防线）。
        lint_issues.extend(crate::anki_qa_lint::observe_document_card(
            document_id,
            crate::anki_qa_lint::duplicate_key_source(&lint_input),
        ));
        crate::anki_qa_lint::merge_flags(&mut cleaned_extra_fields, &lint_issues);

        // enable_qa_pass=false 时校验仍照常执行，但字段规则与 lint 的 QA 留痕均不落盘。
        // 必须在 merge_flags 之后移除，避免 lint 将 _qa_flags 写回。
        if !qa_pass_enabled {
            cleaned_extra_fields.remove(QA_FLAGS_FIELD);
        }

        // 首次入库时固化生成原文，供后续用户编辑后挖掘 grounded critic 修正对。
        // entry-once helper 不覆盖模板/用户已有值；超限或序列化失败仅少一份快照，
        // 绝不能阻断卡片主路径。
        let original_text = cleaned_extra_fields.get("text").cloned();
        if let Err(error) = crate::anki_gold_set::insert_original_generation_once(
            &mut cleaned_extra_fields,
            &cleaned_front,
            &cleaned_back,
            original_text.as_deref(),
        ) {
            warn!(
                "[ANKI_ORIGINAL_GENERATION] 跳过任务 {} 的原始快照，不影响卡片入库: {}",
                task_id, error
            );
        }

        // 遮挡卡把 `_occlusion.imageRef` 写入 images，供渲染/导出侧定位媒体。
        // helper 内部过滤 `vlm://` 占位引用（r2 契约 §2.1，与导出两侧降级一致）。
        // 该构造点此前恒为空列表；保持「已有 images 不追加覆盖」的合并语义，
        // 未来上游若已填充 images 则原样保留。
        let mut images: Vec<String> = Vec::new();
        if images.is_empty() {
            if let Some(image_ref) =
                crate::anki_image_occlusion::occlusion_image_ref_from_fields(&cleaned_extra_fields)
            {
                images.push(image_ref);
            }
        }

        // 创建卡片
        let now = Utc::now().to_rfc3339();
        let card = AnkiCard {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.to_string(),
            front: cleaned_front,
            back: cleaned_back,
            text: cleaned_extra_fields.get("text").cloned(), // 从清理后的extra_fields中提取text字段
            tags: cleaned_tags,
            images,
            is_error_card: false,
            error_content: None,
            created_at: now.clone(),
            updated_at: now,
            extra_fields: cleaned_extra_fields,
            template_id: resolved_template_id,
        };

        // 保存到数据库（DB 唯一索引保证原子去重）
        let inserted = self
            .db
            .insert_anki_card(&card)
            .map_err(|e| AppError::database(format!("保存卡片失败: {}", e)))?;
        if !inserted {
            let preview = card
                .text
                .as_ref()
                .unwrap_or(&card.front)
                .chars()
                .take(80)
                .collect::<String>();
            warn!("[DOC-LEVEL] 发现重复卡片，跳过保存: {}", preview);
            return Ok(None);
        }

        Ok(Some(card))
    }

    /// 清理JSON字符串（保留所有Unicode字符）
    ///
    /// 目的：
    /// - 去除外围Markdown代码块围栏与BOM
    /// - 尽量截取出最外层的JSON对象文本
    /// - 不再做任何“字符白名单”过滤，避免误删日语假名、韩文、拉丁扩展等
    fn clean_json_string(&self, json_str: &str) -> String {
        let mut s = json_str.trim();

        // 移除Markdown代码块标记
        if s.starts_with("```json") {
            s = &s[7..];
        }
        if s.starts_with("```") {
            s = &s[3..];
        }
        if s.ends_with("```") {
            s = &s[..s.len() - 3];
        }

        // 移除可能的BOM标记
        s = s.trim_start_matches('\u{FEFF}');

        // 尝试定位首个 '{' 与最后一个 '}'，以截出JSON对象
        let trimmed = s.trim();
        if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
            if end > start {
                let candidate = &trimmed[start..=end];
                // 仅当截取结果自身配平时才截取（去除尾部自然语言垃圾）；
                // 截断输入的最后一个 '}' 只是内层闭合，截取会让 repair 丢失尾部卡片。
                if json_fragment_balanced(candidate) {
                    return candidate.to_string();
                }
            }
        }

        // 回退：返回简单去围栏/去BOM后的字符串
        trimmed.to_string()
    }

    // 注意：不要在 impl 块中定义测试模块，避免语法冲突

    /// 清理模板占位符
    fn clean_template_placeholders(&self, content: &str) -> String {
        let mut cleaned = content.to_string();

        // 移除各种可能的占位符
        cleaned = cleaned.replace("{{.}}", "");
        cleaned = cleaned.replace("{{/}}", "");
        cleaned = cleaned.replace("{{#}}", "");
        cleaned = cleaned.replace("{{}}", "");

        // 移除空的Mustache标签 {{}}
        while cleaned.contains("{{}}") {
            cleaned = cleaned.replace("{{}}", "");
        }

        // 移除可能的空白标签
        cleaned = cleaned.replace("{{  }}", "");
        cleaned = cleaned.replace("{{ }}", "");

        // 清理多余的空白和换行
        cleaned.trim().to_string()
    }

    /// 使用模板字段提取规则动态解析字段
    fn extract_fields_with_rules(
        &self,
        json_value: &Value,
        rules: &std::collections::HashMap<String, FieldExtractionRule>,
        template_fields: &Option<Vec<String>>,
    ) -> Result<
        (
            String,
            String,
            Vec<String>,
            std::collections::HashMap<String, String>,
        ),
        AppError,
    > {
        let mut front = String::new();
        let mut back = String::new();
        let mut tags = Vec::new();
        let mut extra_fields = std::collections::HashMap::new();
        // 校验违规汇总：不毙卡，最终写入 extra_fields[QA_FLAGS_FIELD]
        let mut qa_flags: Vec<Value> = Vec::new();

        // 遍历所有定义的字段规则（稳定顺序，避免 text 覆盖 front/back）
        let mut ordered_rules: Vec<(&String, &FieldExtractionRule)> = rules.iter().collect();
        ordered_rules.sort_by(|(a, _), (b, _)| {
            let a_lower = a.to_lowercase();
            let b_lower = b.to_lowercase();
            let a_priority = match a_lower.as_str() {
                "text" => 0,
                "front" => 1,
                "back" => 2,
                "tags" => 3,
                _ => 4,
            };
            let b_priority = match b_lower.as_str() {
                "text" => 0,
                "front" => 1,
                "back" => 2,
                "tags" => 3,
                _ => 4,
            };
            a_priority
                .cmp(&b_priority)
                .then_with(|| a_lower.cmp(&b_lower))
        });
        for (field_name, rule) in ordered_rules {
            let field_value = self.extract_field_value(json_value, field_name);
            let field_name_lower = field_name.to_lowercase();

            match (field_value, rule.is_required) {
                (Some(value), _) => {
                    // 字段存在，根据类型和字段名称处理
                    match field_name_lower.as_str() {
                        "front" => {
                            let processed_value =
                                self.process_field_value(&value, &rule.field_type)?;
                            qa_flags.extend(validate_field_against_rule(
                                field_name,
                                &processed_value,
                                rule,
                            ));
                            front = processed_value.clone();
                            // 对于使用模板的卡片，也将Front字段存储到extra_fields中
                            extra_fields.insert("front".to_string(), processed_value);
                        }
                        "back" => {
                            let processed_value =
                                self.process_field_value(&value, &rule.field_type)?;
                            qa_flags.extend(validate_field_against_rule(
                                field_name,
                                &processed_value,
                                rule,
                            ));
                            back = processed_value;
                        }
                        "tags" => {
                            tags = self.process_tags_field(&value, &rule.field_type)?;
                            // 标签逐项校验（allowed_values/长度约束按单个标签生效）
                            for tag in &tags {
                                qa_flags.extend(validate_field_against_rule(field_name, tag, rule));
                            }
                        }
                        "explanation" => {
                            // 选择题的答案需要组合多个字段
                            let explanation_text =
                                self.process_field_value(&value, &rule.field_type)?;
                            qa_flags.extend(validate_field_against_rule(
                                field_name,
                                &explanation_text,
                                rule,
                            ));
                            // 先保存explanation，稍后组合完整答案
                            extra_fields.insert("explanation".to_string(), explanation_text);
                        }
                        // 填空题模板字段映射
                        "text" => {
                            // 对于填空题，Text字段应该保存到extra_fields中，用于Cloze模板
                            let processed_value =
                                self.process_field_value(&value, &rule.field_type)?;
                            qa_flags.extend(validate_field_against_rule(
                                field_name,
                                &processed_value,
                                rule,
                            ));
                            extra_fields.insert("text".to_string(), processed_value.clone());
                            // 同时设置front字段以确保基础验证通过
                            if front.is_empty() {
                                front = processed_value.clone();
                            }
                            if back.is_empty() {
                                back = format!("填空题：{}", processed_value); // 为back字段提供有意义的内容
                            }
                        }
                        _ => {
                            // 扩展字段
                            let processed_value =
                                self.process_field_value(&value, &rule.field_type)?;
                            qa_flags.extend(validate_field_against_rule(
                                field_name,
                                &processed_value,
                                rule,
                            ));
                            extra_fields.insert(field_name_lower.clone(), processed_value);
                        }
                    }
                }
                (None, true) => {
                    // 必需字段缺失
                    if let Some(default) = &rule.default_value {
                        match field_name_lower.as_str() {
                            "front" => {
                                if front.is_empty() {
                                    front = default.clone();
                                }
                            }
                            "back" => {
                                if back.is_empty() {
                                    back = default.clone();
                                }
                            }
                            "tags" => tags = serde_json::from_str(default).unwrap_or_default(),
                            _ => {
                                extra_fields.insert(field_name_lower.clone(), default.clone());
                            }
                        }
                    } else {
                        return Err(AppError::validation(format!(
                            "缺少必需字段: {}",
                            field_name
                        )));
                    }
                }
                (None, false) => {
                    // 可选字段缺失，使用默认值
                    if let Some(default) = &rule.default_value {
                        match field_name_lower.as_str() {
                            "front" => {
                                if front.is_empty() {
                                    front = default.clone();
                                }
                            }
                            "back" => {
                                if back.is_empty() {
                                    back = default.clone();
                                }
                            }
                            "tags" => tags = serde_json::from_str(default).unwrap_or_default(),
                            _ => {
                                extra_fields.insert(field_name_lower.clone(), default.clone());
                            }
                        }
                    }
                    // 如果没有默认值，就不设置该字段
                }
            }
        }

        // 特殊处理选择题模板的back字段组合
        if extra_fields.contains_key("optiona") {
            // 这是选择题模板，需要组合答案
            let mut choice_back = String::new();

            // 添加选项
            if let Some(option_a) = extra_fields.get("optiona") {
                choice_back.push_str(&format!("A. {}\n", option_a));
            }
            if let Some(option_b) = extra_fields.get("optionb") {
                choice_back.push_str(&format!("B. {}\n", option_b));
            }
            if let Some(option_c) = extra_fields.get("optionc") {
                choice_back.push_str(&format!("C. {}\n", option_c));
            }
            if let Some(option_d) = extra_fields.get("optiond") {
                choice_back.push_str(&format!("D. {}\n", option_d));
            }

            // 添加正确答案
            if let Some(correct) = extra_fields.get("correct") {
                choice_back.push_str(&format!("\n正确答案：{}\n", correct));
            }

            // 添加解析
            if let Some(explanation) = extra_fields.get("explanation") {
                choice_back.push_str(&format!("\n解析：{}", explanation));
            }

            back = choice_back;
        }

        // 如果front/back仍为空，再次尝试通用回退逻辑
        if front.is_empty() {
            if let Some(title) = json_value.get("Title").and_then(|v| v.as_str()) {
                front = title.to_string();
            } else if let Some(question) = json_value.get("question").and_then(|v| v.as_str()) {
                front = question.to_string();
            }
        }

        if back.is_empty() {
            if let Some(overview) = json_value.get("Overview").and_then(|v| v.as_str()) {
                back = overview.to_string();
            }
            // 新增回退：Interpretation
            else if let Some(interp) = json_value.get("Interpretation").and_then(|v| v.as_str()) {
                back = interp.to_string();
            }
            // 新增回退：Content
            else if let Some(content) = json_value.get("Content").and_then(|v| v.as_str()) {
                back = content.to_string();
            }
            // 新增回退：Law
            else if let Some(law) = json_value.get("Law").and_then(|v| v.as_str()) {
                back = law.to_string();
            }
        }

        // 新增动态映射：使用模板定义字段顺序来设置 front/back
        if front.is_empty() {
            if let Some(fields) = template_fields {
                if let Some(first) = fields.first() {
                    if let Some(val) = extra_fields.get(&first.to_lowercase()) {
                        front = val.clone();
                    }
                }
            }
        }
        if back.is_empty() {
            if let Some(fields) = template_fields {
                if let Some(second) = fields.get(1) {
                    if let Some(val) = extra_fields.get(&second.to_lowercase()) {
                        back = val.clone();
                    }
                }
            }
        }

        // 最终兜底：提取首个可读文本，而不是把整段 JSON 塞进 front（旧行为会
        // 让用户直接看到原始 JSON 噪声）。完全没有可读文本的残片返回哨兵错误，
        // 由流式循环丢弃并记录 warning，不降级为错误卡。
        if front.is_empty() {
            if let Some(readable) = extract_readable_text(json_value) {
                warn!(
                    "[ANKI_PARSE_WARN] front 字段缺失，回退为首个可读文本（{} 字符）",
                    readable.chars().count()
                );
                front = readable;
            } else {
                return Err(AppError::validation(format!(
                    "{}: 残片不含任何可读文本字段，已丢弃",
                    UNREADABLE_FRAGMENT_MSG
                )));
            }
        }

        if back.is_empty() {
            // 尝试为选择题自动生成back内容
            // 支持顶层和 fields 嵌套对象两种结构
            let fields_obj = json_value.get("fields").and_then(|v| v.as_object());

            // 辅助函数：从顶层或 fields 对象中获取字段值
            let get_field = |key: &str| -> Option<&str> {
                json_value
                    .get(key)
                    .and_then(|v| v.as_str())
                    .or_else(|| fields_obj.and_then(|f| f.get(key).and_then(|v| v.as_str())))
            };

            if get_field("optiona").is_some() {
                let mut choice_back = String::new();

                // 添加选项并保存到extra_fields
                if let Some(option_a) = get_field("optiona") {
                    choice_back.push_str(&format!("A. {}\n", option_a));
                    extra_fields.insert("optiona".to_string(), option_a.to_string());
                }
                if let Some(option_b) = get_field("optionb") {
                    choice_back.push_str(&format!("B. {}\n", option_b));
                    extra_fields.insert("optionb".to_string(), option_b.to_string());
                }
                if let Some(option_c) = get_field("optionc") {
                    choice_back.push_str(&format!("C. {}\n", option_c));
                    extra_fields.insert("optionc".to_string(), option_c.to_string());
                }
                if let Some(option_d) = get_field("optiond") {
                    choice_back.push_str(&format!("D. {}\n", option_d));
                    extra_fields.insert("optiond".to_string(), option_d.to_string());
                }

                // 添加正确答案并保存到extra_fields
                if let Some(correct) = get_field("correct") {
                    choice_back.push_str(&format!("\n正确答案：{}\n", correct));
                    extra_fields.insert("correct".to_string(), correct.to_string());
                }

                // 添加解析并保存到extra_fields
                if let Some(explanation) = get_field("explanation") {
                    choice_back.push_str(&format!("\n解析：{}", explanation));
                    extra_fields.insert("explanation".to_string(), explanation.to_string());
                }

                back = choice_back;
            } else {
                // 兜底：从 extra_fields 中取第一个非 front 的非空值作为 back
                // 注意排除 QA_FLAGS_FIELD：校验标记是元数据，不能被拼进 back 正文
                let skip_keys: std::collections::HashSet<&str> = [
                    "front",
                    "tags",
                    "template_id",
                    "templateid",
                    "text",
                    QA_FLAGS_FIELD,
                ]
                .iter()
                .copied()
                .collect();
                let mut fallback_back = String::new();
                for (key, value) in &extra_fields {
                    if skip_keys.contains(key.as_str())
                        || value.trim().is_empty()
                        || value == &front
                    {
                        continue;
                    }
                    if !fallback_back.is_empty() {
                        fallback_back.push_str("\n\n");
                    }
                    fallback_back.push_str(value);
                }
                if fallback_back.is_empty() {
                    // 最终兜底：从原始 JSON 中收集所有非 front 的字符串值
                    if let Some(obj) = json_value.as_object() {
                        for (key, value) in obj {
                            let key_lower = key.to_lowercase();
                            if matches!(
                                key_lower.as_str(),
                                "front" | "tags" | "template_id" | "templateid" | "fields"
                            ) {
                                continue;
                            }
                            if let Some(s) = value.as_str() {
                                if !s.trim().is_empty() && s != front {
                                    if !fallback_back.is_empty() {
                                        fallback_back.push_str("\n\n");
                                    }
                                    fallback_back.push_str(s);
                                }
                            }
                        }
                    }
                }
                if fallback_back.is_empty() {
                    return Err(AppError::validation("back字段不能为空".to_string()));
                }
                back = fallback_back;
            }
        }

        // 校验违规不毙卡：汇总为 JSON 数组字符串写入 extra_fields 留痕，
        // 由流式循环据此累计 StreamStats::flagged_cards
        if !qa_flags.is_empty() {
            warn!(
                "[QA_FLAGS] 卡片字段校验发现 {} 项违规（仅标记，不丢弃）: {}",
                qa_flags.len(),
                serde_json::Value::Array(qa_flags.clone()).to_string()
            );
            extra_fields.insert(
                QA_FLAGS_FIELD.to_string(),
                Value::Array(qa_flags).to_string(),
            );
        }

        Ok((front, back, tags, extra_fields))
    }

    /// 从JSON中提取 template_id（兼容 camelCase）
    fn extract_template_id(&self, json_value: &Value) -> Option<String> {
        for key in ["template_id", "templateId"] {
            if let Some(value) = self.extract_field_value(json_value, key) {
                if let Some(s) = value.as_str() {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                } else if value.is_number() {
                    return Some(value.to_string());
                }
            }
        }
        None
    }

    /// 从JSON中提取字段值（支持大小写不敏感）
    ///
    /// 查找顺序：
    /// 1. 顶层精确匹配
    /// 2. 顶层大小写不敏感匹配
    /// 3. `fields` 嵌套对象中精确匹配
    /// 4. `fields` 嵌套对象中大小写不敏感匹配
    fn extract_field_value(&self, json_value: &Value, field_name: &str) -> Option<Value> {
        let obj = json_value.as_object()?;
        let field_lower = field_name.to_lowercase();

        // 1. 顶层精确匹配
        if let Some(value) = obj.get(field_name) {
            return Some(value.clone());
        }

        // 2. 顶层大小写不敏感匹配
        for (key, value) in obj {
            if key.to_lowercase() == field_lower {
                return Some(value.clone());
            }
        }

        // 3. 从 `fields` 嵌套对象中查找（支持 LLM 生成的嵌套结构）
        if let Some(fields_obj) = obj.get("fields").and_then(|v| v.as_object()) {
            // 精确匹配
            if let Some(value) = fields_obj.get(field_name) {
                return Some(value.clone());
            }
            // 大小写不敏感匹配
            for (key, value) in fields_obj {
                if key.to_lowercase() == field_lower {
                    return Some(value.clone());
                }
            }
        }

        None
    }

    /// 根据字段类型处理字段值
    fn process_field_value(
        &self,
        value: &Value,
        field_type: &FieldType,
    ) -> Result<String, AppError> {
        match field_type {
            FieldType::Text => {
                if let Some(s) = value.as_str() {
                    Ok(s.to_string())
                } else {
                    // 如果不是字符串，尝试序列化为字符串
                    Ok(value.to_string().trim_matches('"').to_string())
                }
            }
            FieldType::Array => {
                if let Some(arr) = value.as_array() {
                    // 如果是字符串数组，保持为JSON数组格式
                    if arr.iter().all(|v| v.is_string()) {
                        // 序列化为JSON字符串，保持数组格式
                        return serde_json::to_string(&arr)
                            .map_err(|e| AppError::validation(format!("无法序列化数组: {}", e)));
                    }

                    // 对象数组 -> 格式化为 Markdown 列表
                    let mut formatted = String::new();
                    for (idx, item) in arr.iter().enumerate() {
                        if let Some(obj) = item.as_object() {
                            let order = obj
                                .get("order")
                                .and_then(|v| v.as_i64())
                                .unwrap_or((idx + 1) as i64);
                            let action = obj.get("action").and_then(|v| v.as_str()).unwrap_or("");
                            formatted.push_str(&format!("{}. {}\n", order, action));

                            if let Some(details) = obj.get("details").and_then(|v| v.as_str()) {
                                formatted.push_str(&format!("    - {}\n", details));
                            }
                            if let Some(code) = obj.get("code").and_then(|v| v.as_str()) {
                                formatted.push_str(&format!("```\n{}\n```\n", code));
                            }
                            if let Some(warning) = obj.get("warning").and_then(|v| v.as_str()) {
                                formatted.push_str(&format!("❗ {}\n", warning));
                            }
                        } else {
                            formatted.push_str(&item.to_string());
                        }
                    }
                    return Ok(formatted.trim().to_string());
                }
                Ok(value.to_string())
            }
            FieldType::Number => {
                if let Some(n) = value.as_f64() {
                    Ok(n.to_string())
                } else if let Some(s) = value.as_str() {
                    Ok(s.to_string())
                } else {
                    Ok(value.to_string().trim_matches('"').to_string())
                }
            }
            FieldType::Boolean => {
                if let Some(b) = value.as_bool() {
                    Ok(b.to_string())
                } else if let Some(s) = value.as_str() {
                    Ok(s.to_string())
                } else {
                    Ok(value.to_string().trim_matches('"').to_string())
                }
            }

            FieldType::Date => {
                // 日期类型：保持字符串格式或转换为ISO格式
                if let Some(s) = value.as_str() {
                    Ok(s.to_string())
                } else {
                    Ok(value.to_string().trim_matches('"').to_string())
                }
            }
            FieldType::RichText => {
                // 富文本：支持Markdown/HTML内容
                if let Some(s) = value.as_str() {
                    Ok(s.to_string())
                } else if value.is_object() {
                    // 如果是对象格式（如 {format: "markdown", content: "..."}）
                    Ok(serde_json::to_string(value).unwrap_or_else(|_| "".to_string()))
                } else {
                    Ok(value.to_string().trim_matches('"').to_string())
                }
            }
            FieldType::Formula => {
                // 数学公式：LaTeX格式
                if let Some(s) = value.as_str() {
                    Ok(s.to_string())
                } else {
                    Ok(value.to_string().trim_matches('"').to_string())
                }
            }
        }
    }

    /// 处理tags字段
    fn process_tags_field(
        &self,
        value: &Value,
        field_type: &FieldType,
    ) -> Result<Vec<String>, AppError> {
        match field_type {
            FieldType::Array => {
                if let Some(arr) = value.as_array() {
                    Ok(arr
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect())
                } else if let Some(s) = value.as_str() {
                    // 尝试解析逗号分隔的字符串
                    Ok(s.split(',')
                        .map(|tag| tag.trim().to_string())
                        .filter(|tag| !tag.is_empty())
                        .collect())
                } else {
                    Ok(vec![])
                }
            }
            FieldType::Text => {
                if let Some(s) = value.as_str() {
                    Ok(s.split(',')
                        .map(|tag| tag.trim().to_string())
                        .filter(|tag| !tag.is_empty())
                        .collect())
                } else {
                    Ok(vec![])
                }
            }
            _ => Ok(vec![]),
        }
    }

    /// 回退的旧式字段提取逻辑（兼容性）
    fn extract_fields_legacy(
        &self,
        json_value: &Value,
    ) -> Result<
        (
            String,
            String,
            Vec<String>,
            std::collections::HashMap<String, String>,
        ),
        AppError,
    > {
        // 🔧 调试：打印原始 JSON 内容
        debug!("[ANKI_PARSE_DEBUG] 原始 JSON: {}", json_value);

        // 提取必需字段 (支持大小写不敏感)
        // 允许模板无 Front 字段，回退到 Title/title/question
        let front = json_value["front"]
            .as_str()
            .or_else(|| json_value["Front"].as_str())
            .or_else(|| json_value["Title"].as_str())
            .or_else(|| json_value["title"].as_str())
            .or_else(|| json_value["question"].as_str())
            .or_else(|| json_value["Question"].as_str())
            .unwrap_or("")
            .to_string();

        // 🔧 调试：打印提取的 front
        debug!("[ANKI_PARSE_DEBUG] 提取的 front: '{}'", front);

        let mut back = json_value["back"]
            .as_str()
            .or_else(|| json_value["Back"].as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();

        // 如果没有back字段，检查是否为选择题模板，自动生成back内容
        // 🔧 大小写兼容：支持 optiona/OptionA/optionA 等多种格式
        let option_a = json_value["optiona"]
            .as_str()
            .or_else(|| json_value["OptionA"].as_str())
            .or_else(|| json_value["optionA"].as_str())
            .or_else(|| json_value["option_a"].as_str());

        if back.is_empty() && option_a.is_some() {
            let mut choice_back = String::new();

            // 添加选项（支持多种大小写格式）
            if let Some(opt) = option_a {
                choice_back.push_str(&format!("A. {}\n", opt));
            }
            if let Some(opt) = json_value["optionb"]
                .as_str()
                .or_else(|| json_value["OptionB"].as_str())
                .or_else(|| json_value["optionB"].as_str())
                .or_else(|| json_value["option_b"].as_str())
            {
                choice_back.push_str(&format!("B. {}\n", opt));
            }
            if let Some(opt) = json_value["optionc"]
                .as_str()
                .or_else(|| json_value["OptionC"].as_str())
                .or_else(|| json_value["optionC"].as_str())
                .or_else(|| json_value["option_c"].as_str())
            {
                choice_back.push_str(&format!("C. {}\n", opt));
            }
            if let Some(opt) = json_value["optiond"]
                .as_str()
                .or_else(|| json_value["OptionD"].as_str())
                .or_else(|| json_value["optionD"].as_str())
                .or_else(|| json_value["option_d"].as_str())
            {
                choice_back.push_str(&format!("D. {}\n", opt));
            }

            // 添加正确答案（支持多种大小写格式）
            if let Some(correct) = json_value["correct"]
                .as_str()
                .or_else(|| json_value["Correct"].as_str())
                .or_else(|| json_value["answer"].as_str())
                .or_else(|| json_value["Answer"].as_str())
            {
                choice_back.push_str(&format!("\n正确答案：{}\n", correct));
            }

            // 添加解析（支持多种大小写格式）
            if let Some(explanation) = json_value["explanation"]
                .as_str()
                .or_else(|| json_value["Explanation"].as_str())
                .or_else(|| json_value["analysis"].as_str())
                .or_else(|| json_value["Analysis"].as_str())
            {
                choice_back.push_str(&format!("\n解析：{}", explanation));
            }

            back = choice_back;
        }

        // 若 back 为空，则尝试使用 Overview 作为背面内容
        if back.is_empty() {
            back = json_value["Overview"]
                .as_str()
                .or_else(|| json_value["overview"].as_str())
                .map(|s| s.to_string())
                .unwrap_or_default();
        }

        // 🔧 P1 修复 #5: 移除危险的 JSON 回退逻辑，防止信息泄露
        // 原问题：back 为空时将整个 JSON 序列化为字符串，可能泄露 API 密钥等敏感信息
        // 新方案：使用占位符并记录警告
        if back.is_empty() {
            warn!(
                "[ANKI_PARSE_WARN] 卡片缺少 back/Back/Overview 字段，使用占位符。JSON keys: {:?}",
                json_value.as_object().map(|o| o.keys().collect::<Vec<_>>())
            );
            back = "[卡片内容生成中，请检查 LLM 输出格式]".to_string();
        }

        let tags = json_value["tags"]
            .as_array()
            .or_else(|| json_value["Tags"].as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        // 提取扩展字段
        let mut extra_fields = std::collections::HashMap::new();
        if let Some(obj) = json_value.as_object() {
            for (key, value) in obj {
                // 跳过基础字段 (大小写不敏感)
                let key_lower = key.to_lowercase();
                if !matches!(key_lower.as_str(), "front" | "back" | "tags" | "images") {
                    if let Some(str_value) = value.as_str() {
                        // 将字段名转换为统一的小写格式存储
                        extra_fields.insert(key_lower, str_value.to_string());
                    } else if let Some(arr_value) = value.as_array() {
                        // 将数组转换为字符串
                        let arr_str = arr_value
                            .iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(", ");
                        extra_fields.insert(key_lower, arr_str);
                    } else {
                        // 其他类型转换为字符串
                        extra_fields.insert(key_lower, value.to_string());
                    }
                }
            }
        }

        Ok((front, back, tags, extra_fields))
    }

    /// 创建错误卡片
    async fn create_error_card(
        &self,
        error_content: &str,
        task_id: &str,
    ) -> Result<AnkiCard, AppError> {
        let now = Utc::now().to_rfc3339();
        let card = AnkiCard {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.to_string(),
            front: "内容可能被截断或AI输出不完整".to_string(),
            back: "请检查以下原始片段并手动创建或编辑卡片。".to_string(),
            text: None, // 错误卡片不需要text字段
            tags: vec!["错误".to_string(), "截断".to_string()],
            images: Vec::new(),
            is_error_card: true,
            error_content: Some(error_content.to_string()),
            created_at: now.clone(),
            updated_at: now,
            extra_fields: std::collections::HashMap::new(),
            template_id: None,
        };

        // 保存到数据库
        let inserted = self
            .db
            .insert_anki_card(&card)
            .map_err(|e| AppError::database(format!("保存错误卡片失败: {}", e)))?;
        if !inserted {
            warn!("错误卡片已存在，跳过保存: {}", card.id);
        }

        Ok(card)
    }

    /// 更新任务状态
    async fn update_task_status(
        &self,
        task_id: &str,
        status: TaskStatus,
        error_message: Option<String>,
        segment_index: Option<u32>, // 新增参数
        document_id: Option<&str>,
        window: &Window,
    ) -> Result<(), AppError> {
        self.db
            .update_document_task_status(task_id, status.clone(), error_message.clone())
            .map_err(|e| AppError::database(format!("更新任务状态失败: {}", e)))?;

        // 发送状态更新事件
        // 🔧 CardForge 2.0 修复：直接发射 StreamedCardPayload，不包装在 StreamEvent 中
        let payload = StreamedCardPayload::TaskStatusUpdate {
            task_id: task_id.to_string(),
            status,
            message: error_message,
            segment_index, // 包含 segment_index
            document_id: document_id.map(|id| id.to_string()),
        };

        if let Err(e) = window.emit("anki_generation_event", &payload) {
            error!("发送任务状态更新事件失败: {}", e);
        }

        Ok(())
    }

    /// 发送新卡片事件
    async fn emit_new_card(&self, card: AnkiCard, document_id: &str, window: &Window) {
        // 🔧 CardForge 2.0 修复：直接发射 StreamedCardPayload
        let payload = StreamedCardPayload::NewCard {
            card,
            document_id: document_id.to_string(),
        };

        if let Err(e) = window.emit("anki_generation_event", &payload) {
            error!("发送新卡片事件失败: {}", e);
        }
    }

    /// 发送错误卡片事件
    async fn emit_error_card(&self, card: AnkiCard, document_id: &str, window: &Window) {
        // 🔧 CardForge 2.0 修复：直接发射 StreamedCardPayload
        let payload = StreamedCardPayload::NewErrorCard {
            card,
            document_id: document_id.to_string(),
        };

        if let Err(e) = window.emit("anki_generation_event", &payload) {
            error!("发送错误卡片事件失败: {}", e);
        }
    }

    /// 发送生成质量统计事件（纯新增：外部标签 `GenerationStats`，
    /// 前端按 key 匹配已知事件，未识别的标签会被安全忽略，不破坏既有契约）
    fn emit_generation_stats(
        &self,
        task_id: &str,
        document_id: &str,
        stats: &StreamStats,
        window: &Window,
    ) {
        let payload = json!({
            "GenerationStats": {
                "task_id": task_id,
                "document_id": document_id,
                "cards_generated": stats.card_count,
                "failed_cards": stats.failed_cards,
                "duplicate_cards": stats.duplicate_cards,
                "dropped_fragments": stats.dropped_fragments,
                "flagged_cards": stats.flagged_cards,
            }
        });
        if let Err(e) = window.emit("anki_generation_event", &payload) {
            error!("发送生成统计事件失败: {}", e);
        }
    }

    /// 发送 critic pass 摘要事件（纯新增：外部标签 `CriticSummary`，旧版前端安全忽略）。
    /// 仅在 critic 启用（opt-in）且任务收尾成功时派发，见 Round 4 #2。
    /// 载荷 = CriticSummary 全字段序列化 + task_id/document_id（见
    /// [`build_critic_summary_event`]，不再手抄字段清单）。
    fn emit_critic_summary(
        &self,
        task_id: &str,
        document_id: &str,
        summary: &crate::anki_critic::CriticSummary,
        window: &Window,
    ) {
        let payload = build_critic_summary_event(task_id, document_id, summary);
        if let Err(e) = window.emit("anki_generation_event", &payload) {
            error!("发送 critic 摘要事件失败: {}", e);
        }
    }

    /// 发送生成过程警告事件（纯新增：外部标签 `GenerationWarning`，旧版前端安全忽略）。
    /// 用于"丢弃不可读残片"等不值得生成错误卡、但需要留痕的情况。
    fn emit_generation_warning(
        &self,
        task_id: &str,
        document_id: &str,
        reason: &str,
        fragment: &str,
        window: &Window,
    ) {
        // 只携带截断后的预览，避免把超长原始输出灌进事件总线
        let preview: String = fragment.chars().take(200).collect();
        let payload = json!({
            "GenerationWarning": {
                "task_id": task_id,
                "document_id": document_id,
                "reason": reason,
                "fragment_preview": preview,
            }
        });
        if let Err(e) = window.emit("anki_generation_event", &payload) {
            error!("发送生成警告事件失败: {}", e);
        }
    }

    /// 成功完成任务
    async fn complete_task_successfully(
        &self,
        task_id: &str,
        stats: &StreamStats,
        document_id: &str,
        window: &Window,
    ) -> Result<(), AppError> {
        // For TaskCompleted, segment_index might be less critical if task_id is already real.
        // Passing None for now, as the primary use of segment_index is for the initial ID update.
        self.update_task_status(
            task_id,
            TaskStatus::Completed,
            None,
            None,
            Some(document_id),
            window,
        )
        .await?;

        // 发送任务完成事件。基底仍是 StreamedCardPayload::TaskCompleted 的
        // 序列化结果（旧字段 wire 格式不变），叠加质量统计与
        // completed_with_warnings（"带警告完成"，见 build_task_completed_event）。
        let payload = build_task_completed_event(task_id, document_id, stats);
        if let Err(e) = window.emit("anki_generation_event", &payload) {
            error!("发送任务完成事件失败: {}", e);
        }

        Ok(())
    }

    /// 处理任务错误
    async fn handle_task_error(
        &self,
        task_id: &str,
        error: &AppError,
        window: &Window,
        segment_index: Option<u32>,
        document_id: Option<&str>,
    ) -> Result<(), AppError> {
        let error_message = error.message.clone();
        let final_status = if error_message.contains(ERR_KEYWORD_TIMEOUT)
            || error_message.contains(ERR_KEYWORD_TRUNCATED)
        {
            TaskStatus::Truncated
        } else {
            TaskStatus::Failed
        };

        // 状态写库失败（如任务已被删除）时不吞掉错误事件：
        // 记录 DB 失败原因，但仍向前端派发 TaskProcessingError，避免前端永远等不到终态。
        if let Err(db_err) = self
            .update_task_status(
                task_id,
                final_status.clone(),
                Some(error_message.clone()),
                segment_index,
                document_id,
                window,
            )
            .await
        {
            error!(
                "写入任务失败状态到数据库失败（仍将派发错误事件）: task={}, db_err={}",
                task_id, db_err.message
            );
        }

        // 发送错误事件
        // 🔧 CardForge 2.0 修复：直接发射 StreamedCardPayload
        let payload = StreamedCardPayload::TaskProcessingError {
            task_id: task_id.to_string(),
            error_message,
            document_id: document_id.map(|id| id.to_string()),
        };

        if let Err(e) = window.emit("anki_generation_event", &payload) {
            error!("发送任务错误事件失败: {}", e);
        }

        Ok(())
    }

    /// 取消当前流式制卡（用于硬暂停）
    pub async fn cancel_streaming(&self, task_id: String) -> Result<(), String> {
        let mut senders = CANCEL_SENDERS.lock().await;
        if let Some(tx) = senders.remove(&task_id) {
            let _ = tx.send(true);
            Ok(())
        } else {
            Err(format!("任务 {} 未在运行状态", task_id))
        }
    }

    /// abort 兜底后清理可能残留的取消通道（避免 CANCEL_SENDERS 泄漏）
    pub async fn clear_cancel_sender(&self, task_id: &str) {
        CANCEL_SENDERS.lock().await.remove(task_id);
    }

    /// 查询任务是否已注册取消通道（即流式请求已在运行）。
    /// 供调度层做防重入检查，避免同一任务被并发触发两次。
    pub async fn is_streaming(&self, task_id: &str) -> bool {
        CANCEL_SENDERS.lock().await.contains_key(task_id)
    }

    /// 基于当前文档内的失败/截断任务与错误卡片，构建一个“统一重试”任务并插入到该文档中。
    /// 返回 Some(DocumentTask) 表示已构建重试任务；返回 None 表示无需重试。
    pub async fn build_retry_task_for_document(
        &self,
        document_id: &str,
    ) -> Result<Option<crate::models::DocumentTask>, AppError> {
        // 获取该文档的全部任务
        let tasks = self
            .db
            .get_tasks_for_document(document_id)
            .map_err(|e| AppError::database(format!("获取文档任务失败: {}", e)))?;
        if tasks.is_empty() {
            return Ok(None);
        }

        if tasks.iter().any(|t| {
            (t.status == TaskStatus::Pending || t.status == TaskStatus::Processing)
                && t.content_segment.contains("错误卡修复")
        }) {
            warn!("🛈 已存在等待中的错误卡修复任务，跳过重复创建");
            return Ok(None);
        }

        // 读取该文档下的“错误卡片”
        let mut error_cards: Vec<crate::models::AnkiCard> = Vec::new();
        if let Ok(cards) = self.db.get_cards_for_document(document_id) {
            for c in cards.into_iter() {
                if c.is_error_card {
                    if let Some(ec) = &c.error_content {
                        // 纯模型包装 token 无实质内容，喂回模型只会形成错误卡循环。
                        if !ec.starts_with(RETRY_ASSIGNMENT_MARK) && error_content_is_repairable(ec)
                        {
                            error_cards.push(c);
                        } else if !ec.starts_with(RETRY_ASSIGNMENT_MARK) {
                            warn!(
                                "跳过不可修复的错误卡（无实质内容，疑似模型特殊token泄漏）: card_id={}",
                                c.id
                            );
                        }
                    }
                }
            }
        }

        if error_cards.is_empty() {
            return Ok(None);
        }

        // 继承文档元信息
        let Some(first) = tasks.first() else {
            return Ok(None);
        };
        let new_index: u32 = tasks.iter().map(|t| t.segment_index).max().unwrap_or(0) + 1;

        // 构建“错误卡修复”任务内容：直接携带 error_content，逐段修复
        let mut aggregated = String::new();
        aggregated.push_str(
            "你将收到若干条‘错误卡片的原始输出片段’（例如被截断/不完整/被安全策略阻断的内容）。\n",
        );
        aggregated.push_str("请逐条修复并补全为有效的 Anki 卡片JSON。\n");
        aggregated.push_str(&format!(
            "严格要求：\n- 对每条 ==FIX== 段，输出1个或多个完整卡片JSON\n- 每个卡片JSON输出后紧跟分隔符 {}\n- 不输出任何额外解释或Markdown，只输出JSON与分隔符\n\n",
            anki_protocol::CARD_DELIMITER
        ));
        let mut idx = 1usize;
        for ec in &error_cards {
            aggregated.push_str(&format!(
                "==FIX {} | 源任务ID:{} | 错误卡ID:{} ==\n",
                idx, ec.task_id, ec.id
            ));
            aggregated.push_str(ec.error_content.as_deref().unwrap_or(""));
            aggregated.push_str("\n\n");
            idx += 1;
        }

        let now = chrono::Utc::now().to_rfc3339();
        let retry_task = crate::models::DocumentTask {
            id: uuid::Uuid::new_v4().to_string(),
            document_id: first.document_id.clone(),
            original_document_name: format!("{} - 错误卡修复", first.original_document_name),
            segment_index: new_index,
            content_segment: aggregated,
            status: crate::models::TaskStatus::Pending,
            created_at: now.clone(),
            updated_at: now,
            error_message: None,
            anki_generation_options_json: first.anki_generation_options_json.clone(),
        };

        self.db
            .insert_document_task(&retry_task)
            .map_err(|e| AppError::database(format!("插入重试任务失败: {}", e)))?;

        for card in error_cards.iter_mut() {
            if let Some(content) = card.error_content.clone() {
                if !content.starts_with(RETRY_ASSIGNMENT_MARK) {
                    card.error_content = Some(format!("{}\n{}", RETRY_ASSIGNMENT_MARK, content));
                    if let Err(e) = self.db.update_anki_card(card) {
                        error!("标记错误卡片为待修复失败: {}", e);
                    }
                }
            }
        }

        Ok(Some(retry_task))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_template(id: &str, name: &str) -> TemplateDescription {
        TemplateDescription {
            id: id.to_string(),
            name: name.to_string(),
            description: "desc".to_string(),
            fields: vec!["front".to_string(), "back".to_string()],
            generation_prompt: None,
        }
    }

    #[test]
    fn resolve_template_id_accepts_exact_id() {
        let templates = vec![
            make_template("design-lab", "01. The Lab Pro (学术选择题增强版)"),
            make_template("design-glass", "07. The Glass (学术填空题)"),
        ];

        let resolved = resolve_template_id_candidate(
            Some("design-lab".to_string()),
            Some(&templates),
            None,
            None,
        );

        assert_eq!(resolved.as_deref(), Some("design-lab"));
    }

    #[test]
    fn resolve_template_id_accepts_template_name() {
        let templates = vec![make_template(
            "design-lab",
            "01. The Lab Pro (学术选择题增强版)",
        )];

        let resolved = resolve_template_id_candidate(
            Some("01. The Lab Pro (学术选择题增强版)".to_string()),
            Some(&templates),
            None,
            None,
        );

        assert_eq!(resolved.as_deref(), Some("design-lab"));
    }

    #[test]
    fn resolve_template_id_accepts_normalized_name() {
        let templates = vec![make_template(
            "design-lab",
            "01. The Lab Pro (学术选择题增强版)",
        )];

        let resolved = resolve_template_id_candidate(
            Some("01 The   Lab Pro 学术选择题增强版".to_string()),
            Some(&templates),
            None,
            None,
        );

        assert_eq!(resolved.as_deref(), Some("design-lab"));
    }

    #[test]
    fn resolve_template_id_rejects_unknown_value() {
        let templates = vec![make_template(
            "design-lab",
            "01. The Lab Pro (学术选择题增强版)",
        )];

        let resolved = resolve_template_id_candidate(
            Some("not-exist-template".to_string()),
            Some(&templates),
            None,
            None,
        );

        assert!(resolved.is_none());
    }

    #[test]
    fn resolve_template_id_rejects_ambiguous_name() {
        let templates = vec![
            make_template("design-lab-v1", "01. The Lab Pro"),
            make_template("design-lab-v2", "01. The Lab Pro"),
        ];

        let resolved = resolve_template_id_candidate(
            Some("01. The Lab Pro".to_string()),
            Some(&templates),
            None,
            None,
        );

        assert!(resolved.is_none());
    }

    fn make_rule(
        is_required: bool,
        field_type: FieldType,
        description: &str,
    ) -> FieldExtractionRule {
        FieldExtractionRule {
            field_type,
            is_required,
            default_value: None,
            validation_pattern: None,
            description: description.to_string(),
            validation: None,
            transform: None,
            schema: None,
            item_schema: None,
            display_format: None,
            ai_hint: None,
            max_length: None,
            min_length: None,
            allowed_values: None,
            depends_on: None,
            compute_function: None,
        }
    }

    #[test]
    fn extract_readable_text_prefers_top_level_string() {
        let value = json!({
            "tags": ["a", "b"],
            "template_id": "design-lab",
            "question": "什么是牛顿第一定律？",
            "answer": "惯性定律"
        });
        // serde_json 对象按插入序遍历（preserve_order 未启用时按字母序），
        // 无论哪种顺序，结果都必须是可读文本而非 tags/template_id
        let text = extract_readable_text(&value).expect("should find readable text");
        assert!(text == "什么是牛顿第一定律？" || text == "惯性定律");
    }

    #[test]
    fn extract_readable_text_falls_back_to_nested_fields() {
        let value = json!({
            "template_id": "design-lab",
            "fields": { "Question": "  嵌套问题  " }
        });
        assert_eq!(extract_readable_text(&value).as_deref(), Some("嵌套问题"));
    }

    #[test]
    fn extract_readable_text_returns_none_for_unreadable_fragment() {
        let value = json!({
            "tags": ["only", "tags"],
            "template_id": "design-lab",
            "count": 42
        });
        assert!(extract_readable_text(&value).is_none());
        assert!(extract_readable_text(&json!("not an object")).is_none());
    }

    #[test]
    fn describe_prompt_field_honors_is_required_flag() {
        let required_rule = make_rule(true, FieldType::Text, "解析说明");
        let described = describe_prompt_field("explanation", Some(&required_rule));
        assert!(
            described.contains("必填"),
            "required rule must say 必填: {described}"
        );
        assert!(described.contains("解析说明"));

        let optional_rule = make_rule(false, FieldType::Text, "");
        let described = describe_prompt_field("notes", Some(&optional_rule));
        assert!(
            described.contains("可选"),
            "optional rule must say 可选: {described}"
        );
        // 空描述回退到内置文案
        assert!(described.contains("补充注释"));
    }

    #[test]
    fn describe_prompt_field_defaults_without_rule() {
        assert!(describe_prompt_field("front", None).contains("必填"));
        assert!(describe_prompt_field("back", None).contains("必填"));
        let tags = describe_prompt_field("tags", None);
        assert!(tags.contains("可选"));
        assert!(tags.contains("字符串数组"));
        assert!(describe_prompt_field("custom_field", None).contains("可选"));
    }

    #[test]
    fn describe_prompt_field_reports_array_type_from_rule() {
        let rule = make_rule(true, FieldType::Array, "步骤列表");
        let described = describe_prompt_field("steps", Some(&rule));
        assert!(described.contains("字符串数组"));
        assert!(described.contains("必填"));
    }

    #[test]
    fn find_rule_matches_case_insensitively() {
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert(
            "Front".to_string(),
            make_rule(true, FieldType::Text, "正面"),
        );

        assert!(find_rule(Some(&rules), "Front").is_some());
        assert!(find_rule(Some(&rules), "front").is_some());
        assert!(find_rule(Some(&rules), "FRONT").is_some());
        assert!(find_rule(Some(&rules), "back").is_none());
        assert!(find_rule(None, "front").is_none());
    }

    // ===== issue #58 / PR #187 回归：包装 token 不得落错误卡或误删正文 =====

    #[test]
    fn strip_model_special_tokens_removes_box_wrapper() {
        let input = "<|begin_of_box|>{\"front\":\"Q\",\"back\":\"A\"}<|end_of_box|>";
        assert_eq!(
            strip_model_special_tokens(input),
            "{\"front\":\"Q\",\"back\":\"A\"}"
        );
    }

    #[test]
    fn strip_model_special_tokens_yields_empty_for_pure_token_fragment() {
        assert!(strip_model_special_tokens("<|end_of_box|>")
            .trim()
            .is_empty());
        assert!(strip_model_special_tokens("\n <|end_of_box|> \n")
            .trim()
            .is_empty());
        assert!(strip_model_special_tokens("<|im_end|><|endoftext|>")
            .trim()
            .is_empty());
    }

    #[test]
    fn strip_model_special_tokens_keeps_non_whitelisted_content() {
        let input = "{\"front\":\"何为 <|自定义|> 标记？\"}";
        assert_eq!(strip_model_special_tokens(input), input);
    }

    #[test]
    fn strip_model_special_tokens_preserves_literal_tokens_in_card_body() {
        let input =
            "{\"front\":\"<|im_end|> 是什么？\",\"back\":\"它是模型协议的字面量 <|endoftext|>。\"}";
        assert_eq!(strip_model_special_tokens(input), input);

        let wrapped = format!("<|begin_of_box|>{input}<|end_of_box|>");
        assert_eq!(strip_model_special_tokens(&wrapped), input);

        let truncated = "{\"front\":\"正文以字面量 <|im_end|>";
        assert_eq!(strip_model_special_tokens(truncated), truncated);
    }

    #[test]
    fn error_content_is_repairable_rejects_pure_special_token() {
        assert!(!error_content_is_repairable("<|end_of_box|>"));
        assert!(!error_content_is_repairable("  \n<|end_of_box|>\n  "));
        assert!(!error_content_is_repairable(""));
        assert!(!error_content_is_repairable("   "));
    }

    #[test]
    fn error_content_is_repairable_accepts_truncated_card_fragment() {
        assert!(error_content_is_repairable("{\"front\": \"什么是流式解析"));
        assert!(error_content_is_repairable(
            "<|begin_of_box|>{\"front\": \"未闭合的卡片"
        ));
    }

    // ==================== 解析内环测试包（Round 2 #8） ====================
    //
    // clean_json_string / clean_template_placeholders / extract_fields_with_rules /
    // extract_card_from_buffer 都是 &self 方法但不读取任何字段，
    // 因此用最小依赖构造一个真实服务实例（临时目录 + 空 settings 表），
    // 与 llm_manager::tests::create_test_llm_manager 的做法一致。
    fn make_test_service() -> (StreamingAnkiService, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("test.db");
        {
            let conn = rusqlite::Connection::open(&db_path).expect("open test db");
            conn.execute(
                "CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )",
                [],
            )
            .expect("create settings table");
        }
        let db = Arc::new(Database::new(&db_path).expect("create test database"));
        let file_manager = Arc::new(
            crate::file_manager::FileManager::new(dir.path().to_path_buf())
                .expect("create file manager"),
        );
        let llm = Arc::new(LLMManager::new(db.clone(), file_manager).expect("create llm manager"));
        (StreamingAnkiService::new(db, llm), dir)
    }

    /// 需要真实 Anki 入库的测试必须先走生产 Mistakes 迁移；`Database::new`
    /// 只开连接、不建表，不能复用上面的纯解析轻量 fixture。
    fn make_persisted_test_service() -> (StreamingAnkiService, tempfile::TempDir) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let dir = tempfile::tempdir().expect("tempdir");
        let mut coordinator =
            MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("mistakes migrations");
        let db = Arc::new(
            Database::new(&dir.path().join("mistakes.db")).expect("create migrated test database"),
        );
        let file_manager = Arc::new(
            crate::file_manager::FileManager::new(dir.path().to_path_buf())
                .expect("create file manager"),
        );
        let llm = Arc::new(LLMManager::new(db.clone(), file_manager).expect("create llm manager"));
        (StreamingAnkiService::new(db, llm), dir)
    }

    fn make_rule_with_default(
        is_required: bool,
        field_type: FieldType,
        default_value: Option<&str>,
    ) -> FieldExtractionRule {
        let mut rule = make_rule(is_required, field_type, "desc");
        rule.default_value = default_value.map(|s| s.to_string());
        rule
    }

    // -------------------- clean_json_string --------------------

    #[test]
    fn clean_json_string_strips_json_fence() {
        let (svc, _dir) = make_test_service();
        let raw = "```json\n{\"front\":\"问题\",\"back\":\"答案\"}\n```";
        let cleaned = svc.clean_json_string(raw);
        assert_eq!(cleaned, "{\"front\":\"问题\",\"back\":\"答案\"}");
        // 清理结果必须是合法 JSON
        assert!(serde_json::from_str::<Value>(&cleaned).is_ok());
    }

    #[test]
    fn clean_json_string_strips_plain_fence() {
        let (svc, _dir) = make_test_service();
        let raw = "```\n{\"a\": 1}\n```";
        assert_eq!(svc.clean_json_string(raw), "{\"a\": 1}");
    }

    #[test]
    fn clean_json_string_strips_bom_prefix() {
        let (svc, _dir) = make_test_service();
        let raw = "\u{FEFF}{\"a\":1}";
        assert_eq!(svc.clean_json_string(raw), "{\"a\":1}");
    }

    #[test]
    fn clean_json_string_extracts_object_from_surrounding_noise() {
        let (svc, _dir) = make_test_service();
        let raw = "好的，以下是生成的卡片：\n{\"front\":\"Q\",\"back\":\"A\"}\n希望对你有帮助";
        assert_eq!(
            svc.clean_json_string(raw),
            "{\"front\":\"Q\",\"back\":\"A\"}"
        );
    }

    #[test]
    fn clean_json_string_preserves_unicode_content() {
        let (svc, _dir) = make_test_service();
        // 日语假名/韩文不能被"字符白名单"式清理误删
        let raw = "```json\n{\"front\":\"ひらがな カタカナ 한국어\"}\n```";
        let cleaned = svc.clean_json_string(raw);
        let value: Value = serde_json::from_str(&cleaned).expect("valid json");
        assert_eq!(
            value.get("front").and_then(|v| v.as_str()),
            Some("ひらがな カタカナ 한국어")
        );
    }

    #[test]
    fn clean_json_string_falls_back_when_no_object() {
        let (svc, _dir) = make_test_service();
        assert_eq!(
            svc.clean_json_string("  not json at all  "),
            "not json at all"
        );
    }

    // -------------------- extract_fields_with_rules --------------------

    #[test]
    fn extract_fields_required_missing_without_default_is_validation_error() {
        let (svc, _dir) = make_test_service();
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert(
            "front".to_string(),
            make_rule(true, FieldType::Text, "正面"),
        );
        rules.insert("back".to_string(), make_rule(true, FieldType::Text, "背面"));

        let json_value = json!({ "front": "只有正面" });
        let err = svc
            .extract_fields_with_rules(&json_value, &rules, &None)
            .expect_err("missing required field must fail");
        // 该 Err 会在流式循环中降级为 error card（error_content 保留原文），
        // 单元层面只需确认错误信息指明缺失字段。
        let msg = err.to_string();
        assert!(msg.contains("缺少必需字段"), "unexpected error: {msg}");
        assert!(msg.contains("back"), "should name the missing field: {msg}");
    }

    #[test]
    fn extract_fields_required_missing_uses_default_value() {
        let (svc, _dir) = make_test_service();
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert(
            "front".to_string(),
            make_rule(true, FieldType::Text, "正面"),
        );
        rules.insert(
            "back".to_string(),
            make_rule_with_default(true, FieldType::Text, Some("默认背面")),
        );

        let json_value = json!({ "front": "问题" });
        let (front, back, _tags, _extra) = svc
            .extract_fields_with_rules(&json_value, &rules, &None)
            .expect("default value must rescue missing required field");
        assert_eq!(front, "问题");
        assert_eq!(back, "默认背面");
    }

    #[test]
    fn extract_fields_happy_path_with_tags_and_extra_fields() {
        let (svc, _dir) = make_test_service();
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert(
            "front".to_string(),
            make_rule(true, FieldType::Text, "正面"),
        );
        rules.insert("back".to_string(), make_rule(true, FieldType::Text, "背面"));
        rules.insert(
            "tags".to_string(),
            make_rule(false, FieldType::Array, "标签"),
        );
        rules.insert(
            "note".to_string(),
            make_rule(false, FieldType::Text, "备注"),
        );

        let json_value = json!({
            "front": "什么是惯性？",
            "back": "物体保持运动状态的性质",
            "tags": ["物理", "力学"],
            "note": "补充说明"
        });
        let (front, back, tags, extra) = svc
            .extract_fields_with_rules(&json_value, &rules, &None)
            .expect("all fields present");
        assert_eq!(front, "什么是惯性？");
        assert_eq!(back, "物体保持运动状态的性质");
        assert_eq!(tags, vec!["物理".to_string(), "力学".to_string()]);
        assert_eq!(extra.get("note").map(String::as_str), Some("补充说明"));
        // front 同时写入 extra_fields，供模板渲染使用
        assert_eq!(extra.get("front").map(String::as_str), Some("什么是惯性？"));
    }

    #[test]
    fn extract_fields_reads_nested_fields_object_case_insensitively() {
        let (svc, _dir) = make_test_service();
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert(
            "front".to_string(),
            make_rule(true, FieldType::Text, "正面"),
        );
        rules.insert("back".to_string(), make_rule(true, FieldType::Text, "背面"));

        // LLM 常见输出：字段嵌套在 fields 对象里且大小写不一致
        let json_value = json!({
            "template_id": "design-lab",
            "fields": { "Front": "嵌套问题", "Back": "嵌套答案" }
        });
        let (front, back, _tags, _extra) = svc
            .extract_fields_with_rules(&json_value, &rules, &None)
            .expect("nested fields must be found");
        assert_eq!(front, "嵌套问题");
        assert_eq!(back, "嵌套答案");
    }

    #[test]
    fn extract_fields_text_field_maps_to_cloze_front_back() {
        let (svc, _dir) = make_test_service();
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert(
            "text".to_string(),
            make_rule(true, FieldType::Text, "填空文本"),
        );

        let json_value = json!({ "Text": "水的沸点是{{c1::100}}摄氏度" });
        let (front, back, _tags, extra) = svc
            .extract_fields_with_rules(&json_value, &rules, &None)
            .expect("text field maps to front/back");
        assert_eq!(
            extra.get("text").map(String::as_str),
            Some("水的沸点是{{c1::100}}摄氏度")
        );
        assert_eq!(front, "水的沸点是{{c1::100}}摄氏度");
        assert!(
            back.starts_with("填空题："),
            "back must be non-empty: {back}"
        );
    }

    // -------------------- clean_template_placeholders --------------------

    #[test]
    fn clean_template_placeholders_removes_empty_mustache_tags() {
        let (svc, _dir) = make_test_service();
        let raw = "  前缀{{.}}中间{{/}}再{{#}}然后{{}}空格{{ }}双空格{{  }}尾部  ";
        assert_eq!(
            svc.clean_template_placeholders(raw),
            "前缀中间再然后空格双空格尾部"
        );
    }

    #[test]
    fn clean_template_placeholders_preserves_named_tags_and_cloze() {
        let (svc, _dir) = make_test_service();
        let raw = "{{Front}} 与 {{c1::答案}} 应原样保留";
        assert_eq!(
            svc.clean_template_placeholders(raw),
            "{{Front}} 与 {{c1::答案}} 应原样保留"
        );
    }

    // -------------------- buffer 分隔符切分与硬上限 --------------------

    #[test]
    fn extract_card_standard_delimiter_splits_buffer() {
        let (svc, _dir) = make_test_service();
        let mut buffer =
            String::from("{\"front\":\"Q\"}<<<ANKI_CARD_JSON_END>>>{\"front\":\"下一张");
        let result = svc.extract_card_from_buffer(&mut buffer);
        assert_eq!(result, Some(Ok("{\"front\":\"Q\"}".to_string())));
        assert_eq!(buffer, "{\"front\":\"下一张");
        // 剩余部分不含分隔符且远未超限 → 继续等待
        assert_eq!(svc.extract_card_from_buffer(&mut buffer), None);
    }

    #[test]
    fn extract_card_repairs_corrupted_delimiter() {
        let (svc, _dir) = make_test_service();
        // 分隔符中间被塞入空格，标准匹配失败，走损坏分隔符修复分支
        let mut buffer = String::from("{\"a\":1}\n<<< ANKI_CARD_JSON_END>>>tail");
        let result = svc.extract_card_from_buffer(&mut buffer);
        assert_eq!(result, Some(Ok("{\"a\":1}".to_string())));
        assert_eq!(buffer, "tail");
    }

    #[test]
    fn extract_card_ignores_empty_segment_before_delimiter() {
        let (svc, _dir) = make_test_service();
        let mut buffer = String::from("  \n<<<ANKI_CARD_JSON_END>>>next");
        assert_eq!(svc.extract_card_from_buffer(&mut buffer), None);
        // 空段被消费掉，缓冲推进到分隔符之后
        assert_eq!(buffer, "next");
    }

    #[test]
    fn buffer_at_hard_limit_keeps_accumulating() {
        let (svc, _dir) = make_test_service();
        // 恰好等于上限（1_000_000 字节）不触发截断：判定条件是严格大于
        let mut buffer = "x".repeat(StreamingAnkiService::CARD_BUFFER_HARD_LIMIT);
        assert_eq!(svc.extract_card_from_buffer(&mut buffer), None);
        assert_eq!(buffer.len(), StreamingAnkiService::CARD_BUFFER_HARD_LIMIT);
    }

    #[test]
    fn buffer_over_hard_limit_truncates_and_clears() {
        let (svc, _dir) = make_test_service();
        let oversized = "x".repeat(StreamingAnkiService::CARD_BUFFER_HARD_LIMIT + 1);
        let mut buffer = oversized.clone();
        let result = svc.extract_card_from_buffer(&mut buffer);
        // 超限判为截断：原内容以 Err 返回（供降级为 error card），缓冲清空防无界增长
        assert_eq!(result, Some(Err(oversized)));
        assert!(buffer.is_empty());
    }

    #[test]
    fn buffer_hard_limit_is_far_above_legacy_threshold() {
        // P1-2 回归防护：旧实现 10000 字节阈值会腰斩合法长卡片，
        // 上限必须保持远大于单卡体积（中文学术卡约 3300 字即超旧阈值）
        assert!(StreamingAnkiService::CARD_BUFFER_HARD_LIMIT >= 1_000_000);
        let (svc, _dir) = make_test_service();
        // 一张 50KB 的"长卡片仍在传输中"不得被误判截断
        let mut buffer = "内容".repeat(10_000);
        assert_eq!(svc.extract_card_from_buffer(&mut buffer), None);
        assert!(!buffer.is_empty());
    }

    // ==================== 字段校验元数据执行（Round 2 #2） ====================
    //
    // min_length/max_length/allowed_values/validation_pattern 违规不毙卡，
    // 仅写入 extra_fields[QA_FLAGS_FIELD] 留痕。

    /// 从违规项中提取 rule 名便于断言
    fn violation_rules(violations: &[Value]) -> Vec<String> {
        violations
            .iter()
            .map(|v| v["rule"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[test]
    fn validate_field_passes_without_constraints() {
        let rule = make_rule(true, FieldType::Text, "无约束字段");
        assert!(validate_field_against_rule("front", "任意内容", &rule).is_empty());
    }

    #[test]
    fn validate_field_flags_min_length_by_unicode_chars() {
        let mut rule = make_rule(true, FieldType::Text, "正面");
        rule.min_length = Some(5);

        // "题目" = 2 个 Unicode 字符（6 字节）：必须按字符数而非字节数判定
        let violations = validate_field_against_rule("front", "题目", &rule);
        assert_eq!(violation_rules(&violations), vec!["min_length"]);
        assert!(violations[0]["message"]
            .as_str()
            .unwrap()
            .contains("长度 2 小于最小长度 5"));

        // 恰好 5 个字符则通过
        assert!(validate_field_against_rule("front", "五个字的题", &rule).is_empty());
    }

    #[test]
    fn validate_field_flags_max_length() {
        let mut rule = make_rule(true, FieldType::Text, "正面");
        rule.max_length = Some(3);

        let violations = validate_field_against_rule("front", "超过三个字", &rule);
        assert_eq!(violation_rules(&violations), vec!["max_length"]);
        assert!(validate_field_against_rule("front", "三个字", &rule).is_empty());
    }

    #[test]
    fn validate_field_flags_allowed_values() {
        let mut rule = make_rule(true, FieldType::Text, "正确选项");
        rule.allowed_values = Some(vec![json!("A"), json!("B"), json!(42)]);

        assert!(validate_field_against_rule("correct", "A", &rule).is_empty());
        // 非字符串允许值按其 JSON 文本比较
        assert!(validate_field_against_rule("correct", "42", &rule).is_empty());

        let violations = validate_field_against_rule("correct", "E", &rule);
        assert_eq!(violation_rules(&violations), vec!["allowed_values"]);
        assert_eq!(violations[0]["field"], "correct");

        // 空允许列表视为未配置，不应全量误报
        rule.allowed_values = Some(vec![]);
        assert!(validate_field_against_rule("correct", "任意", &rule).is_empty());
    }

    #[test]
    fn validate_field_flags_validation_pattern() {
        let mut rule = make_rule(true, FieldType::Text, "编号");
        rule.validation_pattern = Some(r"^\d{4}$".to_string());

        assert!(validate_field_against_rule("code", "2026", &rule).is_empty());
        let violations = validate_field_against_rule("code", "abc", &rule);
        assert_eq!(violation_rules(&violations), vec!["validation_pattern"]);
    }

    #[test]
    fn validate_field_skips_uncompilable_pattern() {
        let mut rule = make_rule(true, FieldType::Text, "编号");
        // 非法正则属于模板配置问题：跳过该项校验，不惩罚卡片
        rule.validation_pattern = Some("[unclosed".to_string());
        assert!(validate_field_against_rule("code", "whatever", &rule).is_empty());

        // 空白模式同样跳过
        rule.validation_pattern = Some("   ".to_string());
        assert!(validate_field_against_rule("code", "whatever", &rule).is_empty());
    }

    #[test]
    fn validate_field_accumulates_multiple_violations() {
        let mut rule = make_rule(true, FieldType::Text, "正面");
        rule.min_length = Some(10);
        rule.allowed_values = Some(vec![json!("固定答案")]);
        rule.validation_pattern = Some(r"^\d+$".to_string());

        let violations = validate_field_against_rule("front", "abc", &rule);
        assert_eq!(
            violation_rules(&violations),
            vec!["min_length", "allowed_values", "validation_pattern"]
        );
        // 每项都携带字段名与可读消息
        for v in &violations {
            assert_eq!(v["field"], "front");
            assert!(!v["message"].as_str().unwrap().is_empty());
        }
    }

    #[test]
    fn extract_fields_violations_flag_but_do_not_kill_card() {
        let (svc, _dir) = make_test_service();
        let mut front_rule = make_rule(true, FieldType::Text, "正面");
        front_rule.min_length = Some(20); // 故意设高，触发违规
        let mut correct_rule = make_rule(false, FieldType::Text, "正确选项");
        correct_rule.allowed_values = Some(vec![json!("A"), json!("B")]);
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert("front".to_string(), front_rule);
        rules.insert("back".to_string(), make_rule(true, FieldType::Text, "背面"));
        rules.insert("correct".to_string(), correct_rule);

        let json_value = json!({
            "front": "短问题",
            "back": "答案",
            "correct": "E"
        });
        let (front, back, _tags, extra) = svc
            .extract_fields_with_rules(&json_value, &rules, &None)
            .expect("violations must not kill the card");

        // 卡片内容原样保留
        assert_eq!(front, "短问题");
        assert_eq!(back, "答案");

        // 违规汇总写入 _qa_flags，且为可解析的 JSON 数组
        let flags_raw = extra
            .get(QA_FLAGS_FIELD)
            .expect("violations must be recorded in _qa_flags");
        let flags: Vec<Value> = serde_json::from_str(flags_raw).expect("flags must be valid JSON");
        let mut flagged: Vec<(String, String)> = flags
            .iter()
            .map(|f| {
                (
                    f["field"].as_str().unwrap_or_default().to_string(),
                    f["rule"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        flagged.sort();
        assert_eq!(
            flagged,
            vec![
                ("correct".to_string(), "allowed_values".to_string()),
                ("front".to_string(), "min_length".to_string()),
            ]
        );
    }

    #[test]
    fn extract_fields_compliant_card_has_no_qa_flags() {
        let (svc, _dir) = make_test_service();
        let mut front_rule = make_rule(true, FieldType::Text, "正面");
        front_rule.min_length = Some(2);
        front_rule.max_length = Some(50);
        front_rule.validation_pattern = Some("惯性".to_string());
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert("front".to_string(), front_rule);
        rules.insert("back".to_string(), make_rule(true, FieldType::Text, "背面"));

        let json_value = json!({ "front": "什么是惯性？", "back": "答案" });
        let (_front, _back, _tags, extra) = svc
            .extract_fields_with_rules(&json_value, &rules, &None)
            .expect("compliant card");
        assert!(
            !extra.contains_key(QA_FLAGS_FIELD),
            "compliant card must not carry _qa_flags"
        );
    }

    #[test]
    fn extract_fields_tags_validated_per_item() {
        let (svc, _dir) = make_test_service();
        let mut tags_rule = make_rule(false, FieldType::Array, "标签");
        tags_rule.max_length = Some(4);
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert(
            "front".to_string(),
            make_rule(true, FieldType::Text, "正面"),
        );
        rules.insert("back".to_string(), make_rule(true, FieldType::Text, "背面"));
        rules.insert("tags".to_string(), tags_rule);

        let json_value = json!({
            "front": "问题",
            "back": "答案",
            "tags": ["物理", "远超四个字符的超长标签"]
        });
        let (_front, _back, tags, extra) = svc
            .extract_fields_with_rules(&json_value, &rules, &None)
            .expect("tag violations must not kill the card");

        // 标签本身原样保留
        assert_eq!(tags.len(), 2);
        let flags: Vec<Value> =
            serde_json::from_str(extra.get(QA_FLAGS_FIELD).expect("flagged")).expect("valid JSON");
        assert_eq!(flags.len(), 1, "only the overlong tag is flagged");
        assert_eq!(flags[0]["field"], "tags");
        assert_eq!(flags[0]["rule"], "max_length");
    }

    #[test]
    fn qa_flags_never_leak_into_fallback_back() {
        let (svc, _dir) = make_test_service();
        // back 缺失且无默认值 → 走 extra_fields 兜底拼接分支；
        // _qa_flags 是元数据，绝不能被拼进 back 正文
        let mut note_rule = make_rule(false, FieldType::Text, "备注");
        note_rule.min_length = Some(50); // 触发违规
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert(
            "front".to_string(),
            make_rule(true, FieldType::Text, "正面"),
        );
        rules.insert("note".to_string(), note_rule);

        let json_value = json!({ "front": "问题", "note": "短备注" });
        let (_front, back, _tags, extra) = svc
            .extract_fields_with_rules(&json_value, &rules, &None)
            .expect("card survives");

        assert!(extra.contains_key(QA_FLAGS_FIELD));
        assert_eq!(back, "短备注", "back falls back to note content only");
        assert!(
            !back.contains("min_length"),
            "qa flags metadata must not leak into back: {back}"
        );
    }

    // ==================== brace-depth 切卡器（Round 2 #1） ====================
    //
    // 核心函数 extract_card_from_buffer_impl 不依赖 &self，直接测试状态机本身：
    // in_string / escape / brace_depth 三个状态位 + DELIMITER 辅助信号。

    // 与协议模块共用唯一常量定义（防止测试基于过期字面量给出假通过）
    const DELIM: &str = crate::anki_protocol::CARD_DELIMITER;

    fn extract(buffer: &mut String) -> Option<Result<String, String>> {
        StreamingAnkiService::extract_card_from_buffer_impl(buffer)
    }

    #[test]
    fn brace_cutter_waits_for_split_json_then_cuts_without_delimiter() {
        // 半包 JSON：卡片在 chunk 边界被截断，先等待；补齐后无需分隔符即切卡
        let mut buffer = String::from(r#"{"front": "什么是牛顿第一"#);
        assert!(extract(&mut buffer).is_none());
        assert_eq!(
            buffer, r#"{"front": "什么是牛顿第一"#,
            "半包时缓冲必须原样保留"
        );

        buffer.push_str(r#"定律？", "back": "惯性定律"}"#);
        let card = extract(&mut buffer)
            .expect("补齐后应切出卡片")
            .expect("应为 Ok");
        assert_eq!(
            card,
            r#"{"front": "什么是牛顿第一定律？", "back": "惯性定律"}"#
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn brace_cutter_waits_when_nested_object_not_closed() {
        // 半包变体：深度计数须覆盖嵌套对象，内层未闭合时不得提前切卡
        let mut buffer = String::from(r#"{"fields": {"Front": "嵌套问题""#);
        assert!(extract(&mut buffer).is_none());

        buffer.push_str(r#"}, "template_id": "design-lab"}"#);
        let card = extract(&mut buffer).unwrap().unwrap();
        assert_eq!(
            card,
            r#"{"fields": {"Front": "嵌套问题"}, "template_id": "design-lab"}"#
        );
        assert!(serde_json::from_str::<Value>(&card).is_ok());
    }

    #[test]
    fn brace_cutter_extracts_multiple_cards_from_one_chunk() {
        // 一个 chunk 内到达两张完整卡（含分隔符），逐次切出
        let mut buffer = format!(
            r#"{{"front": "Q1", "back": "A1"}}{DELIM}{{"front": "Q2", "back": "A2"}}{DELIM}"#
        );
        assert_eq!(
            extract(&mut buffer).unwrap().unwrap(),
            r#"{"front": "Q1", "back": "A1"}"#
        );
        assert_eq!(
            extract(&mut buffer).unwrap().unwrap(),
            r#"{"front": "Q2", "back": "A2"}"#
        );
        assert!(extract(&mut buffer).is_none());
        assert!(buffer.is_empty());
    }

    #[test]
    fn brace_cutter_extracts_multiple_cards_without_any_delimiter() {
        // 模型漏发分隔符时，brace-depth 主信号仍能逐张切卡（旧实现会整段滞留）
        let mut buffer = String::from(r#"{"front":"Q1","back":"A1"} {"front":"Q2","back":"A2"}"#);
        assert_eq!(
            extract(&mut buffer).unwrap().unwrap(),
            r#"{"front":"Q1","back":"A1"}"#
        );
        assert_eq!(
            extract(&mut buffer).unwrap().unwrap(),
            r#"{"front":"Q2","back":"A2"}"#
        );
        assert!(extract(&mut buffer).is_none());
        assert!(buffer.is_empty());
    }

    #[test]
    fn brace_cutter_ignores_delimiter_inside_json_string() {
        // 字符串内含分隔符文本：不得在字符串中间误切（旧实现的已知缺陷）
        let mut buffer =
            format!(r#"{{"front": "输出 {DELIM} 有什么作用？", "back": "流式切卡信号"}}{DELIM}"#);
        let card = extract(&mut buffer).unwrap().unwrap();
        assert_eq!(
            card,
            format!(r#"{{"front": "输出 {DELIM} 有什么作用？", "back": "流式切卡信号"}}"#)
        );
        assert!(
            card.contains(DELIM),
            "字符串内的分隔符文本必须原样保留在卡片中"
        );
        assert!(buffer.is_empty());
        assert!(serde_json::from_str::<Value>(&card).is_ok());
    }

    #[test]
    fn brace_cutter_ignores_delimiter_in_string_even_when_json_incomplete() {
        // 半包 + 字符串内分隔符：旧实现会在此误切出坏 JSON，新实现必须继续等待
        let mut buffer = format!(r#"{{"front": "分隔符 {DELIM} 出现在字符串里", "back": "尚未"#);
        let snapshot = buffer.clone();
        assert!(
            extract(&mut buffer).is_none(),
            "字符串内的分隔符不得触发切卡"
        );
        assert_eq!(buffer, snapshot, "等待期间缓冲必须原样保留");

        // 补齐后正常切卡，分隔符文本完整保留
        buffer.push_str(r#"结束"}"#);
        let card = extract(&mut buffer).unwrap().unwrap();
        assert!(card.contains(DELIM));
        assert!(serde_json::from_str::<Value>(&card).is_ok());
    }

    #[test]
    fn brace_cutter_handles_escaped_quotes_and_braces_in_strings() {
        // 转义引号 \" 不得终止字符串；字符串内的 {} 不得参与深度计数；
        // 尾部 "\\" 的转义反斜杠不得吞掉字符串结束引号
        let mut buffer = String::from(r#"{"front": "他说：\"{ 这不是括号 }\"", "back": "转义\\"}"#);
        let card = extract(&mut buffer).unwrap().unwrap();
        assert_eq!(
            card,
            r#"{"front": "他说：\"{ 这不是括号 }\"", "back": "转义\\"}"#
        );
        assert!(buffer.is_empty());
        assert!(serde_json::from_str::<Value>(&card).is_ok());
    }

    #[test]
    fn delimiter_still_cuts_unbalanced_fragment_for_backward_compat() {
        // 括号不配平的残片：状态机无法闭合，字符串外的分隔符作为辅助信号兜底，
        // 且不影响后续正常卡片（残片交由上游降级为 error card）
        let mut buffer =
            format!(r#"{{"front": "括号缺失"{DELIM}{{"front": "下一张", "back": "B"}}"#);
        assert_eq!(
            extract(&mut buffer).unwrap().unwrap(),
            r#"{"front": "括号缺失""#
        );
        assert_eq!(
            extract(&mut buffer).unwrap().unwrap(),
            r#"{"front": "下一张", "back": "B"}"#
        );
        assert!(extract(&mut buffer).is_none());
    }

    #[test]
    fn broken_delimiter_variant_still_recovers_unbalanced_fragment() {
        // 损坏分隔符在未闭合字符串内：不得触发修复分支（字符串感知）
        let mut buffer = String::from(r#"{"front": "残片<<< ANKI_CARD_JSON_END>>>"#);
        assert!(extract(&mut buffer).is_none());

        // 损坏分隔符在字符串外 + 坏 JSON：修复分支兜底切卡
        let mut buffer = String::from(r#"{"front": "残片"<<< ANKI_CARD_JSON_END>>>"#);
        assert_eq!(
            extract(&mut buffer).unwrap().unwrap(),
            r#"{"front": "残片""#
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn prose_prefix_is_discarded_when_json_cuts() {
        // 对象前的自然语言前缀被丢弃，切出的内容是纯 JSON（旧实现会连前缀一起切出）
        let mut buffer = format!(r#"好的，以下是第一张卡片：{{"front":"Q","back":"A"}}{DELIM}"#);
        assert_eq!(
            extract(&mut buffer).unwrap().unwrap(),
            r#"{"front":"Q","back":"A"}"#
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn brace_cutter_handles_multibyte_utf8_safely() {
        // 多字节 UTF-8（中日韩、emoji）与字节级扫描共存：切割点必须落在字符边界
        let mut buffer = format!(r#"{{"front": "水的沸点🌡️是{{{{c1::100}}}}℃"}}{DELIM}"#);
        let card = extract(&mut buffer).unwrap().unwrap();
        assert!(serde_json::from_str::<Value>(&card).is_ok());
        assert!(card.contains("🌡️"));
        assert!(buffer.is_empty());
    }

    // ==================== 输出协议升级（Round 3 #2） ====================

    fn minimal_options() -> AnkiGenerationOptions {
        serde_json::from_value(json!({
            "deck_name": "默认",
            "note_type": "Basic",
            "enable_images": false,
            "max_cards_per_mistake": 5
        }))
        .expect("minimal options must deserialize")
    }

    #[test]
    fn prompt_and_parser_share_delimiter_constant() {
        // 常量一致性：指令生成侧（build_prompt）与解析侧（extract_card_from_buffer）
        // 必须使用同一个分隔符定义，任何一侧漂移都会让协议破裂
        let (svc, _dir) = make_test_service();
        let payload = svc
            .build_prompt(
                "内容",
                &minimal_options(),
                crate::anki_protocol::OutputProtocol::Delimiter,
            )
            .expect("prompt");
        assert!(payload.user.contains(crate::anki_protocol::CARD_DELIMITER));

        // 解析侧对同一常量分隔的内容能够切卡
        let mut buffer = format!(
            r#"{{"front":"Q","back":"A"}}{}"#,
            crate::anki_protocol::CARD_DELIMITER
        );
        let card = svc.extract_card_from_buffer(&mut buffer).unwrap().unwrap();
        assert_eq!(card, r#"{"front":"Q","back":"A"}"#);
    }

    #[test]
    fn build_prompt_structured_omits_delimiter_and_uses_wrapper() {
        let (svc, _dir) = make_test_service();
        for protocol in [
            crate::anki_protocol::OutputProtocol::JsonObject,
            crate::anki_protocol::OutputProtocol::JsonSchema,
        ] {
            let payload = svc
                .build_prompt("内容", &minimal_options(), protocol)
                .expect("prompt");
            assert!(
                !payload.user.contains(crate::anki_protocol::CARD_DELIMITER),
                "结构化协议的指令不得再要求输出分隔符"
            );
            assert!(payload
                .user
                .contains(&format!("\"{}\"", crate::anki_protocol::CARDS_WRAPPER_KEY)));
        }
    }

    #[test]
    fn build_prompt_example_json_is_language_neutral() {
        // 示例 JSON 必须是语言中性占位，避免中文 few-shot 把非中文材料的
        // 卡片语言牵引到中文
        let (svc, _dir) = make_test_service();
        let payload = svc
            .build_prompt(
                "content",
                &minimal_options(),
                crate::anki_protocol::OutputProtocol::Delimiter,
            )
            .expect("prompt");
        assert!(payload.user.contains("\"front\": \"<question>\""));
        assert!(payload.user.contains("\"back\": \"<answer>\""));
        assert!(
            !payload.user.contains("问题内容"),
            "示例 JSON 不得再含中文占位: {}",
            payload.user
        );
    }

    #[test]
    fn build_prompt_appends_custom_prompt_instead_of_replacing() {
        // 单模板 generation_prompt（经 custom_anki_prompt 传入）改为附加而非替换：
        // 默认 prompt 的通用质量要求必须保留
        let (svc, _dir) = make_test_service();
        let mut options = minimal_options();
        options.custom_anki_prompt = Some("每张卡片的 front 必须以疑问句结尾".to_string());
        let payload = svc
            .build_prompt(
                "内容",
                &options,
                crate::anki_protocol::OutputProtocol::Delimiter,
            )
            .expect("prompt");
        let system = payload.system.expect("system message");
        assert!(
            system.contains("专业的 Anki 学习卡片制作助手"),
            "默认质量基线必须保留"
        );
        assert!(
            system.contains("每张卡片的 front 必须以疑问句结尾"),
            "模板生成说明必须附加"
        );
        assert!(system.contains("模板生成说明"));
    }

    #[test]
    fn cardagent_real_options_full_request_has_single_protocol_source() {
        // 跨层契约（0824 评审 #2）：用真实 CardAgent options 组装完整请求消息。
        // fixture 与前端 buildCardGenerationSystemPrompt() 输出逐字一致
        // （TS 侧钉住：tests/vitest/anki/cardforge/prompts.test.ts），
        // options 形状与 CardAgent.buildBackendGenerationOptions 的装配一致。
        // 断言输出协议只由后端单点生成：
        // - CardAgent 基础 prompt 协议中立（不含 END-only 规则）；
        // - 后端选 json_schema 时，完整请求（system+user）无任何分隔符指令；
        // - 后端选 delimiter 时，分隔符指令只出现在后端生成的 user 消息中。
        const CARDAGENT_SYSTEM_PROMPT: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/cardagent_system_prompt.txt"
        ));
        assert!(
            !CARDAGENT_SYSTEM_PROMPT.contains("ANKI_CARD_JSON_END"),
            "CardAgent 基础 prompt 必须协议中立，不得携带 END 标记规则"
        );

        let (svc, _dir) = make_test_service();
        let options: AnkiGenerationOptions = serde_json::from_value(json!({
            "deck_name": "Default",
            "note_type": "Basic",
            "enable_images": true,
            "max_cards_per_mistake": 10,
            "max_cards_total": 10,
            "template_id": "basic",
            "template_ids": ["basic"],
            "template_descriptions": [{
                "id": "basic",
                "name": "Basic",
                "description": "Basic template",
                "fields": ["front", "back", "tags"]
            }],
            "template_fields": ["front", "back", "tags"],
            "template_fields_by_id": {"basic": ["front", "back", "tags"]},
            "segment_overlap_size": 200,
            "enable_llm_boundary_detection": true,
            "custom_anki_prompt": CARDAGENT_SYSTEM_PROMPT,
            "fsrs_feedback": false
        }))
        .expect("CardAgent 形状的 options 必须可反序列化");

        // 后端能力探测自动升级 json_schema 的路径
        let structured = svc
            .build_prompt(
                "学习材料",
                &options,
                crate::anki_protocol::OutputProtocol::JsonSchema,
            )
            .expect("structured prompt");
        let system = structured.system.as_deref().expect("system message");
        assert!(
            system.contains("专业的 Anki 记忆卡片制作专家"),
            "CardAgent prompt 必须进入 system 消息"
        );
        for (label, message) in [("system", system), ("user", structured.user.as_str())] {
            assert!(
                !message.contains(crate::anki_protocol::CARD_DELIMITER),
                "json_schema 协议下 {label} 消息不得出现分隔符指令: {message}"
            );
        }
        assert!(
            structured
                .user
                .contains(&format!("\"{}\"", crate::anki_protocol::CARDS_WRAPPER_KEY)),
            "json_schema 协议的 wrapper 指令必须由后端生成"
        );

        // 保守回退 delimiter 的路径：协议指令只能来自后端 user 消息
        let delimiter = svc
            .build_prompt(
                "学习材料",
                &options,
                crate::anki_protocol::OutputProtocol::Delimiter,
            )
            .expect("delimiter prompt");
        let system = delimiter.system.as_deref().expect("system message");
        assert!(
            !system.contains(crate::anki_protocol::CARD_DELIMITER),
            "system（含 CardAgent prompt）不得包含协议指令，协议由后端单点生成"
        );
        assert!(
            delimiter
                .user
                .contains(crate::anki_protocol::CARD_DELIMITER),
            "delimiter 协议指令必须出现在后端生成的 user 消息中"
        );
    }

    #[test]
    fn structured_wrapper_streams_cards_through_existing_cutter() {
        // 结构化协议全链路（流入侧）：wrapper 前缀剥离后，
        // 既有 brace-depth 切卡器能逐卡切出数组内的卡片对象
        let mut buffer = String::new();

        // chunk 1：不完整前缀，剥离必须等待且不破坏缓冲
        buffer.push_str("{\"ca");
        assert!(!crate::anki_protocol::strip_wrapper_prefix(&mut buffer));
        assert!(extract(&mut buffer).is_none());

        // chunk 2：前缀补齐 + 第一张卡完整
        buffer.push_str("rds\": [{\"front\": \"Q1\", \"back\": \"A1\"},");
        assert!(crate::anki_protocol::strip_wrapper_prefix(&mut buffer));
        let card1 = extract(&mut buffer).unwrap().unwrap();
        assert_eq!(card1, r#"{"front": "Q1", "back": "A1"}"#);
        assert!(extract(&mut buffer).is_none());

        // chunk 3：第二张卡 + wrapper 收尾
        buffer.push_str("{\"front\": \"Q2\", \"back\": \"A2\"}]}");
        assert!(!crate::anki_protocol::strip_wrapper_prefix(&mut buffer));
        let card2 = extract(&mut buffer).unwrap().unwrap();
        assert_eq!(card2, r#"{"front": "Q2", "back": "A2"}"#);

        // 收尾残留 ]} 不含 '{'，由收尾逻辑按非卡片内容丢弃
        assert!(extract(&mut buffer).is_none());
        assert!(!buffer.trim().contains('{'));
    }

    #[test]
    fn expand_wrapper_payloads_expands_wrapper_and_repairs_truncation() {
        let (svc, _dir) = make_test_service();

        // 完整 wrapper → 逐卡展开，全部完整
        let payloads = svc.expand_wrapper_payloads(
            r#"{"cards": [{"front": "Q1", "back": "A1"}, {"front": "Q2", "back": "A2"}]}"#,
        );
        assert_eq!(payloads.len(), 2);
        assert!(payloads[0].json.contains("Q1"));
        assert!(payloads[1].json.contains("Q2"));
        assert!(payloads.iter().all(|p| !p.truncated));

        // 截断 wrapper（字符串已闭合，仅缺 ]}）→ 无损修复后仍能展开，不标截断
        let payloads = svc.expand_wrapper_payloads(r#"{"cards": [{"front": "Q1", "back": "A1"}"#);
        assert_eq!(payloads.len(), 1);
        assert!(payloads[0].json.contains("Q1"));
        assert!(!payloads[0].truncated);

        // 非 wrapper 内容原样返回单元素
        let payloads = svc.expand_wrapper_payloads(r#"{"front": "Q", "back": "A"}"#);
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].json, r#"{"front": "Q", "back": "A"}"#);
        assert!(!payloads[0].truncated);

        // 纯文本原样返回
        let payloads = svc.expand_wrapper_payloads("以上就是全部卡片");
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].json, "以上就是全部卡片");
        assert!(!payloads[0].truncated);
    }

    #[test]
    fn expand_wrapper_payloads_marks_mid_string_truncated_last_card() {
        // 0824 评审 #3：wrapper 在最后一张卡的字符串正文中途被截断时，
        // 之前的完整卡照常展开，最后一张必须携带 truncated 标记
        // （调用方据此落错误卡，不得静默入库为正常卡）。
        let (svc, _dir) = make_test_service();
        let payloads = svc.expand_wrapper_payloads(
            r#"{"cards": [{"front": "Q1", "back": "A1"}, {"front": "Q2", "back": "答案说到一半就断"#,
        );
        assert_eq!(payloads.len(), 2);
        assert!(payloads[0].json.contains("Q1"));
        assert!(!payloads[0].truncated, "完整卡不得误标截断");
        assert!(payloads[1].json.contains("Q2"));
        assert!(
            payloads[1].truncated,
            "字符串中途截断的最后一张卡必须标记 truncated"
        );
    }

    #[test]
    fn response_format_injection_matrix_for_service_options() {
        // 服务侧注入语义：delimiter 不注入；json_schema 生成 wrapper schema；
        // 决策函数在能力未知时保守回退 delimiter
        let options = minimal_options();
        assert!(crate::anki_protocol::build_response_format(
            crate::anki_protocol::OutputProtocol::Delimiter,
            &options
        )
        .is_none());

        let format = crate::anki_protocol::build_response_format(
            crate::anki_protocol::OutputProtocol::JsonSchema,
            &options,
        )
        .expect("json_schema format");
        assert_eq!(format["type"], json!("json_schema"));
        assert_eq!(
            format["json_schema"]["schema"]["required"],
            json!([crate::anki_protocol::CARDS_WRAPPER_KEY])
        );

        let (protocol, _) = crate::anki_protocol::resolve_output_protocol(
            None,
            crate::anki_protocol::SchemaCapability::Unknown,
        );
        assert_eq!(protocol, crate::anki_protocol::OutputProtocol::Delimiter);
    }

    // -------------------- Round 4 #3：文档级重复/近重复指纹（真实入库路径） --------------------

    /// 在测试 DB 中登记一个 document_task（parse_and_save_card 入库前置条件）。
    fn seed_task(db: &Database, task_id: &str, document_id: &str, segment_index: u32) {
        let now = chrono::Utc::now().to_rfc3339();
        let task = DocumentTask {
            id: task_id.to_string(),
            document_id: document_id.to_string(),
            original_document_name: "指纹测试文档".to_string(),
            segment_index,
            content_segment: format!("segment-{}", segment_index),
            status: TaskStatus::Streaming,
            created_at: now.clone(),
            updated_at: now,
            error_message: None,
            anki_generation_options_json: "{}".to_string(),
        };
        db.save_document_task_with_cards_atomic(&task, &[])
            .expect("seed document task");
    }

    /// front/back 基础字段提取规则的最小 options。
    fn fingerprint_options() -> AnkiGenerationOptions {
        let mut options = minimal_options();
        let mut rules = HashMap::new();
        rules.insert(
            "front".to_string(),
            make_rule(true, FieldType::Text, "front"),
        );
        rules.insert("back".to_string(), make_rule(true, FieldType::Text, "back"));
        options.field_extraction_rules = Some(rules);
        options
    }

    fn qa_flag_codes(card: &AnkiCard) -> Vec<String> {
        card.extra_fields
            .get(QA_FLAGS_FIELD)
            .map(|raw| {
                serde_json::from_str::<Vec<Value>>(raw)
                    .expect("qa flags must be json array")
                    .iter()
                    .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn parse_and_save_card_honors_qa_pass_flag_persistence_contract() {
        let (svc, _dir) = make_persisted_test_service();
        let default_enabled = StructuredOutputOptions::from_options_json("{}").qa_pass_enabled();
        assert!(
            default_enabled,
            "QA flag persistence must remain enabled by default"
        );

        for (label, qa_pass_enabled, expect_flags) in [
            ("disabled", false, false),
            ("enabled", true, true),
            ("default", default_enabled, true),
        ] {
            let document_id = format!("doc-qa-pass-{label}-{}", uuid::Uuid::new_v4());
            let task_id = format!("qa-pass-{label}-task");
            crate::anki_qa_lint::release_document_tracker(&document_id);
            seed_task(&svc.db, &task_id, &document_id, 0);

            // front == back is a deterministic lint violation produced after field extraction.
            let identical = format!("{label} identical content");
            let payload = json!({ "front": identical, "back": identical }).to_string();
            let card = svc
                .parse_and_save_card(
                    &payload,
                    &task_id,
                    &document_id,
                    &fingerprint_options(),
                    qa_pass_enabled,
                    None,
                )
                .await
                .expect("invalid card must still parse")
                .expect("invalid card must still be saved");

            assert_eq!(
                card.extra_fields.contains_key(QA_FLAGS_FIELD),
                expect_flags,
                "{label} QA mode returned unexpected _qa_flags"
            );
            if expect_flags {
                assert!(
                    qa_flag_codes(&card)
                        .iter()
                        .any(|code| code == "front_back_identical"),
                    "{label} QA mode must preserve lint flags"
                );
            }

            let persisted = svc.db.get_cards_for_task(&task_id).expect("stored card");
            assert_eq!(persisted.len(), 1);
            assert_eq!(
                persisted[0].extra_fields.contains_key(QA_FLAGS_FIELD),
                expect_flags,
                "{label} QA mode persisted unexpected _qa_flags"
            );
            crate::anki_qa_lint::release_document_tracker(&document_id);
        }
    }

    // -------------------- 0824 评审 #3：截断残卡不得静默入库 --------------------

    #[tokio::test]
    async fn parse_and_save_card_rejects_mid_string_truncation_as_error() {
        // 字符串正文中途截断（如 token 上限/断连）：修复产物内容已丢失，
        // 必须返回 Err（上游降级为错误卡），绝不静默保存为正常卡。
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-truncated-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        seed_task(&svc.db, "truncated-task", &document_id, 0);

        let err = svc
            .parse_and_save_card(
                r#"{"front":"什么是流式解析？","back":"答案在正文中途被截"#,
                "truncated-task",
                &document_id,
                &fingerprint_options(),
                true,
                None,
            )
            .await
            .expect_err("字符串中途截断必须报错");
        assert!(
            err.message.contains("字符串中途截断"),
            "错误信息应指明截断: {}",
            err.message
        );

        let persisted = svc
            .db
            .get_cards_for_task("truncated-task")
            .expect("query cards");
        assert!(persisted.is_empty(), "截断残卡不得作为正常卡入库");
        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    #[tokio::test]
    async fn parse_and_save_card_still_repairs_lossless_damage() {
        // 无损坏形态（尾逗号 + 缺闭合括号但字符串已闭合）仍允许自动修复入库。
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-lossless-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        seed_task(&svc.db, "lossless-task", &document_id, 0);

        let card = svc
            .parse_and_save_card(
                r#"{"front":"什么是惯性？","back":"保持原有运动状态的性质","#,
                "lossless-task",
                &document_id,
                &fingerprint_options(),
                true,
                None,
            )
            .await
            .expect("无损修复应成功")
            .expect("卡片应入库");
        assert_eq!(card.front, "什么是惯性？");
        assert_eq!(card.back, "保持原有运动状态的性质");
        assert!(!card.is_error_card);
        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    // -------------------- 收尾 #4：首次入库原文快照 --------------------

    #[tokio::test]
    async fn parse_and_save_card_persists_original_generation_snapshot() {
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-original-basic-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        seed_task(&svc.db, "original-basic-task", &document_id, 0);

        let card = svc
            .parse_and_save_card(
                r#"{"front":"  什么是惯性？  ","back":"  保持原有运动状态的性质  "}"#,
                "original-basic-task",
                &document_id,
                &fingerprint_options(),
                true,
                None,
            )
            .await
            .expect("card parses")
            .expect("card saves");
        let snapshot = crate::anki_gold_set::extract_original_from_extras(&card.extra_fields)
            .expect("snapshot on returned card");
        assert_eq!(snapshot.front, card.front);
        assert_eq!(snapshot.back, card.back);
        assert_eq!(snapshot.text, None);

        let persisted = svc
            .db
            .get_cards_for_task("original-basic-task")
            .expect("stored card");
        assert_eq!(persisted.len(), 1);
        assert_eq!(
            crate::anki_gold_set::extract_original_from_extras(&persisted[0].extra_fields),
            Some(snapshot)
        );
        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    #[tokio::test]
    async fn parse_and_save_card_snapshot_includes_cloze_text() {
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-original-cloze-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        seed_task(&svc.db, "original-cloze-task", &document_id, 0);
        let mut options = minimal_options();
        options.template_fields = Some(vec!["Text".to_string()]);
        options.field_extraction_rules = Some(HashMap::from([(
            "text".to_string(),
            make_rule(true, FieldType::Text, "text"),
        )]));

        let card = svc
            .parse_and_save_card(
                r#"{"text":"水在标准大气压下的沸点是 {{c1::100 摄氏度}}。"}"#,
                "original-cloze-task",
                &document_id,
                &options,
                true,
                None,
            )
            .await
            .expect("cloze parses")
            .expect("cloze saves");
        let snapshot = crate::anki_gold_set::extract_original_from_extras(&card.extra_fields)
            .expect("cloze snapshot");
        assert_eq!(snapshot.front, card.front);
        assert_eq!(snapshot.back, card.back);
        assert_eq!(snapshot.text, card.text);
        assert!(snapshot.text.as_deref().unwrap_or("").contains("{{c1::"));
        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    #[tokio::test]
    async fn parse_and_save_card_does_not_overwrite_existing_original_generation() {
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-original-existing-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        seed_task(&svc.db, "original-existing-task", &document_id, 0);
        let mut options = fingerprint_options();
        options
            .field_extraction_rules
            .as_mut()
            .expect("rules")
            .insert(
                crate::anki_gold_set::ORIGINAL_GENERATION_FIELD.to_string(),
                make_rule(false, FieldType::Text, "existing snapshot"),
            );

        let card = svc
            .parse_and_save_card(
                r#"{"front":"新问题","back":"新答案","_original_generation":"user-controlled-value"}"#,
                "original-existing-task",
                &document_id,
                &options,
                true,
                None,
            )
            .await
            .expect("card parses")
            .expect("card saves");
        assert_eq!(
            card.extra_fields
                .get(crate::anki_gold_set::ORIGINAL_GENERATION_FIELD)
                .map(String::as_str),
            Some("user-controlled-value")
        );
        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    #[tokio::test]
    async fn oversized_original_generation_failure_does_not_block_card_insert() {
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-original-oversized-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        seed_task(&svc.db, "original-oversized-task", &document_id, 0);
        let oversized_front = "界".repeat(crate::anki_gold_set::ORIGINAL_GENERATION_MAX_BYTES);
        let payload = json!({
            "front": oversized_front,
            "back": "仍需正常入库",
        })
        .to_string();

        let card = svc
            .parse_and_save_card(
                &payload,
                "original-oversized-task",
                &document_id,
                &fingerprint_options(),
                true,
                None,
            )
            .await
            .expect("snapshot failure is non-fatal")
            .expect("card still saves");
        assert!(!card
            .extra_fields
            .contains_key(crate::anki_gold_set::ORIGINAL_GENERATION_FIELD));
        let persisted = svc
            .db
            .get_cards_for_task("original-oversized-task")
            .expect("stored oversized card");
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].front, card.front);
        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    #[tokio::test]
    async fn duplicate_front_across_segments_flagged_and_still_saved() {
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-fp-dup-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        // 同文档两个不同 segment task —— tracker 必须跨 task 共享，不能每 task 重置
        seed_task(&svc.db, "fp-task-a", &document_id, 0);
        seed_task(&svc.db, "fp-task-b", &document_id, 1);
        let options = fingerprint_options();

        let first = svc
            .parse_and_save_card(
                r#"{"front":"什么是 TCP？","back":"传输控制协议"}"#,
                "fp-task-a",
                &document_id,
                &options,
                true,
                None,
            )
            .await
            .expect("first card parses")
            .expect("first card saved");
        assert!(
            !qa_flag_codes(&first)
                .iter()
                .any(|c| c == "duplicate_in_document"),
            "首见 front 不得判重复"
        );

        // 另一 segment task：front 归一化后相同（HTML/空白/标点差异），back 不同
        // （避开 DB front|back 唯一索引，验证 flag 与入库互不干扰）
        let second = svc
            .parse_and_save_card(
                r#"{"front":"<b>什么是TCP</b>","back":"Transmission Control Protocol"}"#,
                "fp-task-b",
                &document_id,
                &options,
                true,
                None,
            )
            .await
            .expect("second card parses")
            .expect("重复只打 flag，卡片必须照常入库");
        assert!(
            qa_flag_codes(&second)
                .iter()
                .any(|c| c == "duplicate_in_document"),
            "跨 segment 重复 front 必须打 duplicate_in_document: {:?}",
            second.extra_fields.get(QA_FLAGS_FIELD)
        );
        // 入库确认：两张卡都在 DB
        let cards_a = svc.db.get_cards_for_task("fp-task-a").expect("cards a");
        let cards_b = svc.db.get_cards_for_task("fp-task-b").expect("cards b");
        assert_eq!(cards_a.len() + cards_b.len(), 2);

        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    #[tokio::test]
    async fn near_duplicate_front_flagged_but_not_dropped() {
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-fp-near-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        seed_task(&svc.db, "fp-near-task", &document_id, 0);
        let options = fingerprint_options();

        svc.parse_and_save_card(
            r#"{"front":"细胞膜的主要成分是磷脂双分子层","back":"生物膜基础"}"#,
            "fp-near-task",
            &document_id,
            &options,
            true,
            None,
        )
        .await
        .expect("first parses")
        .expect("first saved");

        // 小编辑近重复：追加两字，归一化后非精确重复但 bigram Jaccard 超阈值
        let near = svc
            .parse_and_save_card(
                r#"{"front":"细胞膜的主要成分是磷脂双分子层结构","back":"生物膜基础知识"}"#,
                "fp-near-task",
                &document_id,
                &options,
                true,
                None,
            )
            .await
            .expect("near-duplicate parses")
            .expect("近重复不丢卡，必须照常入库");
        let codes = qa_flag_codes(&near);
        assert!(
            codes.iter().any(|c| c == "near_duplicate"),
            "近重复必须打 near_duplicate flag: {:?}",
            codes
        );
        assert!(
            !codes.iter().any(|c| c == "duplicate_in_document"),
            "近重复不得误判为精确重复"
        );

        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    #[tokio::test]
    async fn fingerprint_state_isolated_between_documents() {
        let (svc, _dir) = make_persisted_test_service();
        let doc_a = format!("doc-fp-iso-a-{}", uuid::Uuid::new_v4());
        let doc_b = format!("doc-fp-iso-b-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&doc_a);
        crate::anki_qa_lint::release_document_tracker(&doc_b);
        seed_task(&svc.db, "fp-iso-task-a", &doc_a, 0);
        seed_task(&svc.db, "fp-iso-task-b", &doc_b, 0);
        let options = fingerprint_options();

        svc.parse_and_save_card(
            r#"{"front":"什么是渗透压？","back":"溶剂分子跨膜净流动的驱动力"}"#,
            "fp-iso-task-a",
            &doc_a,
            &options,
            true,
            None,
        )
        .await
        .expect("doc a parses")
        .expect("doc a saved");

        // 另一文档出现相同 front：不同 document_id，不得判重复
        let other_doc_card = svc
            .parse_and_save_card(
                r#"{"front":"什么是渗透压？","back":"溶剂分子跨膜净流动的驱动力"}"#,
                "fp-iso-task-b",
                &doc_b,
                &options,
                true,
                None,
            )
            .await
            .expect("doc b parses")
            .expect("doc b saved");
        assert!(
            !qa_flag_codes(&other_doc_card)
                .iter()
                .any(|c| c == "duplicate_in_document" || c == "near_duplicate"),
            "不同文档的指纹状态必须相互隔离: {:?}",
            other_doc_card.extra_fields.get(QA_FLAGS_FIELD)
        );

        crate::anki_qa_lint::release_document_tracker(&doc_a);
        crate::anki_qa_lint::release_document_tracker(&doc_b);
    }

    #[tokio::test]
    async fn vlm_occlusion_draft_is_merged_into_extra_fields_without_rewriting_card() {
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-occlusion-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        seed_task(&svc.db, "occlusion-task", &document_id, 0);
        let options = fingerprint_options();
        let marker = crate::anki_image_occlusion::build_occlusion_draft_marker(
            "image-source-1",
            "[IMAGE_DESC: 输入层；隐藏层；输出层]",
            &crate::anki_image_occlusion::OcclusionConfig::default(),
        )
        .expect("marker");
        let fields = crate::anki_image_occlusion::extract_occlusion_draft_fields(&marker)
            .expect("occlusion fields");

        let card = svc
            .parse_and_save_card(
                r#"{"front":"神经网络包含哪些层？","back":"输入层、隐藏层和输出层"}"#,
                "occlusion-task",
                &document_id,
                &options,
                true,
                Some(&fields),
            )
            .await
            .expect("card parses")
            .expect("card saved");

        assert_eq!(card.front, "神经网络包含哪些层？");
        assert_eq!(card.back, "输入层、隐藏层和输出层");
        assert!(card
            .extra_fields
            .contains_key(crate::anki_image_occlusion::OCCLUSION_FIELD));
        assert!(card
            .tags
            .iter()
            .any(|tag| tag == crate::anki_image_occlusion::OCCLUSION_TAG));
        // Round 2：模型未产出 text 时，草稿 text（<img> + cloze）被消费入库
        assert_eq!(
            card.text.as_deref(),
            Some(fields.text.as_str()),
            "occlusion 草稿 text 应写入卡片"
        );
        assert!(
            card.text
                .as_deref()
                .unwrap_or("")
                .starts_with("<img src=\"image-source-1\"><br>"),
            "text 应含图片 <img src>: {:?}",
            card.text
        );
        assert!(card.text.as_deref().unwrap_or("").contains("{{c1::"));
        // Round 2：_occlusion.imageRef 被写入 images
        assert_eq!(card.images, vec!["image-source-1".to_string()]);
        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    #[tokio::test]
    async fn plain_card_without_occlusion_keeps_images_empty() {
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-plain-images-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        seed_task(&svc.db, "plain-images-task", &document_id, 0);

        let card = svc
            .parse_and_save_card(
                r#"{"front":"什么是熵？","back":"系统混乱程度的度量"}"#,
                "plain-images-task",
                &document_id,
                &fingerprint_options(),
                true,
                None,
            )
            .await
            .expect("card parses")
            .expect("card saved");

        assert!(
            card.images.is_empty(),
            "无 _occlusion 的普通卡 images 必须保持为空: {:?}",
            card.images
        );
        assert!(!card
            .extra_fields
            .contains_key(crate::anki_image_occlusion::OCCLUSION_FIELD));
        assert_eq!(card.text, None, "普通卡不得凭空产生 text");
        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    #[tokio::test]
    async fn occlusion_draft_does_not_overwrite_model_written_text() {
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-occlusion-text-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        seed_task(&svc.db, "occlusion-text-task", &document_id, 0);
        let mut options = minimal_options();
        options.template_fields = Some(vec!["Text".to_string()]);
        options.field_extraction_rules = Some(HashMap::from([(
            "text".to_string(),
            make_rule(true, FieldType::Text, "text"),
        )]));
        let marker = crate::anki_image_occlusion::build_occlusion_draft_marker(
            "image-source-2",
            "[IMAGE_DESC: 定子；转子]",
            &crate::anki_image_occlusion::OcclusionConfig::default(),
        )
        .expect("marker");
        let fields = crate::anki_image_occlusion::extract_occlusion_draft_fields(&marker)
            .expect("occlusion fields");
        assert!(fields.text.contains("<img src=\"image-source-2\">"));

        let card = svc
            .parse_and_save_card(
                r#"{"text":"电动机把电能转化为 {{c1::机械能}}。"}"#,
                "occlusion-text-task",
                &document_id,
                &options,
                true,
                Some(&fields),
            )
            .await
            .expect("card parses")
            .expect("card saved");

        // 模型已产出 text：不得被 occlusion 草稿 text 覆盖
        assert_eq!(
            card.text.as_deref(),
            Some("电动机把电能转化为 {{c1::机械能}}。")
        );
        assert!(
            !card.text.as_deref().unwrap_or("").contains("<img"),
            "模型 text 不得被草稿 <img> 覆盖: {:?}",
            card.text
        );
        // 机器字段照常合并，images 仍来自 _occlusion.imageRef
        assert!(card
            .extra_fields
            .contains_key(crate::anki_image_occlusion::OCCLUSION_FIELD));
        assert_eq!(card.images, vec!["image-source-2".to_string()]);
        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    #[tokio::test]
    async fn occlusion_pending_placeholder_image_ref_stays_out_of_images() {
        // r2 契约 §2.1 / §9：`vlm://pending-image` 占位（VLM 块不选图、
        // 生产接线未替换的边缘）不得进入 card.images——导出两侧已过滤，
        // 入库侧必须对齐，否则渲染/媒体收集会拿到不可解析引用。
        let (svc, _dir) = make_persisted_test_service();
        let document_id = format!("doc-occlusion-pending-{}", uuid::Uuid::new_v4());
        crate::anki_qa_lint::release_document_tracker(&document_id);
        seed_task(&svc.db, "occlusion-pending-task", &document_id, 0);
        let marker = crate::anki_image_occlusion::build_occlusion_draft_marker(
            "vlm://pending-image",
            "[IMAGE_DESC: 主动脉；肺动脉]",
            &crate::anki_image_occlusion::OcclusionConfig::default(),
        )
        .expect("marker");
        let fields = crate::anki_image_occlusion::extract_occlusion_draft_fields(&marker)
            .expect("occlusion fields");

        let card = svc
            .parse_and_save_card(
                r#"{"front":"心脏的大血管有哪些？","back":"主动脉和肺动脉"}"#,
                "occlusion-pending-task",
                &document_id,
                &fingerprint_options(),
                true,
                Some(&fields),
            )
            .await
            .expect("card parses")
            .expect("card saved");

        assert!(
            card.images.is_empty(),
            "vlm:// 占位引用不得进入 images: {:?}",
            card.images
        );
        // 机器字段与 tag 照常合并（占位只影响 images 过滤，不阻断草稿入库）
        assert!(card
            .extra_fields
            .contains_key(crate::anki_image_occlusion::OCCLUSION_FIELD));
        assert!(card
            .tags
            .iter()
            .any(|tag| tag == crate::anki_image_occlusion::OCCLUSION_TAG));
        crate::anki_qa_lint::release_document_tracker(&document_id);
    }

    // ==========================================================================
    // Wave2-E Round 3：CriticSummary / TaskCompleted 事件载荷（纯函数，不依赖 Window）
    // ==========================================================================

    #[test]
    fn critic_summary_event_contains_gold_and_routing_fields() {
        let summary = crate::anki_critic::CriticSummary {
            examined: 5,
            kept: 3,
            revised: 1,
            flagged: 1,
            rejected_unknown_ids: 0,
            skipped_over_budget: 2,
            gold_references: 4,
            gold_references_truncated: 1,
            persist_failures: 0,
            degraded: None,
            routed_config_id: Some("cfg-critic".to_string()),
            routed_model: Some("model-x".to_string()),
            routed_degraded: Some(false),
        };
        let event = build_critic_summary_event("task-1", "doc-1", &summary);
        let inner = event
            .get("CriticSummary")
            .and_then(Value::as_object)
            .expect("外部标签 CriticSummary");

        // merge 进来的路由键
        assert_eq!(inner.get("task_id").and_then(Value::as_str), Some("task-1"));
        assert_eq!(
            inner.get("document_id").and_then(Value::as_str),
            Some("doc-1")
        );
        // struct 序列化字段：金标观测必须在 wire 上（本轮修复的核心断言）
        assert_eq!(
            inner.get("gold_references").and_then(Value::as_u64),
            Some(4)
        );
        assert_eq!(
            inner
                .get("gold_references_truncated")
                .and_then(Value::as_u64),
            Some(1)
        );
        // Sidekick 路由观测字段（Some 时序列化）
        assert_eq!(
            inner.get("routed_config_id").and_then(Value::as_str),
            Some("cfg-critic")
        );
        assert_eq!(
            inner.get("routed_model").and_then(Value::as_str),
            Some("model-x")
        );
        assert_eq!(
            inner.get("routed_degraded").and_then(Value::as_bool),
            Some(false)
        );
        // 旧字段照常在（序列化基底没有丢字段）
        assert_eq!(inner.get("examined").and_then(Value::as_u64), Some(5));
        assert_eq!(
            inner.get("skipped_over_budget").and_then(Value::as_u64),
            Some(2)
        );
    }

    #[test]
    fn critic_summary_event_omits_routing_when_unrouted() {
        // 路由未接通（None）时 wire 格式与旧版完全一致：routed_* 键不出现
        let summary = crate::anki_critic::CriticSummary {
            examined: 1,
            kept: 1,
            ..Default::default()
        };
        let event = build_critic_summary_event("task-2", "doc-2", &summary);
        let inner = event
            .get("CriticSummary")
            .and_then(Value::as_object)
            .expect("外部标签 CriticSummary");
        assert!(!inner.contains_key("routed_config_id"));
        assert!(!inner.contains_key("routed_model"));
        assert!(!inner.contains_key("routed_degraded"));
        // 金标观测字段即使为 0 也序列化（无 skip 注解）
        assert_eq!(
            inner.get("gold_references").and_then(Value::as_u64),
            Some(0)
        );
    }

    #[test]
    fn task_completed_event_flags_warnings_when_dropped() {
        let stats = StreamStats {
            card_count: 7,
            failed_cards: 0,
            duplicate_cards: 0,
            dropped_fragments: 2,
            flagged_cards: 0,
        };
        let event = build_task_completed_event("task-3", "doc-3", &stats);
        let inner = event
            .get("TaskCompleted")
            .and_then(Value::as_object)
            .expect("外部标签 TaskCompleted");

        // 有 dropped 时必须标记"带警告完成"
        assert_eq!(
            inner
                .get("completed_with_warnings")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            inner.get("dropped_fragments").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(inner.get("failed_cards").and_then(Value::as_u64), Some(0));
        assert_eq!(
            inner.get("duplicate_cards").and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(inner.get("flagged_cards").and_then(Value::as_u64), Some(0));
        // 旧 wire 字段保持不变
        assert_eq!(inner.get("task_id").and_then(Value::as_str), Some("task-3"));
        assert_eq!(
            inner.get("document_id").and_then(Value::as_str),
            Some("doc-3")
        );
        assert_eq!(
            inner.get("total_cards_generated").and_then(Value::as_u64),
            Some(7)
        );
        assert_eq!(
            inner.get("final_status").and_then(Value::as_str),
            Some("Completed")
        );
    }

    #[test]
    fn task_completed_event_clean_run_has_no_warning_flag() {
        let stats = StreamStats {
            card_count: 3,
            ..Default::default()
        };
        let event = build_task_completed_event("task-4", "doc-4", &stats);
        let inner = event
            .get("TaskCompleted")
            .and_then(Value::as_object)
            .expect("外部标签 TaskCompleted");
        assert_eq!(
            inner
                .get("completed_with_warnings")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            inner.get("total_cards_generated").and_then(Value::as_u64),
            Some(3)
        );
    }

    #[test]
    fn stream_stats_warning_and_signal_predicates() {
        assert!(!StreamStats::default().has_warnings());
        assert!(!StreamStats::default().has_any_signal());
        // 仅有成功卡：无警告，但失败路径仍值得补发 GenerationStats
        let ok_only = StreamStats {
            card_count: 2,
            ..Default::default()
        };
        assert!(!ok_only.has_warnings());
        assert!(ok_only.has_any_signal());
        // 四类警告任一非零都算警告
        for stats in [
            StreamStats {
                failed_cards: 1,
                ..Default::default()
            },
            StreamStats {
                duplicate_cards: 1,
                ..Default::default()
            },
            StreamStats {
                dropped_fragments: 1,
                ..Default::default()
            },
            StreamStats {
                flagged_cards: 1,
                ..Default::default()
            },
        ] {
            assert!(
                stats.has_warnings(),
                "任一非零计数应判定为带警告: {:?}",
                stats
            );
            assert!(stats.has_any_signal());
        }
    }
}
