use super::*;

fn build_replay_skill_payload_snapshot(
    options: &SendOptions,
) -> Option<crate::chat_v2::types::ReplaySkillPayloadSnapshot> {
    let snapshot = crate::chat_v2::types::ReplaySkillPayloadSnapshot {
        active_skill_ids: options.active_skill_ids.clone().unwrap_or_default(),
        execution_allowed_tools: options.execution_allowed_tools.clone(),
        skill_contents: options.skill_contents.clone().unwrap_or_default(),
        skill_dependencies: options.skill_dependencies.clone().unwrap_or_default(),
        skill_embedded_tools: options.skill_embedded_tools.clone().unwrap_or_default(),
        mcp_tool_schemas: options.mcp_tool_schemas.clone().unwrap_or_default(),
        selected_mcp_servers: options.mcp_tools.clone().unwrap_or_default(),
    }
    .without_skill_contents();

    snapshot.has_replay_metadata().then_some(snapshot)
}

/// 从最终回复文本与工具结果中解析"实际被引用的记忆 note_id"（引用级使用信号）。
///
/// - 回复中的引用标记形如 `[记忆-N]`（编号由后端 CitationLedger 分配、前端直接
///   信任的契约；兼容英文别名 `[memory-N]` 与 `:图片` 类后缀）；
/// - 工具输出的 numbered sources 中 `citationTag` 为 `[记忆-N]` 的条目携带
///   `noteId`（压缩摘要条目为 null，改用 `sourceNoteIds` 数组还原真实成员）。
///
/// 返回去重后的 note_id 列表；同一编号被引用多次只计一次（回复级 set 语义）。
/// 这使 `_used` 从"LLM 主动读全文"扩展到"检索摘要被答案实际引用"，
/// 覆盖了此前只在前端渲染层可见的引用使用信号。
fn extract_cited_memory_note_ids(
    final_content: &str,
    tool_results: &[ToolResultInfo],
) -> Vec<String> {
    use std::sync::OnceLock;
    static CITED_PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = CITED_PATTERN.get_or_init(|| {
        regex::Regex::new(r"(?i)\[(?:记忆|memory)-(\d+)(?::[^\]]*)?\]")
            .expect("memory citation regex is valid")
    });

    let mut cited_indexes: std::collections::HashSet<u64> = std::collections::HashSet::new();
    for cap in pattern.captures_iter(final_content) {
        if let Some(n) = cap.get(1).and_then(|m| m.as_str().parse::<u64>().ok()) {
            cited_indexes.insert(n);
        }
    }
    if cited_indexes.is_empty() {
        return Vec::new();
    }

    let mut note_ids: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for tr in tool_results {
        if !tr.success {
            continue;
        }
        let Some(sources) = tr.output.get("sources").and_then(|v| v.as_array()) else {
            continue;
        };
        for source in sources {
            let Some(tag) = source.get("citationTag").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(idx) = pattern
                .captures(tag)
                .and_then(|c| c.get(1))
                .and_then(|m| m.as_str().parse::<u64>().ok())
            else {
                continue;
            };
            if !cited_indexes.contains(&idx) {
                continue;
            }
            let mut push_id = |id: &str| {
                if !id.is_empty() && seen.insert(id.to_string()) {
                    note_ids.push(id.to_string());
                }
            };
            // 普通条目：noteId（camelCase 优先，兼容 snake_case）
            if let Some(id) = source
                .get("noteId")
                .and_then(|v| v.as_str())
                .or_else(|| source.get("note_id").and_then(|v| v.as_str()))
            {
                push_id(id);
            }
            // 压缩摘要条目：noteId 为 null，成员真实 ID 在 sourceNoteIds
            if let Some(list) = source.get("sourceNoteIds").and_then(|v| v.as_array()) {
                for value in list {
                    if let Some(id) = value.as_str() {
                        push_id(id);
                    }
                }
            }
        }
    }
    note_ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_replay_skill_payload_snapshot_does_not_persist_skill_contents() {
        let options = SendOptions {
            active_skill_ids: Some(vec!["manual-a".to_string()]),
            skill_contents: Some(std::collections::HashMap::from([(
                "manual-a".to_string(),
                "private instructions".to_string(),
            )])),
            ..Default::default()
        };

        let snapshot = build_replay_skill_payload_snapshot(&options).unwrap();
        assert_eq!(snapshot.active_skill_ids, vec!["manual-a".to_string()]);
        assert!(snapshot.skill_contents.is_empty());
    }

    #[test]
    fn test_build_replay_skill_payload_snapshot_skips_content_only_payload() {
        let options = SendOptions {
            skill_contents: Some(std::collections::HashMap::from([(
                "agentic-a".to_string(),
                "private instructions".to_string(),
            )])),
            ..Default::default()
        };

        assert!(build_replay_skill_payload_snapshot(&options).is_none());
    }

    fn make_tool_result(output: serde_json::Value) -> ToolResultInfo {
        ToolResultInfo {
            tool_call_id: None,
            block_id: None,
            tool_name: "builtin-unified_search".to_string(),
            input: serde_json::json!({}),
            output,
            success: true,
            error: None,
            duration_ms: None,
            reasoning_content: None,
            thought_signature: None,
        }
    }

    #[test]
    fn cited_memory_ids_map_citations_including_compressed_sources() {
        let tool_results = vec![make_tool_result(serde_json::json!({
            "success": true,
            "sources": [
                { "citationTag": "[记忆-1]", "noteId": "note_a" },
                { "citationTag": "[记忆-2]", "noteId": null,
                  "sourceNoteIds": ["note_b", "note_c"] },
                { "citationTag": "[知识库-1]", "noteId": "res_x" },
                { "citationTag": "[记忆-3]", "noteId": "note_d" }
            ]
        }))];
        // 引用了记忆-1/2（记忆-3 未被引用；知识库引用不计入）
        let ids = extract_cited_memory_note_ids(
            "根据 [记忆-1]，你此前……结合 [记忆-2] 与 [知识库-1] 来看",
            &tool_results,
        );
        assert_eq!(ids, vec!["note_a", "note_b", "note_c"]);
    }

    #[test]
    fn cited_memory_ids_dedupe_and_handle_no_citation() {
        let tool_results = vec![make_tool_result(serde_json::json!({
            "success": true,
            "sources": [{ "citationTag": "[记忆-1]", "noteId": "note_a" }]
        }))];
        // 同一编号引用两次只计一次；英文别名大小写不敏感
        let ids = extract_cited_memory_note_ids("[记忆-1] …… [Memory-1] 再次引用", &tool_results);
        assert_eq!(ids, vec!["note_a"]);
        // 正文无记忆引用（裸文本"记忆-1"不带方括号不算）
        assert!(
            extract_cited_memory_note_ids("提到过 记忆-1 但没有引用标记", &tool_results).is_empty()
        );
    }
}

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
    pub(crate) async fn save_user_message_immediately(
        &self,
        ctx: &PipelineContext,
    ) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 使用统一的用户消息构建器
        let user_msg_params =
            UserMessageParams::new(ctx.session_id.clone(), ctx.user_content.clone())
                .with_id(ctx.user_message_id.clone())
                .with_attachments(ctx.attachments.clone())
                .with_context_snapshot(ctx.context_snapshot.clone())
                .with_canonical_content(ctx.canonical_content.clone())
                .with_execution_snapshot(ctx.execution_snapshot.clone())
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
    pub(crate) async fn save_intermediate_results(
        &self,
        ctx: &PipelineContext,
    ) -> ChatV2Result<()> {
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

    /// 🔧 P0-3 修复：带一次重试的中间保存点。
    ///
    /// 用于「即将进入长阻塞阶段」（工具执行如 coordinator_sleep、下一轮 LLM 调用）
    /// 前的关键保存：之前失败仅 warn 一次即放弃，阻塞期间用户刷新会丢已生成内容。
    /// 现在失败后小退避重试一次（多数失败源于 SQLITE_BUSY 类瞬态锁竞争）；
    /// 重试仍失败则升级为 error 日志（附 session/message id），但不中断流程。
    ///
    /// 返回是否最终保存成功（仅用于调用方日志分支）。
    pub(crate) async fn save_intermediate_results_with_retry(
        &self,
        ctx: &PipelineContext,
        stage: &str,
    ) -> bool {
        let first_err = match self.save_intermediate_results(ctx).await {
            Ok(()) => return true,
            Err(e) => e,
        };
        log::warn!(
            "[ChatV2::pipeline] Intermediate save failed at {} (session={}, message={}): {}; retrying once",
            stage,
            ctx.session_id,
            ctx.assistant_message_id,
            first_err
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        match self.save_intermediate_results(ctx).await {
            Ok(()) => {
                log::info!(
                    "[ChatV2::pipeline] Intermediate save retry succeeded at {} (session={})",
                    stage,
                    ctx.session_id
                );
                true
            }
            Err(retry_err) => {
                log::error!(
                    "[ChatV2::pipeline] Intermediate save failed after retry at {} (session={}, message={}): {}; continuing without persistence — generated blocks may be lost on refresh until the next save point",
                    stage,
                    ctx.session_id,
                    ctx.assistant_message_id,
                    retry_err
                );
                false
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
                    .with_canonical_content(ctx.canonical_content.clone())
                    .with_execution_snapshot(ctx.execution_snapshot.clone())
                    .with_timestamp(now_ms);

            let user_msg_result = build_user_message(user_msg_params);

            // 使用 INSERT OR REPLACE 保存用户消息（与 save_results 兼容）
            ChatV2Repo::create_message_with_conn(conn, &user_msg_result.message)?;
            ChatV2Repo::create_block_with_conn(conn, &user_msg_result.block)?;
        }

        // 1. 保存助手消息（如果不存在则创建）
        // 🔧 Preserve `anki_cards` blocks created outside of `ctx.interleaved_blocks`.
        //
        // `ChatV2Repo::create_message_with_conn` 使用 ON CONFLICT(id) DO UPDATE SET，
        // 是原地更新而非 DELETE+INSERT，不会触发 CASCADE 删除。
        // 但仍保留 anki_cards 块的保存逻辑以防 block_ids 列表覆盖。
        let preserved_anki_cards_blocks: Vec<MessageBlock> =
            ChatV2Repo::get_message_blocks_with_conn(conn, &ctx.assistant_message_id)?
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
        ChatV2Repo::create_message_with_conn(conn, &assistant_msg)?;

        // 2. 保存所有已生成的块
        for (index, block) in ctx.interleaved_blocks.iter().enumerate() {
            let mut block_to_save = block.clone();
            block_to_save.block_index = index as u32;
            ChatV2Repo::create_block_with_conn(conn, &block_to_save)?;
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

                if let Err(e) = ChatV2Repo::create_block_with_conn(conn, &block_to_save) {
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
                    .with_canonical_content(ctx.canonical_content.clone())
                    .with_execution_snapshot(ctx.execution_snapshot.clone())
                    .with_timestamp(user_now_ms);

            let user_msg_result = build_user_message(user_msg_params);

            // 保存用户消息和块
            ChatV2Repo::create_message_with_conn(conn, &user_msg_result.message)?;
            ChatV2Repo::create_block_with_conn(conn, &user_msg_result.block)?;

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
                || ctx.final_reasoning.as_ref().is_some_and(|r| !r.is_empty())
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
                            .unwrap_or_else(MessageBlock::generate_id);
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
                        .unwrap_or_else(MessageBlock::generate_id);
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
                    .unwrap_or_else(MessageBlock::generate_id);
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
            ChatV2Repo::get_message_blocks_with_conn(conn, &ctx.assistant_message_id)?
                .into_iter()
                .filter(|b| b.block_type == block_types::ANKI_CARDS)
                .collect();
        let preserved_anki_cards_block_ids: std::collections::HashSet<String> =
            preserved_anki_cards_blocks
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
                            // anki_cards 按原始 block_index 在下方插入；这里直接 append
                            // 会让它永久落到消息尾部，并使后续插入逻辑失效。
                            if preserved_anki_cards_block_ids.contains(&existing_id) {
                                continue;
                            }
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
        let final_block_positions: std::collections::HashMap<String, u32> = final_block_ids
            .iter()
            .enumerate()
            .map(|(index, id)| (id.clone(), index as u32))
            .collect();

        // 构建 chatParams 快照（从 SendOptions 中提取相关参数）
        let chat_params_snapshot = json!({
            "modelId": ctx.options.model_id,
            "temperature": ctx.options.temperature,
            "contextLimit": ctx.options.context_limit,
            "maxTokens": ctx.options.max_tokens,
            "enableThinking": ctx.options.enable_thinking,
            "reasoningEffort": ctx.options.reasoning_effort,
            "thinkingBudget": ctx.options.thinking_budget,
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
                    ctx.options
                        .model2_override_id
                        .as_ref()
                        .filter(|id| !is_config_id_format(id))
                        .cloned()
                })
                .or_else(|| {
                    ctx.options
                        .model_id
                        .as_ref()
                        .filter(|id| !is_config_id_format(id))
                        .cloned()
                }),
            execution_snapshot: ctx.execution_snapshot.clone(),
            canonical_content: None,
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
            skill_snapshot_before: None,
            skill_snapshot_after: None,
            skill_runtime_before: build_replay_skill_payload_snapshot(&ctx.options),
            skill_runtime_after: build_replay_skill_payload_snapshot(&ctx.options),
            replay_source: None,
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
            ChatV2Repo::create_message_with_conn(conn, &assistant_message)?;
        } else {
            // 重试场景：更新已有的助手消息（只更新块列表和元数据）
            log::debug!(
                "[ChatV2::pipeline] Updating existing assistant message for retry: id={}",
                ctx.assistant_message_id
            );
            ChatV2Repo::update_message_with_conn(conn, &assistant_message)?;
        }

        // 保存所有助手消息块（无论是创建还是更新消息，块都需要保存）
        for mut block in blocks_to_save {
            block.block_index = final_block_positions
                .get(block.id.as_str())
                .copied()
                .unwrap_or(block.block_index);
            // 确保 message_id 正确
            block.message_id = ctx.assistant_message_id.clone();
            ChatV2Repo::create_block_with_conn(conn, &block)?;
        }

        // Re-insert preserved `anki_cards` blocks deleted by the assistant message REPLACE.
        //    🔧 修复：保持 anki_cards 块的原始 block_index，不再追加到末尾
        if !preserved_anki_cards_blocks.is_empty() {
            for preserved in preserved_anki_cards_blocks {
                // If the pipeline already has the same block id, prefer the pipeline version.
                if pipeline_block_id_set.contains(preserved.id.as_str()) {
                    continue;
                }

                let mut block_to_save = preserved;
                block_to_save.message_id = ctx.assistant_message_id.clone();
                block_to_save.block_index = final_block_positions
                    .get(block_to_save.id.as_str())
                    .copied()
                    .unwrap_or(block_to_save.block_index);

                if let Err(e) = ChatV2Repo::create_block_with_conn(conn, &block_to_save) {
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

        // 注：自动标签提取已合并至 generate_session_metadata（首轮唯一调用），
        // 不再单独触发，避免每轮 2 次 LLM 调用的浪费。
    }

    /// 触发对话后自动记忆提取（fire-and-forget）
    ///
    /// 受 mem0 `add` 和 memU `memorize` 启发：
    /// 从用户消息和助手回复中自动提取候选记忆，通过 write_smart 去重写入。
    fn trigger_auto_memory_extraction(&self, ctx: &PipelineContext) {
        self.trigger_auto_memory_extraction_for_turn(
            ctx.options.memory_enabled,
            &ctx.user_content,
            &ctx.final_content,
            &ctx.tool_results,
            "AutoMemory",
        );
    }

    /// 对话后自动记忆提取的共享实现（单变体 persistence 与 multi_variant 共用，
    /// 消除此前两处手工镜像门控逻辑的漂移风险）
    ///
    /// 门控顺序（全部在 spawn 前同步检查，避免无谓 task 创建）：
    /// 0. 会话级 memory_enabled 开关（Some(false) → 直接跳过，
    ///    与注入 prompt.rs / 工具拦截 tool_loop.rs 的会话开关语义保持一致）
    /// 1. vfs_db 存在性
    /// 2. 频率配置（off → 直接 return）
    /// 3. 隐私模式
    /// 4. 内容长度（按频率档位的字符数门槛）
    /// 5. 竞态保护（LLM 本轮已通过工具写入 fact 记忆时跳过）
    pub(crate) fn trigger_auto_memory_extraction_for_turn(
        &self,
        memory_enabled: Option<bool>,
        user_content: &str,
        assistant_content: &str,
        tool_results: &[ToolResultInfo],
        log_tag: &'static str,
    ) {
        // ⓪ 会话级开关：用户关闭记忆的会话不做任何自动提取入库
        if memory_enabled == Some(false) {
            log::debug!(
                "[{}] Session memory disabled, skipping auto-extraction",
                log_tag
            );
            return;
        }

        let vfs_db = match &self.vfs_db {
            Some(db) => db.clone(),
            None => return,
        };

        // 引用级使用信号（fire-and-forget）：答案中实际引用的 `[记忆-N]` 记 `_used`。
        // 有意放在频率/隐私门控之前——这是纯本地标签写入（无 LLM、无外部调用），
        // 即使自动提取关闭，"被引用"的使用反馈也应照常累积。
        let cited_note_ids = extract_cited_memory_note_ids(assistant_content, tool_results);
        if !cited_note_ids.is_empty() {
            let vfs_db_for_usage = vfs_db.clone();
            let llm_manager_for_usage = self.llm_manager.clone();
            let usage_log_tag = log_tag;
            tokio::task::spawn_blocking(move || {
                use crate::memory::MemoryService;
                use crate::vfs::lance_store::VfsLanceStore;
                let lance_store = match crate::chat_v2::pipeline::managed_vfs_lance_store_for(
                    &vfs_db_for_usage,
                ) {
                    Some(s) => s,
                    None => match VfsLanceStore::new(vfs_db_for_usage.clone()) {
                        Ok(s) => std::sync::Arc::new(s),
                        Err(_) => return,
                    },
                };
                let service =
                    MemoryService::new(vfs_db_for_usage, lance_store, llm_manager_for_usage);
                log::debug!(
                    "[{}] Recording citation usage for {} memories",
                    usage_log_tag,
                    cited_note_ids.len()
                );
                service.record_used(&cited_note_ids);
            });
        }

        // ① 早期门控：读取频率 + 隐私模式配置（同步 SQLite 主键查询，亚毫秒级）
        let mem_config = crate::memory::MemoryConfig::new(vfs_db.clone());
        let frequency = mem_config
            .get_auto_extract_frequency()
            .unwrap_or(crate::memory::AutoExtractFrequency::Balanced);

        if frequency == crate::memory::AutoExtractFrequency::Off {
            log::debug!("[{}] Frequency=off, skipping auto-extraction", log_tag);
            return;
        }

        if mem_config.is_privacy_mode().unwrap_or(false) {
            log::debug!(
                "[{}] Privacy mode enabled, skipping auto-extraction",
                log_tag
            );
            return;
        }

        // ② 内容长度门槛（统一使用 chars().count() 做中文友好的字符数比较）
        let min_chars = frequency.content_min_chars();
        let user_chars = user_content.chars().count();
        let assistant_chars = assistant_content.chars().count();
        if user_chars < min_chars && assistant_chars < min_chars {
            return;
        }

        // ③ 竞态保护：LLM 本轮已通过工具写入 fact 记忆时跳过
        let llm_wrote_fact_memory = tool_results.iter().any(|tr| {
            let name = tr.tool_name.as_str();
            let stripped = name.strip_prefix("builtin-").unwrap_or(name);
            match stripped {
                "memory_write" | "memory_write_smart" | "memory_update_by_id" => {
                    let declared_type = tr
                        .input
                        .get("memory_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("fact");
                    declared_type == "fact"
                }
                // 批量写入：条目级 memory_type 优先，回退到 default_memory_type
                "memory_write_batch" => {
                    let default_type = tr
                        .input
                        .get("default_memory_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("fact");
                    tr.input
                        .get("items")
                        .and_then(|v| v.as_array())
                        .map(|items| {
                            items.iter().any(|item| {
                                item.get("memory_type")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(default_type)
                                    == "fact"
                            })
                        })
                        .unwrap_or(default_type == "fact")
                }
                _ => false,
            }
        });
        if llm_wrote_fact_memory {
            log::debug!(
                "[{}] Skipping auto-extraction: LLM already wrote fact memories this turn",
                log_tag
            );
            return;
        }

        let llm_manager = self.llm_manager.clone();
        let user_content = user_content.to_string();
        let final_content = assistant_content.to_string();

        // fire-and-forget: 不走 spawn_tracked 因为 Pipeline 不持有 ChatV2State。
        tokio::spawn(async move {
            use crate::memory::{MemoryAutoExtractor, MemoryService};
            use crate::vfs::lance_store::VfsLanceStore;

            // 优先复用 app 托管单例（保留 Lance 连接与 ensured_tables 缓存）；
            // 无托管单例（启动降级/测试）时才按需新建。
            let lance_store = match crate::chat_v2::pipeline::managed_vfs_lance_store_for(&vfs_db) {
                Some(s) => s,
                None => match VfsLanceStore::new(vfs_db.clone()) {
                    Ok(s) => std::sync::Arc::new(s),
                    Err(e) => {
                        log::warn!("[{}] Failed to create lance store: {}", log_tag, e);
                        return;
                    }
                },
            };

            let memory_service =
                MemoryService::new(vfs_db.clone(), lance_store, llm_manager.clone());

            let extractor = MemoryAutoExtractor::new(llm_manager.clone());

            match extractor
                .extract_and_store(&memory_service, &user_content, &final_content)
                .await
            {
                Ok(count) => {
                    if count > 0 {
                        log::info!(
                            "[{}] Auto-extracted {} memories (frequency={:?})",
                            log_tag,
                            count,
                            frequency
                        );
                    }

                    // 分类刷新：频率档位决定刷新条件
                    if count > 0 {
                        let should_refresh = match memory_service.list(None, 500, 0) {
                            Ok(all) => {
                                let total =
                                    all.iter().filter(|m| !m.title.starts_with("__")).count();
                                frequency.should_refresh_categories(total)
                            }
                            Err(_) => false,
                        };
                        if should_refresh {
                            use crate::memory::MemoryCategoryManager;
                            let cat_mgr =
                                MemoryCategoryManager::new(vfs_db.clone(), llm_manager.clone());
                            if let Err(e) = cat_mgr.refresh_all_categories(&memory_service).await {
                                log::warn!("[{}] Category refresh failed: {}", log_tag, e);
                            }
                        }
                    }

                    // 自进化：使用共享全局节流，间隔由频率档位决定
                    use crate::memory::MemoryEvolution;
                    let evolution = MemoryEvolution::new(vfs_db);
                    evolution.run_throttled(&memory_service, frequency.evolution_interval_ms());
                }
                Err(e) => {
                    log::warn!("[{}] Auto-extraction failed (non-fatal): {}", log_tag, e);
                }
            }
        });
    }
}
