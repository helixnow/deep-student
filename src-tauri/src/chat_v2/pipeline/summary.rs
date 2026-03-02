use super::*;

impl ChatV2Pipeline {
    // ========================================================================
    // 自动摘要生成（标题 + 简介）
    // ========================================================================

    /// 摘要生成 Prompt（同时生成标题和简介）
    const SUMMARY_GENERATION_PROMPT: &'static str = r#"请根据以下对话内容生成会话标题和简介。

要求：
1. 标题（title）：5-20 个字符，概括对话主题
2. 简介（description）：30-80 个字符，描述对话的主要内容和结论
3. 使用中文
4. 不要使用引号包裹
5. 按 JSON 格式输出：{"title": "标题", "description": "简介"}

用户问题：
{user_content}

助手回复（摘要）：
{assistant_content}

请输出 JSON："#;

    /// 自动生成会话摘要（标题 + 简介）
    ///
    /// 在每轮对话完成后调用，根据对话内容生成标题和简介。
    /// 通过内容哈希防止重复生成。
    ///
    /// ## 参数
    /// - `session_id`: 会话 ID
    /// - `user_content`: 用户消息内容
    /// - `assistant_content`: 助手回复内容
    /// - `emitter`: 事件发射器（用于通知前端）
    ///
    /// ## 说明
    /// - 异步执行，不阻塞主流程
    /// - 生成失败不影响对话功能
    /// - 标题长度限制为 50 字符，简介限制为 100 字符
    pub async fn generate_summary(
        &self,
        session_id: &str,
        user_content: &str,
        assistant_content: &str,
        emitter: Arc<ChatV2EventEmitter>,
    ) {
        log::info!(
            "[ChatV2::pipeline] Generating summary for session={}",
            session_id
        );

        // 截取助手回复的前 500 个字符作为摘要（安全处理 UTF-8）
        let assistant_summary: String = assistant_content.chars().take(500).collect();

        // 构建 prompt
        let prompt = Self::SUMMARY_GENERATION_PROMPT
            .replace("{user_content}", user_content)
            .replace("{assistant_content}", &assistant_summary);

        // 调用 LLM 生成摘要
        let response = match self.call_llm_for_summary(&prompt).await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[ChatV2::pipeline] Failed to generate summary: {}", e);
                return;
            }
        };

        // 解析 JSON 响应
        let (title, description) = match Self::parse_summary_response(&response) {
            Some((t, d)) => (t, d),
            None => {
                log::warn!(
                    "[ChatV2::pipeline] Failed to parse summary JSON: {}",
                    response
                );
                // 回退：将整个响应作为标题，简介留空
                let fallback_title = response
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .chars()
                    .take(50)
                    .collect::<String>();
                if fallback_title.is_empty() {
                    return;
                }
                (fallback_title, String::new())
            }
        };

        if title.is_empty() {
            log::warn!("[ChatV2::pipeline] Generated title is empty");
            return;
        }

        log::info!(
            "[ChatV2::pipeline] Generated summary for session={}: title={}, description={}",
            session_id,
            title,
            description
        );

        // 计算内容哈希（用于防重复生成）
        let content_hash = Self::compute_content_hash(user_content, &assistant_summary);

        // 更新数据库
        if let Err(e) = self
            .update_session_summary(session_id, &title, &description, &content_hash)
            .await
        {
            log::error!("[ChatV2::pipeline] Failed to update session summary: {}", e);
            return;
        }

        // 发送事件通知前端
        emitter.emit_summary_updated(&title, &description);
    }

    /// 解析摘要生成的 JSON 响应
    fn parse_summary_response(response: &str) -> Option<(String, String)> {
        // 尝试解析 JSON
        let response = response.trim();

        // 处理可能的 markdown 代码块包裹
        let json_str = if response.starts_with("```") {
            response
                .trim_start_matches("```json")
                .trim_start_matches("```")
                .trim_end_matches("```")
                .trim()
        } else {
            response
        };

        // 解析 JSON
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
            let title = v
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim_matches('「')
                .trim_matches('」');

            let description = v
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();

            // 截取长度
            let title = if title.chars().count() > 50 {
                title.chars().take(50).collect::<String>()
            } else {
                title.to_string()
            };

            let description = if description.chars().count() > 100 {
                description.chars().take(100).collect::<String>()
            } else {
                description.to_string()
            };

            if !title.is_empty() {
                return Some((title, description));
            }
        }

        None
    }

    /// 计算内容哈希（用于防重复生成）
    fn compute_content_hash(user_content: &str, assistant_content: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(user_content.as_bytes());
        hasher.update(b"|");
        hasher.update(assistant_content.as_bytes());
        let result = hasher.finalize();
        // 取前 16 字节作为哈希
        hex::encode(&result[..16])
    }

    /// 调用 LLM 生成摘要（简单的非流式调用）
    ///
    /// 使用标题/标签生成模型（回退链：chat_title_model → model2）。
    ///
    /// 🔧 P1修复：添加 Pipeline 层超时保护
    async fn call_llm_for_summary(&self, prompt: &str) -> ChatV2Result<String> {
        // 调用 LLM（非流式），使用标题生成专用模型，带超时保护
        let llm_future = self.llm_manager.call_chat_title_raw_prompt(prompt);

        let response =
            match timeout(Duration::from_secs(LLM_NON_STREAM_TIMEOUT_SECS), llm_future).await {
                Ok(result) => {
                    result.map_err(|e| ChatV2Error::Llm(format!("LLM call failed: {}", e)))?
                }
                Err(_) => {
                    log::error!(
                        "[ChatV2::pipeline] LLM summary call timeout after {}s",
                        LLM_NON_STREAM_TIMEOUT_SECS
                    );
                    return Err(ChatV2Error::Timeout(format!(
                        "LLM summary call timed out after {}s",
                        LLM_NON_STREAM_TIMEOUT_SECS
                    )));
                }
            };

        // 提取内容
        let summary = response.assistant_message.trim().to_string();
        Ok(summary)
    }

    /// 更新会话摘要（标题 + 简介 + 哈希）
    async fn update_session_summary(
        &self,
        session_id: &str,
        title: &str,
        description: &str,
        summary_hash: &str,
    ) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;

        let desc_value = if description.is_empty() {
            None
        } else {
            Some(description)
        };
        let now = chrono::Utc::now().to_rfc3339();

        let rows = conn.execute(
            "UPDATE chat_v2_sessions SET title = ?2, description = ?3, summary_hash = ?4, updated_at = ?5 WHERE id = ?1",
            rusqlite::params![session_id, title, desc_value, summary_hash, now],
        )?;

        if rows == 0 {
            return Err(ChatV2Error::SessionNotFound(session_id.to_string()));
        }

        log::debug!(
            "[ChatV2::pipeline] Session summary updated: session={}, title={}, description={}",
            session_id,
            title,
            description
        );

        Ok(())
    }

    /// 检查会话是否需要生成摘要
    ///
    /// 条件：内容哈希与上次生成时不同
    pub(crate) async fn should_generate_summary(
        &self,
        session_id: &str,
        user_content: &str,
        assistant_content: &str,
    ) -> bool {
        // 计算当前内容哈希
        let assistant_summary: String = assistant_content.chars().take(500).collect();
        let current_hash = Self::compute_content_hash(user_content, &assistant_summary);

        // 获取会话中保存的哈希
        let conn = match self.db.get_conn_safe() {
            Ok(c) => c,
            Err(_) => return true, // 出错时允许生成
        };

        let session = match ChatV2Repo::get_session_with_conn(&conn, session_id) {
            Ok(Some(s)) => s,
            Ok(None) | Err(_) => return true, // 会话不存在时允许生成
        };

        // 如果哈希相同，不需要重新生成
        match &session.summary_hash {
            Some(hash) if hash == &current_hash => {
                log::debug!(
                    "[ChatV2::pipeline] Skip summary generation, hash unchanged: {}",
                    session_id
                );
                false
            }
            _ => true,
        }
    }

    // ========================================================================
    // 自动标签提取
    // ========================================================================

    /// 标签提取 Prompt
    const TAG_EXTRACTION_PROMPT: &'static str = r#"请从以下对话中提取3-6个关键标签。

要求：
1. 每个标签2-6个字，简短精练
2. 优先提取：科目名称、核心概念、题型、方法论
3. 语言与对话内容一致
4. 按 JSON 数组格式输出：["标签1", "标签2", "标签3"]

用户问题：
{user_content}

助手回复（摘要）：
{assistant_content}

请直接输出 JSON 数组："#;

    /// 自动提取会话标签（异步，不阻塞主流程）
    pub async fn generate_session_tags(
        &self,
        session_id: &str,
        user_content: &str,
        assistant_content: &str,
    ) {
        log::info!(
            "[ChatV2::pipeline] Generating tags for session={}",
            session_id
        );

        let assistant_summary: String = assistant_content.chars().take(500).collect();
        let content_hash = Self::compute_content_hash(user_content, &assistant_summary);

        // 检查是否需要生成标签（哈希去重）
        {
            let conn = match self.db.get_conn_safe() {
                Ok(c) => c,
                Err(_) => return,
            };
            if let Ok(Some(session)) = ChatV2Repo::get_session_with_conn(&conn, session_id) {
                if session.tags_hash.as_deref() == Some(&content_hash) {
                    log::debug!(
                        "[ChatV2::pipeline] Skip tag generation, hash unchanged: {}",
                        session_id
                    );
                    return;
                }
            }
        }

        let prompt = Self::TAG_EXTRACTION_PROMPT
            .replace("{user_content}", user_content)
            .replace("{assistant_content}", &assistant_summary);

        let response = match self.call_llm_for_summary(&prompt).await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[ChatV2::pipeline] Failed to generate tags: {}", e);
                return;
            }
        };

        let tags = match Self::parse_tags_response(&response) {
            Some(t) if !t.is_empty() => t,
            _ => {
                log::debug!(
                    "[ChatV2::pipeline] No tags extracted from response: {}",
                    response
                );
                return;
            }
        };

        log::info!(
            "[ChatV2::pipeline] Extracted {} tags for session={}: {:?}",
            tags.len(),
            session_id,
            tags
        );

        let conn = match self.db.get_conn_safe() {
            Ok(c) => c,
            Err(e) => {
                log::error!("[ChatV2::pipeline] Failed to get conn for tags: {}", e);
                return;
            }
        };

        if let Err(e) = ChatV2Repo::upsert_auto_tags(&conn, session_id, &tags) {
            log::error!("[ChatV2::pipeline] Failed to save tags: {}", e);
            return;
        }

        if let Err(e) = ChatV2Repo::update_tags_hash(&conn, session_id, &content_hash) {
            log::error!("[ChatV2::pipeline] Failed to update tags_hash: {}", e);
        }
    }

    /// 解析标签提取响应
    fn parse_tags_response(response: &str) -> Option<Vec<String>> {
        let text = response.trim();
        let json_str = if text.starts_with("```") {
            text.trim_start_matches("```json")
                .trim_start_matches("```")
                .trim_end_matches("```")
                .trim()
        } else {
            text
        };

        // 尝试直接解析为数组
        if let Ok(arr) = serde_json::from_str::<Vec<String>>(json_str) {
            let filtered: Vec<String> = arr
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && s.chars().count() <= 24)
                .collect();
            return Some(filtered);
        }

        // 尝试解析为 {"tags": [...]} 对象
        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(json_str) {
            if let Some(arr) = obj.get("tags").and_then(|v| v.as_array()) {
                let filtered: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty() && s.chars().count() <= 24)
                    .collect();
                return Some(filtered);
            }
        }

        None
    }

    /// 取消正在进行的流式生成
    ///
    /// ## 参数
    /// - `session_id`: 会话 ID
    /// - `message_id`: 消息 ID
    ///
    /// ## 说明
    /// 取消操作通过 `CancellationToken` 实现，需要在 handlers 层管理 token。
    pub fn cancel(&self, session_id: &str, message_id: &str) {
        log::info!(
            "[ChatV2::pipeline] Cancel requested for session={}, message={}",
            session_id,
            message_id
        );
        // 实际取消逻辑在 handlers 层通过 CancellationToken 实现
    }
}
