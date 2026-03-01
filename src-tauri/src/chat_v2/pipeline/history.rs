use super::*;

impl ChatV2Pipeline {
    /// 加载聊天历史
    ///
    /// 从数据库加载会话的历史消息，应用 context_limit 限制，
    /// 并提取 content 类型块的内容构建 LLM 对话历史。
    pub(crate) async fn load_chat_history(&self, ctx: &mut PipelineContext) -> ChatV2Result<()> {
        log::debug!(
            "[ChatV2::pipeline] Loading chat history for session={}",
            ctx.session_id
        );

        // 获取数据库连接
        let conn = self.db.get_conn_safe()?;

        // 🆕 获取 VFS 数据库连接（用于解析历史消息中的 context_snapshot）
        let vfs_conn_opt = self.vfs_db.as_ref().and_then(|vfs_db| {
            match vfs_db.get_conn_safe() {
                Ok(vfs_conn) => Some(vfs_conn),
                Err(e) => {
                    log::warn!("[ChatV2::pipeline] Failed to get vfs.db connection for history context_snapshot: {}", e);
                    None
                }
            }
        });
        let vfs_blobs_dir = self
            .vfs_db
            .as_ref()
            .map(|vfs_db| vfs_db.blobs_dir().to_path_buf());

        // 从数据库加载消息
        let messages = ChatV2Repo::get_session_messages_with_conn(&conn, &ctx.session_id)?;

        if messages.is_empty() {
            log::debug!(
                "[ChatV2::pipeline] No chat history found for session={}",
                ctx.session_id
            );
            ctx.chat_history = Vec::new();
            return Ok(());
        }

        // 🔧 排除当前用户消息和助手消息：save_user_message_immediately 会在
        // load_chat_history 之前将当前用户消息写入 DB，而 build_current_user_message
        // 会重新构建当前用户消息（带 <user_query> 标签包裹），如果不排除，
        // merge_consecutive_user_messages 会将两条连续 user 消息合并，导致内容重复。
        let exclude_ids: std::collections::HashSet<&str> = [
            ctx.user_message_id.as_str(),
            ctx.assistant_message_id.as_str(),
        ]
        .into_iter()
        .collect();
        let messages: Vec<_> = messages
            .into_iter()
            .filter(|m| !exclude_ids.contains(m.id.as_str()))
            .collect();

        if messages.is_empty() {
            log::debug!(
                "[ChatV2::pipeline] No chat history after excluding current messages for session={}",
                ctx.session_id
            );
            ctx.chat_history = Vec::new();
            return Ok(());
        }

        // 🔧 P1修复：使用固定的消息条数限制，而非 context_limit
        // context_limit 应该用于 LLM 的 max_input_tokens_override
        let max_messages = DEFAULT_MAX_HISTORY_MESSAGES;
        let messages_to_load: Vec<_> = if messages.len() > max_messages {
            // 取最新的 max_messages 条消息
            messages
                .into_iter()
                .rev()
                .take(max_messages)
                .rev()
                .collect()
        } else {
            messages
        };

        log::debug!(
            "[ChatV2::pipeline] Loading {} messages (max_messages={})",
            messages_to_load.len(),
            max_messages
        );

        // 转换为 LegacyChatMessage 格式
        let mut chat_history = Vec::new();
        for message in messages_to_load {
            // 加载该消息的所有块
            let blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &message.id)?;

            // 只提取 content 类型块的内容
            let content: String = blocks
                .iter()
                .filter(|b| b.block_type == block_types::CONTENT)
                .filter_map(|b| b.content.as_ref())
                .cloned()
                .collect::<Vec<_>>()
                .join("");

            // 🔧 B1+B2+C1 修复：重写工具块和 thinking 关联逻辑
            //
            // B1+B2：纳入所有专用工具类型（不只是 MCP_TOOL）
            // 判断依据：block_type 是工具类型 且 tool_name 已设置（排除预检索块）
            //
            // C1：按 block_index 顺序遍历，将 thinking 关联到紧随其后的 tool block
            // 这样 merge_consecutive_tool_calls 可以通过 thinking_content 检测轮次边界

            // 收集工具块及其关联的 thinking（按 block_index 有序遍历）
            let mut pending_thinking: Option<String> = None;
            let mut tool_entries: Vec<(Option<String>, &MessageBlock)> = Vec::new();

            for block in blocks.iter() {
                if block.block_type == block_types::THINKING {
                    let text = block.content.as_ref().cloned().unwrap_or_default();
                    if !text.is_empty() {
                        pending_thinking = Some(match pending_thinking {
                            Some(existing) => format!("{}\n{}", existing, text),
                            None => text,
                        });
                    }
                } else if is_tool_call_block(block) {
                    tool_entries.push((pending_thinking.take(), block));
                }
            }

            // 如果没有工具块，所有 thinking 都归属于 legacy_message
            // 如果有工具块，未被工具消费的 pending_thinking 留给最终的 legacy_message
            let thinking_content = if tool_entries.is_empty() {
                // 无工具调用：回退到原始逻辑，拼接所有 thinking
                let thinking: String = blocks
                    .iter()
                    .filter(|b| b.block_type == block_types::THINKING)
                    .filter_map(|b| b.content.as_ref())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("");
                if thinking.is_empty() { None } else { Some(thinking) }
            } else {
                // 未被工具消费的 thinking 留给 legacy_message
                pending_thinking
            };

            // 🆕 对于用户消息，解析 context_snapshot.user_refs 并将内容追加到 content
            // ★ 2025-12-10 修复：同时提取图片 base64，注入到 image_base64 字段
            let (content, vfs_image_base64) = if message.role == MessageRole::User {
                if let (Some(ref vfs_conn), Some(ref blobs_dir)) = (&vfs_conn_opt, &vfs_blobs_dir) {
                    self.resolve_history_context_snapshot_v2(
                        &content,
                        &message,
                        &**vfs_conn, // 解引用 PooledConnection 获取 &Connection
                        blobs_dir,
                    )
                } else {
                    (content, Vec::new())
                }
            } else {
                (content, Vec::new())
            };

            // 构建 LegacyChatMessage
            let role = match message.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
            };

            // 如果是 assistant 消息且有工具调用，先添加工具调用消息
            // 🔧 B1+B2+C1 修复：使用 tool_entries（含关联 thinking）替代 tool_blocks
            if role == "assistant" && !tool_entries.is_empty() {
                for (idx, (entry_thinking, tool_block)) in tool_entries.iter().enumerate() {
                    // 生成 tool_call_id（使用块 ID 或生成新的）
                    let tool_call_id = format!("tc_{}", tool_block.id.replace("blk_", ""));

                    // 提取工具名称和输入
                    let tool_name = tool_block.tool_name.clone().unwrap_or_default();
                    let tool_input = tool_block
                        .tool_input
                        .clone()
                        .unwrap_or(serde_json::Value::Null);
                    let tool_output = tool_block
                        .tool_output
                        .clone()
                        .unwrap_or(serde_json::Value::Null);
                    let tool_success = tool_block.status == block_status::SUCCESS;
                    let tool_error = tool_block.error.clone();

                    // 1. 添加 assistant 消息（包含 tool_call）
                    // 🔧 C1修复：携带关联的 thinking_content，用于 merge 边界检测
                    let tool_call = crate::models::ToolCall {
                        id: tool_call_id.clone(),
                        tool_name: tool_name.clone(),
                        args_json: tool_input,
                    };
                    let assistant_tool_msg = LegacyChatMessage {
                        role: "assistant".to_string(),
                        content: String::new(),
                        timestamp: chrono::Utc::now(),
                        thinking_content: entry_thinking.clone(),
                        thought_signature: None,
                        rag_sources: None,
                        memory_sources: None,
                        graph_sources: None,
                        web_search_sources: None,
                        image_paths: None,
                        image_base64: None,
                        doc_attachments: None,
                        multimodal_content: None,
                        tool_call: Some(tool_call),
                        tool_result: None,
                        overrides: None,
                        relations: None,
                        persistent_stable_id: None,
                        metadata: None,
                    };
                    chat_history.push(assistant_tool_msg);

                    // 2. 添加 tool 消息（包含 tool_result）
                    // 🔧 与 context.rs tool_results_to_messages_impl 保持一致：
                    // 失败时优先使用 error 信息，让 LLM 知道失败原因
                    let tool_content = if tool_success {
                        serde_json::to_string(&tool_output).unwrap_or_default()
                    } else if let Some(ref err) = tool_error {
                        if !err.is_empty() {
                            format!("Error: {}", err)
                        } else {
                            serde_json::to_string(&tool_output).unwrap_or_default()
                        }
                    } else {
                        serde_json::to_string(&tool_output).unwrap_or_default()
                    };
                    let tool_result = crate::models::ToolResult {
                        call_id: tool_call_id,
                        ok: tool_success,
                        error: tool_error,
                        error_details: None,
                        data_json: Some(tool_output.clone()),
                        usage: None,
                        citations: None,
                    };
                    let tool_msg = LegacyChatMessage {
                        role: "tool".to_string(),
                        content: tool_content,
                        timestamp: chrono::Utc::now(),
                        thinking_content: None,
                        thought_signature: None,
                        rag_sources: None,
                        memory_sources: None,
                        graph_sources: None,
                        web_search_sources: None,
                        image_paths: None,
                        image_base64: None,
                        doc_attachments: None,
                        multimodal_content: None,
                        tool_call: None,
                        tool_result: Some(tool_result),
                        overrides: None,
                        relations: None,
                        persistent_stable_id: None,
                        metadata: None,
                    };
                    chat_history.push(tool_msg);

                    log::debug!(
                        "[ChatV2::pipeline] Loaded tool call from history: tool={}, block_type={}, block_id={}, index={}, has_thinking={}",
                        tool_name,
                        tool_block.block_type,
                        tool_block.id,
                        idx,
                        entry_thinking.is_some()
                    );
                }
            }

            // 跳过空内容消息（但工具调用消息已经添加）
            if content.is_empty() {
                continue;
            }

            // 从附件中提取图片 base64（仅用户消息有附件）
            // ★ 2025-12-10 修复：合并旧附件图片和 VFS 图片
            let mut all_images: Vec<String> = message
                .attachments
                .as_ref()
                .map(|attachments| {
                    attachments
                        .iter()
                        .filter(|a| a.r#type == "image")
                        .filter_map(|a| {
                            // preview_url 格式为 "data:image/xxx;base64,{base64_content}"
                            a.preview_url
                                .as_ref()
                                .and_then(|url| url.split(',').nth(1).map(|s| s.to_string()))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            // ★ 2025-12-10 修复：追加从 VFS context_snapshot 解析的图片
            all_images.extend(vfs_image_base64);

            let image_base64: Option<Vec<String>> = if all_images.is_empty() {
                None
            } else {
                Some(all_images)
            };

            // 🔧 P2修复：从附件中提取文档附件（同时支持文本和二进制文档）
            // 🔧 P0修复：使用 DocumentParser 解析 docx/pdf 等二进制文档
            let doc_attachments: Option<Vec<crate::models::DocumentAttachment>> = message.attachments
                .as_ref()
                .map(|attachments| {
                    attachments.iter()
                        .filter(|a| a.r#type == "document")
                        .map(|a| {
                            // 判断是否为文本类型
                            let is_text_type = a.mime_type.starts_with("text/") ||
                                               a.mime_type == "application/json" ||
                                               a.mime_type == "application/xml" ||
                                               a.mime_type == "application/javascript";

                            let mut text_content: Option<String> = None;
                            let mut base64_content: Option<String> = None;

                            // 从 preview_url 提取内容
                            if let Some(ref url) = a.preview_url {
                                if url.starts_with("data:") {
                                    if let Some(data_part) = url.split(',').nth(1) {
                                        if is_text_type {
                                            // 文本类型：解码 base64 为文本
                                            use base64::Engine;
                                            text_content = base64::engine::general_purpose::STANDARD
                                                .decode(data_part)
                                                .ok()
                                                .and_then(|bytes| String::from_utf8(bytes).ok());
                                        } else {
                                            // 二进制类型（如 docx/PDF）：先保存 base64
                                            base64_content = Some(data_part.to_string());

                                            // 🔧 P0修复：尝试使用 DocumentParser 解析二进制文档
                                            let parser = crate::document_parser::DocumentParser::new();
                                            match parser.extract_text_from_base64(&a.name, data_part) {
                                                Ok(text) => {
                                                    log::debug!("[ChatV2::pipeline] Extracted {} chars from history document: {}", text.len(), a.name);
                                                    text_content = Some(text);
                                                }
                                                Err(e) => {
                                                    log::debug!("[ChatV2::pipeline] Could not parse history document {}: {}", a.name, e);
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            crate::models::DocumentAttachment {
                                name: a.name.clone(),
                                mime_type: a.mime_type.clone(),
                                size_bytes: a.size as usize,
                                text_content,
                                base64_content,
                            }
                        })
                        .collect::<Vec<_>>()
                })
                .filter(|v| !v.is_empty());

            let legacy_message = LegacyChatMessage {
                role: role.to_string(),
                content: content.clone(),
                timestamp: chrono::Utc::now(), // 历史消息的时间戳（用于格式兼容）
                thinking_content,
                thought_signature: None,
                rag_sources: None,
                memory_sources: None,
                graph_sources: None,
                web_search_sources: None,
                image_paths: None,
                image_base64,
                doc_attachments,
                multimodal_content: None,
                tool_call: None,
                tool_result: None,
                overrides: None,
                relations: None,
                persistent_stable_id: message.persistent_stable_id.clone(),
                metadata: None,
            };

            chat_history.push(legacy_message);
        }

        log::info!(
            "[ChatV2::pipeline] Loaded {} messages from history for session={}",
            chat_history.len(),
            ctx.session_id
        );

        // 🔧 改进 5：验证工具调用链完整性
        validate_tool_chain(&chat_history);

        // 🆕 2026-02-22: 为已激活的默认技能自动注入合成 load_skills 工具交互
        // 技能内容通过 role: tool 投递，模型遵循度远高于 user message 中的 XML 块
        inject_synthetic_load_skills(&mut chat_history, &ctx.options);

        // 🔧 Token 预算裁剪：在条数限制基础上，按 token 预算从最旧消息开始移除
        let max_tokens = ctx
            .options
            .context_limit
            .map(|v| (v as usize).min(DEFAULT_MAX_HISTORY_TOKENS))
            .unwrap_or(DEFAULT_MAX_HISTORY_TOKENS);
        trim_history_by_token_budget(&mut chat_history, max_tokens);

        ctx.chat_history = chat_history;
        Ok(())
    }

    /// 解析历史消息中的 context_snapshot（V2 版本）
    ///
    /// 使用统一的 `vfs_resolver` 模块处理所有资源类型的解引用。
    /// 返回 `(String, Vec<String>)`：
    /// - 第一个值是合并后的文本内容
    /// - 第二个值是图片 base64 列表，用于注入到 `image_base64` 字段
    ///
    /// 这确保历史消息中的 VFS 图片附件能正确注入到多模态请求中。
    pub(crate) fn resolve_history_context_snapshot_v2(
        &self,
        original_content: &str,
        message: &ChatMessage,
        vfs_conn: &rusqlite::Connection,
        blobs_dir: &std::path::Path,
    ) -> (String, Vec<String>) {
        use super::super::vfs_resolver::{resolve_context_ref_data_to_content, ResolvedContent};
        use crate::vfs::repos::VfsResourceRepo;
        use crate::vfs::types::VfsContextRefData;

        // 检查是否有 context_snapshot
        let context_snapshot = match &message.meta {
            Some(meta) => match &meta.context_snapshot {
                Some(snapshot) if !snapshot.user_refs.is_empty() => snapshot,
                _ => return (original_content.to_string(), Vec::new()),
            },
            None => return (original_content.to_string(), Vec::new()),
        };

        log::debug!(
            "[ChatV2::pipeline] resolve_history_context_snapshot_v2 for message {}: {} user_refs",
            message.id,
            context_snapshot.user_refs.len()
        );

        let mut total_result = ResolvedContent::new();

        // 遍历 user_refs
        for context_ref in &context_snapshot.user_refs {
            // 1. 从 VFS resources 表获取资源
            let resource =
                match VfsResourceRepo::get_resource_with_conn(vfs_conn, &context_ref.resource_id) {
                    Ok(Some(r)) => r,
                    Ok(None) => {
                        log::warn!(
                            "[ChatV2::pipeline] Resource not found: {}",
                            context_ref.resource_id
                        );
                        continue;
                    }
                    Err(e) => {
                        log::warn!(
                            "[ChatV2::pipeline] Failed to get resource {}: {}",
                            context_ref.resource_id,
                            e
                        );
                        continue;
                    }
                };

            // 2. 解析资源的 data 字段获取 VFS 引用
            let data_str = match &resource.data {
                Some(d) => d,
                None => {
                    log::debug!(
                        "[ChatV2::pipeline] Resource {} has no data",
                        context_ref.resource_id
                    );
                    continue;
                }
            };

            // 尝试解析为 VfsContextRefData（附件等引用模式资源）
            if let Ok(mut ref_data) = serde_json::from_str::<VfsContextRefData>(data_str) {
                // ★ 2026-02 修复：历史消息解引用时也要恢复 inject_modes
                // 否则编辑重发/重试时会错误注入文本
                if let Some(ref saved_inject_modes) = context_ref.inject_modes {
                    for vfs_ref in &mut ref_data.refs {
                        vfs_ref.inject_modes = Some(saved_inject_modes.clone());
                    }
                }
                // ★ 使用统一的 vfs_resolver 模块解析
                // ★ 2026-01-17 修复：历史加载时使用 is_multimodal=false，同时收集图片和 OCR 文本
                // 实际发送给 LLM 时，由 model2_pipeline 根据 config.is_multimodal 决定：
                // - 多模态模型：使用 image_base64 发送图片
                // - 非多模态模型：使用 content 中的 OCR 文本
                let content =
                    resolve_context_ref_data_to_content(vfs_conn, blobs_dir, &ref_data, false);
                total_result.merge(content);
            } else {
                // 非引用模式资源（如笔记内容直接存储），直接使用 data
                match context_ref.type_id.as_str() {
                    "note" | "translation" | "essay" => {
                        if !data_str.is_empty() {
                            let title = resource
                                .metadata
                                .as_ref()
                                .and_then(|m| m.title.clone())
                                .unwrap_or_else(|| context_ref.type_id.clone());
                            total_result.add_text(format!(
                                "<injected_context>\n[{}]\n{}\n</injected_context>",
                                title, data_str
                            ));
                        }
                    }
                    _ => {
                        log::debug!(
                            "[ChatV2::pipeline] Unknown type_id for resource {}: {}",
                            context_ref.resource_id,
                            context_ref.type_id
                        );
                    }
                }
            }
        }

        // 记录日志
        if !total_result.is_empty() {
            log::info!(
                "[ChatV2::pipeline] Resolved {} context items and {} images for message {}",
                total_result.text_contents.len(),
                total_result.image_base64_list.len(),
                message.id
            );
        }

        // 返回合并后的内容和图片列表
        let final_content = total_result.to_formatted_text(original_content);
        (final_content, total_result.image_base64_list)
    }
}

/// 🔧 B1+B2 修复：判断一个 block 是否是 LLM 发起的工具调用块
///
/// 条件：
/// 1. block_type 是已知的工具类型之一（MCP_TOOL, ASK_USER, MEMORY 等）
/// 2. tool_name 已设置（区分 LLM 工具调用 vs 预检索结果块）
///    预检索块（如 RAG 检索）也使用 RAG/MEMORY/WEB_SEARCH 类型，
///    但没有 tool_name，因此被正确排除。
fn is_tool_call_block(block: &MessageBlock) -> bool {
    let is_tool_type = matches!(
        block.block_type.as_str(),
        block_types::MCP_TOOL
            | block_types::ASK_USER
            | block_types::MEMORY
            | block_types::WEB_SEARCH
            | block_types::GRAPH
            | block_types::RAG
            | block_types::ACADEMIC_SEARCH
            | block_types::SLEEP
            | block_types::SUBAGENT_EMBED
    );
    is_tool_type && block.tool_name.is_some()
}
