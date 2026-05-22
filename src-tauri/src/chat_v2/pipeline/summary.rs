use super::*;

impl ChatV2Pipeline {
    // ========================================================================
    // 自动会话元数据生成（标题 + 简介 + 标签，单次 LLM 调用）
    //
    // 业界最佳实践对齐：
    // 1. **首轮唯一**：会话仅在首次助手回复后生成一次元数据，后续不再重复生成。
    //    （ChatGPT / Claude 标准行为）
    // 2. **用户改名永久 win**：title_locked = true 后自动摘要永不覆盖。
    // 3. **合并调用**：title + description + tags 通过 1 次 LLM 调用产出，
    //    相比拆分前的 2 次直接砍半成本。
    // 4. **语言自适应**：prompt 不强制语种，跟随对话语言。
    // 5. **失败可重试**：LLM/解析失败不写 summary_hash，下一轮自动重试。
    // ========================================================================

    /// 会话元数据生成 Prompt（同时生成标题和标签）
    ///
    /// 设计决策：不生成 description——侧边栏不展示，
    /// 仅 title + tags 即可满足现有 UI 需求，节省每次约 30-80 字符的输出 token。
    const SESSION_METADATA_PROMPT: &'static str = r#"You generate session metadata for a conversation.

Output a single JSON object with two keys:
- "title": 5-20 chars summarizing the topic. No surrounding quotes or punctuation.
- "tags": array of 3-6 short keywords (each 2-6 chars). Prefer subject names, core concepts, problem types, and methods.

Rules:
- Use the SAME language as the conversation (e.g., Chinese conversation -> Chinese metadata; English conversation -> English).
- Do NOT wrap the JSON in markdown code fences.
- Do NOT add any text before or after the JSON.
- If you cannot determine a value, use a short generic placeholder (do not omit the key).

Conversation user message:
{user_content}

Conversation assistant reply (truncated):
{assistant_content}

Output JSON now:"#;

    /// 自动生成会话元数据（标题 + 标签）
    ///
    /// 在首轮助手回复完成后调用一次。后续轮次不再生成（首轮唯一策略）。
    ///
    /// ## 触发条件
    /// 在调用前应通过 `should_generate_session_metadata` 校验，避免不必要的 LLM 开销。
    ///
    /// ## 失败语义
    /// LLM 调用 / JSON 解析 / DB 写入任一失败都不写 `summary_hash`，
    /// 下一轮调用方再次检测时仍会触发，达成自动重试。
    pub async fn generate_session_metadata(
        &self,
        session_id: &str,
        user_content: &str,
        assistant_content: &str,
        emitter: Arc<ChatV2EventEmitter>,
    ) {
        log::info!(
            "[ChatV2::pipeline] Generating session metadata for session={}",
            session_id
        );

        // 截取助手回复的前 500 个字符作为摘要（安全处理 UTF-8）
        let assistant_summary: String = assistant_content.chars().take(500).collect();

        // 构建 prompt
        let prompt = Self::SESSION_METADATA_PROMPT
            .replace("{user_content}", user_content)
            .replace("{assistant_content}", &assistant_summary);

        // 调用 LLM（一次返回 title + tags）
        let response = match self.call_llm_for_summary(&prompt).await {
            Ok(r) => r,
            Err(e) => {
                log::warn!(
                    "[ChatV2::pipeline] Failed to generate session metadata: {}",
                    e
                );
                return;
            }
        };

        // 解析 JSON 响应
        let metadata = match Self::parse_session_metadata_response(&response) {
            Some(m) => m,
            None => {
                log::warn!(
                    "[ChatV2::pipeline] Failed to parse session metadata JSON: {}",
                    response
                );
                return;
            }
        };

        if metadata.title.is_empty() {
            log::warn!("[ChatV2::pipeline] Generated title is empty, skipping persist");
            return;
        }

        log::info!(
            "[ChatV2::pipeline] Generated metadata for session={}: title={}, tags={:?}",
            session_id,
            metadata.title,
            metadata.tags
        );

        // 计算内容哈希
        let content_hash = Self::compute_content_hash(user_content, &assistant_summary);

        // 写入 title + summary_hash + tags（事务）
        if let Err(e) = self
            .persist_session_metadata(session_id, &metadata, &content_hash)
            .await
        {
            log::error!(
                "[ChatV2::pipeline] Failed to persist session metadata: {}",
                e
            );
            return;
        }

        // 通知前端：summary_updated 事件保留 description 字段（前端 setSummary 已兼容空值）
        emitter.emit_summary_updated(&metadata.title, "");
    }

    /// 解析会话元数据 JSON 响应
    ///
    /// 容错处理：
    /// - 剥离可能的 markdown 代码块包裹
    /// - title 缺失或为空 → 返回 None（视为失败，触发重试）
    /// - tags 缺失 → 视为空数组
    /// - 长度超限 → 安全截断
    fn parse_session_metadata_response(response: &str) -> Option<SessionMetadata> {
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
        let v = serde_json::from_str::<serde_json::Value>(json_str).ok()?;

        let title_raw = v.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let title = title_raw
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim_matches('「')
            .trim_matches('」');

        let title = if title.chars().count() > 50 {
            title.chars().take(50).collect::<String>()
        } else {
            title.to_string()
        };

        if title.is_empty() {
            return None;
        }

        // tags：支持数组 / 字符串数组 / 缺失
        let tags: Vec<String> = v
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty() && s.chars().count() <= 24)
                    .take(8) // 上限保护
                    .collect()
            })
            .unwrap_or_default();

        Some(SessionMetadata { title, tags })
    }

    /// 计算内容哈希（用于持久化记录"已生成过"的指纹）
    fn compute_content_hash(user_content: &str, assistant_content: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(user_content.as_bytes());
        hasher.update(b"|");
        hasher.update(assistant_content.as_bytes());
        let result = hasher.finalize();
        // 取前 16 字节作为哈希
        hex::encode(&result[..16])
    }

    /// 调用 LLM 生成元数据（非流式 + 超时保护）
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

    /// 持久化会话元数据：title + summary_hash + tags + tags_hash 一次写入
    ///
    /// 使用事务确保原子性，避免出现「title 写了但 tags 没写」等部分成功状态。
    async fn persist_session_metadata(
        &self,
        session_id: &str,
        metadata: &SessionMetadata,
        content_hash: &str,
    ) -> ChatV2Result<()> {
        let mut conn = self.db.get_conn_safe()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

        let now = chrono::Utc::now().to_rfc3339();

        // 注意：写入时再次校验 title_locked = 0，避免与并发的「用户改名」竞态
        let rows = tx.execute(
            "UPDATE chat_v2_sessions
             SET title = ?2, summary_hash = ?3, tags_hash = ?4, updated_at = ?5
             WHERE id = ?1 AND title_locked = 0",
            rusqlite::params![session_id, metadata.title, content_hash, content_hash, now,],
        )?;

        if rows == 0 {
            // 会话不存在或刚刚被用户锁定 → 不视为错误，仅记录
            log::debug!(
                "[ChatV2::pipeline] Skip persist metadata: session={} not found or just locked",
                session_id
            );
            tx.rollback()?;
            return Ok(());
        }

        // 标签也只在未锁定路径成功时写入
        if !metadata.tags.is_empty() {
            ChatV2Repo::upsert_auto_tags(&tx, session_id, &metadata.tags)?;
        }

        tx.commit()?;

        log::debug!(
            "[ChatV2::pipeline] Session metadata persisted: session={}, title={}, tags={}",
            session_id,
            metadata.title,
            metadata.tags.len()
        );

        Ok(())
    }

    /// 检查会话是否需要生成元数据
    ///
    /// 业界最佳实践（ChatGPT / Claude）：
    /// - `title_locked = true`：用户已显式锁定 → 永不再生成
    /// - `summary_hash IS NOT NULL`：已生成过 → 默认不再重生成
    /// - 内容长度过短 → 跳过（避免无效调用）
    pub(crate) async fn should_generate_session_metadata(
        &self,
        session_id: &str,
        user_content: &str,
        assistant_content: &str,
    ) -> bool {
        // 内容长度门槛：与原 trigger_auto_tag_extraction 保持一致
        let user_chars = user_content.chars().count();
        let assistant_chars = assistant_content.chars().count();
        if user_chars < 10 && assistant_chars < 20 {
            log::debug!(
                "[ChatV2::pipeline] Skip metadata generation, content too short: session={}",
                session_id
            );
            return false;
        }

        // 读取会话状态
        let conn = match self.db.get_conn_safe() {
            Ok(c) => c,
            Err(_) => return false, // DB 不可用时不强行触发，避免雪崩
        };

        let session = match ChatV2Repo::get_session_with_conn(&conn, session_id) {
            Ok(Some(s)) => s,
            Ok(None) => return false,
            Err(_) => return false,
        };

        // 用户已锁定 → 永不覆盖
        if session.title_locked {
            log::debug!(
                "[ChatV2::pipeline] Skip metadata generation, title locked: session={}",
                session_id
            );
            return false;
        }

        // 已生成过 → 默认首轮唯一，不重生成
        if session.summary_hash.is_some() {
            log::debug!(
                "[ChatV2::pipeline] Skip metadata generation, already generated: session={}",
                session_id
            );
            return false;
        }

        true
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

/// 解析后的会话元数据
#[derive(Debug, Clone)]
pub(crate) struct SessionMetadata {
    pub title: String,
    pub tags: Vec<String>,
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_well_formed_json() {
        let resp = r#"{"title": "微积分入门", "tags": ["微积分", "极限", "导数"]}"#;
        let m = ChatV2Pipeline::parse_session_metadata_response(resp).unwrap();
        assert_eq!(m.title, "微积分入门");
        assert_eq!(m.tags, vec!["微积分", "极限", "导数"]);
    }

    #[test]
    fn strips_markdown_code_fences() {
        let resp = "```json\n{\"title\":\"Calculus\",\"tags\":[\"math\"]}\n```";
        let m = ChatV2Pipeline::parse_session_metadata_response(resp).unwrap();
        assert_eq!(m.title, "Calculus");
        assert_eq!(m.tags, vec!["math"]);
    }

    #[test]
    fn handles_missing_tags() {
        let resp = r#"{"title": "Hello"}"#;
        let m = ChatV2Pipeline::parse_session_metadata_response(resp).unwrap();
        assert_eq!(m.title, "Hello");
        assert!(m.tags.is_empty());
    }

    #[test]
    fn ignores_legacy_description_field() {
        // 兼容性：旧 prompt / 旧模型可能仍返回 description，应被静默忽略
        let resp = r#"{"title":"x","description":"legacy field","tags":["t"]}"#;
        let m = ChatV2Pipeline::parse_session_metadata_response(resp).unwrap();
        assert_eq!(m.title, "x");
        assert_eq!(m.tags, vec!["t"]);
    }

    #[test]
    fn rejects_empty_or_missing_title() {
        assert!(ChatV2Pipeline::parse_session_metadata_response(r#"{"title":""}"#).is_none());
        assert!(ChatV2Pipeline::parse_session_metadata_response(r#"{"tags":[]}"#).is_none());
    }

    #[test]
    fn rejects_invalid_json() {
        assert!(ChatV2Pipeline::parse_session_metadata_response("not json").is_none());
        assert!(ChatV2Pipeline::parse_session_metadata_response("").is_none());
    }

    #[test]
    fn truncates_overlong_title() {
        let long_title: String = "标".repeat(80);
        let resp = format!(r#"{{"title":"{}","tags":[]}}"#, long_title);
        let m = ChatV2Pipeline::parse_session_metadata_response(&resp).unwrap();
        assert_eq!(m.title.chars().count(), 50);
    }

    #[test]
    fn strips_quote_wrappers() {
        let resp = r#"{"title":"「会话主题」","tags":[]}"#;
        let m = ChatV2Pipeline::parse_session_metadata_response(resp).unwrap();
        assert_eq!(m.title, "会话主题");
    }

    #[test]
    fn filters_invalid_tags() {
        let resp = r#"{"title":"x","tags":["", "normal", "this_tag_is_way_too_long_for_filter"]}"#;
        let m = ChatV2Pipeline::parse_session_metadata_response(resp).unwrap();
        assert_eq!(m.tags, vec!["normal"]);
    }

    #[test]
    fn content_hash_is_deterministic() {
        let h1 = ChatV2Pipeline::compute_content_hash("hello", "world");
        let h2 = ChatV2Pipeline::compute_content_hash("hello", "world");
        let h3 = ChatV2Pipeline::compute_content_hash("hello", "different");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
        assert_eq!(h1.len(), 32); // 16 bytes -> 32 hex chars
    }
}
