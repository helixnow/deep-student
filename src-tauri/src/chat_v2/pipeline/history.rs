use super::*;
use crate::chat_v2::types::CanonicalContentPart;

impl ChatV2Pipeline {
    /// 加载聊天历史
    ///
    /// 从数据库加载会话的历史消息，应用 context_limit 限制，
    /// 并提取 content 类型块的内容构建 LLM 对话历史。
    ///
    /// 🆕 DESIGN：单趟加载发现超预算且需要 FIFO 头删时，会先强制跑一次
    /// compaction；压缩落盘后重新加载（应用新的压缩视图）。
    /// `ctx.forced_compaction_before_trim` 保证每轮 send 至多重载一次。
    pub(crate) async fn load_chat_history(&self, ctx: &mut PipelineContext) -> ChatV2Result<()> {
        while self.load_chat_history_pass(ctx).await? {}
        Ok(())
    }

    /// 单趟历史加载。返回 `true` 表示本趟触发了「FIFO 前强制 compaction」
    /// 且压缩成功落盘，调用方（外层 while）需要整体重载以应用新压缩视图。
    async fn load_chat_history_pass(&self, ctx: &mut PipelineContext) -> ChatV2Result<bool> {
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
            return Ok(false);
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

        // 🆕 活跃 compaction 记录 id：作为 microcompact 锚点的世代（lineage）
        // 标识 —— 锚点只在它变化（= compaction 事件）时批量推进。
        let active_compaction_id =
            ChatV2Repo::get_active_compaction_with_conn(&conn, &ctx.session_id)
                .ok()
                .flatten()
                .map(|record| record.id);

        // 🆕 P1: 应用 compaction 视图 — 隐藏 tail_start 之前的原始消息，
        // 返回一条 system 摘要伪消息。原消息仍在 DB 中（供"展开原文"）。
        let (compaction_summary_msg, messages) =
            super::compaction::apply_compaction_view(&conn, &ctx.session_id, messages);

        if messages.is_empty() {
            log::debug!(
                "[ChatV2::pipeline] No chat history after excluding current messages for session={}",
                ctx.session_id
            );
            ctx.chat_history = Vec::new();
            return Ok(false);
        }

        // 🔧 P1修复：条数限制与 context_limit（token 语义）分离
        // 🔧 P1-6 修复：token 预算充裕时按预算放宽条数粗筛上限（50–400 条），
        // 精确裁剪仍由下方 trim_history_by_token_budget 按 token 完成
        let max_messages = effective_max_history_messages(ctx.options.context_limit);
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
        let active_variant_artifacts = active_variant_artifacts_by_user(&messages_to_load);

        // Wave2-A r5 #8：本趟三个技能重放门禁消费点聚合到的 digest mismatch
        // 技能 id（去重）。非空即意味着历史前缀已在这些技能位置漂移，趟末
        // 统一记录「需开新 prefix generation」信号（见循环后的记录点）。
        let mut digest_mismatch_skill_ids: Vec<String> = Vec::new();

        log::debug!(
            "[ChatV2::pipeline] Loading {} messages (max_messages={})",
            messages_to_load.len(),
            max_messages
        );

        // 转换为 LegacyChatMessage 格式
        let mut chat_history = Vec::new();
        // V20260806：最近一条 user 消息在 chat_history 中的下标。
        // workspace_injection 还原的 user 消息要插到这条消息**之前**
        // （live 时注入消息 push 在 chat_history 末尾，位于本轮 user 消息前）
        let mut last_user_message_index: Option<usize> = None;
        for message in messages_to_load {
            // 加载该消息的所有块
            let blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &message.id)?;
            // V20260806 B 层：读取重放旁路三列（列不存在/全 NULL 时为空表，
            // 下方各消费点回退旧重建路径）
            let replay_map = ChatV2Repo::get_block_replay_map_with_conn(&conn, &message.id)?;
            // 🔧 ROUND-01-pipeline #1：多变体消息只重放 active variant 的块，
            // 禁止把所有变体的 CONTENT join 在一起
            let blocks = filter_blocks_for_active_variant(&message, blocks);

            // 🔧 ROUND-01-pipeline #2：workspace_injection 块按 live 还原为
            // user 消息（live 注入位置 = 上轮历史之后、本轮 user 消息之前）
            if message.role == MessageRole::Assistant {
                restore_workspace_injection_messages(
                    &blocks,
                    &mut chat_history,
                    &mut last_user_message_index,
                );
            }

            // P1-8 技能锚定重放：按 meta.skill_injection_anchors 在冻结位置
            // 还原瞬态技能消息。只落库 id，正文取自当轮请求的
            // replay_skill_contents / skill_contents，与 live 使用同一渲染
            // 函数，字节相等 —— 使跨轮 [history][skills][userN] live == replay。
            let skill_anchors = (message.role == MessageRole::Assistant)
                .then(|| {
                    message
                        .meta
                        .as_ref()
                        .and_then(|meta| meta.skill_injection_anchors.clone())
                })
                .flatten();
            if let Some(anchors) = skill_anchors
                .as_ref()
                .filter(|anchors| !anchors.turn_skill_ids.is_empty())
            {
                // r3 digest 门禁：锚点带 digest 时校验当轮正文未漂移
                let restored = rebuild_anchored_skill_messages_gated_with_signal(
                    &anchors.turn_skill_ids,
                    ctx.options
                        .replay_skill_contents
                        .as_ref()
                        .or(ctx.options.skill_contents.as_ref()),
                    Some(anchors),
                    &mut digest_mismatch_skill_ids,
                );
                if !restored.is_empty() {
                    // live 注入点：本轮 user 消息之前（is_continue 轮为历史末尾）
                    let insert_at = if anchors.before_turn_user {
                        last_user_message_index
                            .unwrap_or(chat_history.len())
                            .min(chat_history.len())
                    } else {
                        chat_history.len()
                    };
                    let before_len = chat_history.len();
                    insert_transient_skill_messages(&mut chat_history, insert_at, restored);
                    let inserted = chat_history.len() - before_len;
                    if let Some(index) = last_user_message_index.as_mut() {
                        if insert_at <= *index {
                            *index += inserted;
                        }
                    }
                }
            }

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
                if thinking.is_empty() {
                    None
                } else {
                    Some(thinking)
                }
            } else {
                // 未被工具消费的 thinking 留给 legacy_message
                pending_thinking
            };

            // V20260806 B 层：用户消息优先取 live 发送的完整包装（llm_content 列，
            // 含 <user_query> 包装 + <injected_context>/<runtime_facts>）。
            // 列为 NULL（老数据/迁移未跑）时回退现有重建。
            let llm_content_override = (message.role == MessageRole::User)
                .then(|| {
                    blocks
                        .iter()
                        .filter(|b| b.block_type == block_types::CONTENT)
                        .find_map(|b| {
                            replay_map
                                .get(b.id.as_str())
                                .and_then(|r| r.llm_content.clone())
                        })
                })
                .flatten()
                .filter(|text| !text.is_empty());

            // 🆕 对于用户消息，解析 context_snapshot.user_refs 并将内容追加到 content
            // ★ 2025-12-10 修复：同时提取图片 base64，注入到 image_base64 字段
            let (content, vfs_image_base64) = if message.role == MessageRole::User {
                if let (Some(ref vfs_conn), Some(ref blobs_dir)) = (&vfs_conn_opt, &vfs_blobs_dir) {
                    let (resolved_content, images) = self.resolve_history_context_snapshot_v2(
                        &content, &message,
                        vfs_conn, // 解引用 PooledConnection 获取 &Connection
                        blobs_dir,
                    );
                    match llm_content_override {
                        // 字节权威：包装文本已含注入上下文文本，只保留快照解析出的图片
                        Some(llm_content) => (llm_content, images),
                        None => (resolved_content, images),
                    }
                } else {
                    (llm_content_override.unwrap_or(content), Vec::new())
                }
            } else {
                (content, Vec::new())
            };

            // 构建 LegacyChatMessage
            let role = match message.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
            };

            // P1-8：环内 load_skills 锚定批次（tool_call_id → skill_ids），
            // 在对应 tool result 消息之后按 live 顺序还原
            let mut pending_tool_anchored: Vec<crate::chat_v2::types::ToolAnchoredSkills> =
                skill_anchors
                    .as_ref()
                    .map(|anchors| anchors.tool_anchored.clone())
                    .unwrap_or_default();

            // 如果是 assistant 消息且有工具调用，先添加工具调用消息
            // 🔧 B1+B2+C1 修复：使用 tool_entries（含关联 thinking）替代 tool_blocks
            if role == "assistant" && !tool_entries.is_empty() {
                for (idx, (entry_thinking, tool_block)) in tool_entries.iter().enumerate() {
                    let replay = replay_map.get(tool_block.id.as_str());
                    // V20260806：tool_call_id / round_text / meta 回填（thought_signature、
                    // reasoning_content、Responses reasoning item）/ 检索脱敏统一在
                    // build_tool_round_messages（multi_variant 复用同一 helper）
                    let (assistant_tool_msg, tool_msg) = build_tool_round_messages(
                        message.meta.as_ref(),
                        replay,
                        tool_block,
                        entry_thinking.clone(),
                    );
                    let tool_name = tool_block.tool_name.clone().unwrap_or_default();
                    let anchor_call_id = tool_msg
                        .tool_result
                        .as_ref()
                        .map(|tr| tr.call_id.clone())
                        .unwrap_or_default();
                    chat_history.push(assistant_tool_msg);
                    chat_history.push(tool_msg);

                    // P1-8：环内加载的技能还原到该 load_skills tool result 之后
                    // （与 live 的 insert_skill_messages_after_tool_result 同位）
                    let mut still_pending = Vec::with_capacity(pending_tool_anchored.len());
                    for anchored in pending_tool_anchored.drain(..) {
                        if anchored.tool_call_id != anchor_call_id {
                            still_pending.push(anchored);
                            continue;
                        }
                        // r3 digest 门禁：tool 级锚点与 turn 级共用同一 digest map
                        let restored = rebuild_anchored_skill_messages_gated_with_signal(
                            &anchored.skill_ids,
                            ctx.options
                                .replay_skill_contents
                                .as_ref()
                                .or(ctx.options.skill_contents.as_ref()),
                            skill_anchors.as_ref(),
                            &mut digest_mismatch_skill_ids,
                        );
                        chat_history.extend(restored);
                    }
                    pending_tool_anchored = still_pending;

                    log::debug!(
                        "[ChatV2::pipeline] Loaded tool call from history: tool={}, block_type={}, block_id={}, index={}, has_thinking={}",
                        tool_name,
                        tool_block.block_type,
                        tool_block.id,
                        idx,
                        entry_thinking.is_some()
                    );
                }

                // 兜底：tool_call_id 未匹配（老数据 tc_{block_id} 派生等）时，
                // 技能仍需在该 assistant 消息的工具消息之后出现，追加到末尾
                for anchored in pending_tool_anchored.drain(..) {
                    log::warn!(
                        "[ChatV2::pipeline] P1-8: tool-anchored skills {:?} did not match any tool_call_id (anchor={}); appending after tool messages",
                        anchored.skill_ids,
                        anchored.tool_call_id
                    );
                    // r3 digest 门禁：兜底追加路径同样过门禁
                    let restored = rebuild_anchored_skill_messages_gated_with_signal(
                        &anchored.skill_ids,
                        ctx.options
                            .replay_skill_contents
                            .as_ref()
                            .or(ctx.options.skill_contents.as_ref()),
                        skill_anchors.as_ref(),
                        &mut digest_mismatch_skill_ids,
                    );
                    chat_history.extend(restored);
                }
            }

            // 🔧 P1-1 修复（07 报告）：不再对"无正文"消息一刀切跳过。
            // 之前 content 为空即 continue，导致「仅图片附件的用户消息」（附件提取
            // 逻辑在 continue 之后永远执行不到）和「仅思维链的 assistant 消息」
            // 从 LLM 上下文中静默消失。改为先提取附件/图片/文档，再综合判断有效载荷。

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

            // 🔧 P1-1 修复：仅当消息完全没有有效载荷（无正文/无图片/无文档/无思维链）
            // 时才跳过；纯附件的用户消息用占位文本保持 role 交替与 provider 兼容
            let has_thinking = thinking_content
                .as_ref()
                .is_some_and(|t| !t.trim().is_empty());
            if content.is_empty()
                && image_base64.is_none()
                && doc_attachments.is_none()
                && !has_thinking
            {
                continue;
            }

            let content = if content.is_empty() && role == "user" {
                // 仅图片/文档附件的用户消息：占位文本（图片本体通过 image_base64 /
                // doc_attachments 注入多模态请求）
                "[用户发送了附件]".to_string()
            } else {
                content
            };

            // P2-13 收尾：live 持久化的服务端 web_search_call 完整 item 挂回
            // 出站 assistant 消息 metadata（键名与 meta 持久化键一致），由
            // attach_web_search_replay_items 附着后原样回传 Responses input
            let mut history_metadata = serde_json::Map::new();
            if let Some(parts) =
                canonical_content_for_history(&message, active_variant_artifacts.get(&message.id))
            {
                history_metadata.insert("canonicalContent".to_string(), serde_json::json!(parts));
            }
            if role == "assistant" {
                if let Some(items) = message
                    .meta
                    .as_ref()
                    .and_then(|m| m.response_web_search_items.as_ref())
                    .filter(|items| !items.is_empty())
                {
                    history_metadata.insert(
                        "openai_responses_web_search_items".to_string(),
                        serde_json::json!(items),
                    );
                }
                // 无工具纯文本轮的 Responses reasoning item（哨兵键）挂回最终
                // assistant 文本消息 metadata，出站时由
                // attach_response_reasoning_replay_item 附着为消息级
                // response_reasoning_item，Responses 转换层在正文前原样回传
                if let Some(item) = message
                    .meta
                    .as_ref()
                    .and_then(|m| m.response_reasoning_items.as_ref())
                    .and_then(|items| {
                        items.get(crate::chat_v2::types::RESPONSES_FINAL_REASONING_KEY)
                    })
                {
                    history_metadata
                        .insert("openai_responses_reasoning_item".to_string(), item.clone());
                }
            }

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
                metadata: (!history_metadata.is_empty())
                    .then(|| serde_json::Value::Object(history_metadata)),
            };

            if role == "user" {
                last_user_message_index = Some(chat_history.len());
            }
            chat_history.push(legacy_message);
        }

        log::info!(
            "[ChatV2::pipeline] Loaded {} messages from history for session={}",
            chat_history.len(),
            ctx.session_id
        );

        // Wave2-A r5 #8：门禁检出 digest mismatch（重建已被 skip，历史前缀
        // 在这些技能位置已经漂移）→ 记录「需开新 prefix generation」信号。
        // 唯一写点在 `record_skill_digest_prefix_generation_signal`（helpers）：
        // 结构化计数日志 + 声明 availableSkillsSnapshotPendingGeneration
        // 待换代标记（与 compaction R4-#6 同一原语，幂等折叠），由前端
        // TauriAdapter（r5 #9）下轮 freeze 兑现换代。失败只降级打日志，
        // 不阻断本轮发送；外层 while 重跑本趟时重复调用天然幂等。
        // 详见 docs/dev/wave2-A/r5-digest-generation-signal.md。
        if !digest_mismatch_skill_ids.is_empty() {
            self.record_skill_digest_prefix_generation_signal(
                &ctx.session_id,
                &digest_mismatch_skill_ids,
            );
        }

        // 🆕 零成本前置层（microcompact）：把锚点之前的旧工具输出替换为占位符。
        // 只影响本次发给模型的视图，不动数据库；在插入 compaction summary
        // 伪消息之前执行（伪消息与瞬态注入均带 pinned 标记，天然豁免）。
        // 锚点为会话级状态，只随 compaction 事件批量推进 —— 连续多轮不
        // compaction 时历史头部字节逐字稳定，不打破 provider prompt cache。
        let eligible_turns = self.resolve_microcompact_eligible_turns(
            &ctx.session_id,
            active_compaction_id.as_deref(),
            &chat_history,
        );
        let microcompacted = microcompact_old_tool_outputs(&mut chat_history, eligible_turns);
        if microcompacted > 0 {
            log::info!(
                "[ChatV2::pipeline] Microcompact: replaced {} old tool output(s) with placeholders for session={} (anchored at {} eligible turn(s))",
                microcompacted,
                ctx.session_id,
                eligible_turns
            );
        }

        // The summary participates in the same authoritative history budget. Its pinned
        // metadata prevents FIFO removal while still forcing older tail turns to yield space.
        if let Some(summary_msg) = compaction_summary_msg {
            chat_history.insert(0, summary_msg);
        }

        // 🔧 改进 5：验证工具调用链完整性
        // 🔧 P0-2 修复：破损时就地修复（合成占位结果/丢弃孤儿），不再只 warn 后照送 LLM
        if !validate_tool_chain(&chat_history) {
            repair_tool_chain(&mut chat_history);
        }

        // 🔧 Token 预算裁剪：在条数限制基础上，按 token 预算从最旧消息开始移除
        // 🔧 P1-2 修复：context_limit 显式配置时为权威值，不再被 32K 常量 min() 钳制
        let max_tokens = effective_history_token_budget(ctx.options.context_limit);

        // 🆕 DESIGN：FIFO 头删触发前强制 compaction。头删会改写历史前缀
        // （打破 prompt cache，且抢在正确的 tail 锚定压缩之前把任务锚点清零），
        // 因此超预算时先走 compaction；只有 compaction 无法执行 / 无法回收
        // 足够预算时才允许 FIFO 头删兜底。
        if plan_history_overflow_action(
            &chat_history,
            max_tokens,
            ctx.forced_compaction_before_trim,
        ) == HistoryOverflowAction::CompactionFirst
        {
            ctx.forced_compaction_before_trim = true;
            // 在 await 前归还数据库连接（compaction 与重载会各自取连接）。
            drop(vfs_conn_opt);
            drop(conn);
            let session_id = ctx.session_id.clone();
            let model_id = ctx
                .options
                .model2_override_id
                .clone()
                .or_else(|| ctx.options.model_id.clone());
            let exclude_ids = vec![
                ctx.user_message_id.clone(),
                ctx.assistant_message_id.clone(),
            ];
            let cancellation_token = ctx.cancellation_token.clone();
            match self
                .run_compaction_for_session(
                    &session_id,
                    model_id.as_deref(),
                    "overflow",
                    &exclude_ids,
                    ctx.options.context_limit,
                    ctx.options.memory_enabled,
                    cancellation_token.as_ref(),
                )
                .await
            {
                Ok(outcome) if outcome.did_compact() => {
                    log::info!(
                        "[ChatV2::pipeline] Forced compaction before FIFO trim committed for session={}; reloading history with new compaction view",
                        session_id
                    );
                    return Ok(true);
                }
                Ok(outcome) => {
                    log::info!(
                        "[ChatV2::pipeline] Forced compaction before FIFO trim did not compact for session={} (status={}, reason={:?}); falling back to FIFO trim",
                        session_id,
                        outcome.status_code(),
                        outcome.reason_code()
                    );
                }
                Err(err) => {
                    log::warn!(
                        "[ChatV2::pipeline] Forced compaction before FIFO trim failed for session={}: {}; falling back to FIFO trim",
                        session_id,
                        err
                    );
                }
            }
        }

        let trim_outcome = trim_history_by_token_budget(&mut chat_history, max_tokens);
        // 🆕 实际丢弃了消息时挂起报告，由调用方（execute_internal / tool_loop）
        // 在拿到 emitter 的位置发射 `context_trimmed` 事件
        if trim_outcome.dropped_messages > 0 {
            ctx.pending_context_trim = Some(trim_outcome);
        }

        ctx.chat_history = chat_history;
        Ok(false)
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
                // Historical turns must be recompiled for the model active now. Old TM turns
                // often persisted OCR-only modes; carrying those forward would make TM -> MM
                // permanently lose the original image. Keep native PDF text plus original pages,
                // while OCR/visual observations are selected by context_compiler for this turn.
                for vfs_ref in &mut ref_data.refs {
                    use crate::vfs::types::{
                        ImageInjectMode, PdfInjectMode, ResourceInjectModes, VfsResourceType,
                    };
                    match vfs_ref.resource_type {
                        VfsResourceType::Image => {
                            vfs_ref.inject_modes = Some(ResourceInjectModes {
                                image: Some(vec![ImageInjectMode::Image]),
                                pdf: None,
                            });
                        }
                        VfsResourceType::File | VfsResourceType::Textbook => {
                            vfs_ref.inject_modes = Some(ResourceInjectModes {
                                image: None,
                                pdf: Some(vec![PdfInjectMode::Text, PdfInjectMode::Image]),
                            });
                        }
                        _ => {}
                    }
                }
                // Resolve original images regardless of the model used on the old turn. OCR is
                // now a text-model fallback owned by context_compiler, after this turn's model
                // capability has been frozen.
                let content =
                    resolve_context_ref_data_to_content(vfs_conn, blobs_dir, &ref_data, true);
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

/// P1-8：按锚点记录的技能 id 重建瞬态技能消息（与 live 同一渲染函数，
/// 相同正文下字节相等）。正文缺失（技能被删除且无 replay 快照）时跳过
/// 并告警 —— 该技能位置的前缀会漂移，但不阻塞重放。
///
/// 无 digest 门禁的兼容入口：等价于 `rebuild_anchored_skill_messages_gated`
/// 传 `anchors = None`（即全部走「有正文就重建」的旧行为）。保留本签名
/// 是为了 helpers.rs / skill_replay_digest_tests.rs 里既有的重放一致性与
/// 反例测试不动；生产 history 重放路径一律走门禁版。
/// 非 test 构建下本入口仅作兼容薄包装（无生产调用方），生产路径走
/// [`rebuild_anchored_skill_messages_gated_with_signal`]。
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn rebuild_anchored_skill_messages(
    skill_ids: &[String],
    skill_contents: Option<&std::collections::HashMap<String, String>>,
) -> Vec<LegacyChatMessage> {
    rebuild_anchored_skill_messages_gated(skill_ids, skill_contents, None)
}

/// Wave2-A r3：带正文 digest 门禁的锚定技能重放（生产入口）。
///
/// `anchors` 提供锚定时刻的正文 digest 查询
/// （[`crate::chat_v2::types::SkillInjectionAnchors::content_digest_for`]，
/// turn 级与 tool 级锚点共用同一 map）。逐锚点判定：
///
/// - 正文缺失（技能被删且无 replay 快照）→ warn + skip（旧行为不变）；
/// - 锚点带 digest 且正文存在：仅当
///   [`crate::chat_v2::types::skill_body_digest`]`(id, body) == stored`
///   才重建；不一致 → warn（mismatch）+ skip —— **绝不把当轮新正文
///   伪装成旧历史字节发给 provider**（既伪造历史又必然打断 prompt cache）；
/// - 旧锚点无该 skill 的 digest（含 `anchors = None` / 旧 JSON 反序列化出的
///   空 map）→ 保持旧行为，有正文就重建（向后兼容）。
///
/// skip 不阻塞其余锚点、不换序；重建命中走 live 同一渲染函数
/// `make_transient_skill_message`，字节永不漂移。digest 只读不写，
/// 技能正文本身仍不落库（`without_skill_contents` 纪律不变）。
///
/// 本签名是「无切代信号出参」的兼容入口（r3 契约与本文件内既有测试
/// 保持不动），委托给带信号版并丢弃信号。生产 history 重放路径改走
/// [`rebuild_anchored_skill_messages_gated_with_signal`]。
/// 非 test 构建下本入口仅作兼容薄包装（无生产调用方），生产路径走
/// [`rebuild_anchored_skill_messages_gated_with_signal`]。
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn rebuild_anchored_skill_messages_gated(
    skill_ids: &[String],
    skill_contents: Option<&std::collections::HashMap<String, String>>,
    anchors: Option<&crate::chat_v2::types::SkillInjectionAnchors>,
) -> Vec<LegacyChatMessage> {
    rebuild_anchored_skill_messages_gated_with_signal(
        skill_ids,
        skill_contents,
        anchors,
        &mut Vec::new(),
    )
}

/// Wave2-A r5 #8：门禁版 + 「需开新 prefix generation」信号出参
/// （生产 history 重放入口，`load_chat_history_pass` 三个消费点共用）。
///
/// 门禁判定与 [`rebuild_anchored_skill_messages_gated`] 完全一致（该
/// 入口即本函数的丢信号薄包装）；唯一新增行为：检出 digest mismatch
/// 并 skip 重建时，把该 skill_id 追加进 `mismatched_skill_ids`（去重，
/// 不改变 skip/重建结果本身）。mismatch = 历史前缀在该技能位置已经
/// 漂移且无法用旧字节修复（旧正文不存在了），调用方应在本趟结束后把
/// 聚合信号交给 `ChatV2Pipeline::record_skill_digest_prefix_generation_signal`
/// 统一记录/接线换代标记 —— 门禁本身保持纯函数，不做任何 IO。
///
/// 注意：「正文缺失」（warn+skip 的旧行为）**不**产生信号——缺正文时
/// digest 无从比较，且旧行为语义（r3 前即如此）不应触发换代；只有
/// 「锚点有 digest、正文存在但字节漂移」这一确定性证据才计入。
pub(super) fn rebuild_anchored_skill_messages_gated_with_signal(
    skill_ids: &[String],
    skill_contents: Option<&std::collections::HashMap<String, String>>,
    anchors: Option<&crate::chat_v2::types::SkillInjectionAnchors>,
    mismatched_skill_ids: &mut Vec<String>,
) -> Vec<LegacyChatMessage> {
    let mut restored = Vec::with_capacity(skill_ids.len());
    for skill_id in skill_ids {
        let Some(content) = skill_contents.and_then(|contents| contents.get(skill_id)) else {
            log::warn!(
                "[ChatV2::pipeline] P1-8: anchored skill '{}' has no content in this request; replay prefix may drift at its position",
                skill_id
            );
            continue;
        };
        if let Some(stored) = anchors.and_then(|a| a.content_digest_for(skill_id)) {
            let current = crate::chat_v2::types::skill_body_digest(skill_id, content);
            if current != stored {
                log::warn!(
                    "[ChatV2::pipeline] P1-8: anchored skill '{}' content digest mismatch (anchored={}, current={}); skipping rebuild instead of forging history with the edited body — replay prefix will drift at its position",
                    skill_id,
                    stored,
                    current
                );
                // r5 #8：同一 skill 可能在多个锚点（turn 级 + 多个 tool 级）
                // 重复 mismatch，信号按 skill_id 去重。
                if !mismatched_skill_ids.iter().any(|id| id == skill_id) {
                    mismatched_skill_ids.push(skill_id.clone());
                }
                continue;
            }
        }
        restored.push(make_transient_skill_message(skill_id, content));
    }
    restored
}

/// 🔧 ROUND-01-pipeline #1：按 active_variant_id 过滤多变体消息的块
///
/// 只丢弃「属于某个非活跃变体」的块；不归任何变体所有的共享块
/// （检索 / workspace_injection 等）保留。无变体消息原样返回。
/// active_variant_id 缺失或悬空时 `get_active_block_ids` 回退到
/// message.block_ids（含全部块），等价于旧行为。
pub(super) fn filter_blocks_for_active_variant(
    message: &ChatMessage,
    blocks: Vec<MessageBlock>,
) -> Vec<MessageBlock> {
    let Some(variants) = message.variants.as_ref().filter(|v| !v.is_empty()) else {
        return blocks;
    };
    let variant_owned: std::collections::HashSet<&str> = variants
        .iter()
        .flat_map(|v| v.block_ids.iter().map(|s| s.as_str()))
        .collect();
    let active: std::collections::HashSet<&str> = message
        .get_active_block_ids()
        .iter()
        .map(|s| s.as_str())
        .collect();
    blocks
        .into_iter()
        .filter(|b| !variant_owned.contains(b.id.as_str()) || active.contains(b.id.as_str()))
        .collect()
}

/// 🔧 ROUND-01-pipeline #2：workspace_injection 块还原为 live 形态的 user 消息
///
/// 与 `PipelineContext::inject_workspace_messages` 的构造保持一致
/// （role=user、metadata 携带 workspace_injection/workspace_id），
/// 保证下一轮 LLM 视角里注入不消失且字节形态与 live 相同。
pub(super) fn build_workspace_injection_user_message(
    formatted: String,
    injection_meta: Option<&serde_json::Value>,
) -> LegacyChatMessage {
    let workspace_id = injection_meta
        .and_then(|meta| meta.get("workspace_id"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    LegacyChatMessage {
        role: "user".to_string(),
        content: formatted,
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
        tool_result: None,
        overrides: None,
        relations: None,
        persistent_stable_id: None,
        metadata: Some(serde_json::json!({
            "workspace_injection": true,
            "workspace_id": workspace_id,
        })),
    }
}

/// 🔧 ROUND-01-pipeline #2：把 assistant 消息里的 workspace_injection 块
/// 逐个还原为 live 形态的 user 消息，插到本轮 user 消息（`last_user_message_index`）
/// 之前；插入后同步右移下标。单变体 `load_chat_history` 与
/// `load_variant_chat_history` 共用，保证两条路径重放字节一致。
pub(super) fn restore_workspace_injection_messages(
    blocks: &[MessageBlock],
    chat_history: &mut Vec<LegacyChatMessage>,
    last_user_message_index: &mut Option<usize>,
) {
    for block in blocks
        .iter()
        .filter(|b| b.block_type == block_types::WORKSPACE_INJECTION)
    {
        let Some(text) = block.content.clone().filter(|t| !t.is_empty()) else {
            continue;
        };
        let injected = build_workspace_injection_user_message(text, block.tool_output.as_ref());
        let insert_at = last_user_message_index
            .unwrap_or(chat_history.len())
            .min(chat_history.len());
        chat_history.insert(insert_at, injected);
        if let Some(index) = last_user_message_index.as_mut() {
            *index += 1;
        }
    }
}

/// V20260806：单个工具块还原为 live 形态的 `(assistant(tool_call), tool)` 消息对。
///
/// 统一承载重放旁路与 meta 回填逻辑，单变体 `load_chat_history` 与
/// `load_variant_chat_history` 共用（禁止两处各自复制）：
/// - tool_call_id：优先 live 持久化的 provider 原始 id，NULL 回退 tc_{block_id} 派生
/// - round_text：该轮工具调用前的伴随文本（text-before-tool-use）
/// - meta.tool_results 回填：thought_signature + reasoning_content
///   （meta 缺失时 thinking 回退调用方传入的 `entry_thinking`）
/// - meta.response_reasoning_items 回填：Responses reasoning item 挂 metadata 原样回传
/// - 成功的检索工具输出走 `sanitize_retrieval_output_for_llm`（live/重放字节一致）
pub(super) fn build_tool_round_messages(
    message_meta: Option<&MessageMeta>,
    replay: Option<&crate::chat_v2::repo::BlockReplayData>,
    tool_block: &MessageBlock,
    entry_thinking: Option<String>,
) -> (LegacyChatMessage, LegacyChatMessage) {
    let tool_call_id = replay
        .and_then(|r| r.tool_call_id.clone())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| format!("tc_{}", tool_block.id.replace("blk_", "")));
    let round_text = replay
        .and_then(|r| r.round_text.clone())
        .unwrap_or_default();

    // meta 回填：按 block_id 或 tool_call_id 匹配 live 工具结果
    let meta_tool_results: &[ToolResultInfo] = message_meta
        .and_then(|m| m.tool_results.as_deref())
        .unwrap_or(&[]);
    let meta_result = meta_tool_results.iter().find(|r| {
        r.block_id.as_deref() == Some(tool_block.id.as_str())
            || r.tool_call_id.as_deref() == Some(tool_call_id.as_str())
    });
    let thought_signature = meta_result.and_then(|r| r.thought_signature.clone());
    // live 的 assistant(tool_call) 消息 thinking = 该轮 reasoning_content；
    // meta 缺失时回退块重建的 entry_thinking
    let thinking_for_replay = meta_result
        .and_then(|r| r.reasoning_content.clone())
        .or(entry_thinking);
    // Responses reasoning item 原样回传（与 tool_results_to_messages_impl
    // 的 live 形态一致），跨轮不丢 encrypted reasoning
    let reasoning_item_metadata = message_meta
        .and_then(|m| m.response_reasoning_items.as_ref())
        .and_then(|items| items.get(tool_call_id.as_str()))
        .map(|item| serde_json::json!({ "openai_responses_reasoning_item": item.clone() }));

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

    // 1. assistant 消息（包含 tool_call）
    // 🔧 C1修复：携带关联的 thinking_content，用于 merge 边界检测
    let tool_call = crate::models::ToolCall {
        id: tool_call_id.clone(),
        tool_name: tool_name.clone(),
        args_json: tool_input,
    };
    let assistant_tool_msg = LegacyChatMessage {
        role: "assistant".to_string(),
        content: round_text,
        timestamp: chrono::Utc::now(),
        thinking_content: thinking_for_replay,
        thought_signature,
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
        metadata: reasoning_item_metadata,
    };

    // 2. tool 消息（包含 tool_result）
    // 🔧 与 context.rs tool_results_to_messages_impl 保持一致：
    // 失败时优先使用 error 信息，让 LLM 知道失败原因；
    // 成功的检索工具输出走同一份 LLM 视图脱敏（live/重放字节一致）
    let tool_content = if tool_success {
        match crate::chat_v2::context::sanitize_retrieval_output_for_llm(&tool_name, &tool_output) {
            Some(sanitized) => serde_json::to_string(&sanitized).unwrap_or_default(),
            None => serde_json::to_string(&tool_output).unwrap_or_default(),
        }
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

    (assistant_tool_msg, tool_msg)
}

pub(super) fn active_variant_artifacts_by_user(
    messages: &[ChatMessage],
) -> std::collections::HashMap<String, Vec<CanonicalContentPart>> {
    let mut result = std::collections::HashMap::new();
    for pair in messages.windows(2) {
        let [user, assistant] = pair else {
            continue;
        };
        if user.role != MessageRole::User || assistant.role != MessageRole::Assistant {
            continue;
        }
        let Some(artifacts) = assistant
            .get_active_variant()
            .and_then(|variant| variant.meta.as_ref())
            .and_then(|meta| meta.canonical_artifacts.as_ref())
            .filter(|artifacts| !artifacts.is_empty())
        else {
            continue;
        };
        result.insert(user.id.clone(), artifacts.clone());
    }
    result
}

pub(super) fn canonical_content_for_history(
    message: &ChatMessage,
    active_variant_artifacts: Option<&Vec<CanonicalContentPart>>,
) -> Option<Vec<CanonicalContentPart>> {
    let mut canonical = message
        .meta
        .as_ref()
        .and_then(|meta| meta.canonical_content.clone())
        .unwrap_or_default();
    if let Some(active_artifacts) = active_variant_artifacts {
        // Older builds promoted the then-active artifacts onto the user message. Strip those
        // before adding the currently active variant so switching variants is immediately real.
        canonical.retain(|part| !matches!(part, CanonicalContentPart::DerivedArtifactRef { .. }));
        canonical.extend(active_artifacts.iter().cloned());
    }
    (!canonical.is_empty()).then_some(canonical)
}

/// 🔧 B1+B2 修复：判断一个 block 是否是 LLM 发起的工具调用块
///
/// 条件：
/// 1. block_type 是已知的工具类型之一（MCP_TOOL, ASK_USER, MEMORY 等）
/// 2. tool_name 已设置（区分 LLM 工具调用 vs 预检索结果块）
///    预检索块（如 RAG 检索）也使用 RAG/MEMORY/WEB_SEARCH 类型，
///    但没有 tool_name，因此被正确排除。
pub(super) fn is_tool_call_block(block: &MessageBlock) -> bool {
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
            // ACR R2-05：workbench_ops 亦为 LLM 工具调用块，需进入历史 tool 回放
            | block_types::WORKBENCH_OPS
    );
    is_tool_type && block.tool_name.is_some()
}

// ============================================================
// Wave2-A r3：digest 门禁单元测试（只写不跑，行为对齐
// skill_replay_digest_tests.rs 的契约副本）
// ============================================================

#[cfg(test)]
mod skill_replay_gate_tests {
    use super::*;
    use crate::chat_v2::types::{skill_body_digest, SkillInjectionAnchors};
    use std::collections::HashMap;

    fn anchors_with_digests(entries: &[(&str, &str)]) -> SkillInjectionAnchors {
        SkillInjectionAnchors {
            skill_content_digests: entries
                .iter()
                .map(|(id, body)| (id.to_string(), skill_body_digest(id, body)))
                .collect(),
            ..Default::default()
        }
    }

    fn contents_map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(id, body)| (id.to_string(), body.to_string()))
            .collect()
    }

    /// digest 不一致（正文被编辑）→ skip，不得把新正文伪装成旧历史；
    /// digest 一致 → 与 live 渲染同字节；skip 不阻塞其余锚点、不换序。
    #[test]
    fn gate_skips_mismatch_and_rebuilds_match_in_anchor_order() {
        let anchors =
            anchors_with_digests(&[("skill-a", "正文 A（未改）"), ("skill-b", "正文 B v1")]);
        let ids = vec!["skill-a".to_string(), "skill-b".to_string()];
        // 当轮请求携带的 skill-b 正文已被编辑为 v2
        let contents = contents_map(&[("skill-a", "正文 A（未改）"), ("skill-b", "正文 B v2")]);

        let restored = rebuild_anchored_skill_messages_gated(&ids, Some(&contents), Some(&anchors));
        assert_eq!(restored.len(), 1, "漂移的 skill-b 必须被 skip");
        let live = make_transient_skill_message("skill-a", "正文 A（未改）");
        assert_eq!(restored[0].role, live.role);
        assert_eq!(restored[0].content, live.content);
        assert_eq!(restored[0].metadata, live.metadata);
    }

    /// 旧锚点（无 digest 字段 / 该 skill 无 digest 记录）→ 保持旧行为：
    /// 有正文就重建；正文缺失仍 warn+skip。二参兼容入口 == 门禁版传 None。
    #[test]
    fn legacy_anchor_without_digest_keeps_old_rebuild_behavior() {
        let ids = vec!["skill-old".to_string(), "skill-ghost".to_string()];
        let contents = contents_map(&[("skill-old", "旧锚点正文")]);

        // 旧 JSON 反序列化出的锚点：digest map 为空
        let legacy_anchors = SkillInjectionAnchors::default();
        let gated =
            rebuild_anchored_skill_messages_gated(&ids, Some(&contents), Some(&legacy_anchors));
        assert_eq!(gated.len(), 1, "无 digest → 有正文就重建（兼容旧锚点）");
        assert_eq!(
            gated[0].content,
            make_transient_skill_message("skill-old", "旧锚点正文").content
        );

        // 二参兼容入口与门禁版传 None 输出一致
        let ungated = rebuild_anchored_skill_messages(&ids, Some(&contents));
        assert_eq!(ungated.len(), gated.len());
        assert_eq!(ungated[0].content, gated[0].content);

        // 正文缺失（skill-ghost）在两条路径都被 skip，不阻塞重放
        assert!(
            rebuild_anchored_skill_messages_gated(&ids, None, Some(&legacy_anchors)).is_empty()
        );
    }

    /// r5 #8：只有「有 digest 且正文漂移」计入切代信号；digest 命中、
    /// 旧锚点无 digest、正文缺失三种情形都不产生信号；同一 skill 跨
    /// 多锚点重复 mismatch 去重；信号出参不改变 skip/重建结果本身
    /// （与无信号兼容入口输出逐字节一致）。
    #[test]
    fn gate_signal_collects_only_digest_mismatches_deduped() {
        let anchors = anchors_with_digests(&[("skill-ok", "正文未改"), ("skill-drift", "正文 v1")]);
        let ids = vec![
            "skill-ok".to_string(),
            "skill-drift".to_string(),
            "skill-missing".to_string(), // 正文缺失：warn+skip，但不进信号
        ];
        let contents = contents_map(&[("skill-ok", "正文未改"), ("skill-drift", "正文 v2")]);

        let mut signal: Vec<String> = Vec::new();
        let restored = rebuild_anchored_skill_messages_gated_with_signal(
            &ids,
            Some(&contents),
            Some(&anchors),
            &mut signal,
        );
        assert_eq!(restored.len(), 1, "只有 digest 命中的 skill-ok 重建");
        assert_eq!(
            restored[0].content,
            make_transient_skill_message("skill-ok", "正文未改").content
        );
        assert_eq!(
            signal,
            vec!["skill-drift".to_string()],
            "只有确定性 digest 漂移进信号；正文缺失/命中不进"
        );

        // 同一 skill 第二个锚点（tool 级）再次 mismatch：去重不重复累计
        let restored_again = rebuild_anchored_skill_messages_gated_with_signal(
            &["skill-drift".to_string()],
            Some(&contents),
            Some(&anchors),
            &mut signal,
        );
        assert!(restored_again.is_empty());
        assert_eq!(signal, vec!["skill-drift".to_string()], "跨锚点去重");

        // 旧锚点（无 digest）永不产生信号
        let mut legacy_signal: Vec<String> = Vec::new();
        rebuild_anchored_skill_messages_gated_with_signal(
            &ids,
            Some(&contents),
            Some(&SkillInjectionAnchors::default()),
            &mut legacy_signal,
        );
        assert!(legacy_signal.is_empty(), "无 digest 的旧锚点不触发换代信号");

        // 兼容入口（丢信号）与带信号版输出一致
        let ungated = rebuild_anchored_skill_messages_gated(&ids, Some(&contents), Some(&anchors));
        assert_eq!(ungated.len(), restored.len());
        assert_eq!(ungated[0].content, restored[0].content);
    }
}

// ============================================================
// V20260806 prompt_cache_replay_consistency 测试基建
// （pub(super)：history 与 multi_variant 的回放测试共用）
// ============================================================

#[cfg(test)]
pub(super) mod replay_test_support {
    use super::*;
    use crate::chat_v2::types::SendMessageRequest;
    use std::sync::Arc;

    /// 构建带完整迁移（含 V20260806 三列）的真实 ChatV2Pipeline
    pub(in crate::chat_v2::pipeline) fn replay_test_pipeline() -> (tempfile::TempDir, ChatV2Pipeline)
    {
        use crate::chat_v2::database::ChatV2Database;
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;
        use crate::database::Database;
        use crate::file_manager::FileManager;
        use crate::llm_manager::LLMManager;
        use crate::tools::ToolRegistry;

        let chat_dir = tempfile::TempDir::new().expect("chat temp");
        let mut coordinator =
            MigrationCoordinator::new(chat_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("chat_v2 migrate");
        let chat_db = Arc::new(ChatV2Database::new(chat_dir.path()).expect("chat db"));

        let main_dir = tempfile::TempDir::new().expect("main temp");
        let mut main_coordinator =
            MigrationCoordinator::new(main_dir.path().to_path_buf()).with_audit_db(None);
        main_coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("main migrate");
        let main_db =
            Arc::new(Database::new(&main_dir.path().join("mistakes.db")).expect("main db"));
        let file_manager =
            Arc::new(FileManager::new(main_dir.path().join("app-data")).expect("file manager"));
        let llm_manager =
            Arc::new(LLMManager::new(main_db.clone(), file_manager).expect("llm manager"));

        let pipeline = ChatV2Pipeline::new(
            chat_db,
            Some(main_db),
            None,
            None,
            llm_manager,
            Arc::new(ToolRegistry::new()),
            None,
        );
        // Keep main temp dir alive for the duration of the test.
        std::mem::forget(main_dir);
        (chat_dir, pipeline)
    }

    /// 新一轮请求的 PipelineContext（当前消息 id 与历史消息不同，
    /// 避免被 load_chat_history 的当前消息排除逻辑吃掉）
    pub(in crate::chat_v2::pipeline) fn next_turn_ctx(session_id: &str) -> PipelineContext {
        PipelineContext::new(SendMessageRequest {
            session_id: session_id.to_string(),
            content: "下一轮问题".to_string(),
            options: None,
            user_message_id: Some("msg_current_user".to_string()),
            assistant_message_id: Some("msg_current_assistant".to_string()),
            user_context_refs: None,
            path_map: None,
            workspace_id: None,
        })
    }

    pub(in crate::chat_v2::pipeline) fn insert_user_turn(
        conn: &rusqlite::Connection,
        session_id: &str,
        message_id: &str,
        block_id: &str,
        raw_content: &str,
        timestamp: i64,
    ) {
        let mut user_msg =
            ChatMessage::new_user(session_id.to_string(), vec![block_id.to_string()]);
        user_msg.id = message_id.to_string();
        user_msg.timestamp = timestamp;
        ChatV2Repo::create_message_with_conn(conn, &user_msg).unwrap();
        let mut user_block = MessageBlock::new_content(message_id.to_string(), 0);
        user_block.id = block_id.to_string();
        user_block.content = Some(raw_content.to_string());
        user_block.status = block_status::SUCCESS.to_string();
        ChatV2Repo::create_block_with_conn(conn, &user_block).unwrap();
    }

    pub(in crate::chat_v2::pipeline) fn content_block(
        message_id: &str,
        block_id: &str,
        text: &str,
        block_index: u32,
    ) -> MessageBlock {
        let mut block = MessageBlock::new_content(message_id.to_string(), block_index);
        block.id = block_id.to_string();
        block.content = Some(text.to_string());
        block.status = block_status::SUCCESS.to_string();
        block
    }
}

// ============================================================
// V20260806 prompt_cache_replay_consistency 单元测试
// ============================================================

#[cfg(test)]
mod replay_consistency_tests {
    use super::replay_test_support::*;
    use super::*;
    use crate::chat_v2::repo::BlockReplayData;
    use crate::chat_v2::types::{ChatSession, MessageMeta, SendMessageRequest, Variant};
    use std::collections::HashMap;

    /// 要求 9 主测试：live 写入三列后，history 读回与 live 请求字节相等
    /// （用户包装 / provider tool_call_id / round_text / thought_signature /
    /// Responses reasoning item 全部对齐 `tool_results_to_messages_impl` 的 live 形态）
    #[tokio::test]
    async fn replay_uses_sidecar_columns_and_matches_live_bytes() {
        let (_dir, pipeline) = replay_test_pipeline();
        let conn = pipeline.db.get_conn_safe().unwrap();
        let session_id = "sess_replay_hist";
        ChatV2Repo::create_session_with_conn(
            &conn,
            &ChatSession::new(session_id.to_string(), "chat".to_string()),
        )
        .unwrap();

        // ---- 上一轮用户消息：DB 存裸文本，llm_content 列存 live 完整包装 ----
        insert_user_turn(
            &conn,
            session_id,
            "msg_hist_u1",
            "blk_hist_u1",
            "帮我读一下笔记",
            1_000,
        );
        let live_user_content = "<user_query>\n帮我读一下笔记\n</user_query>\n\n<injected_context>\n<runtime_facts>\n当前日期: 2026-08-23\n</runtime_facts>\n</injected_context>";
        ChatV2Repo::update_block_replay_with_conn(
            &conn,
            "blk_hist_u1",
            &BlockReplayData {
                llm_content: Some(live_user_content.to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        // ---- 上一轮助手消息：thinking + tool + content，meta 带 live 工具轮数据 ----
        let reasoning_item = serde_json::json!({"type": "reasoning", "id": "rs_live_1"});
        let live_tool_result = ToolResultInfo {
            tool_call_id: Some("call_live_123".to_string()),
            block_id: Some("blk_hist_tool".to_string()),
            tool_name: "builtin-note_read".to_string(),
            input: serde_json::json!({"id": "n1"}),
            output: serde_json::json!({"ok": true, "text": "笔记内容"}),
            success: true,
            error: None,
            duration_ms: Some(5),
            reasoning_content: Some("先读笔记再回答".to_string()),
            thought_signature: Some("sig-live-1".to_string()),
        };
        let mut assistant_msg = ChatMessage::new_assistant(session_id.to_string());
        assistant_msg.id = "msg_hist_a1".to_string();
        assistant_msg.timestamp = 2_000;
        assistant_msg.block_ids = vec![
            "blk_hist_think".to_string(),
            "blk_hist_tool".to_string(),
            "blk_hist_c1".to_string(),
        ];
        assistant_msg.meta = Some(MessageMeta {
            tool_results: Some(vec![live_tool_result.clone()]),
            response_reasoning_items: Some(HashMap::from([(
                "call_live_123".to_string(),
                reasoning_item.clone(),
            )])),
            ..Default::default()
        });
        ChatV2Repo::create_message_with_conn(&conn, &assistant_msg).unwrap();

        let mut thinking_block = MessageBlock::new_thinking("msg_hist_a1".to_string(), 0);
        thinking_block.id = "blk_hist_think".to_string();
        thinking_block.content = Some("先读笔记再回答".to_string());
        thinking_block.status = block_status::SUCCESS.to_string();
        ChatV2Repo::create_block_with_conn(&conn, &thinking_block).unwrap();

        let mut tool_block = MessageBlock::new_tool(
            "msg_hist_a1".to_string(),
            "builtin-note_read",
            live_tool_result.input.clone(),
            1,
        );
        tool_block.id = "blk_hist_tool".to_string();
        tool_block.status = block_status::SUCCESS.to_string();
        tool_block.tool_output = Some(live_tool_result.output.clone());
        ChatV2Repo::create_block_with_conn(&conn, &tool_block).unwrap();
        ChatV2Repo::update_block_replay_with_conn(
            &conn,
            "blk_hist_tool",
            &BlockReplayData {
                llm_content: None,
                tool_call_id: Some("call_live_123".to_string()),
                round_text: Some("我先读一下笔记。".to_string()),
            },
        )
        .unwrap();

        ChatV2Repo::create_block_with_conn(
            &conn,
            &content_block("msg_hist_a1", "blk_hist_c1", "笔记里说……", 2),
        )
        .unwrap();
        drop(conn);

        // ---- 跨轮重放 ----
        let mut ctx = next_turn_ctx(session_id);
        pipeline.load_chat_history(&mut ctx).await.unwrap();
        assert_eq!(ctx.chat_history.len(), 4, "user + tool_call + tool + final");

        // 1) 用户消息 = live 发送的完整包装（字节相等）
        assert_eq!(ctx.chat_history[0].role, "user");
        assert_eq!(ctx.chat_history[0].content, live_user_content);

        // 2) 工具轮与 live 形态字节对齐（同一数据走 live 的
        //    all_tool_results_to_messages 构建作为基准）
        let mut live_ctx = next_turn_ctx(session_id);
        live_ctx.tool_results = vec![live_tool_result];
        live_ctx
            .round_text_by_tool_call_id
            .insert("call_live_123".to_string(), "我先读一下笔记。".to_string());
        live_ctx
            .response_reasoning_by_tool_call_id
            .insert("call_live_123".to_string(), reasoning_item);
        let live_msgs = live_ctx.all_tool_results_to_messages();
        assert_eq!(live_msgs.len(), 2);

        let replayed_call = &ctx.chat_history[1];
        let live_call = &live_msgs[0];
        assert_eq!(replayed_call.role, live_call.role);
        assert_eq!(replayed_call.content, live_call.content);
        assert_eq!(replayed_call.thinking_content, live_call.thinking_content);
        assert_eq!(replayed_call.thought_signature, live_call.thought_signature);
        assert_eq!(replayed_call.metadata, live_call.metadata);
        let replayed_tc = replayed_call.tool_call.as_ref().unwrap();
        let live_tc = live_call.tool_call.as_ref().unwrap();
        assert_eq!(replayed_tc.id, live_tc.id);
        assert_eq!(replayed_tc.id, "call_live_123", "禁止 tc_{{block_id}} 派生");
        assert_eq!(replayed_tc.tool_name, live_tc.tool_name);
        assert_eq!(replayed_tc.args_json, live_tc.args_json);

        let replayed_tool = &ctx.chat_history[2];
        let live_tool = &live_msgs[1];
        assert_eq!(replayed_tool.role, live_tool.role);
        assert_eq!(replayed_tool.content, live_tool.content);
        assert_eq!(
            replayed_tool.tool_result.as_ref().unwrap().call_id,
            live_tool.tool_result.as_ref().unwrap().call_id
        );

        // 3) 末尾正文
        assert_eq!(ctx.chat_history[3].role, "assistant");
        assert_eq!(ctx.chat_history[3].content, "笔记里说……");
    }

    /// 回归：无工具纯文本轮 —— 上一 assistant 消息 meta 中哨兵键下的
    /// Responses reasoning item 在下一轮重放时挂回该 assistant 消息的
    /// metadata（openai_responses_reasoning_item），保证下一轮 input 仍含
    /// 上一 assistant 的 encrypted reasoning。
    #[tokio::test]
    async fn replay_attaches_final_reasoning_item_to_plain_assistant_message() {
        use crate::chat_v2::types::RESPONSES_FINAL_REASONING_KEY;

        let (_dir, pipeline) = replay_test_pipeline();
        let conn = pipeline.db.get_conn_safe().unwrap();
        let session_id = "sess_replay_final_reasoning";
        ChatV2Repo::create_session_with_conn(
            &conn,
            &ChatSession::new(session_id.to_string(), "chat".to_string()),
        )
        .unwrap();

        insert_user_turn(
            &conn,
            session_id,
            "msg_fr_u1",
            "blk_fr_u1",
            "随便聊聊",
            1_000,
        );

        // 上一轮 assistant：纯文本（无工具块），meta 哨兵键存 reasoning item
        let reasoning_item = serde_json::json!({
            "type": "reasoning",
            "id": "rs_final_1",
            "encrypted_content": "enc-final-state"
        });
        let mut assistant_msg = ChatMessage::new_assistant(session_id.to_string());
        assistant_msg.id = "msg_fr_a1".to_string();
        assistant_msg.timestamp = 2_000;
        assistant_msg.block_ids = vec!["blk_fr_c1".to_string()];
        assistant_msg.meta = Some(MessageMeta {
            response_reasoning_items: Some(HashMap::from([(
                RESPONSES_FINAL_REASONING_KEY.to_string(),
                reasoning_item.clone(),
            )])),
            ..Default::default()
        });
        ChatV2Repo::create_message_with_conn(&conn, &assistant_msg).unwrap();
        ChatV2Repo::create_block_with_conn(
            &conn,
            &content_block("msg_fr_a1", "blk_fr_c1", "这是纯文本回答。", 0),
        )
        .unwrap();
        drop(conn);

        let mut ctx = next_turn_ctx(session_id);
        pipeline.load_chat_history(&mut ctx).await.unwrap();
        assert_eq!(ctx.chat_history.len(), 2, "user + 纯文本 assistant");

        let replayed_assistant = &ctx.chat_history[1];
        assert_eq!(replayed_assistant.role, "assistant");
        assert_eq!(replayed_assistant.content, "这是纯文本回答。");
        assert!(
            replayed_assistant.tool_call.is_none(),
            "纯文本轮不应重建 tool_call"
        );
        let metadata = replayed_assistant
            .metadata
            .as_ref()
            .expect("纯文本 assistant 应携带 metadata");
        assert_eq!(
            metadata.get("openai_responses_reasoning_item"),
            Some(&reasoning_item),
            "哨兵键下的 reasoning item 应挂回 assistant metadata 供下一轮回传"
        );
    }

    /// 要求 9 回退测试：三列为 NULL（老数据）时保持旧重建
    /// （裸文本 + tc_{block_id} 派生 + 空 round_text），不 panic 不丢消息
    #[tokio::test]
    async fn replay_falls_back_to_legacy_rebuild_without_sidecar_data() {
        let (_dir, pipeline) = replay_test_pipeline();
        let conn = pipeline.db.get_conn_safe().unwrap();
        let session_id = "sess_replay_fallback";
        ChatV2Repo::create_session_with_conn(
            &conn,
            &ChatSession::new(session_id.to_string(), "chat".to_string()),
        )
        .unwrap();

        insert_user_turn(
            &conn,
            session_id,
            "msg_fb_u1",
            "blk_fb_u1",
            "原始问题",
            1_000,
        );

        let mut assistant_msg = ChatMessage::new_assistant(session_id.to_string());
        assistant_msg.id = "msg_fb_a1".to_string();
        assistant_msg.timestamp = 2_000;
        assistant_msg.block_ids = vec!["blk_fb_tool".to_string(), "blk_fb_c1".to_string()];
        ChatV2Repo::create_message_with_conn(&conn, &assistant_msg).unwrap();

        let mut tool_block = MessageBlock::new_tool(
            "msg_fb_a1".to_string(),
            "builtin-note_read",
            serde_json::json!({"id": "n2"}),
            0,
        );
        tool_block.id = "blk_fb_tool".to_string();
        tool_block.status = block_status::SUCCESS.to_string();
        tool_block.tool_output = Some(serde_json::json!({"ok": true}));
        ChatV2Repo::create_block_with_conn(&conn, &tool_block).unwrap();
        ChatV2Repo::create_block_with_conn(
            &conn,
            &content_block("msg_fb_a1", "blk_fb_c1", "回答", 1),
        )
        .unwrap();
        drop(conn);

        let mut ctx = next_turn_ctx(session_id);
        pipeline.load_chat_history(&mut ctx).await.unwrap();
        assert_eq!(ctx.chat_history.len(), 4);
        // 用户消息回退为裸文本（无 llm_content 列数据）
        assert_eq!(ctx.chat_history[0].content, "原始问题");
        // tool_call_id 回退为 tc_{block_id} 派生，round_text 回退为空
        let tool_call = ctx.chat_history[1].tool_call.as_ref().unwrap();
        assert_eq!(tool_call.id, "tc_fb_tool");
        assert_eq!(ctx.chat_history[1].content, "");
        assert_eq!(
            ctx.chat_history[2].tool_result.as_ref().unwrap().call_id,
            "tc_fb_tool"
        );
    }

    /// ROUND-01-pipeline #1：多变体消息只重放 active variant 的块，
    /// 不再把所有变体 CONTENT join 在一起；切换活跃变体即改变重放字节
    #[tokio::test]
    async fn replay_filters_blocks_to_active_variant() {
        let (_dir, pipeline) = replay_test_pipeline();
        let conn = pipeline.db.get_conn_safe().unwrap();
        let session_id = "sess_replay_variant";
        ChatV2Repo::create_session_with_conn(
            &conn,
            &ChatSession::new(session_id.to_string(), "chat".to_string()),
        )
        .unwrap();

        insert_user_turn(
            &conn,
            session_id,
            "msg_var_u1",
            "blk_var_u1",
            "多模型对比",
            1_000,
        );

        let make_variant = |id: &str, block_id: &str| {
            let mut variant = Variant::new(format!("model-{}", id));
            variant.id = id.to_string();
            variant.block_ids = vec![block_id.to_string()];
            variant.status = crate::chat_v2::types::variant_status::SUCCESS.to_string();
            variant
        };
        let mut assistant_msg = ChatMessage::new_assistant(session_id.to_string());
        assistant_msg.id = "msg_var_a1".to_string();
        assistant_msg.timestamp = 2_000;
        assistant_msg.block_ids = vec!["blk_var_a".to_string(), "blk_var_b".to_string()];
        assistant_msg.variants = Some(vec![
            make_variant("var_1", "blk_var_a"),
            make_variant("var_2", "blk_var_b"),
        ]);
        assistant_msg.active_variant_id = Some("var_2".to_string());
        ChatV2Repo::create_message_with_conn(&conn, &assistant_msg).unwrap();

        ChatV2Repo::create_block_with_conn(
            &conn,
            &content_block("msg_var_a1", "blk_var_a", "A 变体回答", 0),
        )
        .unwrap();
        ChatV2Repo::create_block_with_conn(
            &conn,
            &content_block("msg_var_a1", "blk_var_b", "B 变体回答", 1),
        )
        .unwrap();
        drop(conn);

        let mut ctx = next_turn_ctx(session_id);
        pipeline.load_chat_history(&mut ctx).await.unwrap();
        assert_eq!(ctx.chat_history.len(), 2);
        assert_eq!(
            ctx.chat_history[1].content, "B 变体回答",
            "只应包含 active variant 的 CONTENT，禁止 join 全部变体"
        );
    }

    /// P2-13 收尾：assistant 消息 meta 持久化的服务端 web_search_call 完整
    /// item 在 history 重放时挂回出站 assistant 消息 metadata
    /// （键 openai_responses_web_search_items），供 Responses 转换层原样回传 input
    #[tokio::test]
    async fn replay_attaches_web_search_items_from_meta() {
        let (_dir, pipeline) = replay_test_pipeline();
        let conn = pipeline.db.get_conn_safe().unwrap();
        let session_id = "sess_replay_ws";
        ChatV2Repo::create_session_with_conn(
            &conn,
            &ChatSession::new(session_id.to_string(), "chat".to_string()),
        )
        .unwrap();

        insert_user_turn(
            &conn,
            session_id,
            "msg_ws_u1",
            "blk_ws_u1",
            "今天有什么新闻",
            1_000,
        );

        let web_search_item = serde_json::json!({
            "type": "web_search_call",
            "id": "ws_live_1",
            "status": "completed",
            "search_results": [{ "url": "https://a.example.com", "title": "A" }]
        });
        let mut assistant_msg = ChatMessage::new_assistant(session_id.to_string());
        assistant_msg.id = "msg_ws_a1".to_string();
        assistant_msg.timestamp = 2_000;
        assistant_msg.block_ids = vec!["blk_ws_c1".to_string()];
        assistant_msg.meta = Some(MessageMeta {
            response_web_search_items: Some(vec![web_search_item.clone()]),
            ..Default::default()
        });
        ChatV2Repo::create_message_with_conn(&conn, &assistant_msg).unwrap();
        ChatV2Repo::create_block_with_conn(
            &conn,
            &content_block("msg_ws_a1", "blk_ws_c1", "根据搜索结果……", 0),
        )
        .unwrap();
        drop(conn);

        let mut ctx = next_turn_ctx(session_id);
        pipeline.load_chat_history(&mut ctx).await.unwrap();
        assert_eq!(ctx.chat_history.len(), 2);

        let assistant = &ctx.chat_history[1];
        assert_eq!(assistant.role, "assistant");
        let metadata = assistant
            .metadata
            .as_ref()
            .expect("assistant 消息应带回 web_search metadata");
        assert_eq!(
            metadata.get("openai_responses_web_search_items"),
            Some(&serde_json::json!([web_search_item])),
            "meta 持久化的完整 item 必须原样挂回出站 assistant 消息 metadata"
        );

        // 无 meta 的普通消息不受影响（用户消息无该键）
        assert!(ctx.chat_history[0]
            .metadata
            .as_ref()
            .map(|m| m.get("openai_responses_web_search_items").is_none())
            .unwrap_or(true));
    }

    /// ROUND-01-pipeline #2：workspace_injection 块按 live 还原为 user 消息，
    /// 且插在本轮 user 消息之前（live 注入 push 在 chat_history 末尾的位置）
    #[tokio::test]
    async fn replay_restores_workspace_injection_before_turn_user() {
        let (_dir, pipeline) = replay_test_pipeline();
        let conn = pipeline.db.get_conn_safe().unwrap();
        let session_id = "sess_replay_wsi";
        ChatV2Repo::create_session_with_conn(
            &conn,
            &ChatSession::new(session_id.to_string(), "chat".to_string()),
        )
        .unwrap();

        insert_user_turn(
            &conn,
            session_id,
            "msg_wsi_u1",
            "blk_wsi_u1",
            "开始任务",
            1_000,
        );

        let mut assistant_msg = ChatMessage::new_assistant(session_id.to_string());
        assistant_msg.id = "msg_wsi_a1".to_string();
        assistant_msg.timestamp = 2_000;
        assistant_msg.block_ids = vec!["blk_wsi_inject".to_string(), "blk_wsi_c1".to_string()];
        ChatV2Repo::create_message_with_conn(&conn, &assistant_msg).unwrap();

        let mut injection_block = MessageBlock::new(
            "msg_wsi_a1".to_string(),
            block_types::WORKSPACE_INJECTION,
            0,
        );
        injection_block.id = "blk_wsi_inject".to_string();
        injection_block.status = block_status::SUCCESS.to_string();
        injection_block.content = Some("[来自工作区] 主代理插话：优先处理 A".to_string());
        injection_block.tool_output = Some(serde_json::json!({
            "workspace_id": "ws_1",
            "message_count": 1,
        }));
        ChatV2Repo::create_block_with_conn(&conn, &injection_block).unwrap();
        ChatV2Repo::create_block_with_conn(
            &conn,
            &content_block("msg_wsi_a1", "blk_wsi_c1", "收到，先处理 A", 1),
        )
        .unwrap();
        drop(conn);

        let mut ctx = next_turn_ctx(session_id);
        pipeline.load_chat_history(&mut ctx).await.unwrap();
        assert_eq!(ctx.chat_history.len(), 3);

        // live 顺序：注入消息在本轮 user 消息之前
        assert_eq!(ctx.chat_history[0].role, "user");
        assert_eq!(
            ctx.chat_history[0].content,
            "[来自工作区] 主代理插话：优先处理 A"
        );
        let metadata = ctx.chat_history[0].metadata.as_ref().unwrap();
        assert_eq!(
            metadata.get("workspace_injection"),
            Some(&serde_json::Value::Bool(true))
        );
        assert_eq!(
            metadata.get("workspace_id"),
            Some(&serde_json::json!("ws_1"))
        );
        assert_eq!(ctx.chat_history[1].role, "user");
        assert_eq!(ctx.chat_history[1].content, "开始任务");
        assert_eq!(ctx.chat_history[2].role, "assistant");
        assert_eq!(ctx.chat_history[2].content, "收到，先处理 A");
    }

    /// 模拟 `chat_v2_edit_and_resend` 编辑事务对 content 块的写操作
    /// （改写正文 + 显式失效旧 llm_content，与 handler 实现保持一致）
    fn simulate_edit_transaction(conn: &rusqlite::Connection, block_id: &str, new_content: &str) {
        let mut edited = ChatV2Repo::get_block_with_conn(conn, block_id)
            .unwrap()
            .unwrap();
        edited.content = Some(new_content.to_string());
        ChatV2Repo::update_block_with_conn(conn, &edited).unwrap();
        ChatV2Repo::clear_block_llm_content_with_conn(conn, block_id).unwrap();
    }

    /// P0 回归：编辑重发改写正文后，下一轮回放不得再返回编辑前的
    /// `llm_content` 旧包装（模型看到编辑前 <user_query> 的正确性回归）；
    /// 管线未补写时回退裸文本（新正文）
    #[tokio::test]
    async fn edit_and_resend_clears_stale_llm_content() {
        let (_dir, pipeline) = replay_test_pipeline();
        let conn = pipeline.db.get_conn_safe().unwrap();
        let session_id = "sess_edit_stale";
        ChatV2Repo::create_session_with_conn(
            &conn,
            &ChatSession::new(session_id.to_string(), "chat".to_string()),
        )
        .unwrap();

        insert_user_turn(
            &conn,
            session_id,
            "msg_edit_u1",
            "blk_edit_u1",
            "编辑前的问题",
            1_000,
        );
        let stale_wrapped = "<user_query>\n编辑前的问题\n</user_query>\n\n<injected_context>\n旧上下文\n</injected_context>";
        ChatV2Repo::update_block_replay_with_conn(
            &conn,
            "blk_edit_u1",
            &BlockReplayData {
                llm_content: Some(stale_wrapped.to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        simulate_edit_transaction(&conn, "blk_edit_u1", "编辑后的新问题");
        drop(conn);

        let mut ctx = next_turn_ctx(session_id);
        pipeline.load_chat_history(&mut ctx).await.unwrap();
        assert_eq!(ctx.chat_history.len(), 1);
        assert_eq!(
            ctx.chat_history[0].content, "编辑后的新问题",
            "旧 llm_content 已失效，必须回退到编辑后的裸文本"
        );
        assert!(
            !ctx.chat_history[0].content.contains("编辑前的问题"),
            "禁止回放编辑前的旧包装"
        );
    }

    /// P0 回归：编辑重发（skip_user_message_save=true 复用原 user_message_id）
    /// 的保存路径必须把本轮 live 编译的新包装补写回既有 content 块，
    /// 下一轮回放与 live 字节相等
    #[tokio::test]
    async fn edit_and_resend_skip_user_save_rewrites_llm_content() {
        use crate::chat_v2::types::SendOptions;

        let (_dir, pipeline) = replay_test_pipeline();
        let conn = pipeline.db.get_conn_safe().unwrap();
        let session_id = "sess_edit_rewrite";
        ChatV2Repo::create_session_with_conn(
            &conn,
            &ChatSession::new(session_id.to_string(), "chat".to_string()),
        )
        .unwrap();

        insert_user_turn(
            &conn,
            session_id,
            "msg_edit_u1",
            "blk_edit_u1",
            "编辑前的问题",
            1_000,
        );
        ChatV2Repo::update_block_replay_with_conn(
            &conn,
            "blk_edit_u1",
            &BlockReplayData {
                llm_content: Some("<user_query>\n编辑前的问题\n</user_query>".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        simulate_edit_transaction(&conn, "blk_edit_u1", "编辑后的新问题");
        drop(conn);

        // 编辑轮 ctx：与 chat_v2_edit_and_resend 一致——skip_user_message_save
        // 且 user_message_id 复用被编辑的原消息 id
        let mut edit_ctx = PipelineContext::new(SendMessageRequest {
            session_id: session_id.to_string(),
            content: "编辑后的新问题".to_string(),
            options: Some(SendOptions {
                skip_user_message_save: Some(true),
                ..Default::default()
            }),
            user_message_id: Some("msg_edit_u1".to_string()),
            assistant_message_id: Some("msg_edit_a1".to_string()),
            user_context_refs: None,
            path_map: None,
            workspace_id: None,
        });
        edit_ctx.compiled_current_user_message =
            Some(pipeline.build_current_user_message(&edit_ctx));
        let live_wrapped = edit_ctx
            .live_user_llm_content()
            .expect("compiled current user message");
        assert!(live_wrapped.contains("编辑后的新问题"));
        edit_ctx.interleaved_blocks =
            vec![content_block("msg_edit_a1", "blk_edit_a1", "新回答", 0)];

        pipeline.save_intermediate_results(&edit_ctx).await.unwrap();

        // 下一轮回放：用户消息 = 编辑轮 live 发送的新包装（字节相等）
        let mut ctx = next_turn_ctx(session_id);
        pipeline.load_chat_history(&mut ctx).await.unwrap();
        assert_eq!(ctx.chat_history.len(), 2);
        assert_eq!(ctx.chat_history[0].role, "user");
        assert_eq!(
            ctx.chat_history[0].content, live_wrapped,
            "补写后的 llm_content 必须与编辑轮 live 包装字节相等"
        );
        assert!(!ctx.chat_history[0].content.contains("编辑前的问题"));
        assert_eq!(ctx.chat_history[1].role, "assistant");
        assert_eq!(ctx.chat_history[1].content, "新回答");
    }
}
