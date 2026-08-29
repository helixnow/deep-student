//! Anki 流式制卡输出协议模块（Round 3 #2：分隔符协议 → Structured Output 升级）
//!
//! 职责：
//! 1. 集中定义分隔符常量（`CARD_DELIMITER` / `BROKEN_DELIMITER_TAIL`），供
//!    `build_prompt` 与 `extract_card_from_buffer` 共用，消灭散落的重复字面量；
//! 2. 定义 [`OutputProtocol`]（Delimiter / JsonObject / JsonSchema）三种输出协议，
//!    以及协议对应的格式指令 [`format_instructions`]；
//! 3. 从模板的 [`FieldExtractionRule`] 生成 JSON Schema（required / type / enum /
//!    minLength / maxLength），多模板场景用 `oneOf` + `template_id` 区分变体；
//! 4. 供应商能力探测 [`detect_schema_capability`] 与默认协议决策
//!    [`resolve_output_protocol`]：能力允许时优先 json_schema，未知供应商保守回退
//!    delimiter（不静默假设所有 OpenAI 兼容端点都支持 response_format）；
//! 5. 轻量 JSON 修复：[`repair_json`] 只做无损修复（去尾逗号 / 截外围垃圾 /
//!    补已闭合字符串之后的缺失括号），[`repair_json_detailed`] 额外支持
//!    字符串中途截断的有损修复并显式返回 `truncated_string` 标记，
//!    在 serde 解析失败后由调用方尝试一次——有损产物绝不能当正常卡入库；
//! 6. 结构化 wrapper（`{"cards": [...]}`）的流式前缀剥离
//!    [`strip_wrapper_prefix`] 与整体展开 [`unwrap_cards_array`]，使既有
//!    brace-depth 切卡状态机在结构化协议下仍能逐卡流式产出。
//!
//! 与 providers/mod.rs 的对接（协议注入点只需生成 OpenAI Chat Completions 形态的
//! `response_format`，各适配器自行转换，详见 docs/research/anki-ai-native/round3/02）：
//! - `OpenAIAdapter`（chat_completions）：请求体原样透传，`response_format` 直达端点；
//! - `OpenAIResponsesAdapter::convert_response_format_to_text_format`：
//!   `response_format:{type:"json_schema",json_schema:{name,schema,strict}}` 扁平化为
//!   Responses 的 `text.format`；
//! - `convert_response_format_for_anthropic`：转换为 GA 形态
//!   `output_config.format = {type:"json_schema", schema:{...}}`；
//! - Gemini（adapters/gemini-openai-converter.rs）：转换为
//!   `generation_config.response_mime_type = "application/json"` + `response_schema`。

use crate::models::{AnkiGenerationOptions, FieldExtractionRule, FieldType};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

// ==================== 共享常量 ====================

/// 分隔符协议下每张卡片 JSON 之后的分隔标记。
///
/// 唯一权威定义：`build_prompt`（指令生成侧）与 `extract_card_from_buffer`
/// （解析侧）必须引用本常量，禁止再出现字面量拷贝。
pub const CARD_DELIMITER: &str = "<<<ANKI_CARD_JSON_END>>>";

/// 损坏分隔符的尾部特征（模型偶发在 `<<<` 后插入空格等杂质时的修复锚点）。
pub const BROKEN_DELIMITER_TAIL: &str = "ANKI_CARD_JSON_END>>>";

/// 结构化协议（json_object / json_schema）下响应对象的顶层数组键名。
pub const CARDS_WRAPPER_KEY: &str = "cards";

/// 多模板 schema 变体的判别字段名。
pub const TEMPLATE_ID_KEY: &str = "template_id";

/// response_format json_schema 的 name 字段。
pub const JSON_SCHEMA_NAME: &str = "anki_cards";

// ==================== 输出协议 ====================

/// Anki 流式制卡的输出协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputProtocol {
    /// 分隔符协议（历史默认，向后兼容）：逐卡输出 JSON + `CARD_DELIMITER`。
    #[default]
    Delimiter,
    /// `response_format: {"type":"json_object"}`：整个响应为一个
    /// `{"cards": [...]}` JSON 对象，不注入具体 schema。
    JsonObject,
    /// `response_format: {"type":"json_schema", ...}`：附带从
    /// FieldExtractionRule 生成的 schema，供应商侧强制约束输出结构。
    JsonSchema,
}

impl OutputProtocol {
    /// 协议的稳定字符串名（与 options JSON 中 `output_protocol` 的取值一致）。
    pub fn as_str(&self) -> &'static str {
        match self {
            OutputProtocol::Delimiter => "delimiter",
            OutputProtocol::JsonObject => "json_object",
            OutputProtocol::JsonSchema => "json_schema",
        }
    }

    /// 是否为结构化协议（需要 wrapper 剥离与 response_format 注入）。
    pub fn is_structured(&self) -> bool {
        !matches!(self, OutputProtocol::Delimiter)
    }
}

/// 协议相关扩展选项（`output_protocol` / `enable_qa_pass`）的薄投影。
///
/// 两个字段的 wire 定义单点收敛在 `models::AnkiGenerationOptions` 上；本结构体
/// 不再自带 serde 解析，仅由 [`Self::from_options_json`] 从同一份 options JSON
/// 投影出来，为流式服务提供便捷视图与 `qa_pass_enabled()` 的默认值语义。
#[derive(Debug, Clone, Default)]
pub struct StructuredOutputOptions {
    /// 请求的输出协议：`auto` / `delimiter` / `json_object` / `json_schema`。
    /// 缺省（None）等价于 `auto`。
    pub output_protocol: Option<String>,
    /// 是否启用字段 QA 校验（`_qa_flags` 留痕）。缺省 true，保持既有行为。
    pub enable_qa_pass: Option<bool>,
}

impl StructuredOutputOptions {
    /// 从任务的 anki_generation_options JSON 解析：复用
    /// `AnkiGenerationOptions` 的 serde 定义并只取两个协议字段；
    /// 解析失败回退默认值（主解析路径已对同一 JSON 做过严格校验）。
    pub fn from_options_json(raw: &str) -> Self {
        serde_json::from_str::<AnkiGenerationOptions>(raw)
            .map(|opts| Self {
                output_protocol: opts.output_protocol,
                enable_qa_pass: opts.enable_qa_pass,
            })
            .unwrap_or_default()
    }

    pub fn qa_pass_enabled(&self) -> bool {
        self.enable_qa_pass.unwrap_or(true)
    }
}

// ==================== 供应商能力探测与协议决策 ====================

/// 供应商对结构化输出的支持能力（保守判定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaCapability {
    /// 已确认支持 json_schema（含适配器侧转换，如 Anthropic/Gemini/Responses）。
    JsonSchema,
    /// 仅确认支持 json_object（如 DeepSeek 官方 chat_completions）。
    JsonObjectOnly,
    /// 未知（任意 OpenAI 兼容端点）：不得静默假设支持，auto 时回退 delimiter。
    Unknown,
}

fn normalized(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_lowercase()
}

/// 依据 ApiConfig 的关键字段保守判定结构化输出能力。
///
/// 判定依据与 providers/mod.rs 中的适配器转换能力一一对应：
/// - `anthropic_messages` / `google_generate_content` / `openai_responses`
///   协议：适配器已实现 response_format → 原生结构化输出的转换 → JsonSchema；
/// - model_adapter 为 anthropic/claude/google/gemini：build_provider_adapter
///   会选择对应原生适配器 → JsonSchema；
/// - OpenAI 官方端点（api.openai.com）：chat_completions 原生支持
///   `response_format: json_schema` → JsonSchema；
/// - DeepSeek 官方端点：文档仅承诺 `json_object` → JsonObjectOnly；
/// - 其余 OpenAI 兼容端点（自建网关 / 本地推理 / 各类中转）：Unknown。
pub fn detect_schema_capability(
    model_adapter: &str,
    api_protocol: Option<&str>,
    provider_type: Option<&str>,
    base_url: &str,
) -> SchemaCapability {
    let adapter = model_adapter.trim().to_lowercase();
    let protocol = normalized(api_protocol);
    let provider = normalized(provider_type);
    let url = base_url.trim().to_lowercase();

    // 原生协议路径：providers/mod.rs 的适配器负责 response_format 转换
    if protocol.contains("anthropic")
        || protocol.contains("google")
        || protocol.contains("gemini")
        || protocol.contains("responses")
    {
        return SchemaCapability::JsonSchema;
    }
    if matches!(
        adapter.as_str(),
        "anthropic" | "claude" | "google" | "gemini"
    ) {
        return SchemaCapability::JsonSchema;
    }
    if url.contains("api.anthropic.com") || url.contains("generativelanguage.googleapis.com") {
        return SchemaCapability::JsonSchema;
    }

    // OpenAI 官方 chat_completions 原生支持 json_schema
    if provider == "openai" || url.contains("api.openai.com") {
        return SchemaCapability::JsonSchema;
    }

    // DeepSeek 官方仅承诺 json_object
    if provider == "deepseek" || url.contains("api.deepseek.com") {
        return SchemaCapability::JsonObjectOnly;
    }

    SchemaCapability::Unknown
}

/// 协议决策：显式请求优先，`auto`（或缺省）按能力选择。
///
/// 默认策略（任务 #4）：能力确认支持 json_schema 时优先 json_schema；
/// 其余情况（含 JsonObjectOnly / Unknown）回退 delimiter——分隔符协议久经
/// 实战且解析侧带 brace-depth 兜底，json_object 仅在显式请求时使用。
///
/// 返回 `(协议, 决策原因)`，原因用于日志与调试。
pub fn resolve_output_protocol(
    requested: Option<&str>,
    capability: SchemaCapability,
) -> (OutputProtocol, &'static str) {
    match normalized(requested).as_str() {
        "delimiter" => (OutputProtocol::Delimiter, "explicit_request"),
        "json_object" => (OutputProtocol::JsonObject, "explicit_request"),
        // 显式请求 json_schema 时尊重用户选择（即使能力未知）；
        // 运行时若被端点拒绝，服务层会回退 delimiter 重试一次。
        "json_schema" => (OutputProtocol::JsonSchema, "explicit_request"),
        "" | "auto" => match capability {
            SchemaCapability::JsonSchema => (OutputProtocol::JsonSchema, "auto_capability"),
            SchemaCapability::JsonObjectOnly => {
                (OutputProtocol::Delimiter, "auto_json_object_only_fallback")
            }
            SchemaCapability::Unknown => (
                OutputProtocol::Delimiter,
                "auto_capability_unknown_fallback",
            ),
        },
        _ => (
            OutputProtocol::Delimiter,
            "unknown_requested_value_fallback",
        ),
    }
}

/// 结构化输出请求疑似被端点拒绝（协议不支持 / schema 不合法）的错误特征。
/// 服务层据此在结构化协议失败后回退 delimiter 重试一次。
pub fn is_probably_structured_output_rejection(message: &str) -> bool {
    message.contains("(HTTP 400)")
        || message.contains("(HTTP 404)")
        || message.contains("(HTTP 422)")
}

// ==================== 协议格式指令 ====================

/// 生成协议对应的输出格式指令块（build_prompt 的"重要指令"段）。
///
/// - `card_count_instruction`：卡片数量约束段（含结尾空行），由调用方组装；
/// - `fields_requirement`：字段要求描述；
/// - `example_json`：单张卡片的示例 JSON（语言中性占位，避免 few-shot 语言牵引）。
pub fn format_instructions(
    protocol: OutputProtocol,
    card_count_instruction: &str,
    fields_requirement: &str,
    example_json: &str,
) -> String {
    match protocol {
        OutputProtocol::Delimiter => format!(
            "{}\
            重要指令：\n\
            1. 请逐个生成卡片，每个卡片必须是完整的JSON格式\n\
            2. 每生成一个完整的卡片JSON后，立即输出分隔符：{delim}（包括最后一张卡片之后也必须输出分隔符）\n\
            3. JSON格式必须包含以下字段：{}\n\
            4. 不要使用Markdown代码块，直接输出JSON\n\
            5. 输出完所有卡片和最后一个分隔符后立即停止，不要输出任何总结或结束语\n\
            6. 示例输出格式：\n\
            {}\n\
            {delim}",
            card_count_instruction,
            fields_requirement,
            example_json,
            delim = CARD_DELIMITER,
        ),
        OutputProtocol::JsonObject | OutputProtocol::JsonSchema => format!(
            "{}\
            重要指令：\n\
            1. 你的完整回复必须是且仅是一个 JSON 对象，不要输出任何其他文字\n\
            2. 该对象只有一个键 \"{wrapper}\"，其值为卡片对象数组\n\
            3. 每个卡片对象必须包含以下字段：{}\n\
            4. 不要使用Markdown代码块，不要输出任何分隔符，直接输出 JSON\n\
            5. 输出完该 JSON 对象后立即停止，不要输出任何总结或结束语\n\
            6. 示例输出格式：\n\
            {{\"{wrapper}\": [{}]}}",
            card_count_instruction,
            fields_requirement,
            example_json,
            wrapper = CARDS_WRAPPER_KEY,
        ),
    }
}

// ==================== 多模板判定 ====================

/// 是否为多模板生成场景（build_prompt 与 parse_and_save_card 共用的唯一判定）。
///
/// 四个来源任一按模板分组的集合含 >1 个条目即视为多模板。
pub fn is_multi_template(options: &AnkiGenerationOptions) -> bool {
    options
        .template_descriptions
        .as_ref()
        .map(|descriptions| descriptions.len() > 1)
        .unwrap_or(false)
        || options
            .template_ids
            .as_ref()
            .map(|ids| ids.len() > 1)
            .unwrap_or(false)
        || options
            .template_fields_by_id
            .as_ref()
            .map(|fields| fields.len() > 1)
            .unwrap_or(false)
        || options
            .field_extraction_rules_by_id
            .as_ref()
            .map(|rules| rules.len() > 1)
            .unwrap_or(false)
}

// ==================== JSON Schema 生成 ====================

/// FieldType → JSON Schema 基础类型名。
fn json_type_for_field(field_type: &FieldType) -> &'static str {
    match field_type {
        FieldType::Array => "array",
        FieldType::Number => "number",
        FieldType::Boolean => "boolean",
        // Text / Date / RichText / Formula 在 Anki 侧均为文本
        _ => "string",
    }
}

/// 在规则表中按名称查规则（先精确，再大小写不敏感），与解析侧行为一致。
fn find_rule_for_schema<'a>(
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

/// 由单个字段规则生成该字段的 JSON Schema 片段（type / enum / 长度约束 / 描述）。
fn build_field_schema(field: &str, rule: Option<&FieldExtractionRule>) -> Value {
    let mut schema = Map::new();

    let type_name = match rule.map(|r| &r.field_type) {
        Some(t) => json_type_for_field(t),
        // 无规则时的历史默认：tags 是字符串数组，其余是字符串
        None if field.eq_ignore_ascii_case("tags") => "array",
        None => "string",
    };
    schema.insert("type".to_string(), json!(type_name));

    let enum_values = rule
        .and_then(|r| r.allowed_values.as_ref())
        .filter(|values| !values.is_empty())
        .cloned();

    if type_name == "array" {
        let mut items = Map::new();
        items.insert("type".to_string(), json!("string"));
        if let Some(values) = enum_values {
            items.insert("enum".to_string(), Value::Array(values));
        }
        schema.insert("items".to_string(), Value::Object(items));
    } else if let Some(values) = enum_values {
        schema.insert("enum".to_string(), Value::Array(values));
    }

    if type_name == "string" {
        if let Some(min) = rule.and_then(|r| r.min_length) {
            schema.insert("minLength".to_string(), json!(min));
        }
        if let Some(max) = rule.and_then(|r| r.max_length) {
            schema.insert("maxLength".to_string(), json!(max));
        }
    }

    let description = rule
        .map(|r| r.description.trim())
        .filter(|d| !d.is_empty())
        .map(str::to_string)
        .or_else(|| {
            rule.and_then(|r| r.ai_hint.as_deref())
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(str::to_string)
        });
    if let Some(desc) = description {
        schema.insert("description".to_string(), json!(desc));
    }

    Value::Object(schema)
}

/// 字段是否必填（有规则按规则，无规则回退历史默认：front/back 必填）。
fn field_is_required(field: &str, rule: Option<&FieldExtractionRule>) -> bool {
    match rule {
        Some(r) => r.is_required,
        None => field.eq_ignore_ascii_case("front") || field.eq_ignore_ascii_case("back"),
    }
}

/// 生成单张卡片对象的 schema。
///
/// - `fields`：模板字段清单（决定 properties 的键集合与顺序来源）；
/// - `rules`：字段提取规则（决定 required / type / enum / 长度约束）；
/// - `template_id`：Some 时注入 `template_id` 判别字段（enum 单值，兼容
///   Gemini 的 OpenAPI 子集——其对 `const` 支持不佳）并加入 required。
pub fn build_card_schema(
    fields: &[String],
    rules: Option<&HashMap<String, FieldExtractionRule>>,
    template_id: Option<&str>,
) -> Value {
    let mut properties = Map::new();
    let mut required: Vec<Value> = Vec::new();

    if let Some(id) = template_id {
        properties.insert(
            TEMPLATE_ID_KEY.to_string(),
            json!({ "type": "string", "enum": [id] }),
        );
        required.push(json!(TEMPLATE_ID_KEY));
    }

    for field in fields {
        let rule = find_rule_for_schema(rules, field);
        properties.insert(field.clone(), build_field_schema(field, rule));
        if field_is_required(field, rule) {
            required.push(json!(field));
        }
    }

    // 规则表中存在但字段清单未列出的字段（规则是解析侧的权威来源）也纳入 schema，
    // 避免模型输出被 additionalProperties:false 误伤。
    if let Some(rules_map) = rules {
        let mut extra_keys: Vec<&String> = rules_map
            .keys()
            .filter(|key| !fields.iter().any(|f| f.eq_ignore_ascii_case(key)))
            .collect();
        extra_keys.sort(); // HashMap 迭代序不稳定，排序保证 schema 确定性
        for key in extra_keys {
            let rule = rules_map.get(key.as_str());
            properties.insert(key.clone(), build_field_schema(key, rule));
            if rule.map(|r| r.is_required).unwrap_or(false) {
                required.push(json!(key.clone()));
            }
        }
    }

    json!({
        "type": "object",
        "properties": Value::Object(properties),
        "required": Value::Array(required),
        "additionalProperties": false,
    })
}

/// 解析单模板场景下的字段清单（与 build_prompt 的历史解析逻辑一致）。
fn resolve_single_template_fields(options: &AnkiGenerationOptions) -> Vec<String> {
    options
        .template_fields
        .clone()
        .or_else(|| {
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
        })
        .unwrap_or_else(|| vec!["front".to_string(), "back".to_string(), "tags".to_string()])
}

/// 解析单模板场景下的字段规则（与 build_prompt 的历史解析逻辑一致）。
fn resolve_single_template_rules(
    options: &AnkiGenerationOptions,
) -> Option<&HashMap<String, FieldExtractionRule>> {
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
    })
}

/// 生成整个响应的 wrapper schema：`{"cards": [<单卡 schema 或多模板 oneOf>]}`。
///
/// 多模板：以 `template_fields_by_id`（回退 `template_descriptions.fields`）为
/// 字段来源、`field_extraction_rules_by_id` 为规则来源，逐模板生成变体并以
/// `oneOf` 组合，每个变体携带 `template_id` 判别字段。
/// 无法收集到任何模板字段信息时返回 None（调用方降级 json_object）。
pub fn build_cards_response_schema(options: &AnkiGenerationOptions) -> Option<Value> {
    let card_schema = if is_multi_template(options) {
        // 收集模板 ID 顺序：优先 descriptions（携带展示顺序），回退 fields_by_id 键
        let mut template_ids: Vec<String> = Vec::new();
        if let Some(descriptions) = options.template_descriptions.as_ref() {
            template_ids.extend(descriptions.iter().map(|t| t.id.clone()));
        }
        if let Some(ids) = options.template_ids.as_ref() {
            for id in ids {
                if !template_ids.contains(id) {
                    template_ids.push(id.clone());
                }
            }
        }
        if let Some(fields_by_id) = options.template_fields_by_id.as_ref() {
            let mut keys: Vec<&String> = fields_by_id.keys().collect();
            keys.sort();
            for key in keys {
                if !template_ids.contains(key) {
                    template_ids.push(key.clone());
                }
            }
        }

        let mut variants: Vec<Value> = Vec::new();
        for template_id in &template_ids {
            let fields: Option<Vec<String>> = options
                .template_fields_by_id
                .as_ref()
                .and_then(|by_id| by_id.get(template_id).cloned())
                .or_else(|| {
                    options.template_descriptions.as_ref().and_then(|ds| {
                        ds.iter()
                            .find(|t| &t.id == template_id)
                            .map(|t| t.fields.clone())
                    })
                });
            let Some(fields) = fields.filter(|f| !f.is_empty()) else {
                continue; // 字段未知的模板无法生成变体，跳过
            };
            let rules = options
                .field_extraction_rules_by_id
                .as_ref()
                .and_then(|by_id| by_id.get(template_id));
            variants.push(build_card_schema(&fields, rules, Some(template_id)));
        }

        if variants.is_empty() {
            return None;
        }
        if variants.len() == 1 {
            variants.into_iter().next().unwrap()
        } else {
            json!({ "oneOf": variants })
        }
    } else {
        let fields = resolve_single_template_fields(options);
        let rules = resolve_single_template_rules(options);
        build_card_schema(&fields, rules, None)
    };

    Some(json!({
        "type": "object",
        "properties": {
            CARDS_WRAPPER_KEY: {
                "type": "array",
                "items": card_schema,
            }
        },
        "required": [CARDS_WRAPPER_KEY],
        "additionalProperties": false,
    }))
}

/// 按协议生成注入 request_body 的 `response_format` 值（OpenAI CC 形态，
/// 各 provider 适配器负责转换为原生形态）。
///
/// - Delimiter → None（保持现状，不注入）；
/// - JsonObject → `{"type":"json_object"}`；
/// - JsonSchema → `{"type":"json_schema","json_schema":{name,schema,strict:false}}`；
///   schema 无法生成（无任何模板字段信息）时降级 json_object。
///   `strict` 取 false：strict 模式要求所有属性必填（可选字段须以 union null
///   表达），与模板"可选字段"语义冲突，且部分中转不支持 strict。
pub fn build_response_format(
    protocol: OutputProtocol,
    options: &AnkiGenerationOptions,
) -> Option<Value> {
    match protocol {
        OutputProtocol::Delimiter => None,
        OutputProtocol::JsonObject => Some(json!({ "type": "json_object" })),
        OutputProtocol::JsonSchema => match build_cards_response_schema(options) {
            Some(schema) => Some(json!({
                "type": "json_schema",
                "json_schema": {
                    "name": JSON_SCHEMA_NAME,
                    "schema": schema,
                    "strict": false,
                }
            })),
            None => Some(json!({ "type": "json_object" })),
        },
    }
}

// ==================== 结构化 wrapper 的流式处理 ====================

/// 剥离结构化响应的 wrapper 前缀 `{"cards": [`（含任意空白变体）。
///
/// 结构化协议下整个响应是一个 `{"cards": [...]}` 对象；剥掉前缀后，数组内的
/// 每个卡片对象即成为"顶层对象"，既有 brace-depth 切卡状态机可原样逐卡切出，
/// 保住逐卡流式产出的首卡延迟。收尾残留的 `]}` 不含 `{`，由既有收尾逻辑
/// 当作非卡片内容静默丢弃。
///
/// 仅在完整前缀已到达时才剥离并返回 true；前缀尚不完整（跨 chunk 传输中）或
/// 内容根本不是 wrapper 形态时不动缓冲返回 false，可安全地每 chunk 重复调用。
pub fn strip_wrapper_prefix(buffer: &mut String) -> bool {
    let bytes = buffer.as_bytes();
    let mut pos = 0usize;

    let skip_ws = |bytes: &[u8], pos: &mut usize| {
        while *pos < bytes.len() && bytes[*pos].is_ascii_whitespace() {
            *pos += 1;
        }
    };

    skip_ws(bytes, &mut pos);
    if pos >= bytes.len() || bytes[pos] != b'{' {
        return false;
    }
    pos += 1;
    skip_ws(bytes, &mut pos);

    let key = format!("\"{}\"", CARDS_WRAPPER_KEY);
    let key_bytes = key.as_bytes();
    if bytes.len() < pos + key_bytes.len() {
        // 前缀可能尚未完整到达：不剥离，等待后续 chunk
        return false;
    }
    if &bytes[pos..pos + key_bytes.len()] != key_bytes {
        return false;
    }
    pos += key_bytes.len();
    skip_ws(bytes, &mut pos);
    if pos >= bytes.len() || bytes[pos] != b':' {
        return false;
    }
    pos += 1;
    skip_ws(bytes, &mut pos);
    if pos >= bytes.len() || bytes[pos] != b'[' {
        return false;
    }
    pos += 1;

    buffer.drain(..pos);
    true
}

/// 若值为 `{"cards": [...]}` wrapper，返回其中的卡片数组。
pub fn unwrap_cards_array(value: &Value) -> Option<&Vec<Value>> {
    value.as_object()?.get(CARDS_WRAPPER_KEY)?.as_array()
}

// ==================== 轻量 JSON 修复 ====================

/// [`repair_json_detailed`] 的修复结果。
///
/// `truncated_string == true` 表示输入在 JSON 字符串中途被截断，修复补写了
/// 收尾引号——此时字段内容**已经丢失**，修复产物只是语法合法，绝不能当作
/// 完整卡片入库（0824 评审 #3：截断残卡必须落错误卡或携带可见 repair 标记）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepairedJson {
    /// 修复后的 JSON 文本（保证可被 serde 解析）。
    pub text: String,
    /// 输入是否在字符串中途截断（有损修复）。
    pub truncated_string: bool,
}

/// 轻量 JSON 修复（含有损形态检测）：serde 解析失败后由调用方尝试一次。
///
/// 修复策略（保守，只处理流式截断/模型笔误的高频形态）：
/// 1. 截去已配平的顶层对象之后的尾部垃圾（如结构化收尾残留 `]}`）；
/// 2. 删除 `}` / `]` 前的尾逗号；
/// 3. 输入在字符串中途截断时补上收尾引号，并置 `truncated_string = true`
///    （有损：截断处之后的字段内容已丢失，调用方必须显式处理）；
/// 4. 依据未闭合的括号栈按序补齐 `}` / `]`。
///
/// 仅当修复结果能被 serde 成功解析时返回 Some；否则返回 None（调用方保留
/// 原始错误语义，不引入静默数据损坏）。
pub fn repair_json_detailed(raw: &str) -> Option<RepairedJson> {
    let trimmed = raw.trim();
    // 定位首个 '{'，丢弃对象前的自然语言前缀
    let start = trimmed.find('{')?;
    let s = &trimmed[start..];

    let mut out = String::with_capacity(s.len() + 8);
    let mut stack: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut escape = false;

    for c in s.chars() {
        if in_string {
            out.push(c);
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
            '"' => {
                in_string = true;
                out.push(c);
            }
            '{' | '[' => {
                stack.push(c);
                out.push(c);
            }
            '}' | ']' => {
                // 去尾逗号：闭合符前的最后一个有效字符若是逗号则删除
                while out.trim_end().ends_with(',') {
                    let trimmed_len = out.trim_end().len();
                    out.truncate(trimmed_len - 1);
                }
                stack.pop();
                out.push(c);
                if stack.is_empty() {
                    // 顶层对象已配平：截去其后的尾部垃圾
                    break;
                }
            }
            _ => out.push(c),
        }
    }

    // 字符串中途截断：补收尾引号（有损，必须向调用方暴露）
    let truncated_string = in_string;
    if in_string {
        if escape {
            // 悬空反斜杠会让补的引号变成转义引号，先移除
            out.pop();
        }
        out.push('"');
    }

    // 去掉截断处遗留的尾逗号（例如 `{"a":1,` 截断）
    while out.trim_end().ends_with(',') {
        let trimmed_len = out.trim_end().len();
        out.truncate(trimmed_len - 1);
    }

    // 按未闭合栈逆序补齐闭合符
    while let Some(open) = stack.pop() {
        out.push(if open == '{' { '}' } else { ']' });
    }

    if serde_json::from_str::<Value>(&out).is_ok() {
        Some(RepairedJson {
            text: out,
            truncated_string,
        })
    } else {
        None
    }
}

/// 无损 JSON 修复：只处理可证明不损失字段内容的形态
/// （尾逗号、对象前后的外围垃圾、已闭合字符串之后的缺失括号）。
///
/// 字符串中途截断视为**不可无损修复**，返回 None——调用方应将该内容降级为
/// 错误卡而不是静默补成正常卡（需要区分有损形态时用 [`repair_json_detailed`]）。
pub fn repair_json(raw: &str) -> Option<String> {
    repair_json_detailed(raw)
        .filter(|repair| !repair.truncated_string)
        .map(|repair| repair.text)
}

// ==================== 单元测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

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

    fn empty_options() -> AnkiGenerationOptions {
        serde_json::from_value(json!({
            "deck_name": "默认",
            "note_type": "Basic",
            "enable_images": false,
            "max_cards_per_mistake": 10
        }))
        .expect("minimal options must deserialize")
    }

    // -------------------- 常量一致性 --------------------

    #[test]
    fn delimiter_constants_are_consistent() {
        // 损坏分隔符尾部必须是标准分隔符的真后缀，且标准分隔符以 <<< 开头，
        // 否则解析侧的修复锚点会失配
        assert!(CARD_DELIMITER.ends_with(BROKEN_DELIMITER_TAIL));
        assert!(CARD_DELIMITER.starts_with("<<<"));
        assert_ne!(CARD_DELIMITER, BROKEN_DELIMITER_TAIL);
    }

    // -------------------- 协议指令 --------------------

    #[test]
    fn delimiter_instructions_reference_shared_constant() {
        let text =
            format_instructions(OutputProtocol::Delimiter, "数量段\n\n", "front、back", "{}");
        assert!(text.contains(CARD_DELIMITER));
        assert!(text.contains("数量段"));
        assert!(text.contains("front、back"));
    }

    #[test]
    fn structured_instructions_use_wrapper_and_omit_delimiter() {
        for protocol in [OutputProtocol::JsonObject, OutputProtocol::JsonSchema] {
            let text =
                format_instructions(protocol, "", "front、back", "{\"front\": \"<question>\"}");
            assert!(
                !text.contains(CARD_DELIMITER),
                "structured instructions must not mention delimiter: {text}"
            );
            assert!(text.contains(&format!("\"{}\"", CARDS_WRAPPER_KEY)));
            assert!(text.contains("{\"cards\": [{\"front\": \"<question>\"}]}"));
        }
    }

    // -------------------- 协议决策 --------------------

    #[test]
    fn auto_prefers_json_schema_when_capable() {
        let (protocol, reason) = resolve_output_protocol(None, SchemaCapability::JsonSchema);
        assert_eq!(protocol, OutputProtocol::JsonSchema);
        assert_eq!(reason, "auto_capability");

        let (protocol, _) = resolve_output_protocol(Some("auto"), SchemaCapability::JsonSchema);
        assert_eq!(protocol, OutputProtocol::JsonSchema);
    }

    #[test]
    fn auto_falls_back_to_delimiter_when_capability_unknown() {
        let (protocol, reason) = resolve_output_protocol(None, SchemaCapability::Unknown);
        assert_eq!(protocol, OutputProtocol::Delimiter);
        assert_eq!(reason, "auto_capability_unknown_fallback");

        // 仅确认 json_object 的供应商同样回退 delimiter（json_object 需显式请求）
        let (protocol, _) = resolve_output_protocol(None, SchemaCapability::JsonObjectOnly);
        assert_eq!(protocol, OutputProtocol::Delimiter);
    }

    #[test]
    fn explicit_request_overrides_capability() {
        let (protocol, reason) =
            resolve_output_protocol(Some("json_schema"), SchemaCapability::Unknown);
        assert_eq!(protocol, OutputProtocol::JsonSchema);
        assert_eq!(reason, "explicit_request");

        let (protocol, _) =
            resolve_output_protocol(Some("delimiter"), SchemaCapability::JsonSchema);
        assert_eq!(protocol, OutputProtocol::Delimiter);

        let (protocol, _) = resolve_output_protocol(Some("json_object"), SchemaCapability::Unknown);
        assert_eq!(protocol, OutputProtocol::JsonObject);

        // 非法取值保守回退 delimiter
        let (protocol, reason) =
            resolve_output_protocol(Some("yaml"), SchemaCapability::JsonSchema);
        assert_eq!(protocol, OutputProtocol::Delimiter);
        assert_eq!(reason, "unknown_requested_value_fallback");
    }

    #[test]
    fn capability_detection_matches_provider_adapters() {
        // 原生协议 / 官方端点 → JsonSchema
        assert_eq!(
            detect_schema_capability("general", Some("anthropic_messages"), None, ""),
            SchemaCapability::JsonSchema
        );
        assert_eq!(
            detect_schema_capability("gemini", None, None, ""),
            SchemaCapability::JsonSchema
        );
        assert_eq!(
            detect_schema_capability("general", None, Some("openai"), "https://api.openai.com/v1"),
            SchemaCapability::JsonSchema
        );
        assert_eq!(
            detect_schema_capability("general", Some("openai_responses"), None, ""),
            SchemaCapability::JsonSchema
        );
        // DeepSeek 官方 → 仅 json_object
        assert_eq!(
            detect_schema_capability("general", None, None, "https://api.deepseek.com/v1"),
            SchemaCapability::JsonObjectOnly
        );
        // 任意 OpenAI 兼容端点 → 未知，不得静默假设支持
        assert_eq!(
            detect_schema_capability(
                "general",
                Some("openai_chat_completions"),
                None,
                "https://my-gateway.example.com/v1"
            ),
            SchemaCapability::Unknown
        );
    }

    // -------------------- schema 生成 --------------------

    #[test]
    fn card_schema_maps_types_required_and_enum() {
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert(
            "front".to_string(),
            make_rule(true, FieldType::Text, "问题"),
        );
        let mut correct = make_rule(true, FieldType::Text, "正确选项");
        correct.allowed_values = Some(vec![json!("A"), json!("B"), json!("C"), json!("D")]);
        rules.insert("correct".to_string(), correct);
        rules.insert(
            "tags".to_string(),
            make_rule(false, FieldType::Array, "标签"),
        );
        rules.insert(
            "score".to_string(),
            make_rule(false, FieldType::Number, "分值"),
        );

        let fields = vec![
            "front".to_string(),
            "correct".to_string(),
            "tags".to_string(),
            "score".to_string(),
        ];
        let schema = build_card_schema(&fields, Some(&rules), None);

        assert_eq!(schema["type"], json!("object"));
        assert_eq!(schema["properties"]["front"]["type"], json!("string"));
        assert_eq!(
            schema["properties"]["correct"]["enum"],
            json!(["A", "B", "C", "D"])
        );
        assert_eq!(schema["properties"]["tags"]["type"], json!("array"));
        assert_eq!(
            schema["properties"]["tags"]["items"]["type"],
            json!("string")
        );
        assert_eq!(schema["properties"]["score"]["type"], json!("number"));
        assert_eq!(schema["additionalProperties"], json!(false));

        let required: Vec<&str> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(required.contains(&"front"));
        assert!(required.contains(&"correct"));
        assert!(!required.contains(&"tags"));
        assert!(!required.contains(&"score"));
    }

    #[test]
    fn card_schema_carries_length_constraints_and_description() {
        let mut front = make_rule(true, FieldType::Text, "问题或概念");
        front.min_length = Some(2);
        front.max_length = Some(100);
        let mut rules: HashMap<String, FieldExtractionRule> = HashMap::new();
        rules.insert("front".to_string(), front);

        let schema = build_card_schema(&["front".to_string()], Some(&rules), None);
        assert_eq!(schema["properties"]["front"]["minLength"], json!(2));
        assert_eq!(schema["properties"]["front"]["maxLength"], json!(100));
        assert_eq!(
            schema["properties"]["front"]["description"],
            json!("问题或概念")
        );
    }

    #[test]
    fn card_schema_without_rules_uses_historic_defaults() {
        let fields = vec!["front".to_string(), "back".to_string(), "tags".to_string()];
        let schema = build_card_schema(&fields, None, None);
        // 历史默认：front/back 必填字符串，tags 可选字符串数组
        assert_eq!(schema["properties"]["tags"]["type"], json!("array"));
        assert_eq!(schema["required"], json!(["front", "back"]));
    }

    #[test]
    fn multi_template_schema_uses_oneof_with_template_id_discriminator() {
        let mut fields_by_id: HashMap<String, Vec<String>> = HashMap::new();
        fields_by_id.insert(
            "design-lab".to_string(),
            vec!["question".to_string(), "answer".to_string()],
        );
        fields_by_id.insert("design-glass".to_string(), vec!["text".to_string()]);

        let mut rules_by_id: HashMap<String, HashMap<String, FieldExtractionRule>> = HashMap::new();
        let mut lab_rules = HashMap::new();
        lab_rules.insert(
            "question".to_string(),
            make_rule(true, FieldType::Text, "题干"),
        );
        lab_rules.insert(
            "answer".to_string(),
            make_rule(true, FieldType::Text, "答案"),
        );
        rules_by_id.insert("design-lab".to_string(), lab_rules);
        let mut glass_rules = HashMap::new();
        glass_rules.insert(
            "text".to_string(),
            make_rule(true, FieldType::Text, "填空文本"),
        );
        rules_by_id.insert("design-glass".to_string(), glass_rules);

        let mut options = empty_options();
        options.template_fields_by_id = Some(fields_by_id);
        options.field_extraction_rules_by_id = Some(rules_by_id);

        assert!(is_multi_template(&options));
        let schema = build_cards_response_schema(&options).expect("schema");
        let items = &schema["properties"][CARDS_WRAPPER_KEY]["items"];
        let variants = items["oneOf"].as_array().expect("oneOf variants");
        assert_eq!(variants.len(), 2);
        for variant in variants {
            let template_enum = variant["properties"][TEMPLATE_ID_KEY]["enum"]
                .as_array()
                .expect("template_id enum");
            assert_eq!(template_enum.len(), 1);
            let required: Vec<&str> = variant["required"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            assert!(required.contains(&TEMPLATE_ID_KEY));
        }
    }

    #[test]
    fn response_format_shapes_per_protocol() {
        let options = empty_options();

        assert!(build_response_format(OutputProtocol::Delimiter, &options).is_none());

        let json_object = build_response_format(OutputProtocol::JsonObject, &options).unwrap();
        assert_eq!(json_object, json!({ "type": "json_object" }));

        // 与 providers/mod.rs 各转换函数约定的 CC 形态完全一致：
        // {type:"json_schema", json_schema:{name,schema,strict}}
        let json_schema = build_response_format(OutputProtocol::JsonSchema, &options).unwrap();
        assert_eq!(json_schema["type"], json!("json_schema"));
        assert_eq!(json_schema["json_schema"]["name"], json!(JSON_SCHEMA_NAME));
        assert_eq!(json_schema["json_schema"]["strict"], json!(false));
        let schema = &json_schema["json_schema"]["schema"];
        assert_eq!(schema["required"], json!([CARDS_WRAPPER_KEY]));
        assert_eq!(
            schema["properties"][CARDS_WRAPPER_KEY]["type"],
            json!("array")
        );
    }

    // -------------------- is_multi_template --------------------

    #[test]
    fn is_multi_template_detects_all_sources() {
        let options = empty_options();
        assert!(!is_multi_template(&options));

        let mut by_ids = empty_options();
        by_ids.template_ids = Some(vec!["a".to_string(), "b".to_string()]);
        assert!(is_multi_template(&by_ids));

        let mut single_id = empty_options();
        single_id.template_ids = Some(vec!["a".to_string()]);
        assert!(!is_multi_template(&single_id));

        let mut by_rules = empty_options();
        let mut rules_by_id = HashMap::new();
        rules_by_id.insert("a".to_string(), HashMap::new());
        rules_by_id.insert("b".to_string(), HashMap::new());
        by_rules.field_extraction_rules_by_id = Some(rules_by_id);
        assert!(is_multi_template(&by_rules));
    }

    // -------------------- json repair --------------------

    #[test]
    fn repair_removes_trailing_comma() {
        let repaired = repair_json("{\"front\": \"Q\", \"back\": \"A\",}").expect("repairable");
        let value: Value = serde_json::from_str(&repaired).unwrap();
        assert_eq!(value["back"], json!("A"));

        let repaired = repair_json("{\"tags\": [\"a\", \"b\",]}").expect("repairable");
        let value: Value = serde_json::from_str(&repaired).unwrap();
        assert_eq!(value["tags"], json!(["a", "b"]));
    }

    #[test]
    fn repair_closes_missing_brackets() {
        // 已闭合字符串之后的缺失括号：无损修复，允许自动修复
        let repaired = repair_json("{\"front\": \"Q\", \"tags\": [\"a\"").expect("repairable");
        let value: Value = serde_json::from_str(&repaired).unwrap();
        assert_eq!(value["tags"], json!(["a"]));
    }

    #[test]
    fn repair_refuses_silent_fix_for_mid_string_truncation() {
        // 字符串中途截断：内容已丢失，无损修复接口必须拒绝（0824 评审 #3）
        assert!(repair_json("{\"front\": \"未闭合").is_none());
        assert!(repair_json("{\"front\": \"Q\", \"back\": \"答案被截").is_none());

        // detailed 接口仍可修出语法合法的 JSON，但必须携带 truncated_string 标记
        let detailed = repair_json_detailed("{\"front\": \"未闭合").expect("detailed repairable");
        assert!(detailed.truncated_string);
        let value: Value = serde_json::from_str(&detailed.text).unwrap();
        assert_eq!(value["front"], json!("未闭合"));

        // 悬空转义反斜杠同属字符串中途截断
        let dangling = repair_json_detailed("{\"front\": \"abc\\").expect("dangling escape");
        assert!(dangling.truncated_string);

        // 无损形态经 detailed 接口不得误标截断
        let lossless =
            repair_json_detailed("{\"front\": \"Q\", \"back\": \"A\",}").expect("lossless");
        assert!(!lossless.truncated_string);
    }

    #[test]
    fn repair_trims_trailing_garbage_after_balanced_object() {
        // 结构化收尾残留 `]}` 场景
        let repaired = repair_json("{\"front\": \"Q\", \"back\": \"A\"}]}").expect("repairable");
        let value: Value = serde_json::from_str(&repaired).unwrap();
        assert_eq!(value["front"], json!("Q"));
    }

    #[test]
    fn repair_returns_none_for_hopeless_input() {
        assert!(repair_json("no json here").is_none());
        assert!(repair_json("").is_none());
    }

    #[test]
    fn repair_does_not_touch_delimiter_text_inside_strings() {
        let raw = format!(
            "{{\"front\": \"包含 {} 的文本\", \"back\": \"A\"",
            CARD_DELIMITER
        );
        let repaired = repair_json(&raw).expect("repairable");
        let value: Value = serde_json::from_str(&repaired).unwrap();
        assert!(value["front"].as_str().unwrap().contains(CARD_DELIMITER));
    }

    // -------------------- wrapper 流式剥离 / 展开 --------------------

    #[test]
    fn strip_wrapper_prefix_only_when_complete() {
        let mut buffer = "{\"cards\": [{\"front\": \"Q\"}".to_string();
        assert!(strip_wrapper_prefix(&mut buffer));
        assert_eq!(buffer, "{\"front\": \"Q\"}");

        // 前缀不完整：等待，不破坏缓冲
        let mut partial = "{\"ca".to_string();
        assert!(!strip_wrapper_prefix(&mut partial));
        assert_eq!(partial, "{\"ca");

        // 非 wrapper 形态：不动
        let mut plain = "{\"front\": \"Q\"}".to_string();
        assert!(!strip_wrapper_prefix(&mut plain));
        assert_eq!(plain, "{\"front\": \"Q\"}");

        // 空白变体
        let mut spaced = "  {\n  \"cards\" : [\n{\"a\":1}".to_string();
        assert!(strip_wrapper_prefix(&mut spaced));
        assert_eq!(spaced.trim_start(), "{\"a\":1}");
    }

    #[test]
    fn unwrap_cards_array_extracts_wrapper_items() {
        let wrapper = json!({ "cards": [{"front": "Q1"}, {"front": "Q2"}] });
        let cards = unwrap_cards_array(&wrapper).expect("cards array");
        assert_eq!(cards.len(), 2);

        assert!(unwrap_cards_array(&json!({"front": "Q"})).is_none());
        assert!(unwrap_cards_array(&json!({"cards": "not array"})).is_none());
        assert!(unwrap_cards_array(&json!("scalar")).is_none());
    }

    // -------------------- StructuredOutputOptions --------------------

    #[test]
    fn structured_options_parse_from_options_json() {
        let opts = StructuredOutputOptions::from_options_json(
            r#"{"deck_name":"d","note_type":"Basic","enable_images":false,
               "max_cards_per_mistake":5,"output_protocol":"json_schema","enable_qa_pass":false}"#,
        );
        assert_eq!(opts.output_protocol.as_deref(), Some("json_schema"));
        assert!(!opts.qa_pass_enabled());

        // 旧版 options（无扩展字段）：默认 auto + QA 开
        let legacy = StructuredOutputOptions::from_options_json(
            r#"{"deck_name":"d","note_type":"Basic","enable_images":false,"max_cards_per_mistake":5}"#,
        );
        assert!(legacy.output_protocol.is_none());
        assert!(legacy.qa_pass_enabled());

        // 非法 JSON 回退默认
        let broken = StructuredOutputOptions::from_options_json("not json");
        assert!(broken.output_protocol.is_none());
        assert!(broken.qa_pass_enabled());

        // 非完整 AnkiGenerationOptions（缺必填字段）同样回退默认：
        // 解析单点收敛后不再对残缺 JSON 做宽松字段提取。
        let partial =
            StructuredOutputOptions::from_options_json(r#"{"output_protocol":"json_schema"}"#);
        assert!(partial.output_protocol.is_none());
        assert!(partial.qa_pass_enabled());
    }
}
