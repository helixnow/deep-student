use super::*;

impl ChatV2Pipeline {

    /// 🆕 P0防闪退：用户消息即时保存
    ///
    /// 在 Pipeline 执行前立即保存用户消息，确保用户输入不会因闪退丢失。
    /// 使用 INSERT OR REPLACE 语义，与 save_results 兼容（不会重复插入）。
    ///
    /// ## 调用时机
    /// 在 execute() 中，emit_stream_start 之后、execute_internal 之前调用。
    ///
    /// ## 与 save_results 的关系
    /// - 本方法先保存用户消息
    /// - save_results 使用 INSERT OR REPLACE，会覆盖本方法保存的数据
    /// - 如果 Pipeline 正常完成，save_results 会保存完整数据
    /// - 如果闪退，至少用户消息已保存
    pub(crate) async fn save_user_message_immediately(&self, ctx: &PipelineContext) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 使用统一的用户消息构建器
        let user_msg_params =
            UserMessageParams::new(ctx.session_id.clone(), ctx.user_content.clone())
                .with_id(ctx.user_message_id.clone())
                .with_attachments(ctx.attachments.clone())
                .with_context_snapshot(ctx.context_snapshot.clone())
                .with_timestamp(now_ms);

        let user_msg_result = build_user_message(user_msg_params);

        // 使用 INSERT OR REPLACE 保存（与 save_results 兼容）
        ChatV2Repo::create_message_with_conn(&conn, &user_msg_result.message)?;
        ChatV2Repo::create_block_with_conn(&conn, &user_msg_result.block)?;

        Ok(())
    }

    /// 🆕 P15 修复：中间保存点
    ///
    /// 在工具执行后保存当前已生成的所有块，确保：
    /// 1. 用户刷新页面时不会丢失已执行的工具结果
    /// 2. 阻塞操作（如 coordinator_sleep）期间数据已持久化
    ///
    /// ## 与 save_results 的关系
    /// - 本方法在流程中间调用，保存部分结果
    /// - save_results 在流程结束时调用，保存完整结果
    /// - 两者都使用 INSERT OR REPLACE，不会冲突
    pub(crate) async fn save_intermediate_results(&self, ctx: &PipelineContext) -> ChatV2Result<()> {
        // 如果没有块需要保存，直接返回
        if ctx.interleaved_blocks.is_empty() {
            return Ok(());
        }

        let conn = self.db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        // P0 修复：使用事务包裹所有写操作，确保中间保存的原子性
        conn.execute("BEGIN IMMEDIATE", []).map_err(|e| {
            log::error!(
                "[ChatV2::pipeline] Failed to begin transaction for save_intermediate_results: {}",
                e
            );
            ChatV2Error::Database(format!("Failed to begin transaction: {}", e))
        })?;

        let save_result = self.save_intermediate_results_inner(&conn, ctx, now_ms);

        match save_result {
            Ok(()) => {
                conn.execute("COMMIT", []).map_err(|e| {
                    log::error!(
                        "[ChatV2::pipeline] Failed to commit intermediate save transaction: {}",
                        e
                    );
                    ChatV2Error::Database(format!("Failed to commit transaction: {}", e))
                })?;
                log::debug!(
                    "[ChatV2::pipeline] Intermediate save committed: message_id={}, blocks={}",
                    ctx.assistant_message_id,
                    ctx.interleaved_blocks.len()
                );
                Ok(())
            }
            Err(e) => {
                if let Err(rollback_err) = conn.execute("ROLLBACK", []) {
                    log::error!(
                        "[ChatV2::pipeline] Failed to rollback intermediate save: {} (original: {:?})",
                        rollback_err,
                        e
                    );
                } else {
                    log::warn!(
                        "[ChatV2::pipeline] Intermediate save rolled back for session={}: {:?}",
                        ctx.session_id,
                        e
                    );
                }
                Err(e)
            }
        }
    }

    /// save_intermediate_results 的内部实现（在事务内执行）
    fn save_intermediate_results_inner(
        &self,
        conn: &crate::chat_v2::database::ChatV2PooledConnection,
        ctx: &PipelineContext,
        now_ms: i64,
    ) -> ChatV2Result<()> {
        // 🔧 P23 修复：中间保存也要保存用户消息
        // 否则刷新后子代理会话只有助手消息，没有用户消息（任务内容）
        // 检查是否跳过用户消息保存（编辑重发场景）
        let skip_user_message = ctx.options.skip_user_message_save.unwrap_or(false);
        if !skip_user_message {
            let user_msg_params =
                UserMessageParams::new(ctx.session_id.clone(), ctx.user_content.clone())
                    .with_id(ctx.user_message_id.clone())
                    .with_attachments(ctx.attachments.clone())
                    .with_context_snapshot(ctx.context_snapshot.clone())
                    .with_timestamp(now_ms);

            let user_msg_result = build_user_message(user_msg_params);

            // 使用 INSERT OR REPLACE 保存用户消息（与 save_results 兼容）
            ChatV2Repo::create_message_with_conn(&conn, &user_msg_result.message)?;
            ChatV2Repo::create_block_with_conn(&conn, &user_msg_result.block)?;
        }

        // 1. 保存助手消息（如果不存在则创建）
        // 🔧 Preserve `anki_cards` blocks created outside of `ctx.interleaved_blocks`.
        //
        // `ChatV2Repo::create_message_with_conn` 使用 ON CONFLICT(id) DO UPDATE SET，
        // 是原地更新而非 DELETE+INSERT，不会触发 CASCADE 删除。
        // 但仍保留 anki_cards 块的保存逻辑以防 block_ids 列表覆盖。
        let preserved_anki_cards_blocks: Vec<MessageBlock> =
            ChatV2Repo::get_message_blocks_with_conn(&conn, &ctx.assistant_message_id)?
                .into_iter()
                .filter(|b| b.block_type == block_types::ANKI_CARDS)
                .collect();

        let interleaved_block_ids: Vec<String> = ctx
            .interleaved_blocks
            .iter()
            .map(|b| b.id.clone())
            .collect();

        // 🔧 修复：按原始 block_index 合并 anki_cards 块，保持其原始位置
        // 而不是追加到末尾导致刷新后位置变化
        let block_ids: Vec<String> = {
            let interleaved_id_set: std::collections::HashSet<&str> =
                interleaved_block_ids.iter().map(|s| s.as_str()).collect();

            // 收集需要插入的 anki_cards 块及其原始位置
            let mut anki_inserts: Vec<(u32, String)> = preserved_anki_cards_blocks
                .iter()
                .filter(|b| !interleaved_id_set.contains(b.id.as_str()))
                .map(|b| (b.block_index, b.id.clone()))
                .collect();
            anki_inserts.sort_by_key(|(idx, _)| *idx);

            // 合并：将 interleaved 块按顺序编号 (0,1,2,...)，
            // 将 anki_cards 块按其原始 block_index 插入对应位置
            let mut indexed: Vec<(u32, String)> = interleaved_block_ids
                .iter()
                .enumerate()
                .map(|(i, id)| (i as u32, id.clone()))
                .collect();

            for (orig_idx, id) in &anki_inserts {
                indexed.push((*orig_idx, id.clone()));
            }

            // 稳定排序：相同 block_index 时保持原有顺序
            indexed.sort_by_key(|(idx, _)| *idx);

            // 去重
            let mut seen = std::collections::HashSet::<String>::new();
            indexed
                .into_iter()
                .filter_map(|(_, id)| {
                    if seen.insert(id.clone()) {
                        Some(id)
                    } else {
                        None
                    }
                })
                .collect()
        };
        let assistant_msg = ChatMessage {
            id: ctx.assistant_message_id.clone(),
            session_id: ctx.session_id.clone(),
            role: MessageRole::Assistant,
            block_ids: block_ids.clone(),
            timestamp: now_ms,
            persistent_stable_id: None,
            parent_id: None,
            supersedes: None,
            meta: None,
            attachments: None,
            active_variant_id: None,
            variants: None,
            shared_context: None,
        };
        ChatV2Repo::create_message_with_conn(&conn, &assistant_msg)?;

        // 2. 保存所有已生成的块
        for (index, block) in ctx.interleaved_blocks.iter().enumerate() {
            let mut block_to_save = block.clone();
            block_to_save.block_index = index as u32;
            ChatV2Repo::create_block_with_conn(&conn, &block_to_save)?;
        }

        // 3. Re-insert preserved `anki_cards` blocks deleted by the assistant message REPLACE.
        //    🔧 修复：保持 anki_cards 块的原始 block_index，不再追加到末尾
        if !preserved_anki_cards_blocks.is_empty() {
            let interleaved_block_id_set: std::collections::HashSet<&str> = ctx
                .interleaved_blocks
                .iter()
                .map(|b| b.id.as_str())
                .collect();

            for preserved in preserved_anki_cards_blocks {
                // If the pipeline already has the same block id, prefer the pipeline version.
                if interleaved_block_id_set.contains(preserved.id.as_str()) {
                    continue;
                }

                // 保持原始 block_index 不变，这样刷新后位置不会跳到末尾
                let block_to_save = preserved;

                if let Err(e) = ChatV2Repo::create_block_with_conn(&conn, &block_to_save) {
                    log::error!(
                        "[ChatV2::pipeline] Failed to re-insert preserved anki_cards block: message_id={}, block_id={}, err={:?}",
                        ctx.assistant_message_id,
                        block_to_save.id,
                        e
                    );
                }
            }
        }

        log::debug!(
            "[ChatV2::pipeline] Intermediate save: message_id={}, blocks={}, user_saved={}",
            ctx.assistant_message_id,
            ctx.interleaved_blocks.len(),
            !skip_user_message
        );

        Ok(())
    }

    /// 保存结果到数据库
    ///
    /// 保存用户消息、助手消息及其所有块到数据库。
    /// 块的 block_index 按生成顺序设置。
    ///
    /// ## skip_user_message_save 选项
    /// 当 `ctx.options.skip_user_message_save` 为 true 时，跳过用户消息的创建。
    /// 用于编辑重发场景：用户消息已在 Handler 中更新，无需 Pipeline 重复创建。
    pub(crate) async fn save_results(&self, ctx: &PipelineContext) -> ChatV2Result<()> {
        log::debug!(
            "[ChatV2::pipeline] Saving results for session={}",
            ctx.session_id
        );

        // 获取数据库连接
        let conn = self.db.get_conn_safe()?;

        // 🆕 P1修复：使用显式事务包裹所有数据库操作，确保原子性
        // 使用 BEGIN IMMEDIATE 避免写锁等待（与 VFS repos 保持一致）
        conn.execute("BEGIN IMMEDIATE", []).map_err(|e| {
            log::error!(
                "[ChatV2::pipeline] Failed to begin transaction for save_results: {}",
                e
            );
            ChatV2Error::Database(format!("Failed to begin transaction: {}", e))
        })?;

        let save_result = self.save_results_inner(&conn, ctx);

        match save_result {
            Ok(()) => {
                conn.execute("COMMIT", []).map_err(|e| {
                    log::error!("[ChatV2::pipeline] Failed to commit transaction: {}", e);
                    ChatV2Error::Database(format!("Failed to commit transaction: {}", e))
                })?;
                log::debug!(
                    "[ChatV2::pipeline] Transaction committed for session={}",
                    ctx.session_id
                );

                // 事务提交成功后执行后处理操作
                self.save_results_post_commit(ctx).await;

                Ok(())
            }
            Err(e) => {
                // 回滚事务
                if let Err(rollback_err) = conn.execute("ROLLBACK", []) {
                    log::error!(
                        "[ChatV2::pipeline] Failed to rollback transaction: {} (original error: {:?})",
                        rollback_err,
                        e
                    );
                } else {
                    log::warn!(
                        "[ChatV2::pipeline] Transaction rolled back for session={}: {:?}",
                        ctx.session_id,
                        e
                    );
                }
                Err(e)
            }
        }
    }

    /// 保存结果的内部实现（在事务内执行）
    ///
    /// 此方法包含所有实际的数据库操作，由 `save_results` 在事务内调用。
    /// 注意：此方法是同步的，因为 SQLite 操作本身是同步的，
    /// 且 PooledConnection 不是 Sync，无法跨 await 点传递引用。
    fn save_results_inner(
        &self,
        conn: &crate::chat_v2::database::ChatV2PooledConnection,
        ctx: &PipelineContext,
    ) -> ChatV2Result<()> {
        // 检查是否跳过用户消息保存（编辑重发场景）
        let skip_user_message = ctx.options.skip_user_message_save.unwrap_or(false);

        // === 1. 创建并保存用户消息（除非 skip_user_message_save 为 true）===
        // 🆕 使用统一的用户消息构建器，确保所有路径的一致性
        if !skip_user_message {
            let user_now_ms = chrono::Utc::now().timestamp_millis();
            let user_msg_params =
                UserMessageParams::new(ctx.session_id.clone(), ctx.user_content.clone())
                    .with_id(ctx.user_message_id.clone())
                    .with_attachments(ctx.attachments.clone())
                    .with_context_snapshot(ctx.context_snapshot.clone())
                    .with_timestamp(user_now_ms);

            let user_msg_result = build_user_message(user_msg_params);

            // 保存用户消息和块
            ChatV2Repo::create_message_with_conn(&conn, &user_msg_result.message)?;
            ChatV2Repo::create_block_with_conn(&conn, &user_msg_result.block)?;

            log::debug!(
                "[ChatV2::pipeline] Saved user message: id={}, content_len={}",
                ctx.user_message_id,
                ctx.user_content.len()
            );
        } else {
            log::debug!(
                "[ChatV2::pipeline] Skipped user message save (skip_user_message_save=true): id={}",
                ctx.user_message_id
            );
        }

        // === 2. 创建并保存助手消息 ===
        //
        // 块保存逻辑优先级：
        // 1. interleaved_blocks（Interleaved Thinking 模式，支持 thinking→tool→thinking→content 交替）
        // 2. generated_blocks（旧逻辑，兼容性保留，目前未使用）
        // 3. 手动创建 thinking/content 块（无工具调用的简单场景）
        //
        // 🔧 块顺序修复：检索块插入在 thinking 之后、content 之前
        // 正确顺序：thinking → retrieval → content（与前端流式渲染一致）

        let assistant_now_ms = chrono::Utc::now().timestamp_millis();
        let elapsed_ms = ctx.elapsed_ms() as i64;
        let mut block_ids: Vec<String> = Vec::new();
        let mut blocks: Vec<MessageBlock> = Vec::new();
        let mut block_index = 0u32;

        // ============================================================
        // 辅助宏：创建检索块，使用流式过程中创建的块 ID
        // 🔧 修复：检索块应该在 thinking 之后、content 之前添加
        // ============================================================
        macro_rules! add_retrieval_block {
            ($block_ids:expr, $blocks:expr, $block_index:expr, $sources:expr, $block_type:expr) => {
                if let Some(ref sources) = $sources {
                    if !sources.is_empty() {
                        let retrieval_block_id = ctx.streaming_retrieval_block_ids
                            .get(&$block_type.to_string())
                            .cloned()
                            .unwrap_or_else(|| MessageBlock::generate_id());
                        let started_at = assistant_now_ms - elapsed_ms;
                        let block = MessageBlock {
                            id: retrieval_block_id,
                            message_id: ctx.assistant_message_id.clone(),
                            block_type: $block_type.to_string(),
                            status: block_status::SUCCESS.to_string(),
                            content: None,
                            tool_name: None,
                            tool_input: None,
                            tool_output: Some(json!({ "sources": sources })),
                            citations: None,
                            error: None,
                            started_at: Some(started_at),
                            ended_at: Some(assistant_now_ms),
                            // 🔧 检索块使用 started_at 作为排序依据
                            first_chunk_at: Some(started_at),
                            block_index: $block_index,
                        };
                        $block_ids.push(block.id.clone());
                        $blocks.push(block);
                        $block_index += 1;
                    }
                }
            };
        }

        // ============================================================
        // 优先级 1: Interleaved Thinking 模式（多轮工具调用）
        // 🔧 P3修复：保持原始交替顺序！不要分离 thinking 块
        // 正确顺序：retrieval → thinking → tool → thinking → tool → ...
        // ============================================================
        if ctx.has_interleaved_blocks() {
            log::info!(
                "[ChatV2::pipeline] Using interleaved blocks for save: count={}",
                ctx.interleaved_block_ids.len()
            );

            // 🔧 P3修复：先添加检索块（检索在 LLM 调用之前完成）
            add_retrieval_block!(
                block_ids,
                blocks,
                block_index,
                ctx.retrieved_sources.rag,
                block_types::RAG
            );
            add_retrieval_block!(
                block_ids,
                blocks,
                block_index,
                ctx.retrieved_sources.memory,
                block_types::MEMORY
            );
            add_retrieval_block!(
                block_ids,
                blocks,
                block_index,
                ctx.retrieved_sources.web_search,
                block_types::WEB_SEARCH
            );

            // 🔧 P3修复：保持 interleaved_blocks 的原始交替顺序
            // 不再分离 thinking 块，直接按原顺序添加
            for mut block in ctx.interleaved_blocks.iter().cloned() {
                block.block_index = block_index;
                block_ids.push(block.id.clone());
                blocks.push(block);
                block_index += 1;
            }
        }
        // ============================================================
        // 优先级 2: 旧的 generated_blocks 逻辑（兼容性保留，目前未使用）
        // 注意：generated_blocks 当前始终为空，此分支保留用于未来兼容
        // ============================================================
        else {
            let assistant_block_ids: Vec<String> =
                ctx.generated_blocks.iter().map(|b| b.id.clone()).collect();

            if !assistant_block_ids.is_empty() {
                // 分离 thinking 块和其他块
                let thinking_blocks: Vec<_> = ctx
                    .generated_blocks
                    .iter()
                    .filter(|b| b.block_type == block_types::THINKING)
                    .cloned()
                    .collect();
                let other_blocks: Vec<_> = ctx
                    .generated_blocks
                    .iter()
                    .filter(|b| b.block_type != block_types::THINKING)
                    .cloned()
                    .collect();

                // 1. 添加 thinking 块
                for mut block in thinking_blocks {
                    block.block_index = block_index;
                    block_ids.push(block.id.clone());
                    blocks.push(block);
                    block_index += 1;
                }

                // 2. 添加检索块
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.rag,
                    block_types::RAG
                );
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.memory,
                    block_types::MEMORY
                );
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.web_search,
                    block_types::WEB_SEARCH
                );

                // 3. 添加其他块（content/tool）
                for mut block in other_blocks {
                    block.block_index = block_index;
                    block_ids.push(block.id.clone());
                    blocks.push(block);
                    block_index += 1;
                }
            }
            // ============================================================
            // 优先级 3: 手动创建 thinking/content 块（无工具调用的简单场景）
            // 🔧 修复：正确顺序为 thinking → retrieval → content
            // 🔧 修复：只要有 thinking 或 content 内容，都应该保存（取消时可能只有 thinking）
            // ============================================================
            else if !ctx.final_content.is_empty()
                || ctx
                    .final_reasoning
                    .as_ref()
                    .map_or(false, |r| !r.is_empty())
            {
                log::info!(
                    "[ChatV2::pipeline] save_results priority 3: final_content_len={}, final_reasoning={:?}",
                    ctx.final_content.len(),
                    ctx.final_reasoning.as_ref().map(|r| format!("{}chars", r.len()))
                );
                // 1. thinking 块：使用流式过程中创建的块 ID，确保与前端一致
                if let Some(ref reasoning) = ctx.final_reasoning {
                    if !reasoning.is_empty() {
                        let thinking_block_id = ctx
                            .streaming_thinking_block_id
                            .clone()
                            .unwrap_or_else(|| MessageBlock::generate_id());
                        let started_at = assistant_now_ms - elapsed_ms;
                        let block = MessageBlock {
                            id: thinking_block_id,
                            message_id: ctx.assistant_message_id.clone(),
                            block_type: block_types::THINKING.to_string(),
                            status: block_status::SUCCESS.to_string(),
                            content: Some(reasoning.clone()),
                            tool_name: None,
                            tool_input: None,
                            tool_output: None,
                            citations: None,
                            error: None,
                            started_at: Some(started_at),
                            ended_at: Some(assistant_now_ms),
                            // 🔧 使用 started_at 作为 first_chunk_at（流式时记录的）
                            first_chunk_at: Some(started_at),
                            block_index,
                        };
                        block_ids.push(block.id.clone());
                        blocks.push(block);
                        block_index += 1;
                    }
                }

                // 2. 检索块（在 thinking 后、content 前）
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.rag,
                    block_types::RAG
                );
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.memory,
                    block_types::MEMORY
                );
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.web_search,
                    block_types::WEB_SEARCH
                );

                // 3. content 块：使用流式过程中创建的块 ID，确保与前端一致
                // 🔧 修复：只有当 final_content 不为空时才创建 content 块（取消时可能只有 thinking）
                if !ctx.final_content.is_empty() {
                    let content_block_id = ctx
                        .streaming_content_block_id
                        .clone()
                        .unwrap_or_else(|| MessageBlock::generate_id());
                    let started_at = assistant_now_ms - elapsed_ms;
                    let block = MessageBlock {
                        id: content_block_id,
                        message_id: ctx.assistant_message_id.clone(),
                        block_type: block_types::CONTENT.to_string(),
                        status: block_status::SUCCESS.to_string(),
                        content: Some(ctx.final_content.clone()),
                        tool_name: None,
                        tool_input: None,
                        tool_output: None,
                        citations: None,
                        error: None,
                        started_at: Some(started_at),
                        ended_at: Some(assistant_now_ms),
                        // 🔧 使用 started_at 作为 first_chunk_at
                        first_chunk_at: Some(started_at),
                        block_index,
                    };
                    block_ids.push(block.id.clone());
                    blocks.push(block);
                    block_index += 1;
                }
            }

            // 工具调用块（仅在非 interleaved 模式下添加，因为 interleaved 模式已包含）
            for tool_result in &ctx.tool_results {
                let tool_block_id = tool_result
                    .block_id
                    .clone()
                    .unwrap_or_else(|| MessageBlock::generate_id());
                let started_at = assistant_now_ms - tool_result.duration_ms.unwrap_or(0) as i64;

                // 🔧 修复：根据工具名称判断正确的 block_type
                // 检索工具使用对应的检索块类型，而不是 mcp_tool
                let block_type = Self::tool_name_to_block_type(&tool_result.tool_name);

                let block = MessageBlock {
                    id: tool_block_id,
                    message_id: ctx.assistant_message_id.clone(),
                    block_type,
                    status: if tool_result.success {
                        block_status::SUCCESS.to_string()
                    } else {
                        block_status::ERROR.to_string()
                    },
                    content: None,
                    tool_name: Some(tool_result.tool_name.clone()),
                    tool_input: Some(tool_result.input.clone()),
                    tool_output: Some(tool_result.output.clone()),
                    citations: None,
                    error: if tool_result.success {
                        None
                    } else {
                        tool_result.error.clone()
                    },
                    started_at: Some(started_at),
                    ended_at: Some(assistant_now_ms),
                    // 🔧 工具块使用 started_at 作为排序依据
                    first_chunk_at: Some(started_at),
                    block_index,
                };
                block_ids.push(block.id.clone());
                blocks.push(block);
                block_index += 1;
            }
        }

        // 🔧 Preserve `anki_cards` blocks created outside of pipeline-generated blocks.
        //
        // `ChatV2Repo::create_message_with_conn` uses SQLite `INSERT OR REPLACE` (DELETE+INSERT).
        // With `chat_v2_blocks.message_id ON DELETE CASCADE`, replacing the assistant message row
        // can delete existing blocks (including ChatAnki-generated `anki_cards` blocks).
        let preserved_anki_cards_blocks: Vec<MessageBlock> =
            ChatV2Repo::get_message_blocks_with_conn(&conn, &ctx.assistant_message_id)?
                .into_iter()
                .filter(|b| b.block_type == block_types::ANKI_CARDS)
                .collect();
        let _preserved_anki_cards_block_ids: Vec<String> = preserved_anki_cards_blocks
            .iter()
            .map(|b| b.id.clone())
            .collect();

        // 🔧 P37 修复：合并数据库中已有的 block_ids（保留前端追加的块）
        // 问题：前端在工具执行后创建 workspace_status 块并追加到消息的 block_ids，
        //       但 save_results 会用 final_block_ids 覆盖整个消息，导致前端追加的块丢失
        // 解决：先读取数据库中现有消息的 block_ids，合并前端追加的块
        let final_block_ids = {
            let mut merged_block_ids = block_ids;

            // 尝试读取数据库中现有消息的 block_ids
            if let Ok(existing_block_ids_json) = conn.query_row::<Option<String>, _, _>(
                "SELECT block_ids_json FROM chat_v2_messages WHERE id = ?1",
                rusqlite::params![&ctx.assistant_message_id],
                |row| row.get(0),
            ) {
                if let Some(json_str) = existing_block_ids_json {
                    if let Ok(existing_block_ids) = serde_json::from_str::<Vec<String>>(&json_str) {
                        // 找出前端追加的块（在数据库中但不在当前 block_ids 中）
                        for existing_id in existing_block_ids {
                            if !merged_block_ids.contains(&existing_id) {
                                log::info!(
                                    "[ChatV2::pipeline] 🔧 P37: Preserving frontend-appended block_id: {}",
                                    existing_id
                                );
                                merged_block_ids.push(existing_id);
                            }
                        }
                    }
                }
            }

            // 🔧 修复：按原始 block_index 插入 anki_cards 块，保持其原始位置
            // 而不是追加到末尾导致刷新后位置变化
            let pipeline_id_set: std::collections::HashSet<&str> =
                merged_block_ids.iter().map(|s| s.as_str()).collect();
            let mut anki_inserts: Vec<(u32, String)> = preserved_anki_cards_blocks
                .iter()
                .filter(|b| !pipeline_id_set.contains(b.id.as_str()))
                .map(|b| (b.block_index, b.id.clone()))
                .collect();
            anki_inserts.sort_by_key(|(idx, _)| *idx);

            for (orig_idx, id) in anki_inserts {
                // 将 anki_cards 块插入到其原始 block_index 对应的位置
                let insert_pos = std::cmp::min(orig_idx as usize, merged_block_ids.len());
                if !merged_block_ids.contains(&id) {
                    merged_block_ids.insert(insert_pos, id);
                }
            }

            merged_block_ids
        };
        let blocks_to_save = blocks;
        let _pipeline_block_count = blocks_to_save.len() as u32;
        let pipeline_block_id_set: std::collections::HashSet<String> =
            blocks_to_save.iter().map(|b| b.id.clone()).collect();

        // 构建 chatParams 快照（从 SendOptions 中提取相关参数）
        let chat_params_snapshot = json!({
            "modelId": ctx.options.model_id,
            "temperature": ctx.options.temperature,
            "contextLimit": ctx.options.context_limit,
            "maxTokens": ctx.options.max_tokens,
            "enableThinking": ctx.options.enable_thinking,
            "disableTools": ctx.options.disable_tools,
            "model2OverrideId": ctx.options.model2_override_id,
        });

        // 构建助手消息元数据
        // 🔧 Bug修复：model_id 使用模型显示名称（如 "Qwen/Qwen3-8B"），而不是 API 配置 ID
        // 这确保刷新后前端能正确显示模型名称和图标
        let assistant_meta = MessageMeta {
            model_id: ctx
                .model_display_name
                .clone()
                .or_else(|| {
                    // 🔧 P0-2 修复：优先尝试 model2_override_id（实际使用的模型）
                    // 过滤配置 ID 格式，避免保存前端无法识别的值
                    ctx.options.model2_override_id.as_ref()
                        .filter(|id| !is_config_id_format(id))
                        .cloned()
                })
                .or_else(|| {
                    ctx.options.model_id.as_ref()
                        .filter(|id| !is_config_id_format(id))
                        .cloned()
                }),
            chat_params: Some(chat_params_snapshot),
            sources: if ctx.retrieved_sources.rag.is_some()
                || ctx.retrieved_sources.memory.is_some()
                || ctx.retrieved_sources.web_search.is_some()
            {
                Some(ctx.retrieved_sources.clone())
            } else {
                None
            },
            tool_results: if ctx.tool_results.is_empty() {
                None
            } else {
                Some(ctx.tool_results.clone())
            },
            anki_cards: None,
            // 🆕 Prompt 5: 保存 token 统计（始终保存，不跳过零值）
            usage: Some(ctx.token_usage.clone()),
            // 🆕 Prompt 8: 保存上下文快照（统一上下文注入系统）
            // 只存 ContextRef，不存 formattedBlocks
            context_snapshot: if ctx.context_snapshot.has_refs() {
                Some(ctx.context_snapshot.clone())
            } else {
                None
            },
        };

        let assistant_message = ChatMessage {
            id: ctx.assistant_message_id.clone(),
            session_id: ctx.session_id.clone(),
            role: MessageRole::Assistant,
            block_ids: final_block_ids,
            timestamp: chrono::Utc::now().timestamp_millis(),
            persistent_stable_id: None,
            parent_id: None,
            supersedes: None,
            meta: Some(assistant_meta),
            attachments: None,
            active_variant_id: None,
            variants: None,
            shared_context: None,
        };

        // 检查是否跳过助手消息保存（重试场景）
        let skip_assistant_message = ctx.options.skip_assistant_message_save.unwrap_or(false);

        if !skip_assistant_message {
            // 正常场景：创建新的助手消息
            ChatV2Repo::create_message_with_conn(&conn, &assistant_message)?;
        } else {
            // 重试场景：更新已有的助手消息（只更新块列表和元数据）
            log::debug!(
                "[ChatV2::pipeline] Updating existing assistant message for retry: id={}",
                ctx.assistant_message_id
            );
            ChatV2Repo::update_message_with_conn(&conn, &assistant_message)?;
        }

        // 保存所有助手消息块（无论是创建还是更新消息，块都需要保存）
        for (index, mut block) in blocks_to_save.into_iter().enumerate() {
            // 确保 block_index 正确设置
            block.block_index = index as u32;
            // 确保 message_id 正确
            block.message_id = ctx.assistant_message_id.clone();
            ChatV2Repo::create_block_with_conn(&conn, &block)?;
        }

        // Re-insert preserved `anki_cards` blocks deleted by the assistant message REPLACE.
        //    🔧 修复：保持 anki_cards 块的原始 block_index，不再追加到末尾
        if !preserved_anki_cards_blocks.is_empty() {
            for preserved in preserved_anki_cards_blocks {
                // If the pipeline already has the same block id, prefer the pipeline version.
                if pipeline_block_id_set.contains(preserved.id.as_str()) {
                    continue;
                }

                // 保持原始 block_index 不变，这样刷新后位置不会跳到末尾
                let mut block_to_save = preserved;
                block_to_save.message_id = ctx.assistant_message_id.clone();

                if let Err(e) = ChatV2Repo::create_block_with_conn(&conn, &block_to_save) {
                    log::error!(
                        "[ChatV2::pipeline] Failed to re-insert preserved anki_cards block: message_id={}, block_id={}, err={:?}",
                        ctx.assistant_message_id,
                        block_to_save.id,
                        e
                    );
                }
            }
        }

        log::info!(
            "[ChatV2::pipeline] Results saved: session={}, user_msg={}, assistant_msg={}, blocks={}, content_len={}",
            ctx.session_id,
            ctx.user_message_id,
            ctx.assistant_message_id,
            ctx.generated_blocks.len(),
            ctx.final_content.len()
        );

        Ok(())
    }

    /// 保存结果后的后处理操作（在事务提交后执行）
    ///
    /// 此方法在事务成功提交后由 `save_results` 调用，
    /// 执行不需要事务保护的后处理操作。
    async fn save_results_post_commit(&self, ctx: &PipelineContext) {
        // 🆕 Prompt 8: 消息保存后增加资源引用计数（统一上下文注入系统）
        if ctx.context_snapshot.has_refs() {
            let resource_ids = ctx.context_snapshot.all_resource_ids();
            self.increment_resource_refs(&resource_ids).await;
            log::debug!(
                "[ChatV2::pipeline] Incremented refs for {} resources after message save",
                resource_ids.len()
            );
        }

        // 🆕 受 mem0/memU 启发：对话后自动记忆提取 pipeline
        // 异步 fire-and-forget，不阻塞对话返回
        self.trigger_auto_memory_extraction(ctx);
    }

    /// 触发对话后自动记忆提取（fire-and-forget）
    ///
    /// 受 mem0 `add` 和 memU `memorize` 启发：
    /// 从用户消息和助手回复中自动提取候选记忆，通过 write_smart 去重写入。
    fn trigger_auto_memory_extraction(&self, ctx: &PipelineContext) {
        let vfs_db = match &self.vfs_db {
            Some(db) => db.clone(),
            None => return,
        };
        let llm_manager = self.llm_manager.clone();
        let user_content = ctx.user_content.clone();
        let final_content = ctx.final_content.clone();

        if user_content.len() < 10 && final_content.len() < 10 {
            return;
        }

        // 竞态保护：如果 LLM 本轮已通过工具主动写入过记忆，跳过自动提取。
        // 避免 auto_extractor 在索引窗口期内重复提取相同事实。
        let llm_already_wrote_memory = ctx.tool_results.iter().any(|tr| {
            let name = tr.tool_name.as_str();
            matches!(
                name.strip_prefix("builtin-").unwrap_or(name),
                "memory_write" | "memory_write_smart" | "memory_update_by_id"
            )
        });
        if llm_already_wrote_memory {
            log::debug!(
                "[AutoMemory] Skipping auto-extraction: LLM already wrote memories this turn"
            );
            return;
        }

        // fire-and-forget: 不走 spawn_tracked 因为 Pipeline 不持有 ChatV2State。
        // 安全性：中断仅导致少提取记忆，不会丢失已有数据（write_smart 内部 DB 写入是原子的）。
        tokio::spawn(async move {
            use crate::memory::{MemoryAutoExtractor, MemoryService};
            use crate::vfs::lance_store::VfsLanceStore;

            let lance_store = match VfsLanceStore::new(vfs_db.clone()) {
                Ok(s) => std::sync::Arc::new(s),
                Err(e) => {
                    log::warn!("[AutoMemory] Failed to create lance store: {}", e);
                    return;
                }
            };

            let memory_service = MemoryService::new(
                vfs_db.clone(),
                lance_store,
                llm_manager.clone(),
            );

            // 隐私模式检查：跳过所有 LLM API 调用（不发送对话内容）
            match memory_service.get_config() {
                Ok(cfg) if cfg.privacy_mode => {
                    log::debug!("[AutoMemory] Privacy mode enabled, skipping auto-extraction");
                    return;
                }
                Err(e) => {
                    log::debug!("[AutoMemory] Config read failed, skipping: {}", e);
                    return;
                }
                _ => {}
            }

            let extractor = MemoryAutoExtractor::new(llm_manager.clone());

            match extractor
                .extract_and_store(&memory_service, &user_content, &final_content)
                .await
            {
                Ok(count) => {
                    if count > 0 {
                        log::info!(
                            "[AutoMemory] Auto-extracted {} memories from conversation",
                            count
                        );
                    }

                    // 节流策略：只有实际新增了记忆时才考虑刷新分类文件。
                    // 进一步通过记忆总数的模运算控制频率：每积累 5 条总记忆刷新一次，
                    // 避免每轮对话都触发 LLM 分类调用，同时确保分类文件最终会被创建。
                    if count > 0 {
                        let should_refresh = match memory_service.list(None, 500, 0) {
                            Ok(all) => {
                                let total = all.iter().filter(|m| !m.title.starts_with("__")).count();
                                total <= 5 || total % 5 == 0
                            }
                            Err(_) => false,
                        };
                        if should_refresh {
                            use crate::memory::MemoryCategoryManager;
                            let cat_mgr = MemoryCategoryManager::new(
                                vfs_db.clone(),
                                llm_manager.clone(),
                            );
                            if let Err(e) = cat_mgr.refresh_all_categories(&memory_service).await {
                                log::warn!("[AutoMemory] Category refresh failed: {}", e);
                            }
                        }
                    }

                    // 自进化节流：每 30 分钟最多执行一次，避免大量 SQL 遍历
                    use crate::memory::MemoryEvolution;
                    use std::sync::atomic::{AtomicI64, Ordering};
                    static LAST_EVOLUTION_MS: AtomicI64 = AtomicI64::new(0);
                    const EVOLUTION_INTERVAL_MS: i64 = 30 * 60 * 1000;

                    let now_ms = chrono::Utc::now().timestamp_millis();
                    let last = LAST_EVOLUTION_MS.load(Ordering::Relaxed);
                    if now_ms - last >= EVOLUTION_INTERVAL_MS {
                        LAST_EVOLUTION_MS.store(now_ms, Ordering::Relaxed);
                        let evolution = MemoryEvolution::new(vfs_db);
                        match evolution.run_evolution_cycle(&memory_service) {
                            Ok(report) => {
                                if report.stale_demoted > 0 || report.high_freq_promoted > 0 || report.duplicates_merged > 0 {
                                    log::info!(
                                        "[AutoMemory] Evolution: demoted={}, promoted={}, merged={}",
                                        report.stale_demoted,
                                        report.high_freq_promoted,
                                        report.duplicates_merged
                                    );
                                }
                            }
                            Err(e) => {
                                log::debug!("[AutoMemory] Evolution check failed (non-fatal): {}", e);
                            }
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[AutoMemory] Auto-extraction failed (non-fatal): {}", e);
                }
            }
        });
    }
}
