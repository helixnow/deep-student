//! 模板设计师工具执行器
//!
//! 支持通过 Chat V2 对模板库进行列举、读取、校验、创建、更新、分叉、预览和删除。
//!
//! 工具：
//! - `builtin-template_list`：列出模板摘要
//! - `builtin-template_get`：获取完整模板
//! - `builtin-template_validate`：校验模板定义
//! - `builtin-template_create`：校验并创建新模板
//! - `builtin-template_update`：更新已有模板（乐观锁）
//! - `builtin-template_fork`：从已有模板分叉
//! - `builtin-template_preview`：预览模板渲染
//! - `builtin-template_delete`：删除用户自定义模板（不可删除内置模板）

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::chatanki_executor::{
    calculate_complexity_level, ensure_field_extraction_rules, import_builtin_templates_if_empty,
    normalize_template_fields,
};
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::models::{CreateTemplateRequest, FieldExtractionRule, UpdateTemplateRequest};

// ============================================================================
// 工具名常量
// ============================================================================

const TEMPLATE_TOOLS: &[&str] = &[
    "template_list",
    "template_get",
    "template_validate",
    "template_create",
    "template_update",
    "template_fork",
    "template_preview",
    "template_delete",
];

// ============================================================================
// Args
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateListArgs {
    #[serde(default = "default_true")]
    active_only: bool,
    #[serde(default)]
    builtin_only: Option<bool>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateGetArgs {
    #[serde(alias = "template_id")]
    template_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateValidateArgs {
    #[serde(alias = "templateDefinition", alias = "template_definition")]
    template: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateCreateArgs {
    #[serde(alias = "templateDefinition", alias = "template_definition")]
    template: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateUpdateArgs {
    #[serde(alias = "template_id")]
    template_id: String,
    #[serde(default)]
    patch: Option<Value>,
    #[serde(default, alias = "templateDefinition", alias = "template_definition")]
    template: Option<Value>,
    #[serde(default, alias = "expected_version")]
    expected_version: Option<String>,
    #[serde(flatten)]
    extra: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateForkArgs {
    #[serde(
        alias = "source_template_id",
        alias = "templateId",
        alias = "template_id"
    )]
    source_template_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default = "default_true")]
    set_active: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplatePreviewArgs {
    #[serde(default)]
    #[serde(alias = "template_id")]
    template_id: Option<String>,
    #[serde(default)]
    template: Option<Value>,
    #[serde(default)]
    sample_data: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateDeleteArgs {
    #[serde(alias = "template_id")]
    template_id: String,
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 返回 JSON Value 的类型标签（用于错误提示）
fn value_type_label(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

// ============================================================================
// Executor
// ============================================================================

pub struct TemplateDesignerExecutor;

impl TemplateDesignerExecutor {
    pub fn new() -> Self {
        Self
    }

    fn is_template_tool(tool_name: &str) -> bool {
        let stripped = strip_tool_namespace(tool_name);
        TEMPLATE_TOOLS.contains(&stripped)
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// 获取数据库引用（优先 main_db，回退 anki_db）
    fn get_db(
        ctx: &ExecutionContext,
    ) -> Result<&std::sync::Arc<crate::database::Database>, String> {
        ctx.main_db
            .as_ref()
            .or(ctx.anki_db.as_ref())
            .ok_or_else(|| "数据库不可用，请稍后重试或检查应用状态".to_string())
    }

    /// 发射错误并返回 failure ToolResultInfo
    fn emit_failure(
        call: &ToolCall,
        ctx: &ExecutionContext,
        error_msg: &str,
        start_time: Instant,
    ) -> ToolResultInfo {
        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emitter
            .emit_error(event_types::TOOL_CALL, &ctx.block_id, error_msg, None);
        let result = ToolResultInfo::failure(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            error_msg.to_string(),
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        result
    }

    /// 发射成功并返回 success ToolResultInfo
    fn emit_success(
        call: &ToolCall,
        ctx: &ExecutionContext,
        output: Value,
        start_time: Instant,
    ) -> ToolResultInfo {
        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({ "result": output, "durationMs": duration_ms })),
            None,
        );
        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        result
    }

    /// 双通道发射成功：前端拿完整可视化数据，LLM 只拿精简摘要
    ///
    /// - `output_for_display`: 完整数据（含 HTML/CSS），通过 emit_end 发给前端，
    ///   同时写入数据库 tool_output（供刷新后恢复渲染）
    /// - `output_for_model`: 精简摘要（不含 HTML/CSS），作为 tool_result 回传给 LLM
    fn emit_success_visual(
        call: &ToolCall,
        ctx: &ExecutionContext,
        output_for_display: Value,
        output_for_model: Value,
        start_time: Instant,
    ) -> ToolResultInfo {
        let duration_ms = start_time.elapsed().as_millis() as u64;

        // 1. emit_end：发送完整数据给前端（实时渲染 + template_preview 块创建）
        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({ "result": output_for_display, "durationMs": duration_ms })),
            None,
        );

        // 2. ToolResultInfo.output = 精简版（回传给 LLM，节省上下文）
        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output_for_model,
            duration_ms,
        );

        // 3. 持久化：数据库保存完整数据（供前端刷新后恢复渲染）
        //    覆盖 result.output（精简版）为 output_for_display（完整版）再保存
        let mut result_for_db = result.clone();
        result_for_db.output = output_for_display;
        let _ = ctx.save_tool_block(&result_for_db);

        // 4. 返回精简版 result（pipeline 用它构造 tool_result 消息给 LLM）
        result
    }

    // ------------------------------------------------------------------
    // 类型安全的字段提取辅助函数
    // ------------------------------------------------------------------

    /// 从 JSON 中提取可选字符串字段（支持双命名）。
    /// - 键不存在 → Ok(None)
    /// - 键存在且是字符串 → Ok(Some(string))
    /// - 键存在但类型错误 → Err
    fn extract_opt_str(val: &Value, camel: &str, snake: &str) -> Result<Option<String>, String> {
        let v = val.get(camel).or_else(|| val.get(snake));
        match v {
            None => Ok(None),
            Some(v) if v.is_null() => Ok(None),
            Some(v) => match v.as_str() {
                Some(s) => Ok(Some(s.to_string())),
                None => Err(format!(
                    "字段 '{}' 必须是字符串，实际收到 {}。请传入字符串值",
                    camel,
                    value_type_label(v)
                )),
            },
        }
    }

    /// 提取版本字段：允许字符串或数字（数字会自动转字符串）。
    /// 用于提高 expectedVersion 的容错，减少模型把版本写成数字导致的硬失败。
    fn extract_opt_version_token(
        val: &Value,
        camel: &str,
        snake: &str,
    ) -> Result<Option<String>, String> {
        let v = val.get(camel).or_else(|| val.get(snake));
        match v {
            None => Ok(None),
            Some(v) if v.is_null() => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.to_string())),
            Some(Value::Number(n)) => Ok(Some(n.to_string())),
            Some(v) => Err(format!(
                "字段 '{}' 必须是字符串或数字，实际收到 {}。请传入版本号字符串（如 \"1.0.0\"）",
                camel,
                value_type_label(v)
            )),
        }
    }

    /// 从 JSON 中提取必需字符串字段（支持双命名），缺失时回退到 default。
    /// - 键存在但类型错误 → Err
    fn extract_str_or(
        val: &Value,
        camel: &str,
        snake: &str,
        default: &str,
    ) -> Result<String, String> {
        let v = val.get(camel).or_else(|| val.get(snake));
        match v {
            None => Ok(default.to_string()),
            Some(v) if v.is_null() => Ok(default.to_string()),
            Some(v) => match v.as_str() {
                Some(s) => Ok(s.to_string()),
                None => Err(format!(
                    "字段 '{}' 必须是字符串，实际收到 {}。请传入字符串值",
                    camel,
                    value_type_label(v)
                )),
            },
        }
    }

    /// 从 JSON 中提取可选布尔字段（支持双命名）。
    fn extract_opt_bool(val: &Value, camel: &str, snake: &str) -> Result<Option<bool>, String> {
        let v = val.get(camel).or_else(|| val.get(snake));
        match v {
            None => Ok(None),
            Some(v) if v.is_null() => Ok(None),
            Some(v) => match v.as_bool() {
                Some(b) => Ok(Some(b)),
                None => Err(format!(
                    "字段 '{}' 必须是布尔值，实际收到 {}。请传入 true 或 false",
                    camel,
                    value_type_label(v)
                )),
            },
        }
    }

    /// 从 JSON 中提取 fields 数组。
    /// - 键不存在 → Ok(default_val)
    /// - 键存在且是字符串数组 → Ok(parsed)
    /// - 键存在但不是数组或元素不是字符串 → Err
    fn extract_fields(val: &Value, required: bool) -> Result<Vec<String>, String> {
        let v = val.get("fields");
        match v {
            None | Some(&Value::Null) => {
                if required {
                    Ok(vec![])
                } else {
                    Ok(vec![])
                }
            }
            Some(v) => {
                let arr = v.as_array().ok_or_else(|| {
                    format!(
                        "fields 必须是字符串数组，实际收到 {}。请传入如 [\"Front\", \"Back\"]",
                        value_type_label(v)
                    )
                })?;
                let mut result = Vec::with_capacity(arr.len());
                for (i, item) in arr.iter().enumerate() {
                    match item.as_str() {
                        Some(s) => result.push(s.to_string()),
                        None => {
                            return Err(format!(
                                "fields[{}] 必须是字符串，实际收到 {}。所有字段名必须是字符串",
                                i,
                                value_type_label(item)
                            ));
                        }
                    }
                }
                Ok(result)
            }
        }
    }

    /// 从 JSON 中提取可选 fields 数组（用于 update patch）。
    /// - 键不存在 → Ok(None)
    /// - 键存在且是字符串数组 → Ok(Some(parsed))
    /// - 键存在但类型错误 → Err
    fn extract_opt_fields(val: &Value) -> Result<Option<Vec<String>>, String> {
        let v = val.get("fields");
        match v {
            None | Some(&Value::Null) => Ok(None),
            Some(v) => {
                let arr = v.as_array().ok_or_else(|| {
                    format!(
                        "fields 必须是字符串数组，实际收到 {}。请传入如 [\"Front\", \"Back\"]",
                        value_type_label(v)
                    )
                })?;
                let mut result = Vec::with_capacity(arr.len());
                for (i, item) in arr.iter().enumerate() {
                    match item.as_str() {
                        Some(s) => result.push(s.to_string()),
                        None => {
                            return Err(format!(
                                "fields[{}] 必须是字符串，实际收到 {}。所有字段名必须是字符串",
                                i,
                                value_type_label(item)
                            ));
                        }
                    }
                }
                Ok(Some(result))
            }
        }
    }

    /// 从 JSON 中提取 fieldExtractionRules（支持双命名）。
    fn extract_rules(
        val: &Value,
        required: bool,
    ) -> Result<HashMap<String, FieldExtractionRule>, String> {
        let v = val
            .get("fieldExtractionRules")
            .or_else(|| val.get("field_extraction_rules"));
        match v {
            None | Some(&Value::Null) => {
                if required {
                    Ok(HashMap::new())
                } else {
                    Ok(HashMap::new())
                }
            }
            Some(v) => serde_json::from_value(v.clone()).map_err(|e| {
                format!(
                    "fieldExtractionRules 格式错误: {}。请确保每个规则包含 field_type, is_required, description 字段",
                    e
                )
            }),
        }
    }

    /// 从 JSON 中提取可选 fieldExtractionRules（用于 update patch）。
    fn extract_opt_rules(
        val: &Value,
    ) -> Result<Option<HashMap<String, FieldExtractionRule>>, String> {
        let v = val
            .get("fieldExtractionRules")
            .or_else(|| val.get("field_extraction_rules"));
        match v {
            None | Some(&Value::Null) => Ok(None),
            Some(v) => {
                let rules: HashMap<String, FieldExtractionRule> =
                    serde_json::from_value(v.clone()).map_err(|e| {
                        format!(
                            "fieldExtractionRules 格式错误: {}。请确保每个规则包含 field_type, is_required, description 字段",
                            e
                        )
                    })?;
                Ok(Some(rules))
            }
        }
    }

    // ------------------------------------------------------------------
    // 解析函数
    // ------------------------------------------------------------------

    /// 将 JSON Value 解析为 CreateTemplateRequest
    fn parse_create_request(val: &Value) -> Result<CreateTemplateRequest, String> {
        let name = Self::extract_str_or(val, "name", "name", "")?;
        let description = Self::extract_str_or(val, "description", "description", "")?;
        let author = Self::extract_opt_str(val, "author", "author")?;
        let version = Self::extract_opt_str(val, "version", "version")?;
        let note_type = Self::extract_str_or(val, "noteType", "note_type", "Basic")?;
        let preview_front = Self::extract_str_or(val, "previewFront", "preview_front", "")?;
        let preview_back = Self::extract_str_or(val, "previewBack", "preview_back", "")?;
        let front_template = Self::extract_str_or(val, "frontTemplate", "front_template", "")?;
        let back_template = Self::extract_str_or(val, "backTemplate", "back_template", "")?;
        let css_style = Self::extract_str_or(val, "cssStyle", "css_style", "")?;
        let generation_prompt =
            Self::extract_str_or(val, "generationPrompt", "generation_prompt", "")?;
        let preview_data_json = Self::extract_opt_str(val, "previewDataJson", "preview_data_json")?;
        let is_active = Self::extract_opt_bool(val, "isActive", "is_active")?;
        let is_built_in = Self::extract_opt_bool(val, "isBuiltIn", "is_built_in")?;
        let fields = Self::extract_fields(val, true)?;
        let field_extraction_rules = Self::extract_rules(val, true)?;

        Ok(CreateTemplateRequest {
            name,
            description,
            author,
            version,
            preview_front,
            preview_back,
            note_type,
            fields,
            generation_prompt,
            front_template,
            back_template,
            css_style,
            field_extraction_rules,
            preview_data_json,
            is_active,
            is_built_in,
        })
    }

    /// 将 JSON Value 解析为 UpdateTemplateRequest（兼容 camelCase 和 snake_case）
    fn parse_update_request(val: &Value) -> Result<UpdateTemplateRequest, String> {
        let name = Self::extract_opt_str(val, "name", "name")?;
        let description = Self::extract_opt_str(val, "description", "description")?;
        let author = Self::extract_opt_str(val, "author", "author")?;
        let version = Self::extract_opt_str(val, "version", "version")?;
        let expected_version =
            Self::extract_opt_version_token(val, "expectedVersion", "expected_version")?;
        let preview_front = Self::extract_opt_str(val, "previewFront", "preview_front")?;
        let preview_back = Self::extract_opt_str(val, "previewBack", "preview_back")?;
        let note_type = Self::extract_opt_str(val, "noteType", "note_type")?;
        let generation_prompt =
            Self::extract_opt_str(val, "generationPrompt", "generation_prompt")?;
        let front_template = Self::extract_opt_str(val, "frontTemplate", "front_template")?;
        let back_template = Self::extract_opt_str(val, "backTemplate", "back_template")?;
        let css_style = Self::extract_opt_str(val, "cssStyle", "css_style")?;
        let preview_data_json = Self::extract_opt_str(val, "previewDataJson", "preview_data_json")?;
        let is_active = Self::extract_opt_bool(val, "isActive", "is_active")?;
        let is_built_in = Self::extract_opt_bool(val, "isBuiltIn", "is_built_in")?;
        let fields = Self::extract_opt_fields(val)?;
        let field_extraction_rules = Self::extract_opt_rules(val)?;

        Ok(UpdateTemplateRequest {
            name,
            description,
            author,
            version,
            expected_version,
            preview_front,
            preview_back,
            note_type,
            fields,
            generation_prompt,
            front_template,
            back_template,
            css_style,
            field_extraction_rules,
            is_active,
            preview_data_json,
            is_built_in,
        })
    }

    /// 将 patch 参数规范化为对象：
    /// - 如果是对象，直接返回
    /// - 如果是 JSON 字符串，尝试解析为对象
    /// - 其他类型返回错误
    fn normalize_patch_value(raw: &Value) -> Result<Value, String> {
        match raw {
            Value::Object(_) => Ok(raw.clone()),
            Value::String(s) => {
                let parsed: Value = serde_json::from_str(s).map_err(|e| {
                    format!(
                        "patch 是字符串但不是合法 JSON：{}。请传入对象或可解析的 JSON 字符串",
                        e
                    )
                })?;
                if parsed.is_object() {
                    Ok(parsed)
                } else {
                    Err(format!(
                        "patch JSON 必须是对象，实际为 {}。请传入如 {{\"expectedVersion\":\"1.0.0\"}} 的对象",
                        value_type_label(&parsed)
                    ))
                }
            }
            other => Err(format!(
                "patch 必须是对象，实际收到 {}。请传入对象（不要传数组/数字）",
                value_type_label(other)
            )),
        }
    }

    /// 将 template 参数规范化为对象：
    /// - 如果是对象，直接返回
    /// - 如果是 JSON 字符串，尝试解析为对象
    /// - 其他类型返回错误
    fn normalize_template_value(raw: &Value) -> Result<Value, String> {
        match raw {
            Value::Object(_) => Ok(raw.clone()),
            Value::String(s) => {
                let parsed: Value = serde_json::from_str(s).map_err(|e| {
                    format!(
                        "template 是字符串但不是合法 JSON：{}。请传入对象或可解析的 JSON 字符串",
                        e
                    )
                })?;
                if parsed.is_object() {
                    Ok(parsed)
                } else {
                    Err(format!(
                        "template JSON 必须是对象，实际为 {}。请传入模板对象",
                        value_type_label(&parsed)
                    ))
                }
            }
            other => Err(format!(
                "template 必须是对象，实际收到 {}。请传入模板对象",
                value_type_label(other)
            )),
        }
    }

    /// 更新请求是否包含实际业务字段变更（不计 expectedVersion）。
    fn has_update_changes(req: &UpdateTemplateRequest) -> bool {
        req.name.is_some()
            || req.description.is_some()
            || req.author.is_some()
            || req.version.is_some()
            || req.preview_front.is_some()
            || req.preview_back.is_some()
            || req.note_type.is_some()
            || req.fields.is_some()
            || req.generation_prompt.is_some()
            || req.front_template.is_some()
            || req.back_template.is_some()
            || req.css_style.is_some()
            || req.field_extraction_rules.is_some()
            || req.is_active.is_some()
            || req.preview_data_json.is_some()
            || req.is_built_in.is_some()
    }

    /// 内部验证逻辑，返回 (errors, warnings)
    fn validate_template_internal(req: &CreateTemplateRequest) -> (Vec<String>, Vec<String>) {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();

        if req.name.trim().is_empty() {
            errors.push("name 不能为空。请提供模板名称".to_string());
        }
        if req.fields.is_empty() {
            errors.push(
                "fields 不能为空。请至少定义一个字段（如 [\"Front\", \"Back\"]）".to_string(),
            );
        }
        if req.front_template.trim().is_empty() {
            errors.push("frontTemplate 不能为空。请提供 Anki 正面模板 HTML".to_string());
        }
        if req.back_template.trim().is_empty() {
            errors.push("backTemplate 不能为空。请提供 Anki 背面模板 HTML".to_string());
        }
        if req.generation_prompt.trim().is_empty() {
            errors.push("generationPrompt 不能为空。请提供 AI 生成卡片的指导提示词".to_string());
        }

        // 字段与 field_extraction_rules 一致性
        let field_set: HashSet<&String> = req.fields.iter().collect();
        for field in &req.fields {
            if !req.field_extraction_rules.contains_key(field) {
                errors.push(format!(
                    "字段 '{}' 缺少对应的 fieldExtractionRules 条目。请为该字段添加提取规则",
                    field
                ));
            }
        }
        let extra_rules: Vec<String> = req
            .field_extraction_rules
            .keys()
            .filter(|k| !field_set.contains(k))
            .cloned()
            .collect();
        if !extra_rules.is_empty() {
            errors.push(format!(
                "fieldExtractionRules 包含未在 fields 中定义的字段: {}。请将这些字段加入 fields 或移除多余规则",
                extra_rules.join(", ")
            ));
        }

        // warnings
        if req.description.trim().is_empty() {
            warnings.push("description 为空，建议补充模板描述以便检索".to_string());
        }
        if req.css_style.trim().is_empty() {
            warnings.push("cssStyle 为空，将使用默认样式".to_string());
        }
        if req.preview_front.trim().is_empty() || req.preview_back.trim().is_empty() {
            warnings.push("previewFront/previewBack 为空，模板列表中将无法展示预览".to_string());
        }

        (errors, warnings)
    }

    // ------------------------------------------------------------------
    // 工具实现
    // ------------------------------------------------------------------

    async fn execute_list(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args: TemplateListArgs = match serde_json::from_value(call.arguments.clone()) {
            Ok(a) => a,
            Err(e) => {
                let msg = format!(
                    "参数格式错误: {}。支持的参数: activeOnly(bool), builtinOnly(bool), query(string), limit(number)",
                    e
                );
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        let db = match Self::get_db(ctx) {
            Ok(db) => db,
            Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
        };

        let mut all_templates = match db.get_all_custom_templates() {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("查询模板失败: {}。请检查数据库状态", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        // 复用 ChatAnki 成熟逻辑：空库时自动导入内置模板
        if all_templates.is_empty() {
            if let Err(e) = import_builtin_templates_if_empty(db) {
                log::warn!(
                    "[TemplateDesignerExecutor] auto-import builtin templates failed: {}",
                    e
                );
            } else if let Ok(v) = db.get_all_custom_templates() {
                all_templates = v;
            }
        }

        let limit = args.limit.unwrap_or(50).min(200);
        let query_lower = args.query.as_ref().map(|q| q.to_lowercase());

        let filtered: Vec<Value> = all_templates
            .iter()
            .filter(|t| {
                if args.active_only && !t.is_active {
                    return false;
                }
                if let Some(true) = args.builtin_only {
                    if !t.is_built_in {
                        return false;
                    }
                }
                if let Some(ref q) = query_lower {
                    // 复用 ChatAnki 成熟的搜索范围：id + name + description + noteType
                    let hay = format!("{} {}\n{}", t.id, t.name, t.description).to_lowercase();
                    if !hay.contains(q) && !t.note_type.to_lowercase().contains(q) {
                        return false;
                    }
                }
                true
            })
            .take(limit)
            .map(|t| {
                // 复用 ChatAnki 成熟逻辑：标准化字段、补全提取规则、计算复杂度
                let fields = normalize_template_fields(&t.fields);
                let rules = ensure_field_extraction_rules(&fields, &t.field_extraction_rules);
                let complexity_level = calculate_complexity_level(fields.len(), &t.note_type);
                json!({
                    "id": t.id,
                    "name": t.name,
                    "description": t.description,
                    "version": t.version,
                    "isActive": t.is_active,
                    "isBuiltIn": t.is_built_in,
                    "noteType": t.note_type,
                    "fields": fields,
                    "complexityLevel": complexity_level,
                    "fieldExtractionRules": rules,
                    "generationPrompt": t.generation_prompt,
                })
            })
            .collect();

        let output = json!({
            "count": filtered.len(),
            "templates": filtered,
        });

        Ok(Self::emit_success(call, ctx, output, start_time))
    }

    async fn execute_get(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args: TemplateGetArgs = match serde_json::from_value(call.arguments.clone()) {
            Ok(a) => a,
            Err(e) => {
                let msg = format!("参数错误: {}。请提供 templateId", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        let db = match Self::get_db(ctx) {
            Ok(db) => db,
            Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
        };

        match db.get_custom_template_by_id(&args.template_id) {
            Ok(Some(t)) => {
                // 完整数据：前端渲染用（含 HTML/CSS）
                let output_for_display = json!({
                    "_templateVisual": true,
                    "id": t.id,
                    "name": t.name,
                    "description": t.description,
                    "author": t.author,
                    "version": t.version,
                    "previewFront": t.preview_front,
                    "previewBack": t.preview_back,
                    "noteType": t.note_type,
                    "fields": t.fields,
                    "generationPrompt": t.generation_prompt,
                    "frontTemplate": t.front_template,
                    "backTemplate": t.back_template,
                    "cssStyle": t.css_style,
                    "fieldExtractionRules": t.field_extraction_rules,
                    "isActive": t.is_active,
                    "isBuiltIn": t.is_built_in,
                    "createdAt": t.created_at.to_rfc3339(),
                    "updatedAt": t.updated_at.to_rfc3339(),
                    "previewDataJson": t.preview_data_json,
                });
                // 精简摘要：回传给 LLM（不含 HTML/CSS，避免上下文膨胀）
                let output_for_model = json!({
                    "id": t.id,
                    "name": t.name,
                    "description": t.description,
                    "version": t.version,
                    "noteType": t.note_type,
                    "fields": t.fields,
                    "isActive": t.is_active,
                    "isBuiltIn": t.is_built_in,
                    "_visualRendered": true,
                });
                Ok(Self::emit_success_visual(
                    call,
                    ctx,
                    output_for_display,
                    output_for_model,
                    start_time,
                ))
            }
            Ok(None) => {
                let msg = format!(
                    "模板 '{}' 不存在。请使用 template_list 查看可用模板",
                    args.template_id
                );
                Ok(Self::emit_failure(call, ctx, &msg, start_time))
            }
            Err(e) => {
                let msg = format!("查询模板失败: {}。请稍后重试", e);
                Ok(Self::emit_failure(call, ctx, &msg, start_time))
            }
        }
    }

    async fn execute_validate(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args: TemplateValidateArgs = match serde_json::from_value(call.arguments.clone()) {
            Ok(a) => a,
            Err(e) => {
                let msg = format!("参数错误: {}。请提供 template 对象", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        let normalized_template = match Self::normalize_template_value(&args.template) {
            Ok(v) => v,
            Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
        };

        let req = match Self::parse_create_request(&normalized_template) {
            Ok(r) => r,
            Err(e) => {
                let output = json!({
                    "valid": false,
                    "errors": [e],
                    "warnings": [],
                });
                return Ok(Self::emit_success(call, ctx, output, start_time));
            }
        };

        let (errors, warnings) = Self::validate_template_internal(&req);

        let output = json!({
            "valid": errors.is_empty(),
            "errors": errors,
            "warnings": warnings,
        });

        Ok(Self::emit_success(call, ctx, output, start_time))
    }

    async fn execute_create(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args: TemplateCreateArgs = match serde_json::from_value(call.arguments.clone()) {
            Ok(a) => a,
            Err(e) => {
                let msg = format!("参数错误: {}。请提供 template 对象", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        let normalized_template = match Self::normalize_template_value(&args.template) {
            Ok(v) => v,
            Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
        };

        let req = match Self::parse_create_request(&normalized_template) {
            Ok(r) => r,
            Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
        };

        // 校验
        let (errors, _warnings) = Self::validate_template_internal(&req);
        if !errors.is_empty() {
            let msg = format!("模板校验失败: {}。请修正后重试", errors.join("; "));
            return Ok(Self::emit_failure(call, ctx, &msg, start_time));
        }

        let db = match Self::get_db(ctx) {
            Ok(db) => db,
            Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
        };

        match db.create_custom_template(&req) {
            Ok(template_id) => {
                let version = req.version.as_deref().unwrap_or("1.0.0");
                // 完整数据：前端渲染用
                let output_for_display = json!({
                    "_templateVisual": true,
                    "created": true,
                    "templateId": template_id,
                    "name": req.name,
                    "version": version,
                    "noteType": req.note_type,
                    "fields": req.fields,
                    "frontTemplate": req.front_template,
                    "backTemplate": req.back_template,
                    "cssStyle": req.css_style,
                    "previewDataJson": req.preview_data_json,
                    "isActive": req.is_active.unwrap_or(true),
                });
                // 精简摘要：回传给 LLM
                let output_for_model = json!({
                    "created": true,
                    "templateId": template_id,
                    "name": req.name,
                    "version": version,
                    "noteType": req.note_type,
                    "fields": req.fields,
                    "isActive": req.is_active.unwrap_or(true),
                    "_visualRendered": true,
                });
                Ok(Self::emit_success_visual(
                    call,
                    ctx,
                    output_for_display,
                    output_for_model,
                    start_time,
                ))
            }
            Err(e) => {
                let msg = format!("创建模板失败: {}。请检查数据是否完整", e);
                Ok(Self::emit_failure(call, ctx, &msg, start_time))
            }
        }
    }

    async fn execute_update(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args: TemplateUpdateArgs = match serde_json::from_value(call.arguments.clone()) {
            Ok(a) => a,
            Err(e) => {
                let msg = format!("参数错误: {}。请提供 templateId 和 patch", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        // 兼容模型将 patch 字段平铺到顶层的情况：
        // 1) 优先使用 args.patch
        // 2) 若缺失，则从顶层参数中扣除已知键后构造 patch
        let raw_patch = if let Some(patch) = args.patch.clone() {
            patch
        } else if let Some(template_like_patch) = args.template.clone() {
            // 兼容：部分模型会误把更新内容放进 template/templateDefinition 字段
            template_like_patch
        } else {
            let mut inferred = serde_json::Map::new();
            for (k, v) in args.extra.iter() {
                if k != "templateId"
                    && k != "template_id"
                    && k != "expectedVersion"
                    && k != "expected_version"
                {
                    inferred.insert(k.clone(), v.clone());
                }
            }
            Value::Object(inferred)
        };

        // 解析 patch 为 UpdateTemplateRequest（兼容 camelCase 和 snake_case）
        let normalized_patch = match Self::normalize_patch_value(&raw_patch) {
            Ok(v) => v,
            Err(e) => {
                let msg = format!("patch 格式错误: {}。请参考 template_get 的返回结构", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        let mut update_req: UpdateTemplateRequest =
            match Self::parse_update_request(&normalized_patch) {
                Ok(r) => r,
                Err(e) => {
                    let msg = format!("patch 格式错误: {}。请参考 template_get 的返回结构", e);
                    return Ok(Self::emit_failure(call, ctx, &msg, start_time));
                }
            };

        // 兼容：允许 expectedVersion 在顶层参数传入（某些模型会放错位置）
        if update_req.expected_version.is_none() {
            update_req.expected_version = args.expected_version.clone();
        }

        // 强制 expected_version
        if update_req.expected_version.is_none() {
            let msg =
                "缺少 expectedVersion。请先用 template_get 获取当前版本号，然后在 patch 中传入 expectedVersion"
                    .to_string();
            return Ok(Self::emit_failure(call, ctx, &msg, start_time));
        }

        if !Self::has_update_changes(&update_req) {
            let msg =
                "patch 中未检测到可更新字段。请至少传入一个变更字段（如 name/frontTemplate/backTemplate/cssStyle）"
                    .to_string();
            return Ok(Self::emit_failure(call, ctx, &msg, start_time));
        }

        let db = match Self::get_db(ctx) {
            Ok(db) => db,
            Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
        };

        // 检查模板是否存在
        let existing = match db.get_custom_template_by_id(&args.template_id) {
            Ok(Some(t)) => t,
            Ok(None) => {
                let msg = format!(
                    "模板 '{}' 不存在。请使用 template_list 查看可用模板",
                    args.template_id
                );
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
            Err(e) => {
                let msg = format!("查询模板失败: {}", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        // 乐观锁检查
        if let Some(ref ev) = update_req.expected_version {
            if ev != &existing.version {
                let msg = format!(
                    "版本冲突：当前版本 {} 与提供的 expectedVersion {} 不匹配。请先用 template_get 获取最新版本",
                    existing.version, ev
                );
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        }

        // 保存更新前的原始模板数据用于 before/after 对比（前端用 renderCardPreview 做真实渲染）
        let before_template = json!({
            "name": existing.name,
            "frontTemplate": existing.front_template,
            "backTemplate": existing.back_template,
            "cssStyle": existing.css_style,
            "fields": existing.fields,
            "noteType": existing.note_type,
            "previewDataJson": existing.preview_data_json,
            "generationPrompt": existing.generation_prompt,
        });

        match db.update_custom_template(&args.template_id, &update_req) {
            Ok(()) => {
                // 读取更新后的模板
                let after = db
                    .get_custom_template_by_id(&args.template_id)
                    .ok()
                    .flatten();
                let after_template = if let Some(ref t) = after {
                    json!({
                        "name": t.name,
                        "frontTemplate": t.front_template,
                        "backTemplate": t.back_template,
                        "cssStyle": t.css_style,
                        "fields": t.fields,
                        "noteType": t.note_type,
                        "previewDataJson": t.preview_data_json,
                        "generationPrompt": t.generation_prompt,
                        "version": t.version,
                    })
                } else {
                    before_template.clone()
                };

                // 完整数据：前端渲染用（含 before/after 的 HTML/CSS）
                let output_for_display = json!({
                    "_templateVisual": true,
                    "_templateDiff": true,
                    "updated": true,
                    "templateId": args.template_id,
                    "name": after.as_ref().map(|t| t.name.as_str()).unwrap_or(&existing.name),
                    "version": after.as_ref().map(|t| t.version.as_str()),
                    "fields": after.as_ref().map(|t| &t.fields).unwrap_or(&existing.fields),
                    "noteType": after.as_ref().map(|t| t.note_type.as_str()).unwrap_or(&existing.note_type),
                    "before": before_template,
                    "after": after_template,
                });
                // 精简摘要：回传给 LLM（不含 before/after 的完整模板内容）
                let output_for_model = json!({
                    "updated": true,
                    "templateId": args.template_id,
                    "name": after.as_ref().map(|t| t.name.as_str()).unwrap_or(&existing.name),
                    "version": after.as_ref().map(|t| t.version.as_str()),
                    "fields": after.as_ref().map(|t| &t.fields).unwrap_or(&existing.fields),
                    "noteType": after.as_ref().map(|t| t.note_type.as_str()).unwrap_or(&existing.note_type),
                    "_visualRendered": true,
                });
                Ok(Self::emit_success_visual(
                    call,
                    ctx,
                    output_for_display,
                    output_for_model,
                    start_time,
                ))
            }
            Err(e) => {
                let err_str = e.to_string();
                let msg = if err_str.contains("optimistic_lock_failed") {
                    "模板已被其他操作更新。请重新用 template_get 获取最新版本后重试".to_string()
                } else {
                    format!("更新模板失败: {}。请检查数据格式", err_str)
                };
                Ok(Self::emit_failure(call, ctx, &msg, start_time))
            }
        }
    }

    async fn execute_fork(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args: TemplateForkArgs = match serde_json::from_value(call.arguments.clone()) {
            Ok(a) => a,
            Err(e) => {
                let msg = format!("参数错误: {}。请提供 sourceTemplateId", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        let db = match Self::get_db(ctx) {
            Ok(db) => db,
            Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
        };

        // 获取源模板
        let source = match db.get_custom_template_by_id(&args.source_template_id) {
            Ok(Some(t)) => t,
            Ok(None) => {
                let msg = format!(
                    "源模板 '{}' 不存在。请使用 template_list 查看可用模板",
                    args.source_template_id
                );
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
            Err(e) => {
                let msg = format!("查询源模板失败: {}", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        let fork_name = args
            .name
            .unwrap_or_else(|| format!("{} (副本)", source.name));
        let fork_desc = args
            .description
            .unwrap_or_else(|| source.description.clone());

        let create_req = CreateTemplateRequest {
            name: fork_name,
            description: fork_desc,
            author: source.author.clone(),
            version: Some("1.0.0".to_string()),
            preview_front: source.preview_front.clone(),
            preview_back: source.preview_back.clone(),
            note_type: source.note_type.clone(),
            fields: source.fields.clone(),
            generation_prompt: source.generation_prompt.clone(),
            front_template: source.front_template.clone(),
            back_template: source.back_template.clone(),
            css_style: source.css_style.clone(),
            field_extraction_rules: source.field_extraction_rules.clone(),
            preview_data_json: source.preview_data_json.clone(),
            is_active: Some(args.set_active),
            is_built_in: Some(false),
        };

        match db.create_custom_template(&create_req) {
            Ok(new_id) => {
                // 完整数据：前端渲染用
                let output_for_display = json!({
                    "_templateVisual": true,
                    "forked": true,
                    "templateId": new_id,
                    "sourceTemplateId": args.source_template_id,
                    "name": create_req.name,
                    "noteType": create_req.note_type,
                    "fields": create_req.fields,
                    "frontTemplate": create_req.front_template,
                    "backTemplate": create_req.back_template,
                    "cssStyle": create_req.css_style,
                    "previewDataJson": create_req.preview_data_json,
                    "isActive": create_req.is_active.unwrap_or(true),
                });
                // 精简摘要：回传给 LLM
                let output_for_model = json!({
                    "forked": true,
                    "templateId": new_id,
                    "sourceTemplateId": args.source_template_id,
                    "name": create_req.name,
                    "noteType": create_req.note_type,
                    "fields": create_req.fields,
                    "isActive": create_req.is_active.unwrap_or(true),
                    "_visualRendered": true,
                });
                Ok(Self::emit_success_visual(
                    call,
                    ctx,
                    output_for_display,
                    output_for_model,
                    start_time,
                ))
            }
            Err(e) => {
                let msg = format!("分叉模板失败: {}。请稍后重试", e);
                Ok(Self::emit_failure(call, ctx, &msg, start_time))
            }
        }
    }

    async fn execute_preview(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args: TemplatePreviewArgs = match serde_json::from_value(call.arguments.clone()) {
            Ok(a) => a,
            Err(e) => {
                let msg = format!("参数错误: {}。请提供 templateId 或 template", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        // 获取模板（优先 templateId，其次 template draft）
        let (front_tmpl, back_tmpl, css_style, fields, used_template_id) = if let Some(ref tid) =
            args.template_id
        {
            let db = match Self::get_db(ctx) {
                Ok(db) => db,
                Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
            };
            match db.get_custom_template_by_id(tid) {
                Ok(Some(t)) => (
                    t.front_template.clone(),
                    t.back_template.clone(),
                    t.css_style.clone(),
                    t.fields.clone(),
                    Some(tid.clone()),
                ),
                Ok(None) => {
                    let msg = format!("模板 '{}' 不存在。请使用 template_list 查看可用模板", tid);
                    return Ok(Self::emit_failure(call, ctx, &msg, start_time));
                }
                Err(e) => {
                    let msg = format!("查询模板失败: {}", e);
                    return Ok(Self::emit_failure(call, ctx, &msg, start_time));
                }
            }
        } else if let Some(ref draft_raw) = args.template {
            let draft = match Self::normalize_template_value(draft_raw) {
                Ok(v) => v,
                Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
            };
            let front = draft
                .get("frontTemplate")
                .or_else(|| draft.get("front_template"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let back = draft
                .get("backTemplate")
                .or_else(|| draft.get("back_template"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let css = draft
                .get("cssStyle")
                .or_else(|| draft.get("css_style"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let fields = match Self::extract_fields(&draft, false) {
                Ok(f) => f,
                Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
            };
            (front, back, css, fields, None)
        } else {
            let msg = "请提供 templateId 或 template 草稿用于预览".to_string();
            return Ok(Self::emit_failure(call, ctx, &msg, start_time));
        };

        // 直接传原始模板数据 + sampleData 给前端，由前端用 renderCardPreview 做真实渲染
        let output_for_display = json!({
            "_templateVisual": true,
            "frontTemplate": front_tmpl,
            "backTemplate": back_tmpl,
            "cssStyle": css_style,
            "fields": fields,
            "usedTemplateId": used_template_id,
            "sampleData": args.sample_data,
        });
        // 精简摘要：回传给 LLM（预览是纯粹给用户看的，LLM 不需要渲染数据）
        let output_for_model = json!({
            "previewRendered": true,
            "usedTemplateId": used_template_id,
            "fields": fields,
            "_visualRendered": true,
        });

        Ok(Self::emit_success_visual(
            call,
            ctx,
            output_for_display,
            output_for_model,
            start_time,
        ))
    }

    // ------------------------------------------------------------------
    // template_delete
    // ------------------------------------------------------------------

    async fn execute_delete(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args: TemplateDeleteArgs = match serde_json::from_value(call.arguments.clone()) {
            Ok(a) => a,
            Err(e) => {
                let msg = format!("参数解析失败: {}。请提供 templateId (string) 参数。", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        let db = match Self::get_db(ctx) {
            Ok(db) => db,
            Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
        };

        // 1. 检查模板是否存在
        let template = match db.get_custom_template_by_id(&args.template_id) {
            Ok(Some(t)) => t,
            Ok(None) => {
                let msg = format!(
                    "模板不存在: {}。请使用 builtin-template_list 查看可用模板。",
                    args.template_id
                );
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
            Err(e) => {
                let msg = format!("查询模板失败: {}", e);
                return Ok(Self::emit_failure(call, ctx, &msg, start_time));
            }
        };

        // 2. 禁止删除内置模板
        if template.is_built_in {
            let msg = format!(
                "不能删除内置模板「{}」(ID: {})。如需修改内置模板，请先使用 builtin-template_fork 创建副本。",
                template.name, args.template_id
            );
            return Ok(Self::emit_failure(call, ctx, &msg, start_time));
        }

        // 3. 记录模板名称用于确认消息
        let template_name = template.name.clone();
        let template_id = args.template_id.clone();

        // 4. 执行删除
        if let Err(e) = db.delete_custom_template(&args.template_id) {
            let msg = format!("删除模板失败: {}", e);
            return Ok(Self::emit_failure(call, ctx, &msg, start_time));
        }

        log::info!(
            "[TemplateDesignerExecutor] Deleted template: id={}, name={}",
            template_id,
            template_name
        );

        let output = json!({
            "success": true,
            "deleted": true,
            "templateId": template_id,
            "templateName": template_name,
            "message": format!("模板「{}」已成功删除。", template_name),
        });

        Ok(Self::emit_success(call, ctx, output, start_time))
    }
}

// ============================================================================
// ToolExecutor 实现
// ============================================================================

#[async_trait]
impl ToolExecutor for TemplateDesignerExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        Self::is_template_tool(tool_name)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        log::info!(
            "[TemplateDesignerExecutor] execute: tool_name={}, tool_call_id={}, session_id={}, message_id={}",
            call.name,
            call.id,
            ctx.session_id,
            ctx.message_id
        );

        // 发射 tool_call_start 事件
        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id),
            None,
        );

        let stripped_name = strip_tool_namespace(&call.name).to_string();

        match stripped_name.as_str() {
            "template_list" => self.execute_list(call, ctx, start_time).await,
            "template_get" => self.execute_get(call, ctx, start_time).await,
            "template_validate" => self.execute_validate(call, ctx, start_time).await,
            "template_create" => self.execute_create(call, ctx, start_time).await,
            "template_update" => self.execute_update(call, ctx, start_time).await,
            "template_fork" => self.execute_fork(call, ctx, start_time).await,
            "template_preview" => self.execute_preview(call, ctx, start_time).await,
            "template_delete" => self.execute_delete(call, ctx, start_time).await,
            _ => Err(format!(
                "Unsupported template designer tool: {}",
                stripped_name
            )),
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            "template_delete" => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "TemplateDesignerExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // can_handle 前缀识别
    // ------------------------------------------------------------------

    #[test]
    fn test_can_handle_builtin_prefix() {
        let executor = TemplateDesignerExecutor::new();
        assert!(executor.can_handle("builtin-template_list"));
        assert!(executor.can_handle("builtin-template_get"));
        assert!(executor.can_handle("builtin-template_validate"));
        assert!(executor.can_handle("builtin-template_create"));
        assert!(executor.can_handle("builtin-template_update"));
        assert!(executor.can_handle("builtin-template_fork"));
        assert!(executor.can_handle("builtin-template_preview"));
    }

    #[test]
    fn test_can_handle_mcp_prefix() {
        let executor = TemplateDesignerExecutor::new();
        assert!(executor.can_handle("mcp_template_list"));
        assert!(executor.can_handle("mcp_template_get"));
    }

    #[test]
    fn test_can_handle_bare_name() {
        let executor = TemplateDesignerExecutor::new();
        assert!(executor.can_handle("template_list"));
        assert!(executor.can_handle("template_get"));
        assert!(executor.can_handle("template_preview"));
    }

    #[test]
    fn test_can_handle_unrelated_tools() {
        let executor = TemplateDesignerExecutor::new();
        assert!(!executor.can_handle("chatanki_run"));
        assert!(!executor.can_handle("builtin-web_search"));
        assert!(!executor.can_handle("builtin-note_read"));
        assert!(!executor.can_handle("unknown_tool"));
    }

    // ------------------------------------------------------------------
    // validate 逻辑
    // ------------------------------------------------------------------

    /// 创建测试用的简单 FieldExtractionRule
    fn make_rule(desc: &str, required: bool) -> FieldExtractionRule {
        FieldExtractionRule {
            field_type: FieldType::Text,
            is_required: required,
            default_value: None,
            validation_pattern: None,
            description: desc.to_string(),
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
    fn test_validate_success() {
        let mut rules = HashMap::new();
        rules.insert("Front".to_string(), make_rule("正面", true));
        rules.insert("Back".to_string(), make_rule("背面", true));

        let req = CreateTemplateRequest {
            name: "Test".to_string(),
            description: "desc".to_string(),
            author: None,
            version: None,
            preview_front: "pf".to_string(),
            preview_back: "pb".to_string(),
            note_type: "Basic".to_string(),
            fields: vec!["Front".to_string(), "Back".to_string()],
            generation_prompt: "gen".to_string(),
            front_template: "{{Front}}".to_string(),
            back_template: "{{Back}}".to_string(),
            css_style: ".card {}".to_string(),
            field_extraction_rules: rules,
            preview_data_json: None,
            is_active: None,
            is_built_in: None,
        };

        let (errors, warnings) = TemplateDesignerExecutor::validate_template_internal(&req);
        assert!(errors.is_empty(), "Expected no errors, got: {:?}", errors);
        assert!(warnings.is_empty());
    }

    #[test]
    fn test_validate_empty_name_and_fields() {
        let req = CreateTemplateRequest {
            name: "".to_string(),
            description: "".to_string(),
            author: None,
            version: None,
            preview_front: "".to_string(),
            preview_back: "".to_string(),
            note_type: "Basic".to_string(),
            fields: vec![],
            generation_prompt: "".to_string(),
            front_template: "".to_string(),
            back_template: "".to_string(),
            css_style: "".to_string(),
            field_extraction_rules: HashMap::new(),
            preview_data_json: None,
            is_active: None,
            is_built_in: None,
        };

        let (errors, _warnings) = TemplateDesignerExecutor::validate_template_internal(&req);
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.contains("name")));
        assert!(errors.iter().any(|e| e.contains("fields")));
        assert!(errors.iter().any(|e| e.contains("frontTemplate")));
        assert!(errors.iter().any(|e| e.contains("backTemplate")));
        assert!(errors.iter().any(|e| e.contains("generationPrompt")));
    }

    #[test]
    fn test_validate_field_rule_mismatch() {
        let mut rules = HashMap::new();
        rules.insert("Front".to_string(), make_rule("正面", true));
        // "Extra" rule has no matching field
        rules.insert("Extra".to_string(), make_rule("extra", false));

        let req = CreateTemplateRequest {
            name: "Test".to_string(),
            description: "d".to_string(),
            author: None,
            version: None,
            preview_front: "p".to_string(),
            preview_back: "p".to_string(),
            note_type: "Basic".to_string(),
            fields: vec!["Front".to_string(), "Back".to_string()],
            generation_prompt: "gen".to_string(),
            front_template: "{{Front}}".to_string(),
            back_template: "{{Back}}".to_string(),
            css_style: ".card {}".to_string(),
            field_extraction_rules: rules,
            preview_data_json: None,
            is_active: None,
            is_built_in: None,
        };

        let (errors, _) = TemplateDesignerExecutor::validate_template_internal(&req);
        assert!(!errors.is_empty());
        // "Back" 缺少规则
        assert!(errors.iter().any(|e| e.contains("Back")));
        // "Extra" 多余规则
        assert!(errors.iter().any(|e| e.contains("Extra")));
    }

    // ------------------------------------------------------------------
    // update 缺 expected_version
    // ------------------------------------------------------------------

    #[test]
    fn test_update_patch_parse_no_expected_version() {
        // 直接测试 UpdateTemplateRequest 解析和 expected_version 检查
        let patch = json!({
            "name": "New Name"
        });
        let update_req: UpdateTemplateRequest = serde_json::from_value(patch).unwrap();
        assert!(
            update_req.expected_version.is_none(),
            "expected_version should be None when not provided"
        );
    }

    // ------------------------------------------------------------------
    // fork 字段复制
    // ------------------------------------------------------------------

    #[test]
    fn test_fork_create_request_copies_fields() {
        let mut rules = HashMap::new();
        rules.insert("Front".to_string(), make_rule("正面", true));

        let source = crate::models::CustomAnkiTemplate {
            id: "src-id".to_string(),
            name: "Source".to_string(),
            description: "Source desc".to_string(),
            author: Some("Author".to_string()),
            version: "2.0.0".to_string(),
            preview_front: "pf".to_string(),
            preview_back: "pb".to_string(),
            note_type: "Basic".to_string(),
            fields: vec!["Front".to_string()],
            generation_prompt: "gen prompt".to_string(),
            front_template: "{{Front}}".to_string(),
            back_template: "{{Back}}".to_string(),
            css_style: ".card {}".to_string(),
            field_extraction_rules: rules.clone(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            is_active: true,
            is_built_in: true,
            preview_data_json: None,
        };

        // Simulate fork logic
        let fork_name = format!("{} (副本)", source.name);
        let create_req = CreateTemplateRequest {
            name: fork_name.clone(),
            description: source.description.clone(),
            author: source.author.clone(),
            version: Some("1.0.0".to_string()),
            preview_front: source.preview_front.clone(),
            preview_back: source.preview_back.clone(),
            note_type: source.note_type.clone(),
            fields: source.fields.clone(),
            generation_prompt: source.generation_prompt.clone(),
            front_template: source.front_template.clone(),
            back_template: source.back_template.clone(),
            css_style: source.css_style.clone(),
            field_extraction_rules: source.field_extraction_rules.clone(),
            preview_data_json: source.preview_data_json.clone(),
            is_active: Some(true),
            is_built_in: Some(false),
        };

        assert_eq!(create_req.name, "Source (副本)");
        assert_eq!(create_req.is_built_in, Some(false));
        assert_eq!(create_req.fields, vec!["Front".to_string()]);
        assert_eq!(create_req.generation_prompt, "gen prompt");
        assert_eq!(create_req.front_template, "{{Front}}");
        assert!(create_req.field_extraction_rules.contains_key("Front"));
    }

    // ------------------------------------------------------------------
    // parse_create_request
    // ------------------------------------------------------------------

    #[test]
    fn test_parse_create_request_camel_case() {
        let val = json!({
            "name": "Test",
            "description": "desc",
            "noteType": "Basic",
            "fields": ["Front", "Back"],
            "frontTemplate": "{{Front}}",
            "backTemplate": "{{Back}}",
            "cssStyle": ".card {}",
            "generationPrompt": "gen",
            "previewFront": "pf",
            "previewBack": "pb",
            "fieldExtractionRules": {
                "Front": { "field_type": "Text", "is_required": true, "description": "正面" },
                "Back": { "field_type": "Text", "is_required": true, "description": "背面" }
            }
        });

        let req = TemplateDesignerExecutor::parse_create_request(&val).unwrap();
        assert_eq!(req.name, "Test");
        assert_eq!(req.note_type, "Basic");
        assert_eq!(req.fields.len(), 2);
        assert_eq!(req.field_extraction_rules.len(), 2);
    }

    #[test]
    fn test_parse_create_request_snake_case() {
        let val = json!({
            "name": "Test",
            "description": "desc",
            "note_type": "Cloze",
            "fields": ["Text", "Extra"],
            "front_template": "{{cloze:Text}}",
            "back_template": "{{cloze:Text}} {{Extra}}",
            "css_style": "",
            "generation_prompt": "gen",
            "preview_front": "",
            "preview_back": "",
            "field_extraction_rules": {
                "Text": { "field_type": "Text", "is_required": true, "description": "文本" },
                "Extra": { "field_type": "Text", "is_required": false, "description": "额外" }
            }
        });

        let req = TemplateDesignerExecutor::parse_create_request(&val).unwrap();
        assert_eq!(req.note_type, "Cloze");
        assert_eq!(req.front_template, "{{cloze:Text}}");
    }

    // ------------------------------------------------------------------
    // sensitivity_level
    // ------------------------------------------------------------------

    #[test]
    fn test_sensitivity_levels() {
        let executor = TemplateDesignerExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-template_list"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-template_get"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-template_validate"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-template_preview"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-template_create"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-template_update"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-template_fork"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-template_delete"),
            ToolSensitivity::Medium
        );
    }

    // ------------------------------------------------------------------
    // template_list: limit / query 行为
    // ------------------------------------------------------------------

    #[test]
    fn test_list_args_defaults() {
        let args: TemplateListArgs = serde_json::from_value(json!({})).unwrap();
        assert!(args.active_only);
        assert!(args.builtin_only.is_none());
        assert!(args.query.is_none());
        assert!(args.limit.is_none());
    }

    #[test]
    fn test_list_args_limit_cap() {
        let args: TemplateListArgs = serde_json::from_value(json!({ "limit": 999 })).unwrap();
        let effective_limit = args.limit.unwrap_or(50).min(200);
        assert_eq!(effective_limit, 200);
    }

    #[test]
    fn test_list_args_query() {
        let args: TemplateListArgs =
            serde_json::from_value(json!({ "query": "cloze", "activeOnly": false })).unwrap();
        assert!(!args.active_only);
        assert_eq!(args.query.as_deref(), Some("cloze"));
    }

    // ------------------------------------------------------------------
    // [P1 回归] parse_update_request camelCase 兼容
    // ------------------------------------------------------------------

    #[test]
    fn test_parse_update_request_camel_case() {
        let patch = json!({
            "expectedVersion": "1.0.0",
            "name": "Updated Name",
            "noteType": "Cloze",
            "frontTemplate": "<div>{{cloze:Text}}</div>",
            "backTemplate": "<div>{{cloze:Text}}</div>",
            "generationPrompt": "new prompt",
            "cssStyle": ".card { color: red; }",
            "previewFront": "preview",
            "previewBack": "preview",
            "isActive": true,
            "isBuiltIn": false,
            "previewDataJson": "{\"key\":\"val\"}"
        });

        let req = TemplateDesignerExecutor::parse_update_request(&patch).unwrap();
        assert_eq!(req.expected_version.as_deref(), Some("1.0.0"));
        assert_eq!(req.name.as_deref(), Some("Updated Name"));
        assert_eq!(req.note_type.as_deref(), Some("Cloze"));
        assert_eq!(
            req.front_template.as_deref(),
            Some("<div>{{cloze:Text}}</div>")
        );
        assert_eq!(req.generation_prompt.as_deref(), Some("new prompt"));
        assert_eq!(req.css_style.as_deref(), Some(".card { color: red; }"));
        assert_eq!(req.is_active, Some(true));
        assert_eq!(req.is_built_in, Some(false));
        assert_eq!(req.preview_data_json.as_deref(), Some("{\"key\":\"val\"}"));
    }

    #[test]
    fn test_parse_update_request_snake_case() {
        let patch = json!({
            "expected_version": "2.1.0",
            "note_type": "Basic",
            "front_template": "{{Front}}",
            "back_template": "{{Back}}",
            "generation_prompt": "gen"
        });

        let req = TemplateDesignerExecutor::parse_update_request(&patch).unwrap();
        assert_eq!(req.expected_version.as_deref(), Some("2.1.0"));
        assert_eq!(req.note_type.as_deref(), Some("Basic"));
        assert_eq!(req.front_template.as_deref(), Some("{{Front}}"));
    }

    #[test]
    fn test_parse_update_request_no_expected_version() {
        let patch = json!({
            "name": "No Version"
        });

        let req = TemplateDesignerExecutor::parse_update_request(&patch).unwrap();
        assert!(
            req.expected_version.is_none(),
            "expected_version should be None when not provided"
        );
    }

    #[test]
    fn test_parse_update_request_with_fields_and_rules() {
        let patch = json!({
            "expectedVersion": "1.0.0",
            "fields": ["Front", "Back", "Extra"],
            "fieldExtractionRules": {
                "Front": { "field_type": "Text", "is_required": true, "description": "正面" },
                "Back": { "field_type": "Text", "is_required": true, "description": "背面" },
                "Extra": { "field_type": "Text", "is_required": false, "description": "额外" }
            }
        });

        let req = TemplateDesignerExecutor::parse_update_request(&patch).unwrap();
        assert_eq!(req.fields.as_ref().unwrap().len(), 3);
        assert_eq!(req.field_extraction_rules.as_ref().unwrap().len(), 3);
        assert!(req
            .field_extraction_rules
            .as_ref()
            .unwrap()
            .contains_key("Extra"));
    }

    #[test]
    fn test_get_args_accepts_snake_case_alias() {
        let args: TemplateGetArgs =
            serde_json::from_value(json!({ "template_id": "tpl-1" })).unwrap();
        assert_eq!(args.template_id, "tpl-1");
    }

    #[test]
    fn test_validate_args_accepts_template_definition_alias() {
        let args: TemplateValidateArgs =
            serde_json::from_value(json!({ "templateDefinition": { "name": "x" } })).unwrap();
        assert_eq!(
            args.template.get("name").and_then(|v| v.as_str()),
            Some("x")
        );
    }

    #[test]
    fn test_create_args_accepts_template_definition_alias() {
        let args: TemplateCreateArgs =
            serde_json::from_value(json!({ "template_definition": { "name": "x" } })).unwrap();
        assert_eq!(
            args.template.get("name").and_then(|v| v.as_str()),
            Some("x")
        );
    }

    #[test]
    fn test_fork_args_accepts_template_id_alias() {
        let args: TemplateForkArgs =
            serde_json::from_value(json!({ "templateId": "src-1" })).unwrap();
        assert_eq!(args.source_template_id, "src-1");
    }

    #[test]
    fn test_normalize_patch_value_accepts_json_string_object() {
        let raw = json!("{\"expectedVersion\":\"1.0.0\",\"name\":\"new\"}");
        let normalized = TemplateDesignerExecutor::normalize_patch_value(&raw).unwrap();
        assert_eq!(
            normalized.get("expectedVersion").and_then(|v| v.as_str()),
            Some("1.0.0")
        );
    }

    #[test]
    fn test_normalize_template_value_accepts_json_string_object() {
        let raw = json!("{\"name\":\"My Template\",\"fields\":[\"Front\",\"Back\"]}");
        let normalized = TemplateDesignerExecutor::normalize_template_value(&raw).unwrap();
        assert_eq!(
            normalized.get("name").and_then(|v| v.as_str()),
            Some("My Template")
        );
        assert!(normalized
            .get("fields")
            .and_then(|v| v.as_array())
            .is_some());
    }

    #[test]
    fn test_update_args_accepts_top_level_expected_version_alias() {
        let args: TemplateUpdateArgs = serde_json::from_value(json!({
            "templateId": "tpl-1",
            "patch": {},
            "expected_version": "1.0.0"
        }))
        .unwrap();
        assert_eq!(args.expected_version.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn test_update_args_allows_flat_patch_fields_without_patch_object() {
        let args: TemplateUpdateArgs = serde_json::from_value(json!({
            "templateId": "tpl-1",
            "expectedVersion": "1.0.0",
            "name": "Flat Patch"
        }))
        .unwrap();

        assert!(args.patch.is_none());
        assert_eq!(args.expected_version.as_deref(), Some("1.0.0"));
        assert_eq!(
            args.extra.get("name").and_then(|v| v.as_str()),
            Some("Flat Patch")
        );
    }

    #[test]
    fn test_has_update_changes_only_expected_version_returns_false() {
        let req = UpdateTemplateRequest {
            name: None,
            description: None,
            author: None,
            version: None,
            expected_version: Some("1.0.0".to_string()),
            preview_front: None,
            preview_back: None,
            note_type: None,
            fields: None,
            generation_prompt: None,
            front_template: None,
            back_template: None,
            css_style: None,
            field_extraction_rules: None,
            is_active: None,
            preview_data_json: None,
            is_built_in: None,
        };

        assert!(!TemplateDesignerExecutor::has_update_changes(&req));
    }

    // ------------------------------------------------------------------
    // [P2 回归] template_list 参数错误 fail-fast
    // ------------------------------------------------------------------

    #[test]
    fn test_list_args_invalid_type_fails() {
        // activeOnly 传了字符串而非 bool，应解析失败
        let result: Result<TemplateListArgs, _> =
            serde_json::from_value(json!({ "activeOnly": "yes" }));
        assert!(
            result.is_err(),
            "Should fail when activeOnly is not a boolean"
        );
    }

    #[test]
    fn test_list_args_invalid_limit_type_fails() {
        // limit 传了字符串而非 number，应解析失败
        let result: Result<TemplateListArgs, _> =
            serde_json::from_value(json!({ "limit": "fifty" }));
        assert!(result.is_err(), "Should fail when limit is not a number");
    }

    // ------------------------------------------------------------------
    // [P1 回归] fields 含非字符串元素时报错（数据破坏防护）
    // ------------------------------------------------------------------

    #[test]
    fn test_create_fields_with_non_string_elements_fails() {
        let val = json!({
            "name": "Test",
            "description": "desc",
            "fields": [1, 2],
            "frontTemplate": "{{Front}}",
            "backTemplate": "{{Back}}",
            "generationPrompt": "gen",
            "fieldExtractionRules": {}
        });

        let result = TemplateDesignerExecutor::parse_create_request(&val);
        assert!(
            result.is_err(),
            "Should fail when fields contains non-string elements"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("fields[0]"),
            "Error should indicate which index: {}",
            err
        );
        assert!(
            err.contains("字符串"),
            "Error should mention string type: {}",
            err
        );
    }

    #[test]
    fn test_update_fields_with_non_string_elements_fails() {
        let val = json!({
            "expectedVersion": "1.0.0",
            "fields": ["Front", 42, "Back"]
        });

        let result = TemplateDesignerExecutor::parse_update_request(&val);
        assert!(
            result.is_err(),
            "Should fail when fields contains non-string element"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("fields[1]"),
            "Error should indicate index 1: {}",
            err
        );
    }

    #[test]
    fn test_update_fields_not_array_fails() {
        let val = json!({
            "expectedVersion": "1.0.0",
            "fields": "Front,Back"
        });

        let result = TemplateDesignerExecutor::parse_update_request(&val);
        assert!(result.is_err(), "Should fail when fields is not an array");
        let err = result.unwrap_err();
        assert!(
            err.contains("字符串数组"),
            "Error should mention array: {}",
            err
        );
    }

    // ------------------------------------------------------------------
    // [P2 回归] patch 字段类型错误时报错（非静默忽略）
    // ------------------------------------------------------------------

    #[test]
    fn test_update_name_wrong_type_fails() {
        let val = json!({
            "expectedVersion": "1.0.0",
            "name": 123
        });

        let result = TemplateDesignerExecutor::parse_update_request(&val);
        assert!(result.is_err(), "Should fail when name is not a string");
        let err = result.unwrap_err();
        assert!(
            err.contains("name"),
            "Error should mention field name: {}",
            err
        );
        assert!(
            err.contains("字符串"),
            "Error should mention expected type: {}",
            err
        );
    }

    #[test]
    fn test_update_is_active_wrong_type_fails() {
        let val = json!({
            "expectedVersion": "1.0.0",
            "isActive": "yes"
        });

        let result = TemplateDesignerExecutor::parse_update_request(&val);
        assert!(
            result.is_err(),
            "Should fail when isActive is not a boolean"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("isActive"),
            "Error should mention field: {}",
            err
        );
        assert!(
            err.contains("布尔值"),
            "Error should mention boolean: {}",
            err
        );
    }

    #[test]
    fn test_update_expected_version_wrong_type_fails() {
        let val = json!({
            "expectedVersion": true
        });

        let result = TemplateDesignerExecutor::parse_update_request(&val);
        assert!(
            result.is_err(),
            "Should fail when expectedVersion is a number"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("expectedVersion"),
            "Error should mention field: {}",
            err
        );
    }

    #[test]
    fn test_update_expected_version_number_is_normalized_to_string() {
        let val = json!({
            "expectedVersion": 100
        });

        let result = TemplateDesignerExecutor::parse_update_request(&val).unwrap();
        assert_eq!(result.expected_version.as_deref(), Some("100"));
    }

    #[test]
    fn test_update_args_accepts_template_definition_alias() {
        let args: TemplateUpdateArgs = serde_json::from_value(json!({
            "templateId": "tpl-1",
            "template_definition": {
                "expectedVersion": "1.0.0",
                "description": "patched"
            }
        }))
        .unwrap();

        assert!(args.patch.is_none());
        assert!(args.template.is_some());
    }

    #[test]
    fn test_create_note_type_wrong_type_fails() {
        let val = json!({
            "name": "Test",
            "noteType": 42,
            "fields": ["F"],
            "frontTemplate": "t",
            "backTemplate": "t",
            "generationPrompt": "g",
            "fieldExtractionRules": {
                "F": { "field_type": "Text", "is_required": true, "description": "f" }
            }
        });

        let result = TemplateDesignerExecutor::parse_create_request(&val);
        assert!(result.is_err(), "Should fail when noteType is not a string");
        let err = result.unwrap_err();
        assert!(
            err.contains("noteType"),
            "Error should mention field: {}",
            err
        );
    }

    #[test]
    fn test_create_is_active_wrong_type_fails() {
        let val = json!({
            "name": "Test",
            "fields": ["F"],
            "frontTemplate": "t",
            "backTemplate": "t",
            "generationPrompt": "g",
            "isActive": "true",
            "fieldExtractionRules": {
                "F": { "field_type": "Text", "is_required": true, "description": "f" }
            }
        });

        let result = TemplateDesignerExecutor::parse_create_request(&val);
        assert!(
            result.is_err(),
            "Should fail when isActive is string 'true'"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("isActive"),
            "Error should mention field: {}",
            err
        );
    }

    // null 值应被视为"未提供"，不报错
    #[test]
    fn test_update_null_values_treated_as_absent() {
        let val = json!({
            "expectedVersion": "1.0.0",
            "name": null,
            "fields": null,
            "isActive": null
        });

        let req = TemplateDesignerExecutor::parse_update_request(&val).unwrap();
        assert_eq!(req.expected_version.as_deref(), Some("1.0.0"));
        assert!(req.name.is_none(), "null name should be None");
        assert!(req.fields.is_none(), "null fields should be None");
        assert!(req.is_active.is_none(), "null isActive should be None");
    }
}
