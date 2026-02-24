use super::*;

impl ChatV2Pipeline {
    // ========================================================================
    // Token 估算逻辑（Prompt 4）
    // ========================================================================

    /// 获取或估算本轮 LLM 调用的 Token 使用量
    ///
    /// 优先使用 API 返回的 usage，如果不可用则估算。
    ///
    /// ## 参数
    /// - `adapter`: LLM 适配器，包含 API 返回的 usage
    /// - `messages`: 输入消息列表
    /// - `completion_text`: 输出文本
    /// - `system_prompt`: 系统提示
    /// - `model_id`: 模型 ID（用于选择 tiktoken 编码器）
    ///
    /// ## 返回
    /// TokenUsage 结构体
    pub(crate) fn get_or_estimate_usage(
        &self,
        adapter: &ChatV2LLMAdapter,
        messages: &[LegacyChatMessage],
        completion_text: &str,
        system_prompt: &str,
        model_id: Option<&str>,
    ) -> TokenUsage {
        // 1. 优先使用 API 返回的 usage
        if let Some(api_usage) = adapter.get_api_usage() {
            log::debug!(
                "[ChatV2::pipeline] Using API usage: prompt={}, completion={}",
                api_usage.prompt_tokens,
                api_usage.completion_tokens
            );
            return api_usage;
        }

        // 2. API 不可用时，使用估算
        log::debug!("[ChatV2::pipeline] API usage not available, using estimation");

        let prompt_tokens = self.estimate_prompt_tokens(messages, system_prompt, model_id);
        let completion_tokens = self.estimate_completion_tokens(completion_text, model_id);

        // 判断是否使用了精确估算（tiktoken）
        #[cfg(feature = "tokenizer_tiktoken")]
        let precise = true;
        #[cfg(not(feature = "tokenizer_tiktoken"))]
        let precise = false;

        TokenUsage::from_estimate(prompt_tokens, completion_tokens, precise)
    }

    /// 估算输入 Token 数量
    ///
    /// 将 system_prompt + 所有消息的内容拼接后估算 token 数量。
    ///
    /// ## 参数
    /// - `messages`: 消息列表
    /// - `system_prompt`: 系统提示
    /// - `model_id`: 模型 ID（用于选择 tiktoken 编码器）
    ///
    /// ## 返回
    /// 估算的 prompt token 数量
    fn estimate_prompt_tokens(
        &self,
        messages: &[LegacyChatMessage],
        system_prompt: &str,
        model_id: Option<&str>,
    ) -> u32 {
        use crate::utils::token_budget::estimate_tokens_with_model;

        // 构建完整的 prompt 文本
        let mut full_prompt = String::new();

        // 添加系统提示
        if !system_prompt.is_empty() {
            full_prompt.push_str(system_prompt);
            full_prompt.push('\n');
        }

        // 添加所有消息内容
        for msg in messages {
            // 消息角色标记（粗略估计 4 tokens）
            full_prompt.push_str(&msg.role);
            full_prompt.push_str(": ");
            full_prompt.push_str(&msg.content);
            full_prompt.push('\n');

            // 如果有 thinking 内容也计入
            if let Some(ref thinking) = msg.thinking_content {
                full_prompt.push_str(thinking);
                full_prompt.push('\n');
            }

            // 如果有工具调用，计入参数
            if let Some(ref tool_call) = msg.tool_call {
                full_prompt.push_str(&tool_call.args_json.to_string());
                full_prompt.push('\n');
            }

            // 如果有工具结果，计入输出
            if let Some(ref tool_result) = msg.tool_result {
                if let Some(ref data) = tool_result.data_json {
                    full_prompt.push_str(&data.to_string());
                    full_prompt.push('\n');
                }
            }
        }

        // 使用 token_budget 模块的估算函数
        let tokens = estimate_tokens_with_model(&full_prompt, model_id) as u32;

        // 添加消息格式开销（每条消息约 4 tokens）
        let message_overhead = (messages.len() as u32) * 4;

        tokens + message_overhead
    }

    /// 估算输出 Token 数量
    ///
    /// ## 参数
    /// - `completion_text`: 输出文本
    /// - `model_id`: 模型 ID（用于选择 tiktoken 编码器）
    ///
    /// ## 返回
    /// 估算的 completion token 数量
    fn estimate_completion_tokens(&self, completion_text: &str, model_id: Option<&str>) -> u32 {
        use crate::utils::token_budget::estimate_tokens_with_model;

        if completion_text.is_empty() {
            return 0;
        }

        estimate_tokens_with_model(completion_text, model_id) as u32
    }

    // ========================================================================
    // 统一上下文注入系统方法
    // ========================================================================

    /// 创建检索资源
    ///
    /// 将检索结果转换为资源引用，调用 ResourceRepo 创建实际资源。
    /// 统一架构修复（2025-12-06）：使用 resources.db 而非 chat_v2.db
    ///
    /// ## 约束（来自文档 17）
    /// - 检索结果创建资源并填充 retrievalRefs
    /// - 使用内容哈希去重
    ///
    /// ## 参数
    /// - `sources`: 检索到的消息来源
    ///
    /// ## 返回
    /// 检索资源的 ContextRef 列表
    pub(crate) async fn create_retrieval_resources(&self, sources: &MessageSources) -> Vec<ContextRef> {
        use crate::vfs::types::{VfsResourceMetadata, VfsResourceType};

        let mut refs = Vec::new();

        // 🆕 获取 VFS 数据库连接
        let vfs_db = match &self.vfs_db {
            Some(db) => db,
            None => {
                log::warn!(
                    "[ChatV2::pipeline] vfs_db not available, skipping retrieval resource creation"
                );
                return refs;
            }
        };

        let conn = match vfs_db.get_conn_safe() {
            Ok(conn) => conn,
            Err(e) => {
                log::error!("[ChatV2::pipeline] Failed to get vfs.db connection: {}", e);
                return refs;
            }
        };

        // 辅助宏：处理单个来源列表
        macro_rules! process_sources {
            ($source_list:expr, $source_type:expr) => {
                if let Some(ref source_list) = $source_list {
                    for (idx, source) in source_list.iter().enumerate() {
                        // 构建内容用于存储（JSON 格式）
                        let content = serde_json::json!({
                            "source_type": $source_type,
                            "title": source.title,
                            "snippet": source.snippet,
                            "url": source.url,
                        }).to_string();

                        // 构建元数据（使用 VFS 的类型）
                        let metadata = VfsResourceMetadata {
                            title: source.title.clone(),
                            source: Some($source_type.to_string()),
                            ..Default::default()
                        };

                        // 🆕 调用 VfsResourceRepo 创建或复用资源（写入 vfs.db）
                        match VfsResourceRepo::create_or_reuse_with_conn(
                            &conn,
                            VfsResourceType::Retrieval,
                            &content,
                            source.url.as_deref(), // source_id: 使用 URL
                            None, // source_table
                            Some(&metadata),
                        ) {
                            Ok(result) => {
                                refs.push(ContextRef::new(
                                    result.resource_id.clone(),
                                    result.hash.clone(),
                                    format!("retrieval_{}", $source_type),
                                ));

                                log::trace!(
                                    "[ChatV2::pipeline] Created retrieval resource in vfs.db: type={}, idx={}, id={}, is_new={}",
                                    $source_type,
                                    idx,
                                    result.resource_id,
                                    result.is_new
                                );
                            }
                            Err(e) => {
                                log::warn!(
                                    "[ChatV2::pipeline] Failed to create retrieval resource: type={}, idx={}, error={}",
                                    $source_type,
                                    idx,
                                    e
                                );
                            }
                        }
                    }
                }
            };
        }

        // 处理各类检索来源
        process_sources!(sources.rag, "rag");
        process_sources!(sources.memory, "memory");
        process_sources!(sources.graph, "graph");
        process_sources!(sources.web_search, "web");

        log::debug!(
            "[ChatV2::pipeline] Created {} retrieval resources in vfs.db",
            refs.len()
        );

        refs
    }

    /// 增加资源引用计数
    ///
    /// 消息保存后调用，增加所有关联资源的引用计数。
    /// 🆕 VFS 统一存储（2025-12-07）：使用 vfs.db
    ///
    /// ## 约束（来自文档 17）
    /// - 消息保存后调用 incrementRef
    pub(crate) async fn increment_resource_refs(&self, resource_ids: &[&str]) {
        if resource_ids.is_empty() {
            return;
        }

        // 🆕 获取 VFS 数据库连接
        let vfs_db = match &self.vfs_db {
            Some(db) => db,
            None => {
                log::warn!(
                    "[ChatV2::pipeline] vfs_db not available, skipping increment_resource_refs"
                );
                return;
            }
        };

        let conn = match vfs_db.get_conn_safe() {
            Ok(conn) => conn,
            Err(e) => {
                log::error!("[ChatV2::pipeline] Failed to get vfs.db connection for increment_resource_refs: {}", e);
                return;
            }
        };

        // 遍历所有资源 ID，调用 VfsResourceRepo 增加引用计数
        for id in resource_ids {
            if let Err(e) = VfsResourceRepo::increment_ref_with_conn(&conn, id) {
                // 引用计数失败不阻塞流程，仅记录警告
                log::warn!(
                    "[ChatV2::pipeline] Failed to increment ref for resource {}: {}",
                    id,
                    e
                );
            }
        }

        log::debug!(
            "[ChatV2::pipeline] Incremented refs for {} resources in vfs.db: {:?}",
            resource_ids.len(),
            resource_ids.iter().take(3).collect::<Vec<_>>()
        );
    }

    /// 减少资源引用计数
    ///
    /// 消息删除时调用，减少所有关联资源的引用计数。
    /// 🆕 VFS 统一存储（2025-12-07）：使用 vfs.db
    ///
    /// ## 约束（来自文档 17）
    /// - 消息删除时调用 decrementRef
    #[allow(dead_code)]
    async fn decrement_resource_refs(&self, resource_ids: &[&str]) {
        if resource_ids.is_empty() {
            return;
        }

        // 🆕 获取 VFS 数据库连接
        let vfs_db = match &self.vfs_db {
            Some(db) => db,
            None => {
                log::warn!(
                    "[ChatV2::pipeline] vfs_db not available, skipping decrement_resource_refs"
                );
                return;
            }
        };

        let conn = match vfs_db.get_conn_safe() {
            Ok(conn) => conn,
            Err(e) => {
                log::error!("[ChatV2::pipeline] Failed to get vfs.db connection for decrement_resource_refs: {}", e);
                return;
            }
        };

        // 遍历所有资源 ID，调用 VfsResourceRepo 减少引用计数
        for id in resource_ids {
            if let Err(e) = VfsResourceRepo::decrement_ref_with_conn(&conn, id) {
                // 引用计数失败不阻塞流程，仅记录警告
                log::warn!(
                    "[ChatV2::pipeline] Failed to decrement ref for resource {}: {}",
                    id,
                    e
                );
            }
        }

        log::debug!(
            "[ChatV2::pipeline] Decremented refs for {} resources in vfs.db: {:?}",
            resource_ids.len(),
            resource_ids.iter().take(3).collect::<Vec<_>>()
        );
    }
}
