use crate::database::Database;
use crate::llm_manager::ApiConfig;
use crate::llm_manager::LLMManager;
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

#[derive(Clone)]
pub struct StreamingAnkiService {
    db: Arc<Database>,
    llm_manager: Arc<LLMManager>,
    client: Client,
    pause_senders: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
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

impl StreamingAnkiService {
    pub fn new(db: Arc<Database>, llm_manager: Arc<LLMManager>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(600)) // 10分钟超时，适合流式处理
            .build()
            .expect("创建HTTP客户端失败");
        let pause_senders = Arc::new(Mutex::new(HashMap::new()));

        Self {
            db,
            llm_manager,
            client,
            pause_senders,
        }
    }

    /// 处理任务并流式生成卡片
    pub async fn process_task_and_generate_cards_stream(
        &self,
        task: DocumentTask,
        window: Window,
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

        // 获取配置
        let api_config = match self.get_configurations("通用").await {
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
        let prompt_payload = match self.build_prompt(&task.content_segment, &options) {
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
            .or(options.max_tokens.map(|t| t as u32))
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
        // 设置暂停与取消通道
        let (pause_tx, pause_rx) = watch::channel(false);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        {
            let mut senders = self.pause_senders.lock().await;
            senders.insert(task_id.clone(), pause_tx);
        }
        {
            let mut senders = CANCEL_SENDERS.lock().await;
            senders.insert(task_id.clone(), cancel_tx);
        }
        let result = self
            .stream_cards_from_ai(
                &api_config,
                &prompt_payload,
                max_tokens,
                temperature,
                &task_id,
                &task.document_id,
                &window,
                &options,
                pause_rx,
                cancel_rx,
            )
            .await;

        match result {
            Ok(card_count) => {
                self.complete_task_successfully(&task_id, card_count, &task.document_id, &window)
                    .await?;
            }
            Err(e) => {
                if e.message == "CANCELLED_BY_USER" {
                    // 由上层 EnhancedAnkiService 负责将任务状态置为 Paused 并派发事件，避免重复事件
                    info!("🛑 任务被用户取消，保持暂停态由调度层处理: {}", task_id);
                } else {
                    self.handle_task_error(
                        &task_id,
                        &e,
                        &window,
                        Some(task.segment_index),
                        Some(task.document_id.as_str()),
                    )
                    .await?;
                }
            }
        }
        // 清理暂停/取消通道
        self.pause_senders.lock().await.remove(&task_id);
        CANCEL_SENDERS.lock().await.remove(&task_id);

        Ok(())
    }

    /// 获取API配置
    async fn get_configurations(&self, _subject_name: &str) -> Result<ApiConfig, AppError> {
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
    ) -> Result<PromptPayload, AppError> {
        // 获取基础prompt（优先级：模板prompt > 默认prompt）
        let base_prompt = if let Some(custom_prompt) = &options.custom_anki_prompt {
            custom_prompt.clone()
        } else {
            // 默认 Anki 制卡 prompt
            "你是一个专业的 Anki 学习卡片制作助手。请根据提供的学习内容，生成高质量的 Anki 学习卡片。\n\n要求：\n1. 卡片应该有助于记忆和理解\n2. 问题要简洁明确\n3. 答案要准确完整\n4. 适当添加相关标签\n5. 确保卡片的逻辑性和实用性".to_string()
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

        let multi_template = options
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
                .unwrap_or(false);

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

        let (fields_requirement, example_json) = if multi_template {
            (
                "template_id（字符串）+ 所选模板的必需字段（见上方模板列表）".to_string(),
                "{\"template_id\": \"<模板ID>\", \"<字段名>\": \"内容\"}".to_string(),
            )
        } else if let Some(fields) = template_fields.as_ref() {
            let fields_requirement = fields
                .iter()
                .map(|field| match field.as_str() {
                    "front" => "front（字符串）：问题或概念".to_string(),
                    "back" => "back（字符串）：答案或解释".to_string(),
                    "tags" => "tags（字符串数组）：相关标签".to_string(),
                    "example" => "example（字符串，可选）：具体示例".to_string(),
                    "source" => "source（字符串，可选）：来源信息".to_string(),
                    "code" => "code（字符串，可选）：代码示例".to_string(),
                    "notes" => "notes（字符串，可选）：补充注释".to_string(),
                    _ => format!("{}（字符串，可选）：{}", field, field),
                })
                .collect::<Vec<_>>()
                .join("、");

            let example_json = {
                let mut example_fields = vec![];
                for field in fields {
                    match field.as_str() {
                        "front" => example_fields.push("\"front\": \"问题内容\"".to_string()),
                        "back" => example_fields.push("\"back\": \"答案内容\"".to_string()),
                        "tags" => {
                            example_fields.push("\"tags\": [\"标签1\", \"标签2\"]".to_string())
                        }
                        "example" => example_fields.push("\"example\": \"示例内容\"".to_string()),
                        "source" => example_fields.push("\"source\": \"来源信息\"".to_string()),
                        "code" => example_fields.push("\"code\": \"代码示例\"".to_string()),
                        "notes" => example_fields.push("\"notes\": \"注释内容\"".to_string()),
                        _ => example_fields.push(format!("\"{}\": \"{}内容\"", field, field)),
                    }
                }
                format!("{{{}}}", example_fields.join(", "))
            };

            (fields_requirement, example_json)
        } else {
            (
                "front/back/tags（默认字段）".to_string(),
                "{\"front\": \"问题内容\", \"back\": \"答案内容\", \"tags\": [\"标签\"]}"
                    .to_string(),
            )
        };

        // 已在系统段开头处理自定义要求

        // 构建卡片数量要求
        let card_count_instruction = if options.max_cards_per_mistake > 0 {
            format!(
                "🚨 卡片数量硬性限制 🚨\n\
                你必须严格生成**恰好 {} 张**卡片，不多不少。\n\
                - 生成到第 {} 张后立即停止，不要再输出任何卡片\n\
                - 确保每张卡片都是高质量的，覆盖内容中最重要的知识点\n\
                - 如果内容不够生成 {} 张，则生成尽可能多但不超过 {} 张\n\n",
                options.max_cards_per_mistake,
                options.max_cards_per_mistake,
                options.max_cards_per_mistake,
                options.max_cards_per_mistake
            )
        } else {
            "根据内容的信息密度生成适量的高质量卡片，充分覆盖所有知识点。\n\n".to_string()
        };

        // 增强prompt以支持流式输出和动态字段
        let generation_instructions = format!(
            "{}\
            重要指令：\n\
            1. 请逐个生成卡片，每个卡片必须是完整的JSON格式\n\
            2. 每生成一个完整的卡片JSON后，立即输出分隔符：<<<ANKI_CARD_JSON_END>>>\n\
            3. JSON格式必须包含以下字段：{}\n\
            4. 不要使用Markdown代码块，直接输出JSON\n\
            5. 示例输出格式：\n\
            {}\n\
            <<<ANKI_CARD_JSON_END>>>",
            card_count_instruction, fields_requirement, example_json
        );

        let user_message = format!(
            "{}\n\n请根据以下内容生成Anki卡片：\n\n{}",
            generation_instructions, content
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
    async fn stream_cards_from_ai(
        &self,
        api_config: &ApiConfig,
        prompt_payload: &PromptPayload,
        max_tokens: u32,
        temperature: f32,
        task_id: &str,
        document_id: &str,
        window: &Window,
        options: &AnkiGenerationOptions,
        pause_rx: watch::Receiver<bool>,
        mut cancel_rx: watch::Receiver<bool>,
    ) -> Result<u32, AppError> {
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

        let request_body = json!({
            "model": api_config.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": true
        });

        // 使用 ProviderAdapter 构建请求（支持 Gemini 中转）
        let adapter: Box<dyn ProviderAdapter> = match api_config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };
        let preq = adapter
            .build_request(
                &api_config.base_url,
                &api_config.api_key,
                &api_config.model,
                &request_body,
            )
            .map_err(|e| AppError::llm(format!("Anki 流式请求构建失败: {}", e)))?;

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

        let mut req_builder = self.client
            .post(&request_url)
            .header("Accept", "text/event-stream, application/json, text/plain, */*")
            .header("Accept-Encoding", "identity")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("Connection", "keep-alive")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
        for (k, v) in preq.headers {
            req_builder = req_builder.header(k, v);
        }

        let response = req_builder
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("AI请求失败: {}", e)))?;

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
        let mut card_count = 0u32;
        let mut _last_activity = std::time::Instant::now(); // Prefixed to silence warning
        const IDLE_TIMEOUT: Duration = Duration::from_secs(30); // 30秒无响应超时
        const LOG_STREAM_CHUNKS: bool = false; // 禁用逐chunk日志
                                               // 初始化SSE行缓冲器
        let mut sse_buffer = crate::utils::sse_buffer::SseLineBuffer::new();
        let mut chunk_counter: u32 = 0;
        let mut reached_card_limit = false;

        loop {
            // 同时监听取消信号与流事件
            let next_item = tokio::select! {
                _ = cancel_rx.changed() => {
                    info!("🛑 检测到取消信号，终止流式制卡");
                    return Err(AppError::validation("CANCELLED_BY_USER".to_string()));
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
            let chunk_str = String::from_utf8_lossy(&chunk);
            // 处理SSE格式 - 使用SSE缓冲器处理chunk，获取完整的行
            let complete_lines = sse_buffer.process_chunk(&chunk_str);
            for line in complete_lines {
                // 检查是否是结束标记
                if crate::utils::sse_buffer::SseLineBuffer::check_done_marker(&line) {
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
                            // 暂停时只累积 buffer，不生成卡片
                            if *cancel_rx.borrow() {
                                return Err(AppError::validation("CANCELLED_BY_USER".to_string()));
                            }
                            if *pause_rx.borrow() {
                                continue;
                            }

                            // 检查是否有完整的卡片
                            while let Some(card_result) = self.extract_card_from_buffer(&mut buffer)
                            {
                                // 硬截断：达到 max_cards_per_mistake 上限时停止
                                if options.max_cards_per_mistake > 0
                                    && card_count as i32 >= options.max_cards_per_mistake
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
                                            .parse_and_save_card(&card_json, task_id, options)
                                            .await
                                        {
                                            Ok(Some(card)) => {
                                                card_count += 1;
                                                debug!("[ANKI_CARD_DEBUG] 已生成第{}张卡片 (上限: {}张)", card_count, options.max_cards_per_mistake);
                                                self.emit_new_card(card, document_id, window).await;
                                            }
                                            Ok(None) => {
                                                // 重复或被跳过的卡片，记录日志但不中断流程
                                                debug!("[ANKI_CARD_DEBUG] 卡片被跳过（重复或不需要保存）");
                                            }
                                            Err(e) => {
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
                                                                &task_id,
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
            // 处理SSE缓冲器中剩余的不完整行
            if let Some(remaining_line) = sse_buffer.flush() {
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

            // 处理剩余缓冲区内容
            if !buffer.trim().is_empty() {
                if let Ok(error_card) = self.create_error_card(&buffer, task_id).await {
                    self.emit_error_card(error_card, document_id, window).await;
                }
            }
        }

        if LOG_STREAM_CHUNKS {
            debug!("[ANKI_RESPONSE_STREAM] total_chunks={}", chunk_counter);
            debug!(
                "[ANKI_RESPONSE_STREAM] cards_generated={} residual_len={}",
                card_count,
                buffer.len()
            );
        }

        Ok(card_count)
    }

    /// 从缓冲区提取卡片
    fn extract_card_from_buffer(&self, buffer: &mut String) -> Option<Result<String, String>> {
        const DELIMITER: &str = "<<<ANKI_CARD_JSON_END>>>";

        // 先尝试查找标准分隔符
        if let Some(delimiter_pos) = buffer.find(DELIMITER) {
            let card_content = buffer[..delimiter_pos].trim().to_string();
            let remaining = buffer[delimiter_pos + DELIMITER.len()..].to_string();
            *buffer = remaining;

            if !card_content.is_empty() {
                Some(Ok(card_content))
            } else {
                None
            }
        } else {
            // 如果找不到标准分隔符，尝试查找可能损坏的分隔符模式
            // 使用正则表达式匹配类似 <<<...ANKI_CARD_JSON_END>>> 的模式
            if let Some(pos) = buffer.find("ANKI_CARD_JSON_END>>>") {
                // 向前查找 "<<<" 的位置
                let start_pos = buffer[..pos].rfind("<<<");
                if let Some(start) = start_pos {
                    let card_content = buffer[..start].trim().to_string();
                    // 找到完整的损坏分隔符的结束位置
                    let end_pos = pos + "ANKI_CARD_JSON_END>>>".len();
                    let remaining = buffer[end_pos..].to_string();
                    *buffer = remaining;

                    warn!("[ANKI_CARD_DEBUG] 检测到损坏的分隔符，已自动修复");

                    if !card_content.is_empty() {
                        Some(Ok(card_content))
                    } else {
                        None
                    }
                } else if buffer.len() > 10000 {
                    // 如果缓冲区过大，可能是截断
                    let truncated = buffer.clone();
                    buffer.clear();
                    Some(Err(truncated))
                } else {
                    None
                }
            } else if buffer.len() > 10000 {
                // 如果缓冲区过大，可能是截断
                let truncated = buffer.clone();
                buffer.clear();
                Some(Err(truncated))
            } else {
                None
            }
        }
    }

    /// 解析并保存卡片 - 支持动态字段提取规则
    async fn parse_and_save_card(
        &self,
        card_json: &str,
        task_id: &str,
        options: &AnkiGenerationOptions,
    ) -> Result<Option<AnkiCard>, AppError> {
        // 清理JSON字符串
        let cleaned_json = self.clean_json_string(card_json);

        // 解析JSON
        let json_value: Value = serde_json::from_str(&cleaned_json).map_err(|e| {
            error!("[ANKI_PARSE_ERROR] JSON解析失败");
            error!("[ANKI_PARSE_ERROR] 错误信息: {}", e);
            error!("[ANKI_PARSE_ERROR] 原始内容: {}", card_json);
            error!("[ANKI_PARSE_ERROR] 清理后内容: {}", cleaned_json);
            AppError::validation(format!("JSON解析失败: {}", e))
        })?;

        let multi_template = options
            .template_ids
            .as_ref()
            .map(|ids| ids.len() > 1)
            .unwrap_or(false)
            || options
                .template_descriptions
                .as_ref()
                .map(|descriptions| descriptions.len() > 1)
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
                .unwrap_or(false);

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
        let cleaned_tags: Vec<String> = tags
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

        // 创建卡片
        let now = Utc::now().to_rfc3339();
        let card = AnkiCard {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.to_string(),
            front: cleaned_front,
            back: cleaned_back,
            text: cleaned_extra_fields.get("text").cloned(), // 从清理后的extra_fields中提取text字段
            tags: cleaned_tags,
            images: Vec::new(),
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
                return trimmed[start..=end].to_string();
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
                            front = processed_value.clone();
                            // 对于使用模板的卡片，也将Front字段存储到extra_fields中
                            extra_fields.insert("front".to_string(), processed_value);
                        }
                        "back" => {
                            back = self.process_field_value(&value, &rule.field_type)?;
                        }
                        "tags" => {
                            tags = self.process_tags_field(&value, &rule.field_type)?;
                        }
                        "explanation" => {
                            // 选择题的答案需要组合多个字段
                            let explanation_text =
                                self.process_field_value(&value, &rule.field_type)?;
                            // 先保存explanation，稍后组合完整答案
                            extra_fields.insert("explanation".to_string(), explanation_text);
                        }
                        // 填空题模板字段映射
                        "text" => {
                            // 对于填空题，Text字段应该保存到extra_fields中，用于Cloze模板
                            let processed_value =
                                self.process_field_value(&value, &rule.field_type)?;
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
                if let Some(first) = fields.get(0) {
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

        // 最后仍为空则用整个 JSON
        if front.is_empty() {
            front = json_value.to_string();
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
                let skip_keys: std::collections::HashSet<&str> =
                    ["front", "tags", "template_id", "templateid", "text"]
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

    /// 成功完成任务
    async fn complete_task_successfully(
        &self,
        task_id: &str,
        card_count: u32,
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

        // 发送任务完成事件
        // 🔧 CardForge 2.0 修复：直接发射 StreamedCardPayload
        let payload = StreamedCardPayload::TaskCompleted {
            task_id: task_id.to_string(),
            final_status: TaskStatus::Completed,
            total_cards_generated: card_count,
            document_id: Some(document_id.to_string()),
        };

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
        let final_status = if error_message.contains("超时") || error_message.contains("截断") {
            TaskStatus::Truncated
        } else {
            TaskStatus::Failed
        };

        self.update_task_status(
            task_id,
            final_status.clone(),
            Some(error_message.clone()),
            segment_index,
            document_id,
            window,
        )
        .await?;

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

    /// 暂停流式制卡
    pub async fn pause_streaming(&self, task_id: String) -> Result<(), String> {
        let senders = self.pause_senders.lock().await;
        if let Some(tx) = senders.get(&task_id) {
            let _ = tx.send(true);
            Ok(())
        } else {
            Err(format!("任务 {} 未在运行状态", task_id))
        }
    }

    /// 继续流式制卡
    pub async fn resume_streaming(&self, task_id: String) -> Result<(), String> {
        let senders = self.pause_senders.lock().await;
        if let Some(tx) = senders.get(&task_id) {
            let _ = tx.send(false);
            Ok(())
        } else {
            Err(format!("任务 {} 未在运行状态", task_id))
        }
    }

    /// 取消当前流式制卡（用于硬暂停）
    pub async fn cancel_streaming(&self, task_id: String) -> Result<(), String> {
        let senders = CANCEL_SENDERS.lock().await;
        if let Some(tx) = senders.get(&task_id) {
            let _ = tx.send(true);
            Ok(())
        } else {
            Err(format!("任务 {} 未在运行状态", task_id))
        }
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
                        if !ec.trim().is_empty() && !ec.starts_with(RETRY_ASSIGNMENT_MARK) {
                            error_cards.push(c);
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
        aggregated.push_str("严格要求：\n- 对每条 ==FIX== 段，输出1个或多个完整卡片JSON\n- 每个卡片JSON输出后紧跟分隔符 <<<ANKI_CARD_JSON_END>>>\n- 不输出任何额外解释或Markdown，只输出JSON与分隔符\n\n");
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
}
